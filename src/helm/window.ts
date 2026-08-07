/**
 * What Helm's own window spent, recovered from disk after the fact.
 *
 * THE GAP THIS CLOSES. BlueSpace measures every consumer it starts: a Crew's
 * tokens are read live off its transcript, a Sentinel's are folded into its
 * task, and `maxTokensPerTask` stops either one. Helm was outside all of it.
 * It runs in the captain's own terminal, under no orchestrator, and it has
 * `Agent` — so it can fan out, and when it does the tokens are real and nothing
 * in this system has ever seen them. Observed: a template-upgrade request in
 * which Helm launched two sub-agents that spent 153.4k and 128.5k tokens in two
 * minutes, while `blue ps` printed nothing and the Starmap said "Nothing needs
 * you · 0 crew working" for the whole two minutes.
 *
 * AFTER THE FACT, AND SAID SO EVERYWHERE. There is no socket to attach to and
 * no process here to observe that window. What there is, is the file Claude Code
 * writes as it goes — the same format `src/transcript/reader.ts` already parses,
 * in the same place, with sub-agents in the sibling `subagents/` directory the
 * Crew adapter already drains. So this module reads a snapshot, and everything
 * it returns is stamped with when that snapshot was taken. Every consumer must
 * present it as "as of", never as "now": a sub-agent that started a second ago
 * has written nothing yet and is genuinely invisible here, and a view that
 * implied otherwise would be lying in the same direction as the bug.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not follow, does not watch, and does
 * not run anywhere but in the foreground of a command the captain typed. `blue
 * ps` is a short-lived process and this is a bounded read of a handful of files;
 * a background tailer for a window BlueSpace does not own would be a second
 * lifetime to get wrong for a number that is only ever read on demand.
 *
 * Nothing here throws for a missing or unreadable file. A window that has not
 * had a turn yet has no transcript, a window that delegated nothing has no
 * `subagents/` directory, and both are the ordinary case rather than a fault.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  addTokenUsage,
  noTokenUsage,
  totalTokens,
  type TokenUsage,
} from '../types/domain.js';
import { priceUsage, type TranscriptUsage } from '../pricing/index.js';
import { findTranscript, readTranscript } from '../transcript/reader.js';

// ---------------------------------------------------------------------------
// Where the window announces itself
// ---------------------------------------------------------------------------

/**
 * The environment variable that tells `blue mcp` which window it is serving.
 *
 * MEASURED, NOT DOCUMENTED. An MCP server registered through `--mcp-config` was
 * replaced with a stub that dumped its own environment; on 2.1.224 it was handed
 * `CLAUDE_CODE_SESSION_ID` set to the LAUNCHING window's session id — verified
 * by launching from a shell whose own `CLAUDE_CODE_SESSION_ID` was a different
 * uuid and watching the child receive the new one, so it is written by the
 * spawning window rather than inherited.
 *
 * THIS IS WHY THE LAUNCHER DOES NOT MINT THE ID ITSELF. `--session-id` looks
 * like the obvious route and is a trap: `claude --session-id <uuid> --continue`
 * exits 1 with *"Error: --session-id can only be used with --continue or
 * --resume if --fork-session is also specified"*, so a launcher that always
 * passed it would break `bluespace --continue` and `bluespace --resume` for a
 * bookkeeping feature. The MCP server is handed the right answer for free, in
 * every launch shape, and it is already started for exactly the windows we care
 * about — it IS the thing that makes a window a Helm window.
 */
export const SESSION_ID_ENV = 'CLAUDE_CODE_SESSION_ID';

/** Where the window is standing, as the harness reports it to its MCP servers. */
export const PROJECT_DIR_ENV = 'CLAUDE_PROJECT_DIR';

/** A Helm window, as much as its own MCP server can know about it at startup. */
export interface HelmWindowIdentity {
  sessionId: string;
  cwd: string;
}

/** UUID, in the one spelling `findTranscript` will accept. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which window this process is serving, or undefined when it is not in one.
 *
 * Undefined is a completely ordinary answer and never an error: `blue mcp` also
 * runs under other clients, and a captain may run it by hand to see what it
 * prints. The registration this feeds is skipped in that case, which costs
 * nothing — the alternative is a row in `blue ps` pointing at a session id that
 * names no transcript anywhere.
 *
 * The id is shape-checked here rather than at the point of use, because the
 * value ends up interpolated into a filename and matched against a directory
 * tree. `findTranscript` rejects a non-UUID by throwing; a caller registering a
 * window is not a caller that should have to catch.
 */
export function helmWindowFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HelmWindowIdentity | undefined {
  const sessionId = env[SESSION_ID_ENV]?.trim();
  if (sessionId === undefined || !SESSION_ID_RE.test(sessionId)) return undefined;
  const cwd = env[PROJECT_DIR_ENV]?.trim();
  return { sessionId, cwd: cwd !== undefined && cwd !== '' ? cwd : process.cwd() };
}

// ---------------------------------------------------------------------------
// What a read produces
// ---------------------------------------------------------------------------

/** One sub-agent Helm fanned out to, as its own transcript describes it. */
export interface HelmSubagent {
  /** From the filename: `agent-<id>.jsonl`. Unique within the window. */
  agentId: string;
  /** `Explore`, `general-purpose`, … — from the sibling `.meta.json`. */
  agentType?: string;
  /**
   * What Helm asked for, in Helm's words: *"Map AULP SDK and template APIs"*.
   *
   * The single most valuable field here, and the reason the `.meta.json` is read
   * at all rather than just the tokens. A row saying `agent-ad6c1d33f · 153.4k`
   * tells the captain that something spent their quota; a row saying what it was
   * asked to do tells them whether it should have been a task.
   */
  description?: string;
  tokens: TokenUsage;
  /** Epoch ms of the last record read from this sub-agent's transcript. */
  lastActivityAt?: number;
}

/** A Helm window's consumption, as of one moment, read from disk. */
export interface HelmWindowActivity {
  sessionId: string;
  cwd: string;
  /**
   * When this snapshot was taken. Every presentation of the numbers below is
   * required to carry it — see the module docstring.
   */
  observedAt: number;
  /**
   * The window's own turns: everything the captain sees Helm say and do.
   * EXCLUDES the sub-agents, which are separate files and separate rows.
   */
  own: TokenUsage;
  /** One per `subagents/agent-*.jsonl`, in the order the directory lists them. */
  subagents: HelmSubagent[];
  /** `own` plus every sub-agent — what the window has actually cost. */
  total: TokenUsage;
  /**
   * False when no transcript was found. The window may be brand new (no turn has
   * been taken, so no file exists yet) or long deleted; either way the numbers
   * above are all zero and a caller must not print them as a measurement.
   */
  transcriptFound: boolean;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Tokens are what this counts, so pricing is a formality.
 *
 * `readTranscript` requires a `price` function because a Crew's events carry a
 * dollar figure downstream. Nothing here does — the captain is on a subscription
 * and this module reports tokens only — so the real table is still used (rather
 * than a zero stub) purely so that a later caller which does want the list-price
 * equivalent gets the same number every other part of BlueSpace would give it.
 */
const price = (usage: TranscriptUsage, model: string | undefined): number =>
  priceUsage(model, usage).usd;

/**
 * Fold one transcript file's usage events into a {@link TokenUsage}.
 *
 * Returns zero counts for anything unreadable. `waitForFileMs: 0` throughout:
 * every path handed to this has either just been listed by `readdir` or come
 * back from `findTranscript`, so a file that is not there now is not a file that
 * is about to appear — waiting would park a `blue ps` for thirty seconds on a
 * dangling symlink to a deleted session.
 */
async function readUsageOf(file: string): Promise<{ tokens: TokenUsage; lastAt?: number }> {
  let tokens = noTokenUsage();
  let lastAt: number | undefined;
  try {
    for await (const event of readTranscript({
      path: file,
      price,
      follow: false,
      waitForFileMs: 0,
    })) {
      if (event.type !== 'usage') continue;
      tokens = addTokenUsage(tokens, event.model, {
        input: event.inputTokens,
        output: event.outputTokens,
        cacheRead: event.cacheReadTokens ?? 0,
        cacheCreation: event.cacheCreationTokens ?? 0,
      });
    }
  } catch {
    // See the module docstring: an unreadable transcript costs us its numbers,
    // never the command that asked for them.
    return { tokens };
  }
  // The reader normalizes away timestamps, so recency comes from the file rather
  // than from a record. It is the same question — "when did this last do
  // anything" — and mtime is the answer that survives a format change.
  try {
    lastAt = (await fs.stat(file)).mtimeMs;
  } catch {
    /* it was there a moment ago; not knowing when is not worth failing over */
  }
  return lastAt === undefined ? { tokens } : { tokens, lastAt };
}

/**
 * `{agentType, description, toolUseId, spawnDepth}`, written beside each
 * sub-agent transcript at spawn.
 *
 * Best-effort by design. This file is undocumented and is not load-bearing: a
 * sub-agent with no readable metadata still gets a row, still gets its tokens
 * counted, and is simply labelled by its id. Reporting a spend without a name is
 * far better than not reporting it.
 */
async function readAgentMeta(
  file: string,
): Promise<{ agentType?: string; description?: string }> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return {};
    const rec = raw as Record<string, unknown>;
    const out: { agentType?: string; description?: string } = {};
    if (typeof rec['agentType'] === 'string' && rec['agentType'] !== '') {
      out.agentType = rec['agentType'];
    }
    if (typeof rec['description'] === 'string' && rec['description'] !== '') {
      out.description = rec['description'];
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Read everything one Helm window has spent, as of now.
 *
 * `root` overrides the transcript root so a test can build a tree instead of
 * needing a real `~/.claude`; `now` is injectable for the same reason.
 *
 * THE SUB-AGENT DIRECTORY IS DERIVED, NOT SEARCHED. `<project-dir>/<session-uuid>/
 * subagents/` sits beside the session transcript, and the session transcript has
 * already been FOUND — so the directory is anchored to a path we hold rather
 * than recomputed from a cwd, whose encoding into a project-directory name is
 * lossy and has no inverse. This is the same derivation the Crew adapter uses
 * for the same reason.
 */
export async function readHelmWindowActivity(
  window: HelmWindowIdentity,
  opts: { root?: string; now?: number } = {},
): Promise<HelmWindowActivity> {
  const observedAt = opts.now ?? Date.now();
  const base: HelmWindowActivity = {
    sessionId: window.sessionId,
    cwd: window.cwd,
    observedAt,
    own: noTokenUsage(),
    subagents: [],
    total: noTokenUsage(),
    transcriptFound: false,
  };

  let main: string | undefined;
  try {
    const findOpts = opts.root === undefined ? undefined : { root: opts.root };
    main = await findTranscript(window.sessionId, findOpts);
  } catch {
    // Only thrown for a malformed session id, which `helmWindowFromEnv` already
    // refuses to produce — but this is read back from a log written by an older
    // build, so it is handled rather than trusted.
    return base;
  }
  if (main === undefined) return base;

  const own = (await readUsageOf(main)).tokens;

  const dir = path.join(path.dirname(main), window.sessionId, 'subagents');
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    /* delegated nothing — much the commonest case */
  }
  names.sort();

  const subagents: HelmSubagent[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const { tokens, lastAt } = await readUsageOf(file);
    const meta = await readAgentMeta(path.join(dir, `${name.slice(0, -'.jsonl'.length)}.meta.json`));
    subagents.push({
      agentId: name.replace(/^agent-/, '').slice(0, -'.jsonl'.length),
      ...meta,
      tokens,
      ...(lastAt === undefined ? {} : { lastActivityAt: lastAt }),
    });
  }

  let total = own;
  for (const agent of subagents) {
    for (const [model, counts] of Object.entries(agent.tokens.byModel)) {
      total = addTokenUsage(total, model, counts);
    }
  }

  return { ...base, own, subagents, total, transcriptFound: true };
}

/**
 * Read several windows, newest first, dropping the ones that left no trace.
 *
 * A window with no transcript is dropped rather than shown as a zero row: the
 * captain closing a window does not remove its `helm.window_opened` event (the
 * log is append-only and this module has no way to observe an exit), so the
 * alternative is a screen that accumulates one empty row per `bluespace` they
 * ever ran.
 */
export async function readHelmWindows(
  windows: readonly HelmWindowIdentity[],
  opts: { root?: string; now?: number } = {},
): Promise<HelmWindowActivity[]> {
  const out: HelmWindowActivity[] = [];
  for (const w of windows) {
    const activity = await readHelmWindowActivity(w, opts);
    if (activity.transcriptFound && totalTokens(activity.total.totals) > 0) out.push(activity);
  }
  return out;
}
