/**
 * Worktree reclamation — the sweep that keeps `<dataDir>/worktrees/` finite.
 *
 * The rule this module enforces is the repo owner's, stated once and not
 * negotiated anywhere below:
 *
 *   **Once the code is merged into its git branch, the worktree can be deleted.**
 *
 * "Its git branch" is the one the work was actually merged INTO, which since
 * delivery exists is normally `blue/dev` rather than `main` — a landed task sits
 * on the integration branch until the captain opens a pull request, and judging
 * it against `main` would keep every landed worktree forever. The base comes
 * from the task's own `task.merged` record and from nowhere else; a task with no
 * such record is judged against the default branch, exactly as before. See
 * `considerWorktree`.
 *
 * `WorktreeManager.remove()` already decides that, correctly and fail-closed.
 * What was missing was anything that CALLED it that way: every terminal path in
 * the orchestrator passes `removeWorktree: false`, so the directory count only
 * ever went up. This module is the caller.
 *
 * Three properties it exists to hold:
 *
 *  1. IT ONLY TAKES WHAT IS MERGED. The default sweep calls `remove()` WITHOUT
 *     force. `DirtyWorktreeError` and `UnlandedCommitsError` are not failures
 *     here — they are the correct answer "not yet", and they come back as a
 *     typed reason the captain can act on, not as an error.
 *  2. IT NEVER TOUCHES LIVE WORK. Only worktrees whose task is terminal, or
 *     which have no task at all. The task projection is the authority, and a
 *     caller holding live crews can name their paths on top of that.
 *  3. IT DOES NOT PRINT. Everything is returned as structure. `blue gc` owns
 *     the wording; a sweep that logged would be unusable from the server, the
 *     MCP layer, or a test.
 *
 * Every git invocation goes through the manager, or through the `git()` helper
 * in `manager.ts` — an argv array, never a shell string.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { isTerminal, type Task, type TaskId, type TaskState } from '../types/domain.js';
import {
  DirtyWorktreeError,
  INTEGRATION_BRANCH,
  UnlandedCommitsError,
  git,
  localBranchRef,
  type BranchRef,
  type Worktree,
  type WorktreeManager,
} from './manager.js';

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** Why a worktree survived the sweep. Typed, because `blue gc` renders each one differently. */
export type KeepReason =
  /** Its task is still live, or a caller named it as held by a running Crew. */
  | { kind: 'live'; taskId?: TaskId; state?: TaskState }
  /** Staged, unstaged or untracked changes: work that exists nowhere else. */
  | { kind: 'uncommitted' }
  /** Committed, but the commits are not reachable from the base branch. */
  | { kind: 'unlanded'; commits: number; baseBranch: string }
  /**
   * A real git worktree that no manager in this sweep claimed: another
   * repository's, a branch outside `blue/`, or a `blue/` worktree whose HEAD is
   * detached — `git worktree list --porcelain` reports no `branch` for a
   * detached checkout, so the manager never lists it and never speaks for it.
   *
   * Never removed, at any force level. Git vouches for the directory but this
   * sweep cannot say what is in it, and a detached HEAD is precisely where a
   * Crew's commits can sit on no branch at all.
   */
  | { kind: 'not-ours' }
  /**
   * A checkout of an INTEGRATION branch, not of a task branch.
   *
   * Never removed, at any force level, because `remove()` reaps a branch it has
   * proven merged — and the integration branch is fully merged into the default
   * branch for the whole window after the captain's pull request lands. That is
   * the garbage collector deleting `blue/dev`, on the one day of the cycle when
   * it looks most reclaimable.
   *
   * `WorktreeManager.list()` already drops the `blue/dev` CONSTANT; this covers
   * what a constant cannot. The reason `Project.devBranch` is recorded per
   * project at all is that the constant may change — and the day it does, every
   * project still on the old name has an integration branch this sweep would
   * otherwise read as a task called `dev`.
   */
  | { kind: 'integration'; branch: string }
  /**
   * A directory under the worktree root that git does not know as a worktree at
   * all. Nothing vouches for its contents, so safe mode leaves it alone.
   */
  | { kind: 'debris' };

/** What forcing a removal costs. Absent when the safe rule was already satisfied. */
export interface Destroys {
  /** Staged, unstaged or untracked changes in the directory. Unrecoverable. */
  uncommitted: boolean;
  /** Commits not reachable from `baseBranch`. */
  unlandedCommits: number;
  /** Absent for a directory git knows nothing about — there is no base to compare to. */
  baseBranch?: string;
  /**
   * True when the branch survives the directory: `remove()` only reaps a branch
   * it has proven fully merged, so forcing away a worktree that still has
   * unlanded commits costs the checkout, not the history.
   *
   * Read it as a statement about the BRANCH. A Crew that committed on a detached
   * HEAD has commits on no branch at all, and nothing can preserve those.
   */
  branchKept: boolean;
}

export interface ReclaimedEntry {
  path: string;
  /** Directory size measured before removal; 0 when the directory was already gone. */
  bytes: number;
  branch?: string;
  taskId?: TaskId;
  /** Set only when `force` overrode a refusal — what that cost. */
  destroys?: Destroys;
}

export interface KeptEntry {
  path: string;
  bytes: number;
  branch?: string;
  taskId?: TaskId;
  reason: KeepReason;
}

export interface ReclaimError {
  path: string;
  message: string;
}

export interface ReclaimResult {
  /** Removed — or, under `dryRun`, what would have been removed. */
  reclaimed: ReclaimedEntry[];
  kept: KeptEntry[];
  /** Sum of `reclaimed[].bytes`. Under `dryRun`, what a real sweep would free. */
  bytesFreed: number;
  /** Things that went wrong. A sweep never throws on one worktree's account. */
  errors: ReclaimError[];
}

export interface ReclaimOptions {
  /**
   * Reclaim terminal-task worktrees regardless of uncommitted work or unlanded
   * commits. DESTRUCTIVE. Callers must confirm with a human first; this module
   * cannot, because it has no terminal.
   */
  force?: boolean;
  /** Decide everything, change nothing. */
  dryRun?: boolean;
  /**
   * Worktree paths held by a Crew running in the caller's process. Never
   * touched, whatever the log says — `#live` cannot be projected, so a caller
   * that has one is the only thing that knows.
   */
  livePaths?: Iterable<string>;
  /**
   * Integration branches for this repository, as recorded on its project(s).
   *
   * The `blue/dev` constant and every branch the log says a task was merged
   * INTO are added for free; this is for the case neither can see — a project
   * whose recorded `devBranch` is a name of its own that has never been landed
   * into. A worktree on one of these is kept at every force level.
   */
  integrationBranches?: Iterable<string>;
  /**
   * Consider ONLY these worktree paths, if given.
   *
   * For reclaiming one directory the captain pointed at, rather than sweeping a
   * repository. It narrows what is looked at and changes NO rule: a path listed
   * here still has to pass every test below, and still shows up in `kept` with
   * a reason when it does not. Anything not listed is not examined at all — a
   * targeted removal must not quietly take a neighbour with it.
   */
  only?: Iterable<string>;
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * Reclaim every worktree of one repository that the rule allows.
 *
 * Considered: each `blue/*` worktree the manager lists. Reclaimable: those whose
 * task is `landed`, `failed` or `cancelled`, plus those with NO task at all —
 * a crash between cutting a worktree and recording the dispatch leaves one, and
 * it is exactly as safe to remove as a finished one, by the same test.
 *
 * `tasks` is the Blackbox projection (`Orchestrator.tasks()` or
 * `projectTasks(...).values()`), which is the only authority on what is live.
 */
export async function reclaimWorktrees(
  worktrees: WorktreeManager,
  tasks: Iterable<Task>,
  opts: ReclaimOptions = {},
): Promise<ReclaimResult> {
  const result: ReclaimResult = { reclaimed: [], kept: [], bytesFreed: 0, errors: [] };

  const byTask = new Map<TaskId, Task>();
  for (const task of tasks) byTask.set(task.id, task);
  const live = livePathSet(byTask.values(), opts.livePaths);
  const integration = integrationBranchSet(byTask.values(), opts.integrationBranches);

  let listed: Worktree[];
  try {
    listed = await worktrees.list();
  } catch (err) {
    result.errors.push({ path: worktrees.root, message: errorText(err) });
    return result;
  }

  const only = opts.only === undefined ? undefined : new Set([...opts.only].map(normalizePath));
  for (const wt of listed) {
    if (only !== undefined && !only.has(normalizePath(wt.path))) continue;
    try {
      await considerWorktree(worktrees, wt, byTask.get(wt.taskId), live, integration, opts, result);
    } catch (err) {
      result.errors.push({ path: wt.path, message: errorText(err) });
    }
  }

  result.bytesFreed = result.reclaimed.reduce((sum, e) => sum + e.bytes, 0);
  return result;
}

async function considerWorktree(
  worktrees: WorktreeManager,
  wt: Worktree,
  task: Task | undefined,
  live: Set<string>,
  integration: Set<string>,
  opts: ReclaimOptions,
  result: ReclaimResult,
): Promise<void> {
  const bytes = await directorySize(wt.path);
  const base = { path: wt.path, bytes, branch: wt.branch, taskId: wt.taskId };

  // AN INTEGRATION BRANCH IS NOT A TASK BRANCH, and this is checked before
  // anything else because it is the one refusal that force may not override.
  // `remove()` deletes a branch once it is proven merged into the base, and an
  // integration branch is proven merged into the default branch for the entire
  // window after the captain's pull request — so a leftover checkout of one (a
  // land killed mid-merge is how you get one) would be swept away together with
  // the branch every landed task was merged into.
  if (integration.has(wt.branch)) {
    result.kept.push({ ...base, reason: { kind: 'integration', branch: wt.branch } });
    return;
  }

  // A task that has not finished is not a candidate, and neither is a path a
  // caller says it is running a Crew in. Both checks, not either: the log lags
  // a live process, and a live process knows nothing about other processes.
  //
  // The snapshot is safe to hold for the length of a sweep because `landed`,
  // `failed` and `cancelled` have no outgoing edges (`statemachine.ts`): a task
  // this pass read as live can only stay live or finish, never the reverse, so
  // re-reading the log before each removal could not change a single answer.
  // Two things that snapshot genuinely cannot see, and neither can a fresher
  // one: a worktree cut after `list()` ran (not in this pass at all — it will
  // be considered by the next one), and the moment between the orchestrator
  // recording a task as terminal and its Crew process actually dying. The
  // second is why `livePaths` exists.
  if (live.has(wt.path) || (task !== undefined && !isTerminal(task.state))) {
    const reason: KeepReason = { kind: 'live' };
    if (task !== undefined) {
      reason.taskId = task.id;
      reason.state = task.state;
    }
    result.kept.push({ ...base, reason });
    return;
  }

  // WHICH BRANCH "MERGED" MEANS FOR THIS WORKTREE.
  //
  // Under the delivery policy, work is merged into `blue/dev` and sits there
  // until the captain opens a pull request — so measuring a landed worktree
  // against `main` would read as unmerged for as long as the pull request takes,
  // and every landed worktree would pile up unreclaimed. That is the exact bug
  // `blue gc` was written to fix, reintroduced by the policy.
  //
  // The fix is narrow on purpose: the base is taken from the task's OWN merge
  // record in the Blackbox (`Task.mergedInto`, written by `task.merged`), not
  // from a constant and not from whatever branch happens to contain the commits.
  // A task that was never landed has no record, gets no override, and is
  // measured against the default branch exactly as before — which is what stops
  // this from becoming a way to reclaim work that landed nowhere. `remove()`
  // then re-proves containment in that branch before deleting anything, so a
  // stale or wrong record cannot destroy work either.
  const mergeTarget = mergeTargetOf(task);
  const pending = await pendingWork(worktrees, wt, mergeTarget);

  if (pending !== undefined && !opts.force) {
    result.kept.push({ ...base, reason: keepReasonFor(pending) });
    return;
  }

  const entry: ReclaimedEntry = { ...base };
  if (pending !== undefined) {
    entry.destroys = {
      uncommitted: pending.uncommitted,
      unlandedCommits: pending.unlandedCommits,
      baseBranch: pending.baseBranch,
      // remove() reaps a branch only once it is proven merged, so unlanded
      // commits outlive the directory.
      branchKept: pending.unlandedCommits > 0,
    };
  }

  if (opts.dryRun) {
    result.reclaimed.push(entry);
    return;
  }

  try {
    // Without force this re-runs the same checks and fails closed. That is the
    // point: `pendingWork` above is for reporting, `remove()` is the authority.
    const removeOpts: { force?: boolean; base?: BranchRef } = {};
    if (opts.force === true) removeOpts.force = true;
    if (mergeTarget !== undefined) removeOpts.base = mergeTarget;
    await worktrees.remove(wt, removeOpts);
    result.reclaimed.push(entry);
  } catch (err) {
    // Not failures — the correct answer "not yet", from the one place entitled
    // to give it. Reachable even after a clean `pendingWork` if a Crew wrote
    // into the directory in between.
    if (err instanceof DirtyWorktreeError) {
      result.kept.push({ ...base, reason: { kind: 'uncommitted' } });
      return;
    }
    if (err instanceof UnlandedCommitsError) {
      result.kept.push({
        ...base,
        reason: {
          kind: 'unlanded',
          commits: pending?.unlandedCommits ?? (await safeUnlandedCount(worktrees, wt, mergeTarget)),
          baseBranch: err.baseBranch,
        },
      });
      return;
    }
    result.errors.push({ path: wt.path, message: errorText(err) });
  }
}

interface PendingWork {
  uncommitted: boolean;
  unlandedCommits: number;
  baseBranch: string;
}

/**
 * What stands between this worktree and the safe rule, or undefined if nothing
 * does.
 *
 * `base` is the branch the task's work was actually merged into, when the log
 * records one; without it the question is asked of the default branch, which is
 * the conservative answer for work nobody has landed.
 */
async function pendingWork(
  worktrees: WorktreeManager,
  wt: Worktree,
  base: BranchRef | undefined,
): Promise<PendingWork | undefined> {
  const baseBranch = base?.name ?? (await worktrees.defaultBranch());
  const uncommitted = await worktrees.hasUncommittedChanges(wt);
  const unlandedCommits = await worktrees.unlandedCommitCount(
    wt,
    base === undefined ? undefined : { base },
  );
  if (!uncommitted && unlandedCommits === 0) return undefined;
  return { uncommitted, unlandedCommits, baseBranch };
}

/**
 * The branch this task was merged into, if any.
 *
 * Read straight off the projection, so the only thing that can produce one is a
 * `task.merged` event — i.e. a merge this system actually performed and
 * recorded. Undefined for everything else, including a task that is `landed`
 * (verified) but never landed (merged): those two words mean different things
 * and this is the line between them.
 */
function mergeTargetOf(task: Task | undefined): BranchRef | undefined {
  const branch = task?.mergedInto;
  if (branch === undefined || branch.trim() === '') return undefined;
  return localBranchRef(branch);
}

/**
 * Uncommitted work outranks unlanded commits in the report, because it is the
 * one of the two that exists nowhere else: commits survive on the branch.
 */
function keepReasonFor(pending: PendingWork): KeepReason {
  if (pending.uncommitted) return { kind: 'uncommitted' };
  return {
    kind: 'unlanded',
    commits: pending.unlandedCommits,
    baseBranch: pending.baseBranch,
  };
}

async function safeUnlandedCount(
  worktrees: WorktreeManager,
  wt: Worktree,
  base: BranchRef | undefined,
): Promise<number> {
  try {
    return await worktrees.unlandedCommitCount(wt, base === undefined ? undefined : { base });
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Loose directories under the worktree root
// ---------------------------------------------------------------------------

export interface OrphanSweepOptions extends ReclaimOptions {
  /**
   * Paths already spoken for by a `reclaimWorktrees` pass — its `reclaimed` and
   * `kept` paths. Anything here is somebody's worktree and is not debris.
   */
  claimed?: Iterable<string>;
}

/**
 * Sweep directories under the worktree root that no manager claimed.
 *
 * These are what a crash leaves when git's registration goes but the directory
 * stays (or the project was deregistered underneath it). The safety rule still
 * applies, and for a directory git cannot speak for it applies at its strictest:
 * nothing tracks the contents, so safe mode keeps it and says why. Only `force`
 * deletes one, and only when it is genuinely not a git worktree — a live
 * worktree of some other repository is never ours to remove.
 *
 * Separate from `reclaimWorktrees` because the root is shared by every project
 * while a manager only speaks for one: the caller sweeps each manager first,
 * then hands the union of claimed paths here.
 */
export async function sweepOrphanDirectories(
  root: string,
  opts: OrphanSweepOptions = {},
): Promise<ReclaimResult> {
  const result: ReclaimResult = { reclaimed: [], kept: [], bytesFreed: 0, errors: [] };

  const claimed = new Set<string>();
  for (const p of opts.claimed ?? []) claimed.add(path.resolve(p));
  const live = livePathSet([], opts.livePaths);

  let entries: string[];
  try {
    entries = (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    // No root yet means nothing has ever been cut. Not an error.
    return result;
  }

  for (const dir of entries) {
    const resolved = await realpathOr(dir);
    if (claimed.has(resolved) || claimed.has(dir) || live.has(resolved)) continue;

    try {
      const bytes = await directorySize(dir);
      const top = await git(['rev-parse', '--show-toplevel'], dir, { allowFailure: true });
      if (top.exitCode === 0) {
        // A real worktree that no manager claimed: another repository's, or on
        // a branch outside the `blue/` namespace. Not ours, at any force level.
        result.kept.push({ path: resolved, bytes, reason: { kind: 'not-ours' } });
        continue;
      }

      if (!opts.force) {
        result.kept.push({ path: resolved, bytes, reason: { kind: 'debris' } });
        continue;
      }

      if (!opts.dryRun) await fs.rm(dir, { recursive: true, force: true });
      result.reclaimed.push({
        path: resolved,
        bytes,
        // Everything in a directory git cannot speak for is unrecoverable, so
        // the whole of it counts as uncommitted work.
        destroys: { uncommitted: true, unlandedCommits: 0, branchKept: false },
      });
    } catch (err) {
      result.errors.push({ path: dir, message: errorText(err) });
    }
  }

  result.bytesFreed = result.reclaimed.reduce((sum, e) => sum + e.bytes, 0);
  return result;
}

// ---------------------------------------------------------------------------
// Disk accounting
// ---------------------------------------------------------------------------

/**
 * Bytes on disk under `target`, following no symlinks and charging each file
 * its apparent size. Approximate by design — it exists so growth is visible,
 * not to agree with `du` to the block.
 */
/** Trailing slashes and `..` are not a difference between two paths. */
function normalizePath(p: string): string {
  return path.resolve(p);
}

export async function directorySize(target: string): Promise<number> {
  let total = 0;
  const stack: string[] = [target];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Gone, or unreadable. A size we cannot measure is not a reason to fail a
      // sweep — the removal decision never depends on this number.
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        total += (await fs.lstat(full)).size;
      } catch {
        /* raced with a delete; skip it */
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Every branch this sweep must treat as an integration branch.
 *
 * Three sources, because no one of them is complete: the constant (what a fresh
 * project uses), every `Task.mergedInto` in the log (what this fleet has
 * actually merged into, including a project unregistered since), and whatever
 * the caller read off the registry (a recorded `devBranch` that has never been
 * landed into yet).
 */
function integrationBranchSet(
  tasks: Iterable<Task>,
  extra: Iterable<string> | undefined,
): Set<string> {
  const branches = new Set<string>([INTEGRATION_BRANCH]);
  const add = (branch: string | undefined): void => {
    const name = branch?.trim();
    if (name !== undefined && name !== '') branches.add(localBranchRef(name).name);
  };
  for (const branch of extra ?? []) add(branch);
  for (const task of tasks) add(task.mergedInto);
  return branches;
}

function livePathSet(tasks: Iterable<Task>, extra: Iterable<string> | undefined): Set<string> {
  const live = new Set<string>();
  for (const p of extra ?? []) live.add(path.resolve(p));
  for (const task of tasks) {
    if (!isTerminal(task.state) && task.worktree !== undefined) {
      live.add(path.resolve(task.worktree));
    }
  }
  return live;
}

async function realpathOr(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
