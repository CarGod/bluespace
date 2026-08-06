/**
 * Delivery tests — landing, the integration branch, and the fleet-management
 * pair.
 *
 * This is the most dangerous code in BlueSpace: it is the only part that writes
 * to the captain's own repositories. So every test here runs against a REAL git
 * repository in a temp directory, and the assertions are about what git actually
 * holds afterwards — not about what the code returned.
 *
 * The properties under test, in the order they would hurt if they broke:
 *
 *   1. `main` is never written to. Not by a merge, not by a fallback, not when
 *      the recorded integration branch has been tampered with to name it.
 *   2. The captain's own checkout is never touched — including the uncommitted
 *      work sitting in it while a land runs.
 *   3. Only a Sentinel-passed mission can land. A recon cannot, ever.
 *   4. A conflict changes nothing at all, and says which files.
 *   5. `blue gc` reclaims what was landed into `blue/dev`, and still refuses
 *      everything that landed nowhere.
 *   6. Unregistering a project deletes nothing.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { Writable } from 'node:stream';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { helmTools } from '../src/agents/helm/index.js';
import { Blackbox, projectTask, projectTasks } from '../src/blackbox/index.js';
import { ProjectRegistry } from '../src/config/index.js';
import { runGc, type GcDeps } from '../src/cli/gc.js';
import { setColourEnabled } from '../src/cli/format.js';
import { LandRefusedError, landTask, pendingDelivery, type LandDeps } from '../src/land/index.js';
import type { Orchestrator } from '../src/orchestrator/index.js';
import type { Project, Task, TaskKind } from '../src/types/domain.js';
import type { ToolDef } from '../src/adapters/types.js';
import {
  DevBranchConflictError,
  INTEGRATION_BRANCH,
  MergeConflictError,
  MergeTargetError,
  WorktreeManager,
  ensureIntegrationBranch,
  type Worktree,
} from '../src/worktree/index.js';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

/** `git rev-parse <ref>`, or undefined when the ref does not exist. */
async function sha(cwd: string, ref: string): Promise<string | undefined> {
  try {
    return (await git(['rev-parse', '--verify', `${ref}^{commit}`], cwd)).trim();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tmpBase: string;
let repoPath: string;
let wtRoot: string;
let dataDir: string;
let bb: Blackbox;
let registry: ProjectRegistry;
let managers: Map<string, WorktreeManager>;
let deps: LandDeps;

function worktreeFor(projectPath: string): WorktreeManager {
  let mgr = managers.get(projectPath);
  if (mgr === undefined) {
    mgr = new WorktreeManager(projectPath, { root: wtRoot });
    managers.set(projectPath, mgr);
  }
  return mgr;
}

async function initRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await git(['init', '-q', '-b', 'main', '.'], dir);
  await git(['config', 'user.email', 'captain@bluespace.test'], dir);
  await git(['config', 'user.name', 'Captain'], dir);
  await git(['config', 'commit.gpgsign', 'false'], dir);
  await fs.writeFile(path.join(dir, 'README.md'), 'hello\n');
  await git(['add', '-A'], dir);
  await git(['commit', '-qm', 'init'], dir);
}

/** What `blue projects add` does: make the dev branch, then record it. */
async function registerProject(over: Partial<Project> = {}): Promise<Project> {
  const setup = await ensureIntegrationBranch(worktreeFor(repoPath), INTEGRATION_BRANCH);
  return registry.add({
    name: over.name ?? 'demo',
    path: over.path ?? repoPath,
    description: over.description ?? 'the demo repo',
    delivery: 'pr',
    devBranch: setup.branch,
  });
}

/**
 * Seed a task into the log exactly as the orchestrator would, up to the state
 * asked for. No orchestrator, no adapter — the projection is what `landTask`
 * reads, so the log is the only thing that has to be real.
 */
function seedTask(input: {
  projectId: string;
  kind?: TaskKind;
  title?: string;
  brief?: string;
  state?: 'working' | 'failed' | 'landed';
  artifact?: string;
  summary?: string;
}): string {
  const taskId = randomUUID();
  const kind = input.kind ?? 'mission';
  bb.append({
    type: 'task.created',
    taskId,
    kind,
    projectId: input.projectId,
    title: input.title ?? 'Add the thing',
    brief: input.brief ?? 'Add the thing, with tests.',
    dependsOn: [],
  });
  const hop = (from: Task['state'], to: Task['state']): void => {
    bb.append({ type: 'task.state_changed', taskId, from, to });
  };
  hop('queued', 'dispatched');
  hop('dispatched', 'working');

  const state = input.state ?? 'landed';
  if (state === 'working') return taskId;
  if (state === 'failed') {
    hop('working', 'failed');
    bb.append({ type: 'task.failed', taskId, reason: 'crew_failed' });
    return taskId;
  }

  hop('working', 'verifying');
  if (kind === 'mission') {
    bb.append({
      type: 'sentinel.verdict',
      taskId,
      verdictId: randomUUID(),
      pass: true,
      reasoning: input.summary ?? 'The diff does everything the brief asked for.',
      unmet: [],
      costUsd: 0,
    });
  }
  hop('verifying', 'ready');
  bb.append({
    type: 'task.completed',
    taskId,
    artifact: input.artifact ?? `blue/${taskId}`,
    summary: input.summary ?? 'The diff does everything the brief asked for.',
  });
  hop('ready', 'landed');
  return taskId;
}

/** Cut the task's worktree and commit one file in it, as a Crew would. */
async function crewWork(taskId: string, file: string, body: string): Promise<Worktree> {
  const wt = await worktreeFor(repoPath).create(taskId);
  await fs.writeFile(path.join(wt.path, file), body);
  await git(['add', '-A'], wt.path);
  await git(['commit', '-qm', `work: ${file}`], wt.path);
  return wt;
}

function tasksFromLog(): Task[] {
  return [...projectTasks(bb.read()).values()];
}

/** The tools, wired to this fixture's real registry, log and managers. */
function tools(): Map<string, ToolDef> {
  const orch = {
    tasks: () => tasksFromLog(),
    task: (id: string) => projectTask(bb.read(), id),
    openDecisions: () => [],
  } as unknown as Orchestrator;
  const list = helmTools(orch, registry, { blackbox: bb, worktreeFor });
  return new Map(list.map((t) => [t.name, t]));
}

async function callTool(name: string, input: Record<string, unknown> = {}): Promise<any> {
  const tool = tools().get(name);
  if (!tool) throw new Error(`no tool named ${name}`);
  return JSON.parse(await tool.handler(input));
}

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

/** Everything git knows about the repository, for a before/after comparison. */
async function repoFingerprint(dir: string): Promise<Record<string, string>> {
  return {
    head: (await git(['rev-parse', 'HEAD'], dir)).trim(),
    branch: (await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir)).trim(),
    status: (await git(['status', '--porcelain'], dir)).trim(),
    branches: (await git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/'], dir)).trim(),
    files: (await fs.readdir(dir)).sort().join(','),
  };
}

beforeAll(() => {
  setColourEnabled(false);
});

beforeEach(async () => {
  // NOT `bluespace-land-`: that is the prefix the merge worktree uses, and a
  // fixture sharing it would make "no land worktree was left behind" pass (or
  // fail) for the wrong reason.
  tmpBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bluespace-delivery-')));
  repoPath = path.join(tmpBase, 'repo');
  wtRoot = path.join(tmpBase, 'worktrees');
  dataDir = path.join(tmpBase, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  await initRepo(repoPath);

  bb = Blackbox.open(':memory:');
  registry = ProjectRegistry.open(dataDir);
  managers = new Map();
  deps = { blackbox: bb, registry, worktreeFor };
});

afterEach(async () => {
  try {
    for (const mgr of managers.values()) {
      for (const wt of await mgr.list()) {
        await mgr.remove(wt, { force: true }).catch(() => undefined);
      }
    }
  } catch {
    // the repo may already be gone
  }
  bb.close();
  await fs.rm(tmpBase, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('registering a project', () => {
  it('creates blue/dev off the default branch when it is absent, and records it', async () => {
    expect(await sha(repoPath, INTEGRATION_BRANCH)).toBeUndefined();

    const project = await registerProject();

    expect(project.devBranch).toBe('blue/dev');
    // Created at the default branch's tip: the first landed task builds on
    // exactly what the captain already has.
    expect(await sha(repoPath, 'refs/heads/blue/dev')).toBe(await sha(repoPath, 'refs/heads/main'));
    // It is a branch, not a tag — the distinction this repository lost work to
    // once already.
    expect((await git(['for-each-ref', '--format=%(refname)', 'refs/tags/'], repoPath)).trim()).toBe(
      '',
    );
  });

  it('adopts an existing blue/dev instead of moving it', async () => {
    // A blue/dev that already carries work, e.g. from a previous session.
    await git(['branch', 'blue/dev', 'main'], repoPath);
    const wt = await worktreeFor(repoPath).create(randomUUID());
    await fs.writeFile(path.join(wt.path, 'earlier.txt'), 'earlier\n');
    await git(['add', '-A'], wt.path);
    await git(['commit', '-qm', 'earlier work'], wt.path);
    await git(['fetch', '.', `${wt.branch}:blue/dev`, '-q'], repoPath);
    const before = await sha(repoPath, 'refs/heads/blue/dev');

    const setup = await ensureIntegrationBranch(worktreeFor(repoPath), INTEGRATION_BRANCH);

    expect(setup.created).toBe(false);
    expect(await sha(repoPath, 'refs/heads/blue/dev')).toBe(before);
  });

  it('REFUSES a repository with a bare `blue` branch, naming the conflict', async () => {
    await git(['branch', 'blue', 'main'], repoPath);

    await expect(registerProject()).rejects.toBeInstanceOf(DevBranchConflictError);
    await expect(registerProject()).rejects.toThrow(/branch named "blue"/);
    // Nothing was registered and nothing was created: the refusal is total.
    expect(registry.list()).toEqual([]);
    expect(await sha(repoPath, 'refs/heads/blue/dev')).toBeUndefined();
  });

  it('add_project refuses the same repository, and registers nothing', async () => {
    await git(['branch', 'blue', 'main'], repoPath);

    await expect(callTool('add_project', { path: repoPath, description: 'x' })).rejects.toThrow(
      /cannot coexist with blue\/dev/,
    );
    expect(registry.list()).toEqual([]);
  });

  it('add_project registers a reference and creates only the dev branch', async () => {
    const before = await repoFingerprint(repoPath);

    const result = await callTool('add_project', {
      path: repoPath,
      name: 'demo',
      description: 'the demo repo',
    });

    expect(result.registered.devBranch).toBe('blue/dev');
    expect(String(result.devBranch)).toContain('created blue/dev off main');
    expect(String(result.note)).toContain('references it in place');

    const after = await repoFingerprint(repoPath);
    // The ONLY difference is the new branch ref: same HEAD, same working tree,
    // same files, same status.
    expect(after.head).toBe(before.head);
    expect(after.branch).toBe(before.branch);
    expect(after.status).toBe(before.status);
    expect(after.files).toBe(before.files);
    expect(after.branches).not.toBe(before.branches);
    expect(after.branches).toContain('refs/heads/blue/dev');
  });
});

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

describe('landing a verified task', () => {
  it('merges into blue/dev and leaves the default branch byte-identical', async () => {
    const project = await registerProject();
    const taskId = seedTask({ projectId: project.id, title: 'Add the feature' });
    await crewWork(taskId, 'feature.ts', 'export const feature = true;\n');

    const mainBefore = await sha(repoPath, 'refs/heads/main');
    const devBefore = await sha(repoPath, 'refs/heads/blue/dev');

    const report = await landTask(deps, taskId);

    expect(report.alreadyMerged).toBe(false);
    expect(report.devBranch).toBe('blue/dev');
    expect(report.defaultBranch).toBe('main');

    // blue/dev moved, and carries the work.
    expect(await sha(repoPath, 'refs/heads/blue/dev')).toBe(report.commit);
    expect(report.commit).not.toBe(devBefore);
    expect(await git(['show', 'blue/dev:feature.ts'], repoPath)).toBe(
      'export const feature = true;\n',
    );

    // main did not move by a single byte, and does not have the file.
    expect(await sha(repoPath, 'refs/heads/main')).toBe(mainBefore);
    await expect(git(['show', 'main:feature.ts'], repoPath)).rejects.toThrow();

    // The merge is in the log, with the target recorded verbatim.
    const merged = bb.read({ types: ['task.merged'] });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      type: 'task.merged',
      taskId,
      into: 'blue/dev',
      branch: `blue/${taskId}`,
      projectId: project.id,
    });
    // …and folded onto the task, which is what lets `blue gc` reclaim it.
    expect(projectTask(bb.read(), taskId)?.mergedInto).toBe('blue/dev');
    expect(projectTask(bb.read(), taskId)?.mergeCommit).toBe(report.commit);
    // Still `landed`: a merge is not a state change.
    expect(projectTask(bb.read(), taskId)?.state).toBe('landed');
  });

  it('records the merge as a real merge commit carrying the Sentinel’s verdict', async () => {
    const project = await registerProject();
    const taskId = seedTask({
      projectId: project.id,
      title: 'Add retries',
      summary: 'Retries are bounded and backed off, exactly as the brief asked.',
    });
    await crewWork(taskId, 'retry.ts', 'export const retry = 3;\n');

    await landTask(deps, taskId);

    const message = await git(['log', '-1', '--pretty=%B', 'blue/dev'], repoPath);
    expect(message).toContain('Land Add retries');
    expect(message).toContain(`Task: ${taskId}`);
    expect(message).toContain('Sentinel: Retries are bounded');
    // --no-ff: the merge is visible as a merge, which is what makes the pull
    // request readable and the landed tasks countable.
    expect((await git(['rev-list', '--count', '--merges', 'main..blue/dev'], repoPath)).trim()).toBe(
      '1',
    );
  });

  it('never touches the captain’s checkout, including the work sitting in it', async () => {
    const project = await registerProject();
    const taskId = seedTask({ projectId: project.id });
    await crewWork(taskId, 'feature.ts', 'export const feature = true;\n');

    // The captain is mid-edit in their own checkout while landing happens.
    await fs.writeFile(path.join(repoPath, 'README.md'), 'hello\nhalf-written thought\n');
    await fs.writeFile(path.join(repoPath, 'scratch.txt'), 'do not lose me\n');
    const before = await repoFingerprint(repoPath);

    await landTask(deps, taskId);

    const after = await repoFingerprint(repoPath);
    expect(after.head).toBe(before.head);
    expect(after.branch).toBe('main');
    expect(after.status).toBe(before.status);
    expect(await fs.readFile(path.join(repoPath, 'README.md'), 'utf8')).toBe(
      'hello\nhalf-written thought\n',
    );
    expect(await fs.readFile(path.join(repoPath, 'scratch.txt'), 'utf8')).toBe('do not lose me\n');
    // The feature never appeared in the captain's working copy.
    expect(await pathExists(path.join(repoPath, 'feature.ts'))).toBe(false);
  });

  it('leaves no worktree behind after the merge', async () => {
    const project = await registerProject();
    const taskId = seedTask({ projectId: project.id });
    await crewWork(taskId, 'feature.ts', 'export const f = 1;\n');

    await landTask(deps, taskId);

    const listed = await git(['worktree', 'list', '--porcelain'], repoPath);
    expect(listed).not.toContain('bluespace-land-');
    // The integration branch is not a task worktree and is never listed as one:
    // if it were, the sweep could hand it to remove(), which reaps merged
    // branches.
    const managed = await worktreeFor(repoPath).list();
    expect(managed.map((w) => w.branch)).not.toContain('blue/dev');
  });

  /**
   * A process killed mid-merge leaves a worktree holding `blue/dev`, and git
   * refuses to check a branch out twice — so without recovery, one crash would
   * make every future land in that repository fail against a temp directory
   * nobody will ever look in.
   */
  it('recovers from a merge worktree a killed process left behind', async () => {
    const project = await registerProject();
    const stale = path.join(os.tmpdir(), `bluespace-land-${randomUUID()}`);
    await git(['worktree', 'add', '--quiet', stale, 'blue/dev'], repoPath);
    expect(await pathExists(stale)).toBe(true);

    const taskId = seedTask({ projectId: project.id });
    await crewWork(taskId, 'feature.ts', 'export const f = 1;\n');

    const report = await landTask(deps, taskId);

    expect(report.alreadyMerged).toBe(false);
    expect(await sha(repoPath, 'refs/heads/blue/dev')).toBe(report.commit);
    expect(await pathExists(stale)).toBe(false);
  });

  /**
   * The debris sweep above matches a registered worktree by directory name and
   * parent, and clears it with `git worktree remove --force` — falling back to a
   * RECURSIVE DELETE when git refuses. Git refuses exactly one worktree: the
   * primary checkout ("is a main working tree"). So a repository whose own root
   * is named `<tmpdir>/bluespace-land-*` matches the sweep, fails the remove,
   * and hits the delete. Far-fetched, and it is the captain's whole repository.
   */
  it('never deletes a repository whose root is named like a merge worktree', async () => {
    const evil = path.join(os.tmpdir(), `bluespace-land-${randomUUID()}`);
    await initRepo(evil);
    await fs.writeFile(path.join(evil, 'IRREPLACEABLE.md'), 'the only copy\n');

    const setup = await ensureIntegrationBranch(worktreeFor(evil), INTEGRATION_BRANCH);
    const project = registry.add({
      name: 'evil',
      path: evil,
      description: 'a repo root shaped like a merge worktree',
      delivery: 'pr',
      devBranch: setup.branch,
    });

    const taskId = seedTask({ projectId: project.id });
    const wt = await worktreeFor(evil).create(taskId);
    await fs.writeFile(path.join(wt.path, 'feature.ts'), 'export const f = 1;\n');
    await git(['add', '-A'], wt.path);
    await git(['commit', '-qm', 'work'], wt.path);

    const report = await landTask(deps, taskId);

    expect(report.alreadyMerged).toBe(false);
    expect(await fs.readFile(path.join(evil, 'IRREPLACEABLE.md'), 'utf8')).toBe('the only copy\n');
    expect(await sha(evil, 'refs/heads/main')).toBeDefined();
    await fs.rm(evil, { recursive: true, force: true });
  });

  it('is idempotent: landing twice merges once and says so', async () => {
    const project = await registerProject();
    const taskId = seedTask({ projectId: project.id });
    await crewWork(taskId, 'feature.ts', 'export const f = 1;\n');

    const first = await landTask(deps, taskId);
    const second = await landTask(deps, taskId);

    expect(first.alreadyMerged).toBe(false);
    expect(second.alreadyMerged).toBe(true);
    expect(second.commit).toBe(first.commit);
    expect(await sha(repoPath, 'refs/heads/blue/dev')).toBe(first.commit);
  });

  it('adopts and records the dev branch for a project registered before delivery existed', async () => {
    // Exactly what an entry written by an older BlueSpace looks like: no
    // devBranch, and no blue/dev in the repository.
    const legacy = registry.add({
      name: 'legacy',
      path: repoPath,
      description: 'registered before delivery existed',
    });
    expect(legacy.devBranch).toBeUndefined();

    const taskId = seedTask({ projectId: legacy.id });
    await crewWork(taskId, 'feature.ts', 'export const f = 1;\n');

    const report = await landTask(deps, taskId);

    expect(report.adoptedDevBranch).toBe(true);
    expect(report.devBranch).toBe('blue/dev');
    // Pinned on the project, so renaming the constant later cannot retarget it.
    expect(registry.get(legacy.id)?.devBranch).toBe('blue/dev');
    expect(await sha(repoPath, 'refs/heads/main')).toBe(
      await sha(repoPath, 'refs/heads/main'),
    );
  });

  it('recreates a dev branch the captain deleted after their pull request merged', async () => {
    const project = await registerProject();
    const first = seedTask({ projectId: project.id });
    await crewWork(first, 'one.ts', 'export const one = 1;\n');
    await landTask(deps, first);

    // The captain merges the PR by hand and deletes the branch, as people do.
    await git(['merge', '--no-ff', '-q', '-m', 'PR #1', 'blue/dev'], repoPath);
    await git(['branch', '-D', 'blue/dev'], repoPath);
    const mainAfterPr = await sha(repoPath, 'refs/heads/main');

    const second = seedTask({ projectId: project.id });
    await crewWork(second, 'two.ts', 'export const two = 2;\n');
    const report = await landTask(deps, second);

    // Recreated off main — where the next round of work belongs — and main is
    // still exactly where the captain's own merge left it.
    expect(await sha(repoPath, 'refs/heads/main')).toBe(mainAfterPr);
    expect(await git(['show', 'blue/dev:two.ts'], repoPath)).toBe('export const two = 2;\n');
    expect(report.status.ahead).toBe(2); // the merge commit and the work
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('landing refuses', () => {
  it('a task the Sentinel never passed', async () => {
    const project = await registerProject();
    const taskId = seedTask({ projectId: project.id, state: 'working' });
    await crewWork(taskId, 'half.ts', 'export const half = true;\n');
    const devBefore = await sha(repoPath, 'refs/heads/blue/dev');

    await expect(landTask(deps, taskId)).rejects.toBeInstanceOf(LandRefusedError);
    await expect(landTask(deps, taskId)).rejects.toThrow(/not verified/);

    expect(await sha(repoPath, 'refs/heads/blue/dev')).toBe(devBefore);
    expect(bb.read({ types: ['task.merged'] })).toEqual([]);
  });

  it('a task that failed', async () => {
    const project = await registerProject();
    const taskId = seedTask({ projectId: project.id, state: 'failed' });
    await crewWork(taskId, 'half.ts', 'export const half = true;\n');

    await expect(landTask(deps, taskId)).rejects.toThrow(/is failed, not verified/);
    expect(bb.read({ types: ['task.merged'] })).toEqual([]);
  });

  it('a recon, which has no diff and nothing verified it', async () => {
    const project = await registerProject();
    const taskId = seedTask({ projectId: project.id, kind: 'recon', state: 'landed' });
    await crewWork(taskId, 'REPORT.md', '# findings\n');
    const devBefore = await sha(repoPath, 'refs/heads/blue/dev');

    await expect(landTask(deps, taskId)).rejects.toBeInstanceOf(LandRefusedError);
    await expect(landTask(deps, taskId)).rejects.toThrow(/recon/);

    expect(await sha(repoPath, 'refs/heads/blue/dev')).toBe(devBefore);
    expect(bb.read({ types: ['task.merged'] })).toEqual([]);
  });

  it('a task whose project is no longer registered', async () => {
    const project = await registerProject();
    const taskId = seedTask({ projectId: project.id });
    await crewWork(taskId, 'feature.ts', 'export const f = 1;\n');
    registry.remove(project.id);

    await expect(landTask(deps, taskId)).rejects.toThrow(/no longer registered/);
  });

  /**
   * The assertion the whole design rests on. A registry entry that names the
   * default branch as the integration branch is the one input that could turn
   * landing into a merge into main — so the merge target is re-proven from the
   * recorded name immediately before the merge, and this is what proves it.
   */
  it('a merge target that is the default branch, however it got recorded', async () => {
    const project = await registerProject();
    registry.update(project.id, { devBranch: 'main' });
    const taskId = seedTask({ projectId: project.id });
    await crewWork(taskId, 'feature.ts', 'export const f = 1;\n');
    const mainBefore = await sha(repoPath, 'refs/heads/main');

    await expect(landTask(deps, taskId)).rejects.toBeInstanceOf(MergeTargetError);
    await expect(landTask(deps, taskId)).rejects.toThrow(/only ever merges into a branch in the blue\//);

    expect(await sha(repoPath, 'refs/heads/main')).toBe(mainBefore);
    await expect(git(['show', 'main:feature.ts'], repoPath)).rejects.toThrow();
    expect(bb.read({ types: ['task.merged'] })).toEqual([]);
  });

  /**
   * Adopting an existing branch of any name is harmless — it verifies and moves
   * nothing. CREATING one is a write into the captain's repository, and the only
   * refs BlueSpace may write are its own.
   */
  it('to create an integration branch outside the blue/ namespace', async () => {
    const project = await registerProject();
    registry.update(project.id, { devBranch: 'release' });
    const taskId = seedTask({ projectId: project.id });
    await crewWork(taskId, 'feature.ts', 'export const f = 1;\n');

    await expect(landTask(deps, taskId)).rejects.toThrow(/only ever creates branches under blue\//);
    expect(await sha(repoPath, 'refs/heads/release')).toBeUndefined();
    expect(bb.read({ types: ['task.merged'] })).toEqual([]);
  });

  it('a conflicting merge — aborting it, and changing nothing', async () => {
    const project = await registerProject();

    const first = seedTask({ projectId: project.id, title: 'First' });
    await crewWork(first, 'README.md', 'hello\nfrom the first crew\n');
    await landTask(deps, first);
    const devAfterFirst = await sha(repoPath, 'refs/heads/blue/dev');

    const second = seedTask({ projectId: project.id, title: 'Second' });
    const secondWt = await crewWork(second, 'README.md', 'hello\nfrom the second crew\n');
    const secondTip = await sha(repoPath, `refs/heads/blue/${second}`);

    const error = await landTask(deps, second).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MergeConflictError);
    expect((error as MergeConflictError).files).toEqual(['README.md']);
    expect((error as Error).message).toContain('exactly as they were');

    // blue/dev is untouched, and has no conflict markers in it.
    expect(await sha(repoPath, 'refs/heads/blue/dev')).toBe(devAfterFirst);
    expect(await git(['show', 'blue/dev:README.md'], repoPath)).toBe('hello\nfrom the first crew\n');
    expect(await git(['show', 'blue/dev:README.md'], repoPath)).not.toContain('<<<<<<<');

    // The task branch and its worktree are intact — the work is not lost, it
    // just did not land.
    expect(await sha(repoPath, `refs/heads/blue/${second}`)).toBe(secondTip);
    expect(await git(['show', `blue/${second}:README.md`], repoPath)).toBe(
      'hello\nfrom the second crew\n',
    );
    expect(await pathExists(secondWt.path)).toBe(true);
    expect((await git(['status', '--porcelain'], secondWt.path)).trim()).toBe('');

    // Nothing was recorded, and no half-merged worktree was left behind.
    expect(bb.read({ types: ['task.merged'] })).toHaveLength(1);
    expect(await git(['worktree', 'list', '--porcelain'], repoPath)).not.toContain(
      'bluespace-land-',
    );

    // And the captain's checkout is still clean.
    expect((await git(['status', '--porcelain'], repoPath)).trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Reclamation — `blue gc` after a land
// ---------------------------------------------------------------------------

describe('blue gc after landing', () => {
  function gcDeps(): GcDeps {
    return {
      tasks: () => tasksFromLog(),
      projects: () => registry.list(),
      worktreeFor,
      worktreeRoot: wtRoot,
    };
  }

  it('reclaims a worktree landed into blue/dev, and keeps one that landed nowhere', async () => {
    const project = await registerProject();

    const landedId = seedTask({ projectId: project.id, title: 'Landed' });
    const landedWt = await crewWork(landedId, 'landed.ts', 'export const landed = true;\n');

    const strandedId = seedTask({ projectId: project.id, title: 'Verified but never landed' });
    const strandedWt = await crewWork(strandedId, 'stranded.ts', 'export const stranded = true;\n');

    await landTask(deps, landedId);

    const out = sink();
    const code = await runGc(gcDeps(), { output: out.stream });
    const text = out.text();

    expect(code).toBe(0);
    expect(text).toContain('reclaimed 1 worktree');
    // The one that landed nowhere is kept, and the reason names the branch it
    // was measured against — main, because nothing merged it anywhere.
    expect(text).toContain('1 commit not in main');
    expect(text).toContain('merge or delete the branch first');

    expect(await pathExists(landedWt.path)).toBe(false);
    expect(await pathExists(strandedWt.path)).toBe(true);

    // The landed branch was reaped only because blue/dev holds its commits.
    expect(await sha(repoPath, `refs/heads/blue/${landedId}`)).toBeUndefined();
    expect(await git(['show', 'blue/dev:landed.ts'], repoPath)).toBe(
      'export const landed = true;\n',
    );
    // The stranded branch is untouched, and so is its work.
    expect(await sha(repoPath, `refs/heads/blue/${strandedId}`)).toBeDefined();

    // The integration branch itself survives the sweep. It matches `blue/`, so
    // a sweep that treated it as a task branch could delete it.
    expect(await sha(repoPath, 'refs/heads/blue/dev')).toBeDefined();
    // And main is still where it was — gc merges nothing.
    await expect(git(['show', 'main:landed.ts'], repoPath)).rejects.toThrow();
  });

  it('will not reclaim a landed task whose merge target no longer contains it', async () => {
    const project = await registerProject();
    const taskId = seedTask({ projectId: project.id });
    const wt = await crewWork(taskId, 'feature.ts', 'export const f = 1;\n');
    await landTask(deps, taskId);

    // The captain resets the integration branch, so the merge record now points
    // at a branch that no longer holds the work. Fail closed: keep it.
    await git(['branch', '-f', 'blue/dev', 'main'], repoPath);

    const out = sink();
    await runGc(gcDeps(), { output: out.stream });

    expect(out.text()).toContain('Nothing to reclaim');
    expect(await pathExists(wt.path)).toBe(true);
    expect(await sha(repoPath, `refs/heads/blue/${taskId}`)).toBeDefined();
  });

  /**
   * The garbage collector deleting the integration branch — the exact failure
   * `WorktreeManager.list()` excludes `blue/dev` to prevent, in the one shape
   * the constant cannot see.
   *
   * `Project.devBranch` is recorded per project precisely because the constant
   * may change; a project on any other `blue/` name has an integration branch
   * that `list()` reads as a task called `integration`. A land killed mid-merge
   * leaves a checkout of it, and the branch is fully merged into main for the
   * whole window after the captain's pull request — so it measures as reclaimed
   * and `remove()` reaps the branch every landed task was merged into.
   *
   * Forced, because this is the one refusal `--force` may not override.
   */
  it('never reclaims a project’s integration branch, whatever it is called', async () => {
    await git(['branch', 'blue/integration', 'main'], repoPath);
    // Registered directly: the fixture's helper always records the constant,
    // and a devBranch that is NOT the constant is the whole point here.
    registry.add({
      name: 'demo',
      path: repoPath,
      description: 'the demo repo',
      delivery: 'pr',
      devBranch: 'blue/integration',
    });

    // What a process killed mid-merge leaves behind: a checkout of the
    // integration branch, with no task in the log that owns it.
    const stale = path.join(wtRoot, 'killed-mid-merge');
    await fs.mkdir(wtRoot, { recursive: true });
    await git(['worktree', 'add', '-q', stale, 'blue/integration'], repoPath);

    const out = sink();
    const code = await runGc(gcDeps(), { output: out.stream, force: true, yes: true });

    expect(code).toBe(0);
    expect(out.text()).toContain('Nothing to reclaim');
    expect(out.text()).toContain('the integration branch landed work is merged into');
    expect(await sha(repoPath, 'refs/heads/blue/integration')).toBeDefined();
    expect(await pathExists(stale)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The pull-request reminder
// ---------------------------------------------------------------------------

describe('pending delivery', () => {
  it('counts the landed tasks blue/dev is ahead by, and goes quiet once they are in main', async () => {
    const project = await registerProject();
    await git(['remote', 'add', 'origin', 'https://example.invalid/demo.git'], repoPath);

    expect(await pendingDelivery(deps)).toEqual([]);

    const one = seedTask({ projectId: project.id, title: 'First task' });
    await crewWork(one, 'one.ts', 'export const one = 1;\n');
    await landTask(deps, one);

    const two = seedTask({ projectId: project.id, title: 'Second task' });
    await crewWork(two, 'two.ts', 'export const two = 2;\n');
    await landTask(deps, two);

    const pending = await pendingDelivery(deps, { detail: true });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      project: 'demo',
      devBranch: 'blue/dev',
      defaultBranch: 'main',
      tasks: 2,
    });
    expect(pending[0]?.landed?.map((t) => t.title)).toEqual(['First task', 'Second task']);
    // The body is drawn from the briefs and the Sentinel's verdicts.
    expect(pending[0]?.prCommand).toContain("gh pr create --base 'main' --head 'blue/dev'");
    expect(pending[0]?.prCommand).toContain('Add the thing, with tests.');
    expect(pending[0]?.prCommand).toContain('**Sentinel.**');
    expect(pending[0]?.prCommand).toContain("git push -u origin 'blue/dev'");

    // The captain opens and merges the pull request. Nothing tells BlueSpace.
    await git(['merge', '--no-ff', '-q', '-m', 'PR #1', 'blue/dev'], repoPath);

    expect(await pendingDelivery(deps)).toEqual([]);
  });

  it('offers no pull-request command when there is no remote to open one against', async () => {
    const project = await registerProject();
    const taskId = seedTask({ projectId: project.id });
    await crewWork(taskId, 'one.ts', 'export const one = 1;\n');
    await landTask(deps, taskId);

    const pending = await pendingDelivery(deps, { detail: true });
    expect(pending[0]?.tasks).toBe(1);
    expect(pending[0]?.prCommand).toBeUndefined();
  });

  it('quotes a hostile task title into the command as text, not as a command', async () => {
    const project = await registerProject();
    await git(['remote', 'add', 'origin', 'https://example.invalid/demo.git'], repoPath);
    const taskId = seedTask({
      projectId: project.id,
      title: "'; rm -rf ~; echo 'pwned",
    });
    await crewWork(taskId, 'one.ts', 'export const one = 1;\n');
    await landTask(deps, taskId);

    const [pending] = await pendingDelivery(deps, { detail: true });
    const command = pending?.prCommand ?? '';
    // Every quote is closed and re-escaped, so nothing in the title can end a
    // quoted argument. This string goes into the captain's own shell.
    expect(command).toContain(`'\\''`);
    expect(command).not.toMatch(/--title ''; rm/);
  });

  it('rides along on list_tasks, with the note that stops it becoming a nag', async () => {
    const project = await registerProject();
    const taskId = seedTask({ projectId: project.id });
    await crewWork(taskId, 'one.ts', 'export const one = 1;\n');

    const before = await callTool('list_tasks');
    expect(before.pendingDelivery).toBeUndefined();

    await landTask(deps, taskId);

    const after = await callTool('list_tasks');
    expect(after.pendingDelivery.projects[0]).toMatchObject({
      project: 'demo',
      devBranch: 'blue/dev',
      defaultBranch: 'main',
      landedTasksNotInDefaultBranch: 1,
    });
    expect(String(after.pendingDelivery.note)).toMatch(/ONE clause/);
    // The command is deliberately not here: it is long, and nobody asked yet.
    expect(JSON.stringify(after.pendingDelivery)).not.toContain('gh pr create');

    const detail = await callTool('delivery_status');
    expect(detail.projects[0].landed).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fleet management
// ---------------------------------------------------------------------------

describe('remove_project', () => {
  it('unregisters the project and leaves the repository on disk untouched', async () => {
    const project = await registerProject();
    const taskId = seedTask({ projectId: project.id });
    const wt = await crewWork(taskId, 'feature.ts', 'export const f = 1;\n');
    await landTask(deps, taskId);

    const before = await repoFingerprint(repoPath);
    const filesBefore = await fs.readdir(repoPath);

    const result = await callTool('remove_project', { projectId: project.id });

    expect(result.unregistered.id).toBe(project.id);
    expect(registry.list()).toEqual([]);

    // Byte for byte: same HEAD, same branches (including blue/dev and the task
    // branch), same working tree, same files. Unregistering is a bookmark
    // deletion.
    const after = await repoFingerprint(repoPath);
    expect(after).toEqual(before);
    expect(await fs.readdir(repoPath)).toEqual(filesBefore);
    expect(await sha(repoPath, 'refs/heads/blue/dev')).toBeDefined();
    expect(await sha(repoPath, `refs/heads/blue/${taskId}`)).toBeDefined();
    expect(await pathExists(wt.path)).toBe(true);
    expect(await fs.readFile(path.join(repoPath, 'README.md'), 'utf8')).toBe('hello\n');
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
