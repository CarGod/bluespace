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
