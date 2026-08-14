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
  DEFAULT_ADDRESS,
  DEFAULT_MAX_CONCURRENT_CREW,
  DEFAULT_MAX_TOKENS_PER_TASK,
  MIRROR_VOICE,
  ProjectRegistry,
  ProjectRegistryError,
  addressTerm,
  configPath,
  configReader,
  dataDir,
  defaultConfig,
  detectLanguage,
  loadConfig,
  localeVarInEffect,
  normalizeLanguage,
  resolveCaptainVoice,
  resolveHelmPosture,
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

describe('configReader', () => {
  it('notices an edit made while the process is running', async () => {
    // THE BUG THIS EXISTS FOR. The orchestrator was handed a snapshot taken at
    // boot, so a captain who raised a ceiling after watching a task die to it
    // changed nothing: the check that killed the next task still read the old
    // number, and the only way to deliver a setting was to close the window
    // running the work. Three rounds of healthy tasks died that way.
    writeConfig(JSON.stringify({ maxTokensPerTask: 1000 }));
    const read = configReader(0);
    expect(read().maxTokensPerTask).toBe(1000);

    writeConfig(JSON.stringify({ maxTokensPerTask: 9000 }));
    expect(read().maxTokensPerTask).toBe(9000);
  });

  it('does not read the file on every call', () => {
    // It is asked for the ceiling on every poll of every crew.
    writeConfig(JSON.stringify({ maxRework: 1 }));
    const read = configReader(60_000);
    expect(read().maxRework).toBe(1);
    writeConfig(JSON.stringify({ maxRework: 7 }));
    expect(read().maxRework).toBe(1);
  });
});

describe('defaults', () => {
  it('honours BLUESPACE_HOME for dataDir and configPath', () => {
    expect(dataDir()).toBe(home);
    expect(configPath()).toBe(path.join(home, 'config.json'));
  });

  it('defaults to autonomous crews and NO token ceiling', () => {
    expect(defaultConfig()).toEqual({
      permissionMode: 'auto',
      effort: 'high',
      maxTokensPerTask: DEFAULT_MAX_TOKENS_PER_TASK,
      maxBudgetUsdPerTask: 5,
      maxConcurrentCrew: DEFAULT_MAX_CONCURRENT_CREW,
      maxRework: 2,
      dataDir: home,
    });
    // Both are the captain's decision, and both are stated rather than implied:
    // 0 means nothing stops a runaway task, and 10 crews at once is a decision
    // about the volume paragraph in docs/compliance.md.
    expect(DEFAULT_MAX_TOKENS_PER_TASK).toBe(0);
    expect(DEFAULT_MAX_CONCURRENT_CREW).toBe(10);
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
    const cleared = saveConfig({ model: null });
    expect(cleared.model).toBeUndefined();
    expect(loadConfig().model).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The captain's language
// ---------------------------------------------------------------------------

describe('detectLanguage', () => {
  it('reads the locale variables in POSIX precedence order', () => {
    expect(detectLanguage({ LC_ALL: 'zh_CN.UTF-8', LC_MESSAGES: 'ja_JP', LANG: 'en_US' })).toBe('zh-CN');
    expect(detectLanguage({ LC_MESSAGES: 'ja_JP.UTF-8', LANG: 'en_US.UTF-8' })).toBe('ja-JP');
    expect(detectLanguage({ LANG: 'en_US.UTF-8' })).toBe('en-US');
    expect(localeVarInEffect({ LC_MESSAGES: 'ja_JP', LANG: 'en_US' })).toBe('LC_MESSAGES');
    expect(localeVarInEffect({})).toBeUndefined();
  });

  it('skips an unset or empty variable and asks the next one', () => {
    // An empty LC_ALL is an absence, not an answer — it is what a shell leaves
    // behind after `LC_ALL= some-command`.
    expect(detectLanguage({ LC_ALL: '', LANG: 'zh_CN.UTF-8' })).toBe('zh-CN');
    expect(detectLanguage({ LC_ALL: '   ', LC_MESSAGES: '', LANG: 'zh_TW' })).toBe('zh-TW');
  });

  it('resolves C and POSIX to NOTHING rather than to English', () => {
    // The whole point. `C` is the locale that means "no localisation", and every
    // build box, cron job and `LC_ALL=C` wrapper sets one. Reading it as a vote
    // for English would answer a Chinese captain in English because of a
    // variable nobody set on purpose; resolving to nothing means Helm mirrors
    // whatever they write, which is the better failure of the two.
    for (const value of ['C', 'POSIX', 'c', 'C.UTF-8', 'posix']) {
      expect(detectLanguage({ LANG: value }), value).toBeUndefined();
    }
    expect(detectLanguage({})).toBeUndefined();
    // And a set LC_ALL decides even when it names no language: POSIX gives it
    // precedence outright, so we do not reach past it for LANG.
    expect(detectLanguage({ LC_ALL: 'C', LANG: 'zh_CN.UTF-8' })).toBeUndefined();
  });

  it('drops encodings, modifiers and garbage', () => {
    expect(detectLanguage({ LANG: 'zh_CN.UTF-8@pinyin' })).toBe('zh-CN');
    expect(detectLanguage({ LANG: 'zh_Hans_CN' })).toBe('zh-Hans-CN');
    expect(detectLanguage({ LANG: 'en' })).toBe('en');
    expect(detectLanguage({ LANG: '@@@' })).toBeUndefined();
    expect(detectLanguage({ LANG: '42' })).toBeUndefined();
  });
});

describe('language as a config key', () => {
  it('persists a pin and reloads it', () => {
    expect(saveConfig({ language: 'zh-CN' }).language).toBe('zh-CN');
    expect(loadConfig().language).toBe('zh-CN');
    const onDisk = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
    expect(onDisk.language).toBe('zh-CN');
  });

  it('is absent from a config that never set one, rather than written as English', () => {
    expect(defaultConfig().language).toBeUndefined();
    saveConfig({ maxRework: 1 });
    const onDisk = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
    expect(onDisk).not.toHaveProperty('language');
  });

  it('canonicalises a locale the captain pasted out of their environment', () => {
    expect(saveConfig({ language: 'zh_CN.UTF-8' }).language).toBe('zh-CN');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('keeps a language named in words verbatim', () => {
    // The value is read by a model, not by a locale library: "中文" and
    // "Simplified Chinese" are exactly as clear to it as "zh-CN".
    expect(saveConfig({ language: '中文' }).language).toBe('中文');
    expect(saveConfig({ language: 'Simplified Chinese' }).language).toBe('Simplified Chinese');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('refuses a value that names no language, and keeps its siblings', () => {
    writeConfig(JSON.stringify({ language: 'C', maxRework: 3 }));
    const cfg = loadConfig();
    expect(cfg.language).toBeUndefined();
    expect(cfg.maxRework).toBe(3);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('name no language');

    // `null` is absent on purpose — it is the documented way to CLEAR the key,
    // not a bad value. The case above it covers that.
    for (const bad of ['POSIX', '', '   ', 'x'.repeat(41), 7]) {
      warnSpy.mockClear();
      writeConfig(JSON.stringify({ language: bad }));
      expect(loadConfig().language, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('clears the pin on null, which means "follow whatever I write"', () => {
    saveConfig({ language: 'zh-CN' });
    expect(saveConfig({ language: null }).language).toBeUndefined();
    expect(loadConfig().language).toBeUndefined();
    const onDisk = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
    expect(onDisk).not.toHaveProperty('language');
  });

  it('normalizeLanguage answers the same questions the loader asks', () => {
    expect(normalizeLanguage('zh_CN.UTF-8')).toBe('zh-CN');
    expect(normalizeLanguage('  en  ')).toBe('en');
    expect(normalizeLanguage('C')).toBeUndefined();
    expect(normalizeLanguage('POSIX')).toBeUndefined();
    expect(normalizeLanguage('')).toBeUndefined();
  });
});

describe('addressTerm', () => {
  it('calls a Chinese-speaking captain 舰长, however the language is spelled', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hans-CN', 'ZH-cn', '中文', 'Chinese']) {
      expect(addressTerm(tag), tag).toBe('舰长');
    }
  });

  it('falls back to Captain for English, for the unknown, and for what it has no word for', () => {
    // The table is short on purpose: it holds the one term the captain actually
    // gave us. Everything else is the model's to translate — see the launcher's
    // system prompt, which tells it to.
    expect(addressTerm(undefined)).toBe(DEFAULT_ADDRESS);
    expect(addressTerm('en-GB')).toBe('Captain');
    expect(addressTerm('de-DE')).toBe('Captain');
  });
});

describe('resolveCaptainVoice', () => {
  it('lets the captain’s pin beat the environment', () => {
    const voice = resolveCaptainVoice('zh-CN', { LANG: 'en_US.UTF-8' });
    expect(voice).toEqual({ language: 'zh-CN', address: '舰长', pinned: true });
  });

  it('detects when there is no pin, and says it is a guess', () => {
    const voice = resolveCaptainVoice(undefined, { LANG: 'zh_CN.UTF-8' });
    expect(voice).toEqual({ language: 'zh-CN', address: '舰长', pinned: false });
  });

  it('resolves to "mirror whatever they write" when nothing knows', () => {
    expect(resolveCaptainVoice(undefined, { LANG: 'C' })).toEqual(MIRROR_VOICE);
    expect(resolveCaptainVoice(undefined, {})).toEqual({ address: 'Captain', pinned: false });
    // Undefined, not "en": nothing here is entitled to claim they read English.
    expect(resolveCaptainVoice(undefined, {}).language).toBeUndefined();
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
    expect(cfg.maxConcurrentCrew).toBe(DEFAULT_MAX_CONCURRENT_CREW);
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
// How the Helm window opens
// ---------------------------------------------------------------------------

describe('the Helm posture', () => {
  it('defaults to the captain’s ask: ultracode, and a posture that does not ask', () => {
    expect(resolveHelmPosture(defaultConfig())).toEqual({
      ultracode: true,
      permissionMode: 'auto',
    });
  });

  it('distinguishes “never said” from “turned it off”', () => {
    // The distinction is the whole reason these are optional. An unset key
    // tracks the default if it ever changes; `false` is a decision that stays
    // made. A required key with a default value cannot express the difference.
    expect(resolveHelmPosture({}).ultracode).toBe(true);
    expect(resolveHelmPosture({ helmUltracode: false }).ultracode).toBe(false);
  });

  it('is settable and clearable, and unset keys are not written to disk', () => {
    saveConfig({ helmUltracode: false, helmPermissionMode: 'manual' });
    expect(loadConfig().helmUltracode).toBe(false);
    expect(loadConfig().helmPermissionMode).toBe('manual');

    saveConfig({ helmUltracode: null, helmPermissionMode: null });
    const cleared = loadConfig();
    expect(cleared.helmUltracode).toBeUndefined();
    expect(cleared.helmPermissionMode).toBeUndefined();
    // Cleared means ABSENT, not `false` — writing today's default into the file
    // would freeze a captain who never touched it onto the old value.
    const onDisk = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
    expect('helmUltracode' in onDisk).toBe(false);
    expect('helmPermissionMode' in onDisk).toBe(false);
  });

  it('drops a nonsense value instead of reading it as “off”', () => {
    // A typo that silently turned ultracode off would be indistinguishable from
    // it never working, which is the failure this whole feature is about.
    writeConfig('{"helmUltracode":"yes","helmPermissionMode":"superuser"}');
    const cfg = loadConfig();
    expect(cfg.helmUltracode).toBeUndefined();
    expect(cfg.helmPermissionMode).toBeUndefined();
    expect(resolveHelmPosture(cfg)).toEqual({ ultracode: true, permissionMode: 'auto' });
    expect(warnSpy).toHaveBeenCalled();
  });

  it('migrates a retired permission mode here too, rather than dropping the key', () => {
    writeConfig('{"helmPermissionMode":"default"}');
    expect(loadConfig().helmPermissionMode).toBe('manual');
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
