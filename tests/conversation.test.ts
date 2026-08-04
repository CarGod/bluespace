/**
 * The conversation surface — the boundary Helm runs on.
 *
 * Two things are worth testing here and they are both about the seam, not about
 * the vendor. First, `jsonSchemaToZodShape`: `ToolDef` describes its input in
 * JSON Schema because that is the format every harness understands, and this
 * converter is what lets the Claude adapter accept it. Its failure mode matters
 * as much as its success — an unsupported construct must degrade, never throw,
 * because a throw takes down the whole session at startup.
 *
 * Second, the `Conversation` contract itself, exercised against a fake adapter:
 * a turn's iterable ends with the turn, the session survives to the next one,
 * and two turns at once are refused rather than interleaved. Those are the
 * promises `src/cli/index.ts` is written against, so they are tested against the
 * interface rather than against Anthropic's subprocess.
 */

import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { jsonSchemaToZodShape } from '../src/adapters/claude.js';
import type {
  AdapterCapabilities,
  AdapterEvent,
  Conversation,
  ConversationRequest,
  HarnessAdapter,
  Session,
  SpawnRequest,
  ToolDef,
} from '../src/adapters/types.js';
import { UnsupportedCapabilityError, requireCapability } from '../src/adapters/types.js';
import type { DispatchProfile } from '../src/types/domain.js';

// ---------------------------------------------------------------------------
// jsonSchemaToZodShape
// ---------------------------------------------------------------------------

describe('jsonSchemaToZodShape — supported vocabulary', () => {
  const shape = jsonSchemaToZodShape({
    type: 'object',
    properties: {
      name: { type: 'string', description: 'who' },
      ratio: { type: 'number' },
      count: { type: 'integer' },
      loud: { type: 'boolean' },
      kind: { type: 'string', enum: ['mission', 'recon'], description: 'what sort' },
      tags: { type: 'array', items: { type: 'string' } },
      sizes: { type: 'array', items: { type: 'integer' } },
    },
    required: ['name', 'kind'],
  });

  it('maps every scalar type onto a validating zod type', () => {
    expect(shape['name']?.parse('helm')).toBe('helm');
    expect(shape['ratio']?.parse(1.5)).toBe(1.5);
    expect(shape['count']?.parse(3)).toBe(3);
    expect(shape['loud']?.parse(true)).toBe(true);

    expect(() => shape['name']?.parse(7)).toThrow();
    expect(() => shape['ratio']?.parse('1.5')).toThrow();
    expect(() => shape['loud']?.parse('yes')).toThrow();
  });

  it('holds integers to whole numbers', () => {
    expect(() => shape['count']?.parse(1.5)).toThrow();
  });

  it('turns an enum into a closed set', () => {
    expect(shape['kind']?.parse('recon')).toBe('recon');
    expect(() => shape['kind']?.parse('sortie')).toThrow();
  });

  it('maps arrays of scalars, element type included', () => {
    expect(shape['tags']?.parse(['a', 'b'])).toEqual(['a', 'b']);
    expect(() => shape['tags']?.parse(['a', 2])).toThrow();
    expect(shape['sizes']?.parse([1, 2])).toEqual([1, 2]);
    expect(() => shape['sizes']?.parse([1.5])).toThrow();
  });

  it('makes everything outside `required` optional', () => {
    // Both are absent from `required`, so an omitted value has to be legal.
    expect(shape['ratio']?.parse(undefined)).toBeUndefined();
    expect(shape['tags']?.parse(undefined)).toBeUndefined();
    // …while a required field still refuses to be omitted.
    expect(() => shape['name']?.parse(undefined)).toThrow();
  });

  it('carries descriptions through, optional fields included', () => {
    expect(shape['name']?.description).toBe('who');
    expect(shape['kind']?.description).toBe('what sort');
  });

  it('produces one entry per property and nothing else', () => {
    expect(Object.keys(shape).sort()).toEqual(
      ['count', 'kind', 'loud', 'name', 'ratio', 'sizes', 'tags'].sort(),
    );
  });
});

describe('jsonSchemaToZodShape — degrading instead of throwing', () => {
  it('falls back to an accept-anything type for unsupported constructs', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { a: { type: 'string' } } },
        ref: { $ref: '#/definitions/thing' },
        untyped: { description: 'no type at all' },
        weird: { type: 'null' },
        listOfObjects: { type: 'array', items: { type: 'object' } },
      },
      required: ['nested', 'ref', 'untyped', 'weird', 'listOfObjects'],
    });

    // Over-permissive on purpose: the value still reaches the handler.
    expect(shape['nested']?.parse({ a: 'x' })).toEqual({ a: 'x' });
    expect(shape['ref']?.parse(42)).toBe(42);
    expect(shape['untyped']?.parse('anything')).toBe('anything');
    expect(shape['weird']?.parse(null)).toBeNull();
    expect(shape['listOfObjects']?.parse([{ a: 1 }])).toEqual([{ a: 1 }]);
    // An array is still known to be an array, even when its items are not.
    expect(() => shape['listOfObjects']?.parse('nope')).toThrow();
  });

  it('survives schemas that are not object schemas at all', () => {
    expect(jsonSchemaToZodShape({})).toEqual({});
    expect(jsonSchemaToZodShape({ type: 'object' })).toEqual({});
    expect(jsonSchemaToZodShape({ type: 'string' })).toEqual({});
    expect(jsonSchemaToZodShape({ type: 'object', properties: 'garbage' })).toEqual({});
  });

  it('degrades instead of blowing the stack on a self-referential schema', () => {
    // `items` pointing back at its own schema is the one input that made the
    // converter throw — and "never throws" is the entire reason it degrades.
    const cyclic: Record<string, unknown> = { type: 'array' };
    cyclic['items'] = cyclic;

    let shape: Record<string, z.ZodType> = {};
    expect(() => {
      shape = jsonSchemaToZodShape({ properties: { a: cyclic }, required: ['a'] });
    }).not.toThrow();
    // Still known to be an array — the recursion is bounded, not abandoned, so
    // it is `items` far enough down that finally degrades to accept-anything.
    expect(shape['a']?.parse([])).toEqual([]);
    expect(() => shape['a']?.parse('not a list')).toThrow();
  });

  it('keeps a property literally named `__proto__`', () => {
    // Plain assignment hits the Object.prototype setter and the property
    // disappears from the shape instead of reaching the model.
    const schema = JSON.parse(
      '{"properties":{"__proto__":{"type":"string"},"ok":{"type":"string"}},"required":["__proto__","ok"]}',
    ) as Record<string, unknown>;
    const shape = jsonSchemaToZodShape(schema);

    expect(Object.keys(shape).sort()).toEqual(['__proto__', 'ok']);
    expect(Object.getPrototypeOf(shape)).toBe(Object.prototype);
  });

  it('tolerates junk in `properties` and `required`', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: { ok: { type: 'string' }, broken: 'not a schema' },
      required: 'not an array',
    });
    expect(shape['ok']?.parse('x')).toBe('x');
    expect(shape['broken']?.parse({ whatever: true })).toEqual({ whatever: true });
  });
});

// ---------------------------------------------------------------------------
// A fake harness that hosts conversations
// ---------------------------------------------------------------------------

const CAPS: AdapterCapabilities = {
  interrupt: true,
  fork: true,
  cost: true,
  toolEvents: true,
  structuredOutput: true,
  steer: true,
  conversation: true,
};

/**
 * A conversation with a scripted "model": each turn echoes the message, calls
 * the first tool it was given, and exits — enough to prove the turn boundary,
 * the session's survival across turns, and the concurrency guard.
 */
class FakeConversation implements Conversation {
  readonly id = 'convo-1';
  readonly received: string[] = [];

  closed = 0;
  interrupts = 0;

  private turnInFlight = false;

  constructor(private readonly tools: ToolDef[]) {}

  send(message: string): AsyncIterable<AdapterEvent> {
    if (this.closed > 0) return failing(new Error('conversation is closed'));
    if (this.turnInFlight) {
      return failing(new Error('conversation is already mid-turn'));
    }
    this.turnInFlight = true;
    this.received.push(message);
    return this.turn(message);
  }

  private async *turn(message: string): AsyncGenerator<AdapterEvent> {
    try {
      if (this.received.length === 1) yield { type: 'session', sessionId: this.id };
      yield { type: 'text', text: `heard: ${message}` };

      const tool = this.tools[0];
      if (tool !== undefined) {
        yield { type: 'tool_use', toolUseId: 't1', name: tool.name, input: {} };
        const result = await tool.handler({});
        yield { type: 'tool_result', toolUseId: 't1', ok: true, result };
      }

      yield { type: 'usage', costUsd: 0.01, inputTokens: 10, outputTokens: 2 };
      yield { type: 'exit', ok: true };
    } finally {
      this.turnInFlight = false;
    }
  }

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

function failing(error: Error): AsyncIterable<AdapterEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<AdapterEvent> {
      return { next: (): Promise<IteratorResult<AdapterEvent>> => Promise.reject(error) };
    },
  };
}

class FakeAdapter implements HarnessAdapter {
  readonly name = 'fake';
  readonly capabilities: AdapterCapabilities = { ...CAPS };
  readonly conversations: Array<{ request: ConversationRequest; convo: FakeConversation }> = [];

  async spawn(_req: SpawnRequest): Promise<Session> {
    throw new Error('not used in this suite');
  }

  async converse(request: ConversationRequest): Promise<Conversation> {
    requireCapability(this, 'conversation');
    const convo = new FakeConversation(request.tools);
    this.conversations.push({ request, convo });
    return convo;
  }
}

const PROFILE: DispatchProfile = { permissionMode: 'bypassPermissions' };

function echoTool(calls: string[]): ToolDef {
  return {
    name: 'ping',
    description: 'Answer with pong. Call this whenever the captain says ping.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      calls.push('ping');
      return 'pong';
    },
  };
}

async function collect(stream: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe('Conversation contract', () => {
  it('ends the turn at `exit` and keeps the session for the next one', async () => {
    const calls: string[] = [];
    const adapter = new FakeAdapter();
    const convo = await adapter.converse({
      systemPrompt: 'you are helm',
      tools: [echoTool(calls)],
      profile: PROFILE,
    });

    const first = await collect(convo.send('ping once'));
    // The iterable ended on its own — no close(), no abort — and it ended with exit.
    expect(first.at(-1)).toEqual({ type: 'exit', ok: true });
    expect(first.map((e) => e.type)).toEqual([
      'session',
      'text',
      'tool_use',
      'tool_result',
      'usage',
      'exit',
    ]);
    expect(calls).toEqual(['ping']);

    // The same conversation continues: no second session event, and the fake
    // still has the whole history.
    const second = await collect(convo.send('ping again'));
    expect(second.map((e) => e.type)).not.toContain('session');
    expect(second.at(-1)).toEqual({ type: 'exit', ok: true });

    const state = adapter.conversations[0]?.convo;
    expect(state?.received).toEqual(['ping once', 'ping again']);
    expect(calls).toEqual(['ping', 'ping']);
    expect(state?.closed).toBe(0);
  });

  it('streams the turn incrementally rather than after the fact', async () => {
    const adapter = new FakeAdapter();
    const convo = await adapter.converse({
      systemPrompt: 'you are helm',
      tools: [],
      profile: PROFILE,
    });

    const seen: string[] = [];
    for await (const ev of convo.send('hello')) {
      seen.push(ev.type);
      if (ev.type === 'text') expect(ev.text).toBe('heard: hello');
    }
    expect(seen).toEqual(['session', 'text', 'usage', 'exit']);
  });

  it('refuses a second turn while one is in flight instead of interleaving', async () => {
    const adapter = new FakeAdapter();
    const convo = await adapter.converse({
      systemPrompt: 'you are helm',
      tools: [],
      profile: PROFILE,
    });

    const inFlight = convo.send('first');
    const iterator = inFlight[Symbol.asyncIterator]();
    await iterator.next(); // open the turn without finishing it

    await expect(collect(convo.send('second'))).rejects.toThrow(/mid-turn/);

    // The first turn is untouched by the refusal and still runs to completion.
    const rest: AdapterEvent[] = [];
    for (;;) {
      const step = await iterator.next();
      if (step.done === true) break;
      rest.push(step.value);
    }
    expect(rest.at(-1)).toEqual({ type: 'exit', ok: true });

    // …and once it is done, the next turn is accepted.
    const next = await collect(convo.send('third'));
    expect(next.at(-1)).toEqual({ type: 'exit', ok: true });
  });

  it('is closed idempotently and refuses turns afterwards', async () => {
    const adapter = new FakeAdapter();
    const convo = await adapter.converse({
      systemPrompt: 'you are helm',
      tools: [],
      profile: PROFILE,
    });

    await convo.close();
    await convo.close();
    expect(adapter.conversations[0]?.convo.closed).toBe(2);
    await expect(collect(convo.send('too late'))).rejects.toThrow(/closed/);
  });

  it('hands the caller the tools it was given, unwrapped', async () => {
    const calls: string[] = [];
    const adapter = new FakeAdapter();
    const tools = [echoTool(calls)];
    await adapter.converse({ systemPrompt: 'p', tools, profile: PROFILE, cwd: '/tmp/x' });

    const request = adapter.conversations[0]?.request;
    expect(request?.tools).toBe(tools);
    expect(request?.cwd).toBe('/tmp/x');
    expect(request?.profile.permissionMode).toBe('bypassPermissions');
  });

  it('refuses to converse when the capability is not declared', async () => {
    const adapter = new FakeAdapter();
    adapter.capabilities.conversation = false;
    expect(() => requireCapability(adapter, 'conversation')).toThrow(UnsupportedCapabilityError);
    await expect(
      adapter.converse({ systemPrompt: 'p', tools: [], profile: PROFILE }),
    ).rejects.toThrow(UnsupportedCapabilityError);
  });
});
