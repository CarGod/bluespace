/**
 * Blackbox tests — the store's ordering/filter/notification contract, and the
 * projections that every other module derives its state from.
 *
 * All of these run against an in-memory SQLite database, so the suite is
 * hermetic and leaves nothing behind.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Blackbox,
  UNKNOWN_MODEL,
  projectAllDecisions,
  projectCost,
  projectCrewLog,
  projectOpenDecisions,
  projectTask,
  projectTasks,
  projectUsage,
} from '../src/blackbox/index.js';
import { totalTokens } from '../src/types/domain.js';
import type { BlueEvent } from '../src/types/events.js';

let bb: Blackbox;

beforeEach(() => {
  bb = Blackbox.open(':memory:');
});

afterEach(() => {
  bb.close();
  vi.useRealTimers();
});

/** Deterministic clock so `at` is distinct and assertable. */
function useClock(startMs = 1_700_000_000_000): (deltaMs?: number) => number {
  vi.useFakeTimers();
  vi.setSystemTime(startMs);
  let now = startMs;
  return (deltaMs = 1_000) => {
    now += deltaMs;
    vi.setSystemTime(now);
    return now;
  };
}

function createTask(taskId: string, title = 'Add auth'): void {
  bb.append({
    type: 'task.created',
    taskId,
    kind: 'mission',
    projectId: 'proj-1',
    title,
    brief: `brief for ${title}`,
    dependsOn: [],
  });
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

describe('Blackbox store', () => {
  it('round-trips an appended event through read()', () => {
    const tick = useClock();
    const at = tick();

    const appended = bb.append({
      type: 'task.created',
      taskId: 't1',
      kind: 'recon',
      projectId: 'proj-1',
      title: 'Investigate flaky test',
      brief: 'Find out why CI is red on main.',
      dependsOn: ['t0'],
    });

    expect(appended.seq).toBe(1);
    expect(appended.at).toBe(at);

    const read = bb.read();
    expect(read).toHaveLength(1);
    expect(read[0]).toEqual(appended);
    // The body survives the JSON round-trip intact, arrays included.
    const [event] = read;
    expect(event?.type).toBe('task.created');
    if (event?.type === 'task.created') {
      expect(event.dependsOn).toEqual(['t0']);
      expect(event.brief).toBe('Find out why CI is red on main.');
    }
  });

  it('assigns strictly increasing seq across append and appendMany', () => {
    const first = bb.append({ type: 'crew.thinking', crewId: 'c1' });
    const batch = bb.appendMany([
      { type: 'crew.text', crewId: 'c1', text: 'one' },
      { type: 'crew.text', crewId: 'c1', text: 'two' },
      { type: 'crew.text', crewId: 'c1', text: 'three' },
    ]);
    const last = bb.append({ type: 'crew.exited', crewId: 'c1', ok: true });

    const seqs = [first, ...batch, last].map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);

    const stored = bb.read().map((e) => e.seq);
    expect(stored).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < stored.length; i += 1) {
      expect(stored[i]!).toBeGreaterThan(stored[i - 1]!);
    }
  });

  it('appendMany commits as one transaction and returns [] for an empty batch', () => {
    expect(bb.appendMany([])).toEqual([]);
    expect(bb.read()).toHaveLength(0);

    bb.appendMany([
      { type: 'crew.text', crewId: 'c1', text: 'a' },
      { type: 'crew.text', crewId: 'c1', text: 'b' },
    ]);
    expect(bb.read()).toHaveLength(2);
  });

  it('filters by taskId, extracting it from the body', () => {
    createTask('t1');
    createTask('t2', 'Other task');
    bb.append({ type: 'task.failed', taskId: 't1', reason: 'boom' });
    // Crew events carry no taskId and must not leak into a task filter.
    bb.append({ type: 'crew.text', crewId: 'c1', text: 'hello' });

    const t1 = bb.read({ taskId: 't1' });
    expect(t1.map((e) => e.type)).toEqual(['task.created', 'task.failed']);

    expect(bb.read({ taskId: 't2' })).toHaveLength(1);
    expect(bb.read({ taskId: 'nope' })).toHaveLength(0);
    expect(bb.read()).toHaveLength(4);
  });

  it('filters by sinceSeq, types and limit, always ordered by seq ASC', () => {
    createTask('t1');
    bb.append({ type: 'crew.text', crewId: 'c1', text: 'a' });
    bb.append({ type: 'crew.text', crewId: 'c1', text: 'b' });
    bb.append({ type: 'task.failed', taskId: 't1', reason: 'boom' });

    expect(bb.read({ sinceSeq: 2 }).map((e) => e.seq)).toEqual([3, 4]);
    expect(bb.read({ types: ['crew.text'] }).map((e) => e.seq)).toEqual([2, 3]);
    expect(bb.read({ types: ['task.created', 'task.failed'] }).map((e) => e.seq)).toEqual([1, 4]);
    expect(bb.read({ limit: 2 }).map((e) => e.seq)).toEqual([1, 2]);
    expect(bb.read({ sinceSeq: 1, types: ['crew.text'], limit: 1 }).map((e) => e.seq)).toEqual([2]);
    // Degenerate filters mean "nothing", not "everything".
    expect(bb.read({ types: [] })).toEqual([]);
    expect(bb.read({ limit: 0 })).toEqual([]);
  });

  it('notifies subscribers synchronously and honours unsubscribe', () => {
    const seen: BlueEvent[] = [];
    const unsubscribe = bb.subscribe((e) => seen.push(e));

    const one = bb.append({ type: 'crew.text', crewId: 'c1', text: 'first' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(one);

    bb.appendMany([
      { type: 'crew.text', crewId: 'c1', text: 'second' },
      { type: 'crew.text', crewId: 'c1', text: 'third' },
    ]);
    expect(seen.map((e) => e.seq)).toEqual([1, 2, 3]);

    unsubscribe();
    bb.append({ type: 'crew.text', crewId: 'c1', text: 'fourth' });
    expect(seen).toHaveLength(3);
    // The un-observed event is still persisted.
    expect(bb.read()).toHaveLength(4);
  });

  it('keeps appending when a subscriber throws', () => {
    const seen: number[] = [];
    bb.subscribe(() => {
      throw new Error('subscriber exploded');
    });
    bb.subscribe((e) => seen.push(e.seq));

    expect(() => bb.append({ type: 'crew.thinking', crewId: 'c1' })).not.toThrow();
    expect(() =>
      bb.appendMany([
        { type: 'crew.text', crewId: 'c1', text: 'a' },
        { type: 'crew.text', crewId: 'c1', text: 'b' },
      ]),
    ).not.toThrow();

    expect(seen).toEqual([1, 2, 3]);
    expect(bb.read()).toHaveLength(3);
  });

  it('rejects use after close', () => {
    bb.append({ type: 'crew.thinking', crewId: 'c1' });
    bb.close();
    expect(() => bb.append({ type: 'crew.thinking', crewId: 'c1' })).toThrow(/closed/);
    expect(() => bb.read()).toThrow(/closed/);
    // close() is idempotent; afterEach calls it again.
    expect(() => bb.close()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task projection
// ---------------------------------------------------------------------------

describe('projectTasks', () => {
  it('folds a full mission lifecycle through rework to landed', () => {
    const tick = useClock();

    createTask('t1', 'Add auth');
    tick();
    bb.append({
      type: 'task.dispatched',
      taskId: 't1',
      crewId: 'c1',
      worktree: '/tmp/wt/t1',
      model: 'claude-opus-4',
      permissionMode: 'auto',
    });
    tick();
    bb.append({ type: 'crew.spawned', crewId: 'c1', taskId: 't1', cwd: '/tmp/wt/t1' });
    tick();
    bb.append({ type: 'task.state_changed', taskId: 't1', from: 'dispatched', to: 'working' });
    tick();
    bb.append({
      type: 'crew.usage',
      crewId: 'c1',
      costUsd: 0.25,
      inputTokens: 1000,
      outputTokens: 400,
      model: 'claude-opus-4',
    });
    tick();
    bb.append({ type: 'task.state_changed', taskId: 't1', from: 'working', to: 'verifying' });
    tick();
    bb.append({ type: 'sentinel.started', taskId: 't1', verdictId: 'v1' });
    tick();
    bb.append({
      type: 'sentinel.verdict',
      taskId: 't1',
      verdictId: 'v1',
      pass: false,
      reasoning: 'No tests for the new middleware.',
      unmet: ['tests'],
      costUsd: 0.05,
    });
    tick();
    bb.append({
      type: 'task.state_changed',
      taskId: 't1',
      from: 'verifying',
      to: 'needs_rework',
      reason: 'sentinel_failed',
    });
    tick();
    bb.append({ type: 'task.state_changed', taskId: 't1', from: 'needs_rework', to: 'working' });
    tick();
    bb.append({
      type: 'crew.usage',
      crewId: 'c1',
      costUsd: 0.1,
      inputTokens: 500,
      outputTokens: 200,
      model: 'claude-opus-4',
    });
    tick();
    bb.append({ type: 'task.state_changed', taskId: 't1', from: 'working', to: 'verifying' });
    tick();
    bb.append({
      type: 'sentinel.verdict',
      taskId: 't1',
      verdictId: 'v2',
      pass: true,
      reasoning: 'Middleware and tests both present.',
      unmet: [],
      costUsd: 0.05,
    });
    tick();
    bb.append({ type: 'task.state_changed', taskId: 't1', from: 'verifying', to: 'ready' });
    const landedAt = tick();
    bb.append({
      type: 'task.completed',
      taskId: 't1',
      artifact: 'blue/t1',
      summary: 'Auth middleware landed.',
    });

    const events = bb.read();
    const task = projectTasks(events).get('t1');

    expect(task).toBeDefined();
    expect(task?.state).toBe('landed');
    expect(task?.kind).toBe('mission');
    expect(task?.title).toBe('Add auth');
    expect(task?.crewId).toBe('c1');
    expect(task?.worktree).toBe('/tmp/wt/t1');
    expect(task?.reworkCount).toBe(1);
    expect(task?.listPriceUsd).toBeCloseTo(0.45, 10);
    expect(task?.createdAt).toBe(1_700_000_000_000);
    expect(task?.updatedAt).toBe(landedAt);

    // Scoped projection agrees with the full one.
    expect(projectTask(events, 't1')).toEqual(task);
    expect(projectTask(events, 'ghost')).toBeUndefined();
  });

  it('starts queued, tracks failure, and keeps tasks independent', () => {
    createTask('t1');
    createTask('t2', 'Second');
    bb.append({ type: 'task.failed', taskId: 't2', reason: 'worktree dirty' });

    const tasks = projectTasks(bb.read());
    expect(tasks.size).toBe(2);
    expect(tasks.get('t1')?.state).toBe('queued');
    expect(tasks.get('t1')?.listPriceUsd).toBe(0);
    expect(tasks.get('t2')?.state).toBe('failed');
  });

  it('folds a dismissal without disturbing anything that happened', () => {
    // Clearing a card off the Starmap board is a VIEW fact. It must not change
    // the state, must not bump `updatedAt` (which would reorder the board and
    // misreport last activity), and must not touch a single number.
    createTask('t1');
    bb.append({ type: 'task.failed', taskId: 't1', reason: 'token ceiling' });
    bb.append({ type: 'crew.spawned', crewId: 'c1', taskId: 't1', cwd: '/wt/1' });
    bb.append({ type: 'crew.usage', crewId: 'c1', costUsd: 0.5, inputTokens: 100, outputTokens: 20 });
    const before = projectTasks(bb.read()).get('t1');

    bb.append({ type: 'task.dismissed', taskId: 't1', dismissed: true });
    const after = projectTasks(bb.read()).get('t1');

    expect(after?.dismissedAt).toBeGreaterThan(0);
    expect(after?.state).toBe('failed');
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.listPriceUsd).toBe(before?.listPriceUsd);
    expect(totalTokens(after?.tokens.totals ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }))
      .toBe(totalTokens(before?.tokens.totals ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }));
  });

  it('puts a dismissed task back with the same event', () => {
    // Reversible by design: the log records the captain changing their mind
    // rather than losing the fact that they once cleared it.
    createTask('t1');
    bb.append({ type: 'task.failed', taskId: 't1', reason: 'nope' });
    bb.append({ type: 'task.dismissed', taskId: 't1', dismissed: true });
    bb.append({ type: 'task.dismissed', taskId: 't1', dismissed: false });

    expect(projectTasks(bb.read()).get('t1')?.dismissedAt).toBeUndefined();
  });

  it('ignores a dismissal for a task that does not exist', () => {
    bb.append({ type: 'task.dismissed', taskId: 'ghost', dismissed: true });
    expect(projectTasks(bb.read()).size).toBe(0);
  });

  it('attributes crew.usage to the task that owns the crew', () => {
    createTask('t1');
    createTask('t2', 'Second');
    bb.append({ type: 'crew.spawned', crewId: 'c1', taskId: 't1', cwd: '/wt/1' });
    bb.append({ type: 'crew.spawned', crewId: 'c2', taskId: 't2', cwd: '/wt/2' });
    bb.append({
      type: 'crew.usage',
      crewId: 'c2',
      costUsd: 0.75,
      inputTokens: 10,
      outputTokens: 5,
    });
    // Usage from a crew we never saw spawn is not attributable to any task.
    bb.append({
      type: 'crew.usage',
      crewId: 'ghost',
      costUsd: 9,
      inputTokens: 1,
      outputTokens: 1,
    });

    const tasks = projectTasks(bb.read());
    expect(tasks.get('t1')?.listPriceUsd).toBe(0);
    expect(tasks.get('t2')?.listPriceUsd).toBe(0.75);
  });

  it('counts only entries into needs_rework', () => {
    createTask('t1');
    bb.append({ type: 'task.state_changed', taskId: 't1', from: 'verifying', to: 'needs_rework' });
    bb.append({ type: 'task.state_changed', taskId: 't1', from: 'needs_rework', to: 'working' });
    bb.append({ type: 'task.state_changed', taskId: 't1', from: 'verifying', to: 'needs_rework' });
    bb.append({ type: 'task.state_changed', taskId: 't1', from: 'needs_rework', to: 'needs_rework' });

    expect(projectTasks(bb.read()).get('t1')?.reworkCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Cost projection
// ---------------------------------------------------------------------------

describe('projectCost', () => {
  it('accumulates crew and sentinel spend by task and by model', () => {
    createTask('t1');
    createTask('t2', 'Second');
    bb.append({ type: 'crew.spawned', crewId: 'c1', taskId: 't1', cwd: '/wt/1' });
    bb.append({ type: 'crew.spawned', crewId: 'c2', taskId: 't2', cwd: '/wt/2' });
    bb.append({
      type: 'crew.usage',
      crewId: 'c1',
      costUsd: 0.1,
      inputTokens: 1,
      outputTokens: 1,
      model: 'claude-opus-4',
    });
    bb.append({
      type: 'crew.usage',
      crewId: 'c1',
      costUsd: 0.2,
      inputTokens: 1,
      outputTokens: 1,
      model: 'claude-opus-4',
    });
    bb.append({
      type: 'crew.usage',
      crewId: 'c2',
      costUsd: 0.4,
      inputTokens: 1,
      outputTokens: 1,
      model: 'claude-haiku-4',
    });
    bb.append({
      type: 'sentinel.verdict',
      taskId: 't1',
      verdictId: 'v1',
      pass: true,
      reasoning: 'ok',
      unmet: [],
      costUsd: 0.05,
    });

    const cost = projectCost(bb.read());

    // 0.1 + 0.2 must not surface as 0.30000000000000004.
    expect(cost.byTask['t1']).toBe(0.35);
    expect(cost.byTask['t2']).toBe(0.4);
    expect(cost.byModel['claude-opus-4']).toBe(0.3);
    expect(cost.byModel['claude-haiku-4']).toBe(0.4);
    expect(cost.byModel['unknown']).toBe(0.05);
    expect(cost.totalUsd).toBe(0.75);

    const modelSum = Object.values(cost.byModel).reduce((a, b) => a + b, 0);
    expect(modelSum).toBeCloseTo(cost.totalUsd, 10);
    // The task projection agrees with the cost projection.
    expect(projectTasks(bb.read()).get('t1')?.listPriceUsd).toBe(cost.byTask['t1']);
  });

  it('returns zeroed totals for an empty log', () => {
    expect(projectCost([])).toEqual({ totalUsd: 0, byTask: {}, byModel: {} });
  });
});

// ---------------------------------------------------------------------------
// Token accounting — the primary unit
// ---------------------------------------------------------------------------

describe('token accounting', () => {
  it('accumulates a task\'s tokens per model and per kind', () => {
    // The ground truth in a transcript is `message.usage` and `message.model`.
    // A task that ran on two models has two answers, and one number covering
    // both cannot be compared to a quota.
    createTask('t1');
    bb.append({ type: 'crew.spawned', crewId: 'c1', taskId: 't1', cwd: '/wt/1' });
    bb.append({
      type: 'crew.usage',
      crewId: 'c1',
      costUsd: 0.1,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 20_000,
      cacheCreationTokens: 3000,
      model: 'claude-opus-5',
    });
    bb.append({
      type: 'crew.usage',
      crewId: 'c1',
      costUsd: 0.01,
      inputTokens: 100,
      outputTokens: 50,
      model: 'claude-haiku-4-5',
    });

    const task = projectTasks(bb.read()).get('t1');
    expect(task?.tokens.totals).toEqual({
      input: 1100,
      output: 550,
      cacheRead: 20_000,
      cacheCreation: 3000,
    });
    expect(totalTokens(task!.tokens.totals)).toBe(24_650);
    expect(task?.tokens.byModel['claude-opus-5']).toEqual({
      input: 1000,
      output: 500,
      cacheRead: 20_000,
      cacheCreation: 3000,
    });
    expect(task?.tokens.byModel['claude-haiku-4-5']).toEqual({
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheCreation: 0,
    });
  });

  it('counts a Sentinel\'s tokens against the task it verified', () => {
    // Verification is not free, and its tokens used to vanish: the verdict
    // event carried dollars and nothing else, so every token total in the
    // system — including the ceiling — silently excluded every Sentinel run.
    createTask('t1');
    bb.append({ type: 'crew.spawned', crewId: 'c1', taskId: 't1', cwd: '/wt/1' });
    bb.append({
      type: 'crew.usage',
      crewId: 'c1',
      costUsd: 0.1,
      inputTokens: 1000,
      outputTokens: 100,
      model: 'claude-opus-5',
    });
    bb.append({
      type: 'sentinel.verdict',
      taskId: 't1',
      verdictId: 'v1',
      pass: true,
      reasoning: 'ok',
      unmet: [],
      costUsd: 0.05,
      tokensByModel: {
        'claude-opus-5': { input: 4000, output: 200, cacheRead: 0, cacheCreation: 0 },
      },
    });

    const task = projectTasks(bb.read()).get('t1');
    expect(totalTokens(task!.tokens.totals)).toBe(5300);
    expect(task?.tokens.byModel['claude-opus-5']?.input).toBe(5000);
  });

  it('buckets tokens with no model under `unknown` rather than dropping them', () => {
    createTask('t1');
    bb.append({ type: 'crew.spawned', crewId: 'c1', taskId: 't1', cwd: '/wt/1' });
    bb.append({ type: 'crew.usage', crewId: 'c1', costUsd: 0, inputTokens: 7, outputTokens: 3 });

    const task = projectTasks(bb.read()).get('t1');
    expect(task?.tokens.byModel[UNKNOWN_MODEL]).toMatchObject({ input: 7, output: 3 });
  });

  it('reports a task as unmetered unless its Crew was spawned with an API key', () => {
    // The flag decides whether anything downstream may call `listPriceUsd`
    // spend. An event written before the flag existed reads as false, which
    // errs toward calling a list-price equivalent what it is.
    createTask('t1');
    createTask('t2', 'Second');
    bb.append({ type: 'crew.spawned', crewId: 'c1', taskId: 't1', cwd: '/wt/1' });
    bb.append({ type: 'crew.spawned', crewId: 'c2', taskId: 't2', cwd: '/wt/2', metered: true });

    const tasks = projectTasks(bb.read());
    expect(tasks.get('t1')?.metered).toBe(false);
    expect(tasks.get('t2')?.metered).toBe(true);
  });

  it('latches metering ON across rework, because that money was really spent', () => {
    createTask('t1');
    bb.append({ type: 'crew.spawned', crewId: 'c1', taskId: 't1', cwd: '/wt/1', metered: true });
    bb.append({ type: 'crew.spawned', crewId: 'c2', taskId: 't1', cwd: '/wt/1', metered: false });

    expect(projectTasks(bb.read()).get('t1')?.metered).toBe(true);
  });

  it('projectUsage answers for the whole fleet, and only calls it metered if everything was', () => {
    createTask('t1');
    createTask('t2', 'Second');
    bb.append({ type: 'crew.spawned', crewId: 'c1', taskId: 't1', cwd: '/wt/1', metered: true });
    bb.append({ type: 'crew.spawned', crewId: 'c2', taskId: 't2', cwd: '/wt/2' });
    bb.append({
      type: 'crew.usage',
      crewId: 'c1',
      costUsd: 0.1,
      inputTokens: 10,
      outputTokens: 5,
      model: 'claude-opus-5',
    });
    bb.append({
      type: 'crew.usage',
      crewId: 'c2',
      costUsd: 0.2,
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 1000,
      model: 'claude-sonnet-5',
    });

    const usage = projectUsage(bb.read());
    expect(usage.total).toBe(1040);
    expect(usage.byModel['claude-opus-5']).toMatchObject({ input: 10, output: 5 });
    expect(totalTokens(usage.byTask['t2']!.totals)).toBe(1025);
    // One subscription run in the fleet, so there is no single spend figure.
    expect(usage.metered).toBe(false);
    expect(usage.listPrice.totalUsd).toBeCloseTo(0.3, 10);
  });

  it('an empty log is not a metered fleet', () => {
    const usage = projectUsage([]);
    expect(usage.total).toBe(0);
    expect(usage.metered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

describe('decision projections', () => {
  it('orders open decisions longest-waiting first and drops resolved ones', () => {
    const tick = useClock();
    createTask('t1');

    const open = (id: string, question: string): void => {
      bb.append({
        type: 'decision.opened',
        decisionId: id,
        taskId: 't1',
        question,
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
        context: `context for ${id}`,
      });
    };

    tick();
    open('d1', 'Oldest?');
    tick();
    open('d2', 'Middle?');
    tick();
    open('d3', 'Newest?');
    tick();
    bb.append({
      type: 'decision.resolved',
      decisionId: 'd2',
      taskId: 't1',
      answer: 'yes',
    });

    const events = bb.read();
    const openDecisions = projectOpenDecisions(events);
    expect(openDecisions.map((d) => d.id)).toEqual(['d1', 'd3']);
    expect(openDecisions[0]?.openedAt).toBeLessThan(openDecisions[1]!.openedAt);
    expect(openDecisions[0]?.question).toBe('Oldest?');
    expect(openDecisions[0]?.context).toBe('context for d1');
    expect(openDecisions[0]?.options.map((o) => o.id)).toEqual(['yes', 'no']);
    expect(openDecisions.every((d) => d.resolvedAt === undefined)).toBe(true);

    const all = projectAllDecisions(events);
    expect(all.map((d) => d.id)).toEqual(['d1', 'd2', 'd3']);
    const resolved = all.find((d) => d.id === 'd2');
    expect(resolved?.answer).toBe('yes');
    expect(resolved?.resolvedAt).toBeGreaterThan(resolved!.openedAt);
  });

  it('keeps insertion order when decisions open within the same millisecond', () => {
    createTask('t1');
    for (const id of ['a', 'b', 'c']) {
      bb.append({
        type: 'decision.opened',
        decisionId: id,
        taskId: 't1',
        question: `q-${id}`,
        options: [],
      });
    }
    expect(projectOpenDecisions(bb.read()).map((d) => d.id)).toEqual(['a', 'b', 'c']);
    expect(projectOpenDecisions([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Crew log
// ---------------------------------------------------------------------------

describe('projectCrewLog', () => {
  it('returns every event for one crew, in seq order', () => {
    createTask('t1');
    bb.append({
      type: 'task.dispatched',
      taskId: 't1',
      crewId: 'c1',
      worktree: '/wt/1',
      permissionMode: 'auto',
    });
    // As the orchestrator writes it: a crew is a real session somewhere the
    // captain can go, and the attach command is stored because no later process
    // can derive it.
    bb.append({
      type: 'crew.spawned',
      crewId: 'c1',
      taskId: 't1',
      cwd: '/wt/1',
      sessionId: '11111111-2222-3333-4444-555555555555',
      attachCommand: 'tmux attach -t bluespace:=blue-11111111',
    });
    bb.append({ type: 'crew.text', crewId: 'c1', text: 'reading files' });
    bb.append({ type: 'crew.text', crewId: 'c2', text: 'different crew' });
    bb.append({
      type: 'crew.tool_use',
      crewId: 'c1',
      toolUseId: 'tu1',
      name: 'Edit',
      inputPreview: 'src/a.ts',
    });
    bb.append({ type: 'crew.exited', crewId: 'c1', ok: true });

    const log = projectCrewLog(bb.read(), 'c1');
    expect(log.map((e) => e.type)).toEqual([
      'task.dispatched',
      'crew.spawned',
      'crew.text',
      'crew.tool_use',
      'crew.exited',
    ]);
    expect(log.map((e) => e.seq)).toEqual([...log.map((e) => e.seq)].sort((a, b) => a - b));
    const spawned = log.find((e) => e.type === 'crew.spawned');
    expect(spawned?.type === 'crew.spawned' ? spawned.attachCommand : undefined).toBe(
      'tmux attach -t bluespace:=blue-11111111',
    );
    expect(projectCrewLog(bb.read(), 'nobody')).toEqual([]);
  });
});
