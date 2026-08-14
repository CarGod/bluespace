/**
 * ClaudeCliAdapter — a worker is a real, interactive Claude Code session.
 *
 * This is the module the migration off the Agent SDK turns on. Everything above
 * it still speaks `AdapterEvent` / `Session` / `SpawnRequest`; underneath, a
 * worker is now the captain's own `claude` binary running in a terminal they can
 * attach to and type into, which is the distinction `docs/compliance.md` argues
 * is load-bearing rather than stylistic. Nothing here imports a vendor SDK, and
 * nothing here may start doing so.
 *
 * It owns no mechanism of its own. It stitches three built modules together:
 *
 *   `src/session/`    — start an endpoint, address it, type into it. Never reads
 *                       what it renders (THE ONE RULE, session/types.ts).
 *   `src/transcript/` — the event stream, recovered from the JSONL the CLI
 *                       writes to `~/.claude/projects/**​/<uuid>.jsonl`.
 *   `src/pricing/`    — token counts to LIST-PRICE dollars, injected into the
 *                       reader. Tokens are what the transcript reports and what
 *                       BlueSpace accounts in; the dollars are an equivalence
 *                       unless `metered` below is true.
 *
 * THE LAUNCH PROTOCOL, verified empirically against Claude Code 2.1.222 on
 * 2026-08-04. None of it is a documented API; re-verify after every upgrade and
 * update the table in docs/compliance.md.
 *
 *  1. `--session-id <uuid>` fixes the transcript path BEFORE launch. Without it
 *     the session id is unknowable until the CLI has already written records,
 *     and a reader that starts late misses the beginning of the run.
 *
 *  2. `--setting-sources` IS ALWAYS PASSED, with an empty value when the caller
 *     asked for no scopes. Verified: omitting the flag loads user+project+local,
 *     so "no scopes" and "no flag" are opposites. A project-scoped SessionStart
 *     hook fired with the flag absent and with `--setting-sources project`, and
 *     did NOT fire with `--setting-sources ''` or `--setting-sources user`.
 *     Passing `[]` as "omit the flag" would silently run every Crew with the
 *     captain's personal hooks — see SpawnRequest.settingScopes.
 *
 *  3. THE POSITIONAL PROMPT SUBMITS ITSELF, and the Enter that follows it is a
 *     belt-and-braces no-op. This was measured the other way round first: text
 *     sitting unsent in the composer seven seconds in. That session was blocked
 *     on the workspace-trust prompt (see the last paragraph of this header),
 *     which is what an untrusted directory looks like from outside. Re-measured
 *     in a trusted directory with no keys sent at all, the turn ran and the Stop
 *     hook fired. `sendKey(target, 'Enter')` is still sent, because it costs
 *     nothing on an empty composer and the failure it would otherwise cover is a
 *     worker that waits forever. See docs/compliance.md, "Verified against".
 *
 *  4. EVERY SIGNAL IS STRUCTURED. Readiness is a `SessionStart` hook touching a
 *     marker file; end-of-turn is a `Stop` hook touching another; a dialog the
 *     worker is stuck on is a `Notification` hook writing its JSON payload to a
 *     third; content and cost come from the transcript. All three hooks travel
 *     in a `--settings` file inside this run's own directory, so a run never
 *     touches `~/.claude/settings.json` — a hook installed there would fire for
 *     the captain's own unrelated sessions.
 *
 *     The third one is not defensive programming. Verified on 2.1.222 with
 *     `--permission-mode auto`, in a git repo, editing a tracked file: Claude
 *     Code STILL asked "Do you want to make this edit?" and sat on the dialog.
 *     Three of three runs on another machine did not — which is why `auto` is
 *     the default — but it is a classifier, not a switch, so "usually" is the
 *     most anyone can promise (docs/compliance.md, "Verified against", says the
 *     same and no more). Unattended, a prompt is a worker frozen until the
 *     turn timeout — hours of a task's wall clock spent on a question nobody
 *     will ever be asked. The Notification payload names the case exactly
 *     (`"notification_type":"permission_prompt"`), so the run ends in seconds
 *     with an error that tells the captain what to attach to. What this adapter
 *     will NOT do is answer the dialog: a machine pressing "1. Yes" is
 *     `--dangerously-skip-permissions` by keystroke, which BlueSpace rejected
 *     for far milder reasons.
 *
 *  5. THE SESSION OUTLIVES THE TURN, and that is an upgrade over the SDK path.
 *     `Stop` means the assistant finished talking, not that the process died, so
 *     rework and steering are real conversational turns (`sendText` + `Enter`)
 *     rather than a fresh run replaying context.
 *
 *     `Session.events()` is therefore ONE TURN, and callable again for the next
 *     one — which is what the orchestrator's rework loop does after it steers.
 *     Each turn reads the transcript from where the previous turn stopped
 *     (`startAtByte`), because the CLI appends every turn to the same file and a
 *     reader that started over would bill turn 1 again on turn 2.
 *
 *  6. THE COMMAND LINE IS SMALL, AND NOTHING UNBOUNDED MAY TRAVEL ON IT. A
 *     worker is launched by handing argv to a session backend, and the reference
 *     backend is tmux, which packs the whole command into one 16 KiB message —
 *     16,364 usable bytes, measured (`TMUX_MAX_COMMAND_BYTES`). BlueSpace's own
 *     inputs cross that routinely: a Sentinel's prompt is a brief plus an entire
 *     diff, and one measured at 112,680 bytes. So the appended system prompt and
 *     the run settings ALWAYS travel as file paths, the opening prompt travels
 *     as a path once it stops fitting, and the assembled line is measured before
 *     launch. What that buys is not just a launch that works — it is a refusal
 *     that names which BlueSpace input was too big, instead of tmux's `command
 *     too long`, which names nothing. Note what this is NOT about: the kernel's
 *     `ARG_MAX` is 1 MiB here and was never the constraint.
 *
 *  7. A SUBAGENT'S TOKENS ARE THE CREW'S BILL. Verified on 2.1.222: records for
 *     a delegated agent are NOT in the session transcript — they are written to
 *     `<project-dir>/<session-uuid>/subagents/agent-<id>.jsonl`. A Crew that
 *     delegates would otherwise spend money nothing here can see, and the
 *     orchestrator's per-task ceiling would stop a run at a number that is not
 *     what it cost. Those files are drained at the end of each turn, before the
 *     `exit` event — see `#drainSubagentUsage`.
 *
 * WHAT THIS ADAPTER CANNOT DO, stated rather than papered over:
 *
 *   `conversation: false`. Helm no longer runs here. Hosting caller-supplied
 *   tools requires an in-process MCP server, which is an SDK facility; there is
 *   no interactive-CLI equivalent. `converse()` throws.
 *
 *   `fork: false`. `--resume` and `--fork-session` exist, but `SpawnRequest.
 *   resume` also carries `atMessageId`, which has no interactive equivalent, and
 *   a resumed session's id is not knowable before launch — which would break
 *   invariant (1), the thing everything else here rests on. Nothing needs it:
 *   rework steers the live session instead (decision 5), which is strictly
 *   better than replaying a checkpoint.
 *
 *   `DispatchProfile.maxTurns` AND `maxBudgetUsd` ARE NOT APPLIED. Verified on
 *   2.1.222: there is no `--max-turns` flag at all, and `--max-budget-usd` is
 *   documented "only works with --print". The SDK enforced both and the CLI
 *   cannot, so a ceiling that used to stop a run now stops nothing. Said out
 *   loud here because a budget silently not applied looks exactly like a budget
 *   that was never exceeded. The enforcement that remains is the orchestrator
 *   watching `usage` events and killing the crew, which is a ceiling with a
 *   turn's worth of overshoot rather than none — and `turnTimeoutMs` below.
 *
 *   `structuredOutput: true`, BUT NOT AT THE PROTOCOL LAYER. `--json-schema` is
 *   a `--print` flag, and `--print` is non-interactive — precisely what
 *   docs/compliance.md says BlueSpace must not use. So the worker is given a
 *   file path and told to write its JSON there, and the file is read and
 *   validated on exit, with a bounded retry typed into the live session. THE
 *   CONSTRAINT HAS MOVED FROM THE PROTOCOL LAYER TO THE APPLICATION LAYER, and
 *   that is a real weakening: the model can now write malformed JSON, write
 *   nothing at all, or write something that parses and is not a verdict. It is
 *   caught rather than prevented. The Sentinel already fails closed on a missing
 *   or malformed verdict, which is why this is survivable — not because it is
 *   equivalent.
 *
 * ONE MORE THING THAT WILL BITE. Claude Code shows a workspace-trust prompt the
 * first time it opens a directory, and no hook runs until it is answered — so a
 * fresh worktree would hang forever with nobody there to press Enter. Verified:
 * trust is INHERITED from a trusted ancestor, so trusting the worktree root once
 * covers every worktree created under it. That is what the ready-timeout error
 * below tells the captain, because a timeout with no explanation is how a tool
 * earns the reputation of being haunted.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { priceUsage } from '../pricing/index.js';
import { TmuxBackend } from '../session/tmux.js';
import {
  SessionBackendUnavailableError,
  type SessionBackend,
  type SessionEndpoint,
} from '../session/types.js';
import { createStats, findTranscript, readTranscript, transcriptRoot } from '../transcript/reader.js';
import { trustWorkspace } from './workspace-trust.js';
import type { DispatchProfile } from '../types/domain.js';
import {
  UnsupportedCapabilityError,
  requireCapability,
  type AdapterCapabilities,
  type AdapterEvent,
  type Conversation,
  type ConversationRequest,
  type HarnessAdapter,
  type Session,
  type SettingScope,
  type SpawnRequest,
} from './types.js';

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** See the file header for why each `false` is false. */
const CLAUDE_CLI_CAPABILITIES: AdapterCapabilities = {
  /** Escape, into a live TUI. */
  interrupt: true,
  /** Deliberately not implemented; see the header. */
  fork: false,
  /** Transcript usage priced by `src/pricing`. */
  cost: true,
  /** The transcript carries tool_use and tool_result records. */
  toolEvents: true,
  /** Application-layer, not protocol-layer. See the header. */
  structuredOutput: true,
  /** sendText + Enter, into a session that is still alive after Stop. */
  steer: true,
  /** Requires hosted tools, which need an SDK. */
  conversation: false,
};

// ---------------------------------------------------------------------------
// Tunables — every one of them bounds a wait on a marker file
// ---------------------------------------------------------------------------

/**
 * How long `SessionStart` gets to touch the ready marker. Generous because a
 * cold CLI start on a large repo is not instant, bounded because the failure it
 * catches (an unanswered trust prompt) never resolves on its own.
 */
const DEFAULT_READY_TIMEOUT_MS = 90_000;

/** Backstop on one turn. A run that never Stops must fail, not hang forever. */
const DEFAULT_TURN_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** How long the transcript gets to appear after the prompt is submitted. */
const DEFAULT_TRANSCRIPT_TIMEOUT_MS = 120_000;

/** Marker polling. Cheap: one `stat` per tick. */
const DEFAULT_POLL_INTERVAL_MS = 100;

/**
 * Liveness polling. Deliberately far coarser than marker polling: `alive()`
 * spawns a tmux process, and this is a backstop for "the worker died", not a
 * latency-sensitive path.
 */
const ALIVE_CHECK_INTERVAL_MS = 2_000;

/**
 * How long to keep reading the transcript after the Stop hook fires.
 *
 * Two independent reasons, both of which are "a dropped usage event is a dropped
 * bill". The hook and the last transcript append are separate writes by the same
 * process in an order we do not control; and the reader's tail loop checks its
 * abort signal BEFORE its next read pass, so aborting the instant Stop lands can
 * leave the final record unread. This window guarantees several more poll passes
 * over whatever the CLI wrote last.
 */
const DEFAULT_SETTLE_MS = 750;

/** Structured-output corrections typed into the live session. One is plenty. */
const DEFAULT_STRUCTURED_RETRIES = 1;

/**
 * How long a permission prompt is given to be answered before the run is
 * declared blocked.
 *
 * Not zero, because a captain who happens to be attached can answer one, and
 * killing a run out from under them would be worse than waiting a minute. Not
 * long, because nobody is attached to the overwhelming majority of workers and
 * every second past that is a task frozen on a question. Any transcript activity
 * inside the window cancels it: the prompt was answered and work resumed.
 */
const DEFAULT_BLOCKED_GRACE_MS = 60_000;

/**
 * The gap between typing a follow-up turn and pressing Enter.
 *
 * A `send-keys -l` of any real size arrives at the TUI as a *paste*, and Claude
 * Code coalesces a paste into `[Pasted text #1]` rather than into characters. An
 * Enter that lands inside that coalescing window is swallowed as one more
 * character of the paste, so the message sits in the composer, unsent, forever —
 * which looks exactly like a worker thinking, because nothing is watching the
 * screen. Measured on 2.1.224 with a 2,178-byte message: Enter with no gap at
 * all did not submit; 150ms, 400ms, 800ms and 1500ms all did.
 *
 * This is the cheap half of the fix and deliberately not the whole of it — a
 * delay long enough on this machine today is not a guarantee, so submission is
 * also *confirmed* below rather than assumed.
 */
export const SUBMIT_SETTLE_MS = 400;

/** How long a submitted turn gets to appear in the transcript before Enter is pressed again. */
const SUBMIT_CONFIRM_MS = 5_000;

/** How many times to press Enter before giving up and saying so. */
const SUBMIT_ATTEMPTS = 4;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The SessionStart hook never fired. Carries the explanation rather than making
 * the captain go and find it: this failure looks identical to a hang, and the
 * likeliest cause is a dialog rather than a bug.
 */
export class SessionNotReadyError extends Error {
  constructor(
    readonly sessionId: string,
    readonly cwd: string,
    readonly waitedMs: number,
  ) {
    super(
      `Claude Code session ${sessionId} never signalled readiness: its SessionStart hook did not ` +
        `run within ${waitedMs}ms, and the worker was killed rather than left to sit.\n\n` +
        `The likeliest cause is the workspace-trust prompt. Claude Code asks "Is this a project ` +
        `you trust?" the first time it opens a directory, no hook runs until it is answered, and ` +
        `a fresh git worktree is always a new directory. BlueSpace records the answer for every ` +
        `worktree it cuts (see workspace-trust.ts); this run got past that, so either the ` +
        `recording failed or something else is holding the window.\n\n` +
        `Answering it by hand for THIS worktree unblocks a retry:\n\n` +
        `    cd ${cwd} && claude    # answer "Yes, I trust this folder", then /exit\n\n` +
        // The old text sent captains to the PARENT directory, which was correct
        // until Claude Code 2.1.232 bounded the inheritance walk at the
        // repository root. A git worktree is its own root, so an ancestor's
        // trust is now never consulted and that advice cost 90 seconds a task.
        `Trusting the directory worktrees live in does NOT cover them: since 2.1.232 the walk ` +
        `stops at the repository root, and a worktree is one.\n\n` +
        `Other candidates: \`claude\` is not on PATH inside the session backend, or the inline ` +
        `--settings JSON was rejected.`,
    );
    this.name = 'SessionNotReadyError';
  }
}

/** Override for a `claude` binary that is not on PATH. */
export const CLI_PATH_ENV = 'CLAUDE_CLI_PATH';

/**
 * The `claude` binary is missing, unreachable, or will not answer.
 *
 * One error class for every way that can happen, because the captain's next move
 * is the same in all of them and the message is the whole value of the type: it
 * has to carry them from "broken" to "fixed" without a second lookup. `detail`
 * names which way it broke; the advice below is constant.
 */
export class ClaudeCliUnavailableError extends Error {
  constructor(readonly detail: string) {
    super(
      `Claude Code is not usable: ${detail}\n\n` +
        'BlueSpace runs its crews as real interactive Claude Code sessions, using the login you\n' +
        'already have — there is no separate key to manage.\n\n' +
        '  1. install:  https://claude.com/claude-code\n' +
        '  2. sign in:  run `claude` once and complete the login\n' +
        '  3. check:    `claude --version` should print a version\n\n' +
        'If `claude` lives somewhere unusual, point BlueSpace at it:\n' +
        `  export ${CLI_PATH_ENV}=/full/path/to/claude`,
    );
    this.name = 'ClaudeCliUnavailableError';
  }
}

/**
 * Nothing named `claude` on PATH at all — the one case a caller may want to
 * distinguish, since it is fixed by installing rather than by signing in.
 * A subclass so `catch (e instanceof ClaudeCliUnavailableError)` still holds.
 */
export class ClaudeCliNotFoundError extends ClaudeCliUnavailableError {
  constructor(readonly attempted: string) {
    super(`\`${attempted}\` was not found on PATH`);
    this.name = 'ClaudeCliNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Authentication — reported, never held
// ---------------------------------------------------------------------------

export type AuthMode =
  /** The captain's own Claude Code login — the default, and what most people have. */
  | { kind: 'cli-login' }
  /** An explicit key in the environment, which the CLI prefers on its own. */
  | { kind: 'api-key'; key: string };

/**
 * Report how a worker will authenticate.
 *
 * BlueSpace never sees a credential: a worker is the captain's own `claude`
 * binary, authenticating as whoever that binary is already signed in as, and an
 * `ANTHROPIC_API_KEY` in the environment is picked up by the CLI itself rather
 * than by anything here. This function exists to *say* which of the two is in
 * play — `docs/compliance.md` turns on the distinction — not to act on it.
 *
 * It only reports and never throws. What can actually fail is the CLI being
 * absent or signed out, and that is `assertClaudeCliAvailable`'s job.
 */
export function resolveAuth(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const key = env['ANTHROPIC_API_KEY']?.trim();
  if (key !== undefined && key !== '') return { kind: 'api-key', key };
  return { kind: 'cli-login' };
}

export interface CliInfo {
  /** Absolute path to the binary that will actually be launched. */
  path: string;
  version: string;
}

/**
 * Prove the CLI exists and answers before anything is dispatched.
 *
 * A worker is only launched once a worktree exists and the captain has been told
 * work started, and the session backend swallows a failed exec into a window
 * that dies — so without this check a missing or signed-out CLI surfaces as a
 * crew that mysteriously never signals readiness. Checking up front turns that
 * into one sentence at startup, which is the entire difference between a tool
 * that feels solid and one that feels haunted.
 */
export function assertClaudeCliAvailable(env: NodeJS.ProcessEnv = process.env): CliInfo {
  // Same resolution the adapter uses, so "the CLI BlueSpace verified" and "the
  // CLI BlueSpace launches" are the same file rather than two that agree today.
  const bin = resolveClaudeBinary(env);
  try {
    const version = execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
      .trim()
      .split('\n')[0];
    // Silence is not success: a binary that runs and says nothing is not one we
    // can claim to have verified.
    if (version === undefined || version === '') {
      throw new ClaudeCliUnavailableError(`\`${bin} --version\` printed nothing`);
    }
    return { path: bin, version };
  } catch (e: unknown) {
    if (e instanceof ClaudeCliUnavailableError) throw e;
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT') throw new ClaudeCliUnavailableError(`\`${bin}\` was not found`);
    if (code === 'ETIMEDOUT') throw new ClaudeCliUnavailableError(`\`${bin} --version\` timed out`);
    // First line only: a signed-out CLI prints a paragraph, and the advice block
    // below it is what the captain needs to read.
    throw new ClaudeCliUnavailableError((e as Error).message.split('\n')[0] ?? 'unknown failure');
  }
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve `claude` to an absolute path IN THIS PROCESS.
 *
 * Not cosmetic: the session backend hands argv to a long-lived tmux server whose
 * environment was captured whenever it started, which may be a different PATH
 * (or a different `claude`) than the one BlueSpace is running under. Resolving
 * here means the binary we verified is the binary that runs.
 */
export function resolveClaudeBinary(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CLI_PATH_ENV]?.trim();
  if (override !== undefined && override !== '') return override;
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .split('\n')[0]
      ?.trim();
    if (found !== undefined && found !== '') return found;
  } catch {
    /* fall through to the error below */
  }
  throw new ClaudeCliNotFoundError('claude');
}

// ---------------------------------------------------------------------------
// The launch argv
// ---------------------------------------------------------------------------

export interface LaunchArgvInput {
  claudePath: string;
  sessionId: string;
  profile: DispatchProfile;
  settingScopes: readonly SettingScope[];
  /**
   * PATH to the appended system prompt, not the text.
   *
   * `--append-system-prompt-file` exists and is what carries it (verified on
   * 2.1.224: the flag parses and validates its argument — it is absent from
   * `--help` but real). The text is unbounded by nature — for a structured run
   * it has a whole JSON Schema in it — and this line has 16,364 bytes for
   * everything. See LAUNCH_LINE_BUDGET.
   */
  systemPromptFile: string;
  /**
   * PATH to this run's settings JSON, not the JSON.
   *
   * `--settings` is documented as taking "a settings JSON file or a JSON
   * string", so a path has always been accepted. Still never a path into
   * `~/.claude`: it is this run's file, in this run's directory.
   */
  settingsFile: string;
  /**
   * Opening message. Lands in the composer UNSENT — see the file header.
   *
   * Kept inline while it fits the line, and replaced by a short pointer at a
   * file when it does not. `spawn` decides which; see `promptPointer`.
   */
  prompt: string;
  /** Extra readable/writable roots, e.g. where a structured verdict is written. */
  addDirs?: readonly string[];
}

/**
 * Build the exact argv a worker is launched with.
 *
 * Exported and pure because this array IS the protocol: a test asserts it
 * element by element, which is the only way a silent reordering or a dropped
 * flag gets caught before a fleet of workers behaves subtly differently.
 *
 * NOTHING UNBOUNDED TRAVELS ON THIS LINE. Every input that can grow with a task
 * — the appended system prompt, the run settings, and (above a budget) the
 * opening prompt — arrives as a path to a file written before launch. That is
 * not tidiness: the line goes to tmux, tmux stops at 16,364 bytes, and a
 * Sentinel prompt is a brief plus an entire diff. See LAUNCH_LINE_BUDGET.
 *
 * Note what has no branch: `--setting-sources` is unconditional. See header (2).
 */
export function buildLaunchArgv(input: LaunchArgvInput): string[] {
  const { profile } = input;
  const argv = [
    input.claudePath,
    '--session-id',
    input.sessionId,
    '--permission-mode',
    profile.permissionMode,
    '--setting-sources',
    input.settingScopes.join(','),
    '--append-system-prompt-file',
    input.systemPromptFile,
  ];

  // Only when the profile states them: an absent `--model` means the captain's
  // configured default, which is a different thing from any value we could pick.
  if (profile.effort !== undefined) argv.push('--effort', profile.effort);
  if (profile.model !== undefined) argv.push('--model', profile.model);
  for (const dir of input.addDirs ?? []) argv.push('--add-dir', dir);

  argv.push('--settings', input.settingsFile);
  // Positional LAST, and last for a reason: everything after a bare positional
  // risks being read as part of it by a future parser.
  if (input.prompt !== '') argv.push(input.prompt);
  return argv;
}

// ---------------------------------------------------------------------------
// The line budget — computed before launch, never discovered afterwards
// ---------------------------------------------------------------------------

/**
 * Ceiling assumed for a backend that declares none.
 *
 * Every backend BlueSpace ships declares one, so this is the value used when a
 * caller supplies their own. tmux's real ceiling is the smallest thing in play
 * by a wide margin, so budgeting to it costs a non-tmux backend nothing and
 * saves a tmux one from a launch it cannot make.
 */
const DEFAULT_LAUNCH_BUDGET_BYTES = 15_340;

/**
 * Room held back for the session backend's own framing.
 *
 * THE ARGV THIS ADAPTER BUILDS IS NOT THE WHOLE COMMAND. A backend wraps it —
 * tmux prepends `new-window -t <session>: -n <window> -c <cwd> -e K=V … -P -F
 * #{window_name} --` — and every byte of that is spent from the same ceiling.
 * An adapter that budgeted only its own argv would pass its check and still be
 * refused, which is the failure it exists to prevent, one layer along.
 *
 * The two parts of the wrapper that can actually grow are priced exactly rather
 * than guessed at, because this adapter supplies both: the working directory and
 * the environment. What is left is the fixed vocabulary — two subcommand
 * spellings, six flags, a session name and a sanitised window name capped at 32
 * characters — and 512 bytes is several times more than that costs.
 */
const BACKEND_FRAMING_BYTES = 512;

/** What tmux-style backends spend on `-e KEY=VALUE` for a launch environment. */
function envFramingBytes(env: Readonly<Record<string, string | undefined>> | undefined): number {
  if (env === undefined) return 0;
  const args: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) args.push('-e', `${key}=${value}`);
  }
  return launchArgvBytes(args);
}

/**
 * WHY THIS BUDGET EXISTS, stated once and referenced from everywhere above.
 *
 * A worker is launched by handing argv to a session backend, and the reference
 * backend is tmux, which packs the whole command into a single 16 KiB message
 * and refuses anything larger with `command too long`. That sentence is the
 * entire failure report: it names no argument, no size, and nothing a captain
 * can act on. A real task died on it — a Sentinel whose prompt was a brief plus
 * a 112,680-byte diff — and then its rework respawn died on it again, after the
 * Crew had already done the work and committed it. 2.4M tokens, nothing verified.
 *
 * So the line is measured BEFORE the launch, against the backend's own declared
 * ceiling, and an oversized input is refused by BlueSpace naming BlueSpace's own
 * input. `TMUX_MAX_COMMAND_BYTES` carries the measurement and the date.
 */
export const LAUNCH_LINE_BUDGET = 'see TMUX_MAX_COMMAND_BYTES in src/session/tmux.ts';

/** Size an argv the way a backend does: every element, plus its NUL terminator. */
export function launchArgvBytes(argv: readonly string[]): number {
  let total = 0;
  for (const arg of argv) total += Buffer.byteLength(arg, 'utf8') + 1;
  return total;
}

/** One named contributor to the line, for an error that points at a cause. */
export interface LaunchPart {
  /** What a captain calls it — "the opening prompt", not "argv[13]". */
  label: string;
  bytes: number;
}

/**
 * The launch line is too long, and here is which of BlueSpace's inputs did it.
 *
 * The whole reason this type exists is the message. tmux says `command too
 * long`; this says which input, how big it is, and how much room there was —
 * the three facts that turn "BlueSpace is broken" into "that diff is enormous".
 * Sizes only, never content: the oversized part is usually a diff or a brief.
 */
export class LaunchTooLargeError extends Error {
  constructor(
    readonly totalBytes: number,
    readonly limitBytes: number,
    readonly parts: readonly LaunchPart[],
  ) {
    const ranked = [...parts].sort((a, b) => b.bytes - a.bytes);
    const worst = ranked[0];
    super(
      `cannot launch this worker: its command line would be ` +
        `${totalBytes.toLocaleString('en-US')} bytes, and the session backend accepts ` +
        `${limitBytes.toLocaleString('en-US')}.\n\n` +
        (worst === undefined
          ? ''
          : `The oversized input is ${worst.label}, at ${worst.bytes.toLocaleString('en-US')} bytes.\n`) +
        `Everything on the line: ${ranked
          .map((p) => `${p.label} ${p.bytes.toLocaleString('en-US')}B`)
          .join(', ')}.\n\n` +
        `This is the session backend's limit on one command, NOT the kernel's ARG_MAX ` +
        `(1 MiB, and not what refused this). BlueSpace already passes the system prompt, the ` +
        `run settings and any large prompt as file paths, so reaching this means something ` +
        `else on the line grew — an unusually long working directory, --add-dir list, or ` +
        `binary path.`,
    );
    this.name = 'LaunchTooLargeError';
  }
}

/**
 * Refuse a launch that will not fit, before a window or a worktree is spent on it.
 *
 * `extraBytes` is what the session backend will add to this argv on its way past
 * — the working directory, the environment, its own subcommand and flags. It is
 * a parameter rather than an assumption because the caller is the only layer
 * that knows both halves: it supplies the cwd and the env, and it knows which
 * backend is going to wrap them.
 *
 * Returns nothing and throws on failure, because there is no useful partial
 * answer: a launch that does not fit is not a launch.
 */
export function assertLaunchFits(
  argv: readonly string[],
  limitBytes: number,
  parts: readonly LaunchPart[],
  extraBytes = 0,
): void {
  const total = launchArgvBytes(argv) + extraBytes;
  if (total <= limitBytes) return;
  throw new LaunchTooLargeError(total, limitBytes, parts);
}

/**
 * The positional that stands in for a prompt too big to put on the line.
 *
 * WHY A POINTER AND NOT THE TEXT. Three routes were available and two do not
 * survive contact with the thing being built:
 *
 *   Typing it in (`sendText` + Enter) is what `send()` does for a follow-up
 *   turn, and it is wrong here. The launch positional SUBMITS ITSELF (header 3),
 *   so a prompt delivered by keystroke has to be submitted by keystroke too —
 *   into a composer whose readiness we are forbidden to observe (THE ONE RULE),
 *   at a moment when the TUI has only just signalled SessionStart. `send()`
 *   already collapses newlines because a stray submit splits one message into
 *   several half-messages; doing that to a brief at launch would start a task on
 *   its first paragraph.
 *
 *   Standard input is not ours. The CLI is launched by the backend into a pty we
 *   reach only through the backend's own typing interface, which is the route
 *   above.
 *
 *   So: the file. And the honest objection to a file is that reading it is an
 *   INSTRUCTION, and a worker can ignore an instruction where it cannot ignore
 *   an argument. Four things answer that, in order of how much they carry:
 *
 *   1. IT IS NOT THE ONLY CHANNEL. The same path is named in the appended system
 *      prompt, which the CLI loads into context itself — no tool call, no
 *      compliance required. A worker that never reads the composer has still
 *      been told where its brief is, by a mechanism it cannot skip.
 *   2. THERE IS NOTHING ELSE TO DO. This text names the path and says the file
 *      is the brief. It deliberately does not summarise the task, because a
 *      summary is exactly what a worker would act on INSTEAD of reading.
 *   3. THE FAILURE IS CONTAINED AND CORRECTLY SIGNED. In practice the only
 *      prompts this large are Sentinel prompts, and the Sentinel fails closed: no
 *      verdict file is `pass: false`, "the diff is unverified". A Crew that
 *      ignored its brief produces a diff the Sentinel rejects. Neither route
 *      launders a skipped instruction into a pass.
 *   4. IT IS ONLY USED WHEN NOTHING ELSE FITS. Under the budget the prompt stays
 *      the positional, exactly as it is today, so the ordinary Crew launch keeps
 *      the measured self-submitting behaviour and gains no dependence on a Read.
 *
 * The run directory is granted with `--add-dir`, so the read cannot fail for
 * permissions, and the file is written before launch, so it cannot race.
 */
export function promptPointer(promptFile: string): string {
  return (
    `Your instructions for this session are too long to pass on the command line, so they ` +
    `are in a file. Read this file now, in full, before doing anything else, and then carry ` +
    `out what it says as if it had been typed here:\n\n    ${promptFile}\n\n` +
    `That file is the entire message. Do not act on this line alone — it contains no task, ` +
    `and guessing at one would waste the run.`
  );
}

/**
 * Told to the worker, in the system prompt, where its brief actually is.
 *
 * The second channel from `promptPointer`'s point (1), and the load-bearing half
 * of it: the appended system prompt travels by file and is loaded by the CLI
 * itself, so this reaches the model whether or not it reads the composer.
 */
function promptFileNotice(promptFile: string): string {
  return [
    '',
    '',
    '## Where your instructions are',
    '',
    'The opening message for this session was too large for the command line and was written',
    'to a file instead. This is the file, and it is the real message:',
    '',
    `    ${promptFile}`,
    '',
    'Read it in full before you act. Nothing else in this session restates it.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Per-run hooks
// ---------------------------------------------------------------------------

interface RunMarkers {
  dir: string;
  ready: string;
  stop: string;
  /** Notification payloads land here, latest wins. See header (4). */
  notify: string;
  /** Where a structured run is told to write its JSON. */
  verdict: string;
  /** This run's hooks, written out rather than passed inline. See header (4). */
  settings: string;
  /** The appended system prompt, passed as `--append-system-prompt-file`. */
  systemPrompt: string;
  /** The opening prompt, written only when it is too big for the line. */
  prompt: string;
}

/**
 * The ONE place in this module that produces shell text.
 *
 * A hook `command` is run by a shell — that is the hook contract, not a choice —
 * so the marker path has to survive quoting. It is safe to do here and nowhere
 * else because these paths are minted by `mkdtemp`, never derived from a brief,
 * a task title, or anything else a captain typed. Everything captain-supplied
 * travels as an argv element and is never parsed by anything.
 */
function shellSingleQuote(value: string): string {
  if (value.includes('\0')) throw new Error('marker path contains a NUL byte');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Inline `--settings` JSON: readiness, end-of-turn, and stuck-on-a-dialog.
 *
 * Scoped to this run on purpose. The same hooks installed in
 * `~/.claude/settings.json` would fire for every Claude Code session on the
 * machine, including the captain's own work.
 *
 * `cat >` rather than `touch` for the notification, because the payload is the
 * useful part: it carries `notification_type`, which is how a permission prompt
 * is told apart from an idle nudge without reading a word of the screen.
 */
export function buildRunSettings(markers: Pick<RunMarkers, 'ready' | 'stop' | 'notify'>): string {
  return JSON.stringify({
    hooks: {
      SessionStart: [
        { hooks: [{ type: 'command', command: `touch ${shellSingleQuote(markers.ready)}` }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: `touch ${shellSingleQuote(markers.stop)}` }] }],
      Notification: [
        { hooks: [{ type: 'command', command: `cat > ${shellSingleQuote(markers.notify)}` }] },
      ],
    },
  });
}

/** The one notification kind that means "nothing will happen until a human acts". */
const PERMISSION_PROMPT = 'permission_prompt';

interface Notification {
  type: string;
  message: string;
}

/**
 * Read and CONSUME the notification marker.
 *
 * Consuming matters: a marker left in place would still be there an hour later,
 * and a long tool call with no transcript output would then look like a stall
 * that had already been resolved. The hook writes a fresh one for every new
 * notification, so deleting what we have looked at loses nothing.
 */
async function takeNotification(file: string): Promise<Notification | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  await fs.rm(file, { force: true }).catch(() => undefined);

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) return undefined;
    const type = typeof parsed['notification_type'] === 'string' ? parsed['notification_type'] : '';
    const message = typeof parsed['message'] === 'string' ? parsed['message'] : '';
    return { type, message };
  } catch {
    // A payload we cannot read is not evidence of anything. Ignoring it risks a
    // hang; acting on it risks killing a healthy run over an idle nudge, and the
    // turn timeout still backstops the first case.
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Structured output, at the application layer
// ---------------------------------------------------------------------------

/**
 * Told to the worker when the caller asked for structured output.
 *
 * Written as an instruction because that is all it can be — see the header. It
 * names the path, the schema, and the one failure mode worth pre-empting:
 * a model that prints the JSON in chat instead of writing the file has produced
 * nothing this adapter can read.
 */
export function structuredOutputInstruction(filePath: string, schema: unknown): string {
  return [
    '',
    '',
    '## Required structured output',
    '',
    `Before you finish, write your final answer to this exact file path as a single JSON value:`,
    '',
    `    ${filePath}`,
    '',
    'It must satisfy this JSON Schema:',
    '',
    '```json',
    JSON.stringify(schema, null, 2),
    '```',
    '',
    'Use the Write tool. Write the JSON and nothing else — no markdown fence, no commentary, no',
    'leading or trailing prose. Printing the JSON in your reply instead of writing the file counts',
    'as not answering at all: the file is the only thing that is read.',
  ].join('\n');
}

/** Bounds `validateAgainstSchema` against a self-referential schema. */
const MAX_SCHEMA_DEPTH = 32;

/**
 * A deliberately small JSON Schema check: object/array/primitive types, plus
 * `required`. It exists to catch the failures the protocol used to prevent —
 * prose instead of JSON, a missing field, a string where a boolean belongs — and
 * to give the retry something concrete to quote back at the worker.
 *
 * It is NOT a conforming validator and does not pretend to be one. Consumers
 * re-validate what they get (the Sentinel parses it with zod), which is the
 * layer that decides whether an object is a verdict.
 *
 * Returns the problems found; empty means "nothing this check can see is wrong".
 */
export function validateAgainstSchema(value: unknown, schema: unknown, depth = 0): string[] {
  if (depth >= MAX_SCHEMA_DEPTH) return [];
  if (!isObject(schema)) return [];

  const problems: string[] = [];
  const expected = schema['type'];
  const where = depth === 0 ? 'the value' : 'a nested value';

  switch (expected) {
    case 'object': {
      if (!isObject(value)) return [`${where} must be a JSON object`];
      const required = Array.isArray(schema['required']) ? schema['required'] : [];
      for (const key of required) {
        if (typeof key === 'string' && !(key in value)) problems.push(`missing property "${key}"`);
      }
      const properties = isObject(schema['properties']) ? schema['properties'] : undefined;
      if (properties !== undefined) {
        for (const [key, sub] of Object.entries(properties)) {
          if (!(key in value)) continue;
          for (const problem of validateAgainstSchema(value[key], sub, depth + 1)) {
            problems.push(`${key}: ${problem}`);
          }
        }
      }
      return problems;
    }
    case 'array': {
      if (!Array.isArray(value)) return [`${where} must be an array`];
      const items = schema['items'];
      if (items === undefined) return problems;
      for (const [index, entry] of value.entries()) {
        for (const problem of validateAgainstSchema(entry, items, depth + 1)) {
          problems.push(`[${index}]: ${problem}`);
        }
      }
      return problems;
    }
    case 'string':
      return typeof value === 'string' ? [] : [`${where} must be a string`];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${where} must be a boolean`];
    case 'number':
      return typeof value === 'number' ? [] : [`${where} must be a number`];
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
        ? []
        : [`${where} must be an integer`];
    default:
      // No `type`, or a construct this check does not model. Silence is correct:
      // an over-permissive check costs one bad retry, an over-strict one rejects
      // a perfectly good verdict.
      return [];
  }
}

/** Typed into the live session when the file is missing or does not validate. */
function correctionMessage(filePath: string, problems: readonly string[]): string {
  return (
    `Your structured output was not accepted: ${problems.join('; ')}. ` +
    `Rewrite ${filePath} so it contains exactly one JSON value matching the schema in your ` +
    `instructions — no fence, no commentary — then stop.`
  );
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Why the turn ended. Exhaustive: adding a case breaks `exitEvent` at compile
 * time rather than producing a run that exits `ok` for a reason nobody handled.
 */
type TurnOutcome =
  | 'stopped'
  | 'interrupted'
  | 'aborted'
  | 'closed'
  | 'timeout'
  | 'died'
  | 'blocked';

interface RunResult {
  outcome: TurnOutcome;
  /** Present when a structured run produced something that validated. */
  structured?: unknown;
  /** Present when a structured run did not. */
  structuredProblems?: string[];
}

interface SessionInit {
  adapter: HarnessAdapter;
  backend: SessionBackend;
  endpoint: SessionEndpoint;
  sessionId: string;
  markers: RunMarkers;
  schema: unknown | undefined;
  transcriptRootPath: string;
  timing: {
    turnTimeoutMs: number;
    transcriptTimeoutMs: number;
    pollIntervalMs: number;
    settleMs: number;
    blockedGraceMs: number;
  };
  structuredRetries: number;
  signal: AbortSignal | undefined;
}

class ClaudeCliSession implements Session {
  readonly id: string;
  /** The backend's own, verbatim: `blue ps` prints this and a human types it. */
  readonly attachCommand: string;

  readonly #init: SessionInit;

  /** True while a turn's stream is being consumed. One consumer at a time. */
  #streaming = false;
  #closed = false;
  #interrupted = false;
  /** A terminal `stop_reason` the reader saw (refusal, max_tokens, …). */
  #terminalReason: string | undefined;
  #transcriptMissing = false;
  /** Last sign of life from the transcript; what tells a stall from slow work. */
  #lastActivityAt = Date.now();
  /** The prompt the run died waiting for somebody to answer. */
  #blockedBy: Notification | undefined;
  /** Found once. The path cannot change: the session id is fixed before launch. */
  #transcriptPath: string | undefined;
  /** How far into the transcript previous turns read. See header (5). */
  #offset = 0;
  /** Per subagent transcript, how far previous drains read. See header (7). */
  readonly #subagentOffsets = new Map<string, number>();

  constructor(init: SessionInit) {
    this.#init = init;
    this.id = init.sessionId;
    this.attachCommand = init.endpoint.attachCommand;

    // The caller's AbortSignal is read by the wait loop rather than listened to:
    // one poll of latency is irrelevant next to a turn, and a listener on a
    // long-lived signal is a leak waiting for someone to forget to remove it.
    //
    // Note what an abort does NOT do — kill the endpoint. Teardown is `close()`'s
    // job, and conflating the two would leave a caller unable to cancel a run and
    // still attach to see what it had done.
  }

  /**
   * ONE TURN's events. Calling it again after the stream ends is the NEXT turn.
   *
   * That is the whole point of decision (5) in the header: `send()` starts a
   * fresh turn in the same live session, and the caller needs a stream to watch
   * it on. What is refused is a SECOND CONCURRENT consumer, which would race two
   * loops over one transcript and bill everything twice.
   */
  events(): AsyncIterable<AdapterEvent> {
    if (this.#streaming) {
      throw new Error(`session "${this.id}" event stream is already being consumed`);
    }
    this.#streaming = true;
    return this.#pump();
  }

  async *#pump(): AsyncGenerator<AdapterEvent, void> {
    // Everything that describes how a turn ENDED is per-turn state. A session
    // outlives its turns, so failing to clear these makes turn 2 inherit turn
    // 1's refusal, its missing transcript, or the dialog it died on.
    this.#terminalReason = undefined;
    this.#transcriptMissing = false;
    this.#blockedBy = undefined;
    this.#lastActivityAt = Date.now();

    try {
      // We minted the id before launch, so the caller learns it now rather than
      // when the CLI happens to write its first record. The reader emits its own
      // `session` event later; it is swallowed below so there is exactly one.
      yield { type: 'session', sessionId: this.id };

      const controller = new AbortController();
      // Started BEFORE the transcript is located: the watcher is what eventually
      // aborts the reader, and a run that dies instantly must still reach an exit.
      const finished = this.#runToCompletion(controller);
      // A throw from the read loop below abandons this generator without ever
      // awaiting `finished`; the second handler keeps that from surfacing as an
      // unhandled rejection. The `await` at the end still sees the real outcome.
      void finished.catch(() => undefined);

      try {
        const transcriptPath = await this.#transcript(controller.signal);
        if (transcriptPath === undefined) {
          this.#transcriptMissing = true;
        } else {
          // If the run already finished, a follow-read would be handed an aborted
          // signal and return immediately, dropping every event in the file. Read
          // it once to EOF instead.
          const done = controller.signal.aborted;
          // Seeded rather than left at zero so that a reader which throws before
          // it opens the file cannot rewind this session to the start and re-bill
          // every turn before this one.
          const stats = createStats();
          stats.consumedBytes = this.#offset;
          const events = readTranscript({
            path: transcriptPath,
            price: (usage, model) => priceUsage(model, usage).usd,
            pollIntervalMs: this.#init.timing.pollIntervalMs,
            startAtByte: this.#offset,
            stats,
            ...(done ? { follow: false } : { signal: controller.signal }),
          });

          try {
            // NEVER `break` OUT OF THIS LOOP. readTranscript holds the last
            // message's usage until a record proves it complete, and emits it on
            // the way out — but only if the generator is allowed to finish.
            // Breaking runs its `finally` without that final flush, and a dropped
            // usage event is a dropped bill. Every early exit here is an abort of
            // `controller`, which the reader honours by draining and returning
            // cleanly.
            for await (const event of events) {
              switch (event.type) {
                case 'session':
                  // Already emitted above, from an id we chose.
                  break;
                case 'exit':
                  // The reader only emits this for a genuinely terminal stop
                  // reason. It is folded into OUR exit rather than forwarded,
                  // because every consumer treats `exit` as the end of the stream
                  // — one arriving mid-run would end their loop early, which is
                  // precisely the dropped-bill failure the comment above exists
                  // to prevent.
                  this.#terminalReason = event.reason ?? 'terminal_stop_reason';
                  break;
                default:
                  // Any event at all is proof the worker is moving, which is what
                  // stops a permission prompt that WAS answered from later reading
                  // as a stall.
                  this.#lastActivityAt = Date.now();
                  yield event;
              }
            }
          } finally {
            // Whatever was consumed stays consumed even if the loop threw: the
            // next turn must not re-read it.
            this.#offset = stats.consumedBytes;
          }
        }
      } finally {
        // The watcher owns the abort, but a throw from the reader must not leave
        // it running after the generator is gone.
        if (!controller.signal.aborted) controller.abort();
      }

      const result = await finished;
      // Before the exit, never after: `exit` ends the stream for every consumer,
      // and the orchestrator's budget check runs on the usage events it saw
      // before it.
      yield* this.#drainSubagentUsage();
      yield this.#exitEvent(result);
    } finally {
      this.#streaming = false;
    }
  }

  /**
   * Bill the subagents. See header (7) for why they are invisible without this.
   *
   * Drained at the end of the turn rather than followed alongside it: the files
   * are complete once the Stop hook has fired and the settle window has passed,
   * and one bounded read is far less machinery — no directory watcher, no second
   * live reader — for the same money. Offsets are kept per file so a second turn
   * bills only what the second turn spent.
   *
   * ONLY `usage` IS FORWARDED. A subagent's text and tool calls belong to a
   * conversation the Crew is having with itself: forwarding them would file a
   * delegate's words in the Crew's log, and a delegate that happened to write
   * this system's escalation marker would open a decision on the captain's inbox
   * that no Crew asked for.
   *
   * Never throws — most runs delegate nothing, so a missing directory is the
   * common case, and a subagent transcript we cannot read costs us its cost
   * rather than the run.
   */
  async *#drainSubagentUsage(): AsyncGenerator<AdapterEvent> {
    const main = this.#transcriptPath;
    if (main === undefined) return;

    // Sibling of the session transcript, named for the session. Derived rather
    // than searched: unlike the session file (whose project directory is a lossy
    // encoding of a cwd) this path is anchored to one we have already found.
    const dir = path.join(path.dirname(main), this.id, 'subagents');
    let names: string[];
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith('.jsonl'));
    } catch {
      return;
    }
    names.sort();

    for (const name of names) {
      const file = path.join(dir, name);
      const stats = createStats();
      stats.consumedBytes = this.#subagentOffsets.get(file) ?? 0;
      // DRAINED INTO AN ARRAY, NOT YIELDED THROUGH. Yielding from inside the
      // read loop suspends this generator mid-read, so a consumer that stops
      // early would abandon the reader before its final flush — while the
      // offset below still advanced past the records it never billed, putting
      // them out of reach of every later turn too. Collecting first makes the
      // read atomic: the reader always runs to completion, or nothing moves.
      const billed: AdapterEvent[] = [];
      try {
        for await (const event of readTranscript({
          path: file,
          price: (usage, model) => priceUsage(model, usage).usd,
          follow: false,
          startAtByte: stats.consumedBytes,
          // The file was just listed; anything slower than "already there" is a
          // symlink to a session that has been deleted, not a file to wait for.
          waitForFileMs: 0,
          stats,
        })) {
          if (event.type === 'usage') billed.push(event);
        }
      } catch {
        /* see the docstring: one unreadable delegate must not fail the turn */
      }
      this.#subagentOffsets.set(file, stats.consumedBytes);
      yield* billed;
    }
  }

  /**
   * Wait for the turn to end, handle structured output, then release the reader.
   *
   * Runs alongside `#pump`'s read loop rather than inside it: the reader must be
   * draining the transcript the whole time this is waiting, including across a
   * structured-output retry, which is a second real turn.
   */
  async #runToCompletion(controller: AbortController): Promise<RunResult> {
    let retries = this.#init.structuredRetries;
    let result: RunResult;

    for (;;) {
      const outcome = await this.#waitForTurn();
      if (outcome !== 'stopped' || this.#init.schema === undefined) {
        result = { outcome };
        break;
      }

      const verdict = await this.#readStructured();
      if (verdict.problems.length === 0) {
        result = { outcome, structured: verdict.value };
        break;
      }
      if (retries <= 0 || this.#closed || !(await this.#alive())) {
        result = { outcome, structuredProblems: verdict.problems };
        break;
      }

      // Retry as a conversational turn. `send()` clears the Stop marker, which
      // is what stops the wait below from returning instantly on the Stop that
      // has already happened.
      retries--;
      try {
        await this.send(correctionMessage(this.#init.markers.verdict, verdict.problems));
      } catch {
        result = { outcome, structuredProblems: verdict.problems };
        break;
      }
    }

    // Let the CLI finish writing, and let the reader poll again. See DEFAULT_SETTLE_MS.
    if (!controller.signal.aborted) {
      await delay(this.#init.timing.settleMs);
      controller.abort();
    }
    return result;
  }

  /** One turn's wait. Every exit from this loop is bounded. */
  async #waitForTurn(): Promise<TurnOutcome> {
    const { pollIntervalMs, turnTimeoutMs, blockedGraceMs } = this.#init.timing;
    const deadline = Date.now() + turnTimeoutMs;
    let nextAliveCheck = Date.now() + ALIVE_CHECK_INTERVAL_MS;
    /** A permission prompt seen, and the activity clock as of that moment. */
    let waitingOn: { note: Notification; since: number; activityAt: number } | undefined;

    for (;;) {
      // Stop first: a worker that finished and then had its window closed still
      // finished, and the marker is the more truthful of the two signals.
      if (await exists(this.#init.markers.stop)) return 'stopped';
      if (this.#closed) return 'closed';
      if (this.#interrupted) return 'interrupted';
      if (this.#init.signal?.aborted === true) return 'aborted';
      if (Date.now() >= deadline) return 'timeout';

      // A dialog nobody is there to answer. Detected structurally, from the
      // Notification payload — never from the screen. See header (4).
      const note = await takeNotification(this.#init.markers.notify);
      if (note?.type === PERMISSION_PROMPT) {
        waitingOn = { note, since: Date.now(), activityAt: this.#lastActivityAt };
      }
      if (waitingOn !== undefined) {
        if (this.#lastActivityAt > waitingOn.activityAt) {
          waitingOn = undefined; // somebody answered it, or it resolved itself.
        } else if (Date.now() - waitingOn.since >= blockedGraceMs) {
          this.#blockedBy = waitingOn.note;
          return 'blocked';
        }
      }

      if (Date.now() >= nextAliveCheck) {
        nextAliveCheck = Date.now() + ALIVE_CHECK_INTERVAL_MS;
        if (!(await this.#alive())) {
          // One last look: the process may have exited between the Stop hook and
          // this check, which is a completed turn, not a death.
          if (await exists(this.#init.markers.stop)) return 'stopped';
          return 'died';
        }
      }

      await delay(pollIntervalMs);
    }
  }

  /** The transcript, found once and remembered: the session id cannot change. */
  async #transcript(signal: AbortSignal): Promise<string | undefined> {
    if (this.#transcriptPath !== undefined) return this.#transcriptPath;
    const found = await this.#locateTranscript(signal);
    if (found !== undefined) this.#transcriptPath = found;
    return found;
  }

  /**
   * Find `<uuid>.jsonl`. Searched rather than computed — the project directory
   * name is a lossy encoding of the cwd, so `findTranscript` is the only correct
   * way to get there (see its docstring).
   */
  async #locateTranscript(signal: AbortSignal): Promise<string | undefined> {
    const { pollIntervalMs, transcriptTimeoutMs } = this.#init.timing;
    const deadline = Date.now() + transcriptTimeoutMs;
    for (;;) {
      const found = await findTranscript(this.id, { root: this.#init.transcriptRootPath });
      if (found !== undefined) return found;
      // A run that ended without ever writing a transcript will never write one.
      if (signal.aborted || Date.now() >= deadline) {
        return findTranscript(this.id, { root: this.#init.transcriptRootPath });
      }
      await delay(pollIntervalMs);
    }
  }

  /** Read and check the file the worker was told to write. Never throws. */
  async #readStructured(): Promise<{ value?: unknown; problems: string[] }> {
    const file = this.#init.markers.verdict;
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      return { problems: [`${file} was not written`] };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.trim());
    } catch (err) {
      return { problems: [`${file} is not valid JSON (${errorText(err)})`] };
    }

    const problems = validateAgainstSchema(parsed, this.#init.schema);
    return problems.length === 0 ? { value: parsed, problems } : { problems };
  }

  /** Exhaustive over `TurnOutcome`; the compiler enforces that. */
  #exitEvent(result: RunResult): AdapterEvent {
    switch (result.outcome) {
      case 'stopped': {
        const problems = result.structuredProblems;
        if (problems !== undefined) {
          return {
            type: 'exit',
            ok: false,
            reason: `structured_output_invalid: ${problems.join('; ')}`,
          };
        }
        if (this.#terminalReason !== undefined) {
          return { type: 'exit', ok: false, reason: this.#terminalReason };
        }
        return {
          type: 'exit',
          ok: true,
          // Reported even on a good exit: the work happened, but nothing about it
          // was observed, so no cost was billed and no text was recorded.
          ...(this.#transcriptMissing ? { reason: 'transcript_not_found' } : {}),
          ...(this.#init.schema === undefined ? {} : { structured: result.structured }),
        };
      }
      case 'interrupted':
        return { type: 'exit', ok: false, interrupted: true, reason: 'interrupted' };
      case 'aborted':
        return { type: 'exit', ok: false, interrupted: true, reason: 'aborted' };
      case 'closed':
        return { type: 'exit', ok: false, reason: 'closed' };
      case 'timeout':
        return {
          type: 'exit',
          ok: false,
          reason: `no Stop hook within ${this.#init.timing.turnTimeoutMs}ms`,
        };
      case 'died':
        return { type: 'exit', ok: false, reason: 'session ended before the Stop hook fired' };
      case 'blocked':
        return {
          type: 'exit',
          ok: false,
          // The attach command belongs IN the reason: this is the one failure a
          // human can still rescue, and only if they know where to go.
          reason:
            `blocked on a prompt nobody answered (${this.#blockedBy?.message ?? 'permission prompt'})` +
            ` — attach with: ${this.attachCommand}`,
        };
    }
  }

  /**
   * A follow-up turn: type, then submit. The same two steps as the launch, for
   * the same reason — text alone sits in the composer forever.
   */
  async send(message: string): Promise<void> {
    requireCapability(this.#init.adapter, 'steer');
    if (this.#closed) throw new Error(`session "${this.id}" is closed`);

    // Newlines are collapsed, and it is a real limitation rather than tidying:
    // the composer treats a submit key as submit, so a multi-line message risks
    // arriving as several half-messages. Losing the line breaks is recoverable;
    // sending the first paragraph as a whole turn is not. If a future release
    // makes a literal newline safe, verify it and delete this.
    const oneLine = message.replace(/\s*\r?\n\s*/g, ' ').trim();
    if (oneLine === '') return;

    // A NEW TURN STARTS HERE, so the previous turn's terminal signals go with
    // it. A Stop marker left in place would end the next turn the instant it is
    // waited on, and an Escape from the last turn would end it as interrupted
    // before it had begun.
    await this.#clearStopMarker();
    this.#interrupted = false;

    await this.#init.backend.sendText(this.#init.endpoint.target, oneLine);
    await this.#submit();
  }

  /**
   * Press Enter until the turn has actually started, and fail loudly if it never
   * does.
   *
   * Typing is not sending. `sendText` puts the message in the composer; only a
   * submit key starts a turn, and a submit key can be eaten (see
   * `SUBMIT_SETTLE_MS`). The failure that motivated this had no symptom at all:
   * a rework message sat in the composer as `[Pasted text #1]`, the task stayed
   * `working` with `reworkCount: 1`, and the only thing that ever moved it was a
   * human pressing Enter by hand.
   *
   * Confirmation comes from the transcript, never the screen: a submitted turn
   * appends a `user` record, and nothing else does. If there is no transcript to
   * read yet, one settled Enter is all this can honestly promise, and it says so
   * by returning rather than pretending to have checked.
   */
  async #submit(): Promise<void> {
    const target = this.#init.endpoint.target;
    const before = await this.#userTurns();

    // Zero is "this transcript does not record prompts", not "no turn has been
    // submitted": a session that has run at all was launched with a positional
    // prompt, and Claude Code writes that as a `user` record before anything
    // else. A transcript with none of them is one this cannot read the way it
    // thinks it can — a stand-in harness in the tests, or a future format — and
    // guessing there would turn every send into four Enters and a hard failure.
    // The settled Enter below is the half that fixed the observed bug on its
    // own; confirmation is the belt on top of it, and it is honest about when
    // it is not wearing one.
    const confirmable = before !== undefined && before > 0;

    for (let attempt = 1; attempt <= SUBMIT_ATTEMPTS; attempt += 1) {
      await delay(SUBMIT_SETTLE_MS);
      await this.#init.backend.sendKey(target, 'Enter');
      if (!confirmable) return;

      const deadline = Date.now() + SUBMIT_CONFIRM_MS;
      while (Date.now() < deadline) {
        await delay(this.#init.timing.pollIntervalMs);
        const now = await this.#userTurns();
        if (now !== undefined && now > before) return;
      }
    }

    throw new Error(
      `session "${this.id}" did not accept the follow-up turn: the message was typed into the ` +
        `composer but ${SUBMIT_ATTEMPTS} Enter presses over ` +
        `${Math.round((SUBMIT_ATTEMPTS * (SUBMIT_SETTLE_MS + SUBMIT_CONFIRM_MS)) / 1000)}s did not ` +
        `start a turn — the transcript records no new message. Attach and press Enter to see what ` +
        `the composer is holding: ${this.attachCommand}`,
    );
  }

  /**
   * How many turns the captain's side of this conversation has, as the
   * transcript records them. `undefined` means "cannot tell" — no transcript
   * located yet, or unreadable — which is different from zero and is treated as
   * such by every caller.
   */
  async #userTurns(): Promise<number | undefined> {
    const file =
      this.#transcriptPath ??
      (await findTranscript(this.id, { root: this.#init.transcriptRootPath }).catch(
        () => undefined,
      ));
    if (file === undefined) return undefined;

    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      return undefined;
    }

    let count = 0;
    for (const line of raw.split('\n')) {
      if (line === '') continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isUserPrompt(record)) continue;
      count += 1;
    }
    return count;
  }

  async interrupt(): Promise<void> {
    requireCapability(this.#init.adapter, 'interrupt');
    if (this.#closed) return;
    // Set first: Escape stops the turn, but nothing guarantees a Stop hook fires
    // for an interrupted turn, so the flag is what ends the wait.
    this.#interrupted = true;
    await this.#init.backend.sendKey(this.#init.endpoint.target, 'Escape');
  }

  /**
   * Kill the endpoint and remove this run's marker files.
   *
   * Both halves matter. `list()` on the backend is what the reaper uses to find
   * orphans, so a crew that finished and left its window behind makes every
   * later reap ambiguous; and the markers are files in a temp directory that
   * nothing else will ever delete.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    try {
      await this.#init.backend.kill(this.#init.endpoint.target);
    } catch {
      // Teardown is best-effort: a backend that is already gone has done the job.
    }
    await cleanupRunDir(this.#init.markers.dir);
  }

  async #alive(): Promise<boolean> {
    try {
      return await this.#init.backend.alive(this.#init.endpoint.target);
    } catch {
      // The backend failed to answer. Assume alive rather than reaping a live
      // worker over one failed tmux call; the turn timeout is the real backstop.
      return true;
    }
  }

  async #clearStopMarker(): Promise<void> {
    await fs.rm(this.#init.markers.stop, { force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface ClaudeCliAdapterOptions {
  /** Where sessions live. Defaults to tmux. */
  backend?: SessionBackend;
  /** The binary. Defaults to whatever `claude` resolves to in this process. */
  claudePath?: string;
  /** Root of `<config>/projects`. Defaults to the reader's, from `env`. */
  transcriptRoot?: string;
  /** Where per-run marker directories are created. Defaults to the temp dir. */
  markerDir?: string;
  /**
   * Extra environment for every worker. Merged over the endpoint's own, which
   * for a long-lived tmux server is NOT this process's environment — anything a
   * worker must see has to be named here.
   */
  env?: Readonly<Record<string, string | undefined>>;
  readyTimeoutMs?: number;
  turnTimeoutMs?: number;
  transcriptTimeoutMs?: number;
  pollIntervalMs?: number;
  settleMs?: number;
  /** Grace given to a permission prompt before the run is declared blocked. */
  blockedGraceMs?: number;
  /** Corrections typed into a live session when structured output fails. */
  structuredRetries?: number;
  /**
   * Record workspace trust for a worker's directory before launching it.
   *
   * DEFAULT OFF, and the default is the whole reason this is a flag: it writes
   * to the captain's `~/.claude.json`, and a test suite that did that would be
   * writing every temporary worktree it ever made into the config of whoever
   * ran it. Production turns it on at the one place the adapter is constructed
   * for real (`boot()` in `src/cli/index.ts`); a test turns it on with
   * `env.CLAUDE_CONFIG_DIR` pointed somewhere disposable.
   */
  trustWorkspaces?: boolean;
}

export class ClaudeCliAdapter implements HarnessAdapter {
  readonly name = 'claude-cli';
  readonly capabilities: AdapterCapabilities = CLAUDE_CLI_CAPABILITIES;

  /**
   * Whether a worker launched by this adapter is billed per token.
   *
   * Resolved ONCE, at construction, from the same environment the workers get —
   * `resolveAuth` over `process.env` merged with `opts.env`, which is the merge
   * the transcript root already uses, because for a long-lived tmux server this
   * process's environment is not the worker's. Frozen at construction rather
   * than read per spawn so that every run of one fleet agrees; a key exported
   * halfway through an afternoon must not make two tasks in the same log
   * disagree about what a dollar means.
   */
  readonly metered: boolean;

  readonly #opts: ClaudeCliAdapterOptions;
  readonly #backend: SessionBackend;
  readonly #transcriptRoot: string;
  readonly #markerDir: string;
  /** Resolved lazily: constructing an adapter must not require a CLI. */
  #claudePath: string | undefined;

  constructor(opts: ClaudeCliAdapterOptions = {}) {
    this.#opts = opts;
    this.#backend = opts.backend ?? new TmuxBackend();
    this.#markerDir = opts.markerDir ?? os.tmpdir();
    const workerEnv = { ...process.env, ...stripUndefined(opts.env ?? {}) } as NodeJS.ProcessEnv;
    this.#transcriptRoot = opts.transcriptRoot ?? transcriptRoot(workerEnv);
    this.metered = resolveAuth(workerEnv).kind === 'api-key';
    this.#claudePath = opts.claudePath;
  }

  async spawn(req: SpawnRequest): Promise<Session> {
    if (req.resume !== undefined) requireCapability(this, 'fork');
    if (req.outputSchema !== undefined) requireCapability(this, 'structuredOutput');
    if (req.prompt.trim() === '') {
      // Submitting an empty composer is a no-op, so the Stop hook would never
      // fire and the run would sit until the turn timeout. Say so immediately.
      throw new Error('spawn requires a non-empty prompt: an empty composer never starts a turn');
    }
    // Launching a worker for a run that is already cancelled would create a
    // window and a temp directory for something nobody is going to read.
    if (req.signal?.aborted === true) throw new Error('spawn aborted before launch');
    if (!(await this.#backend.available())) {
      throw new SessionBackendUnavailableError(
        this.#backend.name,
        `\`${this.#backend.name}\` did not answer — check it is installed and on PATH`,
      );
    }

    const claudePath = this.#resolveBinary();
    const sessionId = randomUUID();
    const markers = await this.#createRunDir(sessionId);

    const timing = {
      turnTimeoutMs: this.#opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      transcriptTimeoutMs: this.#opts.transcriptTimeoutMs ?? DEFAULT_TRANSCRIPT_TIMEOUT_MS,
      pollIntervalMs: this.#opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      settleMs: this.#opts.settleMs ?? DEFAULT_SETTLE_MS,
      blockedGraceMs: this.#opts.blockedGraceMs ?? DEFAULT_BLOCKED_GRACE_MS,
    };

    const structured = req.outputSchema !== undefined;

    // THE LINE BUDGET. Everything below this comment exists because the command
    // is handed to a session backend that stops at a fixed size — 16,364 bytes
    // for tmux — and BlueSpace's own inputs cross it routinely. See
    // LAUNCH_LINE_BUDGET for the failure this replaces.
    const env = this.#launchEnv();
    const cwdBytes = Buffer.byteLength(req.cwd, 'utf8') + 1;
    const envBytes = envFramingBytes(env);
    /** Everything the backend will add to this argv on its way to the terminal. */
    const framingBytes = BACKEND_FRAMING_BYTES + cwdBytes + envBytes;
    /** The whole command's ceiling, which is what the backend actually enforces. */
    const commandLimitBytes = this.#backend.maxCommandBytes ?? DEFAULT_LAUNCH_BUDGET_BYTES;
    /** What is left for THIS adapter's argv once the backend has taken its share. */
    const limitBytes = commandLimitBytes - framingBytes;

    let systemPromptAppend = structured
      ? req.systemPromptAppend + structuredOutputInstruction(markers.verdict, req.outputSchema)
      : req.systemPromptAppend;

    // The verdict file lives outside the worktree so a run never leaves a stray
    // artefact in the diff it is being judged on; a prompt file lives there for
    // the same reason. Either way the worker has to be granted the directory
    // explicitly, and one grant covers both.
    const addDirs: string[] = [];

    // Does the prompt fit as a positional? Measured against the argv that would
    // actually be sent, not against a guess: the flags, the paths and the cwd
    // all spend from the same budget. Built once WITHOUT the prompt to price the
    // rest, because that overhead is what decides how much prompt there is room
    // for.
    const overheadArgv = buildLaunchArgv({
      claudePath,
      sessionId,
      profile: req.profile,
      settingScopes: req.settingScopes,
      systemPromptFile: markers.systemPrompt,
      settingsFile: markers.settings,
      prompt: '',
      addDirs: [markers.dir],
    });
    const roomForPrompt = limitBytes - launchArgvBytes(overheadArgv);
    const promptFits = Buffer.byteLength(req.prompt, 'utf8') + 1 <= roomForPrompt;

    let positional = req.prompt;
    if (!promptFits) {
      // Too big for the line. It becomes a file, the positional becomes a
      // pointer at it, and the system prompt names the same path so the worker
      // is told twice through two mechanisms. See `promptPointer`.
      await fs.writeFile(markers.prompt, req.prompt, 'utf8');
      positional = promptPointer(markers.prompt);
      systemPromptAppend += promptFileNotice(markers.prompt);
    }
    if (structured || !promptFits) addDirs.push(markers.dir);

    // Written BEFORE the launch, both of them, because the CLI reads them at
    // startup and a file that is not there yet is a worker that dies explaining
    // it. `--append-system-prompt-file` validates its path (verified on 2.1.224).
    await fs.writeFile(markers.settings, buildRunSettings(markers), 'utf8');
    await fs.writeFile(markers.systemPrompt, systemPromptAppend, 'utf8');

    const argv = buildLaunchArgv({
      claudePath,
      sessionId,
      profile: req.profile,
      settingScopes: req.settingScopes,
      systemPromptFile: markers.systemPrompt,
      settingsFile: markers.settings,
      prompt: positional,
      ...(addDirs.length > 0 ? { addDirs } : {}),
    });

    // The backstop, and the thing that replaces `command too long`. It should be
    // unreachable — the prompt is the only input that can grow, and it has just
    // been bounded — so reaching it means something else did, and the message
    // has to say what. Checked before the window exists so nothing is left over.
    //
    // Priced against the WHOLE command, backend framing included, so the parts
    // list is the real one: cwd and env are not in this argv but are on the same
    // line, and naming only what happens to be in `argv` would point a captain
    // at the wrong input.
    try {
      assertLaunchFits(
        argv,
        commandLimitBytes,
        [
          { label: 'the opening prompt', bytes: Buffer.byteLength(positional, 'utf8') },
          { label: 'the working directory', bytes: cwdBytes },
          { label: 'the worker environment', bytes: envBytes },
          { label: 'the claude binary path', bytes: Buffer.byteLength(claudePath, 'utf8') },
          { label: 'the run directory paths', bytes: launchArgvBytes(addDirs) },
        ],
        framingBytes,
      );
    } catch (err) {
      await cleanupRunDir(markers.dir);
      throw err;
    }

    // Before the window exists, because the dialog it prevents fires before the
    // first hook does — and a worker stuck on that dialog is indistinguishable
    // from a hang for 90 seconds and then dies. Failure here is not fatal: the
    // run proceeds, and `SessionNotReadyError` says what it means if it comes
    // to that.
    this.#recordTrust(req.cwd);

    let endpoint: SessionEndpoint;
    try {
      endpoint = await this.#backend.launch({
        // Short and derived from the session id: it ends up inside a command a
        // human copy-pastes, and the backend sanitises it further.
        name: `blue-${sessionId.slice(0, 8)}`,
        cwd: req.cwd,
        argv,
        ...(env === undefined ? {} : { env }),
      });
    } catch (err) {
      await cleanupRunDir(markers.dir);
      throw err;
    }

    // READINESS, then a belt-and-braces submit. Waiting for SessionStart is the
    // load-bearing half: it is what turns an unanswered workspace-trust prompt
    // into SessionNotReadyError instead of a worker that sits forever. The Enter
    // is the other half of header (3) — the positional prompt submits itself, so
    // this lands on an empty composer and does nothing, and it stays because the
    // failure it covers costs a whole task.
    try {
      await waitForFile(markers.ready, {
        timeoutMs: this.#opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
        pollIntervalMs: timing.pollIntervalMs,
      });
      await this.#backend.sendKey(endpoint.target, 'Enter');
    } catch (err) {
      // Do not leave a half-started worker sitting in a window nobody will look
      // at; the error explains what to do about it.
      await this.#backend.kill(endpoint.target).catch(() => undefined);
      await cleanupRunDir(markers.dir);
      if (err instanceof TimeoutError) {
        throw new SessionNotReadyError(
          sessionId,
          req.cwd,
          this.#opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
        );
      }
      throw err;
    }

    return new ClaudeCliSession({
      adapter: this,
      backend: this.#backend,
      endpoint,
      sessionId,
      markers,
      schema: req.outputSchema,
      transcriptRootPath: this.#transcriptRoot,
      timing,
      structuredRetries: this.#opts.structuredRetries ?? DEFAULT_STRUCTURED_RETRIES,
      signal: req.signal,
    });
  }

  /**
   * Helm does not run here. Hosting the caller's tools needs an in-process MCP
   * server, which is an SDK facility with no interactive-CLI equivalent — so
   * this is a declared incapacity, not a gap to be filled with a worse version.
   */
  async converse(_req: ConversationRequest): Promise<Conversation> {
    throw new UnsupportedCapabilityError(this.name, 'conversation');
  }

  #resolveBinary(): string {
    if (this.#claudePath === undefined) {
      this.#claudePath = resolveClaudeBinary({
        ...process.env,
        ...stripUndefined(this.#opts.env ?? {}),
      });
    }
    return this.#claudePath;
  }

  #launchEnv(): Readonly<Record<string, string | undefined>> | undefined {
    const env = this.#opts.env;
    return env === undefined || Object.keys(env).length === 0 ? undefined : env;
  }

  /**
   * Answer Claude Code's workspace-trust dialog in advance, for this directory.
   *
   * Silent when it works and when there is nothing to do, which is every launch
   * after the first in a given worktree. A failure is reported once, at warn,
   * and never raised: being unable to write a captain's config is a reason to
   * let them see the dialog, not a reason to refuse them a crew.
   */
  #recordTrust(cwd: string): void {
    if (this.#opts.trustWorkspaces !== true) return;
    const env = { ...process.env, ...this.#opts.env };
    const outcome = trustWorkspace(cwd, env);
    if (outcome.kind === 'unavailable') {
      console.warn(
        `[bluespace:adapter] could not record workspace trust for ${cwd} (${outcome.why}) — ` +
          'the worker may stop on the trust dialog',
      );
    }
  }

  async #createRunDir(sessionId: string): Promise<RunMarkers> {
    // realpath: on macOS the temp dir is a symlink (/var -> /private/var), and a
    // hook that touches one path while we stat the other never appears to fire.
    const base = await fs.realpath(this.#markerDir);
    const dir = await fs.mkdtemp(path.join(base, `blue-run-${sessionId.slice(0, 8)}-`));
    return {
      dir,
      ready: path.join(dir, 'ready'),
      stop: path.join(dir, 'stop'),
      notify: path.join(dir, 'notify.json'),
      verdict: path.join(dir, 'output.json'),
      settings: path.join(dir, 'settings.json'),
      systemPrompt: path.join(dir, 'system-prompt.md'),
      prompt: path.join(dir, 'prompt.md'),
    };
  }
}

export function createClaudeCliAdapter(opts?: ClaudeCliAdapterOptions): HarnessAdapter {
  return new ClaudeCliAdapter(opts);
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Distinguishes "the marker never appeared" from any other failure. */
export class TimeoutError extends Error {
  constructor(
    readonly what: string,
    readonly waitedMs: number,
  ) {
    super(`timed out after ${waitedMs}ms waiting for ${what}`);
    this.name = 'TimeoutError';
  }
}

async function waitForFile(
  file: string,
  o: { timeoutMs: number; pollIntervalMs: number },
): Promise<void> {
  const deadline = Date.now() + o.timeoutMs;
  for (;;) {
    if (await exists(file)) return;
    if (Date.now() >= deadline) throw new TimeoutError(file, o.timeoutMs);
    await delay(Math.min(o.pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

async function cleanupRunDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Is this transcript record a turn the captain's side actually submitted?
 *
 * Tool results are also written as `user` records and vastly outnumber real
 * prompts, so counting `type: "user"` alone would report a turn had started
 * every time the worker ran a command. A submitted prompt is a `user` record
 * whose content is a string, or an array holding at least one `text` block.
 */
function isUserPrompt(record: unknown): boolean {
  if (!isObject(record)) return false;
  if (record['type'] !== 'user') return false;
  if (record['isSidechain'] === true) return false;

  const message = record['message'];
  if (!isObject(message)) return false;

  const content = message['content'];
  if (typeof content === 'string') return content !== '';
  if (!Array.isArray(content)) return false;
  return content.some((part) => isObject(part) && part['type'] === 'text');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** `exactOptionalPropertyTypes` is off, so an explicit undefined would override. */
function stripUndefined(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
