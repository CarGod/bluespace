/**
 * `bluespace` launcher tests.
 *
 * Two halves, matching the two ways this thing can be wrong.
 *
 * THE ARGV IS ASSERTED ELEMENT BY ELEMENT, because the order is load-bearing and
 * invisible: `--mcp-config` and `--add-dir` are variadic and will eat the
 * captain's prompt if either is the last flag injected. That is measured against
 * the real CLI in `docs/compliance.md`; here it is frozen so a tidy-up cannot
 * quietly undo it.
 *
 * THE LAUNCH IS A REAL CHILD PROCESS. `runLauncher` spawns, waits, and reports —
 * so a stand-in `claude` (a node script that records its argv and exits with
 * whatever code it was told to) proves the things a unit test of a pure function
 * cannot: that arguments survive the process boundary, and that an exit code
 * comes back rather than being flattened into 0. What is never launched is the
 * real `claude`: it costs money and opens a TUI (same rule as
 * tests/adapter-claude-cli.test.ts).
 */

import { promises as fs } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  HELM_ALLOWED_TOOLS,
  HELM_DENIED_TOOLS,
  MissingPersonaError,
  WAKE_PROMPT,
  buildHelmArgv,
  deniedTools,
  helmMcpConfig,
  helmSettingsJson,
  helmSystemPrompt,
  runLauncher,
  strictMcpRequested,
  trustNotice,
  ultracodeBlockedBy,
  ultracodeNotice,
  unclampedRequested,
  workspaceTrusted,
  wakePrompt,
} from '../src/cli/bluespace.js';
import { HELM_TOOL_NAMES } from '../src/agents/helm/index.js';
import {
  DEFAULT_HELM_POSTURE,
  MIRROR_VOICE,
  defaultConfig,
  resolveCaptainVoice,
} from '../src/config/index.js';

// ---------------------------------------------------------------------------
// A `claude` that costs nothing
// ---------------------------------------------------------------------------

/**
 * Records the argv it was handed, then exits with `BLUE_FAKE_EXIT`.
 *
 * It reads nothing and prints nothing: the launcher must not depend on what the
 * window does, only on the fact that it ended and how.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.BLUE_ARGV_OUT, JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.BLUE_FAKE_EXIT ?? '0'));
`;

const tmpDirs: string[] = [];

afterAll(async () => {
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true });
});

/**
 * `runLauncher` reads the captain's config to find a pinned language, and
 * `loadConfig` takes its data directory from the process environment. Without
 * this, a developer who has pinned `language` in their own `~/.bluespace` gets
 * different results from CI — the same hazard `tests/setup.ts` clears
 * `CLAUDE_CLI_PATH` and `ANTHROPIC_API_KEY` for.
 */
const originalHome = process.env['BLUESPACE_HOME'];
let sandboxHome: string;

beforeEach(async () => {
  sandboxHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bluespace-home-')));
  tmpDirs.push(sandboxHome);
  process.env['BLUESPACE_HOME'] = sandboxHome;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env['BLUESPACE_HOME'];
  else process.env['BLUESPACE_HOME'] = originalHome;
});

/** Pin a language in the sandbox config, the way `blue config set` would. */
async function pinLanguage(language: string): Promise<void> {
  await fs.writeFile(path.join(sandboxHome, 'config.json'), JSON.stringify({ language }), 'utf8');
}

interface Harness {
  root: string;
  fakeClaude: string;
  argvOut: string;
  entry: string;
  env: NodeJS.ProcessEnv;
  argv(): Promise<string[]>;
}

async function harness(opts: { persona?: string; env?: Record<string, string> } = {}): Promise<Harness> {
  // realpath: on macOS tmpdir is a symlink, and the launcher compares realpaths.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bluespace-launch-')));
  tmpDirs.push(root);

  if (opts.persona !== undefined) await fs.writeFile(path.join(root, 'CLAUDE.md'), opts.persona);

  const fakeClaude = path.join(root, 'fake-claude.mjs');
  await fs.writeFile(fakeClaude, FAKE_CLAUDE, { mode: 0o755 });

  const argvOut = path.join(root, 'argv.json');
  const entry = path.join(root, 'dist', 'cli', 'index.js');

  return {
    root,
    fakeClaude,
    argvOut,
    entry,
    env: {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      CLAUDE_CLI_PATH: fakeClaude,
      BLUE_ARGV_OUT: argvOut,
      ...opts.env,
    },
    async argv(): Promise<string[]> {
      return JSON.parse(await fs.readFile(argvOut, 'utf8')) as string[];
    },
  };
}

/** Index of a flag's value, asserting the flag is present exactly once. */
function valueOf(argv: readonly string[], flag: string): string {
  const at = argv.indexOf(flag);
  expect(at, `${flag} missing from ${JSON.stringify(argv)}`).toBeGreaterThanOrEqual(0);
  expect(argv.lastIndexOf(flag), `${flag} appears twice`).toBe(at);
  const v = argv[at + 1];
  expect(v, `${flag} has no value`).toBeDefined();
  return v as string;
}

// ---------------------------------------------------------------------------
// The argv
// ---------------------------------------------------------------------------

const BASE = {
  claudePath: '/usr/local/bin/claude',
  mcpConfigJson: '{"mcpServers":{}}',
  root: '/opt/bluespace',
  systemPromptAppend: '# Helm\nrules',
  deniedTools: ['Bash', 'Edit'],
  allowedTools: ['mcp__bluespace__list_tasks'],
};

/** Every flag the launcher injects that swallows following non-flag tokens. */
const VARIADIC_FLAGS = ['--mcp-config', '--add-dir', '--disallowedTools', '--allowedTools'] as const;

describe('buildHelmArgv', () => {
  it('injects the tools, the contract, the install root and the clamp — and nothing else', () => {
    const argv = buildHelmArgv({ ...BASE, captainArgs: [], strictMcp: false });

    expect(argv).toEqual([
      '/usr/local/bin/claude',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--add-dir',
      '/opt/bluespace',
      '--disallowedTools',
      'Bash,Edit',
      '--allowedTools',
      'mcp__bluespace__list_tasks',
      '--append-system-prompt',
      '# Helm\nrules',
    ]);
  });

  it('ends its own flags with a single-value one, so a variadic cannot eat the prompt', () => {
    // The failure this prevents, measured on 2.1.223 (docs/compliance.md):
    //   claude -p --add-dir /dir "reply OK"  -> the prompt is read as a directory.
    // Anything of the captain's, and the opening turn, must therefore follow a
    // flag that takes exactly one value.
    for (const strictMcp of [false, true]) {
      const argv = buildHelmArgv({ ...BASE, captainArgs: [], strictMcp });
      const last = argv[argv.length - 2];
      expect(last, 'the last injected flag must take exactly one value').toBe('--append-system-prompt');
      // And the variadic ones are never at the end.
      for (const flag of VARIADIC_FLAGS) {
        expect(argv.indexOf(flag)).toBeLessThan(argv.indexOf('--append-system-prompt'));
      }
    }
  });

  it('never lets a variadic flag sit where the next token would be swallowed', () => {
    // THE FREEZE. The rule is not "--append-system-prompt is last" — that is one
    // way to satisfy it. The rule is that nothing the captain typed, and nothing
    // BlueSpace appends, may land directly behind a flag that takes `<x...>`.
    //
    // It is frozen structurally rather than by comparing to a golden argv so it
    // keeps holding when a flag is added: whatever follows a variadic must be
    // another flag, and a flag is what terminates the variadic above it.
    //
    // Why this matters more than it looks: under `-p` a swallowed prompt is a
    // loud error, but the Helm window is interactive, and there it fails
    // SILENTLY — the composer opens empty, no turn runs, nothing is written to
    // the transcript. That is not a bug anyone finds by reading the diff.
    const cases: Array<{ name: string; input: Parameters<typeof buildHelmArgv>[0] }> = [
      { name: 'bare window', input: { ...BASE, captainArgs: [], strictMcp: false } },
      { name: 'strict mcp', input: { ...BASE, captainArgs: [], strictMcp: true } },
      { name: 'unclamped', input: { ...BASE, deniedTools: [], captainArgs: [], strictMcp: false } },
      {
        name: 'no allow list',
        input: { ...BASE, allowedTools: [], captainArgs: [], strictMcp: false },
      },
      {
        name: 'full lists',
        input: {
          ...BASE,
          deniedTools: HELM_DENIED_TOOLS,
          allowedTools: HELM_ALLOWED_TOOLS,
          captainArgs: [],
          strictMcp: true,
        },
      },
      {
        name: 'wake sweep',
        input: { ...BASE, captainArgs: [], strictMcp: false, openingPrompt: WAKE_PROMPT },
      },
      {
        name: 'captain’s own argv',
        input: { ...BASE, captainArgs: ['--continue', 'ship it'], strictMcp: false },
      },
    ];

    for (const { name, input } of cases) {
      const argv = buildHelmArgv(input);
      const injectedEnd = argv.indexOf('--append-system-prompt') + 2;

      for (const flag of VARIADIC_FLAGS) {
        const at = argv.indexOf(flag);
        if (at < 0) continue;
        // Exactly one value, then a flag. Anything else and the token after the
        // value is read as a second directory / config / tool name.
        const after = argv[at + 2];
        expect(after, `${name}: nothing follows ${flag}’s value`).toBeDefined();
        expect(after?.startsWith('-'), `${name}: ${flag} is followed by \`${after}\`, which it would eat`).toBe(
          true,
        );
      }

      // And everything BlueSpace did not inject sits past the last injected flag.
      const tail = argv.slice(injectedEnd);
      for (const flag of VARIADIC_FLAGS) {
        expect(tail, `${name}: ${flag} escaped into the captain’s half of the argv`).not.toContain(flag);
      }
    }
  });

  it('passes the captain’s arguments through verbatim, in order, after its own', () => {
    const captainArgs = ['--model', 'opus', '--continue', 'ship the refunds fix'];
    const argv = buildHelmArgv({ ...BASE, captainArgs, strictMcp: false });

    expect(argv.slice(-captainArgs.length)).toEqual(captainArgs);
    expect(argv.indexOf('--model')).toBeGreaterThan(argv.indexOf('--append-system-prompt'));
  });

  it('adds --strict-mcp-config only when asked, as a bare flag that closes the variadic', () => {
    expect(buildHelmArgv({ ...BASE, captainArgs: [], strictMcp: false })).not.toContain(
      '--strict-mcp-config',
    );

    const strict = buildHelmArgv({ ...BASE, captainArgs: [], strictMcp: true });
    // Directly after the config value: a bare flag is what terminates
    // `--mcp-config <configs...>`, so this position is deliberate.
    expect(strict.indexOf('--strict-mcp-config')).toBe(strict.indexOf('--mcp-config') + 2);
  });

  it('passes the deny list as ONE comma-joined token', () => {
    const argv = buildHelmArgv({ ...BASE, deniedTools: HELM_DENIED_TOOLS, captainArgs: [], strictMcp: false });
    // `--disallowedTools` takes comma or space separated names (measured on
    // 2.1.223, both forms). One token is chosen so the whole clamp is a single
    // argv element — which is what lets the ordering test above reason about it.
    expect(valueOf(argv, '--disallowedTools')).toBe(HELM_DENIED_TOOLS.join(','));
    expect(argv.filter((a) => a === '--disallowedTools')).toHaveLength(1);
  });

  it('omits the flag entirely when unclamped, rather than passing an empty value', () => {
    // `--disallowedTools ""` would leave a variadic with nothing of its own to
    // read, and the next token — the captain's prompt — is what it would take.
    const argv = buildHelmArgv({ ...BASE, deniedTools: [], captainArgs: [], strictMcp: false });
    expect(argv).not.toContain('--disallowedTools');
    expect(argv).not.toContain('');
  });

  it('passes the allow list as ONE comma-joined token, and omits it when empty', () => {
    const argv = buildHelmArgv({
      ...BASE,
      allowedTools: HELM_ALLOWED_TOOLS,
      captainArgs: [],
      strictMcp: false,
    });
    expect(valueOf(argv, '--allowedTools')).toBe(HELM_ALLOWED_TOOLS.join(','));

    const none = buildHelmArgv({ ...BASE, allowedTools: [], captainArgs: [], strictMcp: false });
    expect(none).not.toContain('--allowedTools');
    expect(none).not.toContain('');
  });

  it('puts the opening prompt last, where a positional is read as a prompt', () => {
    const argv = buildHelmArgv({ ...BASE, captainArgs: [], strictMcp: false, openingPrompt: WAKE_PROMPT });
    expect(argv[argv.length - 1]).toBe(WAKE_PROMPT);
  });

  it('refuses to append an opening prompt behind the captain’s own arguments', () => {
    // `bluespace --add-dir /x` plus our prompt would make the prompt a second
    // directory. The caller only offers one when the captain typed nothing;
    // being handed both is a bug, and a bug is not something to launch through.
    expect(() =>
      buildHelmArgv({ ...BASE, captainArgs: ['--add-dir', '/x'], strictMcp: false, openingPrompt: 'hi' }),
    ).toThrow(/refusing/i);
  });
});

// ---------------------------------------------------------------------------
// The clamp
// ---------------------------------------------------------------------------

describe('HELM_DENIED_TOOLS', () => {
  it('denies every way to do the captain’s work in this window', () => {
    // The observed failure: Helm answered "check whether this bug is real and
    // fix it" by running ls/grep/sed over the captain's repository. No task row,
    // no worktree, no Sentinel, no ceiling, nothing in `blue ps`.
    for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit']) {
      expect(HELM_DENIED_TOOLS, `${tool} would let Helm do a Crew's job itself`).toContain(tool);
    }
  });

  it('denies the shell under every name, including the one a sub-agent is offered', () => {
    // `Monitor` runs a shell command as a background process. It is the one that
    // matters most now that sub-agents are allowed: the probe that measured
    // propagation saw a sub-agent offered exactly `[Monitor, WebFetch]` when it
    // went looking for a shell. Denying Bash and leaving that reachable would be
    // theatre.
    expect(HELM_DENIED_TOOLS).toContain('Bash');
    expect(HELM_DENIED_TOOLS, 'Monitor is Bash through a second door').toContain('Monitor');
  });

  it('denies the delegation this window could not see the end of', () => {
    // Not "delegation" as a category any more — `Agent` is allowed. These three
    // are the ones whose workers this window does not clamp, does not wait on,
    // or cannot reach: a workflow's own scheduler, a routine running on
    // claude.ai, and a session that has moved itself into a new worktree of the
    // captain's repository.
    for (const tool of ['Workflow', 'RemoteTrigger', 'EnterWorktree']) {
      expect(HELM_DENIED_TOOLS, `${tool} creates work the Blackbox never sees`).toContain(tool);
    }
  });

  it('allows the subagent launcher under BOTH of its names, or neither', () => {
    // `Agent` is 2.1.223's name and `Task` is the older one, still accepted.
    // They are ONE lever with two spellings, so a list that splits them either
    // does nothing (on a build that uses the other name) or denies exactly what
    // it meant to allow. Whichever way a future edit goes, it must go together.
    const agent = HELM_DENIED_TOOLS.includes('Agent');
    const task = HELM_DENIED_TOOLS.includes('Task');
    expect(agent, 'Agent and Task are the same tool — deny both or neither').toBe(task);
    // And today: allowed. Helm fans out its own bookkeeping (CLAUDE.md), and
    // what a sub-agent may do about the captain's code is a rule, not a flag —
    // what it CAN do is already this list, which it inherits.
    expect(agent).toBe(false);
  });

  it('keeps everything intake and judgement need', () => {
    // The reason this is `--disallowedTools` and not `--tools`: measured on
    // 2.1.223, `--tools Read,Glob,Grep` also strips every mcp__* tool, which
    // takes away Helm's own levers. A deny list cannot do that by construction —
    // but it CAN be extended carelessly, which is what this freezes.
    for (const tool of ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Skill']) {
      expect(HELM_DENIED_TOOLS, `${tool} is how Helm routes a request and writes a brief`).not.toContain(
        tool,
      );
    }
    // Nothing namespaced may ever appear here. Helm without `mcp__bluespace__*`
    // is not a safer Helm, it is a model talking about a fleet it cannot see.
    expect(HELM_DENIED_TOOLS.filter((t) => t.startsWith('mcp__'))).toEqual([]);
  });

  it('still denies every way to produce a diff, which is what makes sub-agents safe', () => {
    // The load-bearing claim of the whole change: `--disallowedTools` propagates
    // to sub-agents (measured on 2.1.223 — a sub-agent told to `echo … >
    // proof.txt` found no shell tool and wrote nothing). So allowing `Agent` is
    // only safe while this list still contains everything that writes. If a
    // future edit takes Edit or Write out of it, the fan-out rule in CLAUDE.md
    // stops being backed by anything.
    for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit']) {
      expect(HELM_DENIED_TOOLS, `a sub-agent inheriting this list must not have ${tool}`).toContain(
        tool,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The allow list
// ---------------------------------------------------------------------------

describe('HELM_ALLOWED_TOOLS', () => {
  it('pre-approves exactly the tools this launcher installed, and nothing else', () => {
    // A first-run window used to park forever: the wake sweep's first call is
    // `open_decisions`, an MCP tool the session had never seen, so Claude Code
    // asked — with nobody having typed anything yet.
    expect(HELM_ALLOWED_TOOLS).toContain('mcp__bluespace__open_decisions');
    expect(HELM_ALLOWED_TOOLS).toContain('mcp__bluespace__list_tasks');

    // Every entry is one of ours. Approving a built-in, or another server's
    // tool, would be BlueSpace choosing a permission posture over something it
    // did not install — the line src/cli/bluespace.ts draws at the top.
    for (const tool of HELM_ALLOWED_TOOLS) expect(tool.startsWith('mcp__bluespace__')).toBe(true);
    expect(HELM_ALLOWED_TOOLS).toHaveLength(HELM_TOOL_NAMES.length);
  });

  it('names every tool helmTools() actually serves', () => {
    // A tool added to helmTools() and forgotten here prompts on first use,
    // months later, in front of whoever calls it first. `helmTools()` throws on
    // the same disagreement; this is the half that runs without an orchestrator.
    for (const name of HELM_TOOL_NAMES) {
      expect(HELM_ALLOWED_TOOLS).toContain(`mcp__bluespace__${name}`);
    }
  });
});

describe('deniedTools', () => {
  it('clamps by default, and only the captain can undo it', () => {
    expect(deniedTools({})).toEqual(HELM_DENIED_TOOLS);
    expect(unclampedRequested({})).toBe(false);
    expect(unclampedRequested({ BLUESPACE_UNCLAMPED: '0' })).toBe(false);
    expect(unclampedRequested({ BLUESPACE_UNCLAMPED: '' })).toBe(false);

    for (const on of ['1', 'true', 'yes']) {
      expect(unclampedRequested({ BLUESPACE_UNCLAMPED: on })).toBe(true);
      expect(deniedTools({ BLUESPACE_UNCLAMPED: on })).toEqual([]);
    }
  });
});

describe('helmMcpConfig', () => {
  it('names the server `bluespace`, because that is the tool prefix CLAUDE.md promises', () => {
    const parsed = JSON.parse(helmMcpConfig('/opt/bluespace/dist/cli/index.js', '/usr/bin/node')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };

    expect(Object.keys(parsed.mcpServers)).toEqual(['bluespace']);
    // Rename the key and every `mcp__bluespace__*` in the persona points at
    // nothing — the tools are prefixed with the config key, not the server's
    // self-reported name.
    expect(parsed.mcpServers['bluespace']).toEqual({
      command: '/usr/bin/node',
      args: ['/opt/bluespace/dist/cli/index.js', 'mcp'],
    });
  });

  it('runs the entry file by path, not `blue` by name', async () => {
    const h = await harness({ persona: '# Helm' });
    const parsed = JSON.parse(helmMcpConfig(h.entry)) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    // A linked checkout or an odd package manager may not have put `blue` on
    // PATH, and an MCP server that fails to start gives the window a set of missing
    // tools and no explanation.
    expect(parsed.mcpServers['bluespace']?.args[0]).toBe(h.entry);
    expect(parsed.mcpServers['bluespace']?.command).toBe(process.execPath);
  });
});

describe('helmSystemPrompt', () => {
  it('carries CLAUDE.md verbatim rather than a second copy of the persona', async () => {
    const persona = '# Helm\n\n**`create_task` only enqueues.**\n';
    const h = await harness({ persona });

    const prompt = helmSystemPrompt(h.root);

    expect(prompt).toContain('**`create_task` only enqueues.**');
    // Editing CLAUDE.md must be enough to change Helm — see src/agents/helm/index.ts.
    expect(prompt.startsWith('# Helm')).toBe(true);
  });

  it('points at the skill on disk, since it is not installed as a skill anywhere', async () => {
    const h = await harness({ persona: '# Helm' });
    expect(helmSystemPrompt(h.root)).toContain(path.join(h.root, 'skills', 'bluespace', 'SKILL.md'));
  });

  it('refuses rather than opening a window with tools and no rules', async () => {
    const empty = await harness();
    expect(() => helmSystemPrompt(empty.root)).toThrow(MissingPersonaError);

    const blank = await harness({ persona: '   \n' });
    expect(() => helmSystemPrompt(blank.root)).toThrow(MissingPersonaError);
  });

  it('tells the window which tools it was actually denied, by name', async () => {
    const h = await harness({ persona: '# Helm' });
    const prompt = helmSystemPrompt(h.root, HELM_DENIED_TOOLS);

    for (const tool of HELM_DENIED_TOOLS) expect(prompt).toContain(tool);
    expect(prompt).toMatch(/enforced in this window, not requested/i);
    // A model that finds Bash missing with no explanation reports a broken tool
    // to the captain and asks them to fix it.
    expect(prompt).toMatch(/never report one as broken/i);
  });

  it('does not claim a clamp the unclamped window does not have', async () => {
    const h = await harness({ persona: '# Helm' });
    const prompt = helmSystemPrompt(h.root, []);

    // Saying "you have no Bash" to a window that has one teaches the model that
    // its system prompt is unreliable — a worse outcome than the missing rule.
    expect(prompt).not.toMatch(/enforced in this window/i);
    expect(prompt).toContain('BLUESPACE_UNCLAMPED=1');
    // The rule survives the enforcement being off; only who holds it changes.
    expect(prompt).toMatch(/no worktree, no\s+Sentinel/);
  });
});

// ---------------------------------------------------------------------------
// The captain's language
// ---------------------------------------------------------------------------

describe('wakePrompt', () => {
  it('says which language the REPLY is in, while staying an English instruction', () => {
    // The prompt is an instruction to the model, not copy the captain reads — so
    // it is not translated. What it must not do is stay silent about the answer:
    // the wake sweep is produced before the captain has typed anything for Helm
    // to mirror, and it is the exact turn that came back as English prose
    // wrapped around Chinese task titles.
    const zh = wakePrompt(resolveCaptainVoice('zh-CN', {}));

    expect(zh.startsWith(WAKE_PROMPT)).toBe(true);
    expect(zh).toContain('Write the reply in zh-CN');
    expect(zh).toContain('舰长');
    // …and the one thing that must NOT be translated with it.
    expect(zh).toMatch(/titles.*stay exactly as they are stored/i);
  });

  it('adds nothing when no language is known, rather than inventing English', () => {
    expect(wakePrompt(MIRROR_VOICE)).toBe(WAKE_PROMPT);
    expect(wakePrompt(resolveCaptainVoice(undefined, { LANG: 'C' }))).toBe(WAKE_PROMPT);
  });

  it('leads on what died, because that is what the sweep buried', () => {
    // Observed: the sweep opened with a paragraph about brief length and put two
    // dead tasks inside it. The rule lives in CLAUDE.md; this is the nudge in
    // the one turn BlueSpace itself writes.
    expect(WAKE_PROMPT).toMatch(/died|failed/i);
    expect(WAKE_PROMPT).toMatch(/before any account of why/i);
  });
});

describe('helmSystemPrompt: the captain’s language', () => {
  it('carries a pinned language as a standing instruction', async () => {
    const h = await harness({ persona: '# Helm' });
    const prompt = helmSystemPrompt(h.root, HELM_DENIED_TOOLS, resolveCaptainVoice('zh-CN', {}));

    expect(prompt).toContain('**zh-CN**');
    expect(prompt).toContain('**舰长**');
    expect(prompt).toContain('blue config set language zh-CN');
    expect(prompt).toMatch(/standing instruction rather than a guess/i);
  });

  it('marks a detected language as a guess, and says who wins when they disagree', async () => {
    const h = await harness({ persona: '# Helm' });
    const env = { LANG: 'zh_CN.UTF-8' };
    const prompt = helmSystemPrompt(h.root, HELM_DENIED_TOOLS, resolveCaptainVoice(undefined, env), env);

    // Where the guess came from, so the model treats it as the weak evidence it is.
    expect(prompt).toContain('LANG');
    expect(prompt).toMatch(/starting guess/i);
    // The captain's own writing outranks it, with no ceremony.
    expect(prompt).toMatch(/if they write to you in another\s+language, that is the answer/i);
    expect(prompt).toMatch(/without announcing the\s+switch/i);
    // The persistence decision: offered once, in a clause, never written for them.
    expect(prompt).toMatch(/once in the session/i);
    expect(prompt).toMatch(/not write it for them/i);
  });

  it('treats an undetectable locale as unknown, not as English', async () => {
    const h = await harness({ persona: '# Helm' });
    const prompt = helmSystemPrompt(h.root, HELM_DENIED_TOOLS, MIRROR_VOICE, { LANG: 'C' });

    expect(prompt).toMatch(/unknown, not as English/i);
    // It still has to open in something, and says which — an opening turn has
    // nothing to mirror yet.
    expect(prompt).toMatch(/Open in English/);
    expect(prompt).toMatch(/take their first message as the answer/i);
    expect(prompt).toContain('Captain');
    // No language was resolved, so none may be asserted.
    expect(prompt).not.toContain('Write to the captain in **');
  });

  it('lets the model overrule an address term it has no word for', async () => {
    const h = await harness({ persona: '# Helm' });
    const prompt = helmSystemPrompt(h.root, HELM_DENIED_TOOLS, resolveCaptainVoice('de-DE', {}));

    // The table holds one term because one term is what the captain gave us;
    // everything else is a translation the model does better than a lookup.
    expect(prompt).toContain('**Captain**');
    expect(prompt).toMatch(/addressed by rank, not by a string/i);
  });
});

describe('strictMcpRequested', () => {
  it('is off unless the captain turns it on', () => {
    // Default off is a decision, not an oversight: isolating the window removes
    // the captain's own MCP servers, which BlueSpace did not give them.
    expect(strictMcpRequested({})).toBe(false);
    expect(strictMcpRequested({ BLUESPACE_STRICT_MCP: '0' })).toBe(false);
    expect(strictMcpRequested({ BLUESPACE_STRICT_MCP: '' })).toBe(false);
    expect(strictMcpRequested({ BLUESPACE_STRICT_MCP: '1' })).toBe(true);
    expect(strictMcpRequested({ BLUESPACE_STRICT_MCP: 'true' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The launch — a real child process
// ---------------------------------------------------------------------------

describe('runLauncher', () => {
  it('launches the captain’s own claude with both halves of Helm, and opens on the wake sweep', async () => {
    const h = await harness({ persona: '# Helm\nrules go here' });

    const code = await runLauncher([], { root: h.root, entry: h.entry, env: h.env, stdio: 'ignore' });
    expect(code).toBe(0);

    const argv = await h.argv();
    expect(JSON.parse(valueOf(argv, '--mcp-config'))).toHaveProperty('mcpServers.bluespace');
    expect(valueOf(argv, '--append-system-prompt')).toContain('rules go here');
    expect(valueOf(argv, '--add-dir')).toBe(h.root);
    // Three halves now: the tools, the contract, and the boundary that stops the
    // contract from being a suggestion.
    expect(valueOf(argv, '--disallowedTools')).toBe(HELM_DENIED_TOOLS.join(','));
    // …and the tools it just installed, marked approved, so the wake sweep below
    // is a report rather than a permission dialog nobody is there to answer.
    expect(valueOf(argv, '--allowedTools')).toBe(HELM_ALLOWED_TOOLS.join(','));
    // The greeting is a turn, not chrome: BlueSpace cannot write into Claude
    // Code's welcome box, so a bare `bluespace` asks Helm for the wake sweep.
    expect(argv[argv.length - 1]).toBe(WAKE_PROMPT);
    expect(argv).not.toContain('--strict-mcp-config');
  });

  it('clamps the window by default, and says so in the same breath it clamps it', async () => {
    const h = await harness({ persona: '# Helm' });
    await runLauncher([], { root: h.root, entry: h.entry, env: h.env, stdio: 'ignore' });

    const argv = await h.argv();
    const denied = valueOf(argv, '--disallowedTools').split(',');
    expect(denied).toContain('Bash');
    expect(denied).toContain('Monitor');
    // The argv and the system prompt must agree: they are read by the same
    // model, and a disagreement between them is the model's to resolve.
    const prompt = valueOf(argv, '--append-system-prompt');
    for (const tool of denied) expect(prompt).toContain(tool);
    // And the prompt has to say the one thing the flag cannot: that a sub-agent
    // inherits this list. A model that assumes otherwise either refuses to fan
    // out at all, or fans out expecting a diff back.
    expect(prompt).toMatch(/propagates to every sub-agent/i);
  });

  it('hands the tools back on BLUESPACE_UNCLAMPED, and stops claiming otherwise', async () => {
    const h = await harness({ persona: '# Helm', env: { BLUESPACE_UNCLAMPED: '1' } });
    await runLauncher([], { root: h.root, entry: h.entry, env: h.env, stdio: 'ignore' });

    const argv = await h.argv();
    expect(argv).not.toContain('--disallowedTools');
    expect(valueOf(argv, '--append-system-prompt')).toContain('BLUESPACE_UNCLAMPED=1');
    // The allow list is not part of the clamp and does not come off with it: an
    // unclamped window has the same tools from the same server and should not
    // open on a dialog either.
    expect(valueOf(argv, '--allowedTools')).toBe(HELM_ALLOWED_TOOLS.join(','));
  });

  it('reproduces the window’s exit code instead of flattening it', async () => {
    const h = await harness({ persona: '# Helm', env: { BLUE_FAKE_EXIT: '7' } });
    expect(await runLauncher([], { root: h.root, entry: h.entry, env: h.env, stdio: 'ignore' })).toBe(7);
  });

  it('hands the captain’s arguments over and lets them own the first turn', async () => {
    const h = await harness({ persona: '# Helm' });

    const code = await runLauncher(['--model', 'opus', '开始吧'], {
      root: h.root,
      entry: h.entry,
      env: h.env,
      stdio: 'ignore',
    });
    expect(code).toBe(0);

    const argv = await h.argv();
    expect(argv.slice(-3)).toEqual(['--model', 'opus', '开始吧']);
    // Their prompt is the opening turn; ours would be a second positional and
    // would land inside `--model`'s neighbours besides.
    expect(argv).not.toContain(WAKE_PROMPT);
  });

  it('opens in the language the captain pinned, not the one the shell reports', async () => {
    // The pin is the captain's explicit word and outranks a locale that some
    // wrapper script set.
    const h = await harness({ persona: '# Helm', env: { LANG: 'en_US.UTF-8' } });
    await pinLanguage('zh-CN');

    await runLauncher([], { root: h.root, entry: h.entry, env: h.env, stdio: 'ignore' });

    const argv = await h.argv();
    expect(argv[argv.length - 1]).toContain('Write the reply in zh-CN');
    const prompt = valueOf(argv, '--append-system-prompt');
    expect(prompt).toContain('**zh-CN**');
    expect(prompt).toContain('**舰长**');
    // Both halves are read by the same model; a disagreement is the model's to
    // resolve, which is exactly what we do not want it spending a turn on.
    expect(prompt).not.toContain('**en-US**');
  });

  it('opens in the language the shell reports when nothing is pinned', async () => {
    const h = await harness({ persona: '# Helm', env: { LANG: 'zh_CN.UTF-8' } });

    await runLauncher([], { root: h.root, entry: h.entry, env: h.env, stdio: 'ignore' });

    const argv = await h.argv();
    expect(argv[argv.length - 1]).toContain('Write the reply in zh-CN');
    expect(valueOf(argv, '--append-system-prompt')).toMatch(/starting guess/i);
  });

  it('claims no language at all when the locale names none', async () => {
    // `LC_ALL=C` is not a request for English. The window opens with the plain
    // wake sweep and mirrors the captain from their first message.
    const h = await harness({ persona: '# Helm', env: { LC_ALL: 'C', LANG: 'zh_CN.UTF-8' } });

    await runLauncher([], { root: h.root, entry: h.entry, env: h.env, stdio: 'ignore' });

    const argv = await h.argv();
    expect(argv[argv.length - 1]).toBe(WAKE_PROMPT);
    expect(valueOf(argv, '--append-system-prompt')).toMatch(/unknown, not as English/i);
  });

  it('opens silently when asked', async () => {
    const h = await harness({ persona: '# Helm', env: { BLUESPACE_NO_WAKE: '1' } });
    await runLauncher([], { root: h.root, entry: h.entry, env: h.env, stdio: 'ignore' });
    expect(await h.argv()).not.toContain(WAKE_PROMPT);
  });

  it('isolates the window from the captain’s own MCP servers only on request', async () => {
    const h = await harness({ persona: '# Helm', env: { BLUESPACE_STRICT_MCP: '1' } });
    await runLauncher([], { root: h.root, entry: h.entry, env: h.env, stdio: 'ignore' });
    expect(await h.argv()).toContain('--strict-mcp-config');
  });

  it('does not launch at all when the operating contract is missing', async () => {
    const h = await harness(); // no CLAUDE.md

    const code = await runLauncher([], { root: h.root, entry: h.entry, env: h.env, stdio: 'ignore' });

    expect(code).toBe(1);
    // Nothing was spawned: a session with the fleet tools and none of the rules
    // is the state this launcher exists to prevent.
    await expect(fs.readFile(h.argvOut, 'utf8')).rejects.toThrow();
  });

  it('reports a claude that cannot be started, rather than dying without a reason', async () => {
    const h = await harness({ persona: '# Helm', env: { CLAUDE_CLI_PATH: path.join(os.tmpdir(), 'no-such-claude') } });
    expect(await runLauncher([], { root: h.root, entry: h.entry, env: h.env, stdio: 'ignore' })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Ultracode, and the posture
// ---------------------------------------------------------------------------

describe('helmSettingsJson', () => {
  it('carries the one key that turns ultracode on, and no others', () => {
    // `--settings` merges a whole settings object into the captain's window. A
    // second key here would be BlueSpace restyling a session it does not own,
    // which is the line the rest of this launcher is drawn along.
    const json = helmSettingsJson(true);
    expect(json).toBeDefined();
    expect(JSON.parse(json as string)).toEqual({ ultracode: true });
  });

  it('passes nothing at all when the captain turned it off', () => {
    // Not `{"ultracode":false}`: writing the key would still land a flagSettings
    // tier over their own settings for no reason.
    expect(helmSettingsJson(false)).toBeUndefined();
  });
});

describe('ultracodeBlockedBy', () => {
  it('is silent when nothing in this shell is in the way', () => {
    expect(ultracodeBlockedBy({})).toEqual([]);
    expect(ultracodeBlockedBy({ CLAUDE_CODE_DISABLE_WORKFLOWS: '' })).toEqual([]);
  });

  it('names the two variables measured to swallow ultracode without a word', () => {
    // Both measured on 2.1.224: the window opens, the ultracode badge is simply
    // absent, and nothing anywhere says why. See ULTRACODE_SETTINGS_KEY.
    expect(ultracodeBlockedBy({ CLAUDE_CODE_DISABLE_WORKFLOWS: '1' })).toEqual([
      expect.stringContaining('CLAUDE_CODE_DISABLE_WORKFLOWS=1'),
    ]);
    expect(ultracodeBlockedBy({ CLAUDE_CODE_EFFORT_LEVEL: 'medium' })).toEqual([
      expect.stringContaining('CLAUDE_CODE_EFFORT_LEVEL=medium'),
    ]);
    expect(
      ultracodeBlockedBy({ CLAUDE_CODE_DISABLE_WORKFLOWS: '1', CLAUDE_CODE_EFFORT_LEVEL: 'low' }),
    ).toHaveLength(2);
  });
});

describe('ultracodeNotice', () => {
  it('says nothing when there is nothing to say', () => {
    expect(ultracodeNotice([])).toBeUndefined();
  });

  it('hedges the claim it cannot check, and names the command that can', () => {
    const notice = ultracodeNotice(['CLAUDE_CODE_EFFORT_LEVEL=low (takes the session)']);
    expect(notice).toBeDefined();
    // It runs BEFORE the child exists, so it may not assert what the window did.
    expect(notice).toMatch(/may not take/i);
    expect(notice).not.toMatch(/did not|failed to/i);
    // And it must leave the captain with something to do about it.
    expect(notice).toContain('/effort ultracode');
    expect(notice).toContain('CLAUDE_CODE_EFFORT_LEVEL=low');
  });
});

describe('buildHelmArgv: the posture', () => {
  const posture = { ...BASE, captainArgs: [], strictMcp: false };

  it('passes both as single-value flags, before the prompt-safe tail', () => {
    const argv = buildHelmArgv({
      ...posture,
      settingsJson: '{"ultracode":true}',
      permissionMode: 'auto',
    });
    expect(valueOf(argv, '--settings')).toBe('{"ultracode":true}');
    expect(valueOf(argv, '--permission-mode')).toBe('auto');
    // The ordering rule is unchanged: the last injected flag takes exactly one
    // value, so nothing the captain typed can be swallowed by a variadic.
    expect(argv[argv.length - 2]).toBe('--append-system-prompt');
  });

  it('omits each one entirely when there is nothing to say', () => {
    const argv = buildHelmArgv(posture);
    expect(argv).not.toContain('--settings');
    expect(argv).not.toContain('--permission-mode');
  });

  it('never passes --effort, which would silently defeat ultracode', () => {
    // Measured on 2.1.224: `--effort high --settings '{"ultracode":true}'` opens
    // a window whose own footer reads `● high`. The launch pin wins and nothing
    // complains, so the only safe amount of --effort here is none.
    const argv = buildHelmArgv({
      ...posture,
      settingsJson: '{"ultracode":true}',
      permissionMode: 'auto',
    });
    expect(argv).not.toContain('--effort');
  });

  it('puts them ahead of the captain’s argv, so a flag of theirs wins', () => {
    // Both are single-value options rather than variadic, so a later one
    // replaces the earlier outright — which is the precedence that makes these
    // defaults rather than impositions.
    const argv = buildHelmArgv({
      ...posture,
      captainArgs: ['--permission-mode', 'plan'],
      permissionMode: 'auto',
    });
    expect(argv.indexOf('--permission-mode')).toBeLessThan(argv.lastIndexOf('--permission-mode'));
    expect(argv[argv.length - 1]).toBe('plan');
  });
});

describe('runLauncher: the captain’s ask, as the default', () => {
  it('opens at ultracode in a posture that does not ask', async () => {
    const h = await harness({ persona: '# Helm' });
    await runLauncher([], {
      root: h.root,
      entry: h.entry,
      env: h.env,
      stdio: 'ignore',
      config: defaultConfig(),
    });

    const argv = await h.argv();
    expect(JSON.parse(valueOf(argv, '--settings'))).toEqual({ ultracode: true });
    expect(valueOf(argv, '--permission-mode')).toBe('auto');
  });

  it('is `auto` and not `bypassPermissions`, measured rather than preferred', () => {
    // bypassPermissions opens on a consent modal only a human can dismiss,
    // defaulting to "No, exit", and dismissing it writes
    // `bypassPermissionsModeAccepted` into the captain's GLOBAL config — for
    // every Claude Code session on the machine, set by a launcher they ran to
    // get a fleet. `auto` reaches the same place with neither cost.
    expect(DEFAULT_HELM_POSTURE.permissionMode).toBe('auto');
    expect(DEFAULT_HELM_POSTURE.ultracode).toBe(true);
  });

  it('lets the captain dial either one back without touching the other', async () => {
    const h = await harness({ persona: '# Helm' });
    await runLauncher([], {
      root: h.root,
      entry: h.entry,
      env: h.env,
      stdio: 'ignore',
      config: { ...defaultConfig(), helmUltracode: false, helmPermissionMode: 'manual' },
    });

    const argv = await h.argv();
    expect(argv).not.toContain('--settings');
    expect(valueOf(argv, '--permission-mode')).toBe('manual');
  });

  it('does not widen the clamp by one tool, at any posture', async () => {
    // THE CONFLATION THIS FREEZES. Permissive means "not asked", never "allowed
    // more". A deny rule beats an allow rule and beats a permission mode:
    // measured, `claude --permission-mode auto --disallowedTools Bash,Edit,Write`
    // asked to run `echo` replied CLAMP_HELD. The deny list must not move
    // because the posture did.
    const h = await harness({ persona: '# Helm' });
    for (const helmPermissionMode of ['auto', 'bypassPermissions', 'manual'] as const) {
      await runLauncher([], {
        root: h.root,
        entry: h.entry,
        env: h.env,
        stdio: 'ignore',
        config: { ...defaultConfig(), helmPermissionMode },
      });
      expect(valueOf(await h.argv(), '--disallowedTools')).toBe(HELM_DENIED_TOOLS.join(','));
    }
  });

  it('warns on stderr when this shell will swallow ultracode, and launches anyway', async () => {
    const h = await harness({ persona: '# Helm', env: { CLAUDE_CODE_EFFORT_LEVEL: 'medium' } });
    const said: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      said.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await runLauncher([], {
        root: h.root,
        entry: h.entry,
        env: h.env,
        stdio: 'ignore',
        config: defaultConfig(),
      });
      // A blocked ultracode is a worse window, not a broken one.
      expect(code).toBe(0);
    } finally {
      process.stderr.write = write;
    }

    expect(said.join('')).toContain('CLAUDE_CODE_EFFORT_LEVEL=medium');
    expect(said.join('')).toContain('/effort ultracode');
    // The setting is still passed: it is the environment that may defeat it, and
    // this process has no way to know that it did.
    expect(JSON.parse(valueOf(await h.argv(), '--settings'))).toEqual({ ultracode: true });
  });

  it('says nothing at all when the shell is clean', async () => {
    const h = await harness({ persona: '# Helm' });
    const said: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      said.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    try {
      await runLauncher([], {
        root: h.root,
        entry: h.entry,
        env: h.env,
        stdio: 'ignore',
        config: defaultConfig(),
      });
    } finally {
      process.stderr.write = write;
    }
    // A line every launch is noise on the mornings it is fine.
    expect(said.join('')).not.toMatch(/ultracode/i);
  });
});

describe('workspace trust', () => {
  /**
   * The first run every new user takes. Claude Code asks "Is this a project you
   * trust?" the first time it opens a directory and nothing loads until it is
   * answered — no hook, no MCP server, no wake sweep — so a cold `bluespace`
   * sits on a security question that never mentions BlueSpace. A Crew already
   * gets this diagnosis; the window the captain types into did not.
   */
  it('reads trust from the global config, and inherits it from an ancestor', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'blue-trust-'));
    await fs.writeFile(
      path.join(home, '.claude.json'),
      JSON.stringify({ projects: { '/a/trusted': { hasTrustDialogAccepted: true } } }),
    );

    expect(workspaceTrusted('/a/trusted', home)).toBe(true);
    // Inheritance is the whole reason trusting the worktree root once is enough.
    expect(workspaceTrusted('/a/trusted/deep/worktree', home)).toBe(true);
    expect(workspaceTrusted('/a/elsewhere', home)).toBe(false);
    // A sibling whose name merely starts with the trusted path is NOT beneath it.
    expect(workspaceTrusted('/a/trusted-not-really', home)).toBe(false);
    // No config to read is "cannot tell", which must not warn.
    expect(workspaceTrusted('/a/trusted', path.join(home, 'nope'))).toBeUndefined();

    await fs.rm(home, { recursive: true, force: true });
  });

  it('warns only when the directory is known to be untrusted', () => {
    expect(trustNotice(true, '/x')).toBeUndefined();
    expect(trustNotice(undefined, '/x')).toBeUndefined();
    const said = trustNotice(false, '/x');
    expect(said).toMatch(/\/x/);
    expect(said).toMatch(/trust/i);
    expect(said).toMatch(/wake sweep/i);
  });
});


// ---------------------------------------------------------------------------
// The first-run question, from the launcher's side
// ---------------------------------------------------------------------------

describe('runLauncher: the one question', () => {
  /** A terminal that types one line and records what was printed at it. */
  function terminal(line: string): {
    io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; interactive: true };
    printed(): string;
  } {
    const chunks: string[] = [];
    return {
      io: {
        input: Readable.from([`${line}\n`]),
        output: new Writable({
          write(chunk, _enc, cb) {
            chunks.push(String(chunk));
            cb();
          },
        }),
        interactive: true,
      },
      printed: () => chunks.join(''),
    };
  }

  it('asks before the window opens, and launches in what the captain picked', async () => {
    const h = await harness({ persona: '# Helm', env: { LANG: 'en_AU.UTF-8' } });
    const t = terminal('2');

    await runLauncher([], {
      root: h.root,
      entry: h.entry,
      env: h.env,
      stdio: 'ignore',
      firstRun: t.io,
    });

    expect(t.printed()).toContain('Which language should Helm write to you in?');
    const prompt = valueOf(await h.argv(), '--append-system-prompt');
    expect(prompt).toContain('Write to the captain in **zh-CN**');
    expect(prompt).toContain('舰长');
    // Pinned, not guessed — the provenance changes what Helm does when the
    // captain then writes in a third language.
    expect(prompt).toContain('pinned this themselves');
  });

  it('drops the locale guess when the captain declines it by name', async () => {
    // THE REGRESSION. The menu showed `en-AU` and they said no. A launcher that
    // falls back to detection here has just answered for them, which is the
    // whole failure the question was added to end.
    const h = await harness({ persona: '# Helm', env: { LANG: 'en_AU.UTF-8' } });
    const t = terminal('');

    await runLauncher([], {
      root: h.root,
      entry: h.entry,
      env: h.env,
      stdio: 'ignore',
      firstRun: t.io,
    });

    const prompt = valueOf(await h.argv(), '--append-system-prompt');
    expect(prompt).not.toContain('en-AU');
    expect(prompt).not.toContain('Write to the captain in **');
    expect(prompt).toMatch(/chose to be followed/i);
    // And it does not go on to offer the setting: they have been asked once and
    // they answered.
    expect(prompt).toMatch(/Do not mention/i);
  });

  it('asks nothing at all unless the caller opts in', async () => {
    // The default for the exported function is silence: importing it must never
    // block on a prompt. Only the entry point at the bottom of bluespace.ts asks.
    const h = await harness({ persona: '# Helm', env: { LANG: 'en_AU.UTF-8' } });

    await runLauncher([], { root: h.root, entry: h.entry, env: h.env, stdio: 'ignore' });

    // Nobody was asked, so the guess still stands — the behaviour every launch
    // after the first one has.
    expect(valueOf(await h.argv(), '--append-system-prompt')).toContain(
      'Write to the captain in **en-AU**',
    );
  });

  it('does not ask a captain who has already answered', async () => {
    const h = await harness({ persona: '# Helm', env: { LANG: 'en_AU.UTF-8' } });
    await fs.writeFile(
      path.join(sandboxHome, 'config.json'),
      JSON.stringify({ language: 'ja', languageAsked: true }),
      'utf8',
    );
    const t = terminal('2');

    await runLauncher([], {
      root: h.root,
      entry: h.entry,
      env: h.env,
      stdio: 'ignore',
      firstRun: t.io,
    });

    expect(t.printed()).toBe('');
    expect(valueOf(await h.argv(), '--append-system-prompt')).toContain(
      'Write to the captain in **ja**',
    );
  });
});
