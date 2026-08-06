/**
 * Config + project registry tests.
 *
 * BLUESPACE_HOME is pointed at a fresh temp directory for every test, so
 * nothing here can read or write the real ~/.bluespace.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MAX_TOKENS_PER_TASK,
  ProjectRegistry,
  ProjectRegistryError,
  configPath,
  dataDir,
  defaultConfig,
  loadConfig,
  saveConfig,
  slugify,
} from '../src/config/index.js';

let home: string;
let sandbox: string;
let warnSpy: ReturnType<typeof vi.spyOn>;
const originalHome = process.env.BLUESPACE_HOME;

beforeEach(() => {
  // realpath: on macOS os.tmpdir() is a symlink (/var -> /private/var) and the
  // registry stores realpaths, so the expectations must use the same form.
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bluespace-test-')));
  home = path.join(sandbox, 'home');
  process.env.BLUESPACE_HOME = home;
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  if (originalHome === undefined) delete process.env.BLUESPACE_HOME;
  else process.env.BLUESPACE_HOME = originalHome;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function writeConfig(contents: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), contents, 'utf8');
}

/** A directory that looks like a git repo root to the registry. */
function makeRepo(name: string): string {
  const repo = path.join(sandbox, 'repos', name);
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  return repo;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe('defaults', () => {
  it('honours BLUESPACE_HOME for dataDir and configPath', () => {
    expect(dataDir()).toBe(home);
    expect(configPath()).toBe(path.join(home, 'config.json'));
  });

  it('defaults to autonomous crews with a bounded token ceiling', () => {
    expect(defaultConfig()).toEqual({
      permissionMode: 'auto',
      effort: 'high',
      maxTokensPerTask: DEFAULT_MAX_TOKENS_PER_TASK,
      maxBudgetUsdPerTask: 5,
      maxConcurrentCrew: 4,
      maxRework: 2,
      dataDir: home,
    });
  });

  it('loadConfig creates the data dir and returns defaults when no file exists', () => {
    expect(fs.existsSync(home)).toBe(false);
    expect(loadConfig()).toEqual(defaultConfig());
    expect(fs.existsSync(home)).toBe(true);
    // Reading is not writing: we do not create a config file just by looking.
    expect(fs.existsSync(configPath())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Corrupt-file tolerance
// ---------------------------------------------------------------------------

describe('corrupt config tolerance', () => {
  it('falls back to defaults on unparseable JSON instead of throwing', () => {
    writeConfig('{ "permissionMode": "plan"'); // truncated write
    expect(() => loadConfig()).not.toThrow();
    expect(loadConfig()).toEqual(defaultConfig());
    expect(warnSpy).toHaveBeenCalled();
  });

  it('falls back to defaults when the file is not a JSON object', () => {
    writeConfig('[1, 2, 3]');
    expect(loadConfig()).toEqual(defaultConfig());
    writeConfig('"nope"');
    expect(loadConfig()).toEqual(defaultConfig());
    writeConfig('');
    expect(loadConfig()).toEqual(defaultConfig());
  });

  it('ignores unknown keys so a newer file still loads', () => {
    writeConfig(JSON.stringify({ maxRework: 7, futureKnob: { deep: true } }));
    const cfg = loadConfig();
    expect(cfg.maxRework).toBe(7);
    expect(cfg.permissionMode).toBe('auto');
  });
});

// ---------------------------------------------------------------------------
// Save / load roundtrip
// ---------------------------------------------------------------------------

describe('saveConfig / loadConfig roundtrip', () => {
  it('persists a patch and merges the rest from defaults', () => {
    const saved = saveConfig({ permissionMode: 'plan', maxConcurrentCrew: 1, model: 'claude-x' });
    expect(saved).toEqual({
      permissionMode: 'plan',
      effort: 'high',
      model: 'claude-x',
      maxTokensPerTask: DEFAULT_MAX_TOKENS_PER_TASK,
      maxBudgetUsdPerTask: 5,
      maxConcurrentCrew: 1,
      maxRework: 2,
      dataDir: home,
    });
    expect(loadConfig()).toEqual(saved);
  });

  it('accumulates successive patches', () => {
    saveConfig({ maxRework: 4 });
    saveConfig({ effort: 'low' });
    const cfg = loadConfig();
    expect(cfg.maxRework).toBe(4);
    expect(cfg.effort).toBe('low');
  });

  it('writes atomically and leaves no temp files behind', () => {
    saveConfig({ maxRework: 3 });
    expect(fs.readdirSync(home)).toEqual(['config.json']);
    const onDisk = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
    // dataDir is derived from the environment, never persisted into the file
    // that lives inside it.
    expect(onDisk).not.toHaveProperty('dataDir');
    expect(onDisk.maxRework).toBe(3);
  });

  it('re-derives dataDir instead of trusting a stale one in the file', () => {
    writeConfig(JSON.stringify({ dataDir: '/somewhere/else', maxRework: 1 }));
    expect(loadConfig().dataDir).toBe(home);
  });

  it('clears an optional field when the patch sets it to null', () => {
    saveConfig({ model: 'claude-x' });
    const cleared = saveConfig({ model: null } as unknown as { model?: string });
    expect(cleared.model).toBeUndefined();
    expect(loadConfig().model).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('invalid values are dropped, not fatal', () => {
  it('drops an illegal permissionMode and effort but keeps valid siblings', () => {
    writeConfig(
      JSON.stringify({
        permissionMode: 'yolo',
        effort: 'ultra',
        maxRework: 6,
      }),
    );
    const cfg = loadConfig();
    expect(cfg.permissionMode).toBe('auto');
    expect(cfg.effort).toBe('high');
    expect(cfg.maxRework).toBe(6);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('accepts every legal permissionMode and effort level', () => {
    for (const mode of [
      'auto',
      'acceptEdits',
      'plan',
      'manual',
      'dontAsk',
      'bypassPermissions',
    ] as const) {
      expect(saveConfig({ permissionMode: mode }).permissionMode).toBe(mode);
    }
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(saveConfig({ effort }).effort).toBe(effort);
    }
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('migrates a retired permissionMode instead of silently dropping it', () => {
    // A config file outlives a refactor. `default` and `async` were legal when
    // BlueSpace ran on a vendor SDK and have no `claude --permission-mode`
    // counterpart; a captain who set one months ago should be told what
    // happened to it, not quietly handed the default.
    writeConfig(JSON.stringify({ permissionMode: 'default' }));
    expect(loadConfig().permissionMode).toBe('manual');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('renamed');

    warnSpy.mockClear();
    writeConfig(JSON.stringify({ permissionMode: 'async' }));
    expect(loadConfig().permissionMode).toBe('auto');
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('no harness equivalent');
  });

  it('drops out-of-range and non-numeric numbers', () => {
    writeConfig(
      JSON.stringify({
        maxBudgetUsdPerTask: -1,
        maxConcurrentCrew: 0,
        maxRework: 1.5,
        model: '',
      }),
    );
    const cfg = loadConfig();
    expect(cfg.maxBudgetUsdPerTask).toBe(5);
    expect(cfg.maxConcurrentCrew).toBe(4);
    expect(cfg.maxRework).toBe(2);
    expect(cfg.model).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(4);
  });

  it('drops a non-integer or negative maxTokensPerTask, keeping the default ceiling', () => {
    writeConfig(JSON.stringify({ maxTokensPerTask: -5 }));
    expect(loadConfig().maxTokensPerTask).toBe(DEFAULT_MAX_TOKENS_PER_TASK);
    writeConfig(JSON.stringify({ maxTokensPerTask: 1.5 }));
    expect(loadConfig().maxTokensPerTask).toBe(DEFAULT_MAX_TOKENS_PER_TASK);
  });

  it('accepts 0 as "no token ceiling" rather than treating it as invalid', () => {
    // A captain who genuinely wants no ceiling can say so; `blue config set`
    // is what warns them, because that is where a human is present to read it.
    writeConfig(JSON.stringify({ maxTokensPerTask: 0 }));
    expect(loadConfig().maxTokensPerTask).toBe(0);
  });

  it('tells a captain whose config predates the token ceiling what their budget now means', () => {
    // The migration, in the spirit of RETIRED_PERMISSION_MODES: a value that
    // quietly changed meaning is explained, not ignored. `maxBudgetUsdPerTask`
    // only ever bounded dollars, and on a subscription there are none.
    writeConfig(JSON.stringify({ maxBudgetUsdPerTask: 5 }));
    const cfg = loadConfig();

    expect(cfg.maxBudgetUsdPerTask).toBe(5);
    expect(cfg.maxTokensPerTask).toBe(DEFAULT_MAX_TOKENS_PER_TASK);
    const notice = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(notice).toContain('maxBudgetUsdPerTask');
    expect(notice).toContain('metered');
    expect(notice).toContain('maxTokensPerTask');
  });

  it('stops explaining once the config names a token ceiling of its own', () => {
    writeConfig(JSON.stringify({ maxBudgetUsdPerTask: 5, maxTokensPerTask: 2_000_000 }));
    const cfg = loadConfig();
    expect(cfg.maxTokensPerTask).toBe(2_000_000);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a save writes the token ceiling, so the notice self-quiets', () => {
    writeConfig(JSON.stringify({ maxBudgetUsdPerTask: 5 }));
    saveConfig({ maxRework: 1 });
    warnSpy.mockClear();
    expect(loadConfig().maxTokensPerTask).toBe(DEFAULT_MAX_TOKENS_PER_TASK);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('a bad value in the file does not stop a later save from fixing it', () => {
    writeConfig(JSON.stringify({ permissionMode: 'nonsense', maxConcurrentCrew: 2 }));
    const cfg = saveConfig({ permissionMode: 'dontAsk' });
    expect(cfg.permissionMode).toBe('dontAsk');
    expect(cfg.maxConcurrentCrew).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Project registry
// ---------------------------------------------------------------------------

describe('ProjectRegistry', () => {
  it('registers a repo in place and persists it across opens', () => {
    const repo = makeRepo('bluespace');
    const reg = ProjectRegistry.open(home);
    const before = Date.now();
    const project = reg.add({ name: 'BlueSpace', path: repo, description: 'orchestrator' });

    expect(project.path).toBe(repo);
    expect(project.delivery).toBe('pr');
    expect(project.id).toMatch(/^bluespace-[0-9a-f]{6}$/);
    expect(project.addedAt).toBeGreaterThanOrEqual(before);

    // Nothing was copied into the data dir — the repo stays where it is.
    expect(fs.readdirSync(home)).toEqual(['projects.json']);

    const reopened = ProjectRegistry.open(home);
    expect(reopened.list()).toEqual([project]);
    expect(reopened.get(project.id)).toEqual(project);
    expect(reopened.get('nope')).toBeUndefined();
  });

  it('resolves relative paths, symlinks, and ~ to a realpath', () => {
    const repo = makeRepo('ledger');
    const link = path.join(sandbox, 'ledger-link');
    fs.symlinkSync(repo, link);
    const reg = ProjectRegistry.open(home);
    const project = reg.add({ name: 'Ledger', path: link, description: 'billing' });
    expect(project.path).toBe(repo);
  });

  it('rejects a path that is not a git repo root', () => {
    const plain = path.join(sandbox, 'not-a-repo');
    fs.mkdirSync(plain, { recursive: true });
    const reg = ProjectRegistry.open(home);
    expect(() => reg.add({ name: 'Plain', path: plain, description: '' })).toThrow(
      ProjectRegistryError,
    );
    expect(() => reg.add({ name: 'Ghost', path: path.join(sandbox, 'missing'), description: '' })).toThrow(
      /no such directory/,
    );
    expect(reg.list()).toEqual([]);
  });

  it('rejects a duplicate path even when spelled differently', () => {
    const repo = makeRepo('dup');
    const reg = ProjectRegistry.open(home);
    reg.add({ name: 'Dup', path: repo, description: '' });
    expect(() => reg.add({ name: 'Dup Again', path: `${repo}/.`, description: '' })).toThrow(
      /already registered/,
    );
    expect(reg.list()).toHaveLength(1);
  });

  it('gives each project a distinct id even for identical names', () => {
    const reg = ProjectRegistry.open(home);
    const a = reg.add({ name: 'Same Name', path: makeRepo('a'), description: '' });
    const b = reg.add({ name: 'Same Name', path: makeRepo('b'), description: '' });
    expect(a.id).not.toBe(b.id);
    expect(a.id.startsWith('same-name-')).toBe(true);
  });

  it('removes idempotently', () => {
    const reg = ProjectRegistry.open(home);
    const p = reg.add({ name: 'Temp', path: makeRepo('temp'), description: '' });
    reg.remove(p.id);
    expect(reg.list()).toEqual([]);
    expect(() => reg.remove(p.id)).not.toThrow();
    expect(ProjectRegistry.open(home).list()).toEqual([]);
  });

  it('tolerates a corrupt registry file', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'projects.json'), '{ broken', 'utf8');
    const reg = ProjectRegistry.open(home);
    expect(reg.list()).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    // and it recovers on the next write
    const p = reg.add({ name: 'Fresh', path: makeRepo('fresh'), description: '' });
    expect(ProjectRegistry.open(home).list()).toEqual([p]);
  });

  it('drops malformed entries but keeps the good ones', () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, 'projects.json'),
      JSON.stringify({
        version: 1,
        projects: [
          { id: 'ok-1', name: 'Ok', path: '/repos/ok', description: 'd', delivery: 'local', addedAt: 5 },
          { name: 'no id', path: '/repos/x' },
          null,
          { id: 'legacy-1', path: '/repos/legacy' },
        ],
      }),
      'utf8',
    );
    const list = ProjectRegistry.open(home).list();
    expect(list.map((p) => p.id)).toEqual(['ok-1', 'legacy-1']);
    // Missing optional fields are filled in rather than rejected.
    expect(list[1]).toEqual({
      id: 'legacy-1',
      name: 'legacy',
      path: '/repos/legacy',
      description: '',
      delivery: 'pr',
      addedAt: 0,
    });
  });

  it('picks up writes made by another process', () => {
    const reader = ProjectRegistry.open(home);
    expect(reader.list()).toEqual([]);
    const writer = ProjectRegistry.open(home);
    const p = writer.add({ name: 'Late', path: makeRepo('late'), description: '' });
    expect(reader.list()).toEqual([p]);
  });
});

describe('slugify', () => {
  it('produces a stable, url-safe stem', () => {
    expect(slugify('BlueSpace')).toBe('bluespace');
    expect(slugify('  My Repo!! ')).toBe('my-repo');
    expect(slugify('***')).toBe('project');
  });
});

// ---------------------------------------------------------------------------
// resolve() ranking — the heart of Helm's project disambiguation
// ---------------------------------------------------------------------------

describe('ProjectRegistry.resolve ranking', () => {
  let reg: ProjectRegistry;

  beforeEach(() => {
    reg = ProjectRegistry.open(home);
    reg.add({ name: 'Login', path: makeRepo('login-service'), description: 'auth and sessions' });
    reg.add({ name: 'Login Legacy', path: makeRepo('legacy'), description: 'the old auth stack' });
    reg.add({ name: 'Docs', path: makeRepo('docs'), description: 'login flow documentation and test plans' });
    reg.add({ name: 'Auth UI', path: makeRepo('login-ui'), description: 'frontend' });
    reg.add({ name: 'BlueSpace', path: makeRepo('bluespace'), description: 'multi-agent orchestrator' });
  });

  const names = (hint: string): string[] => reg.resolve(hint).map((p) => p.name);

  it('ranks exact name, then name-substring, then description, then path basename', () => {
    expect(names('login')).toEqual(['Login', 'Login Legacy', 'Docs', 'Auth UI']);
  });

  it('ranks an exact id above everything else', () => {
    const docs = reg.list().find((p) => p.name === 'Docs');
    expect(docs).toBeDefined();
    expect(names(docs!.id)[0]).toBe('Docs');
  });

  it('matches an id prefix', () => {
    const docs = reg.list().find((p) => p.name === 'Docs');
    expect(names(docs!.id.slice(0, 9))[0]).toBe('Docs');
  });

  it('finds the project inside a plain-English request', () => {
    // The whole point: the captain never has to name a project. "Login" wins on
    // its name appearing verbatim in the sentence; the rest are weak token
    // matches Helm can show as alternatives or ignore.
    expect(names('fix the login test')).toEqual(['Login', 'Login Legacy', 'Docs', 'Auth UI']);
    const scored = reg.resolveScored('fix the login test');
    expect(scored[0]?.project.name).toBe('Login');
    // The winner leads by a tier, not by a rounding error.
    expect(scored[0]!.score).toBeGreaterThan((scored[1]?.score ?? 0) * 5);
  });

  it('is case-insensitive', () => {
    expect(names('BLUESPACE')[0]).toBe('BlueSpace');
    expect(names('bluespace')[0]).toBe('BlueSpace');
  });

  it('returns an empty array for an empty hint or no match', () => {
    expect(reg.resolve('')).toEqual([]);
    expect(reg.resolve('   ')).toEqual([]);
    expect(reg.resolve('kubernetes cluster autoscaler')).toEqual([]);
  });

  it('is deterministic across repeated calls', () => {
    const first = names('login');
    for (let i = 0; i < 5; i += 1) expect(names('login')).toEqual(first);
  });
});
