/**
 * Session backend contract.
 *
 * A "session endpoint" is a place a real, interactive Claude Code process can
 * live and that a human can walk up to. tmux is the reference implementation;
 * the interface exists so it is not the only possible one.
 *
 * WHY THIS LAYER EXISTS AT ALL. BlueSpace used to run its workers through a
 * vendor SDK, which was simpler in every respect but one: an SDK run is a
 * headless child process with no seat in front of it. Two things follow from
 * that, and both matter more than the simplicity did.
 *
 *  1. The captain cannot watch, and cannot take over. Everything a worker does
 *     had to be reconstructed after the fact from an event log. With a session
 *     endpoint, `attachCommand` is a real command that puts a human inside a
 *     running worker, typing.
 *
 *  2. Credentials. Anthropic documents OAuth (subscription) authentication as
 *     being for "ordinary use of Claude Code and other native Anthropic
 *     applications", and directs anything built on the Agent SDK to API keys
 *     instead. An interactive Claude Code session in a terminal is the former.
 *     See docs/compliance.md.
 *
 * THE ONE RULE. This module may start processes, address them, and type into
 * them. It may NOT read what they render. Terminal output is a picture of a
 * conversation, not the conversation; anything that parses it is guessing, and
 * guesses rot silently across harness releases. Every semantic signal BlueSpace
 * consumes comes from a structured source instead — the session transcript on
 * disk (see `src/transcript/`) and hook-written marker files. `alive()` is the
 * only observation offered here, and it reports process liveness, not content.
 */

/** A launched, addressable session. */
export interface SessionEndpoint {
  /**
   * Backend-opaque address for `sendText` / `sendKey` / `alive` / `kill`.
   * Never parse it; it is a handle, not a path.
   */
  readonly target: string;
  /**
   * Literally what the captain types to watch or take over this worker.
   * Surfaced in `blue ps` and the Starmap, so it has to be copy-pasteable.
   */
  readonly attachCommand: string;
}

export interface LaunchRequest {
  /**
   * Endpoint name, unique within the backend. Backends may sanitise it, so do
   * not derive the target from it — use the returned `SessionEndpoint.target`.
   */
  name: string;
  /** Working directory. For a Crew this is its disposable git worktree. */
  cwd: string;
  /**
   * Program and arguments, as an array. Never a shell string: a brief can
   * contain anything a captain can type, and a task title with a backtick in
   * it must not become a command substitution. Backends pass this straight to
   * execFile-style APIs with no shell involved.
   */
  argv: readonly string[];
  /** Extra environment for the launched process, merged over the caller's. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Keys a backend can press. Deliberately tiny — this is not a keyboard API. */
export type SessionKey = 'Enter' | 'Escape';

/**
 * How an endpoint ended, when it ended — the detail `alive(): boolean` throws
 * away.
 *
 * Still process state, never content: this reports what happened to the *place*
 * the worker was running, and says nothing about whether its turn finished.
 * "The turn never finished" is the caller's own signal (no Stop marker within
 * the timeout) and belongs to the caller; what a backend can add is whether the
 * place is still there, and if not, how much went with it.
 *
 *   - `running`      a live process. Nothing to explain.
 *   - `exited`       the endpoint is still there and the process in it is not.
 *   - `window-gone`  this one endpoint was closed; its neighbours are fine.
 *   - `session-gone` the group holding every endpoint went at once.
 *   - `server-gone`  the whole backend instance is down. Everything went.
 *   - `unavailable`  the backend did not answer. Evidence about the BACKEND,
 *                    not about the worker — a caller must not report it as a
 *                    death.
 *
 * The three "gone" states exist because they need different words to a human:
 * one worker closed, one fleet closed, one machine's worth of tmux closed. A
 * single "died" reads identically for all three and sends the captain looking in
 * the wrong place.
 */
export type EndpointState =
  | 'running'
  | 'exited'
  | 'window-gone'
  | 'session-gone'
  | 'server-gone'
  | 'unavailable';

export interface EndpointStatus {
  readonly state: EndpointState;
  /**
   * One sentence, for a human, naming what is gone and where to look. Safe to
   * put in an event reason or print in `blue ps`; contains no worker output.
   */
  readonly reason: string;
}

export interface SessionBackend {
  readonly name: string;

  /**
   * Largest `launch()` argv this backend can actually carry, in BYTES.
   *
   * Declared rather than assumed, for the same reason `AdapterCapabilities` is:
   * a caller that guesses wrong finds out from the backend's own error message,
   * which describes the backend's internals and not the caller's input. tmux
   * refuses a command over 16 KiB with `command too long` — a sentence that tells
   * a captain nothing about which of BlueSpace's inputs was oversized, and the
   * exact failure that lost a task with a 112,680-byte Sentinel prompt on it.
   *
   * Counted the way a backend counts it, which for tmux is every argv element
   * plus its NUL terminator — so callers must measure UTF-8 bytes, never
   * `String.length`. A brief written in Chinese hits a byte ceiling at a third of
   * the characters an English one does.
   *
   * Undefined means "no limit worth budgeting against" (a backend that spawns
   * directly is bounded only by the kernel's ARG_MAX, which is 1 MiB and has
   * never been the binding constraint here). Callers must treat it as advisory
   * and still handle a launch failure.
   */
  readonly maxCommandBytes?: number;

  /**
   * Is this backend usable on this machine right now? Checked before dispatch,
   * never assumed: a missing multiplexer must surface as one sentence at
   * startup, not as workers that die after a worktree already exists.
   */
  available(): Promise<boolean>;

  /** Start a process in a new endpoint. Resolves once addressable. */
  launch(req: LaunchRequest): Promise<SessionEndpoint>;

  /**
   * Type text into the endpoint WITHOUT submitting it.
   *
   * The split from `sendKey` is not fussiness. Claude Code accepts an opening
   * prompt as an argv positional, but that only populates the composer — it
   * does not send it, so a launch alone produces a session sitting on unsent
   * text forever. Submission is always a separate, explicit keypress, and
   * keeping the two apart means the same pair also covers steering a live
   * worker and answering it mid-run.
   *
   * TEXT OF ANY LENGTH MUST ARRIVE. `maxCommandBytes` bounds one command, not
   * one message: a backend whose transport is smaller than the text splits it
   * and delivers the pieces in order. Callers do not chunk, because a caller
   * that chunked would have to know where the composer's submit key lives.
   */
  sendText(target: string, text: string): Promise<void>;

  /** Press one key. Submission is `sendKey(target, 'Enter')`. */
  sendKey(target: string, key: SessionKey): Promise<void>;

  /** Process liveness only. Says nothing about whether a turn has finished. */
  alive(target: string): Promise<boolean>;

  /**
   * The same observation as `alive()`, with the reason kept. Optional: a backend
   * that cannot tell its failures apart should not pretend to.
   *
   * Callers that only branch on liveness should keep using `alive()`. Callers
   * that REPORT A DEATH TO THE CAPTAIN should prefer this, because `alive()`
   * false is the same value for "the process exited", "somebody closed this
   * window" and "somebody stopped the whole multiplexer", and the captain's next
   * move differs in all three. The failure that motivated it: a fleet killed by a
   * stray `tmux kill-server` was reported as `session ended before the Stop hook
   * fired` — indistinguishable from a worker that crashed on its own, so the
   * cause went unfound.
   *
   * `state: 'unavailable'` is not a death and must never be reported as one.
   */
  describeEndpoint?(target: string): Promise<EndpointStatus>;

  /** Terminate the endpoint. Idempotent: killing a dead endpoint is not an error. */
  kill(target: string): Promise<void>;

  /** Every endpoint this backend currently owns. Used to reap orphans on restart. */
  list(): Promise<string[]>;
}

/** Thrown when the backend is not installed or not reachable. */
export class SessionBackendUnavailableError extends Error {
  constructor(
    readonly backend: string,
    readonly hint: string,
  ) {
    super(`session backend "${backend}" is unavailable: ${hint}`);
    this.name = 'SessionBackendUnavailableError';
  }
}
