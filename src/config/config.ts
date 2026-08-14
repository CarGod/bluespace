/**
 * Global BlueSpace configuration.
 *
 * Owns: where BlueSpace keeps its state on disk (`dataDir`), the defaults every
 * dispatch inherits, and the read/validate/merge/write cycle for
 * `<dataDir>/config.json`.
 *
 * Two rules shape this file:
 *
 *  1. `loadConfig()` NEVER throws. A corrupt, unreadable, or half-written config
 *     file must not stop the fleet from starting — it degrades to defaults and
 *     says so on stderr. Individual bad values are dropped one at a time so a
 *     single typo does not discard the rest of the captain's settings.
 *
 *  2. Writes are atomic (temp file + fsync + rename). The CLI, the server, and a
 *     running orchestrator all read this file; none of them may ever observe a
 *     truncated one.
 *
 * `dataDir` is derived, not configurable from inside the file it lives in —
 * BLUESPACE_HOME (or ~/.bluespace) always wins. It is mirrored into BlueConfig
 * so consumers can thread one object around instead of re-deriving the path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Effort, PermissionMode } from '../types/domain.js';
import { DEFAULT_PERMISSION_MODE } from '../types/domain.js';

// ---------------------------------------------------------------------------
// Legal enum values (mirrored from domain.ts, which is the contract)
// ---------------------------------------------------------------------------

export const PERMISSION_MODES: readonly PermissionMode[] = [
  'auto',
  'acceptEdits',
  'plan',
  'manual',
  'dontAsk',
  'bypassPermissions',
] as const;

/**
 * Modes that used to be legal, and what they become.
 *
 * BlueSpace's permission vocabulary was invented against a vendor SDK. It now
 * mirrors `claude --permission-mode`, and two of the old names have no harness
 * equivalent — they were never going to survive contact with the real flag.
 * A config on disk outlives a refactor, so these are migrated with a sentence
 * saying what happened rather than rejected with "expected one of …", which
 * tells a captain nothing about why the value they set last month is gone.
 */
const RETIRED_PERMISSION_MODES: Readonly<Record<string, { to: PermissionMode; why: string }>> = {
  // The SDK's "prompt on anything sensitive" posture. `manual` is that.
  default: { to: 'manual', why: 'renamed — the harness calls this "manual"' },
  // Never existed outside BlueSpace: a classifier deciding in place of a human
  // is not something `claude --permission-mode` offers.
  async: {
    to: 'auto',
    why: 'removed — no harness equivalent; "auto" is the unattended posture now',
  },
};

/**
 * Default token ceiling for one task.
 *
 * Sized against the ceiling it replaces: $5 of Opus input is 1M tokens, and $5
 * of Opus cache reads is 10M, so a task that used to die at $5 died somewhere
 * between those. 5M sits in the middle and is generous for one task's worth of
 * work while still stopping a Crew that has started looping. Named because the
 * migration warning quotes it.
 */
export const DEFAULT_MAX_TOKENS_PER_TASK = 5_000_000;

export const EFFORT_LEVELS: readonly Effort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

// ---------------------------------------------------------------------------
// How the Helm window opens
// ---------------------------------------------------------------------------

/**
 * What `bluespace` opens at when the captain has pinned nothing.
 *
 * THE DEFAULT IS THE ASK, VERBATIM: *"能否让我们 bluespace 命令启动的时候，默认就是
 * effort=ultracode 然后运行模式就是超级权限的模式"*. It lives here rather than as a
 * literal in the launcher so that `blue config` can print what an unset key
 * resolves to, which is the difference between a captain who can see their own
 * settings and one who has to read our source to find out.
 *
 * Both halves are measured — see `ULTRACODE_SETTINGS_KEY` and
 * `HELM_PERMISSION_MODE_ARGUMENT` in `src/cli/bluespace.ts`. Neither widens the
 * window's tool clamp, and `permissionMode` here is deliberately NOT
 * `bypassPermissions`: that one opens on a modal only a human can dismiss and
 * writes a machine-wide flag into the captain's global config when they do.
 */
export const DEFAULT_HELM_POSTURE: { ultracode: boolean; permissionMode: PermissionMode } = {
  ultracode: true,
  permissionMode: 'auto',
};

/** How this window will actually open: the captain's pins over the defaults. */
export function resolveHelmPosture(cfg: {
  helmUltracode?: boolean;
  helmPermissionMode?: PermissionMode;
}): { ultracode: boolean; permissionMode: PermissionMode } {
  return {
    ultracode: cfg.helmUltracode ?? DEFAULT_HELM_POSTURE.ultracode,
    permissionMode: cfg.helmPermissionMode ?? DEFAULT_HELM_POSTURE.permissionMode,
  };
}

// ---------------------------------------------------------------------------
// The captain's language
// ---------------------------------------------------------------------------

/**
 * The locale variables, in POSIX precedence order.
 *
 * `LC_ALL` overrides everything, `LC_MESSAGES` is the category that governs the
 * language a program *talks* in (as opposed to how it sorts or formats money),
 * and `LANG` is the fallback for every unset category. Anything further down —
 * `LC_CTYPE`, `LANGUAGE` — is either about encoding or is a GNU extension
 * carrying a colon-separated preference list, and neither is worth guessing a
 * captain's language from.
 */
export const LOCALE_ENV_VARS = ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const;

/** How Helm addresses the captain when nothing better is known. */
export const DEFAULT_ADDRESS = 'Captain';

/**
 * The address term, by language. Deliberately short.
 *
 * There is exactly one non-English entry because there is exactly one term we
 * were actually given: the captain asked to be called 舰长. Filling this table
 * out with Kapitän, Capitaine, Капитан and the rest would be inventing content
 * nobody has checked, in a place where being wrong is invisible until it reaches
 * the person being addressed. The launcher's system prompt instead tells the
 * model to use the natural equivalent of "Captain" when the language it is
 * writing in is not in here — a translation the model is better at than this
 * table will ever be. Add a row when a captain tells you the word they want.
 *
 * Keys are matched against the whole tag first, then its primary subtag, both
 * lowercased — so `zh`, `zh-CN`, `zh-Hans-CN` and a hand-typed `中文` all land
 * on the same term.
 */
const ADDRESS_TERMS: Readonly<Record<string, string>> = {
  zh: '舰长',
  中文: '舰长',
  chinese: '舰长',
};

/**
 * Longest value accepted for `language`.
 *
 * The value is pasted into a system prompt, so it is an input to the model, not
 * just a setting. "Simplified Chinese" fits; a pasted paragraph is not a
 * language and must not become one line of Helm's instructions.
 */
const MAX_LANGUAGE_LENGTH = 40;

/** Locale-shaped: `zh`, `zh_CN`, `zh-Hans-CN`, `en_US.UTF-8`, `zh_CN@pinyin`, `C`. */
const LOCALE_SHAPE = /^[A-Za-z]{1,8}([_-][A-Za-z0-9]{1,8})*(\.[^\s@]+)?(@[^\s]+)?$/;

/**
 * A POSIX locale or BCP-47 tag, canonicalised — or undefined when it names no
 * language at all.
 *
 * `C` and `POSIX` are the important undefined case, and they are NOT English.
 * They are the locale that means "no localisation": every build server, cron
 * job and `LC_ALL=C` script sets one, and reading it as a request for English
 * would tell Helm to answer a Chinese captain in English on the strength of a
 * variable nobody set on purpose. Undetectable resolves to nothing, and nothing
 * means "mirror whatever the captain writes" — the better failure of the two.
 */
export function canonicalLanguageTag(raw: string): string | undefined {
  const base = (raw.split('@')[0] ?? '').split('.')[0] ?? '';
  const parts = base.split(/[_-]/).filter((p) => p !== '');
  const primary = (parts[0] ?? '').toLowerCase();
  // `C` fails the length test; `POSIX` has to be named.
  if (!/^[a-z]{2,8}$/.test(primary) || primary === 'c' || primary === 'posix') return undefined;
  const rest = parts.slice(1);
  if (rest.some((s) => !/^[A-Za-z0-9]{1,8}$/.test(s))) return undefined;
  return [
    primary,
    // BCP-47 casing: region UPPER, script Titlecase, everything else lower. It
    // is cosmetic — nothing here parses the tag again — but a config file the
    // captain opens should not show them `zh_cn.utf-8`.
    ...rest.map((s) =>
      s.length === 2
        ? s.toUpperCase()
        : s.length === 4
          ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
          : s.toLowerCase(),
    ),
  ].join('-');
}

/**
 * What the captain may type into `blue config set language <v>`: a locale tag,
 * canonicalised — or a language named in words, kept verbatim.
 *
 * Free-form is allowed on purpose. This value is read by a model, not by a
 * locale library, and "Simplified Chinese", "中文" and "zh-CN" are all perfectly
 * clear to it. Being stricter would reject the spelling a captain reaches for
 * first while gaining nothing.
 */
export function normalizeLanguage(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > MAX_LANGUAGE_LENGTH) return undefined;
  if (LOCALE_SHAPE.test(trimmed)) return canonicalLanguageTag(trimmed);
  return trimmed;
}

/** The locale variable that decides, and its value — POSIX order, first one set wins. */
function decidingLocale(env: NodeJS.ProcessEnv): { name: string; value: string } | undefined {
  for (const name of LOCALE_ENV_VARS) {
    const value = env[name];
    if (value !== undefined && value.trim() !== '') return { name, value };
  }
  return undefined;
}

/** Which locale variable this environment is answering from, if any. */
export function localeVarInEffect(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return decidingLocale(env)?.name;
}

/**
 * The captain's language as this shell reports it, or undefined.
 *
 * Unset and empty variables are skipped — an empty `LC_ALL` is not an answer, it
 * is an absence. A variable that IS set decides, even if what it names is `C`:
 * POSIX gives `LC_ALL` precedence outright, and a captain (or a wrapper script)
 * who set it to `C` asked for no localisation, which is a thing we can honour by
 * returning nothing rather than reaching past them for `LANG`.
 */
export function detectLanguage(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const found = decidingLocale(env);
  return found === undefined ? undefined : canonicalLanguageTag(found.value);
}

/** The term Helm addresses the captain with, for a language. */
export function addressTerm(language: string | undefined): string {
  if (language === undefined) return DEFAULT_ADDRESS;
  const lower = language.toLowerCase();
  const primary = lower.split('-')[0] ?? lower;
  return ADDRESS_TERMS[lower] ?? ADDRESS_TERMS[primary] ?? DEFAULT_ADDRESS;
}

/**
 * Everything a window needs to know about who it is talking to: which language
 * to write in, what to call them, and whether that language is the captain's own
 * standing instruction or this process's guess at it.
 */
export interface CaptainVoice {
  /** The language to write in. Undefined means "mirror whatever they write". */
  language?: string;
  /** 舰长, Captain, … — always populated; `DEFAULT_ADDRESS` when unknown. */
  address: string;
  /** True when the captain pinned it in config; false when it was detected. */
  pinned: boolean;
  /**
   * True when the captain was asked at first launch and chose to be followed
   * rather than to pin anything.
   *
   * It is not the same silence as a key nobody has touched. "Nothing here says"
   * is a gap Helm may offer to fill — `CLAUDE.md` lets it name
   * `blue config set language` once, in a clause. "I was asked, and I said
   * follow me" is an answer, and offering the command again is putting the same
   * question a second time.
   */
  declined?: boolean;
}

/** What a window knows about its captain when nothing at all resolved. */
export const MIRROR_VOICE: CaptainVoice = { address: DEFAULT_ADDRESS, pinned: false };

/**
 * The same silence, chosen rather than inherited.
 *
 * Reads identically to {@link MIRROR_VOICE} everywhere that only asks "which
 * language" — and differently in the one place it has to: the launcher does not
 * offer a setting to a captain who has already turned it down.
 */
export const DECLINED_VOICE: CaptainVoice = { address: DEFAULT_ADDRESS, pinned: false, declined: true };

/**
 * The pin wins; failing that, the environment; failing that, nothing.
 *
 * `pinned` is not decoration — it is the difference between a standing
 * instruction and a guess, and the two behave differently when the captain then
 * writes in a third language. See the launcher's system prompt section.
 */
export function resolveCaptainVoice(
  pinned: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: { declined?: boolean } = {},
): CaptainVoice {
  // A decline outranks the locale, and only the locale. The first-run question
  // shows the detected language as an option BY NAME — declining it is a
  // captain looking at `en-AU` and saying no, so carrying on and using `en-AU`
  // anyway would answer for them. A pin still wins over both: it is the newer
  // instruction, and the only way to get one is to have said it.
  if (pinned === undefined && options.declined === true) return DECLINED_VOICE;
  const language = pinned ?? detectLanguage(env);
  if (language === undefined) return MIRROR_VOICE;
  return { language, address: addressTerm(language), pinned: pinned !== undefined };
}

/**
 * The voice a whole config implies — the pin, then the decline, then the shell.
 *
 * One function so that the three-way rule lives in one place: every caller that
 * reached for `resolveCaptainVoice(config.language, env)` was one edit away from
 * silently dropping the decline and reinstating the guess.
 */
export function captainVoice(
  config: Pick<BlueConfig, 'language' | 'languageAsked'>,
  env: NodeJS.ProcessEnv = process.env,
): CaptainVoice {
  return resolveCaptainVoice(config.language, env, { declined: config.languageAsked === true });
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface BlueConfig {
  /**
   * Permission posture handed to every Crew. Defaults to `auto`: BlueSpace runs
   * crews unattended, and a permission prompt nobody is sitting in front of is
   * just a hang — but `bypassPermissions`, which is the other way to avoid one,
   * costs a modal only a human can dismiss and writes a machine-wide loosening
   * into the captain's global config. See `PermissionMode` in types/domain.ts.
   * The captain can dial it back here.
   */
  permissionMode: PermissionMode;
  /** Model id. Undefined means "whatever the harness defaults to". */
  model?: string;
  effort?: Effort;
  /**
   * TOKEN ceiling for a single task, across its Crew and Sentinel runs, summed
   * over input, output, cache-read and cache-creation tokens.
   *
   * THE CEILING THAT ACTUALLY STOPS A RUNAWAY TASK, because tokens are the only
   * quantity every run reports and the only one that means anything on a
   * subscription. 0 disables it — and disables the only ceiling a subscription
   * run has, which `blue config` says out loud.
   *
   * The default is deliberately generous: cache reads dominate an agentic run
   * (the whole conversation prefix is re-read every turn), so a normal task
   * measures in millions of tokens and a ceiling set from intuition about
   * "how many words is that" would kill healthy work. 5M is roughly what the
   * old $5-of-Opus ceiling bought.
   */
  maxTokensPerTask: number;
  /**
   * USD ceiling for a single task — ENFORCED ONLY ON A METERED RUN, i.e. one
   * launched with `ANTHROPIC_API_KEY` set. On a Claude subscription the tokens
   * draw down a quota and are never invoiced, so there is no spend for this to
   * bound; `maxTokensPerTask` is the ceiling that fires there. See README.
   */
  maxBudgetUsdPerTask: number;
  /** How many Crew may be in flight at once. */
  maxConcurrentCrew: number;
  /** How many times a failed verdict may send a task back to its Crew. */
  maxRework: number;
  /**
   * The captain's pin for whether the Helm window opens at ultracode — xhigh
   * effort plus standing dynamic-workflow orchestration.
   *
   * OPTIONAL, AND UNSET IS NOT FALSE. Unset means they never said, which
   * resolves to {@link DEFAULT_HELM_POSTURE} — on, because that is what they
   * asked for. `false` means they turned it off and it stays off. The same
   * shape as `language` above and for the same reason: a default the captain
   * has not overruled must not be indistinguishable from a choice they made.
   *
   * SEPARATE FROM `effort` ABOVE, AND IT HAS TO BE. `effort` is what a Crew is
   * dispatched with, through `--effort`, whose accepted values are exactly
   * `low, medium, high, xhigh, max`. `ultracode` is not one of them: it is a
   * settings key, it is session-scoped, and it reaches the window through
   * `--settings` rather than a flag. Folding it into `effort` would mean an
   * enum with a member the flag it feeds cannot spell — and, worse, would make
   * the window pass `--effort`, which silently defeats ultracode outright. See
   * `ULTRACODE_SETTINGS_KEY` in the launcher.
   *
   * Boolean rather than a level because that is the shape of the thing: the
   * harness has one ultracode, and a captain who wants the window at plain
   * xhigh already has `/effort xhigh` inside it.
   */
  helmUltracode?: boolean;
  /**
   * The captain's pin for the Helm window's permission posture. Unset resolves
   * to {@link DEFAULT_HELM_POSTURE}.
   *
   * They asked for "超级权限的模式", and `auto` is the honest maximum: with
   * `HELM_DENIED_TOOLS` in force the window has no Bash, Edit, Write or
   * NotebookEdit at all, so what is left to be asked about is reading, the web,
   * and MCP calls. `auto` stops the asking. It does NOT hand anything back —
   * read `HELM_PERMISSION_MODE_ARGUMENT` in the launcher before changing this
   * to `bypassPermissions`, which was measured and rejected.
   */
  helmPermissionMode?: PermissionMode;
  /**
   * The language Helm writes to the captain in — the captain's explicit pin,
   * and it always wins.
   *
   * Undefined is a real answer, not a missing one: it means nothing here claims
   * to know, so Helm opens in English and follows the captain from their first
   * message. The launcher fills the gap by DETECTING a language from the shell's
   * locale (`detectLanguage`); this key exists for when that guess is wrong, or
   * when there is no locale to guess from.
   *
   * BlueSpace is not a Chinese tool. It is a tool one captain uses in Chinese,
   * and this is the one line that says so — nothing downstream hardcodes a
   * language, and the address term travels with this value (`addressTerm`).
   */
  language?: string;
  /**
   * Has the captain been put the language question, once, at first launch?
   *
   * Written by answering it and equally by declining it, because what it records
   * is that they were ASKED. `language` alone cannot carry that: "nobody has
   * ever said" and "they were shown the guess and passed on it" are both an
   * absent key, and the two must not behave the same. A decline turns the locale
   * guess off (see {@link resolveCaptainVoice}) and stops Helm mentioning the
   * setting at all.
   *
   * `blue config set languageAsked false` puts the question back.
   */
  languageAsked?: boolean;
  /** Derived from BLUESPACE_HOME / ~/.bluespace. Not settable from the file. */
  dataDir: string;
}

/**
 * A patch for `saveConfig`. `null` clears an optional field; leaving a key out
 * leaves it alone.
 *
 * Spelled as its own type because `Partial<BlueConfig>` cannot express the
 * clear: a caller that wrote `{ model: undefined }` meaning "clear it" got a
 * key that `mergeConfig` correctly ignores, and their model stayed put.
 */
export type ConfigPatch = { [K in keyof BlueConfig]?: BlueConfig[K] | null };

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Where BlueSpace keeps everything: config, the project registry, the Blackbox.
 * Read from the environment on every call so tests (and `BLUESPACE_HOME=... blue`)
 * can redirect it without a process restart.
 */
export function dataDir(): string {
  const fromEnv = process.env.BLUESPACE_HOME;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return path.resolve(expandHome(fromEnv.trim()));
  }
  return path.join(os.homedir(), '.bluespace');
}

export function configPath(): string {
  return path.join(dataDir(), 'config.json');
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function defaultConfig(): BlueConfig {
  return {
    permissionMode: DEFAULT_PERMISSION_MODE,
    effort: 'high',
    maxTokensPerTask: DEFAULT_MAX_TOKENS_PER_TASK,
    maxBudgetUsdPerTask: 5,
    maxConcurrentCrew: 4,
    maxRework: 2,
    dataDir: dataDir(),
  };
}

// ---------------------------------------------------------------------------
// Disk primitives — shared with the project registry
// ---------------------------------------------------------------------------

function warn(message: string): void {
  console.warn(`[bluespace:config] ${message}`);
}

/** Create the data directory if it is missing. Returns false if we could not. */
export function ensureDataDir(dir: string = dataDir()): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return true;
  } catch (err) {
    warn(`could not create data directory ${dir}: ${errText(err)}`);
    return false;
  }
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Write JSON so that a reader either sees the whole previous file or the whole
 * new one, never a prefix of either: serialize, write to a unique temp file in
 * the same directory, fsync it, then rename over the target.
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, body, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw new Error(`failed to write ${filePath}: ${errText(err)}`);
  }
}

/**
 * Read a JSON object from disk. Returns undefined when the file is absent,
 * unreadable, unparseable, or not a JSON object — every one of which is a
 * "fall back to defaults" condition rather than a crash.
 */
export function readJsonObject(filePath: string, label: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      warn(`could not read ${label} at ${filePath}: ${errText(err)} — using defaults`);
    }
    return undefined;
  }
  if (raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(`${label} at ${filePath} is not valid JSON (${errText(err)}) — using defaults`);
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warn(`${label} at ${filePath} is not a JSON object — using defaults`);
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Validation / merge
// ---------------------------------------------------------------------------

function pickEnum<T extends string>(
  value: unknown,
  legal: readonly T[],
  field: string,
): { ok: true; value: T } | { ok: false } {
  if (typeof value === 'string' && (legal as readonly string[]).includes(value)) {
    return { ok: true, value: value as T };
  }
  warn(
    `ignoring invalid ${field} ${JSON.stringify(value)} — expected one of ${legal
      .map((v) => JSON.stringify(v))
      .join(', ')}`,
  );
  return { ok: false };
}

function pickNumber(
  value: unknown,
  field: string,
  opts: { min: number; integer?: boolean },
): { ok: true; value: number } | { ok: false } {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    warn(`ignoring invalid ${field} ${JSON.stringify(value)} — expected a finite number`);
    return { ok: false };
  }
  if (opts.integer && !Number.isInteger(value)) {
    warn(`ignoring invalid ${field} ${JSON.stringify(value)} — expected an integer`);
    return { ok: false };
  }
  if (value < opts.min) {
    warn(`ignoring invalid ${field} ${JSON.stringify(value)} — must be >= ${opts.min}`);
    return { ok: false };
  }
  return { ok: true, value };
}

/**
 * Fold a raw record over a base config, dropping anything illegal with a
 * warning. Unknown keys are ignored so an older binary can read a newer file.
 *
 * Convention for optional fields (`model`, `effort`): `undefined` means "leave
 * alone", `null` means "clear it".
 */
export function mergeConfig(base: BlueConfig, patch: Record<string, unknown>): BlueConfig {
  const out: BlueConfig = { ...base };

  if (patch.permissionMode !== undefined) {
    const retired =
      typeof patch.permissionMode === 'string'
        ? RETIRED_PERMISSION_MODES[patch.permissionMode]
        : undefined;
    if (retired !== undefined) {
      warn(
        `permissionMode ${JSON.stringify(patch.permissionMode)} is ${retired.why}; using ${JSON.stringify(retired.to)}`,
      );
      out.permissionMode = retired.to;
    } else {
      const got = pickEnum<PermissionMode>(patch.permissionMode, PERMISSION_MODES, 'permissionMode');
      if (got.ok) out.permissionMode = got.value;
    }
  }

  if ('effort' in patch) {
    if (patch.effort === null) {
      out.effort = undefined;
    } else if (patch.effort !== undefined) {
      const got = pickEnum<Effort>(patch.effort, EFFORT_LEVELS, 'effort');
      if (got.ok) out.effort = got.value;
    }
  }

  if ('helmUltracode' in patch) {
    if (patch.helmUltracode === null) {
      out.helmUltracode = undefined;
    } else if (typeof patch.helmUltracode === 'boolean') {
      out.helmUltracode = patch.helmUltracode;
    } else if (patch.helmUltracode !== undefined) {
      warn(
        `ignoring invalid helmUltracode ${JSON.stringify(patch.helmUltracode)} — expected true or false`,
      );
    }
  }

  if ('helmPermissionMode' in patch && patch.helmPermissionMode === null) {
    out.helmPermissionMode = undefined;
  } else if (patch.helmPermissionMode !== undefined) {
    // Retired names are migrated here too: the Helm posture is drawn from the
    // same vocabulary as the Crew one, so a config that predates the rename
    // must not lose this key while keeping the other.
    const retired =
      typeof patch.helmPermissionMode === 'string'
        ? RETIRED_PERMISSION_MODES[patch.helmPermissionMode]
        : undefined;
    if (retired !== undefined) {
      warn(
        `helmPermissionMode ${JSON.stringify(patch.helmPermissionMode)} is ${retired.why}; using ${JSON.stringify(retired.to)}`,
      );
      out.helmPermissionMode = retired.to;
    } else {
      const got = pickEnum<PermissionMode>(
        patch.helmPermissionMode,
        PERMISSION_MODES,
        'helmPermissionMode',
      );
      if (got.ok) out.helmPermissionMode = got.value;
    }
  }

  if ('model' in patch) {
    if (patch.model === null) {
      out.model = undefined;
    } else if (patch.model !== undefined) {
      if (typeof patch.model === 'string' && patch.model.trim() !== '') {
        out.model = patch.model.trim();
      } else {
        warn(`ignoring invalid model ${JSON.stringify(patch.model)} — expected a non-empty string`);
      }
    }
  }

  if ('language' in patch) {
    if (patch.language === null) {
      out.language = undefined;
    } else if (patch.language !== undefined) {
      const normalized = typeof patch.language === 'string' ? normalizeLanguage(patch.language) : undefined;
      if (normalized === undefined) {
        // Named separately from "expected a non-empty string" because `C` and
        // `POSIX` ARE non-empty strings, and a captain who copied one out of
        // their environment deserves to know why it was refused.
        warn(
          `ignoring invalid language ${JSON.stringify(patch.language)} — expected a language ` +
            'like "zh-CN", "en" or "Simplified Chinese". "C" and "POSIX" name no language; ' +
            'leave it unset for "follow whatever I write".',
        );
      } else {
        out.language = normalized;
      }
    }
  }

  if ('languageAsked' in patch) {
    if (patch.languageAsked === null) {
      out.languageAsked = undefined;
    } else if (typeof patch.languageAsked === 'boolean') {
      out.languageAsked = patch.languageAsked;
    } else if (patch.languageAsked !== undefined) {
      warn(
        `ignoring invalid languageAsked ${JSON.stringify(patch.languageAsked)} — expected true or false`,
      );
    }
  }

  if (patch.maxTokensPerTask !== undefined) {
    const got = pickNumber(patch.maxTokensPerTask, 'maxTokensPerTask', { min: 0, integer: true });
    if (got.ok) out.maxTokensPerTask = got.value;
  }

  if (patch.maxBudgetUsdPerTask !== undefined) {
    const got = pickNumber(patch.maxBudgetUsdPerTask, 'maxBudgetUsdPerTask', { min: 0 });
    if (got.ok) out.maxBudgetUsdPerTask = got.value;
    // A config written before the token ceiling existed is a config whose
    // author believes `maxBudgetUsdPerTask` stops their tasks. On a
    // subscription it never did anything but price a fiction, so they are told
    // what it means now rather than left with a setting that silently changed
    // meaning under them — the same courtesy RETIRED_PERMISSION_MODES extends.
    //
    // Keyed on the absence of `maxTokensPerTask` rather than on the presence of
    // the budget (which `serialize` always writes), so the notice appears once
    // and then stops: the next `blue config set` rewrites the file with both.
    if (got.ok && got.value > 0 && patch.maxTokensPerTask === undefined) {
      warn(
        `maxBudgetUsdPerTask ${JSON.stringify(got.value)} now applies ONLY to metered runs ` +
          '(ANTHROPIC_API_KEY set) — on a Claude subscription those tokens draw down a quota ' +
          'and cost no dollars, so there was never any spend for it to bound. The ceiling that ' +
          `stops a task now is maxTokensPerTask, defaulting to ${DEFAULT_MAX_TOKENS_PER_TASK.toLocaleString('en-US')} ` +
          'tokens. Set it explicitly (`blue config set maxTokensPerTask <n>`) to silence this.',
      );
    }
  }

  if (patch.maxConcurrentCrew !== undefined) {
    const got = pickNumber(patch.maxConcurrentCrew, 'maxConcurrentCrew', { min: 1, integer: true });
    if (got.ok) out.maxConcurrentCrew = got.value;
  }

  if (patch.maxRework !== undefined) {
    const got = pickNumber(patch.maxRework, 'maxRework', { min: 0, integer: true });
    if (got.ok) out.maxRework = got.value;
  }

  // `dataDir` is deliberately not taken from the patch: the environment decides
  // where BlueSpace lives, and a stale value in the file would point the
  // Blackbox somewhere the config itself does not live.
  out.dataDir = dataDir();
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read `<dataDir>/config.json` merged over the defaults. Creates the data
 * directory if it is missing. Never throws: a broken file yields defaults.
 */
export function loadConfig(): BlueConfig {
  const base = defaultConfig();
  ensureDataDir(base.dataDir);
  const raw = readJsonObject(configPath(), 'config');
  if (raw === undefined) return base;
  try {
    return mergeConfig(base, raw);
  } catch (err) {
    warn(`could not apply config (${errText(err)}) — using defaults`);
    return base;
  }
}

/** Merge `patch` over the current config, persist atomically, return the result. */
export function saveConfig(patch: ConfigPatch): BlueConfig {
  const merged = mergeConfig(loadConfig(), patch as Record<string, unknown>);
  writeJsonAtomic(configPath(), serialize(merged));
  return merged;
}

/** What actually lands on disk: `dataDir` is derived, so it is not persisted. */
function serialize(cfg: BlueConfig): Record<string, unknown> {
  return {
    permissionMode: cfg.permissionMode,
    // Omitted when unset, like `model` and `language`: an absent key is "you
    // never said", and writing today's default into the file would freeze it
    // there — a captain who never touched this would silently stop tracking the
    // default the day it changed.
    ...(cfg.helmUltracode !== undefined ? { helmUltracode: cfg.helmUltracode } : {}),
    ...(cfg.helmPermissionMode !== undefined
      ? { helmPermissionMode: cfg.helmPermissionMode }
      : {}),
    ...(cfg.model !== undefined ? { model: cfg.model } : {}),
    ...(cfg.effort !== undefined ? { effort: cfg.effort } : {}),
    ...(cfg.language !== undefined ? { language: cfg.language } : {}),
    // Persisted even though it is `false` half the time it is set, because
    // `false` here is not the default — it is "ask me again", which a captain
    // can only have got by typing it.
    ...(cfg.languageAsked !== undefined ? { languageAsked: cfg.languageAsked } : {}),
    maxTokensPerTask: cfg.maxTokensPerTask,
    maxBudgetUsdPerTask: cfg.maxBudgetUsdPerTask,
    maxConcurrentCrew: cfg.maxConcurrentCrew,
    maxRework: cfg.maxRework,
  };
}
