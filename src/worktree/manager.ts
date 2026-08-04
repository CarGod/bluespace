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

/** Every BlueSpace branch lives under this namespace. list() filters on it. */
const BRANCH_PREFIX = 'blue/';

/** The well-known empty tree object, used as a diff base when there is no merge base. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface GitOpts {
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
 */
async function git(args: string[], cwd: string, opts: GitOpts = {}): Promise<GitResult> {
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
   * The branch new worktrees are cut from. origin/HEAD wins, then main, then
   * master. A local branch is preferred over its remote-tracking counterpart so
   * the Crew branches from what the captain actually has checked out.
   */
  async defaultBranch(): Promise<string> {
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
      if (await this.revExists(repoRoot, `refs/heads/${name}`)) return name;
      if (await this.revExists(repoRoot, `refs/remotes/origin/${name}`)) return `origin/${name}`;
    }

    throw new Error(
      `cannot determine default branch for ${repoRoot}: tried ${candidates.join(', ')} ` +
        `as local branches and origin remotes, none exist`,
    );
  }

  private async revExists(cwd: string, ref: string): Promise<boolean> {
    const res = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd, {
      allowFailure: true,
    });
    return res.exitCode === 0 && res.stdout.trim().length > 0;
  }

  /**
   * Cut a fresh worktree for a task: `git worktree add -b blue/<taskId> <path> <base>`.
   * Returns only after isolation has been proven.
   */
  async create(taskId: string): Promise<Worktree> {
    assertSafeTaskId(taskId);

    const repoRoot = await this.repoRoot();
    const base = await this.defaultBranch();
    const root = await this.ensureRoot();
    const branch = `${BRANCH_PREFIX}${taskId}`;
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

  private async ensureRoot(): Promise<string> {
    await fs.mkdir(this.rootInput, { recursive: true });
    return fs.realpath(this.rootInput);
  }

  /** Every `blue/*` worktree registered against this repository. */
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
    const base = await this.defaultBranch();

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

  /** Any staged, unstaged, or untracked change in the worktree. */
  async hasUncommittedChanges(wt: Worktree): Promise<boolean> {
    if (!(await pathExists(wt.path))) return false;
    const res = await git(['status', '--porcelain'], wt.path);
    return res.stdout.trim().length > 0;
  }

  /**
   * Commits that exist on this worktree's branch (or its detached HEAD) but are
   * not reachable from the default branch — i.e. work that would be destroyed by
   * deleting the branch. Fail closed: true if EITHER ref has unlanded commits.
   */
  async hasUnlandedCommits(wt: Worktree): Promise<boolean> {
    const repoRoot = await this.repoRoot();
    const base = await this.defaultBranch();

    if (await this.countUnlanded(repoRoot, base, `refs/heads/${wt.branch}`)) return true;

    // A Crew may have committed on a detached HEAD, or checked out something else.
    if (await pathExists(wt.path)) {
      const head = await git(['rev-parse', 'HEAD'], wt.path, { allowFailure: true });
      const sha = head.stdout.trim();
      if (head.exitCode === 0 && sha && (await this.countUnlanded(repoRoot, base, sha))) {
        return true;
      }
    }
    return false;
  }

  /** True when `ref` exists and holds commits not reachable from `base`. */
  private async countUnlanded(repoRoot: string, base: string, ref: string): Promise<boolean> {
    if (!(await this.revExists(repoRoot, ref))) return false;
    const res = await git(['rev-list', '--count', `${base}..${ref}`, '--'], repoRoot, {
      allowFailure: true,
    });
    if (res.exitCode !== 0) return false;
    return Number.parseInt(res.stdout.trim(), 10) > 0;
  }

  /**
   * Tear down a worktree. FAILS CLOSED: refuses while there is uncommitted work
   * or unlanded commits unless `force` is set. The branch is deleted only once
   * proven fully merged into the default branch, so forcing away a directory
   * never silently destroys the commits — they stay reachable via the branch.
   */
  async remove(wt: Worktree, opts?: { force?: boolean }): Promise<void> {
    const force = opts?.force === true;
    const repoRoot = await this.repoRoot();
    const base = await this.defaultBranch();

    if (!force) {
      if (await this.hasUncommittedChanges(wt)) throw new DirtyWorktreeError(wt);
      if (await this.hasUnlandedCommits(wt)) throw new UnlandedCommitsError(wt, base);
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
    if ((await this.revExists(repoRoot, ref)) && !(await this.countUnlanded(repoRoot, base, ref))) {
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
