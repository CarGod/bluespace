/**
 * What `blue ps` shows, and what it stops showing.
 *
 * A separate module from `index.ts` for one reason: `index.ts` runs `main()` at
 * import time, so nothing can test a rule that lives in it. This rule is worth
 * testing — it is the only place in BlueSpace where something true is
 * deliberately left off the screen.
 *
 * THE BLACKBOX IS APPEND-ONLY AND NOTHING HERE DELETES ANYTHING. Every task ever
 * created is still in the log, still projectable, still reachable with `blue log`
 * and `blue ps --all`. What changes is the default VIEW, because `ps` answers
 * "what is the fleet doing" and a view that cannot forget stops answering it: a
 * month-old fleet replied with forty rows of what it used to be doing, terminal
 * tasks sorted to the bottom and kept for ever. The captain's own words, looking
 * at two dead tasks he could not get rid of: *"这任务怎么结束啊"*.
 */

import type { HelmWindowRef } from '../blackbox/index.js';
import { isTerminal, type Task } from '../types/domain.js';

/**
 * How long a finished task stays on the default screen.
 *
 * ONE RULE, BY TIME, rather than one per state. Cancelled work is over and
 * failed work may still want something from the captain, which is an argument
 * for different horizons — and it loses to a simpler one: a captain who cannot
 * predict what is on the screen cannot read an empty screen as an empty fleet. A
 * day covers "what happened while I was away" for anyone who sleeps, and
 * `--all` covers everything else.
 */
export const PS_HORIZON_MS = 24 * 60 * 60 * 1000;

export interface PsView {
  /** The rows to print, unsorted — the caller owns ordering. */
  shown: Task[];
  /** How many were left out. Zero means the screen is the whole fleet. */
  elided: number;
}

/**
 * Split the fleet into what `blue ps` prints and what it counts.
 *
 * NOTHING IN FLIGHT IS EVER ELIDED, whatever its age. A task stuck for a week is
 * the single most important row on the screen, and a horizon that hid it would
 * turn this from a status view into a recency view.
 *
 * `updatedAt` rather than `createdAt`: the question is when the task finished,
 * not when it was asked for. A long mission that landed an hour ago is news.
 */
export function psView(
  tasks: readonly Task[],
  opts: { all?: boolean; now?: number } = {},
): PsView {
  if (opts.all === true) return { shown: [...tasks], elided: 0 };
  const cutoff = (opts.now ?? Date.now()) - PS_HORIZON_MS;
  const shown = tasks.filter((t) => !isTerminal(t.state) || t.updatedAt >= cutoff);
  return { shown, elided: tasks.length - shown.length };
}

/**
 * How many Helm windows `blue ps` will open transcripts for.
 *
 * A CEILING ON WORK, NOT ON TRUTH. Reading a window costs a directory search
 * across every Claude Code project on the machine plus one pass over each
 * transcript it finds, and the log never forgets a window — a captain a year in
 * has hundreds of rows and only ever wants the last few. Six is more than the
 * number of Helm windows anyone has open at once and small enough that `blue ps`
 * stays a command you run without thinking.
 */
export const PS_HELM_WINDOW_LIMIT = 6;

/**
 * Which Helm windows are worth reading from disk, newest first.
 *
 * The same horizon the task table uses, applied to when the window opened. It is
 * a coarser question than the one asked of a task — there is no state here to
 * call terminal, because nothing observes a Helm window closing — so a window
 * the captain opened this morning and closed at lunch is in view all day. That
 * is the right error: the tokens it spent are still tokens they spent today.
 *
 * `--all` lifts the horizon and keeps the count ceiling, which is the one place
 * these two differ. `--all` exists so a captain can see history the default
 * hides; it does not exist to make `blue ps` walk three hundred transcripts.
 */
export function helmWindowsInView(
  windows: readonly HelmWindowRef[],
  opts: { all?: boolean; now?: number; limit?: number } = {},
): HelmWindowRef[] {
  const limit = opts.limit ?? PS_HELM_WINDOW_LIMIT;
  const cutoff = (opts.now ?? Date.now()) - PS_HORIZON_MS;
  const kept = opts.all === true ? [...windows] : windows.filter((w) => w.openedAt >= cutoff);
  return kept.sort((a, b) => b.openedAt - a.openedAt).slice(0, limit);
}
