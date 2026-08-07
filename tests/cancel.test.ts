/**
 * What `blue cancel` is allowed to claim it did.
 *
 * Found by running the command rather than by reading it: cancelling a queued
 * task printed a green tick and *"Crew stopped, worktree removed"* — for a task
 * that never had a Crew and never had a worktree. `blue cancel` runs in a process
 * that dispatches nothing, so that branch was reachable ONLY in the case where
 * no teardown could have happened.
 *
 * These four cases are the whole rule. The first is the one that regressed, and
 * it is also the commonest cancel there is.
 */

import { describe, expect, it } from 'vitest';

import { cancelOutcome } from '../src/cli/cancel.js';

describe('cancelOutcome', () => {
  it('claims no teardown for a task that never had a Crew', () => {
    expect(cancelOutcome({ hadCrew: false, heldCrew: false })).toBe('never_ran');
  });

  it('still claims none when that queued task was cancelled with --force', () => {
    // `--force` is permission to write the log entry, not evidence about what was
    // running. A task with no Crew is exempt from the refusal either way, so the
    // flag must not change the sentence.
    expect(cancelOutcome({ hadCrew: false, heldCrew: true })).toBe('never_ran');
  });

  it('claims the teardown only when this process held the session', () => {
    expect(cancelOutcome({ hadCrew: true, heldCrew: true })).toBe('crew_stopped');
  });

  it('claims only the record when the Crew belongs to another process', () => {
    // Reachable under `--force`; without it `Orchestrator.cancelTask` throws
    // `CrewNotHeldError` and this is never asked.
    expect(cancelOutcome({ hadCrew: true, heldCrew: false })).toBe('recorded_only');
  });
});
