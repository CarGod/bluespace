/**
 * Public surface of the worktree module.
 *
 * The orchestrator asks for a worktree per task, hands its `path` to the adapter
 * as the Crew's cwd, hands its `diff` to the Sentinel, and tears it down when the
 * task reaches a terminal state. `blue gc` asks `reclaim` to sweep the ones whose
 * task is over. Nothing outside this module shells out to git — which is why the
 * `git()` helper itself is NOT re-exported here.
 */

export {
  BRANCH_PREFIX,
  INTEGRATION_BRANCH,
  WorktreeManager,
  assertIsolated,
  localBranchRef,
  taskBranchName,
  NotIsolatedError,
  GitError,
  DirtyWorktreeError,
  UnlandedCommitsError,
} from './manager.js';
export type { BranchRef, Worktree } from './manager.js';

export {
  DevBranchConflictError,
  MergeConflictError,
  MergeTargetError,
  assertNoBranchNamespaceConflict,
  ensureIntegrationBranch,
  integrationStatus,
  isMergedInto,
  mergeTaskBranch,
} from './dev.js';
export type { DevBranchSetup, IntegrationStatus, MergeInput, MergeReport } from './dev.js';

export { directorySize, reclaimWorktrees, sweepOrphanDirectories } from './reclaim.js';
export type {
  Destroys,
  KeepReason,
  KeptEntry,
  OrphanSweepOptions,
  ReclaimError,
  ReclaimOptions,
  ReclaimResult,
  ReclaimedEntry,
} from './reclaim.js';
