/**
 * The task state machine — the legal shape of a task's life, written down once.
 *
 * This module is pure and dependency-free on purpose. The orchestrator is the
 * only component allowed to move a task, and it must move it THROUGH here: every
 * transition is checked against this table and then recorded as a
 * `task.state_changed` event. A state that cannot be reached by walking these
 * edges cannot happen, which is what makes the log auditable rather than
 * merely voluminous.
 *
 * The table is deliberately narrow. Where the orchestrator needs to reach a
 * state that is not one hop away (a rejected task that ends up in the captain's
 * inbox, a cancellation arriving mid-verification), it asks `pathTo()` for a
 * legal route and records every hop, instead of inventing a shortcut edge.
 */

import type { TaskState } from '../types/domain.js';

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * Legal successor states, keyed by current state.
 *
 * ```
 *   queued ──► dispatched ──► working ──┬──► verifying ──┬──► ready ──► landed
 *                                       │                │
 *                                       ├──► awaiting_decision (blocks on captain)
 *                                       │                │
 *                                       │                └──► needs_rework ──► working
 *                                       └──► failed / cancelled
 * ```
 *
 * `landed`, `failed` and `cancelled` are terminal: no outgoing edges, ever.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = Object.freeze({
  queued: Object.freeze(['dispatched', 'cancelled'] as const),
  dispatched: Object.freeze(['working', 'failed', 'cancelled'] as const),
  working: Object.freeze(['awaiting_decision', 'verifying', 'failed', 'cancelled'] as const),
  awaiting_decision: Object.freeze(['working', 'cancelled', 'failed'] as const),
  verifying: Object.freeze(['ready', 'needs_rework', 'failed'] as const),
  needs_rework: Object.freeze(['working', 'failed', 'cancelled'] as const),
  ready: Object.freeze(['landed', 'failed'] as const),
  landed: Object.freeze([] as const),
  failed: Object.freeze([] as const),
  cancelled: Object.freeze([] as const),
});

/** Every state a task may legally move to from `from`. Never undefined. */
export function legalTargets(from: TaskState): readonly TaskState[] {
  return TASK_TRANSITIONS[from] ?? [];
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return legalTargets(from).includes(to);
}

/** Thrown when something tries to move a task along an edge that does not exist. */
export class IllegalTransitionError extends Error {
  constructor(
    readonly from: TaskState,
    readonly to: TaskState,
    readonly taskId?: string,
  ) {
    super(
      `illegal task transition ${from} -> ${to}${taskId ? ` (task ${taskId})` : ''}; ` +
        `legal from ${from}: ${legalTargets(from).join(', ') || '<terminal>'}`,
    );
    this.name = 'IllegalTransitionError';
  }
}

export function assertTransition(from: TaskState, to: TaskState, taskId?: string): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to, taskId);
}

/**
 * Shortest legal route from `from` to `to`, excluding `from` itself.
 *
 * Returns `[]` when they are the same state, `undefined` when no route exists
 * (e.g. `ready -> cancelled`: once a diff is verified the only ways out are
 * `landed` and `failed`). Breadth-first over the declared edge order, so the
 * route for a given pair is stable — the log reads the same on every run.
 */
export function pathTo(from: TaskState, to: TaskState): TaskState[] | undefined {
  if (from === to) return [];

  const previous = new Map<TaskState, TaskState>();
  const seen = new Set<TaskState>([from]);
  const queue: TaskState[] = [from];

  while (queue.length > 0) {
    const current = queue.shift() as TaskState;
    for (const next of legalTargets(current)) {
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, current);
      if (next === to) {
        const route: TaskState[] = [next];
        let cursor: TaskState = next;
        for (;;) {
          const parent = previous.get(cursor);
          if (parent === undefined || parent === from) break;
          route.unshift(parent);
          cursor = parent;
        }
        return route;
      }
      queue.push(next);
    }
  }

  return undefined;
}
