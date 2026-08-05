/**
 * `blue gc` tests — the terminal surface over the sweep.
 *
 * Real git, real directories, same as `reclaim.test.ts`. What is asserted here
 * is the part a captain actually experiences: which worktrees survive, what the
 * report says about the ones that do, and — the one that matters most — that a
 * `--force` with nobody at the keyboard deletes nothing.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runGc, type GcDeps } from '../src/cli/gc.js';
import { setColourEnabled } from '../src/cli/format.js';
import type { Project, Task, TaskState } from '../src/types/domain.js';
import { WorktreeManager, type Worktree } from '../src/worktree/index.js';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

let repoPath: string;
let wtRoot: string;
let tmpBase: string;
let mgr: WorktreeManager;
let tasks: Task[];

const PROJECT: Project = {
  id: 'proj',
  name: 'demo',
  path: '',
  description: 'demo repo',
  delivery: 'local',
  addedAt: 1,
};

function deps(): GcDeps {
  return {
    tasks: () => tasks,
    projects: () => [{ ...PROJECT, path: repoPath }],
    worktreeFor: () => mgr,
    worktreeRoot: wtRoot,
  };
}

/** Collects everything the command printed, ANSI-free (colour is off below). */
function sink(): { stream: Writable; text(): string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb): void {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { stream, text: () => chunks.join('') };
}

function task(id: string, state: TaskState, worktree: string): Task {
  return {
    id,
    kind: 'mission',
    projectId: PROJECT.id,
    title: 'a task',
    brief: 'do it',
    state,
    dependsOn: [],
    createdAt: 1,
    updatedAt: 2,
    costUsd: 0,
    reworkCount: 0,
    worktree,
  };
}

async function commitIn(wt: Worktree, file: string, body: string): Promise<void> {
  await fs.writeFile(path.join(wt.path, file), body);
  await git(['add', '-A'], wt.path);
  await git(['commit', '-qm', `work: ${file}`], wt.path);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  // Assert on words, not escape codes.
  setColourEnabled(false);
});

beforeEach(async () => {
  tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bluespace-gccli-')));
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
  tasks = [];
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

describe('blue gc', () => {
  it('reclaims merged worktrees and explains every one it keeps', async () => {
    const mergedId = randomUUID();
    const merged = await mgr.create(mergedId);
    await commitIn(merged, 'a.txt', 'a\n');
    await git(['merge', '--no-ff', '-q', '-m', 'land', merged.branch], repoPath);

    const unlandedId = randomUUID();
    const unlanded = await mgr.create(unlandedId);
    await commitIn(unlanded, 'b.txt', 'b\n');
    await commitIn(unlanded, 'c.txt', 'c\n');

    const dirtyId = randomUUID();
    const dirty = await mgr.create(dirtyId);
    await fs.writeFile(path.join(dirty.path, 'wip.txt'), 'wip\n');

    tasks = [
      task(mergedId, 'landed', merged.path),
      task(unlandedId, 'landed', unlanded.path),
      task(dirtyId, 'failed', dirty.path),
    ];

    const out = sink();
    const code = await runGc(deps(), { output: out.stream });
    const text = out.text();

    expect(code).toBe(0);
    expect(text).toContain('reclaimed 1 worktree');
    expect(text).toContain('2 worktrees kept');
    expect(text).toContain('2 commits not in main');
    expect(text).toContain('merge or delete the branch first');
    expect(text).toContain('uncommitted changes');
    // Growth is visible whether or not anything was taken.
    expect(text).toContain(wtRoot);
    expect(text).toContain('in use');

    expect(await pathExists(merged.path)).toBe(false);
    expect(await pathExists(unlanded.path)).toBe(true);
    expect(await pathExists(dirty.path)).toBe(true);
  });

  it('--dry-run reports the same thing and changes nothing', async () => {
    const id = randomUUID();
    const wt = await mgr.create(id);
    await commitIn(wt, 'a.txt', 'a\n');
    await git(['merge', '--no-ff', '-q', '-m', 'land', wt.branch], repoPath);
    tasks = [task(id, 'landed', wt.path)];

    const out = sink();
    const code = await runGc(deps(), { output: out.stream, dryRun: true });

    expect(code).toBe(0);
    expect(out.text()).toContain('would reclaim 1 worktree');
    expect(await pathExists(wt.path)).toBe(true);
  });

  it('says nothing is reclaimable when a task is still live', async () => {
    const id = randomUUID();
    const wt = await mgr.create(id);
    tasks = [task(id, 'working', wt.path)];

    const out = sink();
    await runGc(deps(), { output: out.stream });

    expect(out.text()).toContain('Nothing to reclaim');
    expect(out.text()).toContain('still live');
    expect(await pathExists(wt.path)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // --force
  // -------------------------------------------------------------------------

  it('REFUSES to force from a non-interactive stdin, and deletes nothing', async () => {
    const id = randomUUID();
    const wt = await mgr.create(id);
    await fs.writeFile(path.join(wt.path, 'wip.txt'), 'wip\n');
    tasks = [task(id, 'failed', wt.path)];

    const out = sink();
    const code = await runGc(deps(), { output: out.stream, force: true, interactive: false });
    const text = out.text();

    expect(code).toBe(1);
    expect(text).toContain('Refusing');
    expect(text).toContain('stdin is not a terminal');
    // It still had to say what it was about to take, before refusing to take it.
    expect(text).toContain('uncommitted changes — no other copy exists');
    expect(await pathExists(path.join(wt.path, 'wip.txt'))).toBe(true);
  });

  it('forces once --yes says the captain already decided', async () => {
    const id = randomUUID();
    const wt = await mgr.create(id);
    await fs.writeFile(path.join(wt.path, 'wip.txt'), 'wip\n');
    tasks = [task(id, 'failed', wt.path)];

    const out = sink();
    const code = await runGc(deps(), {
      output: out.stream,
      force: true,
      yes: true,
      interactive: false,
    });

    expect(code).toBe(0);
    expect(out.text()).toContain('reclaimed 1 worktree');
    expect(await pathExists(wt.path)).toBe(false);
  });

  it('forces when a human types yes, and stops when they do not', async () => {
    const keepId = randomUUID();
    const keep = await mgr.create(keepId);
    await fs.writeFile(path.join(keep.path, 'wip.txt'), 'wip\n');
    tasks = [task(keepId, 'failed', keep.path)];

    const refused = sink();
    const refusedCode = await runGc(deps(), {
      output: refused.stream,
      input: Readable.from(['n\n']),
      force: true,
      interactive: true,
    });

    expect(refusedCode).toBe(0);
    expect(refused.text()).toContain('Nothing was removed');
    expect(await pathExists(keep.path)).toBe(true);

    const accepted = sink();
    const acceptedCode = await runGc(deps(), {
      output: accepted.stream,
      input: Readable.from(['yes\n']),
      force: true,
      interactive: true,
    });

    expect(acceptedCode).toBe(0);
    expect(accepted.text()).toContain('reclaimed 1 worktree');
    expect(await pathExists(keep.path)).toBe(false);
  });

  it('does not force away a worktree whose task is still live', async () => {
    const id = randomUUID();
    const wt = await mgr.create(id);
    await fs.writeFile(path.join(wt.path, 'wip.txt'), 'wip\n');
    tasks = [task(id, 'working', wt.path)];

    const out = sink();
    const code = await runGc(deps(), {
      output: out.stream,
      force: true,
      yes: true,
      interactive: false,
    });

    expect(code).toBe(0);
    // Nothing was even offered for confirmation: a live worktree is not a
    // candidate at any force level.
    expect(out.text()).toContain('Nothing to reclaim');
    expect(out.text()).toContain('still live');
    expect(await pathExists(path.join(wt.path, 'wip.txt'))).toBe(true);
  });
});
