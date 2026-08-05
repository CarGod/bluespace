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

export interface SessionBackend {
  readonly name: string;

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
   */
  sendText(target: string, text: string): Promise<void>;

  /** Press one key. Submission is `sendKey(target, 'Enter')`. */
  sendKey(target: string, key: SessionKey): Promise<void>;

  /** Process liveness only. Says nothing about whether a turn has finished. */
  alive(target: string): Promise<boolean>;

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
