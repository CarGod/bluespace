/**
 * MCP stdio server — BlueSpace's front door.
 *
 * BlueSpace used to own a readline REPL and drive Helm through an SDK
 * conversation. It no longer does: the captain talks to Helm in their own
 * interactive Claude Code window, and this module is what puts Helm's levers in
 * that window's hands. The `ToolDef`s in `src/agents/helm/tools.ts` are
 * already exactly the shape MCP wants — a name, a prescriptive description, a
 * JSON Schema, and a handler returning text — so this is a transport, not a
 * redesign. It calls those handlers and nothing else.
 *
 * Why hand-rolled rather than `@modelcontextprotocol/sdk`: the wire format is
 * newline-delimited JSON-RPC 2.0 over two pipes, and three methods of it are in
 * use here. A dependency that large to avoid this much code is a bad trade at
 * any time, and a worse one in a tree that is deliberately down to two runtime
 * dependencies and already serves the Starmap over bare `node:http`.
 *
 * Four decisions carry the module:
 *
 *  1. STDOUT IS THE PROTOCOL AND NOTHING ELSE MAY TOUCH IT. One stray
 *     `console.log` anywhere in the process — ours, a dependency's, a
 *     debug line somebody left in — lands between two frames and desynchronizes
 *     the client. The symptom is not an error message; it is the captain's
 *     window appearing to hang. So the guard is not "remember not to print": the
 *     server captures the real `process.stdout.write` for its own frames and
 *     replaces the public one with a forwarder to stderr for the whole time it
 *     is serving. Diagnostics are still readable — they show up in the client's
 *     MCP log, where they belong — and cannot corrupt anything.
 *
 *  2. AN UNKNOWN PROTOCOL VERSION IS AN ERROR, NOT A SHRUG. The spec permits a
 *     server to answer an unrecognized `initialize` with its own newest version
 *     and let the client decide. We refuse instead, loudly, on both channels.
 *     Degrading silently means the disagreement surfaces later as a tool call
 *     that does not behave, which is far more expensive to diagnose than a
 *     refusal that names the versions this server actually speaks.
 *
 *  3. TOOL NAMES GO OUT BARE. `create_task`, not `mcp__bluespace__create_task`.
 *     The `mcp__<server>__<tool>` prefix is applied by the CLIENT from the name
 *     the server is registered under, which is what makes the
 *     `mcp__bluespace__*` names CLAUDE.md tells Helm to use the real ones.
 *     Prefixing here too would produce
 *     `mcp__bluespace__mcp__bluespace__create_task`.
 *
 *  4. A HANDLER THROW IS A RESULT, NOT A JSON-RPC ERROR. `{isError: true}` with
 *     the message as its text puts the failure in front of the model, which can
 *     read "No task with id nope" and correct itself. A JSON-RPC error object is
 *     for the protocol layer — a malformed frame, an unknown method, a tool that
 *     does not exist — and clients treat it as a broken server rather than as
 *     something the model should react to. `ToolDef.handler` is documented to
 *     report a throw as a tool error for exactly this reason.
 */

import type { ToolDef } from '../adapters/types.js';

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

/**
 * The name this server is registered under in the client's MCP config.
 *
 * Load-bearing beyond identification: it is the middle segment of the tool names
 * the model sees, so `bluespace` here is what makes `mcp__bluespace__create_task`
 * — the names CLAUDE.md tells Helm to use — the real ones.
 */
export const MCP_SERVER_NAME = 'bluespace';

export const MCP_SERVER_VERSION = '0.1.0';

/**
 * Protocol revisions this server will negotiate, newest first.
 *
 * Every method used here (`initialize`, `tools/list`, `tools/call`) is spelled
 * the same way in all of them, which is why the list can be this permissive: an
 * older client is not a degraded client, it is the same three calls. The list is
 * checked against the revisions the reference implementation ships as supported;
 * a client asking for anything else is refused rather than guessed at.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

/** What the client is told this server is for, once, at initialize. */
const DEFAULT_INSTRUCTIONS = [
  "BlueSpace's fleet control surface.",
  'These tools create and inspect tasks; the orchestrator — deterministic code, not a model —',
  'decides when work is dispatched, retried, or torn down.',
].join(' ');

/**
 * Longest single frame accepted, in bytes.
 *
 * A `create_task` brief is the biggest thing that legitimately crosses this
 * wire and it is measured in kilobytes. The bound exists so a client that opens
 * a frame and never closes it cannot grow the buffer until the process dies;
 * hitting it resyncs to the next newline rather than throwing.
 */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// JSON-RPC 2.0
// ---------------------------------------------------------------------------

type JsonRpcId = string | number;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: Record<string, unknown>;
}

interface JsonRpcFailure {
  jsonrpc: '2.0';
  /** null when the frame was too broken to carry an id — JSON-RPC 2.0 §5. */
  id: JsonRpcId | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/**
 * One parsed frame, as a tagged union.
 *
 * The three cases are answered differently and the difference matters: a
 * request gets a response, a notification gets silence (JSON-RPC 2.0 forbids
 * replying to one), and a frame we could not make sense of gets an error with a
 * null id. Modelling that as a union rather than as flags is what makes the
 * "never answer a notification" rule checkable by the compiler.
 */
type Frame =
  | { kind: 'request'; id: JsonRpcId; method: string; params: Record<string, unknown> }
  | { kind: 'notification'; method: string; params: Record<string, unknown> }
  | { kind: 'invalid'; id: JsonRpcId | null; code: number; message: string };

/** What a method handler returns before it is wrapped in an envelope. */
type Outcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: number; message: string; data?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message === '' ? err.name : err.message;
  return String(err);
}

/**
 * Parse one line into a `Frame`. Never throws: a client that sends garbage gets
 * an error frame back and the connection survives, because the alternative is
 * the server dying on a keystroke somebody typed into the wrong terminal.
 */
export function parseFrame(line: string): Frame {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (err) {
    return { kind: 'invalid', id: null, code: PARSE_ERROR, message: `invalid JSON: ${errorText(err)}` };
  }

  // Batches were removed from MCP in 2025-06-18 and were never used by any
  // client that talks to this server. Refusing beats half-implementing.
  if (Array.isArray(value)) {
    return {
      kind: 'invalid',
      id: null,
      code: INVALID_REQUEST,
      message: 'JSON-RPC batch frames are not supported; send one request per line',
    };
  }
  if (!isRecord(value)) {
    return { kind: 'invalid', id: null, code: INVALID_REQUEST, message: 'a frame must be a JSON object' };
  }

  const rawId = value['id'];
  const hasId = rawId !== undefined && rawId !== null;
  if (hasId && typeof rawId !== 'string' && typeof rawId !== 'number') {
    return { kind: 'invalid', id: null, code: INVALID_REQUEST, message: 'id must be a string or a number' };
  }
  const id: JsonRpcId | null = hasId ? (rawId as JsonRpcId) : null;

  if (value['jsonrpc'] !== '2.0') {
    return { kind: 'invalid', id, code: INVALID_REQUEST, message: 'every frame must carry jsonrpc: "2.0"' };
  }

  const method = value['method'];
  if (typeof method !== 'string' || method === '') {
    return { kind: 'invalid', id, code: INVALID_REQUEST, message: 'method must be a non-empty string' };
  }

  const rawParams = value['params'];
  if (rawParams !== undefined && rawParams !== null && !isRecord(rawParams)) {
    return { kind: 'invalid', id, code: INVALID_PARAMS, message: 'params must be an object' };
  }
  const params = isRecord(rawParams) ? rawParams : {};

  return id === null ? { kind: 'notification', method, params } : { kind: 'request', id, method, params };
}

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

export interface McpDispatcherOptions {
  tools: readonly ToolDef[];
  serverName?: string;
  serverVersion?: string;
  instructions?: string;
  /** Where to say things that are not protocol. Never stdout. */
  diagnostic?: (message: string) => void;
}

/**
 * The protocol logic, with no transport in it.
 *
 * Separated from the pipes so the interesting half can be exercised without a
 * stream, and so the framing half has nothing to know about MCP.
 */
export class McpDispatcher {
  private readonly tools: readonly ToolDef[];
  private readonly byName: Map<string, ToolDef>;
  private readonly serverName: string;
  private readonly serverVersion: string;
  private readonly instructions: string;
  private readonly diagnostic: (message: string) => void;

  /** The version agreed at `initialize`, or undefined before one arrives. */
  private negotiated: string | undefined;

  constructor(options: McpDispatcherOptions) {
    this.tools = options.tools;
    this.serverName = options.serverName ?? MCP_SERVER_NAME;
    this.serverVersion = options.serverVersion ?? MCP_SERVER_VERSION;
    this.instructions = options.instructions ?? DEFAULT_INSTRUCTIONS;
    this.diagnostic = options.diagnostic ?? ((): void => undefined);

    this.byName = new Map();
    for (const tool of this.tools) {
      // Two tools under one name means one of them is unreachable and which one
      // depends on iteration order. That is a wiring bug in the caller, and it
      // is worth failing at startup rather than at the call the model makes.
      if (this.byName.has(tool.name)) {
        throw new Error(`duplicate MCP tool name: ${tool.name}`);
      }
      this.byName.set(tool.name, tool);
    }
  }

  /** The version negotiated at `initialize`. Exposed for diagnostics only. */
  get protocolVersion(): string | undefined {
    return this.negotiated;
  }

  /**
   * Answer one frame. Resolves to the response to write, or to undefined when
   * the frame was a notification and silence is the correct answer.
   */
  async handle(frame: Frame): Promise<JsonRpcResponse | undefined> {
    switch (frame.kind) {
      case 'invalid':
        this.diagnostic(`rejected frame: ${frame.message}`);
        return { jsonrpc: '2.0', id: frame.id, error: { code: frame.code, message: frame.message } };

      case 'notification':
        // `notifications/initialized`, `notifications/cancelled`, and anything a
        // future client invents. None of them require an answer, and answering
        // an unknown one would be a protocol violation rather than helpfulness.
        this.diagnostic(`notification: ${frame.method}`);
        return undefined;

      case 'request': {
        let outcome: Outcome;
        try {
          outcome = await this.route(frame.method, frame.params);
        } catch (err) {
          // Nothing in route() is supposed to throw — tool handlers are caught
          // where they are called. If one does anyway, the captain's window gets
          // an answer rather than a silent gap where a response should be.
          this.diagnostic(`internal error handling ${frame.method}: ${errorText(err)}`);
          outcome = { ok: false, code: INTERNAL_ERROR, message: errorText(err) };
        }
        if (outcome.ok) return { jsonrpc: '2.0', id: frame.id, result: outcome.result };
        const error: JsonRpcFailure['error'] = { code: outcome.code, message: outcome.message };
        if (outcome.data !== undefined) error.data = outcome.data;
        return { jsonrpc: '2.0', id: frame.id, error };
      }
    }
  }

  private async route(method: string, params: Record<string, unknown>): Promise<Outcome> {
    switch (method) {
      case 'initialize':
        return this.initialize(params);
      case 'ping':
        // Liveness probe. An empty result is the whole contract.
        return { ok: true, result: {} };
      case 'tools/list':
        return this.listTools();
      case 'tools/call':
        return await this.callTool(params);
      default:
        return {
          ok: false,
          code: METHOD_NOT_FOUND,
          message: `unknown method "${method}"; this server implements initialize, tools/list, tools/call and ping`,
        };
    }
  }

  private initialize(params: Record<string, unknown>): Outcome {
    const requested = params['protocolVersion'];
    if (typeof requested !== 'string' || requested === '') {
      return {
        ok: false,
        code: INVALID_PARAMS,
        message: 'initialize requires a protocolVersion string',
        data: { supported: SUPPORTED_PROTOCOL_VERSIONS },
      };
    }
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
      // Loud on both channels on purpose: the JSON-RPC error is what the client
      // acts on, and the stderr line is what a human reads in the MCP log when
      // the server "just doesn't work" after a client upgrade.
      const message =
        `unsupported MCP protocol version "${requested}"; ` +
        `this server speaks ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`;
      this.diagnostic(message);
      return {
        ok: false,
        code: INVALID_PARAMS,
        message,
        data: { supported: SUPPORTED_PROTOCOL_VERSIONS },
      };
    }

    // Echo the client's own version back. Every method here is identical across
    // the supported revisions, so meeting the client where it is costs nothing
    // and spares it a downgrade negotiation.
    this.negotiated = requested;
    this.diagnostic(`initialized: protocol ${requested}, ${this.tools.length} tools`);

    return {
      ok: true,
      result: {
        protocolVersion: requested,
        // The tool list is fixed for the life of the process — Helm's levers are
        // compiled in — so `listChanged` is honestly false and the client never
        // has to poll.
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: this.serverName, version: this.serverVersion },
        instructions: this.instructions,
      },
    };
  }

  private listTools(): Outcome {
    // Bare names. The client prefixes them with `mcp__<server>__`; see the file
    // header. `inputSchema` is passed through untouched — the ToolDefs already
    // describe themselves in the format MCP asks for, which is the entire
    // reason this module is a transport and not a translation.
    return {
      ok: true,
      result: {
        tools: this.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      },
    };
  }

  private async callTool(params: Record<string, unknown>): Promise<Outcome> {
    const name = params['name'];
    if (typeof name !== 'string' || name === '') {
      return { ok: false, code: INVALID_PARAMS, message: 'tools/call requires a tool name' };
    }

    const rawArgs = params['arguments'];
    if (rawArgs !== undefined && rawArgs !== null && !isRecord(rawArgs)) {
      return { ok: false, code: INVALID_PARAMS, message: `arguments for "${name}" must be an object` };
    }

    const tool = this.byName.get(name);
    if (tool === undefined) {
      // A protocol error rather than a tool error: the model asked for something
      // that is not on the list it was given, so the list is what it needs back.
      return {
        ok: false,
        code: INVALID_PARAMS,
        message: `unknown tool "${name}"; this server exposes: ${[...this.byName.keys()].join(', ')}`,
      };
    }

    try {
      const text = await tool.handler(isRecord(rawArgs) ? rawArgs : {});
      return { ok: true, result: { content: [{ type: 'text', text }], isError: false } };
    } catch (err) {
      // The message is carried through verbatim. Helm's handlers throw sentences
      // written for exactly this moment ("No task with id nope. Use list_tasks
      // …"), and a captain reading their window has to be able to see them.
      const message = errorText(err);
      this.diagnostic(`tool ${name} failed: ${message}`);
      return { ok: true, result: { content: [{ type: 'text', text: message }], isError: true } };
    }
  }
}

// ---------------------------------------------------------------------------
// Framing — newline-delimited JSON over two pipes
// ---------------------------------------------------------------------------

/**
 * Splits a byte stream into complete lines.
 *
 * Framed in BYTES, not text, for the same reason `src/transcript/reader.ts` is:
 * a chunk boundary can fall in the middle of a multi-byte character, and
 * decoding a partial chunk turns that character into U+FFFD permanently. Bytes
 * are held until their newline arrives and only complete lines are decoded, so
 * the mangling is structurally impossible rather than merely unlikely.
 */
export class FrameReader {
  private carry: Buffer = Buffer.alloc(0);
  /** True after an oversized frame: bytes are dropped until the next newline. */
  private resyncing = false;

  /** Set when a frame was abandoned for length. Read and cleared by the server. */
  oversized = false;

  constructor(private readonly maxFrameBytes: number = MAX_FRAME_BYTES) {}

  /** Feed one chunk; returns the complete lines it finished, in order. */
  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let rest = chunk;

    for (;;) {
      const nl = rest.indexOf(0x0a);
      if (nl === -1) break;
      const head = rest.subarray(0, nl);
      const line = this.carry.length > 0 ? Buffer.concat([this.carry, head]) : head;
      this.carry = Buffer.alloc(0);
      rest = rest.subarray(nl + 1);
      if (this.resyncing) {
        this.resyncing = false; // this is the tail of a frame already given up on
        continue;
      }
      // A bare \r\n line ending is not in the spec but costs one call to tolerate.
      const text = line.toString('utf8').replace(/\r$/, '');
      if (text.trim() !== '') lines.push(text);
    }

    if (rest.length > 0) this.carry = this.carry.length > 0 ? Buffer.concat([this.carry, rest]) : Buffer.from(rest);
    if (this.carry.length > this.maxFrameBytes) {
      this.carry = Buffer.alloc(0);
      this.resyncing = true;
      this.oversized = true;
    }
    return lines;
  }

  /** Bytes held back waiting for a newline. Non-zero means a frame is in flight. */
  get pendingBytes(): number {
    return this.carry.length;
  }
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export interface McpServeOptions {
  /** Helm's tools, unmodified. See `helmTools(orch, registry)`. */
  tools: readonly ToolDef[];
  /** Defaults to process.stdin. */
  input?: NodeJS.ReadableStream;
  /** Defaults to process.stdout. NOTHING ELSE MAY WRITE HERE. */
  output?: NodeJS.WritableStream;
  /** Defaults to process.stderr. Everything that is not a frame goes here. */
  diagnostics?: NodeJS.WritableStream;
  serverName?: string;
  serverVersion?: string;
  instructions?: string;
  /**
   * Reroute the process's own stdout to `diagnostics` while serving. Default
   * true; see decision 1 in the file header. Turn it off only when something
   * else already owns the real stdout.
   */
  guardStdout?: boolean;
}

export interface McpServerHandle {
  /** Resolves when the client's end of the pipe closes, or `close()` is called. */
  readonly closed: Promise<void>;
  /** The version negotiated at initialize, once one has been. */
  readonly protocolVersion: string | undefined;
  /** Stop reading, restore stdout, and resolve `closed`. Safe to call twice. */
  close(): void;
}

/**
 * Replace `process.stdout.write` with a forwarder to `diagnostics`.
 *
 * This is the single mechanism that makes "nothing but frames on stdout" a
 * property of the process rather than a rule people remember. Returns the
 * restore function; the original writer is captured before patching so the
 * server's own frames still reach the real stream.
 */
function guardProcessStdout(diagnostics: NodeJS.WritableStream): () => void {
  const original = process.stdout.write.bind(process.stdout);
  const forwarder = function stdoutForwarder(
    chunk: Uint8Array | string,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ): boolean {
    const done = typeof encoding === 'function' ? encoding : callback;
    diagnostics.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
    done?.();
    return true;
  } as typeof process.stdout.write;

  process.stdout.write = forwarder;
  return (): void => {
    // Only undo our own patch: something else may have layered on top of it,
    // and clobbering that would be the same bug pointed the other way.
    if (process.stdout.write === forwarder) process.stdout.write = original;
  };
}

/**
 * Serve MCP over a pair of streams. Returns as soon as it is listening.
 *
 * Requests are answered concurrently rather than one at a time: responses are
 * matched by id, a whole frame is written in a single `write()`, and a client
 * that pings while a slow `tools/call` is running deserves an answer.
 */
export function serveMcp(options: McpServeOptions): McpServerHandle {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const diagnostics = options.diagnostics ?? process.stderr;
  const serverName = options.serverName ?? MCP_SERVER_NAME;

  const diagnostic = (message: string): void => {
    diagnostics.write(`[${serverName}] ${message}\n`);
  };

  const dispatcherOptions: McpDispatcherOptions = { tools: options.tools, diagnostic };
  if (options.serverName !== undefined) dispatcherOptions.serverName = options.serverName;
  if (options.serverVersion !== undefined) dispatcherOptions.serverVersion = options.serverVersion;
  if (options.instructions !== undefined) dispatcherOptions.instructions = options.instructions;
  const dispatcher = new McpDispatcher(dispatcherOptions);

  // Capture the real writer BEFORE the guard replaces the public one, or the
  // server's own frames would be forwarded to stderr along with the noise.
  const rawStdoutWrite = process.stdout.write.bind(process.stdout);
  const restoreStdout = options.guardStdout === false ? (): void => undefined : guardProcessStdout(diagnostics);
  const writeFrame =
    output === process.stdout
      ? (text: string): void => {
          rawStdoutWrite(text);
        }
      : (text: string): void => {
          output.write(text);
        };

  const send = (response: JsonRpcResponse): void => {
    // JSON.stringify escapes every newline inside a string, so a serialized
    // frame can never contain the byte that separates frames.
    writeFrame(`${JSON.stringify(response)}\n`);
  };

  const reader = new FrameReader();
  let closed = false;
  let resolveClosed: () => void = () => undefined;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const onData = (chunk: Buffer | string): void => {
    const lines = reader.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    if (reader.oversized) {
      reader.oversized = false;
      const message = `frame exceeded ${MAX_FRAME_BYTES} bytes and was discarded`;
      diagnostic(message);
      send({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message } });
    }
    for (const line of lines) {
      void dispatcher
        .handle(parseFrame(line))
        .then((response) => {
          if (response !== undefined && !closed) send(response);
        })
        .catch((err: unknown) => {
          // handle() catches its own failures; this is the last net so an
          // unhandled rejection can never take the captain's window down.
          diagnostic(`dropped a frame: ${errorText(err)}`);
        });
    }
  };

  const onEnd = (): void => {
    finish('input stream ended');
  };
  const onError = (err: unknown): void => {
    finish(`input stream failed: ${errorText(err)}`);
  };

  function finish(reason: string): void {
    if (closed) return;
    closed = true;
    input.off('data', onData);
    input.off('end', onEnd);
    input.off('error', onError);
    restoreStdout();
    diagnostic(`shutting down: ${reason}`);
    resolveClosed();
  }

  input.on('data', onData);
  input.on('end', onEnd);
  input.on('error', onError);
  if (typeof (input as { resume?: () => void }).resume === 'function') input.resume();

  return {
    closed: closedPromise,
    get protocolVersion(): string | undefined {
      return dispatcher.protocolVersion;
    },
    close(): void {
      finish('closed by the server');
    },
  };
}
