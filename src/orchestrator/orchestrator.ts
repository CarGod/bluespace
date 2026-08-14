/**
 * The orchestrator — BlueSpace's engine room.
 *
 * THIS IS CODE, NOT AN AGENT. Dispatch order, concurrency, dependency gating,
 * retry, budget and teardown are decided by deterministic logic that can be
 * unit-tested and reasoned about, never by a model. The only model calls that
 * happen here go out through the injected `HarnessAdapter` (a Crew) or through
 * `runSentinel` (a verifier), and both of those are things the orchestrator
 * *commands*, not things that command it.
 *
 * Two invariants hold everywhere in this file:
 *
 *  1. A `Task` object is a READ MODEL. It is projected from the Blackbox on
 *     demand and thrown away. Nothing here caches a task and mutates it; if you
 *     want to know what state something is in, re-project it.
 *  2. Every state change goes through the state machine and lands in the log as
 *     a `task.state_changed` event. Where the target is more than one legal hop
 *     away, we walk the route and record every hop rather than adding an edge.
 *
 * The only mutable in-memory state is `#live`: the handle on a running Crew's
 * session (which cannot be projected from a log, because it is a socket, not a
 * fact) and the worktree we owe a teardown to.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  requireCapability,
  type AdapterEvent,
  type HarnessAdapter,
  type Session,
} from '../adapters/types.js';
import { CREW_SYSTEM_PROMPT, NEEDS_DECISION_MARKER, buildBrief } from '../agents/crew/index.js';
import { runSentinel } from '../agents/sentinel/index.js';
import { projectOpenDecisions, projectTask, projectTasks, type Blackbox } from '../blackbox/index.js';
import type { BlueConfig, ProjectRegistry } from '../config/index.js';
import type { FleetNotice } from '../notify/index.js';
import type { Worktree, WorktreeManager } from '../worktree/index.js';
import {
  isTerminal,
  totalTokens,
  type CrewId,
  type Decision,
  type DecisionId,
  type DecisionOption,
  type DispatchProfile,
  type Project,
  type ProjectId,
  type Task,
  type TaskId,
  type TaskKind,
  type TaskState,
  type TokenCounts,
  type Verdict,
} from '../types/domain.js';
import type { BlueEventBody } from '../types/events.js';
import { assertTransition, pathTo } from './statemachine.js';

// ---------------------------------------------------------------------------
// The Crew -> orchestrator control protocol
// ---------------------------------------------------------------------------

/**
 * The marker a Crew emits to escalate a choice to the captain.
 *
 * Re-exported from the brief builder rather than re-declared, because the brief
 * that teaches a Crew this string and the scanner that looks for it MUST be the
 * same string. Two constants that agree today are a bug scheduled for later.
 */
export const DECISION_MARKER = NEEDS_DECISION_MARKER;

/** Cap on stored tool input/result previews. The harness transcript keeps the rest. */
const PREVIEW_CHARS = 500;

/** Cap on the context we lift out of a Crew's message when opening a decision. */
const DECISION_CONTEXT_CHARS = 2000;

/** Option id that lets a captain end a task from the decision inbox. */
export const ABANDON_OPTION_ID = 'abandon';

/**
 * Cancelling a Crew this process does not hold.
 *
 * A named error rather than a bare `throw new Error`, because two callers have
 * to tell the captain something different about it: `blue cancel` can offer
 * `--force`, and Helm's `cancel_task` — which has no force and should not — must
 * report where the fleet actually is. The message carries the shared half.
 */
export class CrewNotHeldError extends Error {
  constructor(
    readonly taskId: TaskId,
    readonly crewId: CrewId,
  ) {
    super(
      `task ${taskId} has a Crew (${crewId}) that is not running in this process, so nothing here ` +
        `can stop it. Cancel it where the fleet is running — Helm's cancel_task in the Claude Code ` +
        `window serving \`blue mcp\`, or the Starmap started with \`blue map --orchestrate\`. ` +
        `Nothing was changed.`,
    );
    this.name = 'CrewNotHeldError';
  }
}

export interface DecisionRequest {
  question: string;
  options: DecisionOption[];
  context?: string;
}

/**
 * Parse a Crew message for an escalation.
 *
 * Shape:
 * ```
 *   NEEDS-DECISION: Should the migration drop the legacy column?
 *   - Drop it now, one migration
 *   - Keep it nullable for a release
 * ```
 * The question is the rest of the marker line (or the next non-empty line if the
 * marker line ends there). A bulleted or numbered block immediately below
 * becomes the options; anything before the marker becomes context, so the
 * captain can answer without opening the worktree.
 */
export function parseDecisionRequest(text: string): DecisionRequest | undefined {
  const lines = text.split(/\r?\n/);

  let markerLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trimStart().startsWith(DECISION_MARKER)) {
      markerLine = i;
      break;
    }
  }
  if (markerLine < 0) return undefined;

  const head = (lines[markerLine] ?? '').trimStart().slice(DECISION_MARKER.length).trim();
  const rest = lines.slice(markerLine + 1);

  let question = head;
  let cursor = 0;
  if (!question) {
    for (let i = 0; i < rest.length; i += 1) {
      const line = (rest[i] ?? '').trim();
      if (line) {
        question = line;
        cursor = i + 1;
        break;
      }
    }
  }
  if (!question) return undefined;

  const options: DecisionOption[] = [];
  const taken = new Set<string>();
  for (let i = cursor; i < rest.length; i += 1) {
    const line = (rest[i] ?? '').trim();
    if (!line) {
      if (options.length > 0) break;
      continue;
    }
    const bullet = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(line);
    if (!bullet) break;
    const label = (bullet[1] ?? '').trim();
    if (!label) continue;
    options.push({ id: optionId(label, options.length, taken), label });
  }

  const context = lines.slice(0, markerLine).join('\n').trim();
  const request: DecisionRequest = { question, options };
  if (context) request.context = truncate(context, DECISION_CONTEXT_CHARS);
  return request;
}

function optionId(label: string, index: number, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || `opt-${index + 1}`;
  let id = base;
  let n = 2;
  while (taken.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  taken.add(id);
  return id;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Signature of the verification step, so it can be swapped in tests. */
export type SentinelRunner = (input: {
  adapter: HarnessAdapter;
  task: Task;
  diff: string;
  cwd: string;
  profile: DispatchProfile;
}) => Promise<Verdict>;

export interface OrchestratorDeps {
  blackbox: Blackbox;
  adapter: HarnessAdapter;
  /**
   * The captain's settings, read fresh on every use.
   *
   * A FUNCTION, NOT A VALUE, and the difference cost three rounds of tasks. The
   * orchestrator used to be handed a snapshot taken when the process started, so
   * a captain who raised `maxTokensPerTask` after watching a task die to it
   * changed nothing at all: the loop that killed the next one was still reading
   * the number from before their edit, and the only way to deliver a setting was
   * to close the window that was running the work. Every read below is a fresh
   * one; `boot()` supplies a reader that re-reads the file, cheaply.
   *
   * A plain object is still accepted — every test passes one — and is simply a
   * setting that never changes.
   */
  config: BlueConfig | (() => BlueConfig);
  registry: ProjectRegistry;
  worktreeFor(projectPath: string): WorktreeManager;
  /**
   * Optional override for verification. Defaults to the real `runSentinel`.
   * This is the one place a model call is unavoidable in the middle of the
   * engine, so it is injectable — tests drive rework paths through it without
   * pretending to be a harness.
   */
  sentinel?: SentinelRunner;
  /** Optional diagnostics sink. Defaults to stderr. */
  onError?: (scope: string, err: unknown) => void;
  /**
   * Told when a task settles, so the captain can hear about it without being at
   * the screen.
   *
   * ABSENT BY DEFAULT, which is why every test is silent: only `boot()` supplies
   * one. It is called from inside the dispatch loop and must never throw or
   * block — see `src/notify`.
   */
  notify?: (notice: FleetNotice) => void;
}

/** The settings as of RIGHT NOW. Never store the result. */
function readConfig(source: BlueConfig | (() => BlueConfig)): BlueConfig {
  return typeof source === 'function' ? source() : source;
}

export interface CreateTaskInput {
  kind: TaskKind;
  projectId: ProjectId;
  title: string;
  brief: string;
  dependsOn?: TaskId[];
}

/**
 * A running Crew. Everything here is unprojectable — a live session handle and
 * the worktree we owe a teardown to — which is exactly why it is the only
 * in-memory state the orchestrator keeps.
 */
interface LiveCrew {
  taskId: TaskId;
  crewId: CrewId;
  session: Session;
  project: Project;
  worktree: Worktree;
  worktrees: WorktreeManager;
  baseBranch: string;
  /** True while a pump loop is draining this session; guards double-pumping. */
  pumping: boolean;
  /**
   * Why a ceiling stopped this task, in the captain's words — set once, by
   * `#enforceCeilings`, so `#afterExit` reports the stop honestly instead of
   * blaming the interrupt it had to send. Undefined while the task is within
   * its ceilings, which is also the latch that keeps the kill from firing twice.
   */
  ceilingBreach: string | undefined;
  /** Set by cancelTask so a racing pump does not resurrect the task. */
  closed: boolean;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator {
  readonly #deps: OrchestratorDeps;

  readonly #live = new Map<TaskId, LiveCrew>();

  /** In-flight background work (crew pumps, verifications). Used by whenIdle(). */
  readonly #inflight = new Set<Promise<unknown>>();

  #ticking = false;

  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
  }

  /**
   * Push one outcome at the captain, if this run has anywhere to push it.
   *
   * Only the three states that change what they would do next: work that is
   * finished and waiting to be looked at, work that died, and work that has
   * stopped dead until they answer something. Not `dispatched`, not
   * `needs_rework` — a fleet that interrupts on every hop is a fleet whose
   * notifications get turned off, and then the one that mattered is missed too.
   *
   * `cancelled` is deliberately absent: the captain is the only thing that
   * cancels a task, so telling them is telling them what they just did.
   */
  #announce(taskId: TaskId, to: TaskState, detail?: string): void {
    const notify = this.#deps.notify;
    if (notify === undefined) return;
    if (to !== 'landed' && to !== 'failed' && to !== 'awaiting_decision') return;
    const task = this.task(taskId);
    if (!task) return;

    let project = task.projectId;
    try {
      project = this.#deps.registry.get(task.projectId)?.name ?? task.projectId;
    } catch {
      // A registry that cannot answer costs the notification its project name,
      // never the notification.
    }
    const headline =
      to === 'landed'
        ? `Landed · ${project}`
        : to === 'failed'
          ? `Failed · ${project}`
          : `Needs you · ${project}`;
    // The title is DATA and goes in verbatim; `detail` is a reason string the
    // engine wrote, and it is the difference between "a task failed" and "a task
    // failed because it ran out of tokens".
    const body = detail !== undefined && detail !== '' ? `${task.title} — ${detail}` : task.title;
    try {
      notify({ title: headline, body: body.length > 240 ? `${body.slice(0, 239)}…` : body });
    } catch (err) {
      this.#log('notify', err);
    }
  }

  /**
   * The captain's settings as of right now.
   *
   * Every read goes through here and none of them keep the result. A ceiling
   * they raised at 22:20 has to bite the check that runs at 22:21, not the one
   * that ran when the process started.
   */
  #config(): BlueConfig {
    return readConfig(this.#deps.config);
  }

  // -- reads ---------------------------------------------------------------

  /** Every task ever created, oldest first. */
  tasks(): Task[] {
    return [...projectTasks(this.#deps.blackbox.read()).values()].sort(byCreation);
  }

  task(id: TaskId): Task | undefined {
    return projectTask(this.#deps.blackbox.read(), id);
  }

  openDecisions(): Decision[] {
    return projectOpenDecisions(this.#deps.blackbox.read());
  }

  // -- task creation -------------------------------------------------------

  createTask(input: CreateTaskInput): Task {
    const taskId = randomUUID();
    this.#deps.blackbox.append({
      type: 'task.created',
      taskId,
      kind: input.kind,
      projectId: input.projectId,
      title: input.title,
      brief: input.brief,
      dependsOn: [...(input.dependsOn ?? [])],
    });
    const task = this.task(taskId);
    if (!task) throw new Error(`blackbox did not project the task it just accepted (${taskId})`);
    return task;
  }

  // -- the engine ----------------------------------------------------------

  /**
   * One pass of the engine: dispatch whatever is legally dispatchable.
   *
   * Idempotent and safe to call concurrently — a second caller while a tick is
   * in flight returns immediately rather than double-dispatching, because the
   * dispatch decision is made from a projection that the in-flight tick has not
   * finished writing to yet.
   *
   * Everything after dispatch (draining a Crew, verifying, rework) happens on
   * background pumps, not here; a tick never blocks on a model.
   */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      await this.#dispatchPass();
    } catch (err) {
      this.#log('tick', err);
    } finally {
      this.#ticking = false;
    }
  }

  start(intervalMs = 2000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    // Never hold the process open: the fleet is a background service, not a
    // reason for `blue` to refuse to exit.
    this.#timer.unref?.();
  }

  stop(): void {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Resolve once no crew pump or verification is in flight.
   *
   * "In flight" includes a Crew that is still thinking, so this only returns
   * when the whole fleet is quiet. A task parked in `awaiting_decision` does NOT
   * count as busy: its pump has stopped, it is waiting on a human, and no amount
   * of waiting here will produce one.
   *
   * Not part of the engine's contract with the fleet — it exists so a CLI can
   * block until the fleet settles, and so tests are deterministic rather than
   * timing-based.
   */
  async whenIdle(): Promise<void> {
    while (this.#inflight.size > 0) {
      await Promise.allSettled([...this.#inflight]);
    }
  }

  // -- captain controls ----------------------------------------------------

  /**
   * Answer an open decision: record it, unblock the task, and hand the answer
   * to the Crew that asked.
   *
   * The answer reaches the SAME session where possible, so the Crew keeps every
   * bit of context it built before it stopped to ask.
   *
   * REFUSES when this process is not the one holding that Crew. `#live` is
   * per-process and unprojectable, so a `blue` invocation that never dispatched
   * anything — `blue inbox`, a view-only `blue map` — has no session to deliver
   * into and no way to reach the one that does. It used to record the answer
   * anyway and then fail the task with `crew_lost`, which meant the inbox
   * printed "✓ answered" and killed a healthy task in the same breath. Throwing
   * before anything is appended leaves the decision open, so it can still be
   * answered from the process that owns the fleet. `steer()` has always refused
   * the same way; this is that rule applied to the other half of the protocol.
   */
  async resolveDecision(id: DecisionId, answer: string): Promise<void> {
    const decision = projectOpenDecisions(this.#deps.blackbox.read()).find((d) => d.id === id);
    if (!decision) throw new Error(`decision ${id} is not open`);

    const taskId = decision.taskId;

    // Abandoning needs no session — it stops the task rather than talking to it,
    // and it is the captain's way out when the Crew really is gone.
    const abandoning =
      answer.trim().toLowerCase() === ABANDON_OPTION_ID &&
      decision.options.some((o) => o.id === ABANDON_OPTION_ID);

    const current = this.task(taskId);
    if (!abandoning && current && !isTerminal(current.state) && !this.#live.has(taskId)) {
      throw new Error(
        `cannot deliver this answer: task ${taskId} has no Crew running in this process. ` +
          `Answer it where the fleet is running — Helm's answer_decision in the Claude Code ` +
          `window serving \`blue mcp\`, or the Starmap started with \`blue map --orchestrate\`. ` +
          `If that process is gone the Crew went with it, and the task has to be cancelled.`,
      );
    }

    this.#deps.blackbox.append({
      type: 'decision.resolved',
      decisionId: id,
      taskId,
      answer,
    });

    // An explicit abandon option is the captain's exit hatch out of a task that
    // has already proven it cannot converge. Only honoured when the decision
    // actually offered it.
    if (abandoning) {
      await this.#teardown(taskId, { removeWorktree: false });
      this.#failTask(taskId, 'abandoned_by_captain');
      return;
    }

    const task = this.task(taskId);
    if (!task || isTerminal(task.state)) return;
    if (task.state === 'awaiting_decision') {
      this.#setState(taskId, 'working', 'decision_resolved');
    }

    const message = [
      `CAPTAIN'S ANSWER to "${decision.question}":`,
      '',
      answer.trim(),
      '',
      'Proceed on that basis. Do not ask again unless something new comes up.',
    ].join('\n');

    await this.#deliver(taskId, message, 'decision_answer');
  }

  /** Push a message into a live Crew session. */
  async steer(taskId: TaskId, message: string): Promise<void> {
    const live = this.#live.get(taskId);
    if (!live || live.closed) throw new Error(`task ${taskId} has no live crew to steer`);
    requireCapability(this.#deps.adapter, 'steer');
    await live.session.send(message);
    this.#pump(live);
  }

  /**
   * Stop a task and reclaim everything it holds.
   *
   * Cancellation is not always one hop away (`verifying` has to retreat through
   * `needs_rework` first) and from `ready` it is not reachable at all — a
   * verified diff can only land or fail. In that last case the task is failed
   * with a cancellation reason rather than silently ignored.
   *
   * REFUSES when this process is not the one holding that Crew, for the same
   * reason `resolveDecision` and `steer` do: `#live` is per-process and
   * unprojectable, so a `blue` that never dispatched anything has no session to
   * interrupt and no way to reach the one that does. Without this guard a cold
   * `blue cancel` wrote `cancelled` into the log and stopped there — the Crew
   * kept running in its tmux session, kept spending quota against a task nobody
   * was waiting on, and its worktree stayed on disk with `blue ps` reporting the
   * whole thing as over. A half-cancelled task is worse than an uncancellable
   * one, because only one of them is visible.
   *
   * A task with no `crewId` is exempt: nothing was ever spawned for it, so
   * cancelling is a pure log write and every process can do it correctly. That
   * covers the common case of a queued task the captain changed their mind about.
   *
   * `force` is the captain's own hands, and it does exactly one thing: record
   * the cancellation. It cannot stop a Crew it does not hold and does not touch
   * the worktree — callers must say so rather than implying a teardown happened.
   * Helm has no way to pass it; `blue cancel --force` does.
   */
  async cancelTask(id: TaskId, opts: { force?: boolean } = {}): Promise<void> {
    const task = this.task(id);
    if (!task) throw new Error(`unknown task ${id}`);
    if (isTerminal(task.state)) return;

    if (opts.force !== true && task.crewId !== undefined && !this.#live.has(id)) {
      throw new CrewNotHeldError(id, task.crewId);
    }

    await this.#teardown(id, { removeWorktree: true });

    if (!this.#walkTo(id, 'cancelled', 'cancelled_by_captain')) {
      this.#failTask(id, 'cancelled_by_captain');
    }
  }

  /** True when this process holds the live session for that task. */
  holdsCrew(id: TaskId): boolean {
    return this.#live.has(id);
  }

  // -----------------------------------------------------------------------
  // Dispatch
  // -----------------------------------------------------------------------

  async #dispatchPass(): Promise<void> {
    const tasks = projectTasks(this.#deps.blackbox.read());
    const all = [...tasks.values()];

    // 'dispatched' counts: it means "a crew is being stood up for this task",
    // and a worktree is already being cut. Not counting it would let a slow
    // spawn blow straight through the concurrency cap.
    let inFlight = all.filter((t) => t.state === 'dispatched' || t.state === 'working').length;
    const cap = this.#config().maxConcurrentCrew;

    for (const task of all.filter((t) => t.state === 'queued').sort(byCreation)) {
      const deps = this.#dependencyStatus(task, tasks);
      if (deps === 'broken') {
        // A dependency that will never land makes this task undispatchable
        // forever. Say so now instead of leaving it queued for eternity.
        this.#failTask(task.id, 'dependency_failed');
        continue;
      }
      if (deps === 'waiting') continue;
      if (inFlight >= cap) break;
      inFlight += 1;
      await this.#dispatch(task);
    }
  }

  #dependencyStatus(task: Task, tasks: Map<TaskId, Task>): 'ready' | 'waiting' | 'broken' {
    let waiting = false;
    for (const depId of task.dependsOn) {
      const dep = tasks.get(depId);
      if (!dep) {
        // Unknown id: it may be created later in the same plan. Wait, do not fail.
        waiting = true;
        continue;
      }
      if (dep.state === 'landed') continue;
      if (dep.state === 'failed' || dep.state === 'cancelled') return 'broken';
      waiting = true;
    }
    return waiting ? 'waiting' : 'ready';
  }

  async #dispatch(task: Task): Promise<void> {
    const project = this.#deps.registry.get(task.projectId);
    if (!project) {
      this.#failTask(task.id, `unknown_project:${task.projectId}`);
      return;
    }

    // Enter 'dispatched' BEFORE any of the slow, failure-prone setup, so a
    // worktree that will not cut or a harness that will not start is a
    // dispatched task that failed — not a queued task the engine retries
    // forever at tick speed.
    this.#setState(task.id, 'dispatched', 'dispatch');

    try {
      const worktrees = this.#deps.worktreeFor(project.path);
      const worktree = await worktrees.create(task.id);
      const baseBranch = project.defaultBranch ?? (await worktrees.defaultBranch());
      const brief = buildBrief({ task, project, worktree, baseBranch });

      const { session, crewId } = await this.#spawnCrew({
        task,
        project,
        worktree,
        prompt: brief,
      });

      const live: LiveCrew = {
        taskId: task.id,
        crewId,
        session,
        project,
        worktree,
        worktrees,
        baseBranch,
        pumping: false,
        ceilingBreach: undefined,
        closed: false,
      };
      this.#live.set(task.id, live);

      this.#setState(task.id, 'working', 'crew_started');
      this.#pump(live);
    } catch (err) {
      this.#log(`dispatch ${task.id}`, err);
      this.#failTask(task.id, `dispatch_failed: ${errorText(err)}`);
    }
  }

  /**
   * Start a Crew against a worktree and record the dispatch.
   *
   * Used both for a first dispatch and for a cold restart after a lost session.
   * It deliberately touches neither task state nor the live map: the legal
   * transition differs between those cases, and that call belongs to the caller.
   */
  async #spawnCrew(input: {
    task: Task;
    project: Project;
    worktree: Worktree;
    prompt: string;
  }): Promise<{ session: Session; crewId: CrewId }> {
    const { task, project, worktree, prompt } = input;
    const profile = this.#profileFor(project);
    const crewId = randomUUID();

    const session = await this.#deps.adapter.spawn({
      cwd: worktree.path,
      prompt,
      profile,
      systemPromptAppend: CREW_SYSTEM_PROMPT,
      // The repo's conventions, not the captain's. `project` resolves against
      // cwd — the worktree — so this is the checked-in CLAUDE.md, rules and
      // skills of the code being edited. `user` is withheld: those hooks and
      // settings were written for an interactive session, and firing them once
      // per Crew is both wrong and, for anything that blocks, a hang.
      settingScopes: ['project'],
    });

    this.#deps.blackbox.appendMany([
      {
        type: 'task.dispatched',
        taskId: task.id,
        crewId,
        worktree: worktree.path,
        model: profile.model,
        effort: profile.effort,
        permissionMode: profile.permissionMode,
      },
      {
        type: 'crew.spawned',
        crewId,
        taskId: task.id,
        sessionId: session.id,
        cwd: worktree.path,
        // The one fact about a Crew that only exists in this process. A live
        // `Session` cannot be projected, so `blue ps` and the Starmap — separate
        // processes with nothing but the log — can only learn where to attach if
        // we write it down at spawn. Undefined for a headless adapter.
        attachCommand: session.attachCommand,
        // Whether this run's tokens are billed per token, recorded WITH the run
        // rather than looked up when someone reads the log. A captain who
        // exports an API key next week must not retroactively turn this week's
        // subscription tasks into spend, and one who unsets it must not turn
        // real charges into "free". See `HarnessAdapter.metered`.
        metered: this.#metered(),
      },
    ]);

    return { session, crewId };
  }

  /** Project override beats global config; the rest comes straight from config. */
  #profileFor(project: Project): DispatchProfile {
    const cfg = this.#config();
    const profile: DispatchProfile = {
      permissionMode: project.permissionMode ?? cfg.permissionMode,
    };
    if (cfg.model !== undefined) profile.model = cfg.model;
    if (cfg.effort !== undefined) profile.effort = cfg.effort;
    if (cfg.maxTokensPerTask > 0) profile.maxTokens = cfg.maxTokensPerTask;
    // Stated for an adapter that can enforce it; on a subscription it is not
    // even a meaningful number, which is why `#enforceCeilings` only acts on it
    // for a metered run.
    if (cfg.maxBudgetUsdPerTask > 0) profile.maxBudgetUsd = cfg.maxBudgetUsdPerTask;
    return profile;
  }

  /**
   * Is a run launched by this fleet billed per token?
   *
   * Asked of the adapter rather than of `process.env`, because the adapter is
   * what knows the environment its workers actually get (a long-lived tmux
   * server does not inherit this process's). An adapter that declares nothing is
   * treated as unmetered: see `HarnessAdapter.metered`.
   */
  #metered(): boolean {
    return this.#deps.adapter.metered === true;
  }

  // -----------------------------------------------------------------------
  // Pumping a live Crew
  // -----------------------------------------------------------------------

  /**
   * Drain a Crew's event stream in the background, then decide what happens
   * next. Loops while the decision is "keep this Crew going" (a rework steer,
   * a cold restart), so one pump covers a task's whole working life.
   *
   * EACH PASS OF THE LOOP IS ONE TURN, and calls `session.events()` again for
   * the next one. That is the contract a steerable adapter owes: `send()` starts
   * a fresh turn in a session that outlived the last one, and a stream the
   * caller cannot re-open is a turn nobody watches — no usage, no exit, a task
   * left in `working` forever. Adapters refuse a second CONCURRENT consumer,
   * which is why only this loop ever calls it.
   */
  #pump(live: LiveCrew): void {
    if (live.pumping || live.closed) return;
    live.pumping = true;

    const work = (async () => {
      try {
        for (;;) {
          const exit = await this.#consume(live);
          const next = await this.#afterExit(live, exit);
          if (next !== 'continue') break;
        }
      } catch (err) {
        this.#log(`pump ${live.taskId}`, err);
        this.#failTask(live.taskId, `crew_pump_failed: ${errorText(err)}`);
      } finally {
        live.pumping = false;
      }
    })();

    this.#track(work);
  }

  /** Mirror one turn's events into the Blackbox. Returns how that turn ended. */
  async #consume(live: LiveCrew): Promise<ExitEvent> {
    const bb = this.#deps.blackbox;
    let exit: ExitEvent | undefined;

    try {
      for await (const event of live.session.events()) {
        const crewId = live.crewId;
        switch (event.type) {
          case 'session':
            // Already recorded on crew.spawned; a duplicate would just be noise.
            break;

          case 'text':
            bb.append({ type: 'crew.text', crewId, text: event.text });
            this.#maybeOpenDecision(live, event.text);
            break;

          case 'thinking':
            bb.append({ type: 'crew.thinking', crewId });
            break;

          case 'tool_use':
            bb.append({
              type: 'crew.tool_use',
              crewId,
              toolUseId: event.toolUseId,
              name: event.name,
              inputPreview: preview(event.input),
            });
            break;

          case 'tool_result':
            bb.append({
              type: 'crew.tool_result',
              crewId,
              toolUseId: event.toolUseId,
              ok: event.ok,
              resultPreview:
                event.result === undefined ? undefined : truncate(event.result, PREVIEW_CHARS),
            });
            break;

          case 'usage':
            bb.append({
              type: 'crew.usage',
              crewId,
              costUsd: event.costUsd,
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              cacheReadTokens: event.cacheReadTokens,
              cacheCreationTokens: event.cacheCreationTokens,
              model: event.model,
            });
            this.#enforceCeilings(live);
            break;

          case 'exit':
            bb.append({
              type: 'crew.exited',
              crewId,
              ok: event.ok,
              interrupted: event.interrupted,
              reason: event.reason,
            });
            exit = event;
            break;
        }
      }
    } catch (err) {
      // A stream that dies mid-run is a failed run, not a crashed orchestrator.
      this.#log(`crew stream ${live.taskId}`, err);
      const failed: ExitEvent = { type: 'exit', ok: false, reason: errorText(err) };
      bb.append({ type: 'crew.exited', crewId: live.crewId, ok: false, reason: failed.reason });
      return failed;
    }

    if (!exit) {
      // A stream that ends without saying how is treated as a completed turn;
      // the diff is the source of truth about what was actually done.
      exit = { type: 'exit', ok: true, reason: 'stream_ended' };
      this.#deps.blackbox.append({
        type: 'crew.exited',
        crewId: live.crewId,
        ok: true,
        reason: 'stream_ended',
      });
    }
    return exit;
  }

  /**
   * A Crew stopped. Decide what the fleet does about it.
   *
   * Returns 'continue' when the same pump should keep draining (the Crew was
   * steered back to work), 'stop' when this task is done with this pump.
   */
  async #afterExit(live: LiveCrew, exit: ExitEvent): Promise<'continue' | 'stop'> {
    const taskId = live.taskId;
    const task = this.task(taskId);
    if (!task || isTerminal(task.state) || live.closed) return 'stop';

    // Blocked on a human: keep the session warm so the answer lands in the same
    // context, and stop pumping until resolveDecision() wakes it.
    if (task.state === 'awaiting_decision') return 'stop';

    if (live.ceilingBreach !== undefined) {
      await this.#teardown(taskId, { removeWorktree: false });
      this.#failTask(taskId, live.ceilingBreach);
      return 'stop';
    }

    if (!exit.ok) {
      await this.#teardown(taskId, { removeWorktree: false });
      this.#failTask(taskId, exit.reason ? `crew_failed: ${exit.reason}` : 'crew_failed');
      return 'stop';
    }

    this.#setState(taskId, 'verifying', 'crew_finished');

    // Recon produces a report, not a diff. A diff-reading verifier has nothing
    // to read here, and running one anyway would reject every recon task.
    if (task.kind === 'recon') {
      // The report is copied OUT of the worktree first, and the archived path is
      // what gets recorded — see #archiveReport. Undefined artifact is a real
      // answer here: a recon that wrote nothing still landed.
      const archived = await this.#archiveReport(taskId, live.worktree.path);
      this.#complete(taskId, {
        summary: archived.summary,
        artifact: archived.artifact,
        reason: 'recon_reported',
      });
      await this.#teardown(taskId, { removeWorktree: false });
      return 'stop';
    }

    const verdict = await this.#verify(live, task);
    if (!verdict) return 'stop';

    // Cancellation can land while the Sentinel is thinking.
    const afterVerify = this.task(taskId);
    if (!afterVerify || isTerminal(afterVerify.state) || live.closed) return 'stop';

    if (verdict.pass) {
      this.#complete(taskId, {
        summary: verdict.reasoning,
        artifact: live.worktree.branch,
        reason: 'sentinel_passed',
      });
      await this.#teardown(taskId, { removeWorktree: false });
      return 'stop';
    }

    return await this.#rework(live, verdict);
  }

  /** Run verification, recording the attempt before it starts so a hang is visible. */
  async #verify(live: LiveCrew, task: Task): Promise<Verdict | undefined> {
    const verdictId = randomUUID();
    try {
      const diff = await live.worktrees.diff(live.worktree);
      this.#deps.blackbox.append({ type: 'sentinel.started', taskId: task.id, verdictId });

      const run = this.#deps.sentinel ?? runSentinel;
      const verdict = await run({
        adapter: this.#deps.adapter,
        task,
        diff,
        cwd: live.worktree.path,
        profile: this.#profileFor(live.project),
      });

      this.#deps.blackbox.append({
        type: 'sentinel.verdict',
        taskId: task.id,
        // The log pairs started/verdict on OUR id: the verifier's own id is
        // internal to a run we might never see the end of.
        verdictId,
        pass: verdict.pass,
        reasoning: verdict.reasoning,
        unmet: [...verdict.unmet],
        // Both, and in that order of importance: the tokens are what the
        // verification actually consumed and what the task's ceiling counts,
        // the dollars are `src/pricing`'s equivalent of them.
        tokensByModel: { ...verdict.tokens.byModel },
        costUsd: verdict.listPriceUsd,
      });
      return verdict;
    } catch (err) {
      this.#log(`verify ${task.id}`, err);
      await this.#teardown(task.id, { removeWorktree: false });
      this.#failTask(task.id, `verification_failed: ${errorText(err)}`);
      return undefined;
    }
  }

  /**
   * A verdict came back failing. Send the Crew back to work, or hand the
   * problem to the captain once retrying has stopped being useful.
   */
  async #rework(live: LiveCrew, verdict: Verdict): Promise<'continue' | 'stop'> {
    const taskId = live.taskId;
    const attempts = this.#failedAttempts(taskId);

    if (attempts > this.#config().maxRework) {
      // Out of retries. Failing here would throw away a mostly-working diff and
      // tell the captain nothing; the honest move is to put it in the inbox.
      // There is no verifying -> awaiting_decision edge, so this walks the legal
      // route (needs_rework -> working -> awaiting_decision) and records each hop.
      if (!this.#walkTo(taskId, 'awaiting_decision', 'rework_exhausted')) {
        this.#failTask(taskId, 'rework_exhausted');
        return 'stop';
      }
      this.#deps.blackbox.append({
        type: 'decision.opened',
        decisionId: randomUUID(),
        taskId,
        question: `Verification has rejected this work ${attempts} times. How should the fleet proceed?`,
        options: [
          {
            id: 'guide',
            label: 'Send guidance and let the Crew try again',
            detail: 'Reply with what the Sentinel keeps missing, or what to do differently.',
          },
          {
            id: ABANDON_OPTION_ID,
            label: 'Abandon this task',
            detail: 'Stop work. The worktree is kept so nothing is lost.',
          },
        ],
        context: [
          `Sentinel: ${verdict.reasoning}`,
          '',
          'Still unmet:',
          ...verdict.unmet.map((u) => `- ${u}`),
        ].join('\n'),
      });
      return 'stop';
    }

    this.#setState(taskId, 'needs_rework', 'sentinel_failed');
    const message = reworkMessage(verdict);

    // Steering the SAME session is both cheaper and better: the Crew still has
    // the repository, the plan, and every dead end it already ruled out. A cold
    // restart pays for all of that again and often re-walks it.
    if (this.#deps.adapter.capabilities.steer && !live.closed) {
      try {
        await live.session.send(message);
        this.#setState(taskId, 'working', 'rework_steered');
        return 'continue';
      } catch (err) {
        this.#log(`rework steer ${taskId}`, err);
      }
    }

    // Session gone: bring up a fresh Crew on the same worktree, with the unmet
    // requirements folded into its brief so it starts where the last one stopped.
    try {
      await this.#restart(live, message);
      this.#setState(taskId, 'working', 'rework_respawned');
      // The replacement crew inherits this pump; only one may drain a task.
      return 'continue';
    } catch (err) {
      this.#log(`rework respawn ${taskId}`, err);
      this.#failTask(taskId, `rework_respawn_failed: ${errorText(err)}`);
      return 'stop';
    }
  }

  /**
   * Failed verifications charged against the retry budget.
   *
   * Counted since the last decision the captain resolved for this task: once a
   * human has weighed in, the Crew deserves a fresh allowance rather than
   * bouncing straight back into the inbox it just came out of.
   */
  #failedAttempts(taskId: TaskId): number {
    const events = this.#deps.blackbox.read();
    let since = 0;
    for (const e of events) {
      if (e.type === 'decision.resolved' && e.taskId === taskId && e.seq > since) since = e.seq;
    }
    let attempts = 0;
    for (const e of events) {
      if (e.type === 'sentinel.verdict' && e.taskId === taskId && !e.pass && e.seq > since) {
        attempts += 1;
      }
    }
    return attempts;
  }

  // -----------------------------------------------------------------------
  // Decisions raised by a Crew
  // -----------------------------------------------------------------------

  #maybeOpenDecision(live: LiveCrew, text: string): void {
    if (!text.includes(DECISION_MARKER)) return;
    const request = parseDecisionRequest(text);
    if (!request) return;

    const task = this.task(live.taskId);
    if (!task || task.state !== 'working') return;

    this.#deps.blackbox.append({
      type: 'decision.opened',
      decisionId: randomUUID(),
      taskId: live.taskId,
      question: request.question,
      options: request.options,
      context: request.context,
    });
    this.#setState(live.taskId, 'awaiting_decision', 'crew_requested_decision');
  }

  /**
   * Get a message to a task's Crew, restarting it cold if the session is gone.
   *
   * Only ever called for a task this process holds — callers check first — so
   * reaching the `!live` branch means the crew was torn down underneath us,
   * which is a genuine loss rather than the cross-process case above.
   */
  async #deliver(taskId: TaskId, message: string, reason: string): Promise<void> {
    const live = this.#live.get(taskId);
    if (live && !live.closed && this.#deps.adapter.capabilities.steer) {
      try {
        await live.session.send(message);
        this.#pump(live);
        return;
      } catch (err) {
        this.#log(`deliver ${taskId}`, err);
      }
    }

    if (!live) {
      this.#failTask(taskId, `crew_lost: cannot deliver ${reason}`);
      return;
    }

    try {
      await this.#restart(live, message);
      this.#pump(live);
    } catch (err) {
      this.#log(`respawn ${taskId}`, err);
      this.#failTask(taskId, `respawn_failed: ${errorText(err)}`);
    }
  }

  /**
   * Replace a task's Crew with a fresh one on the SAME worktree, carrying
   * `addendum` (a rework verdict, a captain's answer) at the end of the brief.
   *
   * The worktree survives the swap, so a cold restart loses the Crew's reasoning
   * but never its work.
   *
   * THE OUTGOING SESSION IS CLOSED FIRST, and that ordering is not tidiness.
   * A restart happens because `send()` threw, and a throw from `send()` is not
   * proof the worker is dead — a transient tmux failure raises it against a
   * Crew that is alive and mid-turn. Dropping the handle instead of closing it
   * would leave that worker running with nobody reading its transcript: real
   * tokens spent that no `crew.usage` event records and no budget ceiling can
   * see, a window the reaper cannot attribute, and — worst of the three — two
   * Crews editing one worktree.
   */
  async #restart(live: LiveCrew, addendum: string): Promise<void> {
    const task = this.task(live.taskId);
    if (!task) throw new Error(`unknown task ${live.taskId}`);

    const prompt = `${buildBrief({
      task,
      project: live.project,
      worktree: live.worktree,
      baseBranch: live.baseBranch,
    })}\n\n---\n\n${addendum}`;

    // Best-effort: a session that is genuinely gone throws here, and that is
    // the common case rather than the exception.
    try {
      await live.session.close();
    } catch (err) {
      this.#log(`restart close ${live.taskId}`, err);
    }

    const { session, crewId } = await this.#spawnCrew({
      task,
      project: live.project,
      worktree: live.worktree,
      prompt,
    });

    live.session = session;
    live.crewId = crewId;
    live.closed = false;
    this.#live.set(live.taskId, live);
  }

  // -----------------------------------------------------------------------
  // Ceilings
  // -----------------------------------------------------------------------

  /**
   * THE ONLY CONSUMPTION CEILING THAT EXISTS. It used to be the second of two.
   *
   * `DispatchProfile.maxTokens` / `maxBudgetUsd` are still threaded to the
   * adapter, and an adapter that can enforce a per-run ceiling still should —
   * but the one BlueSpace runs on cannot: an interactive Claude Code session has
   * no `--max-turns`, and `--max-budget-usd` only works with `--print`, which is
   * the non-interactive mode `docs/compliance.md` forbids. So the belt is gone
   * and this is the braces.
   *
   * TWO CEILINGS, AND WHICH ONE APPLIES IS NOT A PREFERENCE:
   *
   *   `maxTokensPerTask` is checked on EVERY run. Tokens are what the transcript
   *   reports, so this ceiling is measured rather than modelled, and it is the
   *   only one that means anything on the default path — a Claude subscription,
   *   where tokens draw down a quota and no dollar figure exists to bound.
   *
   *   `maxBudgetUsdPerTask` is checked ONLY when the run is metered (an
   *   `ANTHROPIC_API_KEY` is in play). There it bounds real money and is exactly
   *   as accurate as `src/pricing`'s table. On a subscription it is deliberately
   *   not enforced: killing a task over an invoice nobody will ever send is a
   *   ceiling denominated in fiction, and the config loader says so in words
   *   rather than leaving the setting to look effective.
   *
   * When both apply, WHICHEVER TRIPS FIRST STOPS THE TASK — they are independent
   * bounds on the same run, not a pair to reconcile, and the failure names the
   * one that fired so the captain knows which number to change.
   *
   * The shape of the check is the thing to understand rather than tidy: it fires
   * on a `usage` event, and usage arrives when a message completes, so a ceiling
   * is crossed BEFORE it is noticed. A task can overshoot by roughly one message
   * — and, for a Crew that delegates, by whatever its subagents spent during the
   * turn, since those land at the end of the turn (see
   * `src/adapters/claude-cli.ts`, header 7). It is a ceiling with overshoot, not
   * a hard stop, and calling it anything else would be a lie the captain pays
   * for.
   *
   * WHAT IT MAY NOT DO IS FAIL QUIETLY. `ceilingBreach` latches, so this runs
   * once per task; if the one interrupt it sends is swallowed, nothing tries
   * again and the Crew keeps spending until the turn timeout hours later —
   * a ceiling that logged a line and stopped nothing. So a failed interrupt
   * escalates to closing the session outright, which the wait loop sees
   * immediately.
   */
  #enforceCeilings(live: LiveCrew): void {
    if (live.ceilingBreach !== undefined) return;
    const cfg = this.#config();
    const task = this.task(live.taskId);
    if (!task) return;

    const used = totalTokens(task.tokens.totals);
    let breach: string | undefined;
    if (cfg.maxTokensPerTask > 0 && used > cfg.maxTokensPerTask) {
      breach =
        `token_ceiling_exceeded: task used ${used.toLocaleString('en-US')} tokens ` +
        `(${describeByModel(task.tokens.byModel)}), past the ` +
        `${cfg.maxTokensPerTask.toLocaleString('en-US')} maxTokensPerTask ceiling`;
    } else if (
      this.#metered() &&
      cfg.maxBudgetUsdPerTask > 0 &&
      task.listPriceUsd > cfg.maxBudgetUsdPerTask
    ) {
      breach =
        `budget_exceeded: metered run passed the $${cfg.maxBudgetUsdPerTask} ` +
        `maxBudgetUsdPerTask ceiling ($${task.listPriceUsd.toFixed(2)} at list price, ` +
        `${used.toLocaleString('en-US')} tokens)`;
    }
    if (breach === undefined) return;

    live.ceilingBreach = breach;
    this.#track(
      (async () => {
        try {
          if (this.#deps.adapter.capabilities.interrupt) {
            await live.session.interrupt();
            return;
          }
        } catch (err) {
          this.#log(`ceiling interrupt ${live.taskId}`, err);
        }
        // Either the adapter cannot interrupt, or the interrupt failed. Killing
        // the session is the blunter instrument and the only one left; the
        // stream still drains and the exit is still reported honestly, because
        // `ceilingBreach` is what `#afterExit` reads, not the exit reason.
        try {
          await live.session.close();
        } catch (err) {
          this.#log(`ceiling close ${live.taskId}`, err);
        }
      })(),
    );
  }

  // -----------------------------------------------------------------------
  // State transitions — the only places task state moves
  // -----------------------------------------------------------------------

  #setState(taskId: TaskId, to: TaskState, reason?: string): void {
    const task = this.task(taskId);
    if (!task) throw new Error(`unknown task ${taskId}`);
    if (task.state === to) return;
    assertTransition(task.state, to, taskId);
    this.#deps.blackbox.append(stateChange(taskId, task.state, to, reason));
  }

  /**
   * Move a task to `to` along a legal route, recording every hop.
   *
   * Returns false when no route exists, which is a real answer rather than an
   * error: `ready -> cancelled` genuinely does not exist, and callers decide
   * what to do about that.
   */
  #walkTo(taskId: TaskId, to: TaskState, reason: string): boolean {
    const task = this.task(taskId);
    if (!task) return false;
    const route = pathTo(task.state, to);
    if (!route) return false;

    let from = task.state;
    const bodies: BlueEventBody[] = [];
    for (const hop of route) {
      bodies.push(stateChange(taskId, from, hop, reason));
      from = hop;
    }
    if (bodies.length > 0) this.#deps.blackbox.appendMany(bodies);
    this.#announce(taskId, to, reason);
    return true;
  }

  /** ready -> landed plus the completion record, written as one batch. */
  #complete(taskId: TaskId, input: { summary: string; artifact?: string; reason: string }): void {
    if (!this.#walkTo(taskId, 'ready', input.reason)) {
      this.#failTask(taskId, `cannot_complete_from_state: ${input.reason}`);
      return;
    }
    this.#deps.blackbox.appendMany([
      {
        type: 'task.completed',
        taskId,
        artifact: input.artifact,
        summary: input.summary,
      },
      stateChange(taskId, 'ready', 'landed', input.reason),
    ]);
    this.#announce(taskId, 'landed', input.summary);
  }

  #failTask(taskId: TaskId, reason: string): void {
    const task = this.task(taskId);
    if (!task || isTerminal(task.state)) return;
    this.#walkTo(taskId, 'failed', reason);
    this.#deps.blackbox.append({ type: 'task.failed', taskId, reason });
  }

  // -----------------------------------------------------------------------
  // Recon reports
  // -----------------------------------------------------------------------

  /**
   * Copy a recon's report OUT of the worktree, before anything can reclaim it.
   *
   * A recon's whole deliverable is `REPORT.md` inside a disposable directory,
   * and that had two consequences, both bad. The report is usually untracked, so
   * `git status --porcelain` never empties and the worktree can never satisfy
   * the safe-reclaim rule — recon worktrees were precisely the ones that piled
   * up. And anything that force-reclaimed one destroyed the only artifact the
   * task produced. Archiving to `<dataDir>/reports/<taskId>.md` fixes both: the
   * captain's copy lives outside the worktree, and the worktree is then holding
   * nothing irreplaceable.
   *
   * Never throws. A recon that wrote nothing is a real (if disappointing)
   * outcome, not a failed task — so what actually happened goes into the
   * completion summary, which is in the Blackbox forever, rather than into an
   * exception that would flip a finished task to `failed`.
   */
  async #archiveReport(
    taskId: TaskId,
    worktreePath: string,
  ): Promise<{ summary: string; artifact?: string }> {
    const source = reportPath(worktreePath);
    const target = path.join(this.#config().dataDir, 'reports', reportFileName(taskId));

    try {
      const body = await fs.readFile(source);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body);
      return {
        summary: `Recon complete. The report is archived at ${target}.`,
        artifact: target,
      };
    } catch (err) {
      if (isNotFound(err)) {
        return {
          summary:
            `Recon finished without writing a report — nothing was found at ${source}. ` +
            `Whatever the Crew learned is only in its transcript.`,
        };
      }
      // Archiving failed for some other reason (permissions, a full disk). The
      // in-worktree copy is then the only one there is, so point at it and say
      // so; a captain who is told the report is archived when it is not will
      // find that out at exactly the wrong moment.
      this.#log(`archive report ${taskId}`, err);
      return {
        summary:
          `Recon complete, but the report could not be archived (${errorText(err)}). ` +
          `It is still in the worktree at ${source}, which nothing will reclaim while it is dirty.`,
        artifact: source,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------

  /**
   * Release everything a task holds: the session first (so nothing is writing
   * into a directory we are about to delete), then optionally the worktree.
   *
   * A landed task keeps its worktree — the branch it built is the deliverable,
   * and deleting it at the moment it succeeded would throw the work away before
   * the captain has taken delivery. Only cancellation forces removal here.
   *
   * That is not the same as "forever". Once the branch is merged, the worktree
   * holds nothing that is not also in the repository, and `blue gc` reclaims it
   * on exactly that test (`src/worktree/reclaim.ts`). Teardown does not run that
   * sweep itself: at teardown the work has just landed and has definitionally
   * not been merged yet, so a sweep here would always decline.
   *
   * The removal here is `force: true` and answers to nobody — it is the one
   * place in the system that deletes a worktree without asking whether anything
   * in it is the only copy. So it rescues a recon's report first: a recon
   * cancelled after it wrote `REPORT.md` used to lose it outright, which is the
   * same data loss `#archiveReport` was added to prevent, on the one path that
   * actually deletes something.
   */
  async #teardown(taskId: TaskId, opts: { removeWorktree: boolean }): Promise<void> {
    const live = this.#live.get(taskId);
    if (!live) return;
    live.closed = true;
    this.#live.delete(taskId);

    try {
      if (this.#deps.adapter.capabilities.interrupt) await live.session.interrupt();
    } catch (err) {
      this.#log(`interrupt ${taskId}`, err);
    }
    try {
      await live.session.close();
    } catch (err) {
      this.#log(`close ${taskId}`, err);
    }

    if (!opts.removeWorktree) return;

    // Idempotent: a recon that already landed archived the same bytes to the
    // same path, and re-copying them costs nothing next to losing them.
    if (this.task(taskId)?.kind === 'recon') {
      await this.#archiveReport(taskId, live.worktree.path);
    }

    try {
      await live.worktrees.remove(live.worktree, { force: true });
    } catch (err) {
      this.#log(`worktree teardown ${taskId}`, err);
    }
  }

  // -----------------------------------------------------------------------
  // Plumbing
  // -----------------------------------------------------------------------

  #track(work: Promise<unknown>): void {
    this.#inflight.add(work);
    void work.catch(() => undefined).finally(() => this.#inflight.delete(work));
  }

  #log(scope: string, err: unknown): void {
    if (this.#deps.onError) {
      this.#deps.onError(scope, err);
      return;
    }
    console.error(`[orchestrator] ${scope}: ${errorText(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ExitEvent = Extract<AdapterEvent, { type: 'exit' }>;

function stateChange(
  taskId: TaskId,
  from: TaskState,
  to: TaskState,
  reason?: string,
): BlueEventBody {
  return { type: 'task.state_changed', taskId, from, to, reason };
}

/** Where a recon Crew's brief tells it to write. Kept in step with buildBrief(). */
function reportPath(worktreePath: string): string {
  return worktreePath.endsWith('/') ? `${worktreePath}REPORT.md` : `${worktreePath}/REPORT.md`;
}

/**
 * A task id becomes a file name in the captain's data directory. Ids are minted
 * by `createTask` as UUIDs and have already passed the worktree manager's much
 * stricter rules to get this far — this is the second belt, not the first.
 */
function reportFileName(taskId: TaskId): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '.');
  return `${safe === '' ? 'unknown' : safe}.md`;
}

/** ENOENT, whatever wrapper it arrives in. A missing report is not an error. */
function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/**
 * `claude-opus-5 4.1M, claude-haiku-4-5 900k` — the per-model split, for a
 * failure message.
 *
 * Named in the failure because "5,102,331 tokens" does not tell a captain what
 * to change, and which model burned them usually does. Biggest first, and only
 * the models that actually ran.
 */
function describeByModel(byModel: Record<string, TokenCounts>): string {
  const parts = Object.entries(byModel)
    .map(([model, counts]) => ({ model, total: totalTokens(counts) }))
    .filter((p) => p.total > 0)
    .sort((a, b) => b.total - a.total)
    .map((p) => `${p.model} ${p.total.toLocaleString('en-US')}`);
  return parts.length > 0 ? parts.join(', ') : 'no model reported';
}

function byCreation(a: Task, b: Task): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Bounds on the parts of a verdict quoted back into a rework message.
 *
 * The verdict is MODEL OUTPUT — `reasoning` and every `unmet` entry are written
 * by the Sentinel and nothing constrains their length. This message is typed
 * into a live session, so an unbounded verdict becomes an unbounded thing to
 * type; the backend now splits a long message across several commands rather
 * than failing on one (`TmuxBackend.sendText`), which means the failure mode is
 * no longer an error but a Crew reading a wall of restated diff.
 *
 * Generous enough that a real verdict — one paragraph and a list of specifics —
 * is never touched, and small enough that a Sentinel which dumped the diff into
 * its own reasoning cannot turn a rework into a second full transcript. The cut
 * is visible in the text, because a Crew silently handed two thirds of a
 * requirement would fix two thirds of it.
 */
const REWORK_REASONING_CHARS = 4_000;
const REWORK_UNMET_CHARS = 1_000;
const REWORK_UNMET_ITEMS = 40;

/** The message that sends a Crew back into a diff the Sentinel rejected. */
export function reworkMessage(verdict: Verdict): string {
  const shown = verdict.unmet.slice(0, REWORK_UNMET_ITEMS);
  const hidden = verdict.unmet.length - shown.length;

  return [
    'REWORK REQUIRED — an independent verifier reviewed your diff against the brief and rejected it.',
    '',
    `Verdict: ${truncate(verdict.reasoning, REWORK_REASONING_CHARS)}`,
    '',
    'Unmet requirements:',
    ...(shown.length > 0
      ? shown.map((u) => `- ${truncate(u, REWORK_UNMET_CHARS)}`)
      : ['- (none listed; re-read the brief and close the gap the verdict describes)']),
    ...(hidden > 0
      ? [`- (and ${hidden} more not shown; re-read the brief as a checklist rather than fixing only this list)`]
      : []),
    '',
    'The verifier never saw your reasoning — only the brief and the diff. If you believe a',
    'requirement is already met, it is not visible in the diff, which is the same thing.',
    'Fix these in this worktree, commit, and stop. Do not restate the plan.',
  ].join('\n');
}

function preview(input: unknown): string {
  if (typeof input === 'string') return truncate(input, PREVIEW_CHARS);
  try {
    return truncate(JSON.stringify(input) ?? String(input), PREVIEW_CHARS);
  } catch {
    return truncate(String(input), PREVIEW_CHARS);
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (+${text.length - max} chars)`;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
