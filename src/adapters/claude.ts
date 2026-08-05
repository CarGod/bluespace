/**
 * ClaudeAdapter — the only module in BlueSpace that touches a vendor SDK.
 *
 * It owns exactly one job: translate `@anthropic-ai/claude-agent-sdk` into the
 * vendor-neutral `HarnessAdapter` contract in `./types.js`. Everything above
 * this file (orchestrator, agents, CLI, server) speaks only `AdapterEvent`,
 * `Session`, `SpawnRequest`, `ToolDef` and `Conversation` — swapping harnesses
 * means writing a sibling of this file and nothing else.
 *
 * It answers two shapes of request. `spawn()` runs a one-shot worker (a Crew, a
 * Sentinel). `converse()` runs Helm: a session that outlives each turn, with the
 * caller's own tools hosted in-process. Tools arrive as JSON Schema and are
 * translated here into the SDK's zod-shaped `tool()` calls, which is what keeps
 * Helm's control surface free of vendor types.
 *
 * Two implementation choices are load-bearing:
 *
 *  1. STREAMING INPUT MODE. `query()` is given an AsyncIterable prompt, not a
 *     string. The SDK only exposes the control channel (`interrupt()`,
 *     follow-up messages) when input is streamed, so `send()` and `interrupt()`
 *     would be impossible with a plain string prompt. The iterable yields the
 *     opening brief, then whatever `send()` pushes, and completes on `close()`.
 *
 *  2. CALLER-SUPPLIED SESSION ID. We mint the session UUID ourselves and pass
 *     it to the SDK, so `Session.id` is stable and meaningful from the instant
 *     `spawn()` returns rather than only after the first message arrives.
 *
 * Note the published SDK docs describe different type names than the shipped
 * package; this file is written against `node_modules/@anthropic-ai/
 * claude-agent-sdk/sdk.d.ts` (v0.3.221), which is the authority.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createSdkMcpServer,
  query,
  tool,
  type AnyZodRawShape,
  type ModelUsage,
  type Options as ClaudeOptions,
  type PermissionMode as ClaudePermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Effort, PermissionMode } from '../types/domain.js';
import {
  requireCapability,
  type AdapterCapabilities,
  type AdapterEvent,
  type Conversation,
  type ConversationRequest,
  type HarnessAdapter,
  type Session,
  type SpawnRequest,
  type ToolDef,
} from './types.js';

// ---------------------------------------------------------------------------
// Capabilities — the Claude harness supports the full contract.
// ---------------------------------------------------------------------------

const CLAUDE_CAPABILITIES: AdapterCapabilities = {
  interrupt: true,
  fork: true,
  cost: true,
  toolEvents: true,
  structuredOutput: true,
  steer: true,
  conversation: true,
};

// ---------------------------------------------------------------------------
// Streaming input queue
// ---------------------------------------------------------------------------

/**
 * A single-consumer async queue of `SDKUserMessage`s.
 *
 * This is the prompt handed to `query()`. It yields the opening brief first,
 * then anything pushed by `Session.send()`, and finishes (ending the SDK's
 * input stream) when `close()` is called.
 */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: SDKUserMessage[] = [];
  private readonly waiters: Array<(r: IteratorResult<SDKUserMessage>) => void> = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: message, done: false });
      return;
    }
    this.pending.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Anyone parked on next() is released with done:true; already-queued
    // messages stay queued so a close() racing a send() does not drop input.
    let waiter = this.waiters.shift();
    while (waiter) {
      waiter({ value: undefined, done: true });
      waiter = this.waiters.shift();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const queued = this.pending.shift();
        if (queued !== undefined) {
          return Promise.resolve({ value: queued, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<SDKUserMessage>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  };
}

// ---------------------------------------------------------------------------
// Option mapping
// ---------------------------------------------------------------------------

/**
 * BlueSpace's `PermissionMode` now mirrors the Claude Code CLI's flag values,
 * which the SDK also accepts — with one exception: the SDK calls the
 * prompt-on-anything posture `default`, and the CLI calls it `manual`.
 *
 * This function is scheduled for deletion along with the rest of this file; see
 * docs/compliance.md for why BlueSpace is leaving the SDK. It is kept correct
 * in the meantime because a half-migrated tree that does not compile hides the
 * errors that matter under the ones that do not.
 */
function toSdkPermissionMode(mode: PermissionMode): ClaudePermissionMode {
  switch (mode) {
    case 'manual':
      return 'default';
    case 'auto':
      return 'auto';
    case 'acceptEdits':
      return 'acceptEdits';
    case 'dontAsk':
      return 'dontAsk';
    case 'plan':
      return 'plan';
    case 'bypassPermissions':
      return 'bypassPermissions';
  }
}

/** Domain `Effort` and the SDK's `EffortLevel` share the same five levels. */
function toSdkEffort(effort: Effort): ClaudeOptions['effort'] {
  return effort;
}

function asJsonSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    throw new TypeError('outputSchema must be a JSON Schema object');
  }
  return schema as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Message → AdapterEvent mapping helpers
// ---------------------------------------------------------------------------

function readSessionId(msg: SDKMessage): string | undefined {
  const value = (msg as { session_id?: unknown }).session_id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * A `tool_result` block's content is either a plain string or a list of
 * content blocks. Flatten it to text so the Blackbox stores something a human
 * can read without knowing Anthropic's block shapes.
 */
function stringifyToolResult(content: unknown): string | undefined {
  if (content === undefined || content === null) return undefined;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'object' && block !== null) {
        const typed = block as { type?: unknown; text?: unknown };
        if (typed.type === 'text' && typeof typed.text === 'string') {
          parts.push(typed.text);
          continue;
        }
      }
      parts.push(safeJson(block));
    }
    return parts.join('\n');
  }
  return safeJson(content);
}

/**
 * A run can touch several models (main loop, subagents, summarizers). The
 * "dominant" one — most tokens moved — is the label worth recording.
 */
function dominantModel(modelUsage: Record<string, ModelUsage> | undefined): string | undefined {
  if (!modelUsage) return undefined;
  let best: string | undefined;
  let bestScore = -1;
  let bestCost = -1;
  for (const [name, usage] of Object.entries(modelUsage)) {
    const score = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    const cost = usage?.costUSD ?? 0;
    if (score > bestScore || (score === bestScore && cost > bestCost)) {
      bestScore = score;
      bestCost = cost;
      best = name;
    }
  }
  return best;
}

/**
 * The SDK message stream → `AdapterEvent` translation, and the two latches that
 * make it stateful: `session` is emitted once, and `exit` at most once per run.
 *
 * It lives outside `ClaudeSession` because a conversation maps the exact same
 * stream the exact same way — the only difference is that a conversation resets
 * the exit latch at each turn instead of finishing with it.
 */
class StreamMapper {
  private sessionEmitted = false;

  /** True once a terminal event has been produced for the current turn. */
  exitEmitted = false;

  /** A conversation's next turn ends too; only the exit latch is per-turn. */
  resetTurn(): void {
    this.exitEmitted = false;
  }

  *map(msg: SDKMessage, ctx: { interrupted: boolean }): Generator<AdapterEvent, void> {
    if (!this.sessionEmitted) {
      const sessionId = readSessionId(msg);
      if (sessionId !== undefined) {
        this.sessionEmitted = true;
        yield { type: 'session', sessionId };
      }
    }

    switch (msg.type) {
      case 'assistant': {
        for (const block of msg.message.content) {
          switch (block.type) {
            case 'text':
              if (block.text.length > 0) yield { type: 'text', text: block.text };
              break;
            case 'thinking':
            case 'redacted_thinking':
              yield { type: 'thinking' };
              break;
            case 'tool_use':
              yield {
                type: 'tool_use',
                toolUseId: block.id,
                name: block.name,
                input: block.input,
              };
              break;
            default:
              break;
          }
        }
        return;
      }

      case 'user': {
        const content = msg.message.content;
        if (typeof content === 'string') return;
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          yield {
            type: 'tool_result',
            toolUseId: block.tool_use_id,
            ok: block.is_error !== true,
            result: stringifyToolResult(block.content),
          };
        }
        return;
      }

      case 'result': {
        const usage = msg.usage;
        yield {
          type: 'usage',
          costUsd: msg.total_cost_usd ?? 0,
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
          cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
          model: dominantModel(msg.modelUsage),
        };

        this.exitEmitted = true;
        yield {
          type: 'exit',
          ok: !msg.is_error,
          interrupted: ctx.interrupted || undefined,
          // `stop_reason` is null on many terminal results; the result subtype
          // (error_max_turns, error_max_budget_usd, …) is the useful fallback.
          reason: msg.stop_reason ?? (msg.subtype === 'success' ? undefined : msg.subtype),
          structured: msg.subtype === 'success' ? msg.structured_output : undefined,
        };
        return;
      }

      default:
        return;
    }
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

class ClaudeSession implements Session {
  readonly id: string;

  private readonly adapter: HarnessAdapter;
  private readonly query: Query;
  private readonly input: InputQueue;
  private readonly controller: AbortController;
  private readonly signal: AbortSignal | undefined;
  private readonly onAbort: () => void;
  private readonly mapper = new StreamMapper();

  private consumed = false;
  private closed = false;
  private interrupted = false;

  constructor(init: {
    adapter: HarnessAdapter;
    id: string;
    query: Query;
    input: InputQueue;
    controller: AbortController;
    signal?: AbortSignal | undefined;
  }) {
    this.adapter = init.adapter;
    this.id = init.id;
    this.query = init.query;
    this.input = init.input;
    this.controller = init.controller;
    this.signal = init.signal;

    this.onAbort = () => {
      this.interrupted = true;
      if (!this.controller.signal.aborted) this.controller.abort();
      this.input.close();
    };

    if (this.signal) {
      if (this.signal.aborted) this.onAbort();
      else this.signal.addEventListener('abort', this.onAbort, { once: true });
    }
  }

  events(): AsyncIterable<AdapterEvent> {
    if (this.consumed) {
      throw new Error(`session "${this.id}" event stream is already being consumed`);
    }
    this.consumed = true;
    return this.pump();
  }

  private async *pump(): AsyncGenerator<AdapterEvent, void> {
    const iterator = this.query[Symbol.asyncIterator]();
    try {
      for (;;) {
        const step = await iterator.next();
        if (step.done === true) break;
        for (const event of this.mapper.map(step.value, { interrupted: this.interrupted })) {
          yield event;
          if (event.type === 'exit') return;
        }
      }
    } catch (err) {
      // A crashed subprocess, an aborted signal, or a malformed frame all end
      // the run. Callers get a terminal event rather than a thrown iterator, so
      // the orchestrator's teardown path is the same for every failure mode.
      if (!this.mapper.exitEmitted) {
        this.mapper.exitEmitted = true;
        yield {
          type: 'exit',
          ok: false,
          interrupted: this.interrupted || undefined,
          reason: errorReason(err),
        };
      }
      return;
    }

    // Stream ended without a result message (process died, input closed early).
    if (!this.mapper.exitEmitted) {
      this.mapper.exitEmitted = true;
      yield {
        type: 'exit',
        ok: false,
        interrupted: this.interrupted || undefined,
        reason: this.interrupted ? 'interrupted' : 'stream_ended_without_result',
      };
    }
  }

  async send(message: string): Promise<void> {
    requireCapability(this.adapter, 'steer');
    if (this.closed) {
      throw new Error(`session "${this.id}" is closed`);
    }
    this.input.push(userMessage(message));
  }

  async interrupt(): Promise<void> {
    requireCapability(this.adapter, 'interrupt');
    if (this.closed) return;
    this.interrupted = true;
    await this.query.interrupt();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.signal) this.signal.removeEventListener('abort', this.onAbort);
    this.input.close();

    try {
      this.query.close();
    } catch {
      // close() is a teardown path; a already-dead subprocess is not an error.
    }
    if (!this.controller.signal.aborted) this.controller.abort();
  }
}

function errorReason(err: unknown): string {
  if (err instanceof Error) {
    return err.name === 'AbortError' ? 'aborted' : err.message;
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// JSON Schema → zod raw shape
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * One JSON Schema property → one zod type.
 *
 * The supported vocabulary is deliberately small: string, number, integer,
 * boolean, a string enum, and an array of any of those. Everything else —
 * nested objects, unions, `$ref`, a missing `type` — becomes `z.unknown()`,
 * which still delivers the value to the handler but stops validating it.
 */
/**
 * How far `items` is followed before the schema is treated as unsupported.
 *
 * Nothing legitimate nests this deep, and the bound is what makes the "never
 * throws" promise true for a self-referential schema (`s.items === s`), which
 * would otherwise recurse until the stack gives out.
 */
const MAX_SCHEMA_DEPTH = 32;

function jsonSchemaToZodType(prop: Record<string, unknown>, depth = 0): z.ZodType {
  if (depth >= MAX_SCHEMA_DEPTH) return z.unknown();

  const values = prop['enum'];
  if (Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === 'string')) {
    return z.enum(values as string[]);
  }

  switch (prop['type']) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'array': {
      const items = asRecord(prop['items']);
      return z.array(items === undefined ? z.unknown() : jsonSchemaToZodType(items, depth + 1));
    }
    default:
      return z.unknown();
  }
}

/**
 * `ToolDef.inputSchema` is JSON Schema — the one tool-description format every
 * harness understands — but the SDK's `tool()` wants a zod RAW SHAPE. This is
 * that translation, and it is the whole reason `ToolDef` can stay vendor-neutral.
 *
 * An unsupported construct degrades to `z.unknown()` rather than throwing: an
 * over-permissive schema costs at worst one confused tool call, whereas a
 * converter that throws takes the entire conversation down at startup.
 *
 * Exported because it is the sharp edge of this file and deserves its own tests.
 */
export function jsonSchemaToZodShape(schema: Record<string, unknown>): Record<string, z.ZodType> {
  const shape: Record<string, z.ZodType> = {};

  const properties = asRecord(schema['properties']);
  if (properties === undefined) return shape;

  const requiredRaw = schema['required'];
  const required = new Set(
    Array.isArray(requiredRaw) ? requiredRaw.filter((n): n is string => typeof n === 'string') : [],
  );

  for (const [name, raw] of Object.entries(properties)) {
    const prop = asRecord(raw);
    const base = prop === undefined ? z.unknown() : jsonSchemaToZodType(prop);

    // Optional FIRST, description SECOND: a description attached before the
    // `.optional()` wrapper is not carried by it, and the description is how the
    // model learns what the argument means.
    let type: z.ZodType = required.has(name) ? base : base.optional();

    const description = prop?.['description'];
    if (typeof description === 'string' && description.length > 0) {
      type = type.describe(description);
    }

    // defineProperty, not `shape[name] = type`: a property literally named
    // `__proto__` would otherwise be swallowed by the setter on Object.prototype
    // and vanish from the shape instead of reaching the model.
    Object.defineProperty(shape, name, {
      value: type,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return shape;
}

// ---------------------------------------------------------------------------
// ToolDef → in-process MCP server
// ---------------------------------------------------------------------------

/** The MCP namespace hosted tools land in; the model sees `mcp__tools__<name>`. */
const CONVERSATION_SERVER_NAME = 'tools';

function toolInput(args: unknown): Record<string, unknown> {
  return asRecord(args) ?? {};
}

/**
 * Wrap each `ToolDef` as an SDK tool.
 *
 * The try/catch is load-bearing: a handler that throws must come back to the
 * model as a readable tool error it can react to. Letting it escape would abort
 * the query and end the captain's conversation over a bad task id.
 */
function toSdkTools(defs: ToolDef[]): SdkMcpToolDefinition<AnyZodRawShape>[] {
  const tools = defs.map((def) =>
    tool(def.name, def.description, jsonSchemaToZodShape(def.inputSchema), async (args) => {
      try {
        return { content: [{ type: 'text' as const, text: await def.handler(toolInput(args)) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: errorReason(err) }], isError: true };
      }
    }),
  );
  return tools as SdkMcpToolDefinition<AnyZodRawShape>[];
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

/**
 * A single-producer, single-consumer queue of one turn's events.
 *
 * The SDK stream is one continuous sequence for the whole conversation, but
 * `Conversation.send()` promises an iterable that ENDS with the turn. This is
 * the seam: the pump pushes, the caller's `for await` drains, and closing the
 * channel is what ends that caller's loop without ending the session.
 */
class EventChannel {
  private readonly pending: AdapterEvent[] = [];
  private readonly waiters: Array<(r: IteratorResult<AdapterEvent>) => void> = [];
  private closed = false;

  push(event: AdapterEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    this.pending.push(event);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    let waiter = this.waiters.shift();
    while (waiter) {
      waiter({ value: undefined, done: true });
      waiter = this.waiters.shift();
    }
  }

  async *drain(): AsyncGenerator<AdapterEvent, void> {
    for (;;) {
      const queued = this.pending.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<AdapterEvent>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (next.done === true) continue; // released by close(); drain the tail, then end
      yield next.value;
    }
  }
}

/**
 * How many between-turn events are held for the next turn.
 *
 * In practice this holds exactly one `session`. The bound is only here so a
 * harness that chattered forever between turns could not grow the buffer
 * without limit.
 */
const MAX_PRETURN_EVENTS = 64;

/** An iterable that fails on first read — how `send()` reports a misuse. */
function rejectingTurn(error: Error): AsyncIterable<AdapterEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<AdapterEvent> {
      return { next: (): Promise<IteratorResult<AdapterEvent>> => Promise.reject(error) };
    },
  };
}

class ClaudeConversation implements Conversation {
  readonly id: string;

  private readonly adapter: HarnessAdapter;
  private readonly query: Query;
  private readonly input: InputQueue;
  private readonly controller: AbortController;
  private readonly signal: AbortSignal | undefined;
  private readonly onAbort: () => void;
  private readonly mapper = new StreamMapper();

  /** The turn in flight, or undefined between turns. Also the concurrency lock. */
  private turn: EventChannel | undefined;
  /**
   * Events the stream produced while no turn was in flight.
   *
   * The pump starts with the query, and the harness announces itself (the
   * `system:init` frame carrying the session id) as soon as its subprocess is
   * up — before the captain has said anything. Those events belong to the first
   * turn that asks for them, so they wait here instead of being dropped, which
   * would burn the `session` latch and leave the conversation never reporting
   * its id at all.
   */
  private readonly preTurn: AdapterEvent[] = [];
  private closed = false;
  private interrupted = false;
  /** Why the underlying stream stopped for good; undefined while it is alive. */
  private ended: string | undefined;

  constructor(init: {
    adapter: HarnessAdapter;
    id: string;
    query: Query;
    input: InputQueue;
    controller: AbortController;
    signal?: AbortSignal | undefined;
  }) {
    this.adapter = init.adapter;
    this.id = init.id;
    this.query = init.query;
    this.input = init.input;
    this.controller = init.controller;
    this.signal = init.signal;

    this.onAbort = () => {
      this.interrupted = true;
      if (!this.controller.signal.aborted) this.controller.abort();
      this.input.close();
    };

    if (this.signal) {
      if (this.signal.aborted) this.onAbort();
      else this.signal.addEventListener('abort', this.onAbort, { once: true });
    }

    // One pump for the life of the conversation. Turns come and go; the SDK
    // stream underneath them does not.
    void this.pump();
  }

  send(message: string): AsyncIterable<AdapterEvent> {
    if (this.closed) {
      return rejectingTurn(new Error(`conversation "${this.id}" is closed`));
    }
    if (this.ended !== undefined) {
      return rejectingTurn(new Error(`conversation "${this.id}" has ended: ${this.ended}`));
    }
    if (this.turn !== undefined) {
      // Two turns on one session would interleave into a single stream with no
      // way to tell whose event is whose. Refusing is the only honest answer.
      return rejectingTurn(
        new Error(
          `conversation "${this.id}" is already mid-turn; finish the current send() before starting another`,
        ),
      );
    }

    const turn = new EventChannel();
    this.turn = turn;
    this.mapper.resetTurn();
    // Anything the stream said before anyone was listening opens this turn.
    let buffered = this.preTurn.shift();
    while (buffered !== undefined) {
      turn.push(buffered);
      buffered = this.preTurn.shift();
    }
    this.input.push(userMessage(message));
    return turn.drain();
  }

  async interrupt(): Promise<void> {
    requireCapability(this.adapter, 'interrupt');
    if (this.closed) return;
    this.interrupted = true;
    await this.query.interrupt();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.signal) this.signal.removeEventListener('abort', this.onAbort);
    this.input.close();

    try {
      this.query.close();
    } catch {
      // close() is a teardown path; an already-dead subprocess is not an error.
    }
    if (!this.controller.signal.aborted) this.controller.abort();

    // Whoever is parked on the current turn gets a terminal event, not a hang.
    this.stop('closed');
  }

  private async pump(): Promise<void> {
    const iterator = this.query[Symbol.asyncIterator]();
    try {
      for (;;) {
        const step = await iterator.next();
        if (step.done === true) break;
        for (const event of this.mapper.map(step.value, { interrupted: this.interrupted })) {
          if (this.turn === undefined) {
            // Between turns: hold it for whoever sends next rather than dropping
            // it. A terminal event is the exception — an `exit` with no turn to
            // end is meaningless, and replaying one would end the NEXT turn
            // before the model had said anything.
            if (event.type !== 'exit' && this.preTurn.length < MAX_PRETURN_EVENTS) {
              this.preTurn.push(event);
            }
            continue;
          }
          this.turn.push(event);
          // The turn's `exit` closes the caller's iterable and nothing more —
          // the session stays up, waiting for the next send().
          if (event.type === 'exit') this.endTurn();
        }
      }
      this.stop(this.interrupted ? 'interrupted' : 'stream_ended_without_result');
    } catch (err) {
      this.stop(errorReason(err));
    }
  }

  /** End the turn in flight, leaving the session open for the next one. */
  private endTurn(): void {
    const turn = this.turn;
    this.turn = undefined;
    turn?.close();
  }

  /** The stream is gone for good: fail the turn in flight and refuse new ones. */
  private stop(reason: string): void {
    if (this.ended !== undefined) return;
    this.ended = reason;
    if (this.turn === undefined) return;
    if (!this.mapper.exitEmitted) {
      this.mapper.exitEmitted = true;
      this.turn.push({
        type: 'exit',
        ok: false,
        interrupted: this.interrupted || undefined,
        reason,
      });
    }
    this.endTurn();
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Raised when the `claude` executable cannot be found or will not answer. */
export class ClaudeCliUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `Claude Code is not usable: ${detail}\n\n` +
        'BlueSpace runs its crews through your own installed Claude CLI, using the\n' +
        'login you already have — there is no separate key to manage. It needs the\n' +
        '`claude` command on PATH and signed in.\n\n' +
        '  1. install:  https://claude.com/claude-code\n' +
        '  2. sign in:  run `claude` once and complete the login\n' +
        '  3. check:    `claude --version` should print a version\n\n' +
        'If `claude` lives somewhere unusual, point BlueSpace at it:\n' +
        '  export CLAUDE_CLI_PATH=/full/path/to/claude',
    );
    this.name = 'ClaudeCliUnavailableError';
  }
}

/** Override for a `claude` binary that is not on PATH. */
export const CLI_PATH_ENV = 'CLAUDE_CLI_PATH';

export type AuthMode =
  /** The captain's own Claude CLI login — the default, and what most people have. */
  | { kind: 'cli-login' }
  /** An explicit key in the environment, which the SDK will prefer on its own. */
  | { kind: 'api-key'; key: string };

/**
 * Report how this run will authenticate.
 *
 * BlueSpace drives the Claude CLI the captain already installed and signed into,
 * so the normal path needs no configuration at all: whatever `claude` is logged
 * in as is what the crews run as. An `ANTHROPIC_API_KEY` in the environment is
 * honoured too — the SDK prefers it — which is what makes headless and CI runs
 * possible without a login.
 *
 * This function only reports; it never throws. What can actually fail is the CLI
 * being absent or signed out, and that is `assertClaudeCliAvailable`'s job.
 */
export function resolveAuth(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const key = env['ANTHROPIC_API_KEY']?.trim();
  if (key !== undefined && key !== '') return { kind: 'api-key', key };
  return { kind: 'cli-login' };
}

export interface CliInfo {
  /** What we invoke: an absolute path when overridden, otherwise plain `claude`. */
  path: string;
  version: string;
}

/**
 * Prove the CLI exists and answers before anything is dispatched.
 *
 * The SDK spawns `claude` lazily, so without this check a missing or signed-out
 * CLI surfaces as a dead session partway through a task — after a worktree has
 * been created and the captain has been told work started. Checking up front
 * turns that into one sentence at startup, which is the entire difference
 * between a tool that feels solid and one that feels haunted.
 */
/**
 * Turn `claude` into the absolute path it actually resolves to.
 *
 * This matters more than it looks. Left unset, the SDK runs a copy of the CLI it
 * ships inside its own package rather than the one the captain installed — same
 * product, but a version the SDK pins, not the version they chose and updated.
 * Resolving here means the binary we verified at startup is the binary that runs,
 * instead of two things that merely happen to agree today.
 */
function resolveOnPath(name: string): string {
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split('\n')[0]
      ?.trim();
    if (found !== undefined && found !== '') return found;
  } catch {
    /* fall through: let the --version probe below produce the real error */
  }
  return name;
}

export function assertClaudeCliAvailable(env: NodeJS.ProcessEnv = process.env): CliInfo {
  const override = env[CLI_PATH_ENV]?.trim();
  const bin = override !== undefined && override !== '' ? override : resolveOnPath('claude');
  try {
    const version = execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n')[0];
    if (version === undefined || version === '') {
      throw new ClaudeCliUnavailableError(`\`${bin} --version\` printed nothing`);
    }
    return { path: bin, version };
  } catch (e: unknown) {
    if (e instanceof ClaudeCliUnavailableError) throw e;
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new ClaudeCliUnavailableError(`\`${bin}\` was not found on PATH`);
    }
    if (code === 'ETIMEDOUT') {
      throw new ClaudeCliUnavailableError(`\`${bin} --version\` timed out`);
    }
    throw new ClaudeCliUnavailableError(
      (e as Error).message.split('\n')[0] ?? 'unknown failure',
    );
  }
}

export class ClaudeAdapter implements HarnessAdapter {
  readonly name = 'claude';
  readonly capabilities: AdapterCapabilities = CLAUDE_CAPABILITIES;

  private readonly executablePath: string | undefined;

  constructor(opts?: { executablePath?: string }) {
    // Resolve the CLI the same way the startup check does, so "BlueSpace verified
    // my claude" and "BlueSpace runs my claude" are the same binary.
    //
    // Without this the SDK falls back to a copy of the CLI bundled inside its own
    // package — a version it pins rather than the one the captain installed and
    // updates. That divergence is silent and only shows up as the fleet behaving
    // unlike the `claude` they just upgraded, which is a miserable thing to debug.
    if (opts?.executablePath !== undefined) {
      this.executablePath = opts.executablePath;
      return;
    }
    try {
      this.executablePath = assertClaudeCliAvailable().path;
    } catch {
      // No usable CLI. Leave it undefined and let the caller's startup check
      // produce the actionable error rather than throwing from a constructor.
      this.executablePath = undefined;
    }
  }

  /**
   * The environment handed to every SDK run.
   *
   * Passed through as-is: BlueSpace drives the captain's own Claude CLI, so the
   * credential it uses is whatever that CLI is signed in as. An ANTHROPIC_API_KEY
   * already present in the environment rides along and the SDK prefers it, which
   * is how a headless or CI run works without a login.
   */
  private authEnv(): Record<string, string | undefined> {
    return { ...process.env };
  }

  async spawn(req: SpawnRequest): Promise<Session> {
    if (req.outputSchema !== undefined) requireCapability(this, 'structuredOutput');
    if (req.resume !== undefined) requireCapability(this, 'fork');

    const { profile } = req;
    const controller = new AbortController();
    const input = new InputQueue();
    input.push(userMessage(req.prompt));

    const options: ClaudeOptions = {
      cwd: req.cwd,
      env: this.authEnv(),
      abortController: controller,
      permissionMode: toSdkPermissionMode(profile.permissionMode),
    };

    // `bypassPermissions` is refused by the SDK unless this flag rides along.
    // It is a paired safety interlock, not a knob the captain sets separately.
    if (profile.permissionMode === 'bypassPermissions') {
      options.allowDangerouslySkipPermissions = true;
    }

    if (profile.model !== undefined) options.model = profile.model;
    if (profile.effort !== undefined) options.effort = toSdkEffort(profile.effort);
    if (profile.maxTurns !== undefined) options.maxTurns = profile.maxTurns;
    if (profile.maxBudgetUsd !== undefined) options.maxBudgetUsd = profile.maxBudgetUsd;
    if (this.executablePath !== undefined) options.pathToClaudeCodeExecutable = this.executablePath;

    // Always the preset, never the SDK's minimal prompt. `systemPrompt` left
    // unset means the worker gets Claude Code's tools without Claude Code's
    // instructions — which reads as a subtly worse model rather than as a
    // missing option, so it is not a mistake anyone finds by looking at output.
    options.systemPrompt = {
      type: 'preset',
      preset: 'claude_code',
      append: req.systemPromptAppend,
    };

    // Stated, never inferred. An absent `settingSources` means all three
    // scopes, so the only way to not inherit the captain's own hooks is to say so.
    options.settingSources = [...req.settingScopes];

    if (req.outputSchema !== undefined) {
      options.outputFormat = { type: 'json_schema', schema: asJsonSchema(req.outputSchema) };
    }

    // Session id: a fresh run (or a fork of an old one) gets a UUID we choose,
    // so `Session.id` is usable immediately. A straight resume keeps the id it
    // is resuming into — the SDK forbids overriding it in that case.
    let id: string;
    if (req.resume !== undefined) {
      const fork = req.resume.fork === true;
      options.resume = req.resume.sessionId;
      if (req.resume.atMessageId !== undefined) options.resumeSessionAt = req.resume.atMessageId;
      if (fork) {
        options.forkSession = true;
        id = randomUUID();
        options.sessionId = id;
      } else {
        id = req.resume.sessionId;
      }
    } else {
      id = randomUUID();
      options.sessionId = id;
    }

    const q = query({ prompt: input, options });

    return new ClaudeSession({
      adapter: this,
      id,
      query: q,
      input,
      controller,
      signal: req.signal,
    });
  }

  async converse(req: ConversationRequest): Promise<Conversation> {
    requireCapability(this, 'conversation');

    const { profile } = req;
    const controller = new AbortController();
    // Streaming input again, and for the same reason: a string prompt would be
    // one shot, and this session has to survive every turn the captain takes.
    const input = new InputQueue();

    const server = createSdkMcpServer({
      name: CONVERSATION_SERVER_NAME,
      version: '0.1.0',
      instructions: 'Tools hosted by the caller. Prefer them over the built-in read tools.',
      tools: toSdkTools(req.tools),
    });

    const id = randomUUID();
    const options: ClaudeOptions = {
      sessionId: id,
      systemPrompt: req.systemPrompt,
      env: this.authEnv(),
      mcpServers: { [CONVERSATION_SERVER_NAME]: server },
      abortController: controller,
      permissionMode: toSdkPermissionMode(profile.permissionMode),
      // The caller's tools ARE the conversation's control surface. The built-ins
      // are here only so it can look at a repo to answer a question, so they are
      // the read-only three — anything that changes the world goes through a
      // ToolDef, where the caller can see it.
      tools: ['Read', 'Glob', 'Grep'],
      // Same reasoning as spawn(): stated, never inferred.
      settingSources: [...req.settingScopes],
    };

    // Same paired safety interlock as spawn(): the SDK refuses one without the other.
    if (profile.permissionMode === 'bypassPermissions') {
      options.allowDangerouslySkipPermissions = true;
    }

    if (req.cwd !== undefined) options.cwd = req.cwd;
    if (profile.model !== undefined) options.model = profile.model;
    if (profile.effort !== undefined) options.effort = toSdkEffort(profile.effort);
    if (profile.maxTurns !== undefined) options.maxTurns = profile.maxTurns;
    if (profile.maxBudgetUsd !== undefined) options.maxBudgetUsd = profile.maxBudgetUsd;
    if (this.executablePath !== undefined) options.pathToClaudeCodeExecutable = this.executablePath;

    const q = query({ prompt: input, options });

    return new ClaudeConversation({
      adapter: this,
      id,
      query: q,
      input,
      controller,
      signal: req.signal,
    });
  }
}

export function createClaudeAdapter(opts?: { executablePath?: string }): HarnessAdapter {
  return new ClaudeAdapter(opts);
}
