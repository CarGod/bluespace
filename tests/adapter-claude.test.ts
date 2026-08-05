/**
 * The Claude adapter's own behaviour, driven against a stand-in for the SDK.
 *
 * `tests/conversation.test.ts` proves the `Conversation` CONTRACT using a fake
 * adapter — useful, but it cannot catch a real adapter that honours the types
 * and breaks the promise. The one that matters most is invisible to the type
 * checker: `send()` must continue ONE session rather than start a fresh query
 * per turn, which would silently discard the whole conversation each time and
 * still compile, still stream events, and still look right on screen.
 *
 * So this suite mocks `@anthropic-ai/claude-agent-sdk` and exercises the real
 * `ClaudeAdapter`: one query for many turns, the concurrency guard, teardown,
 * and the ToolDef → in-process MCP server translation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const reg = vi.hoisted(() => ({
  makeQuery: null as unknown as (args: Record<string, any>) => any,
  servers: [] as Array<Record<string, any>>,
  queryCalls: [] as Array<Record<string, any>>,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: Record<string, any>) => {
    reg.queryCalls.push(args);
    return reg.makeQuery(args);
  },
  tool: (name: string, description: string, shape: unknown, handler: unknown) => ({
    name,
    description,
    shape,
    handler,
  }),
  createSdkMcpServer: (cfg: Record<string, any>) => {
    reg.servers.push(cfg);
    return { name: cfg['name'], tools: cfg['tools'] };
  },
}));

const { ClaudeAdapter } = await import('../src/adapters/claude.js');
import type { AdapterEvent, ToolDef } from '../src/adapters/types.js';
import type { DispatchProfile } from '../src/types/domain.js';

// ---------------------------------------------------------------------------
// A stand-in for the SDK's Query: an async iterable of SDK messages, fed by
// whatever the adapter writes into its streaming-input prompt.
// ---------------------------------------------------------------------------

class Chan {
  private readonly pending: unknown[] = [];
  private readonly waiters: Array<(r: IteratorResult<any>) => void> = [];
  private done = false;

  push(v: unknown): void {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.pending.push(v);
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    let w = this.waiters.shift();
    while (w) {
      w({ value: undefined, done: true });
      w = this.waiters.shift();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<any> {
    return {
      next: (): Promise<IteratorResult<any>> => {
        const q = this.pending.shift();
        if (q !== undefined) return Promise.resolve({ value: q, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<any>>((r) => this.waiters.push(r));
      },
    };
  }
}

class FakeQuery {
  closeCount = 0;
  interruptCount = 0;
  /** Every user message the adapter pushed, in order — the history proof. */
  readonly turns: string[] = [];
  readonly out = new Chan();
  readonly sessionId: string;
  /** Swap to script a turn that stalls, dies, or says nothing. */
  onTurn: (q: FakeQuery, text: string) => void | Promise<void> = (q, t) => q.answer(t);

  constructor(args: Record<string, any>) {
    this.sessionId = (args['options']?.sessionId as string | undefined) ?? 'sess-x';
    void this.run(args['prompt'] as AsyncIterable<any>);
  }

  private async run(prompt: AsyncIterable<any>): Promise<void> {
    for await (const msg of prompt) {
      const content = msg.message.content;
      const text = typeof content === 'string' ? content : '';
      this.turns.push(text);
      await this.onTurn(this, text);
    }
    this.out.end();
  }

  /** The init frame a real harness emits as soon as its subprocess is up. */
  announce(): void {
    this.out.push({ type: 'system', subtype: 'init', session_id: this.sessionId });
  }

  answer(text: string): void {
    this.out.push({
      type: 'assistant',
      session_id: this.sessionId,
      message: { role: 'assistant', content: [{ type: 'text', text: `heard: ${text}` }] },
    });
    this.out.push({
      type: 'result',
      subtype: 'success',
      session_id: this.sessionId,
      is_error: false,
      stop_reason: null,
      total_cost_usd: 0.02,
      usage: { input_tokens: 5, output_tokens: 7 },
      modelUsage: { 'claude-x': { inputTokens: 5, outputTokens: 7, costUSD: 0.02 } },
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<any> {
    return this.out[Symbol.asyncIterator]();
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
  }

  close(): void {
    this.closeCount += 1;
    this.out.end();
  }
}

const PROFILE: DispatchProfile = { permissionMode: 'bypassPermissions' };

let last: FakeQuery;

/** Install a query factory, optionally customising each FakeQuery. */
function harness(setup?: (q: FakeQuery) => void): void {
  reg.makeQuery = (args) => {
    const q = new FakeQuery(args);
    if (setup) setup(q);
    last = q;
    return q;
  };
}

beforeEach(() => {
  reg.servers.length = 0;
  reg.queryCalls.length = 0;
  harness();
});

async function collect(s: AsyncIterable<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  for await (const e of s) out.push(e);
  return out;
}

/** Fail loudly instead of hanging the suite when a turn never ends. */
function within<T>(p: Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('turn never ended')), ms)),
  ]);
}

const converse = (tools: ToolDef[] = []) =>
  new ClaudeAdapter().converse({ systemPrompt: 'you are helm', tools, profile: PROFILE, settingScopes: [] });

const types = (events: AdapterEvent[]): string[] => events.map((e) => e.type);

// ---------------------------------------------------------------------------

describe('ClaudeConversation — the session really persists', () => {
  it('runs every turn through ONE query instead of restarting the session', async () => {
    const convo = await converse();

    const first = await within(collect(convo.send('one')));
    const second = await within(collect(convo.send('two')));

    // The whole point. A per-turn query would also pass every other assertion
    // here while silently throwing away the conversation each time.
    expect(reg.queryCalls.length).toBe(1);
    // Both turns went into the same streaming-input prompt, in order.
    expect(last.turns).toEqual(['one', 'two']);
    expect(last.closeCount).toBe(0);

    expect(first.at(-1)).toMatchObject({ type: 'exit', ok: true });
    expect(second.at(-1)).toMatchObject({ type: 'exit', ok: true });
    expect(first).toContainEqual({ type: 'text', text: 'heard: one' });
    expect(second).toContainEqual({ type: 'text', text: 'heard: two' });
  });

  it('reports the session id once, not once per turn', async () => {
    const convo = await converse();
    const first = await within(collect(convo.send('one')));
    const second = await within(collect(convo.send('two')));

    expect(first.filter((e) => e.type === 'session')).toHaveLength(1);
    expect(types(second)).not.toContain('session');
  });

  it('still reports the session when the harness announces itself before the first turn', async () => {
    // The init frame lands as soon as the subprocess is up — which in streaming
    // input mode is before the captain has typed anything. Dropping it would
    // burn the once-only latch and leave the id unreported for the whole run.
    harness((q) => q.announce());
    const convo = await converse();
    await new Promise((r) => setTimeout(r, 20));

    const first = await within(collect(convo.send('one')));
    expect(first[0]).toEqual({ type: 'session', sessionId: last.sessionId });
    expect(first.at(-1)).toMatchObject({ type: 'exit', ok: true });
  });

  it('carries usage and the dominant model out of the result message', async () => {
    const convo = await converse();
    const events = await within(collect(convo.send('one')));
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      costUsd: 0.02,
      inputTokens: 5,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      model: 'claude-x',
    });
  });
});

describe('ClaudeConversation — one turn at a time', () => {
  it('refuses a concurrent send and leaves the in-flight turn untouched', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    harness((q) => {
      q.onTurn = async (self, text) => {
        await gate;
        self.answer(text);
      };
    });

    const convo = await converse();
    const inFlight = convo.send('first');
    const iterator = inFlight[Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise((r) => setTimeout(r, 10));

    await expect(collect(convo.send('second'))).rejects.toThrow(/mid-turn/);

    release();
    await within(pending);
    const rest: AdapterEvent[] = [];
    for (;;) {
      const step = await within(iterator.next());
      if (step.done === true) break;
      rest.push(step.value);
    }
    expect(rest.at(-1)).toMatchObject({ type: 'exit', ok: true });

    // The refusal did not poison the lock: the next turn is accepted.
    const third = await within(collect(convo.send('third')));
    expect(third.at(-1)).toMatchObject({ type: 'exit', ok: true });
    expect(last.turns).toEqual(['first', 'third']);
  });
});

describe('ClaudeConversation — teardown', () => {
  it('closes idempotently and releases the query exactly once', async () => {
    const convo = await converse();
    await within(collect(convo.send('one')));

    await convo.close();
    await convo.close();

    expect(last.closeCount).toBe(1);
    await expect(collect(convo.send('late'))).rejects.toThrow(/closed/);
  });

  it('ends a live turn on close() rather than hanging its reader', async () => {
    harness((q) => {
      q.onTurn = () => undefined; // the model never answers
    });
    const convo = await converse();
    const turn = collect(convo.send('hello'));
    await new Promise((r) => setTimeout(r, 10));

    await convo.close();

    expect((await within(turn)).at(-1)).toMatchObject({ type: 'exit', ok: false });
  });

  it('fails the live turn and refuses later ones when the stream dies', async () => {
    harness((q) => {
      q.onTurn = (self) => self.out.end();
    });
    const convo = await converse();

    const events = await within(collect(convo.send('hello')));
    expect(events.at(-1)).toMatchObject({ type: 'exit', ok: false });
    await expect(collect(convo.send('again'))).rejects.toThrow(/has ended/);
  });

  it('forwards interrupt() to the query', async () => {
    const convo = await converse();
    await within(collect(convo.send('one')));
    await convo.interrupt();
    expect(last.interruptCount).toBe(1);
  });
});

describe('ClaudeConversation — hosted tools', () => {
  const tools: ToolDef[] = [
    {
      name: 'ping',
      description: 'Answer with pong.',
      inputSchema: { type: 'object', properties: { x: { type: 'string', description: 'what' } } },
      handler: async (input) => `pong:${String(input['x'])}`,
    },
    {
      name: 'boom',
      description: 'Always fails.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        throw new Error('deliberate tool failure');
      },
    },
  ];

  it('registers the caller tools on one in-process MCP server', async () => {
    await converse(tools);
    expect(reg.servers).toHaveLength(1);
    expect(reg.servers[0]?.['name']).toBe('tools');
    expect((reg.servers[0]?.['tools'] as Array<{ name: string }>).map((t) => t.name)).toEqual([
      'ping',
      'boom',
    ]);
    expect(reg.queryCalls[0]?.['options'].mcpServers).toHaveProperty('tools');
    // Built-ins stay read-only; anything that changes the world is a ToolDef.
    expect(reg.queryCalls[0]?.['options'].tools).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('returns a handler result as text and a throw as a tool error', async () => {
    await converse(tools);
    const hosted = reg.servers[0]?.['tools'] as Array<{ handler: (a: unknown) => Promise<any> }>;

    expect(await hosted[0]?.handler({ x: 'hi' })).toEqual({
      content: [{ type: 'text', text: 'pong:hi' }],
    });

    // A throwing handler must reach the model as a readable error, not abort
    // the query and end the captain's conversation.
    const failed = await hosted[1]?.handler({});
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toBe('deliberate tool failure');
  });

  it('hands Helm all nine tools through to the harness', async () => {
    const helm = await import('../src/agents/helm/tools.js');
    await converse(helm.helmTools({} as never, {} as never));
    expect((reg.servers[0]?.['tools'] as Array<{ name: string }>).map((t) => t.name)).toEqual([
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
  });
});
