/**
 * Git worktree lifecycle — the physical isolation layer under every Crew.
 *
 * One task, one worktree, one branch (`blue/<taskId>`), one disposable directory.
 * A Crew never touches the captain's checkout: it is handed a linked worktree cut
 * from the default branch, and that isolation is asserted (not assumed) before the
 * path is ever returned. If the assertion fails we throw rather than hand a Crew a
 * loaded gun pointed at the primary checkout.
 *
 * Two properties this module is responsible for:
 *   1. ISOLATION — `assertIsolated` proves the returned path is a real *linked*
 *      worktree root and is not the primary checkout, by realpath, by inode, and
 *      by git-dir vs git-common-dir. Enforced on every create().
 *   2. FAIL CLOSED ON DESTRUCTION — remove() refuses to delete a worktree with
 *      uncommitted changes or with commits not reachable from the default branch,
 *      unless the caller explicitly forces it. Losing a Crew's work silently is
 *      the worst failure mode this system can have.
 *
 * Every git invocation goes through execFile with an argv ARRAY. No shell, ever,
 * so no amount of hostile input in a task id or a path can become a command.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Diffs and status output can be large; 64MiB before we consider it pathological. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Every BlueSpace branch lives under this namespace. list() filters on it.
 *
 * Exported because the integration branch, the task branches and the D/F
 * conflict check in `dev.ts` all have to agree on it, and three literals that
 * agree today are a bug scheduled for later.
 */
export const BRANCH_PREFIX = 'blue/';

/**
 * The one branch every landed task is merged into. THE ONLY MERGE TARGET IN
 * BLUESPACE — nothing here ever writes to `main`.
 *
 * Fixed and namespaced rather than configurable or confirmed, and both halves of
 * that are deliberate:
 *
 *  - `blue/dev` sits in the same namespace as the task branches (`blue/<taskId>`),
 *    so it groups with them in `git branch` and no human creates it by accident.
 *    A name that essentially cannot collide is a name that needs no confirmation
 *    dance: if it exists, BlueSpace made it; if it does not, BlueSpace makes it.
 *  - It deliberately avoids the word "tag". This repository already lost work
 *    once to a TAG named `main` shadowing the BRANCH named `main` (see
 *    `defaultBranchRef` below), and a branch whose name contains "tag" invites
 *    that confusion straight back in.
 *
 * The one real edge is that git cannot hold both `refs/heads/blue` and
 * `refs/heads/blue/dev`. A repository with a bare `blue` branch is already
 * incompatible with the `blue/<taskId>` scheme, so it is detected and refused at
 * registration — see `assertNoBranchNamespaceConflict` in `./dev.ts`.
 *
 * Read the recorded `Project.devBranch` in preference to this constant wherever
 * a project is in hand: renaming this must not silently retarget old projects.
 */
export const INTEGRATION_BRANCH = `${BRANCH_PREFIX}dev`;

/** The branch a task's Crew works on. One task, one branch, one worktree. */
export function taskBranchName(taskId: string): string {
  return `${BRANCH_PREFIX}${taskId}`;
}

/**
 * A branch in both the forms every reachability question needs: the short name
 * a human reads and the fully-qualified ref git may not misinterpret.
 */
export interface BranchRef {
  name: string;
  ref: string;
}

/**
 * Qualify a local branch name. `blue/dev` becomes `refs/heads/blue/dev`, which
 * is the only form safe to hand to `rev-list` — see `defaultBranchRef()`.
 */
export function localBranchRef(branch: string): BranchRef {
  return branch.startsWith('refs/')
    ? { name: branch.replace(/^refs\/heads\//, ''), ref: branch }
    : { name: branch, ref: `refs/heads/${branch}` };
}

/** The well-known empty tree object, used as a diff base when there is no merge base. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * What `countUnlanded` reports when git could not answer.
 *
 * Any non-zero value refuses the removal and keeps the branch, which is the
 * whole point; 1 is chosen so the captain reads "1 commit not in main" rather
 * than a number the repository cannot justify.
 */
const UNKNOWN_IS_UNLANDED = 1;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Worktree {
  /** Canonical (realpath-resolved) absolute path to the worktree root. */
  path: string;
  /** Full branch name, e.g. `blue/3f2a...`. */
  branch: string;
  /** Canonical absolute path to the primary checkout this worktree belongs to. */
  repoPath: string;
  taskId: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a path that is supposed to be a disposable worktree cannot be
 * proven distinct from the primary checkout. Callers must treat this as fatal:
 * dispatching a Crew anyway would let it write to the captain's repo.
 */
export class NotIsolatedError extends Error {
  constructor(
    message: string,
    readonly worktreePath?: string,
    readonly repoPath?: string,
  ) {
    super(message);
    this.name = 'NotIsolatedError';
  }
}

/** A git command exited non-zero. Carries argv and stderr for diagnosis. */
export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly cwd: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(
      `git ${args.join(' ')} failed in ${cwd} (exit ${exitCode ?? 'null'})` +
        (stderr.trim() ? `: ${stderr.trim()}` : ''),
    );
    this.name = 'GitError';
  }
}

/** remove() refused: the worktree has uncommitted work. Pass `{ force: true }` to override. */
export class DirtyWorktreeError extends Error {
  constructor(readonly worktree: Worktree) {
    super(
      `refusing to remove worktree ${worktree.path}: it has uncommitted changes. ` +
        `Pass { force: true } to discard them.`,
    );
    this.name = 'DirtyWorktreeError';
  }
}

/** remove() refused: the branch holds commits not reachable from the default branch. */
export class UnlandedCommitsError extends Error {
  constructor(
    readonly worktree: Worktree,
    readonly baseBranch: string,
  ) {
    super(
      `refusing to remove worktree ${worktree.path}: branch ${worktree.branch} has commits ` +
        `not reachable from ${baseBranch}. Pass { force: true } to discard them.`,
    );
    this.name = 'UnlandedCommitsError';
  }
}

// ---------------------------------------------------------------------------
// git plumbing
// ---------------------------------------------------------------------------

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitOpts {
  /** Return the failure instead of throwing. Use when non-zero is a real answer. */
  allowFailure?: boolean;
  /** Extra environment for this invocation (e.g. GIT_INDEX_FILE). */
  env?: Record<string, string>;
}

function isExecError(e: unknown): e is { code?: number; stdout?: string; stderr?: string } {
  return typeof e === 'object' && e !== null;
}

/**
 * Run git with an argv array. Never a shell string — user-controlled values
 * (task ids, paths, branch names) are arguments, and can never be commands.
 *
 * Exported for `reclaim.ts`, which has to interrogate directories this manager
 * does not own. It is module-internal plumbing, not public API: `index.ts` does
 * not re-export it, and nothing outside `src/worktree/` may shell out to git.
 */
export async function git(args: string[], cwd: string, opts: GitOpts = {}): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      env: {
        ...process.env,
        // Never block on a credential or passphrase prompt inside an orchestrator.
        GIT_TERMINAL_PROMPT: '0',
        ...opts.env,
      },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (e: unknown) {
    const exitCode = isExecError(e) && typeof e.code === 'number' ? e.code : null;
    const stdout = (isExecError(e) && e.stdout) || '';
    const stderr = (isExecError(e) && e.stderr) || (e instanceof Error ? e.message : String(e));
    if (opts.allowFailure) return { stdout, stderr, exitCode: exitCode ?? 1 };
    throw new GitError(args, cwd, exitCode, stderr);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** realpath if it exists, otherwise the resolved-but-unresolved path. */
async function realpathOr(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * A task id becomes both a branch name component and a directory name, so it is
 * validated rather than trusted. randomUUID() ids pass; anything that could climb
 * out of a directory or confuse git's refname rules does not.
 */
function assertSafeTaskId(taskId: string): void {
  const ok =
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(taskId) &&
    !taskId.includes('..') &&
    !taskId.endsWith('.lock');
  if (!ok) {
    throw new Error(
      `unsafe taskId ${JSON.stringify(taskId)}: must be 1-128 chars of [A-Za-z0-9._-], ` +
        `start alphanumeric, contain no ".." and not end in ".lock"`,
    );
  }
}

// ---------------------------------------------------------------------------
// Isolation assertion — exported standalone so any module can re-verify
// ---------------------------------------------------------------------------

/**
 * Prove `worktreePath` is a disposable linked worktree of the repository at
 * `repoPath`, and is NOT the primary checkout. Throws NotIsolatedError otherwise.
 *
 * Four independent checks, because any one of them can be defeated by symlinks,
 * bind mounts, or a caller that passed the wrong path:
 *   1. it is a git worktree ROOT (its --show-toplevel is itself);
 *   2. its realpath differs from the primary checkout's realpath;
 *   3. its device+inode differ from the primary checkout's;
 *   4. its --git-dir differs from its --git-common-dir, which is true for linked
 *      worktrees and false for a primary checkout; and that common dir is the
 *      same repository the caller named.
 */
export async function assertIsolated(worktreePath: string, repoPath: string): Promise<void> {
  const wtReal = await realpathOr(worktreePath);
  const repoReal = await realpathOr(repoPath);

  if (!(await pathExists(wtReal))) {
    throw new NotIsolatedError(`worktree path does not exist: ${wtReal}`, wtReal, repoReal);
  }

  // (1) It must be the ROOT of a worktree, not a subdirectory of one.
  const topRes = await git(['rev-parse', '--show-toplevel'], wtReal, { allowFailure: true });
  if (topRes.exitCode !== 0) {
    throw new NotIsolatedError(
      `not a git worktree: ${wtReal} (${topRes.stderr.trim()})`,
      wtReal,
      repoReal,
    );
  }
  const top = await realpathOr(topRes.stdout.trim());
  if (top !== wtReal) {
    throw new NotIsolatedError(
      `${wtReal} is not a worktree root; its repository root is ${top}`,
      wtReal,
      repoReal,
    );
  }

  // The primary checkout's root, resolved the same way.
  const primaryRes = await git(['rev-parse', '--show-toplevel'], repoReal, { allowFailure: true });
  if (primaryRes.exitCode !== 0) {
    throw new NotIsolatedError(
      `not a git repository: ${repoReal} (${primaryRes.stderr.trim()})`,
      wtReal,
      repoReal,
    );
  }
  const primary = await realpathOr(primaryRes.stdout.trim());

  // (2) Path identity.
  if (top === primary) {
    throw new NotIsolatedError(
      `worktree path is the primary checkout itself: ${primary}`,
      wtReal,
      repoReal,
    );
  }

  // (3) Inode identity — catches hardlinked/bind-mounted aliases realpath misses.
  const [wtStat, primaryStat] = await Promise.all([fs.stat(top), fs.stat(primary)]);
  if (wtStat.dev === primaryStat.dev && wtStat.ino === primaryStat.ino) {
    throw new NotIsolatedError(
      `worktree ${top} is the same inode as the primary checkout ${primary}`,
      wtReal,
      repoReal,
    );
  }

  // (4) Linked-worktree identity: --git-dir is <common>/worktrees/<name> for a
  //     linked worktree and equals --git-common-dir for a primary checkout.
  const wtGitDir = await resolveGitPath(top, '--git-dir');
  const wtCommonDir = await resolveGitPath(top, '--git-common-dir');
  if (wtGitDir === wtCommonDir) {
    throw new NotIsolatedError(
      `${top} is a primary checkout, not a linked worktree (git-dir === git-common-dir)`,
      wtReal,
      repoReal,
    );
  }

  const repoCommonDir = await resolveGitPath(primary, '--git-common-dir');
  if (wtCommonDir !== repoCommonDir) {
    throw new NotIsolatedError(
      `worktree ${top} belongs to repository ${wtCommonDir}, not ${repoCommonDir}`,
      wtReal,
      repoReal,
    );
  }
}

/** `git rev-parse <flag>` returns a path that may be relative to cwd (e.g. ".git"). */
async function resolveGitPath(cwd: string, flag: '--git-dir' | '--git-common-dir'): Promise<string> {
  const res = await git(['rev-parse', flag], cwd);
  return realpathOr(path.resolve(cwd, res.stdout.trim()));
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class WorktreeManager {
  /** As given by the caller; the resolved primary root is discovered lazily. */
  private readonly repoPathInput: string;
  private readonly rootInput: string;
  private repoRootCache?: string;

  constructor(repoPath: string, opts?: { root?: string }) {
    this.repoPathInput = path.resolve(repoPath);
    this.rootInput = opts?.root
      ? path.resolve(opts.root)
      : path.join(os.tmpdir(), 'bluespace-worktrees');
  }

  /** Where worktree directories are created. Not canonicalized until it exists. */
  get root(): string {
    return this.rootInput;
  }

  /** Canonical absolute path of the primary checkout's top level. */
  async repoRoot(): Promise<string> {
    if (this.repoRootCache) return this.repoRootCache;
    const res = await git(['rev-parse', '--show-toplevel'], this.repoPathInput, {
      allowFailure: true,
    });
    if (res.exitCode !== 0) {
      throw new GitError(
        ['rev-parse', '--show-toplevel'],
        this.repoPathInput,
        res.exitCode,
        res.stderr,
      );
    }
    const root = await realpathOr(res.stdout.trim());
    this.repoRootCache = root;
    return root;
  }

  /**
   * The branch new worktrees are cut from, as a SHORT name (`main`,
   * `origin/main`) — what `git worktree add` takes and what a human reads.
   *
   * origin/HEAD wins, then main, then master. A local branch is preferred over
   * its remote-tracking counterpart so the Crew branches from what the captain
   * actually has checked out.
   *
   * Anything that decides whether work may be DELETED must use
   * `defaultBranchRef()` instead. See the warning there.
   */
  async defaultBranch(): Promise<string> {
    return (await this.resolveDefaultBranch()).name;
  }

  /**
   * The same branch, fully qualified (`refs/heads/main`, `refs/remotes/origin/main`).
   *
   * A short name is AMBIGUOUS, and the ambiguity is silent and destructive. Git
   * resolves a bare `main` in this order: refs/main, refs/tags/main,
   * refs/heads/main, refs/remotes/main, refs/remotes/main/HEAD — so a repository
   * that also has a TAG called `main` (git permits it) answers
   * `rev-list --count main..blue/x` against the tag. It warns on stderr, which
   * nothing here reads, and exits 0. A branch holding two unmerged commits then
   * measures as fully merged, and the safe sweep deletes the worktree AND
   * `git branch -D`s the only ref that reached those commits.
   *
   * That is the one bug this whole module exists to make impossible, so every
   * reachability question asks for the qualified ref and every range is computed
   * from resolved object ids.
   */
  async defaultBranchRef(): Promise<string> {
    return (await this.resolveDefaultBranch()).ref;
  }

  private async resolveDefaultBranch(): Promise<{ name: string; ref: string }> {
    const repoRoot = await this.repoRoot();

    const candidates: string[] = [];
    const sym = await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repoRoot, {
      allowFailure: true,
    });
    if (sym.exitCode === 0) {
      const ref = sym.stdout.trim();
      const short = ref.startsWith('refs/remotes/origin/')
        ? ref.slice('refs/remotes/origin/'.length)
        : '';
      if (short) candidates.push(short);
    }
    for (const fallback of ['main', 'master']) {
      if (!candidates.includes(fallback)) candidates.push(fallback);
    }

    for (const name of candidates) {
      const local = `refs/heads/${name}`;
      if (await this.revExists(repoRoot, local)) return { name, ref: local };
      const remote = `refs/remotes/origin/${name}`;
      if (await this.revExists(repoRoot, remote)) return { name: `origin/${name}`, ref: remote };
    }

    throw new Error(
      `cannot determine default branch for ${repoRoot}: tried ${candidates.join(', ')} ` +
        `as local branches and origin remotes, none exist`,
    );
  }

  private async revExists(cwd: string, ref: string): Promise<boolean> {
    return (await this.resolveCommit(cwd, ref)) !== undefined;
  }

  /** The object id `ref` names, or undefined when it names no commit. */
  private async resolveCommit(cwd: string, ref: string): Promise<string | undefined> {
    const res = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd, {
      allowFailure: true,
    });
    if (res.exitCode !== 0) return undefined;
    const oid = res.stdout.trim();
    return oid.length > 0 ? oid : undefined;
  }

  /**
   * Cut a fresh worktree for a task: `git worktree add -b blue/<taskId> <path> <base>`.
   * Returns only after isolation has been proven.
   */
  async create(taskId: string): Promise<Worktree> {
    assertSafeTaskId(taskId);

    const repoRoot = await this.repoRoot();
    // QUALIFIED, for the same reason every reachability question is. `git
    // worktree add -b <new> <path> main` in a repository that also has a TAG
    // called `main` does not pick one and carry on — it exits 128 with
    // "fatal: ambiguous object name: 'main'", and no Crew can ever be
    // dispatched against that repository. The ref form has no other reading.
    const base = await this.defaultBranchRef();
    const root = await this.ensureRoot();
    const branch = taskBranchName(taskId);
    // A task called `dev` would cut its worktree on the integration branch
    // itself, and every merge into it afterwards would be a merge into a
    // directory a Crew is editing. Ids are UUIDs, so this is the second belt.
    if (branch === INTEGRATION_BRANCH) {
      throw new Error(
        `taskId ${JSON.stringify(taskId)} would collide with the integration branch ${INTEGRATION_BRANCH}`,
      );
    }
    const target = path.join(root, `${path.basename(repoRoot)}-${taskId}`);

    // Clear stale registrations (directories deleted out from under git) so a
    // retry of a previously-reaped task can reuse its path.
    await git(['worktree', 'prune'], repoRoot, { allowFailure: true });

    await git(['worktree', 'add', '-b', branch, target, base], repoRoot);

    // macOS: os.tmpdir() is /var/... which is a symlink to /private/var. Every
    // consumer compares this path against git output, so canonicalize once here.
    const real = await fs.realpath(target);
    await assertIsolated(real, repoRoot);

    return { path: real, branch, repoPath: repoRoot, taskId };
  }

  /**
   * Take over a directory another task left behind, and cut this task's branch
   * at whatever is in it right now.
   *
   * WHY THE DIRECTORY AND NOT THE BRANCH. Measured across a fleet that died to a
   * token ceiling: every dead task had four to nine modified files and ZERO
   * commits, because Crews commit at the end of the job rather than as they go.
   * A resume that branched off the dead branch would inherit an empty tree and
   * the captain would pay for the same work twice. `git switch -c` carries the
   * working tree across with it, which is the entire value being rescued.
   *
   * The ancestor's branch is left exactly where it was — it is the record of
   * what that run committed, which is nothing, and rewriting history to say
   * otherwise is not this function's business.
   */
  async adopt(taskId: string, from: string): Promise<Worktree> {
    assertSafeTaskId(taskId);
    const repoRoot = await this.repoRoot();
    const branch = taskBranchName(taskId);
    if (branch === INTEGRATION_BRANCH) {
      throw new Error(
        `taskId ${JSON.stringify(taskId)} would collide with the integration branch ${INTEGRATION_BRANCH}`,
      );
    }

    let real: string;
    try {
      real = await fs.realpath(from);
    } catch {
      throw new Error(`cannot resume: the worktree ${from} is gone`);
    }

    // It must still be a worktree of THIS repository. A directory that merely
    // exists at the recorded path is not evidence of anything.
    const top = await git(['rev-parse', '--show-toplevel'], real, { allowFailure: true });
    if (top.exitCode !== 0 || (await fs.realpath(top.stdout.trim())) !== real) {
      throw new Error(`cannot resume: ${real} is not a git worktree root`);
    }
    await assertIsolated(real, repoRoot);

    // `switch -c` keeps uncommitted changes; `-C` would be a reset. If the
    // branch somehow exists already, switching to it is the right answer — a
    // second resume of the same task should not invent a third name.
    const cut = await git(['switch', '-c', branch], real, { allowFailure: true });
    if (cut.exitCode !== 0) {
      const swap = await git(['switch', branch], real, { allowFailure: true });
      if (swap.exitCode !== 0) {
        throw new Error(`cannot resume: could not put ${branch} on ${real} (${cut.stderr.trim()})`);
      }
    }

    return { path: real, branch, repoPath: repoRoot, taskId };
  }

  private async ensureRoot(): Promise<string> {
    await fs.mkdir(this.rootInput, { recursive: true });
    return fs.realpath(this.rootInput);
  }

  /**
   * Every `blue/<taskId>` worktree registered against this repository.
   *
   * The integration branch is excluded, and that exclusion is load-bearing
   * rather than tidy. A checkout of `blue/dev` matches the `blue/` prefix, so
   * without this it would be listed as a worktree whose "task id" is `dev` —
   * and the sweep in `reclaim.ts` would then consider it, find no task for it,
   * and (whenever `blue/dev` happened to be fully merged into main) hand it to
   * `remove()`, which reaps a branch it has proven merged. That is the
   * integration branch deleted by the garbage collector.
   */
  async list(): Promise<Worktree[]> {
    const repoRoot = await this.repoRoot();
    const res = await git(['worktree', 'list', '--porcelain'], repoRoot);

    const out: Worktree[] = [];
    for (const record of parsePorcelain(res.stdout)) {
      if (!record.worktree || !record.branch) continue;
      const branch = record.branch.startsWith('refs/heads/')
        ? record.branch.slice('refs/heads/'.length)
        : record.branch;
      if (!branch.startsWith(BRANCH_PREFIX)) continue;
      if (branch === INTEGRATION_BRANCH) continue;
      const taskId = branch.slice(BRANCH_PREFIX.length);
      if (!taskId) continue;
      out.push({
        path: await realpathOr(record.worktree),
        branch,
        repoPath: repoRoot,
        taskId,
      });
    }
    return out;
  }

  /**
   * Everything the Crew changed relative to the base branch, INCLUDING work it
   * left uncommitted — which is the common case, since a Crew often stops before
   * committing. Two parts, concatenated:
   *
   *   1. committed:  `git diff <mergeBase>...HEAD`
   *   2. working:    index+worktree vs HEAD, computed through a TEMPORARY index
   *      so that untracked new files show up. Plain `git diff HEAD` omits them,
   *      which would hide entire new modules from the Sentinel.
   *
   * The temporary index means the Crew's real index is never mutated.
   */
  async diff(wt: Worktree): Promise<string> {
    // Qualified, for the same reason the reclamation checks are: a tag that
    // shadows the branch name would silently move the merge base, and the
    // Sentinel would grade a diff against the wrong thing.
    const base = await this.defaultBranchRef();

    const mbRes = await git(['merge-base', base, 'HEAD'], wt.path, { allowFailure: true });
    const mergeBase = mbRes.exitCode === 0 && mbRes.stdout.trim() ? mbRes.stdout.trim() : EMPTY_TREE;

    const committed = (await git(['diff', `${mergeBase}...HEAD`], wt.path)).stdout;
    const working = await this.workingTreeDiff(wt.path);

    const parts = [committed, working].map((p) => p.trim()).filter((p) => p.length > 0);
    return parts.length ? `${parts.join('\n')}\n` : '';
  }

  /** index + worktree + untracked, versus HEAD, without touching the real index. */
  private async workingTreeDiff(wtPath: string): Promise<string> {
    const indexFile = path.join(os.tmpdir(), `bluespace-diff-${randomUUID()}.index`);
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await git(['read-tree', 'HEAD'], wtPath, { env });
      await git(['add', '-A', '--', '.'], wtPath, { env });
      return (await git(['diff', '--cached', 'HEAD'], wtPath, { env })).stdout;
    } finally {
      await fs.rm(indexFile, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Any staged, unstaged, or untracked change in the worktree.
   *
   * NOT ignored files. `git status --porcelain` omits everything `.gitignore`
   * covers, and `git worktree remove` deletes them without complaint, so a
   * merged worktree is removed with its `.env`, its `dist/` and its
   * `node_modules/` — silently, reported as "merged". That is deliberate rather
   * than overlooked: counting ignored files as work would make every worktree in
   * a JavaScript or Python repository permanently unreclaimable, which is a
   * worse failure than the one it prevents. It is the one thing the safe rule
   * does not cover, and the README says so.
   */
  async hasUncommittedChanges(wt: Worktree): Promise<boolean> {
    if (!(await pathExists(wt.path))) return false;
    const res = await git(['status', '--porcelain'], wt.path);
    return res.stdout.trim().length > 0;
  }

  /**
   * Commits that exist on this worktree's branch (or its detached HEAD) but are
   * not reachable from `base` — i.e. work that would be destroyed by deleting
   * the branch. Fail closed: true if EITHER ref has unlanded commits.
   *
   * `base` defaults to the default branch. Pass the integration branch when the
   * log says this task's work was merged there — see `unlandedCommitCount`.
   */
  async hasUnlandedCommits(wt: Worktree, opts?: { base?: BranchRef }): Promise<boolean> {
    return (await this.unlandedCommitCount(wt, opts)) > 0;
  }

  /**
   * HOW MANY commits would be stranded by deleting this branch.
   *
   * The same question `hasUnlandedCommits` answers, with the number kept — a
   * sweep that refuses to reclaim a worktree has to be able to tell the captain
   * "3 commits not in main", not merely "not yet". Fail closed: the larger of
   * the branch's count and the detached HEAD's, since either can hold work.
   *
   * `base` OVERRIDES the branch the question is asked about, and the caller owes
   * a reason for overriding it. Under the delivery policy work is merged into
   * `blue/dev` and sits there until a pull request, so a landed worktree
   * measured against `main` reads as unmerged forever and is never reclaimed.
   * `reclaim.ts` passes the branch the Blackbox says this task was merged into,
   * and passes nothing at all for a task that was never merged — which is what
   * keeps this from becoming a way to reclaim work that landed nowhere.
   */
  async unlandedCommitCount(wt: Worktree, opts?: { base?: BranchRef }): Promise<number> {
    const repoRoot = await this.repoRoot();
    const base = opts?.base?.ref ?? (await this.defaultBranchRef());

    let count = await this.countUnlanded(repoRoot, base, `refs/heads/${wt.branch}`);

    // A Crew may have committed on a detached HEAD, or checked out something else.
    if (await pathExists(wt.path)) {
      const head = await git(['rev-parse', 'HEAD'], wt.path, { allowFailure: true });
      const sha = head.stdout.trim();
      if (head.exitCode === 0 && sha) {
        count = Math.max(count, await this.countUnlanded(repoRoot, base, sha));
      }
    }
    return count;
  }

  /**
   * Commits on `ref` that are not reachable from `baseRef`; 0 when `ref` is gone.
   *
   * `baseRef` must be fully qualified — see `defaultBranchRef()`. Both ends are
   * resolved to object ids before the range is built, so nothing in the range
   * expression can be re-interpreted as a tag, a remote, or a file name.
   *
   * Every failure answers "unlanded", never "landed": this number is the only
   * thing standing between a Crew's commits and `git branch -D`, and a question
   * we could not ask is not an answer of zero. The one exception is a `ref` that
   * names no commit at all, which really is nothing to lose.
   */
  private async countUnlanded(repoRoot: string, baseRef: string, ref: string): Promise<number> {
    const tip = await this.resolveCommit(repoRoot, ref);
    if (tip === undefined) return 0;

    const base = await this.resolveCommit(repoRoot, baseRef);
    // No resolvable base means we cannot prove anything landed. Count the whole
    // history of the ref rather than pretending it is merged.
    const range = base === undefined ? tip : `${base}..${tip}`;

    const res = await git(['rev-list', '--count', range, '--'], repoRoot, { allowFailure: true });
    if (res.exitCode !== 0) return UNKNOWN_IS_UNLANDED;
    const n = Number.parseInt(res.stdout.trim(), 10);
    if (!Number.isFinite(n)) return UNKNOWN_IS_UNLANDED;
    return n > 0 ? n : 0;
  }

  /**
   * Tear down a worktree. FAILS CLOSED: refuses while there is uncommitted work
   * or unlanded commits unless `force` is set. The branch is deleted only once
   * proven fully merged into `base`, so forcing away a directory never silently
   * destroys the commits — they stay reachable via the branch.
   *
   * `base` defaults to the default branch and is the authority on both
   * questions; a caller that passes the integration branch is saying "this work
   * was merged there", and this method re-proves it rather than believing it.
   */
  async remove(wt: Worktree, opts?: { force?: boolean; base?: BranchRef }): Promise<void> {
    const force = opts?.force === true;
    const repoRoot = await this.repoRoot();
    // Two forms of the same branch: the qualified ref decides, the short name
    // is what the refusal tells the captain.
    const { name: base, ref: baseRef } = opts?.base ?? (await this.resolveDefaultBranch());
    const against = { base: { name: base, ref: baseRef } };

    if (!force) {
      if (await this.hasUncommittedChanges(wt)) throw new DirtyWorktreeError(wt);
      if (await this.hasUnlandedCommits(wt, against)) throw new UnlandedCommitsError(wt, base);
    }

    if (await pathExists(wt.path)) {
      // Two --force: the second is what lets git remove a *locked* worktree.
      const args = ['worktree', 'remove', ...(force ? ['--force', '--force'] : []), wt.path];
      await git(args, repoRoot);
    } else {
      await git(['worktree', 'prune'], repoRoot, { allowFailure: true });
    }

    // Only reap the branch when nothing would be lost with it.
    const ref = `refs/heads/${wt.branch}`;
    if (
      (await this.revExists(repoRoot, ref)) &&
      (await this.countUnlanded(repoRoot, baseRef, ref)) === 0
    ) {
      await git(['branch', '-D', wt.branch], repoRoot, { allowFailure: true });
    }
  }
}

// ---------------------------------------------------------------------------
// `git worktree list --porcelain` parsing
// ---------------------------------------------------------------------------

interface PorcelainRecord {
  worktree?: string;
  head?: string;
  branch?: string;
  detached?: boolean;
  bare?: boolean;
}

/**
 * Records are separated by blank lines; each line is `<key>[ <value>]`.
 * Anything we do not model (locked, prunable, …) is ignored on purpose.
 */
function parsePorcelain(stdout: string): PorcelainRecord[] {
  const records: PorcelainRecord[] = [];
  let current: PorcelainRecord | undefined;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.trim() === '') {
      if (current) records.push(current);
      current = undefined;
      continue;
    }
    const sep = line.indexOf(' ');
    const key = sep === -1 ? line : line.slice(0, sep);
    const value = sep === -1 ? '' : line.slice(sep + 1);

    if (key === 'worktree') current = { worktree: value };
    else if (!current) continue;
    else if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value;
    else if (key === 'detached') current.detached = true;
    else if (key === 'bare') current.bare = true;
  }
  if (current) records.push(current);

  return records;
}
