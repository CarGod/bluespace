/**
 * Helm's own fan-out, made visible.
 *
 * THE BUG THESE TESTS ARE ABOUT. The captain asked for a template upgrade; Helm
 * launched two `Agent` sub-agents to survey the repositories; they spent 153.4k
 * and 128.5k tokens in two minutes; `blue ps` showed nothing and the Starmap
 * said "Nothing needs you · 0 crew working" the whole time. Every other consumer
 * in BlueSpace is a process it starts and watches. Helm is the one it does not,
 * and it was therefore the one spender outside a token-accounting layer built
 * specifically because dollars were the wrong unit.
 *
 * The fixtures below are transcript trees on disk, in the layout Claude Code
 * actually writes — `<projects>/<encoded-cwd>/<session>.jsonl` with sub-agents
 * in `<projects>/<encoded-cwd>/<session>/subagents/agent-<id>.jsonl` and a
 * sibling `.meta.json`. That layout is measured, not assumed: it is what
 * `docs/compliance.md` records and what `src/adapters/claude-cli.ts` already
 * drains for a delegating Crew.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { Blackbox, projectHelmWindows } from '../src/blackbox/index.js';
import { PS_HELM_WINDOW_LIMIT, helmWindowsInView } from '../src/cli/ps.js';
import {
  SESSION_ID_ENV,
  helmWindowFromEnv,
  readHelmWindowActivity,
  readHelmWindows,
} from '../src/helm/index.js';
import { registerHelmWindow } from '../src/mcp/index.js';
import { totalTokens } from '../src/types/domain.js';

// ---------------------------------------------------------------------------
// A transcript tree on disk
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'blue-helm-'));
  tmpDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tmpDirs) await fs.rm(dir, { recursive: true, force: true });
});

const SESSION = '11111111-2222-3333-4444-555555555555';

/** One assistant record, in the shape the reader parses usage out of. */
function record(id: string, model: string, output: number, input = 0): string {
  return `${JSON.stringify({
    type: 'assistant',
    sessionId: SESSION,
    message: {
      id,
      model,
      content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0 },
      stop_reason: 'end_turn',
    },
  })}\n`;
}

interface AgentFixture {
  id: string;
  output: number;
  agentType?: string;
  description?: string;
  /** Omit the `.meta.json` entirely — an undocumented file we do not control. */
  noMeta?: boolean;
}

/**
 * Build `<root>/<project>/<session>.jsonl` plus its sub-agents, and return the
 * transcript root to search from.
 */
async function tree(opts: {
  session?: string;
  ownOutput?: number;
  agents?: AgentFixture[];
}): Promise<string> {
  const session = opts.session ?? SESSION;
  const root = await tmp();
  const project = path.join(root, '-Users-someone-aulp');
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(
    path.join(project, `${session}.jsonl`),
    record('own_1', 'claude-opus-5', opts.ownOutput ?? 100),
  );

  for (const agent of opts.agents ?? []) {
    const dir = path.join(project, session, 'subagents');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `agent-${agent.id}.jsonl`),
      record(`sub_${agent.id}`, 'claude-opus-5', agent.output),
    );
    if (agent.noMeta !== true) {
      await fs.writeFile(
        path.join(dir, `agent-${agent.id}.meta.json`),
        JSON.stringify({
          agentType: agent.agentType ?? 'Explore',
          description: agent.description ?? 'survey the repos',
          toolUseId: `toolu_${agent.id}`,
          spawnDepth: 1,
        }),
      );
    }
  }
  return root;
}

// ---------------------------------------------------------------------------
// Knowing which window this is
// ---------------------------------------------------------------------------

describe('helmWindowFromEnv', () => {
  it('reads the session id the harness hands its MCP servers', () => {
    // MEASURED on 2.1.224: an MCP server registered through `--mcp-config` and
    // replaced with a stub that dumped its own environment received
    // CLAUDE_CODE_SESSION_ID set to the LAUNCHING window's id — verified by
    // launching from a shell whose own value was a different uuid.
    //
    // This is why the launcher does not pass `--session-id`: that flag cannot be
    // combined with --continue or --resume ("Error: --session-id can only be
    // used with --continue or --resume if --fork-session is also specified"), so
    // minting the id there would have broken `bluespace --continue` outright.
    const w = helmWindowFromEnv({
      [SESSION_ID_ENV]: SESSION,
      CLAUDE_PROJECT_DIR: '/Users/someone/aulp',
    });
    expect(w).toEqual({ sessionId: SESSION, cwd: '/Users/someone/aulp' });
  });

  it('is undefined outside a window, which is an ordinary answer and not a fault', () => {
    // `blue mcp` also runs under other clients, and a captain may run it by
    // hand. Registering a window then would put a row in `blue ps` pointing at a
    // session id that names no transcript anywhere.
    expect(helmWindowFromEnv({})).toBeUndefined();
  });

  it('refuses anything that is not a session id, because it becomes a filename', () => {
    expect(helmWindowFromEnv({ [SESSION_ID_ENV]: '../../etc/passwd' })).toBeUndefined();
    expect(helmWindowFromEnv({ [SESSION_ID_ENV]: 'not-a-uuid' })).toBeUndefined();
  });
});

describe('registerHelmWindow', () => {
  it('writes the one fact that makes the spend findable afterwards', async () => {
    const dir = await tmp();
    const blackbox = Blackbox.open(path.join(dir, 'blackbox.db'));
    try {
      expect(
        registerHelmWindow(blackbox, {
          [SESSION_ID_ENV]: SESSION,
          CLAUDE_PROJECT_DIR: '/Users/someone/aulp',
        }),
      ).toBe(true);
      const windows = projectHelmWindows(blackbox.read());
      expect(windows).toHaveLength(1);
      expect(windows[0]?.sessionId).toBe(SESSION);
      expect(windows[0]?.cwd).toBe('/Users/someone/aulp');
    } finally {
      blackbox.close();
    }
  });

  it('writes nothing, and does not complain, when this is not a Helm window', async () => {
    const dir = await tmp();
    const blackbox = Blackbox.open(path.join(dir, 'blackbox.db'));
    try {
      expect(registerHelmWindow(blackbox, {})).toBe(false);
      expect(projectHelmWindows(blackbox.read())).toEqual([]);
    } finally {
      blackbox.close();
    }
  });
});

describe('projectHelmWindows', () => {
  it('keeps one row per window however many times its MCP server restarted', async () => {
    // The harness restarts an MCP server on `/mcp reconnect` and on a config
    // reload, so one window can register several times. Two rows would
    // double-count the same transcript the moment a caller summed them.
    const dir = await tmp();
    const blackbox = Blackbox.open(path.join(dir, 'blackbox.db'));
    try {
      const env = { [SESSION_ID_ENV]: SESSION, CLAUDE_PROJECT_DIR: '/a' };
      registerHelmWindow(blackbox, env);
      registerHelmWindow(blackbox, { ...env, CLAUDE_PROJECT_DIR: '/b' });
      const windows = projectHelmWindows(blackbox.read());
      expect(windows).toHaveLength(1);
      // The newest registration wins: it is where the window is standing now.
      expect(windows[0]?.cwd).toBe('/b');
    } finally {
      blackbox.close();
    }
  });
});

describe('helmWindowsInView', () => {
  const now = 1_000_000_000_000;
  const day = 24 * 60 * 60 * 1000;
  const at = (openedAt: number, sessionId = String(openedAt)): { sessionId: string; cwd: string; openedAt: number } => ({
    sessionId,
    cwd: '/x',
    openedAt,
  });

  it('drops windows older than the horizon the task table already uses', () => {
    const kept = helmWindowsInView([at(now - 60_000), at(now - 2 * day)], { now });
    expect(kept.map((w) => w.openedAt)).toEqual([now - 60_000]);
  });

  it('lifts the horizon on --all but keeps the ceiling on work', () => {
    // `--all` exists so a captain can see history the default hides. It does not
    // exist to make `blue ps` walk three hundred transcripts.
    const many = Array.from({ length: PS_HELM_WINDOW_LIMIT + 4 }, (_, i) =>
      at(now - (i + 1) * 5 * day, `s${i}`),
    );
    expect(helmWindowsInView(many, { now })).toHaveLength(0);
    expect(helmWindowsInView(many, { now, all: true })).toHaveLength(PS_HELM_WINDOW_LIMIT);
  });

  it('reads newest first, so the window the captain is sitting in is the first row', () => {
    const kept = helmWindowsInView([at(now - 3000), at(now - 1000), at(now - 2000)], { now });
    expect(kept.map((w) => w.openedAt)).toEqual([now - 1000, now - 2000, now - 3000]);
  });
});

// ---------------------------------------------------------------------------
// Reading what the window spent
// ---------------------------------------------------------------------------

describe('readHelmWindowActivity', () => {
  it('counts the window and every sub-agent, and keeps them apart', async () => {
    // The incident, to scale: two sub-agents that between them cost more than
    // many whole tasks, against a fleet that showed nothing running.
    const root = await tree({
      ownOutput: 500,
      agents: [
        { id: 'aaa', output: 153_400, description: 'Survey the template repos' },
        { id: 'bbb', output: 128_500, description: 'Map the SDK surface' },
      ],
    });

    const a = await readHelmWindowActivity({ sessionId: SESSION, cwd: '/Users/someone/aulp' }, { root });

    expect(a.transcriptFound).toBe(true);
    // The window's own turns EXCLUDE the sub-agents: they are separate files and
    // separate rows, and a captain reading one number wants to know which.
    expect(totalTokens(a.own.totals)).toBe(500);
    expect(a.subagents.map((s) => totalTokens(s.tokens.totals))).toEqual([153_400, 128_500]);
    expect(totalTokens(a.total.totals)).toBe(500 + 153_400 + 128_500);
  });

  it('labels each sub-agent with what Helm actually asked it to do', async () => {
    // The single most valuable field: `agent-ad6c1d33f · 153.4k` says something
    // spent the captain's quota. "Survey the template repos" says whether it
    // should have been a task.
    const root = await tree({
      agents: [{ id: 'aaa', agentType: 'Explore', description: 'Survey the template repos' }].map(
        (a) => ({ ...a, output: 10 }),
      ),
    });
    const a = await readHelmWindowActivity({ sessionId: SESSION, cwd: '/x' }, { root });
    expect(a.subagents[0]?.agentType).toBe('Explore');
    expect(a.subagents[0]?.description).toBe('Survey the template repos');
    expect(a.subagents[0]?.agentId).toBe('aaa');
  });

  it('still bills a sub-agent whose metadata it cannot read', async () => {
    // `.meta.json` is undocumented and not load-bearing. Reporting a spend
    // without a name beats not reporting it.
    const root = await tree({ agents: [{ id: 'ccc', output: 42, noMeta: true }] });
    const a = await readHelmWindowActivity({ sessionId: SESSION, cwd: '/x' }, { root });
    expect(a.subagents).toHaveLength(1);
    expect(a.subagents[0]?.description).toBeUndefined();
    expect(totalTokens(a.subagents[0]?.tokens.totals ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 })).toBe(42);
  });

  it('reports a window that has taken no turn as unmeasured, not as zero', async () => {
    // A window opens before its transcript exists. Zeros presented as a
    // measurement are how the original bug read to the captain.
    const root = await tmp();
    const a = await readHelmWindowActivity({ sessionId: SESSION, cwd: '/x' }, { root });
    expect(a.transcriptFound).toBe(false);
    expect(totalTokens(a.total.totals)).toBe(0);
  });

  it('handles a window that delegated nothing, which is the common case', async () => {
    const root = await tree({ ownOutput: 7 });
    const a = await readHelmWindowActivity({ sessionId: SESSION, cwd: '/x' }, { root });
    expect(a.subagents).toEqual([]);
    expect(totalTokens(a.total.totals)).toBe(7);
  });

  it('stamps every read with when it was taken, because it is never live', async () => {
    // There is no process here watching that window. A sub-agent that started a
    // second ago has written nothing yet and is genuinely absent from this list,
    // so every presentation of these numbers has to carry an "as of".
    const root = await tree({ ownOutput: 1 });
    const a = await readHelmWindowActivity({ sessionId: SESSION, cwd: '/x' }, { root, now: 12_345 });
    expect(a.observedAt).toBe(12_345);
  });
});

describe('readHelmWindows', () => {
  it('drops the windows that left no trace rather than showing empty rows', async () => {
    // The log is append-only and nothing observes a window closing, so its row
    // survives forever. Without this the screen accumulates one empty line per
    // `bluespace` the captain has ever run.
    const root = await tree({ ownOutput: 9 });
    const rows = await readHelmWindows(
      [
        { sessionId: SESSION, cwd: '/x' },
        { sessionId: '99999999-9999-4999-8999-999999999999', cwd: '/gone' },
      ],
      { root },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe(SESSION);
  });
});
