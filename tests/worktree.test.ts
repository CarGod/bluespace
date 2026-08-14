/**
 * Worktree manager tests.
 *
 * These run against a REAL git repository created in a temp dir — no mocks. The
 * safety properties this module claims (isolation, fail-closed teardown) are only
 * meaningful if they hold against actual git, so that is what we exercise.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DirtyWorktreeError,
  NotIsolatedError,
  UnlandedCommitsError,
  WorktreeManager,
  assertIsolated,
  type Worktree,
} from '../src/worktree/index.js';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

let repoPath: string;
let wtRoot: string;
let tmpBase: string;
let mgr: WorktreeManager;

/** ids must satisfy the manager's refname rules; keep them uuid-shaped. */
function taskId(): string {
  return randomUUID();
}

beforeEach(async () => {
  tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bluespace-test-')));
  repoPath = path.join(tmpBase, 'repo');
  wtRoot = path.join(tmpBase, 'worktrees');
  await fs.mkdir(repoPath, { recursive: true });

  await git(['init', '-q', '-b', 'main', '.'], repoPath);
  await git(['config', 'user.email', 'captain@bluespace.test'], repoPath);
  await git(['config', 'user.name', 'Captain'], repoPath);
  await git(['config', 'commit.gpgsign', 'false'], repoPath);
  await fs.writeFile(path.join(repoPath, 'README.md'), 'hello\n');
  await git(['add', '-A'], repoPath);
  await git(['commit', '-qm', 'init'], repoPath);

  mgr = new WorktreeManager(repoPath, { root: wtRoot });
});

afterEach(async () => {
  // Force-remove anything left registered so git does not hold on to the dirs,
  // then delete the temp tree outright.
  try {
    for (const wt of await mgr.list()) {
      await mgr.remove(wt, { force: true }).catch(() => undefined);
    }
  } catch {
    // repo may already be gone; nothing to clean.
  }
  await fs.rm(tmpBase, { recursive: true, force: true });
});

describe('defaultBranch', () => {
  it('finds the local main branch', async () => {
    expect(await mgr.defaultBranch()).toBe('main');
  });

  it('falls back to master when there is no main', async () => {
    await git(['branch', '-m', 'main', 'master'], repoPath);
    const fresh = new WorktreeManager(repoPath, { root: wtRoot });
    expect(await fresh.defaultBranch()).toBe('master');
  });

  it('throws when neither main nor master exists', async () => {
    await git(['branch', '-m', 'main', 'trunk'], repoPath);
    const fresh = new WorktreeManager(repoPath, { root: wtRoot });
    await expect(fresh.defaultBranch()).rejects.toThrow(/cannot determine default branch/);
  });

  it('prefers the branch origin/HEAD points at', async () => {
    // Simulate a remote whose HEAD is `trunk`, plus a local trunk to check out.
    await git(['branch', 'trunk'], repoPath);
    await git(['update-ref', 'refs/remotes/origin/trunk', 'refs/heads/trunk'], repoPath);
    await git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'], repoPath);
    const fresh = new WorktreeManager(repoPath, { root: wtRoot });
    expect(await fresh.defaultBranch()).toBe('trunk');
  });
});

describe('create', () => {
  it('creates an isolated worktree on a blue/ branch', async () => {
    const id = taskId();
    const wt = await mgr.create(id);

    expect(wt.taskId).toBe(id);
    expect(wt.branch).toBe(`blue/${id}`);
    expect(wt.repoPath).toBe(await fs.realpath(repoPath));

    // The path exists, is canonical, and is not the primary checkout.
    expect(await fs.realpath(wt.path)).toBe(wt.path);
    expect(wt.path).not.toBe(wt.repoPath);
    expect(path.basename(wt.path)).toBe(`repo-${id}`);
    expect(await fs.stat(wt.path)).toBeTruthy();

    // It really is a linked worktree of the same repo.
    const gitDir = (await git(['rev-parse', '--git-dir'], wt.path)).trim();
    const commonDir = (await git(['rev-parse', '--git-common-dir'], wt.path)).trim();
    expect(gitDir).not.toBe(commonDir);
    expect(gitDir).toContain('worktrees');

    // Base content came across, and HEAD is on our branch.
    expect(await fs.readFile(path.join(wt.path, 'README.md'), 'utf8')).toBe('hello\n');
    expect((await git(['rev-parse', '--abbrev-ref', 'HEAD'], wt.path)).trim()).toBe(`blue/${id}`);
  });

  it('creates the worktree root directory if missing', async () => {
    const nested = path.join(tmpBase, 'does', 'not', 'exist', 'yet');
    const fresh = new WorktreeManager(repoPath, { root: nested });
    const wt = await fresh.create(taskId());
    expect(wt.path.startsWith(await fs.realpath(nested))).toBe(true);
    await fresh.remove(wt);
  });

  it('defaults its root to the OS temp dir', () => {
    const fresh = new WorktreeManager(repoPath);
    expect(fresh.root).toBe(path.join(os.tmpdir(), 'bluespace-worktrees'));
  });

  it('writes nothing into the primary checkout', async () => {
    const before = (await git(['status', '--porcelain'], repoPath)).trim();
    await mgr.create(taskId());
    expect((await git(['status', '--porcelain'], repoPath)).trim()).toBe(before);
  });

  it('rejects task ids that could escape the path or break refnames', async () => {
    for (const bad of ['../escape', 'has space', 'a/b', '-flag', '', 'x..y', 'name.lock']) {
      await expect(mgr.create(bad)).rejects.toThrow(/unsafe taskId/);
    }
  });

  it('refuses to reuse a task id that already has a worktree', async () => {
    const id = taskId();
    await mgr.create(id);
    await expect(mgr.create(id)).rejects.toThrow();
  });

  /**
   * The same ambiguous-ref class as `hasUnlandedCommits` below, at the other end
   * of the lifecycle. `git worktree add -b blue/x <path> main` in a repository
   * that also has a TAG called `main` does not quietly pick one: it exits 128
   * with "fatal: ambiguous object name: 'main'", and NO Crew can ever be
   * dispatched against that repository — `add_project` succeeds (it qualifies
   * its ref) and every task afterwards fails at worktree creation.
   */
  it('cuts from the default BRANCH in a repo that also has a tag of that name', async () => {
    await git(['tag', 'main', 'HEAD'], repoPath);
    const mainTip = (await git(['rev-parse', 'refs/heads/main'], repoPath)).trim();

    const wt = await mgr.create(taskId());

    expect((await git(['rev-parse', 'HEAD'], wt.path)).trim()).toBe(mainTip);
    expect((await git(['symbolic-ref', 'HEAD'], wt.path)).trim()).toBe(`refs/heads/${wt.branch}`);
  });
});

describe('adopt — carrying on where a dead task stopped', () => {
  it('keeps the uncommitted work, which is the whole point', async () => {
    // MEASURED, and the reason a resume inherits the DIRECTORY and not the
    // branch: every task on this fleet that died to a token ceiling had four to
    // nine modified files and ZERO commits, because Crews commit at the end of
    // the job. Branching off the dead branch would inherit an empty tree.
    const dead = taskId();
    const wt = await mgr.create(dead);
    await fs.writeFile(path.join(wt.path, 'half-done.ts'), 'export const half = 1;\n');
    await fs.writeFile(path.join(wt.path, 'README.md'), 'hello\nedited\n');
    await git(['add', 'half-done.ts'], wt.path);

    const next = taskId();
    const adopted = await mgr.adopt(next, wt.path);

    expect(adopted.path).toBe(wt.path);
    expect(adopted.branch).toBe(`blue/${next}`);
    expect(adopted.taskId).toBe(next);
    // The work came with it: one staged file, one modified in place.
    expect(await fs.readFile(path.join(wt.path, 'half-done.ts'), 'utf8')).toBe(
      'export const half = 1;\n',
    );
    expect(await fs.readFile(path.join(wt.path, 'README.md'), 'utf8')).toBe('hello\nedited\n');
    expect((await git(['status', '--porcelain'], wt.path)).trim().split('\n')).toHaveLength(2);
    // And the checkout really is on the new task's branch now.
    expect((await git(['rev-parse', '--abbrev-ref', 'HEAD'], wt.path)).trim()).toBe(
      `blue/${next}`,
    );
    // The ancestor's branch is left exactly where it was: it is the record of
    // what that run committed, which is nothing.
    expect((await git(['branch', '--list', wt.branch], repoPath)).trim()).toContain(wt.branch);
  });

  it('carries commits across as well, when there were any', async () => {
    const dead = taskId();
    const wt = await mgr.create(dead);
    await fs.writeFile(path.join(wt.path, 'done.ts'), 'export const done = true;\n');
    await git(['add', '-A'], wt.path);
    await git(['commit', '-qm', 'first half'], wt.path);

    const next = taskId();
    await mgr.adopt(next, wt.path);

    expect((await git(['log', '--oneline', '-1'], wt.path)).trim()).toContain('first half');
    expect(await pathExists(path.join(wt.path, 'done.ts'))).toBe(true);
  });

  it('refuses a directory that is not a worktree of this repository', async () => {
    const stray = path.join(tmpBase, 'not-a-worktree');
    await fs.mkdir(stray, { recursive: true });
    await expect(mgr.adopt(taskId(), stray)).rejects.toThrow(/not a git worktree root/);
    await expect(mgr.adopt(taskId(), path.join(tmpBase, 'nowhere'))).rejects.toThrow(/is gone/);
  });

  it('is idempotent enough to survive a second resume of the same task', async () => {
    const dead = taskId();
    const wt = await mgr.create(dead);
    const next = taskId();
    await mgr.adopt(next, wt.path);
    // The branch already exists and is already checked out here.
    const again = await mgr.adopt(next, wt.path);
    expect(again.branch).toBe(`blue/${next}`);
  });
});

describe('assertIsolated', () => {
  it('accepts a real worktree', async () => {
    const wt = await mgr.create(taskId());
    await expect(assertIsolated(wt.path, repoPath)).resolves.toBeUndefined();
  });

  it('rejects the primary checkout', async () => {
    await expect(assertIsolated(repoPath, repoPath)).rejects.toBeInstanceOf(NotIsolatedError);
  });

  it('rejects a subdirectory of a worktree (not a worktree root)', async () => {
    const wt = await mgr.create(taskId());
    const sub = path.join(wt.path, 'sub');
    await fs.mkdir(sub);
    await expect(assertIsolated(sub, repoPath)).rejects.toBeInstanceOf(NotIsolatedError);
  });

  it('rejects a path that is not a git repository at all', async () => {
    const plain = path.join(tmpBase, 'plain');
    await fs.mkdir(plain);
    await expect(assertIsolated(plain, repoPath)).rejects.toBeInstanceOf(NotIsolatedError);
  });

  it('rejects a worktree belonging to a different repository', async () => {
    const other = path.join(tmpBase, 'other');
    await fs.mkdir(other);
    await git(['init', '-q', '-b', 'main', '.'], other);
    await git(['config', 'user.email', 'x@y.z'], other);
    await git(['config', 'user.name', 'X'], other);
    await fs.writeFile(path.join(other, 'a.txt'), 'a\n');
    await git(['add', '-A'], other);
    await git(['commit', '-qm', 'init'], other);

    const otherMgr = new WorktreeManager(other, { root: wtRoot });
    const otherWt = await otherMgr.create(taskId());

    // A genuine worktree, but of the wrong repo — must not pass.
    await expect(assertIsolated(otherWt.path, repoPath)).rejects.toBeInstanceOf(NotIsolatedError);
    await otherMgr.remove(otherWt, { force: true });
  });

  it('rejects a path that does not exist', async () => {
    await expect(
      assertIsolated(path.join(tmpBase, 'nope'), repoPath),
    ).rejects.toBeInstanceOf(NotIsolatedError);
  });
});

describe('list', () => {
  it('returns only blue/* worktrees, never the primary checkout', async () => {
    const a = await mgr.create(taskId());
    const b = await mgr.create(taskId());

    // A non-blue worktree that must be filtered out.
    const otherPath = path.join(tmpBase, 'manual-wt');
    await git(['worktree', 'add', '-q', '-b', 'feature/manual', otherPath, 'main'], repoPath);

    const listed = await mgr.list();
    const paths = listed.map((w) => w.path).sort();
    expect(paths).toEqual([a.path, b.path].sort());
    expect(listed.map((w) => w.branch).sort()).toEqual([a.branch, b.branch].sort());
    expect(listed.map((w) => w.taskId).sort()).toEqual([a.taskId, b.taskId].sort());
    for (const w of listed) expect(w.repoPath).toBe(await fs.realpath(repoPath));

    await git(['worktree', 'remove', '--force', otherPath], repoPath);
  });

  it('is empty for a repo with no blue worktrees', async () => {
    expect(await mgr.list()).toEqual([]);
  });
});

describe('hasUncommittedChanges', () => {
  it('is false for a fresh worktree and true after any edit', async () => {
    const wt = await mgr.create(taskId());
    expect(await mgr.hasUncommittedChanges(wt)).toBe(false);

    await fs.writeFile(path.join(wt.path, 'README.md'), 'hello\nedited\n');
    expect(await mgr.hasUncommittedChanges(wt)).toBe(true);
  });

  it('counts untracked files as uncommitted', async () => {
    const wt = await mgr.create(taskId());
    await fs.writeFile(path.join(wt.path, 'brand-new.ts'), 'export const x = 1;\n');
    expect(await mgr.hasUncommittedChanges(wt)).toBe(true);
  });

  it('is false again once everything is committed', async () => {
    const wt = await mgr.create(taskId());
    await fs.writeFile(path.join(wt.path, 'a.txt'), 'a\n');
    await git(['add', '-A'], wt.path);
    await git(['commit', '-qm', 'work'], wt.path);
    expect(await mgr.hasUncommittedChanges(wt)).toBe(false);
  });
});

describe('hasUnlandedCommits', () => {
  it('is false for a fresh worktree', async () => {
    const wt = await mgr.create(taskId());
    expect(await mgr.hasUnlandedCommits(wt)).toBe(false);
  });

  it('is true once the crew commits', async () => {
    const wt = await mgr.create(taskId());
    await fs.writeFile(path.join(wt.path, 'a.txt'), 'a\n');
    await git(['add', '-A'], wt.path);
    await git(['commit', '-qm', 'crew work'], wt.path);
    expect(await mgr.hasUnlandedCommits(wt)).toBe(true);
  });

  it('is false again once the work is merged into the default branch', async () => {
    const wt = await mgr.create(taskId());
    await fs.writeFile(path.join(wt.path, 'a.txt'), 'a\n');
    await git(['add', '-A'], wt.path);
    await git(['commit', '-qm', 'crew work'], wt.path);

    await git(['merge', '--no-ff', '-q', '-m', 'land', wt.branch], repoPath);
    expect(await mgr.hasUnlandedCommits(wt)).toBe(false);
  });

  /**
   * A tag may share a branch's name, and git resolves the bare name to the TAG
   * first. Asked as `main..blue/x`, a branch two commits ahead of refs/heads/main
   * measures as fully merged — git warns on stderr and exits 0 — and `remove()`
   * then deletes the worktree and `git branch -D`s the only ref that reached
   * those commits. The question has to be asked of refs/heads/main.
   */
  it('is not fooled by a TAG that shares the default branch name', async () => {
    const wt = await mgr.create(taskId());
    await fs.writeFile(path.join(wt.path, 'precious.txt'), 'the only copy\n');
    await git(['add', '-A'], wt.path);
    await git(['commit', '-qm', 'crew work'], wt.path);

    // The tag points at the branch tip, so `main..blue/x` against it is empty.
    const tip = (await git(['rev-parse', 'HEAD'], wt.path)).trim();
    await git(['tag', 'main', tip], repoPath);

    expect(await mgr.hasUnlandedCommits(wt)).toBe(true);
    expect(await mgr.unlandedCommitCount(wt)).toBe(1);
    await expect(mgr.remove(wt)).rejects.toThrow(UnlandedCommitsError);

    // Untouched: directory, branch, and the commit itself.
    expect(await fs.stat(wt.path)).toBeTruthy();
    expect((await git(['branch', '--list', wt.branch], repoPath)).trim()).not.toBe('');
    expect(await git(['show', `${wt.branch}:precious.txt`], repoPath)).toBe('the only copy\n');
  });
});

describe('diff', () => {
  it('is empty for an untouched worktree', async () => {
    const wt = await mgr.create(taskId());
    expect(await mgr.diff(wt)).toBe('');
  });

  it('shows committed work relative to the base branch', async () => {
    const wt = await mgr.create(taskId());
    await fs.writeFile(path.join(wt.path, 'README.md'), 'hello\ncommitted line\n');
    await git(['add', '-A'], wt.path);
    await git(['commit', '-qm', 'commit it'], wt.path);

    const diff = await mgr.diff(wt);
    expect(diff).toContain('diff --git a/README.md b/README.md');
    expect(diff).toContain('+committed line');
  });

  it('shows uncommitted work, including brand new untracked files', async () => {
    const wt = await mgr.create(taskId());
    await fs.writeFile(path.join(wt.path, 'README.md'), 'hello\nunstaged line\n');
    await fs.writeFile(path.join(wt.path, 'untracked.ts'), 'export const answer = 42;\n');
    await fs.writeFile(path.join(wt.path, 'staged.ts'), 'export const staged = true;\n');
    await git(['add', 'staged.ts'], wt.path);

    const diff = await mgr.diff(wt);
    expect(diff).toContain('+unstaged line');
    expect(diff).toContain('untracked.ts');
    expect(diff).toContain('export const answer = 42;');
    expect(diff).toContain('staged.ts');
    expect(diff).toContain('export const staged = true;');
  });

  it('shows committed and uncommitted work together', async () => {
    const wt = await mgr.create(taskId());
    await fs.writeFile(path.join(wt.path, 'committed.ts'), 'export const c = 1;\n');
    await git(['add', '-A'], wt.path);
    await git(['commit', '-qm', 'crew commit'], wt.path);
    await fs.writeFile(path.join(wt.path, 'pending.ts'), 'export const p = 2;\n');

    const diff = await mgr.diff(wt);
    expect(diff).toContain('committed.ts');
    expect(diff).toContain('export const c = 1;');
    expect(diff).toContain('pending.ts');
    expect(diff).toContain('export const p = 2;');
  });

  it('does not include changes made on the base branch after the worktree was cut', async () => {
    const wt = await mgr.create(taskId());
    // The captain keeps working on main; that is not the Crew's diff.
    await fs.writeFile(path.join(repoPath, 'captain.txt'), 'captain work\n');
    await git(['add', '-A'], repoPath);
    await git(['commit', '-qm', 'captain moves on'], repoPath);

    expect(await mgr.diff(wt)).toBe('');
  });

  it('leaves the crew index untouched', async () => {
    const wt = await mgr.create(taskId());
    await fs.writeFile(path.join(wt.path, 'staged.ts'), 'export const s = 1;\n');
    await fs.writeFile(path.join(wt.path, 'loose.ts'), 'export const l = 1;\n');
    await git(['add', 'staged.ts'], wt.path);
    const before = await git(['status', '--porcelain'], wt.path);

    await mgr.diff(wt);

    expect(await git(['status', '--porcelain'], wt.path)).toBe(before);
  });
});

describe('remove', () => {
  it('removes a clean worktree and deletes its merged branch', async () => {
    const wt = await mgr.create(taskId());
    await mgr.remove(wt);

    expect(await pathExists(wt.path)).toBe(false);
    expect(await mgr.list()).toEqual([]);
    const branches = await git(['branch', '--list', wt.branch], repoPath);
    expect(branches.trim()).toBe('');
  });

  it('REFUSES to remove a worktree with uncommitted changes', async () => {
    const wt = await mgr.create(taskId());
    await fs.writeFile(path.join(wt.path, 'in-progress.ts'), 'export const wip = true;\n');

    await expect(mgr.remove(wt)).rejects.toBeInstanceOf(DirtyWorktreeError);

    // Nothing was destroyed by the refusal.
    expect(await pathExists(wt.path)).toBe(true);
    expect(await pathExists(path.join(wt.path, 'in-progress.ts'))).toBe(true);
    expect((await mgr.list()).map((w) => w.path)).toContain(wt.path);
  });

  it('removes a dirty worktree when forced', async () => {
    const wt = await mgr.create(taskId());
    await fs.writeFile(path.join(wt.path, 'in-progress.ts'), 'export const wip = true;\n');

    await mgr.remove(wt, { force: true });

    expect(await pathExists(wt.path)).toBe(false);
    expect(await mgr.list()).toEqual([]);
  });

  it('REFUSES to remove a worktree with unlanded commits', async () => {
    const wt = await mgr.create(taskId());
    await fs.writeFile(path.join(wt.path, 'a.txt'), 'a\n');
    await git(['add', '-A'], wt.path);
    await git(['commit', '-qm', 'crew work'], wt.path);

    // Clean tree, but the commits are not on main yet.
    expect(await mgr.hasUncommittedChanges(wt)).toBe(false);
    await expect(mgr.remove(wt)).rejects.toBeInstanceOf(UnlandedCommitsError);
    expect(await pathExists(wt.path)).toBe(true);
  });

  it('keeps the branch when forcing away unlanded commits, so work is recoverable', async () => {
    const wt = await mgr.create(taskId());
    await fs.writeFile(path.join(wt.path, 'a.txt'), 'precious\n');
    await git(['add', '-A'], wt.path);
    await git(['commit', '-qm', 'precious work'], wt.path);

    await mgr.remove(wt, { force: true });

    expect(await pathExists(wt.path)).toBe(false);
    // The directory is gone but the commits survive on the branch.
    const branches = await git(['branch', '--list', wt.branch], repoPath);
    expect(branches).toContain(wt.branch);
    const show = await git(['show', `${wt.branch}:a.txt`], repoPath);
    expect(show).toBe('precious\n');
  });

  it('removes a worktree whose commits have landed, and reaps the branch', async () => {
    const wt = await mgr.create(taskId());
    await fs.writeFile(path.join(wt.path, 'a.txt'), 'a\n');
    await git(['add', '-A'], wt.path);
    await git(['commit', '-qm', 'crew work'], wt.path);
    await git(['merge', '--no-ff', '-q', '-m', 'land', wt.branch], repoPath);

    await mgr.remove(wt);

    expect(await pathExists(wt.path)).toBe(false);
    expect((await git(['branch', '--list', wt.branch], repoPath)).trim()).toBe('');
  });

  it('tolerates a worktree directory deleted out from under git', async () => {
    const wt = await mgr.create(taskId());
    await fs.rm(wt.path, { recursive: true, force: true });

    await mgr.remove(wt);

    expect(await mgr.list()).toEqual([]);
  });

  it('removes only the target worktree', async () => {
    const keep = await mgr.create(taskId());
    const drop = await mgr.create(taskId());

    await mgr.remove(drop);

    expect((await mgr.list()).map((w) => w.path)).toEqual([keep.path]);
    expect(await pathExists(keep.path)).toBe(true);
    expect(await fs.readFile(path.join(keep.path, 'README.md'), 'utf8')).toBe('hello\n');
  });

  it('never touches the primary checkout', async () => {
    const wt = await mgr.create(taskId());
    await fs.writeFile(path.join(wt.path, 'junk.txt'), 'junk\n');
    await mgr.remove(wt, { force: true });

    expect(await pathExists(repoPath)).toBe(true);
    expect(await fs.readFile(path.join(repoPath, 'README.md'), 'utf8')).toBe('hello\n');
    expect((await git(['status', '--porcelain'], repoPath)).trim()).toBe('');
  });
});

describe('full lifecycle', () => {
  it('creates, works, diffs, lands and tears down', async () => {
    const id = taskId();
    const wt: Worktree = await mgr.create(id);

    // Crew does its work: one commit plus something left uncommitted.
    await fs.writeFile(path.join(wt.path, 'feature.ts'), 'export const feature = true;\n');
    await git(['add', '-A'], wt.path);
    await git(['commit', '-qm', 'add feature'], wt.path);
    await fs.writeFile(path.join(wt.path, 'notes.md'), '# notes\n');

    // Sentinel would see everything, committed and not.
    const diff = await mgr.diff(wt);
    expect(diff).toContain('export const feature = true;');
    expect(diff).toContain('# notes');

    // Fail closed while work is pending.
    await expect(mgr.remove(wt)).rejects.toBeInstanceOf(DirtyWorktreeError);

    // Crew commits the rest; still unlanded, still refused.
    await git(['add', '-A'], wt.path);
    await git(['commit', '-qm', 'add notes'], wt.path);
    await expect(mgr.remove(wt)).rejects.toBeInstanceOf(UnlandedCommitsError);

    // Land it, then teardown succeeds cleanly.
    await git(['merge', '--no-ff', '-q', '-m', 'land', wt.branch], repoPath);
    await mgr.remove(wt);

    expect(await mgr.list()).toEqual([]);
    expect(await pathExists(wt.path)).toBe(false);
    expect(await fs.readFile(path.join(repoPath, 'feature.ts'), 'utf8')).toBe(
      'export const feature = true;\n',
    );
  });
});

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
