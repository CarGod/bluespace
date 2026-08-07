/**
 * Sentinel tests.
 *
 * The behaviour under test is not "does it call the SDK" — it is the contract
 * the orchestrator depends on: a validated verdict when verification completes,
 * and a FAILING verdict whenever it does not. A verifier that passes work it
 * could not check is the one bug in this module that would be invisible in
 * production, so most of these tests are about the failure paths.
 */

import { describe, expect, it } from 'vitest';

import type {
  AdapterCapabilities,
  AdapterEvent,
  Conversation,
  HarnessAdapter,
  Session,
  SpawnRequest,
} from '../src/adapters/types.js';
import { UnsupportedCapabilityError } from '../src/adapters/types.js';
import type { DispatchProfile, Task } from '../src/types/domain.js';
import { noTokenUsage, totalTokens, VERDICT_SCHEMA } from '../src/types/domain.js';
import {
  MAX_BRIEF_CHARS,
  MAX_DIFF_CHARS,
  runSentinel,
  SENTINEL_MAX_TURNS,
} from '../src/agents/sentinel/index.js';

// ---------------------------------------------------------------------------
// Fake adapter
// ---------------------------------------------------------------------------

const FULL_CAPS: AdapterCapabilities = {
  interrupt: true,
  fork: true,
  cost: true,
  toolEvents: true,
  structuredOutput: true,
  steer: true,
  conversation: true,
};

interface FakeAdapter {
  adapter: HarnessAdapter;
  spawns: SpawnRequest[];
  closes: number;
}

/**
 * An adapter that replays a scripted event stream. `script` may also be a
 * function so a test can throw mid-stream.
 */
function fakeAdapter(
  script: AdapterEvent[] | (() => AsyncIterable<AdapterEvent>),
  opts: { capabilities?: Partial<AdapterCapabilities>; spawnError?: Error } = {},
): FakeAdapter {
  const state: FakeAdapter = {
    spawns: [],
    closes: 0,
    adapter: {
      name: 'fake',
      capabilities: { ...FULL_CAPS, ...opts.capabilities },
      // The Sentinel is a one-shot worker; it never opens a conversation.
      async converse(): Promise<Conversation> {
        throw new UnsupportedCapabilityError('fake', 'conversation');
      },
      async spawn(req: SpawnRequest): Promise<Session> {
        state.spawns.push(req);
        if (opts.spawnError) throw opts.spawnError;
        const session: Session = {
          id: 'fake-session',
          events(): AsyncIterable<AdapterEvent> {
            if (typeof script === 'function') return script();
            return (async function* () {
              for (const e of script) yield e;
            })();
          },
          async send(): Promise<void> {},
          async interrupt(): Promise<void> {},
          async close(): Promise<void> {
            state.closes += 1;
          },
        };
        return session;
      },
    },
  };
  return state;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    kind: 'mission',
    projectId: 'proj-1',
    title: 'Add retry to the uploader',
    brief: 'Retry failed uploads three times with backoff, log each attempt, and add a test.',
    state: 'verifying',
    dependsOn: [],
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    tokens: noTokenUsage(),
    metered: false,
    listPriceUsd: 0,
    reworkCount: 0,
    ...overrides,
  };
}

const PROFILE: DispatchProfile = {
  model: 'claude-opus-4',
  effort: 'high',
  // The default posture since crews became real interactive sessions: it edits
  // unattended with no dialog and no machine-wide config write.
  permissionMode: 'auto',
  maxBudgetUsd: 5,
  maxTurns: 200,
};

const DIFF = [
  'diff --git a/src/uploader.ts b/src/uploader.ts',
  '@@ -1,3 +1,9 @@',
  '+for (let attempt = 0; attempt < 3; attempt++) {',
  '+  await backoff(attempt);',
  '+}',
].join('\n');

function usage(costUsd: number, model = 'claude-opus-5'): AdapterEvent {
  return { type: 'usage', costUsd, inputTokens: 100, outputTokens: 20, model };
}

function exitWith(structured: unknown, ok = true): AdapterEvent {
  return { type: 'exit', ok, structured };
}

function run(adapter: HarnessAdapter, task: Task = makeTask(), diff: string = DIFF) {
  return runSentinel({ adapter, task, diff, cwd: '/tmp/wt/task-1', profile: PROFILE });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runSentinel — pass verdict', () => {
  it('returns the validated verdict when the diff satisfies the brief', async () => {
    const fake = fakeAdapter([
      { type: 'session', sessionId: 's1' },
      { type: 'text', text: 'checking the brief against the diff' },
      usage(0.02),
      exitWith({ pass: true, reasoning: 'All three requirements are present in the diff.', unmet: [] }),
    ]);

    const verdict = await run(fake.adapter);

    expect(verdict.pass).toBe(true);
    expect(verdict.unmet).toEqual([]);
    expect(verdict.reasoning).toBe('All three requirements are present in the diff.');
    expect(verdict.taskId).toBe('task-1');
    expect(verdict.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(verdict.listPriceUsd).toBeCloseTo(0.02, 10);
    expect(fake.closes).toBe(1);
  });

  it('records the tokens verification consumed, by model', async () => {
    // Verification runs a model too. Recording only its dollars made a
    // Sentinel's consumption invisible to the ceiling that is meant to bound
    // the task — and on a subscription, dollars were the one number that meant
    // nothing.
    const fake = fakeAdapter([
      usage(0.02),
      usage(0.01, 'claude-haiku-4-5'),
      exitWith({ pass: true, reasoning: 'ok', unmet: [] }),
    ]);

    const verdict = await run(fake.adapter);

    expect(totalTokens(verdict.tokens.totals)).toBe(240);
    expect(verdict.tokens.byModel['claude-opus-5']).toMatchObject({ input: 100, output: 20 });
    expect(verdict.tokens.byModel['claude-haiku-4-5']).toMatchObject({ input: 100, output: 20 });
  });

  it('still reports the tokens a verification burned when it could not produce a verdict', async () => {
    // Failing closed must not also lose the accounting: those tokens were spent
    // whether or not a verdict came back.
    const fake = fakeAdapter([usage(0.02), exitWith(undefined)]);
    const verdict = await run(fake.adapter);

    expect(verdict.pass).toBe(false);
    expect(totalTokens(verdict.tokens.totals)).toBe(120);
  });

  it('spawns with the verdict schema, the worktree cwd, and a derived profile', async () => {
    const fake = fakeAdapter([exitWith({ pass: true, reasoning: 'ok', unmet: [] })]);
    await run(fake.adapter);

    const req = fake.spawns[0];
    expect(req).toBeDefined();
    expect(req?.outputSchema).toBe(VERDICT_SCHEMA);
    expect(req?.cwd).toBe('/tmp/wt/task-1');
    expect(req?.profile.model).toBe(PROFILE.model);
    expect(req?.profile.permissionMode).toBe(PROFILE.permissionMode);
    // Verification is one read-and-judge pass; the Crew's 200-turn leash is cut down.
    expect(req?.profile.maxTurns).toBe(SENTINEL_MAX_TURNS);
  });

  it('keeps a posture that can actually produce a verdict', async () => {
    // The verdict is a FILE the Sentinel writes now, not a schema-constrained
    // tool call. `plan` changes nothing on disk by definition and `dontAsk`
    // refuses Write outright, so inheriting either would fail every
    // verification closed — and a task whose diff was never judged would burn
    // its whole rework budget before reaching the captain.
    for (const mode of ['plan', 'dontAsk'] as const) {
      const fake = fakeAdapter([exitWith({ pass: true, reasoning: 'ok', unmet: [] })]);
      await runSentinel({
        adapter: fake.adapter,
        task: makeTask(),
        diff: DIFF,
        cwd: '/tmp/wt/task-1',
        profile: { ...PROFILE, permissionMode: mode },
      });
      expect(fake.spawns[0]?.profile.permissionMode).toBe('auto');
    }

    // Every other posture is the Crew's, untouched: the Sentinel is held
    // read-only by its system prompt, not by a mode.
    const fake = fakeAdapter([exitWith({ pass: true, reasoning: 'ok', unmet: [] })]);
    await runSentinel({
      adapter: fake.adapter,
      task: makeTask(),
      diff: DIFF,
      cwd: '/tmp/wt/task-1',
      profile: { ...PROFILE, permissionMode: 'acceptEdits' },
    });
    expect(fake.spawns[0]?.profile.permissionMode).toBe('acceptEdits');
  });

  it('tells the Sentinel it may write its verdict file and nothing else', async () => {
    const fake = fakeAdapter([exitWith({ pass: true, reasoning: 'ok', unmet: [] })]);
    await run(fake.adapter);

    // The read-only rule and the file-based verdict path contradict each other
    // unless the exception is stated: a Sentinel that obeys "create nothing"
    // literally writes no verdict, and fails closed on work it actually judged.
    const sys = fake.spawns[0]?.systemPromptAppend ?? '';
    expect(sys).toMatch(/read-only over the worktree/i);
    expect(sys).toMatch(/must not edit, create, delete, stage, commit/i);
    expect(sys).toMatch(/ONE file you must write is the\s+structured-output file/i);
    expect(sys).toMatch(/outside the\s+worktree/i);
  });

  it('gives the Sentinel the brief and the diff, and nothing about the Crew', async () => {
    const fake = fakeAdapter([exitWith({ pass: true, reasoning: 'ok', unmet: [] })]);
    const task = makeTask();
    await run(fake.adapter, task);

    const prompt = fake.spawns[0]?.prompt ?? '';
    expect(prompt).toContain(task.brief);
    expect(prompt).toContain('await backoff(attempt);');
    expect(prompt).toContain('BEGIN BRIEF');
    expect(prompt).toContain('BEGIN DIFF');
    // Context isolation: no resume handle, so no way to inherit the Crew's session.
    expect(fake.spawns[0]?.resume).toBeUndefined();
  });
});

describe('runSentinel — fail verdict', () => {
  it('carries the unmet requirements through verbatim', async () => {
    const unmet = ['No test was added for the retry path', 'Attempts are not logged'];
    const fake = fakeAdapter([
      usage(0.01),
      exitWith({
        pass: false,
        reasoning: 'The diff retries but skips logging and tests.',
        unmet,
      }),
    ]);

    const verdict = await run(fake.adapter);

    expect(verdict.pass).toBe(false);
    expect(verdict.unmet).toEqual(unmet);
    expect(verdict.reasoning).toContain('skips logging');
    expect(fake.closes).toBe(1);
  });

  it('treats a self-contradictory pass (pass:true with unmet items) as a failure', async () => {
    const fake = fakeAdapter([
      exitWith({ pass: true, reasoning: 'Mostly done.', unmet: ['No test was added'] }),
    ]);

    const verdict = await run(fake.adapter);

    expect(verdict.pass).toBe(false);
    expect(verdict.unmet).toEqual(['No test was added']);
    expect(verdict.reasoning).toMatch(/self-contradictory/i);
  });
});

describe('runSentinel — fails closed', () => {
  it('fails when the exit event carries no structured output', async () => {
    const fake = fakeAdapter([
      { type: 'text', text: 'Looks good to me!' },
      usage(0.03),
      { type: 'exit', ok: true },
    ]);

    const verdict = await run(fake.adapter);

    expect(verdict.pass).toBe(false);
    expect(verdict.reasoning).toMatch(/could not be completed/i);
    expect(verdict.reasoning).toMatch(/structured verdict/i);
    expect(verdict.unmet.length).toBeGreaterThan(0);
    expect(verdict.listPriceUsd).toBeCloseTo(0.03, 10);
    expect(fake.closes).toBe(1);
  });

  it('fails when structured output is present but malformed', async () => {
    const fake = fakeAdapter([exitWith({ pass: 'yes', reasoning: 42 })]);

    const verdict = await run(fake.adapter);

    expect(verdict.pass).toBe(false);
    expect(verdict.reasoning).toMatch(/not a valid verdict/i);
    expect(verdict.reasoning).toContain('pass');
  });

  it('fails when the stream ends without an exit event', async () => {
    const fake = fakeAdapter([{ type: 'text', text: 'partial' }, usage(0.005)]);

    const verdict = await run(fake.adapter);

    expect(verdict.pass).toBe(false);
    expect(verdict.reasoning).toMatch(/without an exit event/i);
    expect(verdict.listPriceUsd).toBeCloseTo(0.005, 10);
  });

  it('fails when the run was interrupted, even with structured output attached', async () => {
    const fake = fakeAdapter([
      usage(0.5),
      {
        type: 'exit',
        ok: false,
        interrupted: true,
        structured: { pass: true, reasoning: 'looks fine', unmet: [] },
      },
    ]);

    const verdict = await run(fake.adapter);

    expect(verdict.pass).toBe(false);
    expect(verdict.reasoning).toMatch(/interrupted/i);
  });

  it('fails when the event stream throws, and still closes the session', async () => {
    const fake = fakeAdapter(() =>
      (async function* (): AsyncIterable<AdapterEvent> {
        yield usage(0.07);
        throw new Error('harness pipe closed');
      })(),
    );

    const verdict = await run(fake.adapter);

    expect(verdict.pass).toBe(false);
    expect(verdict.reasoning).toContain('harness pipe closed');
    expect(verdict.listPriceUsd).toBeCloseTo(0.07, 10);
    expect(fake.closes).toBe(1);
  });

  it('fails when spawn itself throws, without leaking a session', async () => {
    const fake = fakeAdapter([], { spawnError: new Error('no api key') });

    const verdict = await run(fake.adapter);

    expect(verdict.pass).toBe(false);
    expect(verdict.reasoning).toContain('no api key');
    expect(fake.closes).toBe(0);
  });

  it('refuses to run at all on an adapter without structured output', async () => {
    const fake = fakeAdapter([], { capabilities: { structuredOutput: false } });

    await expect(run(fake.adapter)).rejects.toBeInstanceOf(UnsupportedCapabilityError);
    expect(fake.spawns).toHaveLength(0);
  });
});

describe('runSentinel — cost accumulation', () => {
  it('sums every usage event in the stream', async () => {
    const fake = fakeAdapter([
      usage(0.01),
      usage(0.02),
      usage(0.005),
      exitWith({ pass: true, reasoning: 'ok', unmet: [] }),
    ]);

    const verdict = await run(fake.adapter);

    expect(verdict.listPriceUsd).toBeCloseTo(0.035, 10);
  });

  it('is zero when the harness reports no usage', async () => {
    const fake = fakeAdapter([exitWith({ pass: true, reasoning: 'ok', unmet: [] })]);
    const verdict = await run(fake.adapter);
    expect(verdict.listPriceUsd).toBe(0);
  });

  it('ignores non-finite costs instead of poisoning the total', async () => {
    const fake = fakeAdapter([
      usage(0.02),
      usage(Number.NaN),
      exitWith({ pass: true, reasoning: 'ok', unmet: [] }),
    ]);

    const verdict = await run(fake.adapter);

    expect(verdict.listPriceUsd).toBeCloseTo(0.02, 10);
  });
});

describe('runSentinel — prompt shaping', () => {
  it('truncates an enormous diff and says so', async () => {
    const fake = fakeAdapter([exitWith({ pass: true, reasoning: 'ok', unmet: [] })]);
    const huge = 'a'.repeat(50) + '\n'.repeat(1) + 'b'.repeat(MAX_DIFF_CHARS + 50_000);

    await run(fake.adapter, makeTask(), huge);

    const prompt = fake.spawns[0]?.prompt ?? '';
    expect(prompt).toMatch(/TRUNCATED/);
    expect(prompt).toMatch(/treat anything you cannot see as unverified/i);
    expect(prompt.length).toBeLessThan(MAX_DIFF_CHARS + 10_000);
  });

  it('marks the cut IN BAND, where the evidence actually stops', async () => {
    // A note after the closing delimiter is a note a reader can reach the end of
    // the diff without having seen. The marker sits at the exact character the
    // evidence stops at, so "I have read the whole diff" is not available.
    const fake = fakeAdapter([exitWith({ pass: true, reasoning: 'ok', unmet: [] })]);
    await run(fake.adapter, makeTask(), 'x'.repeat(MAX_DIFF_CHARS + 1_000));

    const prompt = fake.spawns[0]?.prompt ?? '';
    const marker = prompt.indexOf('!!! DIFF TRUNCATED HERE');
    const endOfDiff = prompt.indexOf('--- END DIFF ---');
    expect(marker, 'the cut must be marked where it happens').toBeGreaterThan(0);
    expect(marker, 'the marker belongs inside the diff block').toBeLessThan(endOfDiff);
  });

  it('never silently drops evidence: the omitted amount is always stated', async () => {
    const fake = fakeAdapter([exitWith({ pass: true, reasoning: 'ok', unmet: [] })]);
    const omitted = 40_000;
    await run(fake.adapter, makeTask(), 'x'.repeat(MAX_DIFF_CHARS + omitted));

    // The number itself, not just the word "truncated". A Sentinel told that
    // something was cut but not how much cannot weigh what it is missing.
    expect(fake.spawns[0]?.prompt ?? '').toContain(omitted.toLocaleString('en-US'));
  });

  it('demands a verdict anyway, because no verdict helps nobody', async () => {
    // The third option, and the one that is not acceptable: a Sentinel that
    // refuses to judge because the evidence is incomplete leaves the captain a
    // dead task and a diff nothing ever looked at.
    const fake = fakeAdapter([exitWith({ pass: true, reasoning: 'ok', unmet: [] })]);
    await run(fake.adapter, makeTask(), 'x'.repeat(MAX_DIFF_CHARS + 1_000));

    expect(fake.spawns[0]?.prompt ?? '').toMatch(/Do NOT refuse to answer/i);
    // And the same instruction in the channel it cannot skip.
    expect(fake.spawns[0]?.systemPromptAppend ?? '').toMatch(/ALWAYS RETURN A VERDICT/);
  });

  it('bounds the BRIEF too, and treats cut requirements as unverifiable', async () => {
    // Cutting requirements is strictly worse than cutting evidence: a verifier
    // that cannot read a requirement cannot confirm it, and under its own rules
    // that is a fail rather than a pass.
    const fake = fakeAdapter([exitWith({ pass: true, reasoning: 'ok', unmet: [] })]);
    const brief = 'Do the thing.\n'.repeat(MAX_BRIEF_CHARS);

    await run(fake.adapter, makeTask({ brief }), 'diff');

    const prompt = fake.spawns[0]?.prompt ?? '';
    expect(prompt).toContain('!!! BRIEF TRUNCATED HERE');
    expect(prompt).toMatch(/some requirements could not be checked/i);
    expect(prompt).toMatch(/pass: false/);
    // Bounded by construction: a prompt is a bounded brief plus a bounded diff,
    // so however large a task gets there is a size this cannot exceed.
    expect(prompt.length).toBeLessThan(MAX_BRIEF_CHARS + MAX_DIFF_CHARS + 10_000);
  });

  it('says nothing about truncation when nothing was truncated', async () => {
    // A standing warning about incomplete evidence would teach the Sentinel to
    // discount a diff it can see in full.
    const fake = fakeAdapter([exitWith({ pass: true, reasoning: 'ok', unmet: [] })]);
    await run(fake.adapter, makeTask(), 'a small diff');

    expect(fake.spawns[0]?.prompt ?? '').not.toMatch(/TRUNCATED/);
  });

  it('says plainly when the diff is empty rather than sending a blank block', async () => {
    const fake = fakeAdapter([exitWith({ pass: false, reasoning: 'nothing here', unmet: ['all of it'] })]);

    await run(fake.adapter, makeTask(), '   \n  ');

    expect(fake.spawns[0]?.prompt ?? '').toMatch(/diff is EMPTY/);
  });

  it('tells the Sentinel that a recon must not touch project code', async () => {
    const fake = fakeAdapter([exitWith({ pass: true, reasoning: 'ok', unmet: [] })]);

    await run(fake.adapter, makeTask({ kind: 'recon', brief: 'Find out why uploads stall.' }));

    const prompt = fake.spawns[0]?.prompt ?? '';
    expect(prompt).toMatch(/RECON/);
    expect(prompt).toMatch(/REPORT\.md/);
  });
});
