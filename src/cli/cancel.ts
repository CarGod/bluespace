/**
 * What actually happened when a task was cancelled — the sentence under the tick.
 *
 * A separate module from `index.ts` for the same reason `./ps.ts` is one:
 * `index.ts` runs `main()` at import time, so nothing in it can be tested, and
 * this is a rule worth testing. `blue cancel` prints a green tick and then one
 * line saying what was torn down; that line is the only place a captain learns
 * whether a session stopped, and it is the one part of this command that can be
 * wrong while everything else works.
 *
 * IT WAS WRONG, AND THIS IS THE SHAPE OF IT. The first version keyed off
 * `--force`: forced meant "recorded only", anything else meant "Crew stopped,
 * worktree removed". That is right for a Crew and false for the commonest cancel
 * there is — a queued task the captain changed their mind about, which never had
 * a Crew, never had a worktree, and had nothing to stop. `blue cancel` also runs
 * in a process that never dispatches anything, so the branch claiming a teardown
 * was reachable *only* in the case where no teardown could have happened.
 *
 * Two facts decide it, and `--force` is not one of them — it is the permission
 * to write the log entry, not evidence about what was running.
 */

/** What `blue cancel` may truthfully claim it did. */
export type CancelOutcome =
  /** Nothing was ever spawned: no session, no worktree, nothing to tear down. */
  | 'never_ran'
  /** This process held the session, so `cancelTask` really did stop and remove it. */
  | 'crew_stopped'
  /** A Crew exists somewhere else; only the cancellation was written down. */
  | 'recorded_only';

/**
 * Decide from the task as it stood BEFORE the cancel, not after.
 *
 * `heldCrew` has to be read before `cancelTask` runs: teardown is what removes a
 * task from the orchestrator's live map, so asking afterwards always answers
 * "no" — including in the one case where a Crew really was stopped.
 *
 * `hadCrew` is `task.crewId !== undefined` on that same pre-cancel projection.
 * A task keeps its crew id across rework, so this is "was anything ever spawned
 * for this task", which is exactly the question the worktree line depends on.
 */
export function cancelOutcome(input: { hadCrew: boolean; heldCrew: boolean }): CancelOutcome {
  if (!input.hadCrew) return 'never_ran';
  return input.heldCrew ? 'crew_stopped' : 'recorded_only';
}
