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
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  MissingPersonaError,
  WAKE_PROMPT,
  buildHelmArgv,
  helmMcpConfig,
  helmSystemPrompt,
  runLauncher,
  strictMcpRequested,
} from '../src/cli/bluespace.js';

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
};

describe('buildHelmArgv', () => {
  it('injects the tools, the contract, and the install root — and nothing else', () => {
    const argv = buildHelmArgv({ ...BASE, captainArgs: [], strictMcp: false });

    expect(argv).toEqual([
      '/usr/local/bin/claude',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--add-dir',
      '/opt/bluespace',
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
      expect(argv.indexOf('--mcp-config')).toBeLessThan(argv.indexOf('--append-system-prompt'));
      expect(argv.indexOf('--add-dir')).toBeLessThan(argv.indexOf('--append-system-prompt'));
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
    // The greeting is a turn, not chrome: BlueSpace cannot write into Claude
    // Code's welcome box, so a bare `bluespace` asks Helm for the wake sweep.
    expect(argv[argv.length - 1]).toBe(WAKE_PROMPT);
    expect(argv).not.toContain('--strict-mcp-config');
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
