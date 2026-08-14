/**
 * The gate that killed every crew on Claude Code 2.1.232.
 *
 * The rule under test is not ours — it is read out of the binary and confirmed
 * by experiment: the trust walk runs from the working directory upwards and
 * STOPS AT THE REPOSITORY ROOT. Up to 2.1.231 it ran to `/`, which is why a
 * captain with a trusted home directory never knew this gate existed and why the
 * fleet stopped dead the morning they upgraded.
 *
 * Every assertion below is about a real directory tree, because the whole
 * discriminator is whether a `.git` entry sits in one of them.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  globalConfigPath,
  repositoryRoot,
  trustWorkspace,
  workspaceTrusted,
} from '../src/adapters/workspace-trust.js';

const tmpDirs: string[] = [];

afterAll(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

/** A home with a `.claude.json`, and a tree to ask questions about. */
async function sandbox(
  trusted: readonly string[] = [],
  extra: Record<string, unknown> = {},
): Promise<{ home: string; env: NodeJS.ProcessEnv; config(): Promise<Record<string, unknown>> }> {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'blue-trust-')));
  tmpDirs.push(home);
  const projects: Record<string, unknown> = {};
  for (const dir of trusted) projects[dir] = { hasTrustDialogAccepted: true };
  await fs.writeFile(
    path.join(home, '.claude.json'),
    JSON.stringify({ ...extra, projects }, null, 2),
    { mode: 0o600 },
  );
  return {
    home,
    env: { HOME: home },
    async config() {
      return JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8')) as Record<
        string,
        unknown
      >;
    },
  };
}

/** A directory tree; `git` entries become a `.git` FILE, as a worktree has. */
async function tree(spec: { dirs: readonly string[]; git?: readonly string[] }): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'blue-tree-')));
  tmpDirs.push(root);
  for (const d of spec.dirs) await fs.mkdir(path.join(root, d), { recursive: true });
  for (const g of spec.git ?? []) {
    await fs.mkdir(path.join(root, g), { recursive: true });
    await fs.writeFile(path.join(root, g, '.git'), 'gitdir: /somewhere/else\n');
  }
  return root;
}

// ---------------------------------------------------------------------------

describe('globalConfigPath', () => {
  it('is ~/.claude.json, and moves with CLAUDE_CONFIG_DIR', () => {
    expect(globalConfigPath({ HOME: '/h' })).toBe(path.join('/h', '.claude.json'));
    expect(globalConfigPath({ HOME: '/h', CLAUDE_CONFIG_DIR: '/cfg' })).toBe(
      path.join('/cfg', '.claude.json'),
    );
    // Blank is not a setting.
    expect(globalConfigPath({ HOME: '/h', CLAUDE_CONFIG_DIR: '  ' })).toBe(
      path.join('/h', '.claude.json'),
    );
  });
});

describe('repositoryRoot', () => {
  it('finds the nearest ancestor holding a .git, worktree or checkout', async () => {
    const root = await tree({ dirs: ['repo/src/deep'], git: ['repo'] });
    expect(repositoryRoot(path.join(root, 'repo/src/deep'))).toBe(path.join(root, 'repo'));
    expect(repositoryRoot(path.join(root, 'repo'))).toBe(path.join(root, 'repo'));
  });

  it('is undefined outside a repository', async () => {
    const root = await tree({ dirs: ['plain/dir'] });
    // Guard against a stray `.git` above the temp dir on someone's machine.
    const found = repositoryRoot(path.join(root, 'plain/dir'));
    expect(found === undefined || !found.startsWith(root)).toBe(true);
  });
});

describe('workspaceTrusted', () => {
  it('inherits from an ancestor inside the same repository', async () => {
    const root = await tree({ dirs: ['repo/src/deep'], git: ['repo'] });
    const s = await sandbox([path.join(root, 'repo')]);
    expect(workspaceTrusted(path.join(root, 'repo/src/deep'), s.env)).toBe(true);
  });

  it('does NOT inherit across the repository root — the 2.1.232 change', async () => {
    // THE BUG, in one assertion. `parent` is trusted; `parent/worktree` is a
    // repository of its own, so the walk checks the worktree and stops. This is
    // exactly the shape of `~/.bluespace/worktrees/<task>`, and trusting the
    // directory above it — which the old error message told captains to do —
    // buys nothing.
    const root = await tree({ dirs: ['parent'], git: ['parent/worktree'] });
    const s = await sandbox([path.join(root, 'parent'), root]);
    expect(workspaceTrusted(path.join(root, 'parent/worktree'), s.env)).toBe(false);
  });

  it('still inherits all the way up outside a repository', async () => {
    const root = await tree({ dirs: ['plain/child'] });
    const s = await sandbox([root]);
    expect(workspaceTrusted(path.join(root, 'plain/child'), s.env)).toBe(true);
  });

  it('is true for the worktree once it has its own entry', async () => {
    const root = await tree({ dirs: [], git: ['worktree'] });
    const s = await sandbox([path.join(root, 'worktree')]);
    expect(workspaceTrusted(path.join(root, 'worktree'), s.env)).toBe(true);
  });

  it('does not count a sibling whose name merely starts the same', async () => {
    const root = await tree({ dirs: ['trusted', 'trusted-not-really'] });
    const s = await sandbox([path.join(root, 'trusted')]);
    expect(workspaceTrusted(path.join(root, 'trusted-not-really'), s.env)).toBe(false);
  });

  it('says "cannot tell" rather than "untrusted" when it cannot read the config', async () => {
    // A warning about a modal, shown to every captain whose config lives
    // somewhere unusual, is worse than the modal.
    expect(workspaceTrusted('/anywhere', { HOME: '/no/such/home' })).toBeUndefined();
  });
});

describe('trustWorkspace', () => {
  it('records the answer the dialog would have written', async () => {
    const root = await tree({ dirs: [], git: ['worktree'] });
    const wt = path.join(root, 'worktree');
    const s = await sandbox([]);

    expect(trustWorkspace(wt, s.env)).toMatchObject({ kind: 'recorded' });
    expect(workspaceTrusted(wt, s.env)).toBe(true);

    const cfg = (await s.config())['projects'] as Record<string, Record<string, unknown>>;
    expect(cfg[wt]).toEqual({ hasTrustDialogAccepted: true });
  });

  it('leaves every other key in the captain’s config alone', async () => {
    // It is their file: history, MCP registrations, onboarding state. One
    // boolean is added to it and nothing else may move.
    const root = await tree({ dirs: [], git: ['worktree'] });
    const s = await sandbox([], {
      hasCompletedOnboarding: true,
      mcpServers: { theirs: { command: 'x' } },
      numStartups: 41,
    });

    trustWorkspace(path.join(root, 'worktree'), s.env);

    const cfg = await s.config();
    expect(cfg['hasCompletedOnboarding']).toBe(true);
    expect(cfg['mcpServers']).toEqual({ theirs: { command: 'x' } });
    expect(cfg['numStartups']).toBe(41);
  });

  it('keeps an existing entry’s other fields', async () => {
    const root = await tree({ dirs: [], git: ['worktree'] });
    const wt = path.join(root, 'worktree');
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'blue-trust-')));
    tmpDirs.push(home);
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({ projects: { [wt]: { projectOnboardingSeenCount: 3 } } }),
    );

    trustWorkspace(wt, { HOME: home });

    const cfg = JSON.parse(await fs.readFile(path.join(home, '.claude.json'), 'utf8')) as {
      projects: Record<string, Record<string, unknown>>;
    };
    expect(cfg.projects[wt]).toEqual({ projectOnboardingSeenCount: 3, hasTrustDialogAccepted: true });
  });

  it('writes nothing at all when the directory is already trusted', async () => {
    const root = await tree({ dirs: [], git: ['worktree'] });
    const wt = path.join(root, 'worktree');
    const s = await sandbox([wt]);
    const before = await fs.stat(path.join(s.home, '.claude.json'));

    expect(trustWorkspace(wt, s.env)).toEqual({ kind: 'already-trusted' });
    const after = await fs.stat(path.join(s.home, '.claude.json'));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('keeps the file private', async () => {
    // It holds their history and their MCP registrations. A config that comes
    // back world-readable from a helpful rewrite is a worse bug than the one
    // being fixed.
    const root = await tree({ dirs: [], git: ['worktree'] });
    const s = await sandbox([]);
    trustWorkspace(path.join(root, 'worktree'), s.env);
    const mode = (await fs.stat(path.join(s.home, '.claude.json'))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('never creates the config file, and says why', async () => {
    // No `~/.claude.json` means Claude Code has not been through its own
    // onboarding. A launcher inventing that file decides things nobody asked it
    // to decide.
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'blue-trust-')));
    tmpDirs.push(home);
    const outcome = trustWorkspace('/anywhere', { HOME: home });

    expect(outcome.kind).toBe('unavailable');
    await expect(fs.stat(path.join(home, '.claude.json'))).rejects.toThrow();
  });

  it('refuses a config it cannot parse rather than replacing it', async () => {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'blue-trust-')));
    tmpDirs.push(home);
    await fs.writeFile(path.join(home, '.claude.json'), '{ this is not json');

    expect(trustWorkspace('/anywhere', { HOME: home }).kind).toBe('unavailable');
    expect(await fs.readFile(path.join(home, '.claude.json'), 'utf8')).toBe('{ this is not json');
  });

  it('leaves no temporary file behind', async () => {
    const root = await tree({ dirs: [], git: ['worktree'] });
    const s = await sandbox([]);
    trustWorkspace(path.join(root, 'worktree'), s.env);
    expect((await fs.readdir(s.home)).filter((f) => f.includes('tmp'))).toEqual([]);
  });
});
