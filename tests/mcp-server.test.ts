/**
 * The MCP stdio server — BlueSpace's front door.
 *
 * Everything here is driven the way a real client drives it: JSON-RPC frames
 * written into a pipe, frames read back out of another. Nothing calls a
 * dispatcher method directly, because the failures this transport actually has
 * — a frame split across two chunks, a stray write to stdout, a version nobody
 * agreed on — only exist at the stream boundary.
 *
 * The tools under test are the real `helmTools(orch, registry)` over a stubbed
 * orchestrator, since the whole claim of the module is that it serves those
 * `ToolDef`s unmodified. The one synthetic tool in the file is deliberately
 * badly behaved: it prints to stdout, which is the failure mode the server
 * exists to make impossible.
 */

import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import type { ToolDef } from '../src/adapters/types.js';
import { helmTools } from '../src/agents/helm/index.js';
import type { ProjectRegistry } from '../src/config/index.js';
import {
  FrameReader,
  MCP_SERVER_NAME,
  SUPPORTED_PROTOCOL_VERSIONS,
  serveMcp,
  type McpServerHandle,
} from '../src/mcp/index.js';
import type { Orchestrator } from '../src/orchestrator/index.js';
import type { Decision, Project, Task } from '../src/types/domain.js';

// ---------------------------------------------------------------------------
// Fleet stubs — the seam the tools already use: the public methods.
// ---------------------------------------------------------------------------

const PROJECT: Project = {
  id: 'proj-1',
  name: 'uploader',
  path: '/repos/uploader',
  description: 'the upload service',
  delivery: 'local',
  addedAt: 1_700_000_000_000,
};

const TASK: Task = {
  id: 'task-1',
  kind: 'mission',
  projectId: 'proj-1',
  title: 'Add retry to the uploader',
  brief: 'Retry failed uploads three times with backoff.',
  state: 'working',
  dependsOn: [],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_100,
  costUsd: 0.5,
  reworkCount: 0,
};

const DECISION: Decision = {
  id: 'dec-1',
  taskId: 'task-1',
  question: 'Retry on 5xx only?',
  options: [{ id: 'a', label: '5xx only' }],
  context: 'the uploader sees both',
  openedAt: 1_700_000_000_000,
};

function fleetTools(): ToolDef[] {
  const registry = {
    list: () => [PROJECT],
    get: (id: string) => (id === PROJECT.id ? PROJECT : undefined),
    resolveScored: () => [{ project: PROJECT, score: 42 }],
  } as unknown as ProjectRegistry;

  const orch = {
    tasks: () => [TASK],
    task: (id: string) => (id === TASK.id ? TASK : undefined),
    openDecisions: () => [DECISION],
    // Echoes what it was handed, so a test can watch an argument make the whole
    // round trip: client → frame → handler → frame → client.
    createTask: (input: Record<string, unknown>) => ({ ...TASK, ...input }),
    resolveDecision: async () => undefined,
    steer: async () => undefined,
    cancelTask: async () => undefined,
  } as unknown as Orchestrator;

  return helmTools(orch, registry);
}

// ---------------------------------------------------------------------------
// A client on the other end of the pipe
// ---------------------------------------------------------------------------

interface Frame {
  jsonrpc?: unknown;
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

interface Client {
  server: McpServerHandle;
  /** Send a request and wait for the frame carrying its id. */
  request(method: string, params?: Record<string, unknown>): Promise<Frame>;
  /** Write raw bytes — a half frame, two frames at once, or something illegal. */
  raw(text: string | Buffer): void;
  /** Every complete line the server has written, verbatim, before parsing. */
  lines(): string[];
  frames(): Frame[];
  /** Everything the server sent to stderr. */
  diagnostics(): string;
  /** Let the event loop deliver whatever is in flight. */
  settle(): Promise<void>;
  stop(): void;
}

const running: McpServerHandle[] = [];

function connect(tools: ToolDef[] = fleetTools(), opts: { guardStdout?: boolean } = {}): Client {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();

  const lines: string[] = [];
  const frames: Frame[] = [];
  const waiting = new Map<string | number, (frame: Frame) => void>();
  let outBuffer = '';

  output.on('data', (chunk: Buffer) => {
    outBuffer += chunk.toString('utf8');
    for (;;) {
      const nl = outBuffer.indexOf('\n');
      if (nl === -1) break;
      const line = outBuffer.slice(0, nl);
      outBuffer = outBuffer.slice(nl + 1);
      lines.push(line);
      let frame: Frame;
      try {
        frame = JSON.parse(line) as Frame;
      } catch {
        continue; // kept in `lines`; the purity test is what looks at it
      }
      frames.push(frame);
      const id = frame.id;
      if (typeof id === 'string' || typeof id === 'number') {
        const waiter = waiting.get(id);
        if (waiter) {
          waiting.delete(id);
          waiter(frame);
        }
      }
    }
  });

  let diagBuffer = '';
  diagnostics.on('data', (chunk: Buffer) => {
    diagBuffer += chunk.toString('utf8');
  });

  const server = serveMcp({
    tools,
    input,
    output,
    diagnostics,
    // Off unless a test is specifically about it: the guard reaches into the
    // process's real stdout, which the test runner is also using.
    guardStdout: opts.guardStdout ?? false,
  });
  running.push(server);

  let nextId = 1;

  return {
    server,
    request(method, params = {}): Promise<Frame> {
      const id = nextId++;
      const answered = new Promise<Frame>((resolve) => waiting.set(id, resolve));
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return answered;
    },
    raw(text): void {
      input.write(text);
    },
    lines: () => [...lines],
    frames: () => [...frames],
    diagnostics: () => diagBuffer,
    async settle(): Promise<void> {
      // Three turns of the loop: stream delivery, the handler's await, the write.
      for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
    },
    stop(): void {
      server.close();
    },
  };
}

afterEach(() => {
  let server = running.pop();
  while (server !== undefined) {
    server.close();
    server = running.pop();
  }
});

const LATEST = SUPPORTED_PROTOCOL_VERSIONS[0] ?? '2025-06-18';

function result(frame: Frame): Record<string, unknown> {
  expect(frame.error, `unexpected JSON-RPC error: ${JSON.stringify(frame.error)}`).toBeUndefined();
  expect(frame.result).toBeDefined();
  return frame.result as Record<string, unknown>;
}

function textOf(frame: Frame): string {
  const content = result(frame)['content'] as Array<{ type: string; text: string }>;
  expect(content[0]?.type).toBe('text');
  return content[0]?.text ?? '';
}

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

describe('initialize', () => {
  it('echoes the client’s own protocol version and announces the tool capability', async () => {
    const client = connect();
    const frame = await client.request('initialize', {
      protocolVersion: LATEST,
      capabilities: {},
      clientInfo: { name: 'claude-code', version: '2.1.222' },
    });

    const res = result(frame);
    expect(frame.jsonrpc).toBe('2.0');
    expect(res['protocolVersion']).toBe(LATEST);
    expect(res['serverInfo']).toMatchObject({ name: MCP_SERVER_NAME });
    expect(res['capabilities']).toMatchObject({ tools: { listChanged: false } });
    expect(res['instructions']).toBeTypeOf('string');
    expect(client.server.protocolVersion).toBe(LATEST);
  });

  it('meets an older client on its own version rather than forcing an upgrade', async () => {
    const client = connect();
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      const res = result(await client.request('initialize', { protocolVersion: version }));
      expect(res['protocolVersion']).toBe(version);
    }
  });

  it('fails loudly on an unknown version instead of silently degrading', async () => {
    const client = connect();
    const frame = await client.request('initialize', { protocolVersion: '1999-01-01' });

    expect(frame.result).toBeUndefined();
    expect(frame.error?.code).toBe(-32602);
    expect(frame.error?.message).toMatch(/unsupported MCP protocol version "1999-01-01"/);
    // The refusal has to name what this server does speak, or the next step is
    // guesswork against a server that will not say.
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      expect(frame.error?.message).toContain(version);
    }
    expect(frame.error?.data).toEqual({ supported: [...SUPPORTED_PROTOCOL_VERSIONS] });
    // …and loudly means on both channels: stderr is the MCP log a human reads.
    expect(client.diagnostics()).toMatch(/unsupported MCP protocol version/);
    expect(client.server.protocolVersion).toBeUndefined();
  });

  it('rejects an initialize with no version at all', async () => {
    const client = connect();
    const frame = await client.request('initialize', { capabilities: {} });
    expect(frame.error?.code).toBe(-32602);
    expect(frame.error?.message).toMatch(/protocolVersion/);
  });
});

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

describe('tools/list', () => {
  it('serves Helm’s nine levers with their schemas, unmodified', async () => {
    const tools = fleetTools();
    const client = connect(tools);
    await client.request('initialize', { protocolVersion: LATEST });

    const served = result(await client.request('tools/list'))['tools'] as Array<
      Record<string, unknown>
    >;

    expect(served.map((t) => t['name'])).toEqual([
      'list_projects',
      'resolve_project',
      'create_task',
      'list_tasks',
      'get_task',
      'open_decisions',
      'answer_decision',
      'steer_task',
      'cancel_task',
    ]);

    // Not merely the same names: the same descriptions and the same JSON Schema
    // objects. A transport that reshapes what it carries is a translation, and
    // a translation is a place for the two copies to drift.
    for (const [i, tool] of tools.entries()) {
      expect(served[i]).toEqual({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
      expect((served[i]?.['inputSchema'] as Record<string, unknown>)['type']).toBe('object');
    }
  });

  it('leaves the mcp__ prefix to the client — it is applied from the registered name', async () => {
    const client = connect();
    const served = result(await client.request('tools/list'))['tools'] as Array<
      Record<string, unknown>
    >;
    // The client applies `mcp__<server>__` from the name this server is
    // registered under, which is what makes `mcp__bluespace__create_task` — the
    // names CLAUDE.md tells Helm to use — the real ones. A server that prefixed
    // too would produce mcp__bluespace__mcp__bluespace__…
    for (const tool of served) {
      expect(String(tool['name'])).not.toMatch(/^mcp__/);
    }
  });
});

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------

describe('tools/call', () => {
  it('runs the handler and returns its text', async () => {
    const client = connect();
    await client.request('initialize', { protocolVersion: LATEST });

    const frame = await client.request('tools/call', { name: 'list_projects', arguments: {} });
    expect(result(frame)['isError']).toBe(false);
    expect(JSON.parse(textOf(frame))).toMatchObject({
      count: 1,
      projects: [{ id: 'proj-1', name: 'uploader' }],
    });
  });

  it('passes arguments through to the handler', async () => {
    const client = connect();
    const frame = await client.request('tools/call', {
      name: 'get_task',
      arguments: { taskId: 'task-1' },
    });
    expect(JSON.parse(textOf(frame))).toMatchObject({
      id: 'task-1',
      brief: 'Retry failed uploads three times with backoff.',
    });
  });

  it('treats a missing arguments object as no arguments, not as a crash', async () => {
    const client = connect();
    const frame = await client.request('tools/call', { name: 'open_decisions' });
    expect(result(frame)['isError']).toBe(false);
    expect(JSON.parse(textOf(frame))).toMatchObject({ count: 1 });
  });

  it('reports a throwing handler as a tool error with the message intact', async () => {
    const client = connect();
    const frame = await client.request('tools/call', {
      name: 'get_task',
      arguments: { taskId: 'nope' },
    });

    // A tool error, NOT a JSON-RPC error: the model has to be able to read this
    // and correct itself, and a protocol error reads as a broken server.
    expect(frame.error).toBeUndefined();
    expect(result(frame)['isError']).toBe(true);
    expect(textOf(frame)).toBe('No task with id nope. Use list_tasks to see current task ids.');
  });

  it('reports a rejected argument by name, the way the handler wrote it', async () => {
    const client = connect();
    const frame = await client.request('tools/call', {
      name: 'create_task',
      arguments: { kind: 'sortie', projectId: 'p', title: 't', brief: 'b' },
    });
    expect(result(frame)['isError']).toBe(true);
    expect(textOf(frame)).toMatch(/kind must be one of: mission, recon/);
  });

  it('answers an unknown tool with a protocol error naming the real ones', async () => {
    const client = connect();
    const frame = await client.request('tools/call', { name: 'launch_missiles' });
    expect(frame.result).toBeUndefined();
    expect(frame.error?.code).toBe(-32602);
    expect(frame.error?.message).toMatch(/unknown tool "launch_missiles"/);
    expect(frame.error?.message).toMatch(/create_task/);
  });

  it('refuses a call with no tool name and one with non-object arguments', async () => {
    const client = connect();
    expect((await client.request('tools/call', {})).error?.code).toBe(-32602);
    expect(
      (await client.request('tools/call', { name: 'get_task', arguments: 'task-1' })).error?.message,
    ).toMatch(/must be an object/);
  });
});

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

describe('framing', () => {
  it('reassembles a frame split across chunks and answers only once it is whole', async () => {
    const client = connect();
    const frame = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping', params: {} });

    client.raw(frame.slice(0, 20));
    await client.settle();
    expect(client.frames()).toHaveLength(0); // half a frame is not a request

    client.raw(`${frame.slice(20)}\n`);
    await client.settle();
    expect(client.frames()).toHaveLength(1);
    expect(client.frames()[0]).toMatchObject({ jsonrpc: '2.0', id: 7, result: {} });
  });

  it('never mangles a multi-byte character split across a chunk boundary', async () => {
    const client = connect();
    // A brief with an emoji in it, cut mid-character: the naive implementation
    // decodes each chunk on arrival and turns the halves into U+FFFD.
    const title = 'Fix the 🚀 launcher';
    const frame = Buffer.from(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'create_task', arguments: { kind: 'mission', projectId: 'proj-1', title, brief: 'b' } },
      })}\n`,
      'utf8',
    );
    const cut = frame.indexOf(Buffer.from('🚀', 'utf8')) + 2;

    client.raw(frame.subarray(0, cut));
    await client.settle();
    client.raw(frame.subarray(cut));
    await client.settle();

    const answered = client.frames()[0];
    expect(answered).toBeDefined();
    expect(JSON.stringify(answered)).not.toContain('\\ufffd');
    expect(textOf(answered as Frame)).toContain('🚀');
  });

  it('handles several frames arriving in one chunk', async () => {
    const client = connect();
    const ping = (id: number): string => `${JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })}\n`;
    client.raw(`${ping(1)}${ping(2)}${ping(3)}`);
    await client.settle();
    expect(client.frames().map((f) => f.id)).toEqual([1, 2, 3]);
  });

  it('ignores blank lines between frames', async () => {
    const client = connect();
    client.raw('\n\n');
    await client.settle();
    expect(client.frames()).toHaveLength(0);
    expect(await client.request('ping')).toMatchObject({ result: {} });
  });

  it('gives up on an over-long frame and resynchronizes at the next newline', () => {
    // Direct, because the server's own ceiling is four megabytes and building
    // one of those to test the recovery would be the slowest test in the suite.
    const reader = new FrameReader(16);
    expect(reader.push(Buffer.from('x'.repeat(40)))).toEqual([]);
    expect(reader.oversized).toBe(true);
    expect(reader.pendingBytes).toBe(0);
    // The tail of the abandoned frame is discarded with it; the next one is whole.
    expect(reader.push(Buffer.from('more junk\n{"ok":1}\r\n'))).toEqual(['{"ok":1}']);
  });

  it('resolves `closed` when the client hangs up', async () => {
    const client = connect();
    client.stop();
    await expect(client.server.closed).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Malformed input
// ---------------------------------------------------------------------------

describe('malformed input', () => {
  it('answers unparseable JSON with a parse error and stays up', async () => {
    const client = connect();
    client.raw('{"jsonrpc": "2.0", "id": 1, "method": \n');
    await client.settle();

    const frame = client.frames()[0];
    expect(frame?.error?.code).toBe(-32700);
    expect(frame?.id).toBeNull();

    // Still serving: a keystroke in the wrong terminal must not end the session.
    expect(result(await client.request('ping'))).toEqual({});
  });

  it('rejects a frame that is not a JSON-RPC 2.0 request', async () => {
    const client = connect();

    client.raw(`${JSON.stringify({ id: 1, method: 'ping' })}\n`); // no jsonrpc
    client.raw(`${JSON.stringify({ jsonrpc: '2.0', id: 2 })}\n`); // no method
    client.raw(`${JSON.stringify([{ jsonrpc: '2.0', id: 3, method: 'ping' }])}\n`); // batch
    client.raw('"just a string"\n');
    await client.settle();

    const codes = client.frames().map((f) => f.error?.code);
    expect(codes).toEqual([-32600, -32600, -32600, -32600]);
    expect(client.frames()[0]?.id).toBe(1); // the id is echoed when there is one
    expect(client.frames()[2]?.error?.message).toMatch(/batch/);
  });

  it('answers an unknown method with method-not-found', async () => {
    const client = connect();
    const frame = await client.request('resources/list');
    expect(frame.error?.code).toBe(-32601);
    expect(frame.error?.message).toMatch(/unknown method "resources\/list"/);
  });

  it('never replies to a notification', async () => {
    const client = connect();
    client.raw(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    client.raw(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} })}\n`);
    await client.settle();
    expect(client.frames()).toHaveLength(0);

    // The only frame on the wire is the answer to the one thing that asked.
    const frame = await client.request('ping');
    expect(frame.id).toBe(1);
    expect(client.frames()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// stdout purity — the failure this module exists to prevent
// ---------------------------------------------------------------------------

describe('stdout purity', () => {
  it('keeps stray writes out of the protocol stream and puts them on stderr', async () => {
    // A tool that behaves the way real code eventually does: it prints. Left
    // alone, this lands between two frames and desynchronizes the client, and
    // the symptom the captain sees is a window that hangs.
    const noisy: ToolDef = {
      name: 'noisy',
      description: 'Writes to stdout while it works. Call this to prove it cannot corrupt the stream.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        // Written straight to the stream rather than through `console.log`
        // because the test runner intercepts console and this does not: both
        // end at the same `process.stdout.write`, which is the sink the guard
        // actually replaces.
        process.stdout.write('noise from a handler\n');
        process.stdout.write(Buffer.from('and a buffer\n'));
        return 'done';
      },
    };

    const client = connect([...fleetTools(), noisy], { guardStdout: true });
    try {
      await client.request('initialize', { protocolVersion: LATEST });
      const frame = await client.request('tools/call', { name: 'noisy', arguments: {} });
      expect(textOf(frame)).toBe('done');
      await client.settle();
    } finally {
      // Restore the process's stdout before the test runner needs it back.
      client.stop();
    }

    // Every line on the protocol stream is a well-formed JSON-RPC frame, and
    // there are exactly as many as there were requests.
    const lines = client.lines();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed: unknown = JSON.parse(line);
      expect(parsed).toMatchObject({ jsonrpc: '2.0' });
    }
    expect(lines.join('\n')).not.toContain('noise from a handler');

    // The diagnostics are not swallowed — they are readable, on the other channel.
    const diagnostics = client.diagnostics();
    expect(diagnostics).toContain('noise from a handler');
    expect(diagnostics).toContain('and a buffer');
  });

  it('routes its own diagnostics to stderr, never to the frame stream', async () => {
    const client = connect();
    await client.request('initialize', { protocolVersion: LATEST });
    await client.request('tools/call', { name: 'get_task', arguments: { taskId: 'nope' } });
    await client.settle();

    expect(client.diagnostics()).toMatch(/initialized: protocol/);
    expect(client.diagnostics()).toMatch(/tool get_task failed: No task with id nope/);
    for (const line of client.lines()) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
      expect(line).not.toContain(`[${MCP_SERVER_NAME}]`);
    }
  });
});
