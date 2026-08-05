/**
 * Orchestrator tests — the engine's decisions, not its collaborators.
 *
 * Everything slow or non-deterministic is faked at a seam the orchestrator
 * already owns: a scripted HarnessAdapter, a stubbed WorktreeManager, and an
 * injected Sentinel. The Blackbox is REAL (in-memory SQLite), because the whole
 * point of the design is that task state is a projection over the log — asserting
 * against a fake log would be asserting against nothing.
 *
 * The fake sessions are queue-driven rather than timer-driven, so every test is
 * deterministic: push the events a Crew would emit, then await quiescence.
 *
 * The one collaborator that is NOT faked away is the filesystem. Worktree paths
 * and `dataDir` are real temp directories, because archiving a recon's report
 * out of a worktree is a real file copy — asserting it against a stub would
 * assert nothing about the data-loss bug it exists to close.
 */

import { mkdtempSync, rmSync, promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  AdapterCapabilities,
  AdapterEvent,
  Conversation,
  HarnessAdapter,
  Session,
  SpawnRequest,
} from '../src/adapters/types.js';
import { UnsupportedCapabilityError } from '../src/adapters/types.js';
import { Blackbox } from '../src/blackbox/index.js';
import type { BlueConfig, ProjectRegistry } from '../src/config/index.js';
import {
  Orchestrator,
  assertTransition,
  canTransition,
  pathTo,
  type SentinelRunner,
} from '../src/orchestrator/index.js';
import type { Project, Task, TaskState, Verdict } from '../src/types/domain.js';
import type { BlueEvent } from '../src/types/events.js';
import type { Worktree, WorktreeManager } from '../src/worktree/index.js';

// ---------------------------------------------------------------------------
// A fake harness
// ---------------------------------------------------------------------------

const ALL_CAPABILITIES: AdapterCapabilities = {
  interrupt: true,
  fork: true,
  cost: true,
  toolEvents: true,
  structuredOutput: true,
  steer: true,
  // The orchestrator only ever spawns workers; conversations are Helm's.
  conversation: false,
};

/**
 * A session whose event stream is a queue the test writes to.
 *
 * `events()` yields until it hands out an `exit`, exactly like a real turn, and
 * a later call resumes over whatever is still queued — which is what makes the
 * steer-the-same-session rework path testable.
 *
 * IT REFUSES A SECOND CONCURRENT CONSUMER, because both real adapters do and a
 * fake that did not would hide the difference. That is not hypothetical: the
 * orchestrator calls `events()` once per TURN, so a rework steer opens a second
 * stream — legal — while two overlapping pumps would race one transcript and
 * bill it twice — not legal, and caught here rather than in production.
 */
class FakeSession implements Session {
  readonly sent: string[] = [];

  /**
   * What `blue ps` prints. Shaped like the tmux backend's, since that is what
   * mints it. Undefined models a headless harness, which is a real difference
   * rather than a missing value.
   */
  readonly attachCommand: string | undefined;

  closed = false;

  interrupted = false;

  #queue: AdapterEvent[] = [];

  #wake: (() => void) | undefined;

  #streaming = false;

  constructor(
    readonly id: string,
    attachable = true,
  ) {
    this.attachCommand = attachable ? `tmux attach -t bluespace:=blue-${id}` : undefined;
  }

  push(...events: AdapterEvent[]): void {
    this.#queue.push(...events);
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  /** A whole Crew turn: some work, a cost, and an exit. */
  turn(opts: { text?: string; costUsd?: number; ok?: boolean; reason?: string } = {}): void {
    if (opts.text !== undefined) this.push({ type: 'text', text: opts.text });
    this.push({
      type: 'usage',
      costUsd: opts.costUsd ?? 0.01,
      inputTokens: 1000,
      outputTokens: 200,
      model: 'fake-model',
    });
    this.push({ type: 'exit', ok: opts.ok ?? true, reason: opts.reason });
  }

  events(): AsyncIterable<AdapterEvent> {
    if (this.#streaming) {
      throw new Error(`session "${this.id}" event stream is already being consumed`);
    }
    this.#streaming = true;
    return this.#drain();
  }

  async *#drain(): AsyncGenerator<AdapterEvent> {
    try {
      for (;;) {
        while (this.#queue.length > 0) {
          const next = this.#queue.shift();
          if (!next) break;
          yield next;
          if (next.type === 'exit') return;
        }
        if (this.closed) return;
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
      }
    } finally {
      this.#streaming = false;
    }
  }

  async send(message: string): Promise<void> {
    if (this.closed) throw new Error('session is closed');
    this.sent.push(message);
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  async close(): Promise<void> {
    this.closed = true;
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }
}

class FakeAdapter implements HarnessAdapter {
  readonly name = 'fake';

  capabilities: AdapterCapabilities = { ...ALL_CAPABILITIES };

  readonly spawns: Array<{ request: SpawnRequest; session: FakeSession }> = [];

  /** Set to model an adapter whose runs are nowhere a human can attach. */
  headless = false;

  async spawn(request: SpawnRequest): Promise<Session> {
    const session = new FakeSession(`sess-${this.spawns.length + 1}`, !this.headless);
    this.spawns.push({ request, session });
    return session;
  }

  /** Declared unsupported above, so the contract says this must refuse. */
  async converse(): Promise<Conversation> {
    throw new UnsupportedCapabilityError(this.name, 'conversation');
  }

  /** The most recent Crew spawned into a given task's worktree. */
  crewFor(taskId: string): FakeSession {
    const match = [...this.spawns].reverse().find((s) => s.request.cwd === worktreePath(taskId));
    if (!match) throw new Error(`no crew spawned for task ${taskId}`);
    return match.session;
  }

  spawnCountFor(taskId: string): number {
    return this.spawns.filter((s) => s.request.cwd === worktreePath(taskId)).length;
  }
}

// ---------------------------------------------------------------------------
// A stubbed worktree manager
// ---------------------------------------------------------------------------

/** One temp tree for the whole file: worktrees on the left, `dataDir` on the right. */
const TMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'bluespace-orch-'));
const DATA_DIR = path.join(TMP_ROOT, 'data');

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

function worktreePath(taskId: string): string {
  return path.join(TMP_ROOT, 'worktrees', taskId);
}

class FakeWorktrees {
  readonly created: Worktree[] = [];

  readonly removed: Array<{ worktree: Worktree; force: boolean }> = [];

  diffText = 'diff --git a/src/auth.ts b/src/auth.ts\n+export function login() {}\n';

  constructor(readonly repoPath: string) {}

  async create(taskId: string): Promise<Worktree> {
    const worktree: Worktree = {
      path: worktreePath(taskId),
      branch: `blue/${taskId.slice(0, 8)}`,
      repoPath: this.repoPath,
      taskId,
    };
    // A real directory, because a Crew writes into one and reclamation deletes
    // one; a path that never existed would let a broken archive step pass.
    await fsp.mkdir(worktree.path, { recursive: true });
    this.created.push(worktree);
    return worktree;
  }

  async remove(worktree: Worktree, opts?: { force?: boolean }): Promise<void> {
    this.removed.push({ worktree, force: opts?.force ?? false });
    await fsp.rm(worktree.path, { recursive: true, force: true });
  }

  async list(): Promise<Worktree[]> {
    return [...this.created];
  }

  async diff(): Promise<string> {
    return this.diffText;
  }

  async hasUncommittedChanges(): Promise<boolean> {
    return false;
  }

  async hasUnlandedCommits(): Promise<boolean> {
    return true;
  }

  async defaultBranch(): Promise<string> {
    return 'main';
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface VerdictSpec {
  pass: boolean;
  unmet?: string[];
  reasoning?: string;
  costUsd?: number;
}

interface Harness {
  bb: Blackbox;
  orch: Orchestrator;
  adapter: FakeAdapter;
  worktrees: FakeWorktrees;
  project: Project;
  /** Verdicts handed out in order; the last one repeats once exhausted. */
  verdicts: VerdictSpec[];
  sentinelRuns: Array<{ taskId: string; diff: string; cwd: string }>;
  errors: Array<{ scope: string; err: unknown }>;
}

const PROJECT: Project = {
  id: 'proj-demo',
  name: 'demo',
  path: '/repos/demo',
  description: 'A demo repository',
  delivery: 'local',
  addedAt: 1_700_000_000_000,
};

function fakeRegistry(projects: Project[]): ProjectRegistry {
  return {
    list: () => [...projects],
    get: (id: string) => projects.find((p) => p.id === id),
    add: () => {
      throw new Error('registry.add is not used by the orchestrator');
    },
    remove: () => {
      throw new Error('registry.remove is not used by the orchestrator');
    },
    resolve: (hint: string) => projects.filter((p) => p.name.includes(hint)),
  } as unknown as ProjectRegistry;
}

let open: Harness | undefined;

function harness(
  config: Partial<BlueConfig> = {},
  project: Partial<Project> = {},
): Harness {
  const bb = Blackbox.open(':memory:');
  const adapter = new FakeAdapter();
  const merged: Project = { ...PROJECT, ...project };
  const worktrees = new FakeWorktrees(merged.path);
  const verdicts: VerdictSpec[] = [];
  const sentinelRuns: Harness['sentinelRuns'] = [];
  const errors: Harness['errors'] = [];

  const sentinel: SentinelRunner = async ({ task, diff, cwd }) => {
    sentinelRuns.push({ taskId: task.id, diff, cwd });
    const spec = verdicts.length > 1 ? verdicts.shift() : verdicts[0];
    const resolved: VerdictSpec = spec ?? { pass: true };
    const verdict: Verdict = {
      id: `verdict-${sentinelRuns.length}`,
      taskId: task.id,
      pass: resolved.pass,
      reasoning: resolved.reasoning ?? (resolved.pass ? 'Satisfies the brief.' : 'Falls short.'),
      unmet: resolved.unmet ?? (resolved.pass ? [] : ['the brief asked for tests']),
      createdAt: Date.now(),
      costUsd: resolved.costUsd ?? 0.02,
    };
    return verdict;
  };

  const orch = new Orchestrator({
    blackbox: bb,
    adapter,
    config: {
      // `auto` is the default posture now: it edits and runs commands unattended
      // with no dialog and no machine-wide config write. See types/domain.ts.
      permissionMode: 'auto',
      maxBudgetUsdPerTask: 25,
      maxConcurrentCrew: 4,
      maxRework: 2,
      dataDir: DATA_DIR,
      ...config,
    },
    registry: fakeRegistry([merged]),
    worktreeFor: (repoPath: string) => {
      expect(repoPath).toBe(merged.path);
      return worktrees as unknown as WorktreeManager;
    },
    sentinel,
    onError: (scope, err) => errors.push({ scope, err }),
  });

  open = { bb, orch, adapter, worktrees, project: merged, verdicts, sentinelRuns, errors };
  return open;
}

afterEach(() => {
  open?.bb.close();
  open = undefined;
});

function newTask(h: Harness, overrides: Partial<Parameters<Orchestrator['createTask']>[0]> = {}): Task {
  return h.orch.createTask({
    kind: 'mission',
    projectId: h.project.id,
    title: 'Add login',
    brief: 'Add a login endpoint with tests.',
    ...overrides,
  });
}

function stateOf(h: Harness, id: string): TaskState {
  const task = h.orch.task(id);
  if (!task) throw new Error(`task ${id} vanished`);
  return task.state;
}

/** What `task.completed` recorded as the deliverable, if the task got that far. */
function completionOf(
  h: Harness,
  id: string,
): { artifact?: string; summary: string } | undefined {
  const event = h.bb
    .read()
    .find((e: BlueEvent) => e.type === 'task.completed' && e.taskId === id);
  return event !== undefined && event.type === 'task.completed'
    ? { artifact: event.artifact, summary: event.summary }
    : undefined;
}

function artifactOf(h: Harness, id: string): string | undefined {
  return completionOf(h, id)?.artifact;
}

function summaryOf(h: Harness, id: string): string {
  return completionOf(h, id)?.summary ?? '';
}

/** The recorded state path, which is the audit trail the whole design promises. */
function statePath(h: Harness, id: string): string[] {
  return h.bb
    .read()
    .filter((e: BlueEvent) => e.type === 'task.state_changed' && e.taskId === id)
    .map((e) => (e.type === 'task.state_changed' ? e.to : ''));
}

/**
 * Wait for a condition rather than for global quiescence.
 *
 * `whenIdle()` waits on every live crew, so it deadlocks whenever a test leaves
 * one deliberately mid-turn. These cases wait on the thing they actually care
 * about instead.
 */
async function until(check: () => boolean, label: string, tries = 500): Promise<void> {
  for (let i = 0; i < tries; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`condition never held: ${label}`);
}

function eventTypes(h: Harness, id: string): string[] {
  return h.bb
    .read()
    .filter((e: BlueEvent) => 'taskId' in e && e.taskId === id)
    .map((e) => e.type);
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe('state machine', () => {
  it('permits only the declared edges', () => {
    expect(canTransition('queued', 'dispatched')).toBe(true);
    expect(canTransition('queued', 'working')).toBe(false);
    expect(canTransition('verifying', 'needs_rework')).toBe(true);
    expect(canTransition('verifying', 'cancelled')).toBe(false);
    expect(canTransition('ready', 'landed')).toBe(true);
    expect(canTransition('landed', 'working')).toBe(false);
    expect(() => assertTransition('landed', 'working')).toThrow(/illegal task transition/);
  });

  it('routes multi-hop moves along legal edges only', () => {
    // No verifying -> awaiting_decision edge exists; the engine walks there.
    expect(pathTo('verifying', 'awaiting_decision')).toEqual([
      'needs_rework',
      'working',
      'awaiting_decision',
    ]);
    expect(pathTo('working', 'cancelled')).toEqual(['cancelled']);
    expect(pathTo('working', 'working')).toEqual([]);
    // A verified diff can only land or fail — cancellation is genuinely unreachable.
    expect(pathTo('ready', 'cancelled')).toBeUndefined();
    expect(pathTo('landed', 'working')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe('dispatch', () => {
  it('holds a task until every dependency has landed', async () => {
    const h = harness();
    const first = newTask(h, { title: 'Schema migration' });
    const second = newTask(h, { title: 'Use the new schema', dependsOn: [first.id] });

    await h.orch.tick();

    expect(h.adapter.spawns).toHaveLength(1);
    expect(stateOf(h, first.id)).toBe('working');
    expect(stateOf(h, second.id)).toBe('queued');

    // Ticking again must not sneak the dependent task out.
    await h.orch.tick();
    expect(h.adapter.spawns).toHaveLength(1);

    h.adapter.crewFor(first.id).turn();
    await h.orch.whenIdle();
    expect(stateOf(h, first.id)).toBe('landed');

    await h.orch.tick();
    expect(stateOf(h, second.id)).toBe('working');
    expect(h.adapter.spawnCountFor(second.id)).toBe(1);
  });

  it('fails a task whose dependency can never land', async () => {
    const h = harness();
    const blocker = newTask(h, { title: 'Blocker' });
    const dependent = newTask(h, { title: 'Dependent', dependsOn: [blocker.id] });

    await h.orch.tick();
    await h.orch.cancelTask(blocker.id);
    await h.orch.tick();

    expect(stateOf(h, blocker.id)).toBe('cancelled');
    expect(stateOf(h, dependent.id)).toBe('failed');
    expect(eventTypes(h, dependent.id)).toContain('task.failed');
  });

  it('never exceeds maxConcurrentCrew', async () => {
    const h = harness({ maxConcurrentCrew: 2 });
    const tasks = [newTask(h), newTask(h), newTask(h), newTask(h)];

    await h.orch.tick();
    await h.orch.tick();

    expect(h.adapter.spawns).toHaveLength(2);
    expect(tasks.filter((t) => stateOf(h, t.id) === 'working')).toHaveLength(2);
    expect(tasks.filter((t) => stateOf(h, t.id) === 'queued')).toHaveLength(2);

    // Freeing one slot admits exactly one more. (The other crew is still mid-turn,
    // so this waits on the task that finished, not on the whole fleet.)
    const running = tasks.filter((t) => stateOf(h, t.id) === 'working');
    const firstRunning = running[0];
    expect(firstRunning).toBeDefined();
    h.adapter.crewFor(firstRunning!.id).turn();
    await until(() => stateOf(h, firstRunning!.id) === 'landed', 'first crew lands');
    await h.orch.tick();

    expect(h.adapter.spawns).toHaveLength(3);
    expect(tasks.filter((t) => stateOf(h, t.id) === 'queued')).toHaveLength(1);
  });

  it('lets a project override the global permission mode', async () => {
    const h = harness({ permissionMode: 'auto' }, { permissionMode: 'plan' });
    newTask(h);
    await h.orch.tick();

    const spawn = h.adapter.spawns[0];
    expect(spawn).toBeDefined();
    expect(spawn!.request.profile.permissionMode).toBe('plan');
    expect(spawn!.request.cwd).toBe(h.worktrees.created[0]!.path);
    expect(spawn!.request.profile.maxBudgetUsd).toBe(25);
  });

  it('records where to attach to the Crew it just started', async () => {
    const h = harness();
    const task = newTask(h);

    await h.orch.tick();

    const spawned = h.bb
      .read()
      .find((e: BlueEvent) => e.type === 'crew.spawned' && e.taskId === task.id);
    expect(spawned?.type).toBe('crew.spawned');
    // A live Session cannot be projected, so if the attach command is not
    // written down at spawn, `blue ps` — a different process — can never learn
    // it, and the captain has no way to take over a worker that is stuck.
    if (spawned?.type === 'crew.spawned') {
      expect(spawned.attachCommand).toBe(h.adapter.crewFor(task.id).attachCommand);
      expect(spawned.sessionId).toBe(h.adapter.crewFor(task.id).id);
    }
  });

  it('leaves the attach command undefined for a headless harness', async () => {
    const h = harness();
    // An adapter whose workers are not somewhere a human can reach reports no
    // attach command; recording an empty string would put an unrunnable line in
    // front of the captain.
    h.adapter.headless = true;
    const task = newTask(h);

    await h.orch.tick();

    const spawned = h.bb
      .read()
      .find((e: BlueEvent) => e.type === 'crew.spawned' && e.taskId === task.id);
    if (spawned?.type === 'crew.spawned') expect(spawned.attachCommand).toBeUndefined();
  });

  it('fails the task instead of the engine when a worktree cannot be cut', async () => {
    const h = harness();
    h.worktrees.create = async () => {
      throw new Error('fatal: not a git repository');
    };
    const task = newTask(h);

    await h.orch.tick();

    expect(stateOf(h, task.id)).toBe('failed');
    expect(statePath(h, task.id)).toEqual(['dispatched', 'failed']);
  });
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('a mission that works', () => {
  it('runs queued -> landed and records every hop', async () => {
    const h = harness();
    const task = newTask(h);

    await h.orch.tick();
    const crew = h.adapter.crewFor(task.id);
    crew.push({ type: 'tool_use', toolUseId: 't1', name: 'Edit', input: { path: 'a.ts' } });
    crew.push({ type: 'tool_result', toolUseId: 't1', ok: true, result: 'ok' });
    crew.turn({ text: 'Done: added the endpoint and tests.', costUsd: 0.5 });
    await h.orch.whenIdle();

    expect(stateOf(h, task.id)).toBe('landed');
    expect(statePath(h, task.id)).toEqual([
      'dispatched',
      'working',
      'verifying',
      'ready',
      'landed',
    ]);

    const types = eventTypes(h, task.id);
    expect(types).toContain('task.dispatched');
    expect(types).toContain('sentinel.started');
    expect(types).toContain('sentinel.verdict');
    expect(types).toContain('task.completed');

    // The Sentinel saw the diff and never the Crew's reasoning.
    expect(h.sentinelRuns).toHaveLength(1);
    expect(h.sentinelRuns[0]!.diff).toBe(h.worktrees.diffText);

    // Crew cost plus verification cost, billed to the task.
    expect(h.orch.task(task.id)!.costUsd).toBeCloseTo(0.52, 5);

    // A landed task keeps its worktree: the branch is the deliverable.
    expect(h.worktrees.removed).toHaveLength(0);
    expect(crew.closed).toBe(true);
  });

  /**
   * The recon report used to be recorded as a path INSIDE the worktree, which
   * made it both unreclaimable (untracked, so the worktree is dirty forever) and
   * destroyable (anything that forced the worktree away took the only copy).
   * Archiving it out is what makes reclaiming a recon worktree safe at all.
   */
  it('archives a recon report out of the worktree before teardown', async () => {
    const h = harness();
    const task = newTask(h, { kind: 'recon', title: 'Why is startup slow?' });

    await h.orch.tick();
    const report = '# Why startup is slow\n\nThe registry is read twice.\n';
    await fsp.writeFile(path.join(worktreePath(task.id), 'REPORT.md'), report);
    h.adapter.crewFor(task.id).turn({ text: 'Wrote REPORT.md' });
    await h.orch.whenIdle();

    expect(stateOf(h, task.id)).toBe('landed');
    expect(h.sentinelRuns).toHaveLength(0);

    const archived = path.join(DATA_DIR, 'reports', `${task.id}.md`);
    expect(artifactOf(h, task.id)).toBe(archived);
    expect(await fsp.readFile(archived, 'utf8')).toBe(report);

    // And it survives reclamation: the whole point of copying it out.
    await h.worktrees.remove(h.worktrees.created[0]!, { force: true });
    expect(await fsp.readFile(archived, 'utf8')).toBe(report);
  });

  it('lands a recon that wrote no report, and says so instead of failing', async () => {
    const h = harness();
    const task = newTask(h, { kind: 'recon', title: 'Anything to find here?' });

    await h.orch.tick();
    h.adapter.crewFor(task.id).turn({ text: 'Nothing to report.' });
    await h.orch.whenIdle();

    expect(stateOf(h, task.id)).toBe('landed');
    expect(artifactOf(h, task.id)).toBeUndefined();
    expect(summaryOf(h, task.id)).toContain('without writing a report');
    expect(h.errors).toEqual([]);
  });

  it('fails a task whose Crew exits badly', async () => {
    const h = harness();
    const task = newTask(h);

    await h.orch.tick();
    h.adapter.crewFor(task.id).turn({ ok: false, reason: 'process exited with code 1' });
    await h.orch.whenIdle();

    expect(stateOf(h, task.id)).toBe('failed');
    expect(h.sentinelRuns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Rework
// ---------------------------------------------------------------------------

describe('rework', () => {
  it('steers the same Crew back to work after a failing verdict', async () => {
    const h = harness({ maxRework: 2 });
    h.verdicts.push({ pass: false, unmet: ['no tests for the failure path'] }, { pass: true });
    const task = newTask(h);

    await h.orch.tick();
    const crew = h.adapter.crewFor(task.id);
    crew.turn(); // first attempt -> rejected
    crew.turn(); // second attempt, after the steer -> accepted
    await h.orch.whenIdle();

    expect(stateOf(h, task.id)).toBe('landed');
    expect(statePath(h, task.id)).toEqual([
      'dispatched',
      'working',
      'verifying',
      'needs_rework',
      'working',
      'verifying',
      'ready',
      'landed',
    ]);

    // Same session, not a cold restart: the Crew keeps its context.
    expect(h.adapter.spawnCountFor(task.id)).toBe(1);
    expect(crew.sent).toHaveLength(1);
    expect(crew.sent[0]).toContain('no tests for the failure path');
    expect(crew.sent[0]).toContain('REWORK REQUIRED');
    expect(h.orch.task(task.id)!.reworkCount).toBe(1);
    expect(h.sentinelRuns).toHaveLength(2);
  });

  it('cold-starts a replacement Crew when the session is gone', async () => {
    const h = harness({ maxRework: 2 });
    h.verdicts.push({ pass: false, unmet: ['missing migration'] }, { pass: true });
    const task = newTask(h);

    await h.orch.tick();
    const first = h.adapter.crewFor(task.id);
    // A session that refuses to be steered is indistinguishable from a dead one.
    first.send = async () => {
      throw new Error('session already ended');
    };
    first.turn();
    await until(() => h.adapter.spawnCountFor(task.id) === 2, 'a replacement crew is spawned');

    const replacement = h.adapter.crewFor(task.id);
    expect(replacement).not.toBe(first);
    // THE OUTGOING CREW IS CLOSED, NOT JUST DROPPED. A throw from send() is not
    // proof the worker died — a transient backend failure raises it against a
    // Crew that is alive and mid-turn. Leaking the handle would leave that
    // worker spending tokens nothing reads or bills, in the same worktree the
    // replacement is now editing.
    expect(first.closed, 'the replaced crew was left running').toBe(true);
    // The replacement is briefed on the same worktree, with the gap spelled out.
    const respawn = h.adapter.spawns[1];
    expect(respawn!.request.cwd).toBe(worktreePath(task.id));
    expect(respawn!.request.prompt).toContain('missing migration');
    expect(h.worktrees.created).toHaveLength(1);

    replacement.turn();
    await until(() => stateOf(h, task.id) === 'landed', 'the replacement lands the task');
    expect(h.sentinelRuns).toHaveLength(2);
  });

  it('opens a decision instead of retrying forever', async () => {
    const h = harness({ maxRework: 1 });
    h.verdicts.push({ pass: false, unmet: ['the endpoint still 500s on bad input'] });
    const task = newTask(h);

    await h.orch.tick();
    const crew = h.adapter.crewFor(task.id);
    crew.turn(); // rejected -> one rework allowed
    crew.turn(); // rejected again -> budget spent
    await h.orch.whenIdle();

    expect(stateOf(h, task.id)).toBe('awaiting_decision');
    expect(h.sentinelRuns).toHaveLength(2);

    const decisions = h.orch.openDecisions();
    expect(decisions).toHaveLength(1);
    const decision = decisions[0]!;
    expect(decision.taskId).toBe(task.id);
    expect(decision.question).toMatch(/rejected this work 2 times/);
    expect(decision.options.map((o) => o.id)).toContain('abandon');
    expect(decision.context).toContain('the endpoint still 500s on bad input');

    // It walked there legally rather than teleporting.
    expect(statePath(h, task.id).slice(-3)).toEqual([
      'needs_rework',
      'working',
      'awaiting_decision',
    ]);

    // And it is not still burning money.
    expect(h.adapter.spawnCountFor(task.id)).toBe(1);
  });

  it('gives the Crew a fresh allowance once the captain has weighed in', async () => {
    const h = harness({ maxRework: 1 });
    h.verdicts.push({ pass: false, unmet: ['still no tests'] });
    const task = newTask(h);

    await h.orch.tick();
    const crew = h.adapter.crewFor(task.id);
    crew.turn();
    crew.turn();
    await h.orch.whenIdle();

    const decision = h.orch.openDecisions()[0]!;
    h.verdicts.length = 0;
    h.verdicts.push({ pass: true });
    await h.orch.resolveDecision(decision.id, 'Ship it without the integration test.');

    expect(stateOf(h, task.id)).toBe('working');
    expect(crew.sent.at(-1)).toContain('Ship it without the integration test.');
    expect(h.orch.openDecisions()).toHaveLength(0);

    crew.turn();
    await h.orch.whenIdle();
    expect(stateOf(h, task.id)).toBe('landed');
  });

  it('lets the captain abandon a task from the inbox', async () => {
    const h = harness({ maxRework: 0 });
    h.verdicts.push({ pass: false });
    const task = newTask(h);

    await h.orch.tick();
    h.adapter.crewFor(task.id).turn();
    await h.orch.whenIdle();

    const decision = h.orch.openDecisions()[0]!;
    await h.orch.resolveDecision(decision.id, 'abandon');

    expect(stateOf(h, task.id)).toBe('failed');
    expect(eventTypes(h, task.id)).toContain('task.failed');
  });

  /**
   * `blue inbox` is a different process from the one running the fleet, so its
   * Orchestrator projects the same log but holds no live sessions. It used to
   * record the answer anyway and then fail the task with `crew_lost` — the inbox
   * printed "✓ answered" and killed a healthy task in the same breath, while the
   * real Crew went on running in the other process. A second Orchestrator over
   * the same Blackbox is exactly that situation.
   */
  it('refuses to answer a decision from a process that holds no Crew, and changes nothing', async () => {
    const h = harness();
    const task = newTask(h);

    await h.orch.tick();
    const crew = h.adapter.crewFor(task.id);
    crew.push({ type: 'text', text: 'NEEDS-DECISION: Drop the column?\n- Drop it\n- Keep it' });
    await until(() => stateOf(h, task.id) === 'awaiting_decision', 'the task parks on the decision');

    const decision = h.orch.openDecisions()[0]!;
    const before = h.bb.read().length;

    const elsewhere = new Orchestrator({
      blackbox: h.bb,
      adapter: h.adapter,
      config: { permissionMode: 'auto', maxBudgetUsdPerTask: 25, maxConcurrentCrew: 4, maxRework: 2, dataDir: DATA_DIR },
      registry: fakeRegistry([h.project]),
      worktreeFor: () => h.worktrees as unknown as WorktreeManager,
    });

    await expect(elsewhere.resolveDecision(decision.id, 'left')).rejects.toThrow(
      /no Crew running in this process/,
    );

    // Nothing was written, so the decision is still answerable where it can be
    // delivered, and the task is still exactly where the Crew left it.
    expect(h.bb.read().length).toBe(before);
    expect(stateOf(h, task.id)).toBe('awaiting_decision');
    expect(h.orch.openDecisions().map((d) => d.id)).toContain(decision.id);

    // The process that does hold the Crew still answers it.
    await h.orch.resolveDecision(decision.id, 'Drop it');
    expect(stateOf(h, task.id)).toBe('working');
    expect(crew.sent.at(-1)).toContain('Drop it');
  });
});

// ---------------------------------------------------------------------------
// Decisions raised by a Crew
// ---------------------------------------------------------------------------

describe('crew escalation', () => {
  it('parks a task on NEEDS-DECISION and resumes it with the answer', async () => {
    const h = harness();
    const task = newTask(h);

    await h.orch.tick();
    const crew = h.adapter.crewFor(task.id);
    crew.turn({
      text: [
        'The schema has a legacy `email_verified` column nothing reads.',
        'NEEDS-DECISION: Should the migration drop the legacy column?',
        '- Drop it now, in this migration',
        '- Keep it nullable for one release',
      ].join('\n'),
    });
    await h.orch.whenIdle();

    expect(stateOf(h, task.id)).toBe('awaiting_decision');
    const decision = h.orch.openDecisions()[0]!;
    expect(decision.question).toBe('Should the migration drop the legacy column?');
    expect(decision.options.map((o) => o.label)).toEqual([
      'Drop it now, in this migration',
      'Keep it nullable for one release',
    ]);
    expect(decision.context).toContain('legacy `email_verified` column');

    // Verification must NOT have run: the task never finished working.
    expect(h.sentinelRuns).toHaveLength(0);

    await h.orch.resolveDecision(decision.id, 'Keep it nullable for one release');
    expect(stateOf(h, task.id)).toBe('working');
    expect(crew.sent[0]).toContain('Keep it nullable for one release');

    crew.turn();
    await h.orch.whenIdle();
    expect(stateOf(h, task.id)).toBe('landed');
  });

  it('ignores the marker once a task is no longer working', async () => {
    const h = harness();
    const task = newTask(h);

    await h.orch.tick();
    const crew = h.adapter.crewFor(task.id);
    crew.push({ type: 'text', text: 'NEEDS-DECISION: first question?' });
    crew.push({ type: 'text', text: 'NEEDS-DECISION: second question?' });
    crew.push({ type: 'exit', ok: true });
    await h.orch.whenIdle();

    expect(h.orch.openDecisions()).toHaveLength(1);
    expect(h.orch.openDecisions()[0]!.question).toBe('first question?');
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('cancelTask', () => {
  it('stops the Crew, cancels the task, and tears the worktree down', async () => {
    const h = harness();
    const task = newTask(h);

    await h.orch.tick();
    const crew = h.adapter.crewFor(task.id);

    await h.orch.cancelTask(task.id);

    expect(stateOf(h, task.id)).toBe('cancelled');
    expect(crew.interrupted).toBe(true);
    expect(crew.closed).toBe(true);
    expect(h.worktrees.removed).toHaveLength(1);
    expect(h.worktrees.removed[0]!.force).toBe(true);
    expect(h.worktrees.removed[0]!.worktree.taskId).toBe(task.id);

    // The pump must unwind without resurrecting the task.
    await h.orch.whenIdle();
    expect(stateOf(h, task.id)).toBe('cancelled');
    expect(h.sentinelRuns).toHaveLength(0);
  });

  it('is a no-op on a task that already finished', async () => {
    const h = harness();
    const task = newTask(h);

    await h.orch.tick();
    h.adapter.crewFor(task.id).turn();
    await h.orch.whenIdle();
    expect(stateOf(h, task.id)).toBe('landed');

    await h.orch.cancelTask(task.id);
    expect(stateOf(h, task.id)).toBe('landed');
    expect(h.worktrees.removed).toHaveLength(0);
  });

  it('cancels a queued task that never spawned anything', async () => {
    const h = harness({ maxConcurrentCrew: 0 });
    const task = newTask(h);

    await h.orch.tick();
    expect(stateOf(h, task.id)).toBe('queued');

    await h.orch.cancelTask(task.id);
    expect(stateOf(h, task.id)).toBe('cancelled');
    expect(h.adapter.spawns).toHaveLength(0);
  });

  /**
   * Cancellation is the only place that deletes a worktree without asking, so
   * it is the only place that can destroy a recon's report. Archiving on the
   * landed path alone left exactly this hole: a recon that wrote its report and
   * was then cancelled lost it, with nothing recorded anywhere.
   */
  it('rescues a recon report before destroying its worktree', async () => {
    const h = harness();
    const task = newTask(h, { kind: 'recon', title: 'What is in here?' });

    await h.orch.tick();
    const report = '# Findings\n\nThe cache is never invalidated.\n';
    await fsp.writeFile(path.join(worktreePath(task.id), 'REPORT.md'), report);

    await h.orch.cancelTask(task.id);

    expect(stateOf(h, task.id)).toBe('cancelled');
    expect(h.worktrees.removed).toHaveLength(1);
    expect(await fsp.readFile(path.join(DATA_DIR, 'reports', `${task.id}.md`), 'utf8')).toBe(report);
  });

  it('cancels a recon that wrote nothing without complaining about it', async () => {
    const h = harness();
    const task = newTask(h, { kind: 'recon', title: 'Nothing here' });

    await h.orch.tick();
    await h.orch.cancelTask(task.id);

    expect(stateOf(h, task.id)).toBe('cancelled');
    expect(h.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Steering and budget
// ---------------------------------------------------------------------------

describe('captain controls', () => {
  it('pushes a steer into the live session', async () => {
    const h = harness();
    const task = newTask(h);

    await h.orch.tick();
    await h.orch.steer(task.id, 'Use the existing HTTP client, not fetch.');

    expect(h.adapter.crewFor(task.id).sent).toEqual(['Use the existing HTTP client, not fetch.']);
    await expect(h.orch.steer('nope', 'hello')).rejects.toThrow(/no live crew/);
  });

  it('kills a task that blows its budget', async () => {
    const h = harness({ maxBudgetUsdPerTask: 1 });
    const task = newTask(h);

    await h.orch.tick();
    const crew = h.adapter.crewFor(task.id);
    crew.turn({ costUsd: 9.5 });
    await h.orch.whenIdle();

    expect(crew.interrupted).toBe(true);
    expect(stateOf(h, task.id)).toBe('failed');
    expect(h.sentinelRuns).toHaveLength(0);
    const failure = h.bb
      .read()
      .find((e: BlueEvent) => e.type === 'task.failed' && e.taskId === task.id);
    expect(failure && failure.type === 'task.failed' ? failure.reason : '').toContain(
      'budget_exceeded',
    );
  });

  it('kills the session outright when the budget interrupt fails', async () => {
    // The ceiling latches after one attempt, so a swallowed interrupt is a
    // ceiling that logs a line and stops nothing: the Crew keeps spending until
    // the turn timeout, hours later, with the captain told it was capped. This
    // turn NEVER emits an exit — reaching `failed` at all proves the escalation
    // ended the run rather than something downstream tidying up afterwards.
    const h = harness({ maxBudgetUsdPerTask: 1 });
    const task = newTask(h);

    await h.orch.tick();
    const crew = h.adapter.crewFor(task.id);
    crew.interrupt = async () => {
      throw new Error('tmux went away');
    };

    crew.push({ type: 'usage', costUsd: 9.5, inputTokens: 1000, outputTokens: 200 });
    await until(() => stateOf(h, task.id) === 'failed', 'the over-budget crew is stopped');

    expect(crew.closed, 'a failed interrupt left the crew running').toBe(true);
    const failure = h.bb
      .read()
      .find((e: BlueEvent) => e.type === 'task.failed' && e.taskId === task.id);
    expect(failure && failure.type === 'task.failed' ? failure.reason : '').toContain(
      'budget_exceeded',
    );
  });
});

// ---------------------------------------------------------------------------
// Engine plumbing
// ---------------------------------------------------------------------------

describe('the tick loop', () => {
  it('is safe to call concurrently', async () => {
    const h = harness({ maxConcurrentCrew: 4 });
    newTask(h);
    newTask(h);

    await Promise.all([h.orch.tick(), h.orch.tick(), h.orch.tick()]);

    // Overlapping ticks must not double-dispatch anything.
    expect(h.adapter.spawns).toHaveLength(2);
    expect(h.worktrees.created).toHaveLength(2);
  });

  it('start() schedules ticks without holding the process open, stop() ends them', async () => {
    const h = harness();
    const task = newTask(h);

    h.orch.start(1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    h.orch.stop();

    expect(stateOf(h, task.id)).toBe('working');

    const spawnsAfterStop = h.adapter.spawns.length;
    newTask(h);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.adapter.spawns).toHaveLength(spawnsAfterStop);
  });

  it('surfaces tick errors instead of dying on them', async () => {
    const h = harness();
    const task = newTask(h);
    h.adapter.spawn = async () => {
      throw new Error('harness unavailable');
    };

    await h.orch.tick();

    expect(stateOf(h, task.id)).toBe('failed');
    expect(h.errors.map((e) => e.scope).join()).toContain(`dispatch ${task.id}`);
  });
});
