/**
 * Claude Code's workspace-trust gate, read and — for worktrees BlueSpace itself
 * cut — answered in advance.
 *
 * THE FAILURE. Claude Code asks *"Is this a project you trust?"* the first time
 * it opens a directory, and NOTHING runs until it is answered: no SessionStart
 * hook, so no readiness marker, so every crew dies at the 90-second timeout with
 * `dispatch_failed`. Nobody is sitting in front of a crew to answer it.
 *
 * WHY THIS ONLY STARTED HAPPENING. Trust is inherited from an ancestor, and up
 * to Claude Code 2.1.231 that walk ran all the way to `/`. A captain whose home
 * directory is trusted — which is every captain who has ever answered the dialog
 * in `~` — therefore had every worktree under `~/.bluespace/worktrees` trusted
 * for free, and the fleet worked without anyone knowing this gate existed.
 *
 * 2.1.232 BOUNDS THE WALK AT THE REPOSITORY ROOT. Read out of the binary and
 * confirmed by experiment on this machine: a fresh `git init` under a trusted
 * ancestor now prompts, while a plain directory in the same place does not. A
 * git worktree IS its own repository root, so the walk checks the worktree and
 * stops. That is why the remedy the old error message printed — trust the
 * directory worktrees are created under, once — cannot work any more: the one
 * directory it tells you to trust is the one directory the walk refuses to look
 * at.
 *
 * WHY WRITING THE CAPTAIN'S GLOBAL CONFIG IS THE ANSWER, HAVING BEEN THE ONE
 * THING BLUESPACE WOULD NOT DO. The alternatives were measured and are worse:
 *
 *   - `-p` / non-interactive, where the dialog is skipped: that is not a crew.
 *     A crew is a real interactive session on the captain's own login, which is
 *     an architectural boundary, not a preference (`docs/compliance.md`).
 *   - `CLAUDE_CODE_SANDBOXED=1`, which short-circuits the trust check: it tells
 *     Claude Code something untrue about how it is running, and buys the answer
 *     to one question with an unknown number of other behaviours.
 *   - Watching the pane and pressing `1`: answering a safety prompt on the
 *     captain's behalf, blind, inside a 90-second race.
 *
 * What is written here is one boolean, for one directory, and it is the same
 * boolean the dialog would write if the captain answered it. The directory is
 * one BlueSpace created moments earlier, from a repository the captain
 * registered themselves. Nothing else in the file is touched, and a directory
 * that is already trusted is not written at all.
 *
 * Verified against Claude Code 2.1.232 on 2026-08-13.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when that is set.
 *
 * Read off the environment rather than assumed, because the transcript reader
 * already honours the same variable and the two must agree about which
 * installation they are talking about.
 */
export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configDir = env['CLAUDE_CONFIG_DIR'];
  if (configDir !== undefined && configDir.trim() !== '') return path.join(configDir.trim(), '.claude.json');
  // `HOME` before `os.homedir()` so a caller can ask about a home that is not
  // this process's — the launcher does, to answer for the window it is opening.
  const home = env['HOME'];
  return path.join(home !== undefined && home !== '' ? home : os.homedir(), '.claude.json');
}

/**
 * The repository this directory belongs to — the boundary the trust walk stops
 * at — or undefined when it is not in one.
 *
 * `.git` is a FILE in a worktree and a directory in a primary checkout, so the
 * test is existence, not type. That distinction is the whole point here: the
 * file is what makes a worktree its own root.
 */
export function repositoryRoot(dir: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The `projects` map of the global config, or undefined if it cannot be read. */
function readProjects(configPath: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const projects = (parsed as Record<string, unknown>)['projects'];
  if (typeof projects !== 'object' || projects === null) return undefined;
  return projects as Record<string, unknown>;
}

function acceptedAt(projects: Record<string, unknown>, dir: string): boolean {
  const entry = projects[dir];
  if (typeof entry !== 'object' || entry === null) return false;
  return (entry as Record<string, unknown>)['hasTrustDialogAccepted'] === true;
}

/**
 * Will Claude Code open in this directory without asking?
 *
 * `undefined` means "cannot tell" — no config file, or one this cannot parse —
 * and is deliberately not `false`. A guess in that direction would put a warning
 * about a modal in front of every captain whose config lives somewhere unusual,
 * which is worse than the modal.
 *
 * The walk mirrors 2.1.232's exactly: from the directory upwards, stopping at
 * (and including) the repository root, and never above it. An ancestor outside
 * the repository does not count however trusted it is.
 */
export function workspaceTrusted(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean | undefined {
  const projects = readProjects(globalConfigPath(env));
  if (projects === undefined) return undefined;

  const target = path.resolve(dir);
  const boundary = repositoryRoot(target);
  let current = target;
  for (;;) {
    if (boundary !== undefined && current !== boundary && !current.startsWith(`${boundary}${path.sep}`)) {
      return false;
    }
    if (acceptedAt(projects, current)) return true;
    if (current === boundary) return false;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** What `trustWorkspace` did, in the words the caller has to report it in. */
export type TrustOutcome =
  | { kind: 'already-trusted' }
  | { kind: 'recorded'; configPath: string }
  | { kind: 'unavailable'; why: string };

/**
 * Record that this directory is trusted, if it is not already.
 *
 * Never creates the config file and never repairs a broken one: an absent
 * `~/.claude.json` means Claude Code has not been through its own onboarding,
 * and a launcher inventing that file is a launcher deciding things it was not
 * asked to decide. In both cases the caller gets `unavailable` and the run goes
 * ahead — worst case the dialog appears and the captain sees the same failure
 * they would have seen anyway, with a message that now names the cause.
 *
 * The read-modify-write races with any Claude Code session writing the same
 * file, and there is no lock to take — the binary does not use one either. It is
 * kept as narrow as possible instead: nothing is written when the directory is
 * already trusted, which is every launch after the first in a given worktree.
 */
export function trustWorkspace(dir: string, env: NodeJS.ProcessEnv = process.env): TrustOutcome {
  const configPath = globalConfigPath(env);
  const target = path.resolve(dir);

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    return { kind: 'unavailable', why: `could not read ${configPath}: ${message(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: 'unavailable', why: `${configPath} is not readable JSON: ${message(err)}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'unavailable', why: `${configPath} is not a JSON object` };
  }

  const config = parsed as Record<string, unknown>;
  const projectsRaw = config['projects'];
  const projects: Record<string, unknown> =
    typeof projectsRaw === 'object' && projectsRaw !== null && !Array.isArray(projectsRaw)
      ? (projectsRaw as Record<string, unknown>)
      : {};

  if (workspaceTrusted(target, env) === true) return { kind: 'already-trusted' };

  const existing = projects[target];
  const entry =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  entry['hasTrustDialogAccepted'] = true;

  const next = { ...config, projects: { ...projects, [target]: entry } };

  // Atomic, and 0600 because that is what the file already is: it holds the
  // captain's history and their MCP registrations, and a config that comes back
  // world-readable from a helpful rewrite is a worse bug than the one being
  // fixed. The temp file is a sibling so the rename cannot cross a device.
  const tmp = `${configPath}.bluespace-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, configPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the write is what failed; the cleanup failing on top of it changes nothing */
    }
    return { kind: 'unavailable', why: `could not write ${configPath}: ${message(err)}` };
  }

  return { kind: 'recorded', configPath };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
