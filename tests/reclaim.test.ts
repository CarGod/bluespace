/**
 * Worktree reclamation tests.
 *
 * Like `worktree.test.ts`, these run against a REAL git repository in a temp
 * dir. The whole claim of this module is "it only takes what git says is
 * merged", and a mocked git could be made to say anything — so the sweep is
 * pointed at actual commits, actual merges and actual dirty files.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { noTokenUsage } from '../src/types/domain.js';
import type { Task, TaskState } from '../src/types/domain.js';
import {
  WorktreeManager,
  directorySize,
  reclaimWorktrees,
  sweepOrphanDirectories,
  type KeptEntry,
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

function taskId(): string {
  return randomUUID();
}

/** A task projection row. Only `id`, `state` and `worktree` matter to the sweep. */
function task(id: string, state: TaskState, worktree?: string): Task {
  return {
    id,
    kind: 'mission',
    projectId: 'proj',
    title: 'a task',
    brief: 'do the thing',
    state,
    dependsOn: [],
    createdAt: 1,
    updatedAt: 2,
    tokens: noTokenUsage(),
    metered: false,
    listPriceUsd: 0,
    reworkCount: 0,
    ...(worktree !== undefined ? { worktree } : {}),
  };
}

/** Commit a file inside a worktree, leaving the tree clean but unlanded. */
async function commitIn(wt: Worktree, file: string, body: string): Promise<void> {
  await fs.writeFile(path.join(wt.path, file), body);
  await git(['add', '-A'], wt.path);
  await git(['commit', '-qm', `crew work: ${file}`], wt.path);
}

async function land(wt: Worktree): Promise<void> {
  await git(['merge', '--no-ff', '-q', '-m', 'land', wt.branch], repoPath);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function reasonOf(kept: KeptEntry[], p: string): KeptEntry['reason'] | undefined {
  return kept.find((k) => k.path === p)?.reason;
}

beforeEach(async () => {
  tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bluespace-gc-')));
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
  try {
    for (const wt of await mgr.list()) {
      await mgr.remove(wt, { force: true }).catch(() => undefined);
    }
  } catch {
    // repo may already be gone
  }
  await fs.rm(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The rule: merged means reclaimable
// ---------------------------------------------------------------------------

describe('reclaimWorktrees — the safe sweep', () => {
  it('reclaims a landed worktree whose work is merged, and reaps its branch', async () => {
    const id = taskId();
    const wt = await mgr.create(id);
    await commitIn(wt, 'feature.ts', 'export const feature = true;\n');
    await land(wt);

    const result = await reclaimWorktrees(mgr, [task(id, 'landed', wt.path)]);

    expect(result.reclaimed.map((r) => r.path)).toEqual([wt.path]);
    expect(result.reclaimed[0]!.branch).toBe(wt.branch);
    expect(result.reclaimed[0]!.taskId).toBe(id);
    expect(result.reclaimed[0]!.destroys).toBeUndefined();
    expect(result.kept).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.bytesFreed).toBeGreaterThan(0);

    expect(await pathExists(wt.path)).toBe(false);
    expect(await mgr.list()).toEqual([]);
    // The branch is reaped only because main already has every commit on it.
    expect((await git(['branch', '--list', wt.branch], repoPath)).trim()).toBe('');
    // And the work is still in the repository, which is the whole justification.
    expect(await fs.readFile(path.join(repoPath, 'feature.ts'), 'utf8')).toBe(
      'export const feature = true;\n',
    );
  });

  it('KEEPS a landed worktree whose commits are not in the base branch', async () => {
    const id = taskId();
    const wt = await mgr.create(id);
    await commitIn(wt, 'a.txt', 'a\n');
    await commitIn(wt, 'b.txt', 'b\n');

    const result = await reclaimWorktrees(mgr, [task(id, 'landed', wt.path)]);

    expect(result.reclaimed).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(reasonOf(result.kept, wt.path)).toEqual({
      kind: 'unlanded',
      commits: 2,
      baseBranch: 'main',
    });

    // Nothing was destroyed by the refusal.
    expect(await pathExists(wt.path)).toBe(true);
    expect((await git(['branch', '--list', wt.branch], repoPath)).trim()).not.toBe('');
  });

  it('KEEPS a worktree with uncommitted changes, including untracked files', async () => {
    const id = taskId();
    const wt = await mgr.create(id);
    await fs.writeFile(path.join(wt.path, 'scratch.ts'), 'export const wip = true;\n');

    const result = await reclaimWorktrees(mgr, [task(id, 'failed', wt.path)]);

    expect(result.reclaimed).toEqual([]);
    expect(reasonOf(result.kept, wt.path)).toEqual({ kind: 'uncommitted' });
    expect(await pathExists(path.join(wt.path, 'scratch.ts'))).toBe(true);
  });

  it('reports uncommitted work ahead of unlanded commits — it is the copy that is unique', async () => {
    const id = taskId();
    const wt = await mgr.create(id);
    await commitIn(wt, 'a.txt', 'a\n');
    await fs.writeFile(path.join(wt.path, 'dirty.txt'), 'dirty\n');

    const result = await reclaimWorktrees(mgr, [task(id, 'cancelled', wt.path)]);

    expect(reasonOf(result.kept, wt.path)).toEqual({ kind: 'uncommitted' });
  });

  /**
   * The end-to-end shape of the ambiguous-ref bug: a repository with a tag
   * called `main` made the safe sweep delete a worktree with two unmerged
   * commits, report it to the captain as "merged", and reap the branch — the
   * exact outcome the module is built to make impossible.
   */
  it('is not fooled into calling unmerged work merged by a tag named like the base branch', async () => {
    const id = taskId();
    const wt = await mgr.create(id);
    await commitIn(wt, 'a.txt', 'a\n');
    await commitIn(wt, 'b.txt', 'the only copy\n');
    await git(['tag', 'main', (await git(['rev-parse', 'HEAD'], wt.path)).trim()], repoPath);

    const result = await reclaimWorktrees(mgr, [task(id, 'landed', wt.path)]);

    expect(result.reclaimed).toEqual([]);
    expect(reasonOf(result.kept, wt.path)).toEqual({
      kind: 'unlanded',
      commits: 2,
      baseBranch: 'main',
    });
    expect(await pathExists(wt.path)).toBe(true);
    expect(await git(['show', `${wt.branch}:b.txt`], repoPath)).toBe('the only copy\n');
  });

  it('reclaims a clean worktree that never committed anything', async () => {
    const id = taskId();
    const wt = await mgr.create(id);

    const result = await reclaimWorktrees(mgr, [task(id, 'failed', wt.path)]);

    expect(result.reclaimed.map((r) => r.path)).toEqual([wt.path]);
    expect(await pathExists(wt.path)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Live work is untouchable
// ---------------------------------------------------------------------------

describe('reclaimWorktrees — live work', () => {
  it('never touches a worktree whose task is still live', async () => {
    const id = taskId();
    const wt = await mgr.create(id);
    // Merged, clean, and therefore removable by the rule — but the task is not over.
    await commitIn(wt, 'a.txt', 'a\n');
    await land(wt);

    for (const state of ['queued', 'working', 'awaiting_decision', 'verifying', 'ready'] as const) {
      const result = await reclaimWorktrees(mgr, [task(id, state, wt.path)]);
      expect(result.reclaimed).toEqual([]);
      expect(reasonOf(result.kept, wt.path)).toEqual({ kind: 'live', taskId: id, state });
      expect(await pathExists(wt.path)).toBe(true);
    }
  });

  it('never touches a path a caller says a Crew is running in, whatever the log says', async () => {
    const id = taskId();
    const wt = await mgr.create(id);

    // The projection says landed; the caller knows better, because `#live` is
    // in-process state that no projection can see.
    const result = await reclaimWorktrees(mgr, [task(id, 'landed', wt.path)], {
      livePaths: [wt.path],
    });

    expect(result.reclaimed).toEqual([]);
    expect(reasonOf(result.kept, wt.path)).toEqual({ kind: 'live', taskId: id, state: 'landed' });
    expect(await pathExists(wt.path)).toBe(true);
  });

  it('does not force a live worktree away either', async () => {
    const id = taskId();
    const wt = await mgr.create(id);
    await fs.writeFile(path.join(wt.path, 'wip.ts'), 'export const wip = 1;\n');

    const result = await reclaimWorktrees(mgr, [task(id, 'working', wt.path)], { force: true });

    expect(result.reclaimed).toEqual([]);
    expect(await pathExists(path.join(wt.path, 'wip.ts'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Orphans — a worktree with no task at all
// ---------------------------------------------------------------------------

describe('reclaimWorktrees — orphans', () => {
  it('sweeps a worktree with no task under exactly the same rule', async () => {
    // Left by a crash between cutting the worktree and recording the dispatch.
    const merged = await mgr.create(taskId());
    await commitIn(merged, 'landed.txt', 'landed\n');
    await land(merged);

    const stranded = await mgr.create(taskId());
    await commitIn(stranded, 'stranded.txt', 'stranded\n');

    const dirty = await mgr.create(taskId());
    await fs.writeFile(path.join(dirty.path, 'wip.txt'), 'wip\n');

    // No tasks at all — the projection is empty.
    const result = await reclaimWorktrees(mgr, []);

    expect(result.reclaimed.map((r) => r.path)).toEqual([merged.path]);
    expect(reasonOf(result.kept, stranded.path)).toMatchObject({ kind: 'unlanded', commits: 1 });
    expect(reasonOf(result.kept, dirty.path)).toEqual({ kind: 'uncommitted' });

    expect(await pathExists(merged.path)).toBe(false);
    expect(await pathExists(stranded.path)).toBe(true);
    expect(await pathExists(dirty.path)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --dry-run and --force
// ---------------------------------------------------------------------------

describe('reclaimWorktrees — dryRun', () => {
  it('reports what it would take and changes nothing', async () => {
    const id = taskId();
    const wt = await mgr.create(id);
    await commitIn(wt, 'a.txt', 'a\n');
    await land(wt);

    const result = await reclaimWorktrees(mgr, [task(id, 'landed', wt.path)], { dryRun: true });

    expect(result.reclaimed.map((r) => r.path)).toEqual([wt.path]);
    expect(result.bytesFreed).toBeGreaterThan(0);

    // Still there, still registered, still on its branch.
    expect(await pathExists(wt.path)).toBe(true);
    expect((await mgr.list()).map((w) => w.path)).toContain(wt.path);
    expect((await git(['branch', '--list', wt.branch], repoPath)).trim()).not.toBe('');
  });

  it('leaves a dirty worktree alone under dryRun + force, but names the cost', async () => {
    const id = taskId();
    const wt = await mgr.create(id);
    await fs.writeFile(path.join(wt.path, 'wip.txt'), 'wip\n');

    const result = await reclaimWorktrees(mgr, [task(id, 'landed', wt.path)], {
      dryRun: true,
      force: true,
    });

    expect(result.reclaimed[0]!.destroys).toEqual({
      uncommitted: true,
      unlandedCommits: 0,
      baseBranch: 'main',
      branchKept: false,
    });
    expect(await pathExists(path.join(wt.path, 'wip.txt'))).toBe(true);
  });
});

describe('reclaimWorktrees — force', () => {
  it('destroys what the safe sweep kept', async () => {
    const dirtyId = taskId();
    const dirty = await mgr.create(dirtyId);
    await fs.writeFile(path.join(dirty.path, 'wip.txt'), 'wip\n');

    const unlandedId = taskId();
    const unlanded = await mgr.create(unlandedId);
    await commitIn(unlanded, 'a.txt', 'precious\n');

    const tasks = [task(dirtyId, 'failed', dirty.path), task(unlandedId, 'landed', unlanded.path)];

    // Safe mode keeps both.
    const safe = await reclaimWorktrees(mgr, tasks);
    expect(safe.reclaimed).toEqual([]);
    expect(safe.kept).toHaveLength(2);

    const forced = await reclaimWorktrees(mgr, tasks, { force: true });

    expect(forced.kept).toEqual([]);
    expect(forced.reclaimed.map((r) => r.path).sort()).toEqual([dirty.path, unlanded.path].sort());
    expect(await pathExists(dirty.path)).toBe(false);
    expect(await pathExists(unlanded.path)).toBe(false);

    const dirtyEntry = forced.reclaimed.find((r) => r.path === dirty.path);
    expect(dirtyEntry!.destroys).toMatchObject({ uncommitted: true, unlandedCommits: 0 });

    // The commits are not destroyed with the directory: remove() only reaps a
    // branch it has proven merged, so `blue gc --force` costs the checkout, and
    // the history stays recoverable.
    const unlandedEntry = forced.reclaimed.find((r) => r.path === unlanded.path);
    expect(unlandedEntry!.destroys).toMatchObject({ unlandedCommits: 1, branchKept: true });
    expect(await git(['show', `${unlanded.branch}:a.txt`], repoPath)).toBe('precious\n');
  });
});

// ---------------------------------------------------------------------------
// Loose directories under the root
// ---------------------------------------------------------------------------

describe('sweepOrphanDirectories', () => {
  it('keeps a directory git knows nothing about, and says so', async () => {
    await fs.mkdir(path.join(wtRoot, 'crash-leftover'), { recursive: true });
    await fs.writeFile(path.join(wtRoot, 'crash-leftover', 'notes.md'), '# notes\n');

    const result = await sweepOrphanDirectories(wtRoot);

    expect(result.reclaimed).toEqual([]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.reason).toEqual({ kind: 'debris' });
    expect(result.kept[0]!.bytes).toBeGreaterThan(0);
    expect(await pathExists(path.join(wtRoot, 'crash-leftover'))).toBe(true);
  });

  it('removes that directory only when forced', async () => {
    const debris = path.join(wtRoot, 'crash-leftover');
    await fs.mkdir(debris, { recursive: true });
    await fs.writeFile(path.join(debris, 'notes.md'), '# notes\n');

    const result = await sweepOrphanDirectories(wtRoot, { force: true });

    expect(result.reclaimed.map((r) => r.path)).toEqual([
      path.join(await fs.realpath(wtRoot), 'crash-leftover'),
    ]);
    expect(await pathExists(debris)).toBe(false);
  });

  it('never removes a real worktree it was not told about', async () => {
    // A worktree of this very repo, on a branch outside the blue/ namespace.
    const manual = path.join(wtRoot, 'manual');
    await fs.mkdir(wtRoot, { recursive: true });
    await git(['worktree', 'add', '-q', '-b', 'feature/manual', manual, 'main'], repoPath);

    const result = await sweepOrphanDirectories(wtRoot, { force: true });

    expect(result.reclaimed).toEqual([]);
    expect(result.kept[0]!.reason).toEqual({ kind: 'not-ours' });
    expect(await pathExists(manual)).toBe(true);

    await git(['worktree', 'remove', '--force', manual], repoPath);
  });

  it('skips paths a sweep already claimed', async () => {
    const wt = await mgr.create(taskId());

    const result = await sweepOrphanDirectories(wtRoot, { claimed: [wt.path], force: true });

    expect(result.reclaimed).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(await pathExists(wt.path)).toBe(true);
  });

  it('is empty and silent when the root does not exist yet', async () => {
    const result = await sweepOrphanDirectories(path.join(tmpBase, 'never-created'));
    expect(result).toEqual({ reclaimed: [], kept: [], bytesFreed: 0, errors: [] });
  });
});

// ---------------------------------------------------------------------------
// Disk accounting
// ---------------------------------------------------------------------------

describe('directorySize', () => {
  it('counts files recursively and returns 0 for a missing path', async () => {
    const dir = path.join(tmpBase, 'sized', 'nested');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.bin'), Buffer.alloc(4096));
    await fs.writeFile(path.join(tmpBase, 'sized', 'b.bin'), Buffer.alloc(2048));

    expect(await directorySize(path.join(tmpBase, 'sized'))).toBe(6144);
    expect(await directorySize(path.join(tmpBase, 'not-here'))).toBe(0);
  });
});
