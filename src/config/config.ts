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
  /** Derived from BLUESPACE_HOME / ~/.bluespace. Not settable from the file. */
  dataDir: string;
}

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
export function saveConfig(patch: Partial<BlueConfig>): BlueConfig {
  const merged = mergeConfig(loadConfig(), patch as Record<string, unknown>);
  writeJsonAtomic(configPath(), serialize(merged));
  return merged;
}

/** What actually lands on disk: `dataDir` is derived, so it is not persisted. */
function serialize(cfg: BlueConfig): Record<string, unknown> {
  return {
    permissionMode: cfg.permissionMode,
    ...(cfg.model !== undefined ? { model: cfg.model } : {}),
    ...(cfg.effort !== undefined ? { effort: cfg.effort } : {}),
    maxTokensPerTask: cfg.maxTokensPerTask,
    maxBudgetUsdPerTask: cfg.maxBudgetUsdPerTask,
    maxConcurrentCrew: cfg.maxConcurrentCrew,
    maxRework: cfg.maxRework,
  };
}
