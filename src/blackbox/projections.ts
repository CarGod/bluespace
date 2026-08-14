/**
 * Projections — every piece of BlueSpace state, derived by folding the log.
 *
 * These are pure functions over `BlueEvent[]`: no database, no clock, no I/O.
 * That is deliberate. It means the TUI, the web server and the orchestrator all
 * compute state the same way, a projection can be unit-tested with a literal
 * array, and there is never a stored mutable row that can disagree with what
 * actually happened.
 *
 * Ordering rule: `seq` is the only ordering anyone may trust. Callers usually
 * hand us `Blackbox.read()` output (already seq ASC), but each entry point
 * re-sorts a copy so a hand-assembled or merged array can't corrupt the fold.
 */

import {
  addTokenCounts,
  addTokenUsage,
  noTokenUsage,
  noTokens,
  totalTokens,
  UNKNOWN_MODEL,
} from '../types/domain.js';
import type {
  CrewId,
  Decision,
  Task,
  TaskId,
  TaskState,
  TokenCounts,
  TokenUsage,
} from '../types/domain.js';
import type { BlueEvent } from '../types/events.js';

/**
 * Bucket for tokens whose model the harness did not report.
 *
 * Re-exported rather than redeclared: the fold here and the accumulator in
 * types/domain.ts must agree on the key, or a task's `byModel` would carry two
 * spellings of "we don't know".
 */
export { UNKNOWN_MODEL } from '../types/domain.js';

/**
 * Money is accumulated as floating point, so 0.1 + 0.2 must not surface as
 * 0.30000000000000004 in a captain-facing total. Ten decimal places keeps
 * every real per-call cost intact while erasing binary-float noise.
 */
function round(usd: number): number {
  return Math.round(usd * 1e10) / 1e10;
}

function bySeq(events: BlueEvent[]): BlueEvent[] {
  return [...events].sort((a, b) => a.seq - b.seq);
}

/**
 * A `crew.usage` event's four counts, in the domain's vocabulary.
 *
 * The event's names are the harness's (`inputTokens`, `cacheReadTokens`, …) and
 * two of them are optional, because an older transcript carried neither cache
 * field. Missing is read as zero rather than as unknown: the alternative is a
 * total that cannot be added up.
 */
function usageTokens(e: Extract<BlueEvent, { type: 'crew.usage' }>): TokenCounts {
  return {
    input: e.inputTokens,
    output: e.outputTokens,
    cacheRead: e.cacheReadTokens ?? 0,
    cacheCreation: e.cacheCreationTokens ?? 0,
  };
}

/**
 * crewId -> taskId. Crew-scoped events (notably crew.usage) carry only a crew
 * id, so the mapping has to be rebuilt before the main fold — a single crew's
 * usage can otherwise never be attributed to the task that paid for it.
 */
function crewOwners(events: BlueEvent[]): Map<CrewId, TaskId> {
  const owners = new Map<CrewId, TaskId>();
  for (const e of events) {
    if (e.type === 'crew.spawned' || e.type === 'task.dispatched') {
      owners.set(e.crewId, e.taskId);
    }
  }
  return owners;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * Fold the log into the current Task for every task ever created.
 *
 * Contributing events: task.created, task.dispatched, task.state_changed,
 * task.completed, task.failed, crew.spawned, crew.usage, sentinel.verdict.
 * `updatedAt` is the `at` of the last such event, so it answers "when did this
 * task last actually move", not "when did a crew last print a line".
 *
 * Consumption is folded TWICE, into two fields that are not the same kind of
 * thing: `tokens` (measured, per model, the ceiling's unit) and `listPriceUsd`
 * (derived from a price table, and money only when `metered`). Nothing here
 * decides which of them to show a human — that is a reporting decision, and the
 * `metered` flag is projected so every reporter can make it the same way.
 */
export function projectTasks(events: BlueEvent[]): Map<TaskId, Task> {
  const ordered = bySeq(events);
  const owners = crewOwners(ordered);
  const tasks = new Map<TaskId, Task>();

  const touch = (id: TaskId | undefined, at: number): Task | undefined => {
    if (id === undefined) return undefined;
    const task = tasks.get(id);
    if (!task) return undefined;
    task.updatedAt = at;
    return task;
  };

  const transition = (task: Task, to: TaskState): void => {
    // reworkCount counts ENTRIES into needs_rework, not time spent there: a
    // repeated state_changed into the same state is not another attempt.
    if (to === 'needs_rework' && task.state !== 'needs_rework') task.reworkCount += 1;
    task.state = to;
  };

  for (const e of ordered) {
    switch (e.type) {
      case 'task.created': {
        // A duplicated create (replay, resumed session) must not reset the
        // accumulated cost or rework count of a task already in flight.
        if (tasks.has(e.taskId)) {
          const existing = tasks.get(e.taskId);
          if (existing) existing.updatedAt = e.at;
          break;
        }
        tasks.set(e.taskId, {
          id: e.taskId,
          kind: e.kind,
          projectId: e.projectId,
          title: e.title,
          brief: e.brief,
          state: 'queued',
          dependsOn: [...e.dependsOn],
          ...(e.resumeOf !== undefined ? { resumeOf: e.resumeOf } : {}),
          createdAt: e.at,
          updatedAt: e.at,
          tokens: noTokenUsage(),
          metered: false,
          listPriceUsd: 0,
          reworkCount: 0,
          amendments: 0,
        });
        break;
      }

      case 'task.dispatched': {
        const task = touch(e.taskId, e.at);
        if (!task) break;
        task.crewId = e.crewId;
        task.worktree = e.worktree;
        transition(task, 'dispatched');
        break;
      }

      case 'crew.spawned': {
        // Only `metered` is read here; the task's crew id comes from
        // task.dispatched, which is written in the same batch.
        //
        // LATCHED ON, never off: a task whose first Crew ran on an API key and
        // whose rework Crew ran on a subscription did spend real money, and a
        // reader that flipped the flag back would report that spend as free.
        // The reverse (one metered run in a mostly-subscription task) overstates
        // what is spend, which is the error that costs a captain nothing.
        const task = tasks.get(e.taskId);
        if (!task) break;
        if (e.metered === true) task.metered = true;
        break;
      }

      case 'task.state_changed': {
        const task = touch(e.taskId, e.at);
        if (!task) break;
        transition(task, e.to);
        break;
      }

      case 'task.completed': {
        const task = touch(e.taskId, e.at);
        if (!task) break;
        // The deliverable, kept on the task. For a recon this is the report
        // archived OUT of the worktree, which is the only pointer that stays
        // valid after `blue gc` reclaims the directory.
        task.artifact = e.artifact;
        task.summary = e.summary;
        transition(task, 'landed');
        break;
      }

      case 'task.failed': {
        const task = touch(e.taskId, e.at);
        if (!task) break;
        transition(task, 'failed');
        break;
      }

      case 'task.merged': {
        // NOT a state change: `landed` already means verification is over, and a
        // merge is a separate fact about the captain's repository. It is folded
        // onto the task because it is the only thing that can tell a later sweep
        // which branch this task's commits actually reached — see
        // `Task.mergedInto` and `src/worktree/reclaim.ts`.
        const task = touch(e.taskId, e.at);
        if (!task) break;
        task.mergedInto = e.into;
        task.mergeCommit = e.commit;
        task.mergedAt = e.at;
        break;
      }

      case 'task.amended': {
        // Folded INTO the brief, which is the one string the Crew is briefed
        // from and the Sentinel grades against. Anything else would leave the
        // two reading different documents, which is the bug this event exists
        // to end.
        const task = touch(e.taskId, e.at);
        if (!task) break;
        task.amendments += 1;
        task.brief = `${task.brief.trimEnd()}\n\n## Amendment ${task.amendments}\n\n${e.addendum.trim()}`;
        break;
      }

      case 'task.dismissed': {
        // Not a transition: a dismissed task keeps the state it died in. This
        // only decides whether the board draws it.
        const task = tasks.get(e.taskId);
        if (!task) break;
        task.dismissedAt = e.dismissed ? e.at : undefined;
        break;
      }

      case 'crew.usage': {
        const task = touch(owners.get(e.crewId), e.at);
        if (!task) break;
        task.tokens = addTokenUsage(task.tokens, e.model, usageTokens(e));
        task.listPriceUsd = round(task.listPriceUsd + e.costUsd);
        break;
      }

      case 'sentinel.verdict': {
        // Verification is billed to the task it verified, not to the crew.
        const task = touch(e.taskId, e.at);
        if (!task) break;
        for (const [model, counts] of Object.entries(e.tokensByModel ?? {})) {
          task.tokens = addTokenUsage(task.tokens, model, counts);
        }
        task.listPriceUsd = round(task.listPriceUsd + e.costUsd);
        break;
      }

      default:
        break;
    }
  }

  return tasks;
}

/** The same fold, scoped to one task. */
export function projectTask(events: BlueEvent[], id: TaskId): Task | undefined {
  const owned = new Set<CrewId>();
  for (const e of events) {
    if ((e.type === 'crew.spawned' || e.type === 'task.dispatched') && e.taskId === id) {
      owned.add(e.crewId);
    }
  }

  const scoped = events.filter((e) => {
    if ('taskId' in e && e.taskId === id) return true;
    return 'crewId' in e && owned.has(e.crewId);
  });

  return projectTasks(scoped).get(id);
}

// ---------------------------------------------------------------------------
// Decisions — the captain's inbox
// ---------------------------------------------------------------------------

interface DecisionFold {
  decision: Decision;
  /** seq of the opening event; the tiebreak for identical timestamps. */
  openedSeq: number;
}

function foldDecisions(events: BlueEvent[]): DecisionFold[] {
  const folds = new Map<string, DecisionFold>();

  for (const e of bySeq(events)) {
    if (e.type === 'decision.opened') {
      const decision: Decision = {
        id: e.decisionId,
        taskId: e.taskId,
        question: e.question,
        options: [...e.options],
        openedAt: e.at,
      };
      if (e.context !== undefined) decision.context = e.context;
      folds.set(e.decisionId, { decision, openedSeq: e.seq });
    } else if (e.type === 'decision.resolved') {
      const fold = folds.get(e.decisionId);
      if (!fold) continue;
      fold.decision.resolvedAt = e.at;
      fold.decision.answer = e.answer;
    }
  }

  return [...folds.values()];
}

/** Every decision ever raised, oldest first. */
export function projectAllDecisions(events: BlueEvent[]): Decision[] {
  return foldDecisions(events)
    .sort(byOpenedOldestFirst)
    .map((f) => f.decision);
}

/**
 * Decisions still waiting on the captain, LONGEST-WAITING FIRST.
 *
 * This ordering is the product: it is the inbox the captain works top-down,
 * and it guarantees that the task blocked the longest is the one unblocked
 * next. Do not "improve" it into newest-first.
 */
export function projectOpenDecisions(events: BlueEvent[]): Decision[] {
  return foldDecisions(events)
    .filter((f) => f.decision.resolvedAt === undefined)
    .sort(byOpenedOldestFirst)
    .map((f) => f.decision);
}

function byOpenedOldestFirst(a: DecisionFold, b: DecisionFold): number {
  return a.decision.openedAt - b.decision.openedAt || a.openedSeq - b.openedSeq;
}

// ---------------------------------------------------------------------------
// Helm's own windows
// ---------------------------------------------------------------------------

/** A Helm window as the log remembers it: enough to find its transcript. */
export interface HelmWindowRef {
  sessionId: string;
  cwd: string;
  /** When `blue mcp` registered it — the window's start, near enough. */
  openedAt: number;
}

/**
 * Every Helm window ever registered, MOST RECENT FIRST, one row per session.
 *
 * DEDUPLICATED BY SESSION ID, keeping the newest. One window registers once per
 * `blue mcp` process, and a window whose MCP server is restarted — the harness
 * does that on `/mcp reconnect`, and on a config reload — registers again under
 * the same session id. Two rows for one window would double-count its tokens the
 * moment a caller summed them.
 *
 * NOTHING HERE KNOWS WHICH WINDOWS ARE STILL OPEN, and nothing can: this process
 * did not start them and there is no exit event to pair with the open. That is
 * why the caller filters on the transcript instead of on this list — a window
 * the captain closed yesterday still has its row here forever, exactly as an
 * append-only log requires.
 */
export function projectHelmWindows(events: BlueEvent[]): HelmWindowRef[] {
  const byId = new Map<string, HelmWindowRef>();
  for (const e of events) {
    if (e.type !== 'helm.window_opened') continue;
    byId.set(e.sessionId, { sessionId: e.sessionId, cwd: e.cwd, openedAt: e.at });
  }
  return [...byId.values()].sort((a, b) => b.openedAt - a.openedAt);
}

// ---------------------------------------------------------------------------
// Consumption — tokens first, dollars derived
// ---------------------------------------------------------------------------

/**
 * Fleet-wide token consumption: the honest answer to "what has this cost me".
 *
 * `metered` is the flag that decides whether {@link listPrice} may be called
 * spend. It is true only if EVERY run in the log was launched with an API key —
 * a fleet that mixes a metered run with subscription ones has no single dollar
 * figure, and quoting the sum as spend would overstate the invoice by whatever
 * the subscription runs "cost". Mixed fleets report tokens and, if they insist
 * on dollars, a labelled equivalent.
 */
export interface UsageProjection {
  totals: TokenCounts;
  /** Total across all four kinds — what `maxTokensPerTask` counts. */
  total: number;
  byModel: Record<string, TokenCounts>;
  byTask: Record<string, TokenUsage>;
  metered: boolean;
  /** Derived from the counts above by `src/pricing`, at spawn time. */
  listPrice: CostProjection;
}

export function projectUsage(events: BlueEvent[]): UsageProjection {
  const ordered = bySeq(events);
  const owners = crewOwners(ordered);

  let totals: TokenCounts = noTokens();
  const byModel: Record<string, TokenCounts> = {};
  const byTask: Record<string, TokenUsage> = {};

  let sawRun = false;
  let allMetered = true;

  const addTo = (taskId: string | undefined, model: string | undefined, counts: TokenCounts): void => {
    const key = model !== undefined && model !== '' ? model : UNKNOWN_MODEL;
    totals = addTokenCounts(totals, counts);
    byModel[key] = addTokenCounts(byModel[key] ?? noTokens(), counts);
    if (taskId === undefined) return;
    byTask[taskId] = addTokenUsage(byTask[taskId] ?? noTokenUsage(), key, counts);
  };

  for (const e of ordered) {
    if (e.type === 'crew.spawned') {
      sawRun = true;
      if (e.metered !== true) allMetered = false;
    } else if (e.type === 'crew.usage') {
      addTo(owners.get(e.crewId), e.model, usageTokens(e));
    } else if (e.type === 'sentinel.verdict') {
      for (const [model, counts] of Object.entries(e.tokensByModel ?? {})) {
        addTo(e.taskId, model, counts);
      }
    }
  }

  return {
    totals,
    total: totalTokens(totals),
    byModel,
    byTask,
    metered: sawRun && allMetered,
    listPrice: projectCost(ordered),
  };
}

export interface CostProjection {
  totalUsd: number;
  byTask: Record<string, number>;
  byModel: Record<string, number>;
}

/**
 * The LIST-PRICE EQUIVALENT of everything in the log, split by task and by model.
 *
 * Not spend unless `projectUsage(...).metered` is true — on a subscription these
 * tokens drew down a quota and were never invoiced. Callers that print this
 * without checking are the bug this whole module was reshaped to prevent.
 *
 * Sentinel verdicts are billed to the task they verified; since the verdict
 * event carries dollars without a model split they land in the `unknown` model
 * bucket, which keeps `sum(byModel) === totalUsd` true.
 *
 * Crew usage from a crew that was never observed spawning still counts toward
 * the total — the tokens were spent — but cannot be attributed to a task.
 */
export function projectCost(events: BlueEvent[]): CostProjection {
  const ordered = bySeq(events);
  const owners = crewOwners(ordered);

  let totalUsd = 0;
  const byTask: Record<string, number> = {};
  const byModel: Record<string, number> = {};

  const add = (bucket: Record<string, number>, key: string, usd: number): void => {
    bucket[key] = round((bucket[key] ?? 0) + usd);
  };

  for (const e of ordered) {
    if (e.type === 'crew.usage') {
      totalUsd += e.costUsd;
      const taskId = owners.get(e.crewId);
      if (taskId !== undefined) add(byTask, taskId, e.costUsd);
      add(byModel, e.model ?? UNKNOWN_MODEL, e.costUsd);
    } else if (e.type === 'sentinel.verdict') {
      totalUsd += e.costUsd;
      add(byTask, e.taskId, e.costUsd);
      add(byModel, UNKNOWN_MODEL, e.costUsd);
    }
  }

  return { totalUsd: round(totalUsd), byTask, byModel };
}

// ---------------------------------------------------------------------------
// Crew log
// ---------------------------------------------------------------------------

/**
 * Everything one Crew did, in order — the transcript the captain scrolls when
 * they want to know what a worker was actually thinking.
 */
export function projectCrewLog(events: BlueEvent[], crewId: string): BlueEvent[] {
  return bySeq(events.filter((e) => 'crewId' in e && e.crewId === crewId));
}
