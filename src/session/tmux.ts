/**
 * tmux session backend — the reference implementation of `SessionBackend`.
 *
 * One tmux session (`blue` by default) holds every worker, one window each. A
 * window is the unit because it is the cheapest thing tmux will let a human
 * attach *directly to*: `attachCommand` has to land the captain inside one
 * specific Crew, not inside a session where they then have to go hunting.
 *
 * THE ONE RULE (see types.ts) is enforced here by omission: this file contains
 * no pane-capture call and must never grow one — a test asserts that. Every
 * tmux invocation below either starts something, addresses something, types
 * into something, or asks about *process* state (`pane_dead`, `pane_id`,
 * `window_name`). None of it reads a character the worker rendered.
 *
 * Two decisions in here are load-bearing, and both were settled empirically
 * against tmux 3.7b rather than from the manual:
 *
 *  1. NAMES ARE TARGETS, so a bad name silently addresses the wrong worker.
 *     tmux target syntax is `<session>:<window>`, which means a window name
 *     containing `:` or `.` re-parses into a different address. Worse, three
 *     quieter traps: a window named `1` is unreachable, because tmux resolves a
 *     numeric component as a window *index* first (verified: with windows
 *     [0:alpha, 1:beta, 2:"1"], `sess:1` returns beta); a name that is a prefix
 *     of another name matches it by fallback (verified: with only `abcdef`
 *     present, `sess:abc` returns abcdef); and both failures are silent — you
 *     get somebody else's pane, not an error. So names are sanitised to
 *     `[A-Za-z0-9_-]`, never left all-digits, and made unique against `list()`;
 *     and every internal address goes through `#exact()`, which inserts tmux's
 *     `=` exact-match prefix so a vanished window reads as *gone* rather than
 *     as its neighbour.
 *
 *  2. ARGV, NEVER A SHELL. A brief is captain-supplied text and routinely
 *     contains backticks, `$(...)`, quotes and newlines. Everything here is an
 *     execFile argv array, and `send-keys` uses `-l -- <text>`: `-l` stops tmux
 *     interpreting the text as key *names*, and `--` stops tmux's own getopt
 *     eating text that begins with `-` (verified: without it, sending the string
 *     `-l -t evil` fails with "invalid flag"). The text reaches the pane's tty
 *     byte-for-byte and is never parsed by anything.
 *
 * A third, smaller one: a detached tmux session is 80x24, which is too narrow
 * for the Claude Code TUI and produces workers that render into a corner. New
 * sessions are created at 200x50 (`-x/-y`); later windows inherit the session
 * size, so it is set once.
 *
 * Requires tmux 3.0+ for `new-session -e` / `new-window -e` (environment).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  SessionBackendUnavailableError,
  type LaunchRequest,
  type SessionBackend,
  type SessionEndpoint,
  type SessionKey,
} from './types.js';

const execFileAsync = promisify(execFile);

/** Shown verbatim to the captain when dispatch finds no tmux. */
export const TMUX_INSTALL_HINT = 'tmux is not installed or not on PATH — `brew install tmux`';

const DEFAULT_SESSION = 'blue';

/** 80x24 cramps the Claude Code TUI; this is a comfortable working size. */
const DEFAULT_COLS = 200;
const DEFAULT_ROWS = 50;

/**
 * Window names end up inside a command a human copy-pastes, so they are kept
 * short rather than allowed to inherit a whole task title.
 */
const MAX_WINDOW_NAME = 32;

/** Used when sanitisation eats the entire name (a title of pure punctuation). */
const FALLBACK_WINDOW_NAME = 'w';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A tmux command exited non-zero. Carries argv and stderr for diagnosis. */
export class TmuxError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(
      `tmux ${args.join(' ')} failed (exit ${exitCode ?? 'null'})` +
        (stderr.trim() ? `: ${stderr.trim()}` : ''),
    );
    this.name = 'TmuxError';
  }
}

// ---------------------------------------------------------------------------
// The one seam
// ---------------------------------------------------------------------------

export interface TmuxResult {
  readonly stdout: string;
  readonly stderr: string;
  /**
   * tmux's exit status, or `null` when tmux never ran at all (not installed,
   * not executable, killed by a signal). All three collapse to one case on
   * purpose: tmux did not answer, so nothing this backend claims is true.
   */
  readonly exitCode: number | null;
}

/**
 * How this backend actually invokes tmux. Injectable for ONE reason: a test
 * needs to assert on the argv array itself — that a hostile brief travels as a
 * single element and never as a shell string — while still driving real tmux.
 * A test wraps the real runner and records; it does not replace it.
 */
export type TmuxRunner = (args: readonly string[]) => Promise<TmuxResult>;

/** tmux output is tiny (names, ids, flags), but a huge window list should not EPIPE. */
const TMUX_MAX_BUFFER = 8 * 1024 * 1024;

export function createTmuxRunner(tmuxPath: string): TmuxRunner {
  return async (args) => {
    try {
      const { stdout, stderr } = await execFileAsync(tmuxPath, [...args], {
        maxBuffer: TMUX_MAX_BUFFER,
        windowsHide: true,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (e: unknown) {
      return {
        stdout: readField(e, 'stdout'),
        stderr: readField(e, 'stderr') || (e instanceof Error ? e.message : String(e)),
        // execFile reports a spawn failure (ENOENT) with a string `code`; only a
        // number is a real tmux exit status.
        exitCode: numericCode(e),
      };
    }
  };
}

function readField(e: unknown, key: 'stdout' | 'stderr'): string {
  if (typeof e !== 'object' || e === null || !(key in e)) return '';
  const value: unknown = Reflect.get(e, key);
  return typeof value === 'string' ? value : '';
}

function numericCode(e: unknown): number | null {
  if (typeof e !== 'object' || e === null || !('code' in e)) return null;
  const value: unknown = Reflect.get(e, 'code');
  return typeof value === 'number' ? value : null;
}

// ---------------------------------------------------------------------------
// Window-name sanitisation
// ---------------------------------------------------------------------------

/**
 * Turn an arbitrary endpoint name into something safe to put after a `:` in a
 * tmux target. See decision (1) in the file header for why each rule exists —
 * every one of them is a case where tmux would otherwise address a *different*
 * window without complaining.
 *
 * Exported because the rules are the contract, and are tested directly.
 */
export function sanitizeWindowName(raw: string, taken: ReadonlySet<string> = new Set()): string {
  const base = baseWindowName(raw);
  if (!taken.has(base)) return base;

  // Collide by suffix rather than by hashing: `crew-fix-parser-2` still tells a
  // captain which worker they are attaching to.
  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`;
    const stem = trimEdges(base.slice(0, MAX_WINDOW_NAME - suffix.length)) || FALLBACK_WINDOW_NAME;
    const candidate = `${stem}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`cannot find a free tmux window name derived from ${JSON.stringify(raw)}`);
}

function baseWindowName(raw: string): string {
  const cleaned = trimEdges(
    raw
      // One separator per RUN of junk, so `a: b.c` does not become `a---b-c`.
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/[-_]{2,}/g, '-'),
  ).slice(0, MAX_WINDOW_NAME);

  const trimmed = trimEdges(cleaned);
  if (trimmed === '') return FALLBACK_WINDOW_NAME;

  // An all-digit name is unreachable: tmux reads a numeric target component as
  // a window INDEX and returns whatever window happens to sit at it.
  if (/^[0-9]+$/.test(trimmed)) return `${FALLBACK_WINDOW_NAME}${trimmed}`.slice(0, MAX_WINDOW_NAME);

  return trimmed;
}

/** Leading/trailing separators read as noise and a leading `-` looks like a flag. */
function trimEdges(s: string): string {
  return s.replace(/^[-_]+/, '').replace(/[-_]+$/, '');
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export interface TmuxBackendOptions {
  /** tmux session that holds every worker. Default `blue`. */
  session?: string;
  /** Width of new sessions. Default 200 — see the header on why not 80. */
  cols?: number;
  /** Height of new sessions. Default 50. */
  rows?: number;
  /** tmux binary. Also what `attachCommand` tells the captain to run. */
  tmuxPath?: string;
  /** Testing seam; see `TmuxRunner`. */
  runner?: TmuxRunner;
}

export class TmuxBackend implements SessionBackend {
  readonly name = 'tmux';
  readonly session: string;
  readonly cols: number;
  readonly rows: number;
  readonly tmuxPath: string;

  readonly #run: TmuxRunner;

  /**
   * launch() is read-modify-write on the window list (it picks a name that is
   * unique against `list()`), and creating the session is itself a
   * check-then-act. Two Crews dispatched in the same tick would otherwise race
   * into a duplicate name or a duplicate session, so launches are serialised.
   */
  #lock: Promise<void> = Promise.resolve();

  constructor(opts: TmuxBackendOptions = {}) {
    const session = opts.session ?? DEFAULT_SESSION;
    // The session name is the left half of every target, so it is held to the
    // same charset as a window name — but thrown on rather than rewritten,
    // because it comes from config, not from a task title.
    if (!/^[A-Za-z0-9_-]+$/.test(session)) {
      throw new Error(
        `invalid tmux session name ${JSON.stringify(session)}: ` +
          `must be one or more of [A-Za-z0-9_-] (":" and "." are tmux target separators)`,
      );
    }
    this.session = session;
    this.cols = opts.cols ?? DEFAULT_COLS;
    this.rows = opts.rows ?? DEFAULT_ROWS;
    this.tmuxPath = opts.tmuxPath ?? 'tmux';
    this.#run = opts.runner ?? createTmuxRunner(this.tmuxPath);
  }

  /** `tmux -V`. Absence is an answer, not an exception. */
  async available(): Promise<boolean> {
    const res = await this.#run(['-V']);
    return res.exitCode === 0;
  }

  /**
   * Create the session on first use, add a window thereafter. Callers cannot
   * tell which happened, and must not care: the difference is one tmux
   * subcommand and the returned endpoint is identical either way.
   */
  async launch(req: LaunchRequest): Promise<SessionEndpoint> {
    return this.#serialize(async () => {
      // An empty argv would make tmux fall back to its default-command, i.e.
      // hand the captain a bare login shell wearing a Crew's name.
      if (req.argv.length === 0) {
        throw new Error('launch requires a non-empty argv (program plus arguments)');
      }

      const window = sanitizeWindowName(req.name, new Set(await this.#windowNames()));
      const env = envArgs(req.env);

      // `-P -F` makes tmux print the window it just created, which is how this
      // resolves on "the endpoint is addressable" rather than on "tmux exited
      // 0". It has to come from the create command itself: polling afterwards
      // races both ways — a launch is not yet visible for a few ms, and a
      // short-lived program is already gone by the time the poll runs.
      // `--` fences the payload off from tmux's option parsing; the argv array
      // fences it off from any shell.
      const report = ['-P', '-F', '#{window_name}'];
      const args = (await this.#sessionExists())
        ? [
            'new-window',
            '-t',
            `${this.session}:`,
            '-n',
            window,
            '-c',
            req.cwd,
            ...env,
            ...report,
            '--',
            ...req.argv,
          ]
        : [
            'new-session',
            '-d',
            '-s',
            this.session,
            '-n',
            window,
            '-x',
            String(this.cols),
            '-y',
            String(this.rows),
            '-c',
            req.cwd,
            ...env,
            ...report,
            '--',
            ...req.argv,
          ];
      const created = (await this.#must(args)).stdout.trim();

      // tmux is the authority on the name it assigned; if it is not the one we
      // sanitised, every target we hand out would address something else.
      if (created !== window) {
        throw new TmuxError(args, 0, `tmux named the new window ${JSON.stringify(created)}`);
      }

      return {
        target: `${this.session}:${window}`,
        // The `=` is the exact-match prefix, and it is deliberately in the
        // command the human runs too: attaching to a stale name must fail loudly
        // instead of dropping them into a colleague's session. Verified on tmux
        // 3.7b that this form both attaches AND selects that window; plain
        // `attach -t <session>` leaves whatever window was current.
        // No quoting is needed because sanitisation already guaranteed the name
        // holds nothing a shell reacts to.
        attachCommand: `${shellQuote(this.tmuxPath)} attach -t ${this.session}:=${window}`,
      };
    });
  }

  /** Type without submitting. `-l` = literal: never interpreted as key names. */
  async sendText(target: string, text: string): Promise<void> {
    if (text === '') return;
    await this.#must(['send-keys', '-t', this.#exact(target), '-l', '--', text]);
  }

  async sendKey(target: string, key: SessionKey): Promise<void> {
    await this.#must(['send-keys', '-t', this.#exact(target), tmuxKeyName(key)]);
  }

  /**
   * Process liveness, and nothing else. Both flavours of "gone" answer false
   * rather than throwing: the window may have been closed when its process
   * exited, or (under `remain-on-exit`) still exist holding a dead pane.
   */
  async alive(target: string): Promise<boolean> {
    const res = await this.#run(['list-panes', '-t', this.#exact(target), '-F', '#{pane_dead}']);
    if (res.exitCode !== 0) return false; // no such window, no such session, no tmux
    return res.stdout.split('\n').some((line) => line.trim() === '0');
  }

  /**
   * Idempotent by discarding the result: every way `kill-window` can fail here
   * ("can't find window", "can't find session", tmux already gone) describes
   * the state the caller asked for.
   */
  async kill(target: string): Promise<void> {
    await this.#run(['kill-window', '-t', this.#exact(target)]);
  }

  async list(): Promise<string[]> {
    return (await this.#windowNames()).map((n) => `${this.session}:${n}`);
  }

  // -- internals ------------------------------------------------------------

  async #windowNames(): Promise<string[]> {
    const res = await this.#run(['list-windows', '-t', `=${this.session}`, '-F', '#{window_name}']);
    // A missing session owns no endpoints; that is an empty list, not a fault.
    if (res.exitCode !== 0) return [];
    return res.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }

  async #sessionExists(): Promise<boolean> {
    return (await this.#run(['has-session', '-t', `=${this.session}`])).exitCode === 0;
  }

  /**
   * Rewrite `sess:win` to `sess:=win`. Without the `=`, tmux falls back to
   * prefix and fnmatch matching, so addressing a window that has since died can
   * silently hit a *different, live* window whose name starts the same way —
   * i.e. type a brief into the wrong Crew.
   */
  #exact(target: string): string {
    const sep = target.indexOf(':');
    if (sep === -1) return target;
    const window = target.slice(sep + 1);
    if (window.startsWith('=')) return target;
    return `${target.slice(0, sep)}:=${window}`;
  }

  /** Run, or explain why not. Spawn failure is unavailability, not a tmux error. */
  async #must(args: readonly string[]): Promise<TmuxResult> {
    const res = await this.#run(args);
    if (res.exitCode === null) {
      throw new SessionBackendUnavailableError(this.name, TMUX_INSTALL_HINT);
    }
    if (res.exitCode !== 0) throw new TmuxError(args, res.exitCode, res.stderr);
    return res;
  }

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(fn, fn);
    this.#lock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Exhaustive by construction: adding a `SessionKey` breaks this at compile time. */
function tmuxKeyName(key: SessionKey): string {
  switch (key) {
    case 'Enter':
      return 'Enter';
    case 'Escape':
      return 'Escape';
  }
}

function envArgs(env: LaunchRequest['env']): string[] {
  if (!env) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    // tmux splits `-e` on the first `=`, so a key containing one would silently
    // define a different variable than the caller named.
    if (key === '' || key.includes('=') || key.includes('\0')) {
      throw new Error(`invalid environment variable name ${JSON.stringify(key)}`);
    }
    out.push('-e', `${key}=${value}`);
  }
  return out;
}

/**
 * The ONLY place this module thinks about shells, and it never runs one: an
 * `attachCommand` is a string a human pastes into their own terminal, so a
 * tmux path containing spaces has to survive the trip.
 */
function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
