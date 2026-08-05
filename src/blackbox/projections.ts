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

import type {
  CrewId,
  Decision,
  Task,
  TaskId,
  TaskState,
} from '../types/domain.js';
import type { BlueEvent } from '../types/events.js';

/** Bucket for costs whose model the harness did not report. */
export const UNKNOWN_MODEL = 'unknown';

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
 * task.completed, task.failed, crew.usage, sentinel.verdict. `updatedAt` is the
 * `at` of the last such event, so it answers "when did this task last actually
 * move", not "when did a crew last print a line".
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
          createdAt: e.at,
          updatedAt: e.at,
          costUsd: 0,
          reworkCount: 0,
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

      case 'crew.usage': {
        const task = touch(owners.get(e.crewId), e.at);
        if (!task) break;
        task.costUsd = round(task.costUsd + e.costUsd);
        break;
      }

      case 'sentinel.verdict': {
        // Verification is billed to the task it verified, not to the crew.
        const task = touch(e.taskId, e.at);
        if (!task) break;
        task.costUsd = round(task.costUsd + e.costUsd);
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
// Cost
// ---------------------------------------------------------------------------

export interface CostProjection {
  totalUsd: number;
  byTask: Record<string, number>;
  byModel: Record<string, number>;
}

/**
 * Total spend, split by task and by model. Sentinel verdicts are billed to the
 * task they verified; since the harness does not report a model for structured
 * verdicts they land in the `unknown` model bucket, which keeps
 * `sum(byModel) === totalUsd` true.
 *
 * Crew usage from a crew that was never observed spawning still counts toward
 * the total — the money was spent — but cannot be attributed to a task.
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
