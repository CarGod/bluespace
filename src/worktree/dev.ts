/**
 * The integration branch — `blue/dev`, and the only branch BlueSpace ever
 * writes to.
 *
 * The captain's policy, verbatim: *"我们整个结构应该是开发合并永远都在 dev 分支，
 * 最终 main 分支只能通过 pr 来合并，不能自动合并 main 分支."* Development merges
 * always happen on the dev branch; main is reached only through a pull request
 * that a human opens. This module is the half of that policy git can enforce.
 *
 * Three operations live here, and nothing else does:
 *
 *  1. `ensureIntegrationBranch` — create `blue/dev` off the default branch when
 *     it is absent, adopt it when it is present, and refuse a repository whose
 *     branch names make the namespace impossible.
 *  2. `mergeTaskBranch` — merge one task branch into it, in a worktree BlueSpace
 *     owns and deletes afterwards.
 *  3. `integrationStatus` / `isMergedInto` — how far ahead of the default branch
 *     the integration branch is, which is what the pull-request reminder reads.
 *
 * FOUR SAFETY PROPERTIES, in the order they would hurt if they broke:
 *
 *  - **Nothing here can write to the default branch.** The merge target is
 *    asserted three ways immediately before the merge: it must live in the
 *    `blue/` namespace, it must not be the default branch by name or by
 *    resolved ref, and the worktree's own `HEAD` must be a symbolic ref to
 *    exactly it. A merge whose target cannot be proven is refused, not retried.
 *  - **The captain's checkout is never touched.** The merge happens in a
 *    dedicated linked worktree, proven isolated by `assertIsolated` before a
 *    single git command that writes anything is run, and removed afterwards.
 *    Uncommitted work in the captain's own checkout is never at risk, and a
 *    repository that already has `blue/dev` checked out somewhere is refused
 *    rather than merged into through that checkout.
 *  - **A conflict changes nothing.** `git merge --abort` restores the branch,
 *    the pre-merge tip is re-read to prove it, and the conflicting paths come
 *    back as data. No `-X ours`, no rebase, no force, no auto-resolution.
 *  - **No branch is ever deleted here.** In particular the integration branch is
 *    never handed to `WorktreeManager.remove()`, which reaps a branch it has
 *    proven merged — that would delete `blue/dev` the moment its contents
 *    reached main.
 *
 * Every git invocation goes through the argv-array `git()` helper. No shell.
 */

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  BRANCH_PREFIX,
  GitError,
  INTEGRATION_BRANCH,
  assertIsolated,
  git,
  localBranchRef,
  type BranchRef,
  type WorktreeManager,
} from './manager.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The repository's existing branches make `blue/dev` impossible.
 *
 * Git stores branches as files under `.git/refs/heads/`, so it cannot hold both
 * `refs/heads/blue` and `refs/heads/blue/dev` — one would have to be a file and
 * a directory at once. A repository with a bare `blue` branch is therefore
 * already incompatible with BlueSpace's `blue/<taskId>` scheme, and the honest
 * moment to say so is registration, not the middle of a merge.
 */
export class DevBranchConflictError extends Error {
  constructor(
    message: string,
    readonly repoPath: string,
    /** The refs that stand in the way, fully qualified. */
    readonly conflicting: string[],
  ) {
    super(message);
    this.name = 'DevBranchConflictError';
  }
}

/** A merge stopped on conflicting files. Nothing was changed; see `files`. */
export class MergeConflictError extends Error {
  constructor(
    readonly branch: string,
    readonly into: string,
    readonly files: string[],
  ) {
    super(
      `merging ${branch} into ${into} conflicts in ${files.length} file${files.length === 1 ? '' : 's'}` +
        (files.length > 0 ? `: ${files.join(', ')}` : '') +
        `. The merge was aborted; ${into} and ${branch} are exactly as they were.`,
    );
    this.name = 'MergeConflictError';
  }
}

/** The merge target could not be proven to be the integration branch. */
export class MergeTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeTargetError';
  }
}

// ---------------------------------------------------------------------------
// Creating / adopting the integration branch
// ---------------------------------------------------------------------------

export interface DevBranchSetup {
  /** The integration branch, as recorded on the project. */
  branch: string;
  /** True when this call created it; false when it was already there. */
  created: boolean;
  /** The branch it was cut from. Only meaningful when `created`. */
  base: string;
}

/**
 * Make sure `branch` exists, creating it off the default branch if it does not.
 *
 * No prompt and no confirmation, which is the entire point of a collision-proof
 * name: if `blue/dev` exists, BlueSpace made it; if it does not, BlueSpace makes
 * it. The one thing that stops this is a repository whose branch names make the
 * name impossible, and that is refused with the conflicting refs named.
 */
export async function ensureIntegrationBranch(
  worktrees: WorktreeManager,
  branch: string = INTEGRATION_BRANCH,
): Promise<DevBranchSetup> {
  const repoRoot = await worktrees.repoRoot();
  await assertNoBranchNamespaceConflict(repoRoot, branch);

  const ref = localBranchRef(branch);
  if (await refExists(repoRoot, ref.ref)) {
    return { branch, created: false, base: '' };
  }

  // Nothing outside the `blue/` namespace is ever CREATED, whatever a project
  // record says. Adoption above is harmless for any name — it verifies a branch
  // and moves nothing — but creation writes a ref into the captain's repository,
  // and the only refs BlueSpace may write are its own. A project whose
  // `devBranch` was hand-edited to `release` gets a refusal here rather than a
  // surprise branch; `assertMergeTarget` refuses the same name again at merge
  // time, which is the check that matters for `main`.
  if (!branch.startsWith(BRANCH_PREFIX)) {
    throw new MergeTargetError(
      `refusing to create ${branch}: BlueSpace only ever creates branches under ${BRANCH_PREFIX}. ` +
        `If this project should use a different integration branch, create it yourself first.`,
    );
  }

  // Qualified, always. A repository with a TAG named `main` resolves the bare
  // name to the tag, and cutting the integration branch from the wrong commit
  // would put every landed task on top of history nobody is reviewing.
  const base = await worktrees.defaultBranch();
  const baseRef = await worktrees.defaultBranchRef();

  const res = await git(['branch', branch, baseRef], repoRoot, { allowFailure: true });
  if (res.exitCode !== 0) {
    throw new DevBranchConflictError(
      `could not create the integration branch ${branch} in ${repoRoot} from ${base}: ` +
        `${res.stderr.trim()}`,
      repoRoot,
      [],
    );
  }
  return { branch, created: true, base };
}

/**
 * Refuse a repository whose refs collide with `branch`'s path.
 *
 * Two shapes of collision, both fatal and both git's own rule rather than ours:
 * an ancestor of the branch path that is itself a ref (`blue` for `blue/dev`),
 * and any ref living underneath the branch path (`blue/dev/foo`). One
 * `for-each-ref` answers both.
 */
export async function assertNoBranchNamespaceConflict(
  repoPath: string,
  branch: string = INTEGRATION_BRANCH,
): Promise<void> {
  const segments = branch.split('/').filter((s) => s !== '');
  const ancestors = new Set<string>();
  for (let i = 1; i < segments.length; i += 1) {
    ancestors.add(`refs/heads/${segments.slice(0, i).join('/')}`);
  }

  // The pattern matches the ref itself and everything under it, which is
  // exactly the set that can collide.
  const listed = await git(
    ['for-each-ref', '--format=%(refname)', `refs/heads/${segments[0] ?? branch}`],
    repoPath,
    { allowFailure: true },
  );
  const refs = listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const blockers = refs.filter(
    (ref) => ancestors.has(ref) || ref.startsWith(`refs/heads/${branch}/`),
  );
  if (blockers.length === 0) return;

  const bare = blockers.filter((ref) => ancestors.has(ref));
  throw new DevBranchConflictError(
    bare.length > 0
      ? `this repository has a branch named "${bare[0]?.slice('refs/heads/'.length) ?? ''}", which cannot coexist with ${branch}: ` +
          `git stores branches as paths, so "${bare[0]?.slice('refs/heads/'.length) ?? ''}" and "${branch}" would have to be a file and a directory at once. ` +
          `BlueSpace also cuts every task branch as ${BRANCH_PREFIX}<taskId>, so this repository cannot be used until that branch is renamed or deleted.`
      : `this repository has ${blockers.length} branch(es) under ${branch}/ (${blockers
          .map((r) => r.slice('refs/heads/'.length))
          .join(', ')}), which prevents ${branch} from existing at all. Rename or delete them first.`,
    repoPath,
    blockers,
  );
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

export interface MergeInput {
  worktrees: WorktreeManager;
  /** The task branch to merge, e.g. `blue/<taskId>`. */
  branch: string;
  /** The integration branch to merge INTO, as recorded on the project. */
  into: string;
  /** Merge commit message. */
  message: string;
}

export interface MergeReport {
  branch: string;
  into: string;
  /** Tip of `into` before the merge. */
  before: string;
  /** Tip of `into` after it. Equal to `before` when `alreadyMerged`. */
  commit: string;
  /** True when `branch` was already contained in `into` and nothing moved. */
  alreadyMerged: boolean;
  /** The default branch, by name — reported so a caller can say what was NOT touched. */
  defaultBranch: string;
  /**
   * True if the default branch's tip changed while we were merging.
   *
   * Nothing here can move it, so this is not a self-check that can fail: it is
   * the captain committing in their own checkout at the same moment. Reported
   * rather than thrown so a concurrent commit never fails a good merge.
   */
  defaultBranchMoved: boolean;
}

/**
 * Merge one task branch into the integration branch, in a worktree we own.
 *
 * The sequence is deliberate and none of it is reorderable: prove the target,
 * cut an isolated worktree, prove the worktree is on the target, merge, prove
 * the result, remove the worktree.
 */
export async function mergeTaskBranch(input: MergeInput): Promise<MergeReport> {
  const { worktrees, branch, into, message } = input;
  const repoRoot = await worktrees.repoRoot();

  const target = await assertMergeTarget(worktrees, into, branch);
  const source = localBranchRef(branch);

  const sourceTip = await resolveCommit(repoRoot, source.ref);
  if (sourceTip === undefined) {
    throw new MergeTargetError(
      `branch ${branch} does not exist in ${repoRoot}; there is nothing to merge. ` +
        `If this task was landed already, \`blue gc\` reaps a branch once ${into} holds its ` +
        `commits — \`blue log <taskId>\` shows the merge.`,
    );
  }
  const before = await resolveCommit(repoRoot, target.ref);
  if (before === undefined) {
    throw new MergeTargetError(
      `the integration branch ${into} does not exist in ${repoRoot}. It is created at ` +
        `registration; recreate it with \`blue projects add\` or land again once it is back.`,
    );
  }

  const defaultBranch = await worktrees.defaultBranch();
  const defaultRef = await worktrees.defaultBranchRef();
  const defaultBefore = await resolveCommit(repoRoot, defaultRef);

  // Nothing to do: the branch is already contained. Reported rather than
  // merged, so landing twice is idempotent instead of producing an empty merge.
  if (await isAncestor(repoRoot, sourceTip, before)) {
    return {
      branch,
      into,
      before,
      commit: before,
      alreadyMerged: true,
      defaultBranch,
      defaultBranchMoved: false,
    };
  }

  // Stale registrations from a previous run (a directory deleted out from under
  // git, a process killed mid-merge) would otherwise refuse the path below.
  await git(['worktree', 'prune'], repoRoot, { allowFailure: true });
  await removeStaleLandWorktrees(repoRoot);

  const dir = path.join(os.tmpdir(), `${LAND_PREFIX}${randomUUID()}`);
  const added = await git(['worktree', 'add', '--quiet', dir, target.name], repoRoot, {
    allowFailure: true,
  });
  if (added.exitCode !== 0) {
    // The commonest cause by far: `blue/dev` is checked out somewhere already —
    // possibly in the captain's own checkout. Merging through THAT would write
    // into their working copy, so this is a refusal, not a fallback.
    throw new MergeTargetError(
      `could not create a worktree on ${into} to merge into: ${added.stderr.trim()}. ` +
        `If ${into} is checked out somewhere, switch that checkout to another branch and land again — ` +
        `BlueSpace will not merge through a checkout it does not own.`,
    );
  }

  let landPath: string;
  try {
    landPath = await fs.realpath(dir);
    // The one guard that makes every line after it safe to run.
    await assertIsolated(landPath, repoRoot);
    await assertWorktreeIsOn(landPath, target, before);
  } catch (err) {
    await removeLandWorktree(repoRoot, dir);
    throw err;
  }

  try {
    const merged = await git(
      ['merge', '--no-ff', '--no-edit', '-m', message, source.ref],
      landPath,
      { allowFailure: true },
    );

    if (merged.exitCode !== 0) {
      const files = await conflictedFiles(landPath);
      await git(['merge', '--abort'], landPath, { allowFailure: true });

      // Prove the abort actually restored the branch rather than assuming it.
      const after = await resolveCommit(repoRoot, target.ref);
      if (after !== before) {
        throw new Error(
          `merge of ${branch} into ${into} failed and the abort did not restore it ` +
            `(${into} was ${before}, is now ${after ?? 'unresolvable'}). Nothing further was attempted; ` +
            `inspect the repository at ${repoRoot} by hand.`,
        );
      }
      if (files.length > 0) throw new MergeConflictError(branch, into, files);
      throw new GitError(['merge', branch], landPath, merged.exitCode, merged.stderr);
    }

    const commit = await resolveCommit(repoRoot, target.ref);
    if (commit === undefined || commit === before) {
      throw new Error(
        `merge of ${branch} into ${into} reported success but ${into} did not move; ` +
          `nothing was recorded.`,
      );
    }

    const defaultAfter = await resolveCommit(repoRoot, defaultRef);
    return {
      branch,
      into,
      before,
      commit,
      alreadyMerged: false,
      defaultBranch,
      defaultBranchMoved: defaultBefore !== defaultAfter,
    };
  } finally {
    await removeLandWorktree(repoRoot, dir);
  }
}

/**
 * Prove `into` is a branch we are allowed to merge into, three independent ways.
 *
 * This is the assertion the whole delivery design rests on, so it is made from
 * the recorded branch name every time rather than cached, and it runs
 * immediately before the worktree is cut.
 */
async function assertMergeTarget(
  worktrees: WorktreeManager,
  into: string,
  branch: string,
): Promise<BranchRef> {
  const target = localBranchRef(into);

  if (!into.startsWith(BRANCH_PREFIX)) {
    throw new MergeTargetError(
      `refusing to merge into ${into}: BlueSpace only ever merges into a branch in the ` +
        `${BRANCH_PREFIX} namespace. Landing never touches a branch outside it.`,
    );
  }
  if (into === branch) {
    throw new MergeTargetError(`refusing to merge ${branch} into itself`);
  }

  const defaultName = await worktrees.defaultBranch();
  const defaultRef = await worktrees.defaultBranchRef();
  if (target.name === defaultName || target.ref === defaultRef) {
    throw new MergeTargetError(
      `refusing to merge into ${into}: that is the default branch. Nothing in BlueSpace ` +
        `merges into ${defaultName} — it is reached only by a pull request the captain opens.`,
    );
  }
  return target;
}

/** The land worktree must be attached to exactly the target branch, at its tip. */
async function assertWorktreeIsOn(
  landPath: string,
  target: BranchRef,
  expectedTip: string,
): Promise<void> {
  const head = await git(['symbolic-ref', '--quiet', 'HEAD'], landPath, { allowFailure: true });
  const headRef = head.stdout.trim();
  if (head.exitCode !== 0 || headRef !== target.ref) {
    throw new MergeTargetError(
      `refusing to merge: the worktree at ${landPath} is on ${headRef || 'a detached HEAD'}, ` +
        `not on ${target.ref}`,
    );
  }
  const tip = (await git(['rev-parse', 'HEAD'], landPath)).stdout.trim();
  if (tip !== expectedTip) {
    throw new MergeTargetError(
      `refusing to merge: ${target.name} moved between checks (${expectedTip} -> ${tip})`,
    );
  }
}

/** Paths git left with conflict markers, one per line. */
async function conflictedFiles(cwd: string): Promise<string[]> {
  const res = await git(['diff', '--name-only', '--diff-filter=U'], cwd, { allowFailure: true });
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Directory-name prefix for the worktree a merge happens in.
 *
 * Under `os.tmpdir()` and nowhere near `<dataDir>/worktrees/`, because unlike a
 * Crew's worktree this one holds nothing that exists only in it: it is a
 * checkout of a branch, made for one merge, deleted immediately after. Putting
 * it with the deliverables would leave `blue gc` reporting it as a directory it
 * does not manage, forever, if a process ever died at the wrong moment.
 */
const LAND_PREFIX = 'bluespace-land-';

/**
 * Clear the debris a process killed mid-merge would leave.
 *
 * Without this, one crash makes every future land in that repository fail with
 * "blue/dev is already checked out" pointing at a temp directory nobody will
 * ever look in. The guards are deliberately narrow — a registered worktree
 * whose directory name carries OUR prefix and which lives under the system
 * temp directory. Nothing a captain made can match both, and a directory that
 * does match holds no work: it is a checkout of the integration branch, made
 * by this function's caller, whose merge either finished or was aborted.
 */
async function removeStaleLandWorktrees(repoRoot: string): Promise<void> {
  const listed = await git(['worktree', 'list', '--porcelain'], repoRoot, { allowFailure: true });
  if (listed.exitCode !== 0) return;

  const tmp = await fs.realpath(os.tmpdir()).catch(() => os.tmpdir());
  for (const line of listed.stdout.split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const dir = line.slice('worktree '.length).trim();
    if (dir === '') continue;
    if (!path.basename(dir).startsWith(LAND_PREFIX)) continue;
    const parent = path.dirname(dir);
    if (parent !== tmp && parent !== os.tmpdir()) continue;
    await removeLandWorktree(repoRoot, dir);
  }
}

/**
 * Is this path the primary checkout — the captain's own working copy?
 *
 * `git worktree list` puts the primary checkout first, so every sweep over that
 * output has to be able to recognise and skip it. Compared by realpath because
 * `os.tmpdir()` is a symlink on macOS and the two spellings must not disagree.
 */
async function isPrimaryCheckout(dir: string, repoRoot: string): Promise<boolean> {
  const resolve = async (p: string): Promise<string> =>
    fs.realpath(p).catch(() => path.resolve(p));
  return (await resolve(dir)) === (await resolve(repoRoot));
}

/**
 * Remove the worktree we cut for the merge — and ONLY through raw git.
 *
 * `WorktreeManager.remove()` deletes a branch it has proven merged, so handing
 * it this worktree would delete the integration branch the moment its contents
 * reached main. Best effort throughout: a leftover directory costs disk, while
 * throwing here would report a completed merge as a failure.
 */
async function removeLandWorktree(repoRoot: string, dir: string): Promise<void> {
  // THE ONE PATH THAT MUST NEVER BE TAKEN. `git worktree remove` refuses the
  // primary checkout ("is a main working tree", exit 128) — and the fallback
  // below is a recursive delete that would not refuse anything. The only way
  // `dir` can be the primary checkout is a repository whose root is itself
  // named `<tmpdir>/bluespace-land-*`, which `removeStaleLandWorktrees` would
  // then match; vanishingly unlikely, and it would delete the captain's entire
  // repository, so it is checked rather than argued about.
  if (await isPrimaryCheckout(dir, repoRoot)) return;

  const removed = await git(['worktree', 'remove', '--force', dir], repoRoot, {
    allowFailure: true,
  });
  if (removed.exitCode === 0) return;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await git(['worktree', 'prune'], repoRoot, { allowFailure: true });
}

// ---------------------------------------------------------------------------
// How far ahead of the default branch the integration branch is
// ---------------------------------------------------------------------------

export interface IntegrationStatus {
  devBranch: string;
  /** False when the branch has not been created (or the captain deleted it). */
  exists: boolean;
  defaultBranch: string;
  /** Commits on the integration branch that the default branch does not have. */
  ahead: number;
  /** Commits on the default branch that the integration branch does not have. */
  behind: number;
  /** True when the repository has an `origin` remote to open a pull request against. */
  hasOrigin: boolean;
}

/** Where the integration branch stands relative to the default branch. */
export async function integrationStatus(
  worktrees: WorktreeManager,
  devBranch: string = INTEGRATION_BRANCH,
): Promise<IntegrationStatus> {
  const repoRoot = await worktrees.repoRoot();
  const dev = localBranchRef(devBranch);
  const defaultBranch = await worktrees.defaultBranch();
  const defaultRef = await worktrees.defaultBranchRef();

  const base: IntegrationStatus = {
    devBranch,
    exists: false,
    defaultBranch,
    ahead: 0,
    behind: 0,
    hasOrigin: await hasOrigin(repoRoot),
  };

  const devTip = await resolveCommit(repoRoot, dev.ref);
  const defaultTip = await resolveCommit(repoRoot, defaultRef);
  if (devTip === undefined || defaultTip === undefined) return base;

  // Object ids, not names: the range must not be re-interpreted as a tag.
  const counts = await git(
    ['rev-list', '--left-right', '--count', `${defaultTip}...${devTip}`, '--'],
    repoRoot,
    { allowFailure: true },
  );
  if (counts.exitCode !== 0) return { ...base, exists: true };

  const [behindRaw, aheadRaw] = counts.stdout.trim().split(/\s+/);
  const behind = Number.parseInt(behindRaw ?? '', 10);
  const ahead = Number.parseInt(aheadRaw ?? '', 10);

  return {
    ...base,
    exists: true,
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
}

/**
 * Is `commit` already contained in `branch`?
 *
 * This is what makes the pull-request reminder go quiet by itself: once the
 * captain's PR merges `blue/dev` into main, every landed task's merge commit
 * becomes an ancestor of main and stops counting as pending delivery. Answers
 * false for anything it cannot resolve — a reminder that overstates is noise, a
 * reminder that vanishes is a captain who never hears about landed work.
 */
export async function isMergedInto(
  worktrees: WorktreeManager,
  commit: string,
  /**
   * The branch to test containment in, as a rev. Pass a FULLY QUALIFIED ref
   * (`refs/heads/main`, `refs/remotes/origin/main`): the default branch is
   * `origin/main` in a repository with no local copy, and a short name is what
   * lets a tag answer in a branch's place.
   */
  rev: string,
): Promise<boolean> {
  const repoRoot = await worktrees.repoRoot();
  const target = await resolveCommit(repoRoot, rev);
  if (target === undefined) return false;
  const tip = await resolveCommit(repoRoot, commit);
  if (tip === undefined) return false;
  return isAncestor(repoRoot, tip, target);
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await resolveCommit(cwd, ref)) !== undefined;
}

async function resolveCommit(cwd: string, ref: string): Promise<string | undefined> {
  const res = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd, {
    allowFailure: true,
  });
  if (res.exitCode !== 0) return undefined;
  const oid = res.stdout.trim();
  return oid === '' ? undefined : oid;
}

async function isAncestor(cwd: string, maybeAncestor: string, descendant: string): Promise<boolean> {
  const res = await git(['merge-base', '--is-ancestor', maybeAncestor, descendant], cwd, {
    allowFailure: true,
  });
  return res.exitCode === 0;
}

async function hasOrigin(cwd: string): Promise<boolean> {
  const res = await git(['remote', 'get-url', 'origin'], cwd, { allowFailure: true });
  return res.exitCode === 0 && res.stdout.trim() !== '';
}
