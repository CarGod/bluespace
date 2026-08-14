/**
 * End-to-end integration proof.
 *
 * Every other suite tests one module against fakes at its seams. This one wires
 * the REAL modules together — real Blackbox on a real file, real WorktreeManager
 * on a real git repo, real ProjectRegistry, real config, real brief builder —
 * and drives a task from `queued` to `landed`.
 *
 * The only thing faked is the model: a scripted HarnessAdapter whose "Crew"
 * actually edits and commits inside the worktree it was handed. That is the
 * point — it proves the orchestrator's cwd really is an isolated worktree, that
 * the diff handed to the Sentinel is the Crew's real work, and that teardown
 * respects commits that have not landed.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  AdapterCapabilities,
  AdapterEvent,
  Conversation,
  HarnessAdapter,
  Session,
  SpawnRequest,
} from '../src/adapters/types.js';
import { UnsupportedCapabilityError } from '../src/adapters/types.js';
import { buildBrief } from '../src/agents/crew/index.js';
import { Blackbox } from '../src/blackbox/index.js';
import { ProjectRegistry, defaultConfig, type BlueConfig } from '../src/config/index.js';
import { Orchestrator } from '../src/orchestrator/index.js';
import { addTokenUsage, noTokenUsage } from '../src/types/domain.js';
import type { Project, Verdict } from '../src/types/domain.js';
import { WorktreeManager } from '../src/worktree/index.js';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'BlueSpace Test',
      GIT_AUTHOR_EMAIL: 'test@bluespace.invalid',
      GIT_COMMITTER_NAME: 'BlueSpace Test',
      GIT_COMMITTER_EMAIL: 'test@bluespace.invalid',
    },
  });
  return stdout;
}

/** A repo with one commit on `main`, so worktrees have somewhere to branch from. */
async function makeRepo(root: string): Promise<string> {
  const repo = path.join(root, 'repo');
  await exec('mkdir', ['-p', repo]);
  await git(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'README.md'), '# fixture\n');
  await writeFile(path.join(repo, 'index.ts'), 'export const hello = () => "hi";\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-q', '-m', 'initial');
  return repo;
}

// ---------------------------------------------------------------------------
// A scripted Crew that does real work in the worktree it is given
// ---------------------------------------------------------------------------

type CrewScript = (cwd: string) => Promise<{ text: string }>;

class ScriptedSession implements Session {
  readonly id = `sess-${Math.random().toString(36).slice(2)}`;
  /** Shaped like the tmux backend's, since that is what mints the real one. */
  readonly attachCommand = `tmux attach -t bluespace:=blue-${Math.random().toString(36).slice(2, 10)}`;
  closed = false;
  readonly steers: string[] = [];

  constructor(
    private readonly req: SpawnRequest,
    private readonly script: CrewScript,
  ) {}

  async *events(): AsyncIterable<AdapterEvent> {
    yield { type: 'session', sessionId: this.id };
    const { text } = await this.script(this.req.cwd);
    yield { type: 'text', text };
    yield { type: 'usage', costUsd: 0.25, inputTokens: 1000, outputTokens: 200, model: 'scripted' };
    yield { type: 'exit', ok: true };
  }

  async send(message: string): Promise<void> {
    this.steers.push(message);
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
}

class ScriptedAdapter implements HarnessAdapter {
  readonly name = 'scripted';
  readonly capabilities: AdapterCapabilities = {
    interrupt: true,
    fork: true,
    cost: true,
    toolEvents: true,
    structuredOutput: true,
    steer: true,
    // Nothing in this path talks to Helm, so no conversation is offered.
    conversation: false,
  };
  readonly spawns: SpawnRequest[] = [];

  constructor(private readonly script: CrewScript) {}

  async spawn(req: SpawnRequest): Promise<Session> {
    this.spawns.push(req);
    return new ScriptedSession(req, this.script);
  }

  async converse(): Promise<Conversation> {
    throw new UnsupportedCapabilityError(this.name, 'conversation');
  }
}

// ---------------------------------------------------------------------------

describe('end-to-end: real blackbox + real worktrees + real registry', () => {
  let root: string;
  let repo: string;
  let dataDir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bluespace-e2e-'));
    repo = await makeRepo(root);
    dataDir = path.join(root, 'data');
    await exec('mkdir', ['-p', dataDir]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function wire(script: CrewScript, overrides: Partial<BlueConfig> = {}) {
    const bb = Blackbox.open(path.join(dataDir, 'blackbox.db'));
    const registry = ProjectRegistry.open(dataDir);
    const project: Project = registry.add({
      name: 'fixture',
      path: repo,
      description: 'the fixture repo',
      delivery: 'local',
    });
    const adapter = new ScriptedAdapter(script);
    const config: BlueConfig = { ...defaultConfig(), dataDir, ...overrides };

    const seen: { diff: string; cwd: string }[] = [];
    const orch = new Orchestrator({
      blackbox: bb,
      adapter,
      config,
      registry,
      worktreeFor: (projectPath: string) =>
        new WorktreeManager(projectPath, { root: path.join(root, 'worktrees') }),
      sentinel: async ({ task, diff, cwd }): Promise<Verdict> => {
        seen.push({ diff, cwd });
        return {
          id: `v-${task.id}`,
          taskId: task.id,
          pass: true,
          reasoning: 'the diff adds the requested export',
          unmet: [],
          createdAt: Date.now(),
          tokens: addTokenUsage(noTokenUsage(), 'scripted', { input: 400, output: 80 }),
          listPriceUsd: 0.02,
        };
      },
    });

    return { bb, registry, project, adapter, orch, seen };
  }

  it('runs a mission from queued to landed against a real repo', async () => {
    // The "Crew" does what a real one would: edit a file, then commit it.
    const w = wire(async (cwd) => {
      await writeFile(path.join(cwd, 'index.ts'), 'export const hello = () => "hello, bluespace";\n');
      await writeFile(path.join(cwd, 'added.ts'), 'export const added = true;\n');
      await git(cwd, 'add', '.');
      await git(cwd, 'commit', '-q', '-m', 'make hello greet bluespace');
      return { text: 'Updated the greeting and added a module.' };
    });

    const task = w.orch.createTask({
      kind: 'mission',
      projectId: w.project.id,
      title: 'Fix the greeting',
      brief: 'Change hello() to greet bluespace, and add an `added` export.',
    });

    await w.orch.tick();
    await w.orch.whenIdle();

    const final = w.orch.task(task.id);
    expect(final?.state).toBe('landed');

    // The Crew's cwd was a real, isolated worktree — not the primary checkout.
    const spawn = w.adapter.spawns[0];
    expect(spawn).toBeDefined();
    expect(spawn!.cwd).not.toBe(repo);
    expect(path.resolve(spawn!.cwd)).toContain('worktrees');

    // The primary checkout was never touched.
    expect(await readFile(path.join(repo, 'index.ts'), 'utf8')).toBe(
      'export const hello = () => "hi";\n',
    );

    // A Crew is a session the captain can walk into, and `blue ps` is a separate
    // process holding nothing but this log — so if the attach command is not
    // here, it does not exist anywhere.
    const spawnedEvent = w.bb.read().find((e) => e.type === 'crew.spawned');
    expect(spawnedEvent?.type === 'crew.spawned' ? spawnedEvent.attachCommand : undefined).toMatch(
      /^tmux attach -t /,
    );

    // The Sentinel saw the Crew's REAL diff, computed by git, not a fixture.
    expect(w.seen).toHaveLength(1);
    const diff = w.seen[0]!.diff;
    expect(diff).toContain('hello, bluespace');
    expect(diff).toContain('added.ts');
    // and it saw none of the Crew's narration
    expect(diff).not.toContain('Updated the greeting');

    // Cost is the Crew's run plus verification, billed to the task.
    expect(final!.listPriceUsd).toBeCloseTo(0.27, 5);

    // The branch is the deliverable, so a landed task keeps its worktree.
    const wts = await new WorktreeManager(repo, {
      root: path.join(root, 'worktrees'),
    }).list();
    expect(wts.map((x) => x.taskId)).toContain(task.id);
  });

  it('survives a process restart: state is a projection, not memory', async () => {
    const w = wire(async (cwd) => {
      await writeFile(path.join(cwd, 'added.ts'), 'export const added = true;\n');
      await git(cwd, 'add', '.');
      await git(cwd, 'commit', '-q', '-m', 'add module');
      return { text: 'done' };
    });

    const task = w.orch.createTask({
      kind: 'mission',
      projectId: w.project.id,
      title: 'Add a module',
      brief: 'Add an `added` export.',
    });
    await w.orch.tick();
    await w.orch.whenIdle();
    expect(w.orch.task(task.id)?.state).toBe('landed');

    const costBefore = w.orch.task(task.id)!.listPriceUsd;
    w.bb.close();

    // Reopen the log from disk in a brand-new process-equivalent and re-project.
    const reopened = Blackbox.open(path.join(dataDir, 'blackbox.db'));
    const revived = new Orchestrator({
      blackbox: reopened,
      adapter: new ScriptedAdapter(async () => ({ text: 'unused' })),
      config: { ...defaultConfig(), dataDir },
      registry: ProjectRegistry.open(dataDir),
      worktreeFor: (p: string) => new WorktreeManager(p, { root: path.join(root, 'worktrees') }),
    });

    const after = revived.task(task.id);
    expect(after?.state).toBe('landed');
    expect(after?.title).toBe('Add a module');
    expect(after?.listPriceUsd).toBeCloseTo(costBefore, 5);
    reopened.close();
  });

  it('tears down the worktree of a cancelled task', async () => {
    let release: (() => void) | undefined;
    const started = new Promise<void>((r) => {
      release = r;
    });
    const w = wire(async () => {
      release?.();
      // Hang until cancelled.
      await new Promise((r) => setTimeout(r, 30_000));
      return { text: 'never' };
    });

    const task = w.orch.createTask({
      kind: 'mission',
      projectId: w.project.id,
      title: 'Doomed',
      brief: 'This one gets cancelled.',
    });
    await w.orch.tick();
    await started;

    const mgr = new WorktreeManager(repo, { root: path.join(root, 'worktrees') });
    expect((await mgr.list()).map((x) => x.taskId)).toContain(task.id);

    await w.orch.cancelTask(task.id);
    expect(w.orch.task(task.id)?.state).toBe('cancelled');

    // A cancelled task leaves nothing behind: no worktree, no branch.
    expect((await mgr.list()).map((x) => x.taskId)).not.toContain(task.id);
  });

  it('builds a brief that names the real worktree and base branch', async () => {
    const mgr = new WorktreeManager(repo, { root: path.join(root, 'worktrees') });
    const base = await mgr.defaultBranch();
    expect(base).toBe('main');

    const wt = await mgr.create('task-brief-check');
    const bb = Blackbox.open(':memory:');
    const registry = ProjectRegistry.open(dataDir);
    const project = registry.add({
      name: 'fixture',
      path: repo,
      description: 'the fixture repo',
      delivery: 'local',
    });

    const brief = buildBrief({
      task: {
        id: 'task-brief-check',
        kind: 'mission',
        projectId: project.id,
        title: 'Ship it',
        brief: 'Do the thing.',
        state: 'dispatched',
        dependsOn: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        tokens: noTokenUsage(),
        metered: false,
        listPriceUsd: 0,
        reworkCount: 0,
    amendments: 0,
      },
      project,
      worktree: wt,
      baseBranch: base,
    });

    expect(brief).toContain('Do the thing.');
    expect(brief).toContain(wt.path);
    expect(brief).toContain(wt.branch);
    expect(brief).toContain('main');

    await mgr.remove(wt, { force: true });
    bb.close();
  });
});
