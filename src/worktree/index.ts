/**
 * Public surface of the worktree module.
 *
 * The orchestrator asks for a worktree per task, hands its `path` to the adapter
 * as the Crew's cwd, hands its `diff` to the Sentinel, and tears it down when the
 * task reaches a terminal state. Nothing outside this module shells out to git.
 */

export {
  WorktreeManager,
  assertIsolated,
  NotIsolatedError,
  GitError,
  DirtyWorktreeError,
  UnlandedCommitsError,
} from './manager.js';
export type { Worktree } from './manager.js';
