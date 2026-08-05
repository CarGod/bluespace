/**
 * Transcript reader tests.
 *
 * These run against REAL files in a temp dir, written the way the CLI writes them
 * — appended to while being read, one record at a time, sometimes half a record at
 * a time. Every property this module claims (never parse a partial record, never
 * drop a split one, never crash on garbage) is only meaningful against actual
 * filesystem timing, so that is what is exercised. Nothing here reads the
 * developer's own `~/.claude`; the fixtures below are the entire input.
 *
 * The fixture shapes are copied from a real Claude Code 2.1.222 transcript,
 * including the awkward one: a single logical assistant message written as several
 * records that share a `message.id` and repeat a `usage` block.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AdapterEvent } from '../src/adapters/types.js';
import { priceUsage, type TranscriptUsage } from '../src/pricing/index.js';
import {
  InvalidSessionIdError,
  TranscriptNotFoundError,
  createStats,
  findTranscript,
  readTranscript,
  stopReasonToExit,
  transcriptRoot,
  type PriceFn,
  type TranscriptReadStats,
} from '../src/transcript/reader.js';

let tmpBase: string;
let transcript: string;

beforeEach(async () => {
  tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bluespace-transcript-')));
  transcript = path.join(tmpBase, 'session.jsonl');
});

afterEach(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION = '0608c67f-24b4-4230-9588-d19f58da5e82';

/** The real usage shape, split cache included. */
function usage(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 1000,
    cache_creation: { ephemeral_1h_input_tokens: 100, ephemeral_5m_input_tokens: 0 },
    service_tier: 'standard',
    ...over,
  };
}

interface AssistantOpts {
  id?: string;
  uuid?: string;
  model?: string;
  content: unknown[];
  stopReason?: string | null;
  usage?: Record<string, unknown>;
  sidechain?: boolean;
}

function assistant(o: AssistantOpts): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid: o.uuid ?? 'u-' + Math.random().toString(16).slice(2),
    parentUuid: null,
    sessionId: SESSION,
    timestamp: '2026-08-04T00:00:00.000Z',
    isSidechain: o.sidechain ?? false,
    message: {
      id: o.id ?? 'msg_1',
      role: 'assistant',
      type: 'message',
      model: o.model ?? 'claude-opus-5',
      content: o.content,
      stop_reason: o.stopReason === undefined ? 'end_turn' : o.stopReason,
      stop_details: null,
      usage: o.usage ?? usage(),
    },
  };
}

function toolResultRecord(
  toolUseId: string,
  content: unknown,
  isError?: boolean,
): Record<string, unknown> {
  return {
    type: 'user',
    uuid: 'u-res-' + toolUseId,
    parentUuid: null,
    sessionId: SESSION,
    timestamp: '2026-08-04T00:00:01.000Z',
    isSidechain: false,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          ...(isError === undefined ? {} : { is_error: isError }),
        },
      ],
    },
    toolUseResult: { stdout: 'ignored by the reader on purpose' },
  };
}

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Deterministic stand-in so token->dollar assertions do not encode a price table. */
const fakePrice: PriceFn = (u) => (u.output_tokens ?? 0) * 0.001;

/** The real wiring, to prove the callback's argument order matches `src/pricing`. */
const realPrice: PriceFn = (u, m) => priceUsage(m, u).usd;

async function write(...records: unknown[]): Promise<void> {
  await fs.writeFile(transcript, records.map(line).join(''));
}

async function append(text: string): Promise<void> {
  await fs.appendFile(transcript, text);
}

/** Read to EOF and stop. */
async function drain(
  opts: { price?: PriceFn; stats?: TranscriptReadStats; path?: string } = {},
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const e of readTranscript({
    path: opts.path ?? transcript,
    price: opts.price ?? fakePrice,
    follow: false,
    waitForFileMs: 2000,
    ...(opts.stats === undefined ? {} : { stats: opts.stats }),
  })) {
    events.push(e);
  }
  return events;
}

/** Tail until `count` events have arrived, then stop iterating. */
async function tail(
  count: number,
  opts: { signal?: AbortSignal; stats?: TranscriptReadStats } = {},
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const e of readTranscript({
    path: transcript,
    price: fakePrice,
    pollIntervalMs: 10,
    waitForFileMs: 5000,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    ...(opts.stats === undefined ? {} : { stats: opts.stats }),
  })) {
    events.push(e);
    if (events.length >= count) break;
  }
  return events;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Tail a path under a signal, to EOF or abort, whichever comes first. */
async function drainWithSignal(p: string, signal: AbortSignal): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  for await (const e of readTranscript({ path: p, price: fakePrice, pollIntervalMs: 10, signal })) {
    events.push(e);
  }
  return events;
}

// ---------------------------------------------------------------------------

describe('content mapping', () => {
  it('maps text, thinking and tool_use blocks in order', async () => {
    await write(
      assistant({
        content: [
          { type: 'thinking', thinking: 'secret reasoning', signature: 'sig' },
          { type: 'text', text: 'on it' },
          { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { file_path: '/a' } },
        ],
        stopReason: 'tool_use',
      }),
    );

    const events = await drain();
    expect(events.map((e) => e.type)).toEqual([
      'session',
      'thinking',
      'text',
      'tool_use',
      'usage',
    ]);
    expect(events[0]).toEqual({ type: 'session', sessionId: SESSION });
    expect(events[2]).toEqual({ type: 'text', text: 'on it' });
    expect(events[3]).toEqual({
      type: 'tool_use',
      toolUseId: 'toolu_01',
      name: 'Read',
      input: { file_path: '/a' },
    });
    // Reasoning text is deliberately not carried on the event.
    expect(JSON.stringify(events[1])).not.toContain('secret reasoning');
  });

  it('emits the session event exactly once', async () => {
    await write(
      assistant({ id: 'msg_1', content: [{ type: 'text', text: 'a' }] }),
      assistant({ id: 'msg_2', content: [{ type: 'text', text: 'b' }] }),
    );
    const events = await drain();
    expect(events.filter((e) => e.type === 'session')).toHaveLength(1);
  });

  it('drops empty text blocks and keeps unknown block kinds inert', async () => {
    const stats = createStats();
    await write(
      assistant({
        content: [
          { type: 'text', text: '' },
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' },
          { type: 'text', text: 'kept' },
        ],
      }),
    );
    const events = await drain({ stats });
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'kept' }]);
    expect(stats.ignoredBlockKinds['server_tool_use']).toBe(1);
  });
});

describe('tool_result mapping', () => {
  it('maps a string result, marking it ok', async () => {
    await write(
      assistant({
        content: [{ type: 'tool_use', id: 'toolu_a', name: 'Bash', input: {} }],
        stopReason: 'tool_use',
      }),
      toolResultRecord('toolu_a', 'total 0\n'),
    );

    const events = await drain();
    expect(events.find((e) => e.type === 'tool_result')).toEqual({
      type: 'tool_result',
      toolUseId: 'toolu_a',
      ok: true,
      result: 'total 0\n',
    });
  });

  it('maps is_error onto ok: false', async () => {
    await write(toolResultRecord('toolu_b', 'Exit code 1', true));
    const events = await drain();
    expect(events).toContainEqual({
      type: 'tool_result',
      toolUseId: 'toolu_b',
      ok: false,
      result: 'Exit code 1',
    });
  });

  it('flattens a block-list result to its text, ignoring non-text blocks', async () => {
    await write(
      toolResultRecord('toolu_c', [
        { type: 'text', text: 'first' },
        { type: 'image', source: { type: 'base64', data: 'AAAA' } },
        { type: 'tool_reference', tool_name: 'WebFetch' },
        { type: 'text', text: 'second' },
      ]),
    );
    const events = await drain();
    expect(events).toContainEqual({
      type: 'tool_result',
      toolUseId: 'toolu_c',
      ok: true,
      result: 'first\nsecond',
    });
  });

  it('omits result entirely when there is no text to report', async () => {
    await write(toolResultRecord('toolu_d', [{ type: 'image', source: {} }]));
    const events = await drain();
    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toEqual({ type: 'tool_result', toolUseId: 'toolu_d', ok: true });
    expect(result && 'result' in result).toBe(false);
  });

  it('ignores a plain-string user message (the captain typing)', async () => {
    await write({
      type: 'user',
      sessionId: SESSION,
      uuid: 'u1',
      message: { role: 'user', content: 'do the thing' },
    });
    expect((await drain()).map((e) => e.type)).toEqual(['session']);
  });

  it('emits a turn usage BEFORE the tool result that follows it', async () => {
    await write(
      assistant({
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'toolu_e', name: 'Bash', input: {} }],
        stopReason: 'tool_use',
      }),
      toolResultRecord('toolu_e', 'ok'),
    );
    const kinds = (await drain()).map((e) => e.type);
    expect(kinds.indexOf('usage')).toBeLessThan(kinds.indexOf('tool_result'));
  });
});

describe('usage mapping', () => {
  it('maps every token count and prices it through the callback', async () => {
    await write(assistant({ content: [{ type: 'text', text: 'hi' }] }));
    const events = await drain();
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      costUsd: 20 * 0.001,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 1000,
      cacheCreationTokens: 100,
      model: 'claude-opus-5',
    });
  });

  it('hands the price callback the raw usage and model, in that order', async () => {
    const seen: Array<{ u: TranscriptUsage; m: string | undefined }> = [];
    await write(assistant({ model: 'claude-fable-5', content: [{ type: 'text', text: 'x' }] }));
    await drain({
      price: (u, m) => {
        seen.push({ u, m });
        return 0;
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.m).toBe('claude-fable-5');
    expect(seen[0]?.u.cache_creation?.ephemeral_1h_input_tokens).toBe(100);
  });

  it('wires up to the real pricing module without adaptation', async () => {
    await write(assistant({ content: [{ type: 'text', text: 'x' }] }));
    const events = await drain({ price: realPrice });
    const u = events.find((e) => e.type === 'usage');
    expect(u?.type).toBe('usage');
    // 5/MTok opus: 10 in + 20 out@25 + 1000 read@0.1x + 100 1h-write@2x.
    expect(u && u.type === 'usage' ? u.costUsd : 0).toBeCloseTo(
      (10 * 5 + 20 * 25 + 1000 * 0.5 + 100 * 10) / 1e6,
      12,
    );
  });

  it('counts ONE usage per logical message when records share a message.id', async () => {
    // This is how the CLI really writes a streamed message: several records, same
    // id, each repeating usage, and only the last one complete.
    const partial = usage({ output_tokens: 2 });
    const final = usage({ output_tokens: 698 });
    await write(
      assistant({ id: 'msg_9', content: [{ type: 'thinking', thinking: 't' }], stopReason: null, usage: partial }),
      assistant({ id: 'msg_9', content: [{ type: 'text', text: 'a' }], stopReason: null, usage: partial }),
      assistant({
        id: 'msg_9',
        content: [{ type: 'tool_use', id: 'toolu_z', name: 'Bash', input: {} }],
        stopReason: 'tool_use',
        usage: final,
      }),
    );

    const events = await drain();
    const usages = events.filter((e) => e.type === 'usage');
    expect(usages).toHaveLength(1);
    expect(usages[0]).toMatchObject({ outputTokens: 698 });
    // Content from every record still comes through — the dedup is usage-only.
    expect(events.map((e) => e.type)).toEqual([
      'session',
      'thinking',
      'text',
      'tool_use',
      'usage',
    ]);
  });

  it('counts ONE usage when every record of a message carries a stop_reason', async () => {
    // Parallel tool calls: one message, two records, BOTH stamped `tool_use`.
    // 12,475 messages in the real corpus look like this, and treating stop_reason
    // as a message terminator double-bills every one of them.
    await write(
      assistant({
        id: 'msg_par',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }],
        stopReason: 'tool_use',
        usage: usage({ output_tokens: 40 }),
      }),
      assistant({
        id: 'msg_par',
        content: [{ type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} }],
        stopReason: 'tool_use',
        usage: usage({ output_tokens: 120 }),
      }),
      toolResultRecord('toolu_1', 'a'),
    );

    const events = await drain();
    const usages = events.filter((e) => e.type === 'usage');
    expect(usages).toHaveLength(1);
    // The last record's usage is the complete one.
    expect(usages[0]).toMatchObject({ outputTokens: 120 });
    expect(events.filter((e) => e.type === 'tool_use')).toHaveLength(2);
  });

  it('emits at most one exit per message, however many records carry the reason', async () => {
    await write(
      assistant({ id: 'msg_r', content: [{ type: 'text', text: 'a' }], stopReason: 'refusal' }),
      assistant({ id: 'msg_r', content: [{ type: 'text', text: 'b' }], stopReason: 'refusal' }),
    );
    expect((await drain()).filter((e) => e.type === 'exit')).toHaveLength(1);
  });

  it('does NOT merge two messages that both lost their id — a merge is a dropped bill', async () => {
    // The dedup keys on message.id, so an id that is absent or empty must never
    // compare equal to another one. Two unrelated messages both carrying `id: ""`
    // would otherwise look like one, and the first one's tokens would go unbilled.
    await write(
      assistant({ id: '', content: [{ type: 'text', text: 'a' }], usage: usage({ output_tokens: 100 }) }),
      assistant({ id: '', content: [{ type: 'text', text: 'b' }], usage: usage({ output_tokens: 200 }) }),
    );

    const usages = (await drain()).filter((e) => e.type === 'usage');
    expect(usages).toHaveLength(2);
    expect(usages.map((u) => (u.type === 'usage' ? u.outputTokens : 0))).toEqual([100, 200]);
  });

  it('bills a record whose message.id is missing entirely, rather than discarding it', async () => {
    // Such a record still carries real content and real tokens; treating it as
    // damage would drop both.
    const stats = createStats();
    await write({
      type: 'assistant',
      sessionId: SESSION,
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text: 'no id' }],
        usage: usage({ output_tokens: 55 }),
      },
    });

    const events = await drain({ stats });
    expect(events).toContainEqual({ type: 'text', text: 'no id' });
    expect(events.filter((e) => e.type === 'usage')).toMatchObject([{ outputTokens: 55 }]);
    expect(stats.malformedLines).toBe(0);
  });

  it('still emits usage for a message that never got a stop_reason', async () => {
    await write(
      assistant({ id: 'msg_a', content: [{ type: 'text', text: 'interrupted' }], stopReason: null }),
    );
    const events = await drain();
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(1);
  });

  it('flushes the previous message usage when a new message id arrives', async () => {
    await write(
      assistant({ id: 'msg_a', content: [{ type: 'text', text: 'a' }], stopReason: null }),
      assistant({ id: 'msg_b', content: [{ type: 'text', text: 'b' }], stopReason: null }),
    );
    expect((await drain()).filter((e) => e.type === 'usage')).toHaveLength(2);
  });

  it('skips an all-zero usage block, such as a <synthetic> API-error record', async () => {
    await write(
      assistant({
        model: '<synthetic>',
        content: [{ type: 'text', text: 'API Error: 500' }],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    );
    const events = await drain();
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(0);
  });

  it('does not mistake a split-only cache block for an empty one', async () => {
    // `cache_creation_input_tokens` and the `cache_creation` split are two
    // views of the same total, and a transcript written across a schema change
    // can carry one without the other. `src/pricing` bills the split, so a
    // reader that decided emptiness from the total alone would drop an event
    // that costs real money — and report zero cache-creation tokens for it.
    await write(
      assistant({
        content: [{ type: 'text', text: 'cached' }],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_1h_input_tokens: 4000, ephemeral_5m_input_tokens: 1000 },
        },
      }),
    );
    const events = await drain({ price: realPrice });
    const billed = events.filter((e) => e.type === 'usage');
    expect(billed, 'a billable block was dropped as empty').toHaveLength(1);
    expect(billed[0]).toMatchObject({ cacheCreationTokens: 5000 });
    // claude-opus-5 input is $5/MTok: 4000 at 2x plus 1000 at 1.25x.
    expect(billed[0] && billed[0].type === 'usage' ? billed[0].costUsd : 0).toBeCloseTo(
      (4000 * 10 + 1000 * 6.25) / 1e6,
      12,
    );
  });

  it('survives a price callback that throws, keeping the token counts', async () => {
    const stats = createStats();
    await write(assistant({ content: [{ type: 'text', text: 'x' }] }));
    const events = await drain({
      stats,
      price: () => {
        throw new Error('unknown model');
      },
    });
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      costUsd: 0,
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(stats.pricingFailures).toBe(1);
  });

  it('treats a non-finite price as a pricing failure', async () => {
    const stats = createStats();
    await write(assistant({ content: [{ type: 'text', text: 'x' }] }));
    const events = await drain({ stats, price: () => Number.NaN });
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ costUsd: 0 });
    expect(stats.pricingFailures).toBe(1);
  });

  it('defaults missing token fields to zero rather than dropping the event', async () => {
    await write(assistant({ content: [{ type: 'text', text: 'x' }], usage: { output_tokens: 7 } }));
    expect((await drain()).find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      costUsd: 7 * 0.001,
      inputTokens: 0,
      outputTokens: 7,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      model: 'claude-opus-5',
    });
  });
});

describe('sidechain records', () => {
  it('emits subagent events and usage, unfiltered', async () => {
    await write(
      assistant({
        id: 'msg_main',
        content: [{ type: 'tool_use', id: 'toolu_task', name: 'Task', input: {} }],
        stopReason: 'tool_use',
      }),
      assistant({
        id: 'msg_sub',
        sidechain: true,
        model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'subagent working' }],
        usage: usage({ output_tokens: 500 }),
      }),
    );

    const events = await drain();
    expect(events).toContainEqual({ type: 'text', text: 'subagent working' });
    const usages = events.filter((e) => e.type === 'usage');
    expect(usages).toHaveLength(2);
    // A subagent's tokens are real money: its usage must not be filtered out.
    expect(usages.some((u) => u.type === 'usage' && u.model === 'claude-opus-4-8')).toBe(true);
  });
});

describe('exit mapping', () => {
  it('never invents an exit from end_turn, tool_use or stop_sequence', () => {
    for (const reason of ['end_turn', 'tool_use', 'stop_sequence', undefined]) {
      expect(stopReasonToExit(reason)).toBeUndefined();
    }
  });

  it('maps genuinely terminal stop reasons to a failed exit', () => {
    expect(stopReasonToExit('refusal')).toEqual({ type: 'exit', ok: false, reason: 'refusal' });
    expect(stopReasonToExit('max_tokens')).toEqual({ type: 'exit', ok: false, reason: 'max_tokens' });
  });

  it('emits no exit for an ordinary finished turn', async () => {
    await write(assistant({ content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }));
    expect((await drain()).filter((e) => e.type === 'exit')).toHaveLength(0);
  });

  it('emits an exit after the usage when the model refuses', async () => {
    await write(assistant({ content: [{ type: 'text', text: 'no' }], stopReason: 'refusal' }));
    const kinds = (await drain()).map((e) => e.type);
    expect(kinds).toEqual(['session', 'text', 'usage', 'exit']);
  });
});

describe('bookkeeping record kinds', () => {
  it('ignores every non-conversational kind and counts it', async () => {
    const stats = createStats();
    await write(
      { type: 'mode', mode: 'default', sessionId: SESSION },
      { type: 'permission-mode', permissionMode: 'acceptEdits' },
      { type: 'bridge-session', id: 'x' },
      { type: 'file-history-snapshot', messageId: 'm' },
      { type: 'attachment', attachment: {} },
      { type: 'ai-title', title: 't' },
      { type: 'last-prompt', prompt: 'p' },
      { type: 'file-history-delta', delta: {} },
      { type: 'system', subtype: 'turn_duration', durationMs: 12 },
      { type: 'system', subtype: 'stop_hook_summary', hookCount: 1 },
      assistant({ content: [{ type: 'text', text: 'still here' }] }),
    );

    const events = await drain({ stats });
    expect(events.map((e) => e.type)).toEqual(['session', 'text', 'usage']);
    expect(stats.ignoredKinds['mode']).toBe(1);
    expect(stats.ignoredKinds['attachment']).toBe(1);
    expect(stats.ignoredKinds['system:stop_hook_summary']).toBe(1);
    expect(stats.malformedLines).toBe(0);
  });

  it('is inert, not fatal, for a record kind that does not exist yet', async () => {
    const stats = createStats();
    await write(
      { type: 'quantum-entanglement-log', payload: { spooky: true } },
      assistant({ content: [{ type: 'text', text: 'survived' }] }),
    );
    const events = await drain({ stats });
    expect(events).toContainEqual({ type: 'text', text: 'survived' });
    expect(stats.ignoredKinds['quantum-entanglement-log']).toBe(1);
    expect(stats.malformedLines).toBe(0);
  });
});

describe('malformed input', () => {
  it('skips unparseable lines with a counter and keeps reading', async () => {
    const stats = createStats();
    await fs.writeFile(
      transcript,
      line(assistant({ id: 'msg_1', content: [{ type: 'text', text: 'before' }] })) +
        '{"type":"assistant", this is not json\n' +
        'not json at all\n' +
        '\n' +
        line(assistant({ id: 'msg_2', content: [{ type: 'text', text: 'after' }] })),
    );

    const events = await drain({ stats });
    expect(events.filter((e) => e.type === 'text')).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: 'after' },
    ]);
    expect(stats.malformedLines).toBe(2);
    expect(stats.recordsParsed).toBe(2);
    // A blank line is not damage.
    expect(stats.linesSeen).toBe(4);
  });

  it('counts valid JSON that is not a record as malformed', async () => {
    const stats = createStats();
    await fs.writeFile(transcript, '[1,2,3]\n"a string"\n42\n{"no":"type"}\nnull\n');
    expect(await drain({ stats })).toEqual([]);
    expect(stats.malformedLines).toBe(5);
  });

  it('does not crash on an assistant record with a broken message', async () => {
    const stats = createStats();
    await write(
      { type: 'assistant', sessionId: SESSION, message: 'not an object' },
      { type: 'assistant', sessionId: SESSION, message: { id: 'm', content: 'not an array' } },
      assistant({ content: [{ type: 'text', text: 'fine' }] }),
    );
    const events = await drain({ stats });
    expect(events).toContainEqual({ type: 'text', text: 'fine' });
    expect(stats.malformedLines).toBe(2);
  });

  it('never yields a tool_use or tool_result missing its id', async () => {
    await write(
      assistant({ content: [{ type: 'tool_use', name: 'Bash', input: {} }] }),
      {
        type: 'user',
        sessionId: SESSION,
        message: { role: 'user', content: [{ type: 'tool_result', content: 'orphan' }] },
      },
    );
    const events = await drain();
    expect(events.some((e) => e.type === 'tool_use' || e.type === 'tool_result')).toBe(false);
  });

  it('treats an EMPTY id the same as a missing one, for both halves of a tool call', async () => {
    // An empty id is worse than an absent one: it correlates a result to whichever
    // other call also lost its id, so it must never reach the event stream.
    await write(
      assistant({ content: [{ type: 'tool_use', id: '', name: 'Bash', input: {} }] }),
      {
        type: 'user',
        sessionId: SESSION,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: '', content: 'orphan' }],
        },
      },
    );
    const events = await drain();
    expect(events.some((e) => e.type === 'tool_use' || e.type === 'tool_result')).toBe(false);
  });

  it('does not emit a session event for an empty sessionId', async () => {
    await write({
      type: 'assistant',
      sessionId: '',
      message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: {} },
    });
    const events = await drain();
    expect(events.some((e) => e.type === 'session')).toBe(false);
    expect(events).toContainEqual({ type: 'text', text: 'x' });
  });
});

describe('resuming at an offset', () => {
  /**
   * The case this exists for: a Claude Code session outlives a turn and appends
   * every turn to ONE file, so the reader for turn 2 must not re-read turn 1.
   * Doing so would emit its usage a second time, and a double-counted bill is
   * the one reader bug the captain pays for directly.
   */
  it('reads only what the previous read left, and bills each turn once', async () => {
    await write(
      assistant({ id: 'turn1', content: [{ type: 'text', text: 'turn one' }], usage: usage({ output_tokens: 100 }) }),
    );

    const first = createStats();
    const firstEvents = await drain({ stats: first });
    expect(firstEvents).toContainEqual({ type: 'text', text: 'turn one' });
    expect(firstEvents.filter((e) => e.type === 'usage')).toHaveLength(1);
    expect(first.consumedBytes).toBe((await fs.stat(transcript)).size);

    await append(
      line(
        assistant({
          id: 'turn2',
          content: [{ type: 'text', text: 'turn two' }],
          usage: usage({ output_tokens: 200 }),
        }),
      ),
    );

    const second = createStats();
    const secondEvents: AdapterEvent[] = [];
    for await (const e of readTranscript({
      path: transcript,
      price: fakePrice,
      follow: false,
      startAtByte: first.consumedBytes,
      stats: second,
    })) {
      secondEvents.push(e);
    }

    expect(secondEvents).toContainEqual({ type: 'text', text: 'turn two' });
    expect(secondEvents).not.toContainEqual({ type: 'text', text: 'turn one' });
    const billed = secondEvents.filter((e) => e.type === 'usage');
    expect(billed, 'turn one was billed a second time').toHaveLength(1);
    expect(billed[0]).toMatchObject({ outputTokens: 200 });
    expect(second.consumedBytes).toBe((await fs.stat(transcript)).size);
  });

  it('stops at a line boundary, never inside a record still being written', async () => {
    const complete = line(assistant({ id: 'msg_1', content: [{ type: 'text', text: 'complete' }] }));
    const half = line(assistant({ id: 'msg_2', content: [{ type: 'text', text: 'half' }] })).slice(0, 40);
    await fs.writeFile(transcript, complete + half);

    const stats = createStats();
    await drain({ stats });
    // Resuming from here re-reads the half-written record from its first byte.
    expect(stats.consumedBytes).toBe(Buffer.byteLength(complete));
  });

  it('re-reads from the start when the file it was reading shrank', async () => {
    // A resumed session gets its transcript rewritten. An offset past the end of
    // the new file would silently skip everything in it.
    await write(assistant({ id: 'old', content: [{ type: 'text', text: 'rewritten away' }] }));
    const stats = createStats();
    await drain({ stats });
    const wasAt = stats.consumedBytes;
    expect(wasAt).toBeGreaterThan(0);

    await fs.writeFile(transcript, line(assistant({ id: 'new', content: [{ type: 'text', text: 'fresh' }] })));

    const after = createStats();
    const events: AdapterEvent[] = [];
    for await (const e of readTranscript({
      path: transcript,
      price: fakePrice,
      follow: false,
      startAtByte: wasAt + 10_000,
      stats: after,
    })) {
      events.push(e);
    }
    expect(events).toContainEqual({ type: 'text', text: 'fresh' });
  });
});

describe('partial trailing line', () => {
  it('never yields a record that is still being written', async () => {
    const complete = line(assistant({ id: 'msg_1', content: [{ type: 'text', text: 'complete' }] }));
    const half = line(assistant({ id: 'msg_2', content: [{ type: 'text', text: 'truncated' }] })).slice(
      0,
      60,
    );
    await fs.writeFile(transcript, complete + half);

    const stats = createStats();
    const events = await drain({ stats });
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'complete' }]);
    // The remainder was held, not parsed — so it is not damage either.
    expect(stats.malformedLines).toBe(0);
    expect(stats.recordsParsed).toBe(1);
  });

  it('yields the record once the rest of the line arrives', async () => {
    const record = line(assistant({ id: 'msg_2', content: [{ type: 'text', text: 'split record' }] }));
    const cut = Math.floor(record.length / 2);
    await fs.writeFile(transcript, record.slice(0, cut));

    const stats = createStats();
    const pending = tail(2, { stats });
    await sleep(60);
    await append(record.slice(cut));

    const events = await pending;
    expect(events).toContainEqual({ type: 'text', text: 'split record' });
    expect(stats.malformedLines).toBe(0);
  });

  it('reassembles a record split across many appends, byte by byte', async () => {
    const record = line(
      assistant({ id: 'msg_3', content: [{ type: 'text', text: 'dripped in one byte at a time' }] }),
    );
    await fs.writeFile(transcript, '');

    const pending = tail(2);
    for (let i = 0; i < record.length; i += 7) {
      await append(record.slice(i, i + 7));
    }

    expect(await pending).toContainEqual({
      type: 'text',
      text: 'dripped in one byte at a time',
    });
  });

  it('does not mangle a multi-byte character split across reads', async () => {
    // The writer emits UTF-8 bytes; a chunk boundary can fall inside one character.
    const text = '毛衫定制 — 花型白名单';
    const record = line(assistant({ id: 'msg_4', content: [{ type: 'text', text }] }));
    const bytes = Buffer.from(record, 'utf8');
    const idx = bytes.indexOf(Buffer.from('毛', 'utf8')) + 1; // mid-character.
    await fs.writeFile(transcript, bytes.subarray(0, idx));

    const pending = tail(2);
    await sleep(40);
    await fs.appendFile(transcript, bytes.subarray(idx));

    const events = await pending;
    expect(events).toContainEqual({ type: 'text', text });
  });
});

describe('following a growing file', () => {
  it('yields records appended after the reader caught up', async () => {
    await write(assistant({ id: 'msg_1', content: [{ type: 'text', text: 'first' }] }));

    const events: AdapterEvent[] = [];
    const iterator = readTranscript({ path: transcript, price: fakePrice, pollIntervalMs: 10 });
    const collected = (async () => {
      for await (const e of iterator) {
        events.push(e);
        if (events.filter((x) => x.type === 'text').length >= 3) break;
      }
    })();

    await sleep(50);
    await append(line(assistant({ id: 'msg_2', content: [{ type: 'text', text: 'second' }] })));
    await sleep(50);
    await append(line(assistant({ id: 'msg_3', content: [{ type: 'text', text: 'third' }] })));
    await collected;

    expect(events.filter((e) => e.type === 'text')).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
      { type: 'text', text: 'third' },
    ]);
  });

  it('starts over when the file is truncated under it', async () => {
    await write(assistant({ id: 'msg_1', content: [{ type: 'text', text: 'old run' }] }));

    const events: AdapterEvent[] = [];
    const collected = (async () => {
      for await (const e of readTranscript({
        path: transcript,
        price: fakePrice,
        pollIntervalMs: 10,
      })) {
        events.push(e);
        if (events.some((x) => x.type === 'text' && x.text === 'new run')) break;
      }
    })();

    await sleep(50);
    await write(assistant({ id: 'msg_2', content: [{ type: 'text', text: 'new run' }] }));
    await collected;

    expect(events).toContainEqual({ type: 'text', text: 'new run' });
  });
});

describe('file appears late', () => {
  it('waits for a transcript that does not exist yet', async () => {
    const events: AdapterEvent[] = [];
    const collected = (async () => {
      for await (const e of readTranscript({
        path: transcript,
        price: fakePrice,
        pollIntervalMs: 10,
        waitForFileMs: 5000,
      })) {
        events.push(e);
        if (events.some((x) => x.type === 'text')) break;
      }
    })();

    await sleep(80);
    expect(events).toEqual([]);
    await write(assistant({ content: [{ type: 'text', text: 'finally here' }] }));
    await collected;

    expect(events).toContainEqual({ type: 'text', text: 'finally here' });
  });

  it('waits for a transcript whose directory does not exist yet', async () => {
    const late = path.join(tmpBase, 'not', 'created', 'yet', 'session.jsonl');
    const events: AdapterEvent[] = [];
    const collected = (async () => {
      for await (const e of readTranscript({
        path: late,
        price: fakePrice,
        pollIntervalMs: 10,
        waitForFileMs: 5000,
      })) {
        events.push(e);
        break;
      }
    })();

    await sleep(60);
    await fs.mkdir(path.dirname(late), { recursive: true });
    await fs.writeFile(late, line(assistant({ content: [{ type: 'text', text: 'late dir' }] })));
    await collected;

    expect(events[0]).toEqual({ type: 'session', sessionId: SESSION });
  });

  it('throws TranscriptNotFoundError when it never appears', async () => {
    await expect(
      drain({ path: path.join(tmpBase, 'never.jsonl') }),
    ).rejects.toBeInstanceOf(TranscriptNotFoundError);
  });

  it('gives up waiting when aborted, without throwing', async () => {
    const ac = new AbortController();
    const pending = tail(10, { signal: ac.signal });
    await sleep(30);
    ac.abort();
    await expect(pending).resolves.toEqual([]);
  });
});

describe('stopping', () => {
  /**
   * ABORT MEANS "DRAIN AND STOP", AND THE DIFFERENCE IS A WHOLE TURN'S BILL.
   *
   * The abort arrives from a watcher that has just seen the Stop hook, so the
   * records the turn was still writing are on disk by the time it fires. A
   * reader that checked its signal and bailed would hand back nothing at all —
   * no cost, no text — for a transcript sitting complete in front of it, and
   * `consumedBytes` would stay put, so no later turn would pick it up either.
   * The signal here is aborted before the first read, which is the extreme of
   * that race and the cheapest way to pin the contract.
   */
  it('drains what is already on disk even when the signal is ALREADY aborted', async () => {
    await write(
      assistant({ id: 'm1', content: [{ type: 'text', text: 'one' }], usage: usage({ output_tokens: 7 }) }),
      assistant({ id: 'm2', content: [{ type: 'text', text: 'two' }], usage: usage({ output_tokens: 9 }) }),
    );
    const ac = new AbortController();
    ac.abort();

    const stats = createStats();
    const events: AdapterEvent[] = [];
    for await (const e of readTranscript({
      path: transcript,
      price: fakePrice,
      pollIntervalMs: 10,
      signal: ac.signal,
      stats,
    })) {
      events.push(e);
    }

    expect(events).toContainEqual({ type: 'text', text: 'one' });
    expect(events).toContainEqual({ type: 'text', text: 'two' });
    const billed = events.filter((e) => e.type === 'usage');
    expect(billed, 'an aborted reader dropped a turn it could see').toHaveLength(2);
    expect(stats.consumedBytes).toBe((await fs.stat(transcript)).size);
  });

  it('does not wait for a file that does not exist when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    // Trying the open before checking the signal must not turn into WAITING for
    // one: a 30s default timeout here would stall every teardown.
    await expect(
      drainWithSignal(path.join(tmpBase, 'never.jsonl'), ac.signal),
    ).resolves.toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('stops when the abort signal fires mid-tail', async () => {
    await write(assistant({ content: [{ type: 'text', text: 'one' }] }));
    const ac = new AbortController();

    const events: AdapterEvent[] = [];
    const collected = (async () => {
      for await (const e of readTranscript({
        path: transcript,
        price: fakePrice,
        pollIntervalMs: 10,
        signal: ac.signal,
      })) {
        events.push(e);
      }
    })();

    await sleep(60);
    ac.abort();
    await collected; // resolves, rather than hanging or throwing.

    expect(events).toContainEqual({ type: 'text', text: 'one' });
  });

  it('releases its watcher and timer when the caller stops iterating', async () => {
    await write(assistant({ content: [{ type: 'text', text: 'one' }] }));

    const before = process.getActiveResourcesInfo().length;
    for await (const e of readTranscript({
      path: transcript,
      price: fakePrice,
      pollIntervalMs: 10,
    })) {
      if (e.type === 'text') break; // abandon the iterator mid-tail.
    }
    await sleep(50);

    // A leaked poll timer or fs.watch would still be registered here.
    expect(process.getActiveResourcesInfo().length).toBeLessThanOrEqual(before);
  });

  it('reports its stats as the generator return value', async () => {
    await write(assistant({ content: [{ type: 'text', text: 'x' }] }));
    const it = readTranscript({ path: transcript, price: fakePrice, follow: false })[
      Symbol.asyncIterator
    ]();
    let result = await it.next();
    while (result.done !== true) result = await it.next();
    expect(result.value.recordsParsed).toBe(1);
    expect(result.value.eventsEmitted).toBe(3);
  });
});

describe('a whole realistic turn', () => {
  it('reconstructs the stream from a session written the way the CLI writes it', async () => {
    const stats = createStats();
    await write(
      { type: 'mode', mode: 'default', sessionId: SESSION },
      assistant({
        id: 'msg_turn',
        content: [{ type: 'thinking', thinking: 'plan', signature: 's' }],
        stopReason: null,
        usage: usage({ output_tokens: 3 }),
      }),
      assistant({
        id: 'msg_turn',
        content: [{ type: 'text', text: 'Reading the file.' }],
        stopReason: null,
        usage: usage({ output_tokens: 3 }),
      }),
      assistant({
        id: 'msg_turn',
        content: [{ type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: '/x' } }],
        stopReason: 'tool_use',
        usage: usage({ output_tokens: 412 }),
      }),
      toolResultRecord('toolu_r', '1\tconst x = 1;\n'),
      { type: 'system', subtype: 'turn_duration', durationMs: 4200 },
      assistant({
        id: 'msg_final',
        content: [{ type: 'text', text: 'Done.' }],
        stopReason: 'end_turn',
        usage: usage({ output_tokens: 12 }),
      }),
      { type: 'system', subtype: 'stop_hook_summary', hookCount: 1, preventedContinuation: false },
    );

    const events = await drain({ stats, price: realPrice });
    expect(events.map((e) => e.type)).toEqual([
      'session',
      'thinking',
      'text',
      'tool_use',
      'usage',
      'tool_result',
      'text',
      'usage',
    ]);
    const usages = events.filter((e) => e.type === 'usage');
    expect(usages.map((u) => (u.type === 'usage' ? u.outputTokens : 0))).toEqual([412, 12]);
    // No exit: the Stop hook is the caller's to interpret, not ours.
    expect(events.some((e) => e.type === 'exit')).toBe(false);
    expect(stats.malformedLines).toBe(0);
  });
});

describe('findTranscript', () => {
  it('finds a transcript under a project directory', async () => {
    const root = path.join(tmpBase, 'projects');
    const projectDir = path.join(root, '-Users-liufei-some-project');
    await fs.mkdir(projectDir, { recursive: true });
    const target = path.join(projectDir, `${SESSION}.jsonl`);
    await fs.writeFile(target, '');

    expect(await findTranscript(SESSION, { root })).toBe(target);
  });

  it('does not care that the directory encoding is lossy', async () => {
    // `/Users/a.b/x_y` and `/Users/a-b/x-y` encode to the same name; the session
    // id is what is unique, so the search never needs to invert the encoding.
    const root = path.join(tmpBase, 'projects');
    for (const dir of ['-Users-a-b-x-y', '-Users-liufei-other']) {
      await fs.mkdir(path.join(root, dir), { recursive: true });
    }
    const target = path.join(root, '-Users-a-b-x-y', `${SESSION}.jsonl`);
    await fs.writeFile(target, '');
    expect(await findTranscript(SESSION, { root })).toBe(target);
  });

  it('prefers the most recently modified when the id appears twice', async () => {
    const root = path.join(tmpBase, 'projects');
    const older = path.join(root, 'a', `${SESSION}.jsonl`);
    const newer = path.join(root, 'b', `${SESSION}.jsonl`);
    await fs.mkdir(path.dirname(older), { recursive: true });
    await fs.mkdir(path.dirname(newer), { recursive: true });
    await fs.writeFile(older, '');
    await fs.writeFile(newer, '');
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(older, past, past);

    expect(await findTranscript(SESSION, { root })).toBe(newer);
  });

  it('finds a transcript nested deeper than one level', async () => {
    const root = path.join(tmpBase, 'projects');
    const nested = path.join(root, 'proj', 'sub', 'deeper');
    await fs.mkdir(nested, { recursive: true });
    const target = path.join(nested, `${SESSION}.jsonl`);
    await fs.writeFile(target, '');
    expect(await findTranscript(SESSION, { root })).toBe(target);
  });

  it('finds a transcript that is a symlink', async () => {
    // Real layout: a resumed session symlinks its subagent transcripts back to the
    // session that wrote them, so a candidate is often a link, not a file.
    const root = path.join(tmpBase, 'projects');
    const real = path.join(tmpBase, 'elsewhere', `${SESSION}.jsonl`);
    await fs.mkdir(path.dirname(real), { recursive: true });
    await fs.writeFile(real, line(assistant({ content: [{ type: 'text', text: 'via link' }] })));

    const link = path.join(root, 'proj', `${SESSION}.jsonl`);
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(real, link);

    const found = await findTranscript(SESSION, { root });
    expect(found).toBe(link);
    expect(await drain({ path: found ?? '' })).toContainEqual({ type: 'text', text: 'via link' });
  });

  it('ignores a DANGLING symlink rather than returning an unopenable path', async () => {
    const root = path.join(tmpBase, 'projects');
    const dead = path.join(root, 'proj', `${SESSION}.jsonl`);
    await fs.mkdir(path.dirname(dead), { recursive: true });
    await fs.symlink(path.join(tmpBase, 'deleted-session.jsonl'), dead);

    // Returning it would strand the caller in the wait-for-file loop.
    expect(await findTranscript(SESSION, { root })).toBeUndefined();
  });

  it('returns undefined for an unknown session and a missing root', async () => {
    const root = path.join(tmpBase, 'projects');
    await fs.mkdir(root, { recursive: true });
    expect(await findTranscript('11111111-2222-3333-4444-555555555555', { root })).toBeUndefined();
    expect(
      await findTranscript(SESSION, { root: path.join(tmpBase, 'no-such-root') }),
    ).toBeUndefined();
  });

  it('rejects a session id that could escape the search root', async () => {
    for (const bad of ['../../etc/passwd', 'not-a-uuid', '', '*', `${SESSION}/../x`]) {
      await expect(findTranscript(bad)).rejects.toBeInstanceOf(InvalidSessionIdError);
    }
  });

  it('honours CLAUDE_CONFIG_DIR when resolving the default root', () => {
    expect(transcriptRoot({ CLAUDE_CONFIG_DIR: '/custom/cfg' })).toBe('/custom/cfg/projects');
    expect(transcriptRoot({ CLAUDE_CONFIG_DIR: '   ' })).toBe(
      path.join(os.homedir(), '.claude', 'projects'),
    );
    expect(transcriptRoot({})).toBe(path.join(os.homedir(), '.claude', 'projects'));
  });

  it('finds a real transcript through the default root', async () => {
    const root = path.join(tmpBase, 'cfg', 'projects', 'proj');
    await fs.mkdir(root, { recursive: true });
    const target = path.join(root, `${SESSION}.jsonl`);
    await fs.writeFile(target, line(assistant({ content: [{ type: 'text', text: 'end to end' }] })));

    const previous = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = path.join(tmpBase, 'cfg');
    try {
      const found = await findTranscript(SESSION);
      expect(found).toBe(target);
      expect(await drain({ path: found ?? '' })).toContainEqual({
        type: 'text',
        text: 'end to end',
      });
    } finally {
      if (previous === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
      else process.env['CLAUDE_CONFIG_DIR'] = previous;
    }
  });
});
