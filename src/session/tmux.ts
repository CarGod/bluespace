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
 * Three decisions in here are load-bearing, and all three were settled
 * empirically against tmux 3.7b rather than from the manual:
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
 *  3. A TMUX COMMAND HAS A CEILING, AND IT IS SMALL — 16,364 bytes of packed
 *     argv, for every subcommand alike. See `TMUX_MAX_COMMAND_BYTES` for the
 *     measurement and its derivation. It is small enough that real BlueSpace
 *     inputs cross it routinely (a Sentinel prompt is a brief plus a whole
 *     diff), and it is the reason two things here look the way they do: `launch`
 *     refuses oversized argv itself rather than letting tmux answer `command too
 *     long`, and `sendText` splits long text across several commands instead of
 *     assuming one will carry it. Callers keep large payloads off the line
 *     entirely by passing file paths — but a backend that only works when its
 *     callers are careful is a backend with a trap in it.
 *
 *  4. THE FLEET GETS ITS OWN TMUX SERVER, and this is the newest of the four.
 *     tmux with no `-L` talks to the socket named `default`, which is shared
 *     with the captain's own sessions, with anything else on the box that speaks
 *     tmux, and — the reason this decision exists — with any `tmux kill-server`
 *     typed anywhere on the machine. That command is not scoped to a session: it
 *     stops the server and every session on it. Two Crews died to it mid-turn,
 *     reported as `crew.exited ok=false reason="session ended before the Stop
 *     hook fired"`, a sentence that describes a fleet that was killed from
 *     outside exactly as well as it describes one that crashed on its own.
 *
 *     So every invocation goes through `#run`, which prepends `-L <socket>`. ONE
 *     PLACE, deliberately: a socket flag present in nine calls and missing from
 *     the tenth is worse than no socket at all, because the tenth call addresses
 *     a different server — `alive()` reports a live worker dead, `kill()` reaps
 *     nothing, `list()` finds no orphans, and each of those failures looks like
 *     a different bug. A test asserts the prefix on every argv the backend
 *     emits rather than trusting the reading of this file.
 *
 *     The isolation runs both ways, which is half the point: BlueSpace's own
 *     teardown now cannot reach the captain's sessions either.
 *
 *     MEASURED 2026-08-07, because (3) makes it a fair question: `-L` costs
 *     nothing against the command ceiling. It is a client-side flag — the client
 *     uses it to find a socket and does not pack it into the message it sends —
 *     and the 16,364/16,365 wall lands in exactly the same place with it, without
 *     it, and with a 60-character socket name. `#assertFits` therefore measures
 *     the subcommand only, as it always did.
 *
 *     `attachCommand` carries the flag too. Without it the captain's paste goes
 *     to the shared server, finds no such session, and tells them their worker is
 *     gone when it is running three feet away.
 *
 *     UPGRADE HAZARD: workers launched by a build without this are on the shared
 *     socket, and nothing here can see or address them — `list()` will not find
 *     them, so the orchestrator's orphan reap will not either, and they keep
 *     spending the captain's quota. `strandedOnSharedSocket()` is how that gets
 *     noticed instead of guessed at.
 *
 * A fifth, smaller one: a detached tmux session is 80x24, which is too narrow
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
  type EndpointStatus,
  type LaunchRequest,
  type SessionBackend,
  type SessionEndpoint,
  type SessionKey,
} from './types.js';

const execFileAsync = promisify(execFile);

/** Shown verbatim to the captain when dispatch finds no tmux. */
export const TMUX_INSTALL_HINT = 'tmux is not installed or not on PATH — `brew install tmux`';

const DEFAULT_SESSION = 'blue';

/**
 * The socket the fleet lives on — `tmux -L <this>`. See decision (4).
 *
 * Named for the product rather than for the default session (`blue`) so that a
 * captain who already runs `tmux -L blue` for their own reasons does not end up
 * sharing a server with the fleet by coincidence — which is the exact hazard
 * this constant exists to remove.
 */
export const DEFAULT_TMUX_SOCKET = 'bluespace';

/**
 * Where tmux goes when nobody says otherwise, and therefore where every worker
 * launched before this change still is.
 *
 * Only `strandedOnSharedSocket()` may name it. Everything else in this file is
 * on `this.socket` by construction.
 */
export const SHARED_TMUX_SOCKET = 'default';

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
// The command-length ceiling — measured, not guessed
// ---------------------------------------------------------------------------

/**
 * The largest command tmux will accept, in BYTES of packed argv.
 *
 * MEASURED 2026-08-07 against tmux 3.7b (darwin/arm64, Darwin 25.5.0) by binary
 * search, and measured again with the fixed part of the command padded to 1,
 * 1000, 4000 and 8000 bytes. All four runs put the wall at the same place:
 *
 *     total argv bytes 16,364 -> delivered
 *     total argv bytes 16,365 -> refused
 *
 * That it does not move when the padding does is the whole point of the second
 * measurement: THE CEILING IS ON THE WHOLE COMMAND, not on any one argument. It
 * is also not a coincidental number — tmux packs argv into one libevent imsg,
 * whose maximum is 16 KiB (16,384) less a 16-byte imsg header and the 4-byte
 * `argc` of tmux's own message struct, leaving exactly 16,364 for the arguments.
 * The same wall applies to `new-session`, `new-window` and `send-keys` alike;
 * all three were measured and all three land on 16,364.
 *
 * WHAT THIS IS NOT is the kernel's `ARG_MAX`, which is 1,048,576 on this machine
 * and was never in play — the launch that lost a task carried a 112,680-byte
 * prompt, a tenth of ARG_MAX and seven times this. An earlier diagnosis blamed
 * `ARG_MAX` and sent the fix in the wrong direction; the number above is the one
 * that actually decides, and it belongs to tmux.
 *
 * Counted as tmux counts it — `cmd_pack_argv` writes each argument NUL
 * terminated — so one byte per element is added for the terminator, and the
 * unit is UTF-8 bytes rather than characters. Verified: 5,440 three-byte CJK
 * characters (16,320 bytes) fit and 5,441 do not, so a Chinese brief reaches
 * this wall at a third of the character count an English one does.
 *
 * Re-measure after a tmux upgrade. `tests/session-tmux.test.ts` asserts the wall
 * is still where this says it is, so a moved ceiling fails a test rather than a
 * fleet.
 */
export const TMUX_MAX_COMMAND_BYTES = 16_364;

/**
 * How much of the ceiling is held back.
 *
 * Not superstition, and not tuned to a failure: the constant above is one build
 * on one platform, and while its derivation (imsg 16 KiB, less two headers) is
 * stable in a way a magic number would not be, the header sizes are tmux's
 * business and not ours. Refusing 1 KiB early costs nothing a real prompt will
 * ever notice — everything unbounded now travels as a file path — and buys the
 * difference between a diagnosis and a lost task if a future tmux spends a few
 * more bytes on its own framing.
 */
const TMUX_COMMAND_MARGIN_BYTES = 1_024;

/** What callers may actually spend. See the two constants above. */
export const TMUX_COMMAND_BUDGET_BYTES = TMUX_MAX_COMMAND_BYTES - TMUX_COMMAND_MARGIN_BYTES;

/**
 * Size a tmux command the way tmux sizes it: every argument, NUL terminated.
 *
 * Exported because callers have to be able to ask "will this fit" BEFORE they
 * build a worktree and tell a captain that work has started.
 */
export function tmuxCommandBytes(args: readonly string[]): number {
  let total = 0;
  for (const arg of args) total += Buffer.byteLength(arg, 'utf8') + 1;
  return total;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * A command too big to hand tmux, refused BEFORE tmux is asked.
 *
 * The value of catching it here is entirely in what the message says. tmux's own
 * answer is `command too long`, which names neither the command nor the size nor
 * the offending argument — a captain reading it learns that something, somewhere,
 * was too big. This one reports the total, the ceiling, and which element is
 * carrying the weight, so the next question is "why is argv[13] 112 KB" rather
 * than "what is tmux".
 *
 * It reports POSITION AND SIZE, never content. The big element is routinely a
 * brief or a diff, and an error string is the wrong place for either.
 */
export class TmuxCommandTooLongError extends Error {
  constructor(
    readonly subcommand: string,
    readonly totalBytes: number,
    readonly limitBytes: number,
    readonly largest: { index: number; bytes: number },
  ) {
    super(
      `tmux ${subcommand} would be ${totalBytes.toLocaleString('en-US')} bytes, past the ` +
        `${limitBytes.toLocaleString('en-US')}-byte budget this backend keeps under tmux's own ` +
        `${TMUX_MAX_COMMAND_BYTES.toLocaleString('en-US')}-byte command ceiling (measured; see ` +
        `TMUX_MAX_COMMAND_BYTES). The largest argument is argv[${largest.index}] at ` +
        `${largest.bytes.toLocaleString('en-US')} bytes — that is the one to move off the command ` +
        `line and pass as a file path. This is tmux's limit, not the kernel's: ARG_MAX is 1 MiB ` +
        `and is not what refused this.`,
    );
    this.name = 'TmuxCommandTooLongError';
  }
}

/** Index and size of the biggest element, for a diagnosis that points somewhere. */
function largestArg(args: readonly string[]): { index: number; bytes: number } {
  let index = 0;
  let bytes = -1;
  for (const [i, arg] of args.entries()) {
    const size = Buffer.byteLength(arg, 'utf8');
    if (size > bytes) {
      index = i;
      bytes = size;
    }
  }
  return { index, bytes: Math.max(bytes, 0) };
}

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

/**
 * What `strandedOnSharedSocket()` found: a fleet from before this change, alive
 * on the shared socket and unreachable from here.
 */
export interface StrandedFleet {
  /** Always `SHARED_TMUX_SOCKET`; carried so a caller can print it. */
  readonly socket: string;
  readonly session: string;
  /** Window names, i.e. one entry per worker still running over there. */
  readonly windows: readonly string[];
  /** What the captain types to go look at them. */
  readonly attachCommand: string;
  /**
   * What the captain types to stop them, once they have looked and confirmed
   * the session is BlueSpace's. Offered as a string and never run: on the shared
   * socket a session named `blue` is not provably ours, and the whole reason
   * this file moved off that socket is that killing other people's tmux is a
   * thing that actually happened.
   */
  readonly killCommand: string;
}

export interface TmuxBackendOptions {
  /** tmux session that holds every worker. Default `blue`. */
  session?: string;
  /**
   * tmux socket the fleet's server listens on — `tmux -L <name>`. Default
   * `bluespace`. See decision (4): this is what an outside `kill-server` cannot
   * reach, and what this backend's own teardown cannot reach past.
   */
  socket?: string;
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
  /** See `SessionBackend.maxCommandBytes` and `TMUX_MAX_COMMAND_BYTES`. */
  readonly maxCommandBytes = TMUX_COMMAND_BUDGET_BYTES;
  readonly session: string;
  /** The socket every command below is scoped to. See decision (4). */
  readonly socket: string;
  readonly cols: number;
  readonly rows: number;
  readonly tmuxPath: string;

  /**
   * The RAW runner: it has no socket on it. Nothing outside `#run` and
   * `strandedOnSharedSocket` may touch it, because an unprefixed tmux command
   * addresses the shared server.
   */
  readonly #exec: TmuxRunner;
  /** `['-L', socket]`, built once. Prepended by `#run` to every command. */
  readonly #socketArgs: readonly string[];

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
    const socket = opts.socket ?? DEFAULT_TMUX_SOCKET;
    // A socket name is a FILENAME: tmux appends it to `<tmpdir>/tmux-<uid>/`, so
    // a `/` in it relocates the server and a `..` walks out of the directory.
    // Held to the same charset as a session name, and for the stronger reason —
    // this one decides which server the whole fleet lands on.
    if (!/^[A-Za-z0-9_-]+$/.test(socket)) {
      throw new Error(
        `invalid tmux socket name ${JSON.stringify(socket)}: ` +
          `must be one or more of [A-Za-z0-9_-] (it becomes a filename under tmux's socket dir)`,
      );
    }
    this.session = session;
    this.socket = socket;
    this.cols = opts.cols ?? DEFAULT_COLS;
    this.rows = opts.rows ?? DEFAULT_ROWS;
    this.tmuxPath = opts.tmuxPath ?? 'tmux';
    this.#exec = opts.runner ?? createTmuxRunner(this.tmuxPath);
    this.#socketArgs = ['-L', this.socket];
  }

  /**
   * `tmux -V`. Absence is an answer, not an exception.
   *
   * Carries the socket like everything else even though `-V` never connects to a
   * server: the rule is "every command that leaves this class is prefixed", and a
   * rule with one documented exemption is a rule with one undocumented one next
   * year. Verified it neither fails nor creates a socket file.
   */
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
      // Refused here rather than by tmux, and BEFORE anything is created: the
      // caller has already cut a worktree by this point, so the difference
      // between `command too long` and a message naming the oversized argument
      // is the difference between a captain who can act and one who cannot.
      // The check covers the WHOLE command, which is the only thing that can
      // check it — the caller knows its own argv but not tmux's prefix.
      this.#assertFits(args);

      const created = (await this.#must(args)).stdout.trim();

      // tmux is the authority on the name it assigned; if it is not the one we
      // sanitised, every target we hand out would address something else.
      if (created !== window) {
        throw new TmuxError(args, 0, `tmux named the new window ${JSON.stringify(created)}`);
      }

      return {
        target: `${this.session}:${window}`,
        // `-L` FIRST, and it is not optional: the fleet's server is not the one
        // a bare `tmux attach` finds, so the same paste without it reports "no
        // sessions" or drops the captain into their own work, and either way
        // tells them a running worker is gone. It is a client flag, so it has to
        // precede the subcommand.
        //
        // The `=` is the exact-match prefix, and it is deliberately in the
        // command the human runs too: attaching to a stale name must fail loudly
        // instead of dropping them into a colleague's session. Verified on tmux
        // 3.7b that this form both attaches AND selects that window; plain
        // `attach -t <session>` leaves whatever window was current.
        // No quoting is needed on the socket, session or window because all
        // three are `[A-Za-z0-9_-]+` by construction; only the path can hold a
        // space.
        attachCommand:
          `${shellQuote(this.tmuxPath)} -L ${this.socket} ` +
          `attach -t ${this.session}:=${window}`,
      };
    });
  }

  /**
   * Type without submitting. `-l` = literal: never interpreted as key names.
   *
   * CHUNKED, because `send-keys` is a tmux command and pays the same
   * 16,364-byte ceiling every other tmux command does — measured, same wall, and
   * the reason a rework message quoting a long verdict used to die here with the
   * same useless `command too long`. Splitting is safe and is the whole fix:
   * verified 2026-08-07 that 100,000 bytes of mixed ASCII and CJK sent as nine
   * `send-keys -l` calls arrive at a raw-mode reader as the exact concatenation,
   * in 309ms. Nothing is submitted in between — submission is `sendKey`, always
   * a separate call — so the composer simply accumulates.
   *
   * SPLIT ON CODE POINTS, NEVER ON BYTES. `for...of` iterates code points, so a
   * multi-byte character cannot be cut in half; half a UTF-8 sequence would
   * reach the pane as a replacement character, silently corrupting exactly the
   * briefs least likely to be read by whoever debugs it.
   */
  async sendText(target: string, text: string): Promise<void> {
    if (text === '') return;
    const prefix = ['send-keys', '-t', this.#exact(target), '-l', '--'];
    // What is left for the text once the command's own words are paid for.
    const budget = this.maxCommandBytes - tmuxCommandBytes(prefix) - 1;
    // A target so long that nothing fits is a caller bug, not a chunking problem.
    if (budget <= 0) this.#assertFits([...prefix, text]);

    // Sequential and in order: two concurrent send-keys would interleave.
    for (const piece of chunkByBytes(text, budget)) {
      await this.#must([...prefix, piece]);
    }
  }

  async sendKey(target: string, key: SessionKey): Promise<void> {
    await this.#must(['send-keys', '-t', this.#exact(target), tmuxKeyName(key)]);
  }

  /**
   * Process liveness, and nothing else. Every flavour of "gone" answers false
   * rather than throwing: the window may have been closed when its process
   * exited, or (under `remain-on-exit`) still exist holding a dead pane, or the
   * whole server may have been stopped out from under it.
   *
   * A boolean is all the `SessionBackend` contract promises, and all most
   * callers want. `describeEndpoint()` is the same observation with the reason
   * kept — see it for why a caller reporting a death to a human should prefer it.
   */
  async alive(target: string): Promise<boolean> {
    return (await this.describeEndpoint(target)).state === 'running';
  }

  /**
   * Liveness WITH the reason, for the caller that has to tell a human what
   * happened.
   *
   * The failure this exists for: a worker killed from outside was reported as
   * `session ended before the Stop hook fired`, which is true of a worker that
   * segfaulted, a worker whose window someone closed, and a fleet that a passing
   * `tmux kill-server` took down together — three different next actions behind
   * one sentence. `alive()` cannot say which because it only has a boolean;
   * everything needed to tell them apart is already in the exit status and the
   * scope of the tmux command that failed, and was simply being thrown away.
   *
   * Four distinguishable ends, from narrowest to widest:
   *
   *   - `exited`       the pane is still there and its process is not. The worker
   *                    ran and stopped; look at the transcript.
   *   - `window-gone`  the session is fine, this one window is not. Something
   *                    closed this worker specifically — `kill()`, a captain
   *                    typing `exit` while attached.
   *   - `session-gone` the fleet's server is up and the session is not. Every
   *                    worker went at once, and something aimed at the session.
   *   - `server-gone`  the fleet's server itself is not running. This is what
   *                    `kill-server` looks like from in here — but so does a
   *                    fleet whose LAST window was killed, because tmux exits an
   *                    empty server. The reason text says both; claiming the
   *                    dramatic one would be guessing.
   *
   * Plus `running`, and `unavailable` for "tmux did not answer at all", which is
   * the one case that is not evidence of anything about the worker.
   *
   * COSTS NOTHING IN THE COMMON CASE. A live worker is one `list-panes`, exactly
   * what `alive()` always ran; the extra calls happen only once the answer is
   * already bad news.
   */
  async describeEndpoint(target: string): Promise<EndpointStatus> {
    const panes = await this.#run(['list-panes', '-t', this.#exact(target), '-F', '#{pane_dead}']);
    if (panes.exitCode === 0) {
      // `#{pane_dead}` is 1 for a pane kept by `remain-on-exit`. Any live pane
      // makes the endpoint live.
      const dead = panes.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '');
      if (dead.some((flag) => flag === '0')) {
        return { state: 'running', reason: `the process in ${target} is running` };
      }
      return {
        state: 'exited',
        reason:
          `the process in ${target} exited; tmux is holding the pane open ` +
          `(remain-on-exit), so the window is still listed`,
      };
    }
    // exitCode null means tmux never ran — not installed, not executable, killed
    // by a signal. That says nothing about the worker, so it must not be reported
    // as one of the deaths below.
    if (panes.exitCode === null) return this.#unavailable();

    // The window is not addressable. Widen the question to find out how much else
    // went with it, because "this worker died" and "the whole server died" are
    // the same failure from the window's point of view.
    const sessions = await this.#run(['list-sessions', '-F', '#{session_name}']);
    if (sessions.exitCode === null) return this.#unavailable();
    if (sessions.exitCode !== 0) {
      return {
        state: 'server-gone',
        reason:
          `the fleet's tmux server (socket ${this.socket}) is not running, so every worker on ` +
          `it is gone — either something stopped the server (\`${this.tmuxPath} -L ` +
          `${this.socket} kill-server\`), or its last window was closed and tmux exited an ` +
          `empty server`,
      };
    }
    const wanted = targetSession(target);
    const live = sessions.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (!live.includes(wanted)) {
      return {
        state: 'session-gone',
        reason:
          `tmux session ${wanted} is gone from the fleet's server (socket ${this.socket}), ` +
          `taking every worker in it — the server itself is still up`,
      };
    }
    return {
      state: 'window-gone',
      reason:
        `the tmux window for ${target} is gone while session ${wanted} on socket ` +
        `${this.socket} is still up, so this worker was closed on its own rather than with ` +
        `the rest of the fleet`,
    };
  }

  #unavailable(): EndpointStatus {
    return {
      state: 'unavailable',
      reason: `tmux did not answer, so nothing is known about this worker — ${TMUX_INSTALL_HINT}`,
    };
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

  /**
   * The upgrade hazard, made visible: workers this backend can no longer see.
   *
   * THE ONLY PLACE IN THIS FILE THAT LOOKS AT THE SHARED SOCKET, and it looks
   * without `-L` precisely because that is where a pre-socket build put them.
   *
   * Why it has to exist. Moving the fleet to its own server does not move the
   * fleet that is already flying. Workers launched by an older build stay on the
   * shared socket, still attached to Claude Code sessions, still spending the
   * captain's quota — and from here they are simply absent: `list()` returns
   * nothing, so the orchestrator's orphan reap finds nothing to reap, and
   * `alive()` on their stored targets says dead, so their tasks fail while the
   * processes behind them keep running. Silence is the worst of the available
   * answers, and it is what shipping this without a probe would produce.
   *
   * What it deliberately does NOT do is kill them. A session named `blue` on the
   * shared socket is not provably BlueSpace's — that socket is shared with the
   * captain and with everything else on the box, which is the entire reason this
   * file left it. So this reports, hands over the two commands, and stops. The
   * failure being fixed here is software that killed tmux sessions it did not
   * own; repeating it in the migration path would be a poor joke.
   *
   * Returns undefined when there is nothing over there — no server, no session,
   * or no windows — which is the normal case on every run after the first.
   */
  async strandedOnSharedSocket(): Promise<StrandedFleet | undefined> {
    if (this.socket === SHARED_TMUX_SOCKET) return undefined; // nothing to strand
    // #exec, not #run: the whole question is about the OTHER server.
    const res = await this.#exec(['list-windows', '-t', `=${this.session}`, '-F', '#{window_name}']);
    if (res.exitCode !== 0) return undefined;
    const windows = res.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (windows.length === 0) return undefined;
    const tmux = shellQuote(this.tmuxPath);
    return {
      socket: SHARED_TMUX_SOCKET,
      session: this.session,
      windows,
      attachCommand: `${tmux} attach -t ${this.session}:`,
      killCommand: `${tmux} kill-session -t =${this.session}`,
    };
  }

  // -- internals ------------------------------------------------------------

  /**
   * Every tmux command this backend runs, and the one place the socket is
   * attached. See decision (4): the value of a single choke point is that
   * "did we remember the flag" stops being a question you answer by reading.
   */
  async #run(args: readonly string[]): Promise<TmuxResult> {
    return this.#exec([...this.#socketArgs, ...args]);
  }

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



  /**
   * Refuse a command tmux would refuse, with a message tmux would not write.
   *
   * Measures the SUBCOMMAND, without the `-L <socket>` prefix, and that is
   * correct rather than an oversight: measured 2026-08-07 that the wall sits at
   * the same 16,364/16,365 bytes with the flag, without it, and with a
   * 60-character socket name. `-L` is consumed by the tmux client to find a
   * socket and never reaches the message the server is sent.
   */
  #assertFits(args: readonly string[]): void {
    const total = tmuxCommandBytes(args);
    if (total <= this.maxCommandBytes) return;
    throw new TmuxCommandTooLongError(
      args[0] ?? 'command',
      total,
      this.maxCommandBytes,
      largestArg(args),
    );
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

/**
 * Split text into pieces of at most `maxBytes` UTF-8 bytes each, cutting only
 * between code points.
 *
 * Exported for the test that proves a chunked message is the same message: this
 * is the one place a lost or mangled byte would be invisible until a Crew acted
 * on half an instruction.
 */
export function chunkByBytes(text: string, maxBytes: number): string[] {
  if (maxBytes <= 0) throw new Error(`chunkByBytes needs a positive budget, got ${maxBytes}`);
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text === '' ? [] : [text];

  const out: string[] = [];
  let piece = '';
  let bytes = 0;
  // `for...of` yields code points, so a surrogate pair or a 3-byte CJK character
  // is never cut in half. `.length` and index access would both do exactly that.
  for (const ch of text) {
    const width = Buffer.byteLength(ch, 'utf8');
    if (bytes + width > maxBytes) {
      out.push(piece);
      piece = '';
      bytes = 0;
    }
    piece += ch;
    bytes += width;
  }
  if (piece !== '') out.push(piece);
  return out;
}

/**
 * The session half of a target, `=` prefix removed.
 *
 * `describeEndpoint` needs it rather than using `this.session`, because a target
 * is a handle a caller kept — possibly from a differently configured backend —
 * and a diagnosis that names the wrong session is worse than none.
 */
function targetSession(target: string): string {
  const sep = target.indexOf(':');
  const name = sep === -1 ? target : target.slice(0, sep);
  return name.startsWith('=') ? name.slice(1) : name;
}

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
