#!/usr/bin/env node
/**
 * `bluespace` — one command that opens a Claude Code window which IS Helm.
 *
 * WHAT THIS REPLACES, AND WHY IT HAD TO BE REPLACED
 *
 * The old instruction was `claude mcp add -s user bluespace -- blue mcp`. It
 * registered the fleet tools for every Claude Code session on the machine,
 * forever, and it still did not produce Helm. Those are two separate faults and
 * the second is the worse one:
 *
 *   An MCP server supplies TOOLS. It does not supply the OPERATING CONTRACT.
 *   Helm's contract lives in `CLAUDE.md` at the root of this repo, which Claude
 *   Code loads only when the working directory is this repo. So in the captain's
 *   own project — the only place they would ever want Helm — a user-scoped
 *   install gave them nine `mcp__bluespace__*` tools and zero rules: a model
 *   that knows `create_task` exists but not that it only enqueues, not that
 *   `landed` is not merged, and not that it must never spawn its own subagents
 *   for fleet work. That middle state is worse than having neither half, because
 *   it is confidently wrong about a fleet the captain is relying on.
 *
 * This launcher supplies both halves at once, for one invocation:
 *
 *   `--mcp-config <inline JSON>`  Helm's tools, from a server started for this
 *                                 window alone. Nothing is written to
 *                                 `~/.claude.json`; delete this binary and every
 *                                 trace is gone.
 *   `--append-system-prompt`      `CLAUDE.md`, verbatim, so the contract arrives
 *                                 wherever the captain happens to be standing.
 *   `--add-dir <install root>`    so the session can read the skill, the
 *                                 compliance doc, and its own source.
 *
 * and a plain `claude` keeps none of it. That is the whole product decision:
 * `bluespace` is Helm, `claude` is Claude Code, and neither leaks into the other.
 *
 * IT IS A LAUNCHER, NOT A WRAPPER. Every argument the captain passes goes
 * through untouched, stdio is inherited (this is an interactive session — see
 * `docs/compliance.md`), the environment is inherited whole, and the child's
 * exit status is reproduced, signal and all. Nothing here parses the captain's
 * argv, and nothing here prints over Claude Code's own screen.
 *
 * WHAT IS DELIBERATELY NOT PASSED, since a reader who knows `buildLaunchArgv`
 * will look for it: `--setting-sources`, `--permission-mode`, `--model`,
 * `--settings`. Those are how BlueSpace constrains a CREW — a process it starts,
 * owns, and grades. This window is the captain's own session, in their own
 * terminal, with their own settings, hooks, model and permission posture. The
 * launcher adds Helm to it; it does not take the captain's Claude Code away and
 * hand back a narrower one. Anything they want changed, they pass themselves.
 *
 * `--strict-mcp-config` is the one flag in that family with a real argument for
 * it, and it is opt-in for the same reason — see `strictMcpRequested`.
 *
 * ARGV ORDER IS LOAD-BEARING — see `buildHelmArgv`.
 *
 * Verified against Claude Code 2.1.223 on 2026-08-05; the measurements are in
 * `docs/compliance.md` under "The `bluespace` launcher".
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClaudeCliUnavailableError, resolveClaudeBinary } from '../adapters/claude-cli.js';
import { MCP_SERVER_NAME } from '../mcp/server.js';

// ---------------------------------------------------------------------------
// Where the installed package is
// ---------------------------------------------------------------------------

/** `dist/cli/` — this module's own directory, wherever it was installed. */
function moduleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** The package root: `dist/cli/bluespace.js` sits two levels down from it. */
function installRoot(): string {
  return path.resolve(moduleDir(), '..', '..');
}

/**
 * The `blue` entry point, as a sibling file rather than a name on PATH.
 *
 * A global install puts `blue` on PATH, but a linked checkout, an npx run, or a
 * captain who installed with a package manager that shims differently may not —
 * and an MCP server that fails to start gives the window nine missing tools and
 * no explanation. The file next to this one is the file that shipped with it.
 */
function blueEntry(): string {
  return path.join(moduleDir(), 'index.js');
}

// ---------------------------------------------------------------------------
// The three things injected into the window
// ---------------------------------------------------------------------------

/**
 * The MCP server, declared inline so nothing is registered anywhere.
 *
 * `node <entry> mcp` rather than `blue mcp` for the PATH reason above, and
 * `process.execPath` rather than the string `node` because the Node that is
 * running this launcher is known to exist and known to satisfy `engines`.
 *
 * The key MUST be `MCP_SERVER_NAME`: the config key is what Claude Code prefixes
 * tool names with, and `CLAUDE.md` tells Helm its levers are `mcp__bluespace__*`.
 * Rename it here and the persona is talking about tools that do not exist.
 */
export function helmMcpConfig(entry: string, nodePath: string = process.execPath): string {
  return JSON.stringify({
    mcpServers: {
      [MCP_SERVER_NAME]: { command: nodePath, args: [entry, 'mcp'] },
    },
  });
}

/** `CLAUDE.md` is missing from the install — refuse rather than open a half-Helm. */
export class MissingPersonaError extends Error {
  constructor(readonly attempted: string) {
    super(
      `BlueSpace could not read Helm's operating contract at ${attempted}\n\n` +
        'Refusing to open the window. A session with the fleet tools and none of the rules\n' +
        'is worse than no session at all: it can create tasks, and it does not know that\n' +
        '`create_task` only enqueues or that `landed` does not mean merged.\n\n' +
        'This file ships with the package. If you are running from a checkout, you are in\n' +
        'the wrong tree; if you installed from npm, the install is incomplete — reinstall.',
    );
    this.name = 'MissingPersonaError';
  }
}

/**
 * What goes into `--append-system-prompt`: the contract, plus what the contract
 * cannot know about the window it is being read in.
 *
 * `CLAUDE.md` is read from disk rather than compiled in on purpose. `src/agents/
 * helm/index.ts` explains the rule: Helm's persona has exactly two copies, this
 * file and `skills/bluespace/SKILL.md`, and a third one embedded in a launcher
 * would drift out of agreement with them silently. Editing `CLAUDE.md` must be
 * enough to change Helm.
 *
 * The appended note below is not persona — it is orientation. It says three
 * things the file itself cannot say, because the file was written for a session
 * whose working directory is this repo and this session's is not.
 */
export function helmSystemPrompt(root: string): string {
  const personaPath = path.join(root, 'CLAUDE.md');
  let persona: string;
  try {
    persona = fs.readFileSync(personaPath, 'utf8');
  } catch {
    throw new MissingPersonaError(personaPath);
  }
  if (persona.trim() === '') throw new MissingPersonaError(personaPath);

  const skill = path.join(root, 'skills', 'bluespace', 'SKILL.md');

  return `${persona.trimEnd()}

---

## This window

You were opened by the \`bluespace\` launcher. The working directory is wherever the
captain ran it — usually one of their own repositories, not BlueSpace's. Everything above
applies unchanged there, including that you are read-only over their projects: being
inside a repo is not permission to edit it, and the fact that you *can* reach the Edit
tool is not a reason to. Work goes through \`mcp__bluespace__create_task\`.

Your levers come from a \`bluespace\` MCP server started for this window alone. It is not
installed in the captain's configuration and it is gone when this window closes — a plain
\`claude\` window has none of it, by design. If the \`mcp__bluespace__*\` tools are not
present, say so in one line and stop. You are not Helm without them, and answering from
memory about a fleet you cannot see is the one failure the captain cannot detect.

The **bluespace** skill named above is a file, not an installed skill. Read it with the
Read tool from:

    ${skill}

That directory is reachable from this window. Load it before the wake sweep, before
writing a brief, before answering a decision, and before reviewing a diff — it is the
craft the rules above assume you already have.
`;
}

/**
 * The opening turn, and the argument for having one at all.
 *
 * The captain asked whether there would be a welcome. Honestly: BlueSpace cannot
 * paint one. Claude Code owns the first screen — its own box, its own model
 * line, its own tips — and there is no flag that writes into it. Printing our
 * own banner first would either be erased or scroll away above a UI we do not
 * control, and a banner that sometimes appears is worse than none.
 *
 * So the greeting is not chrome, it is a TURN. A positional prompt submits
 * itself (verified; `docs/compliance.md`), and Helm's own contract already
 * prescribes what a session should open with — the wake sweep. That makes the
 * first thing the captain reads a real answer to "what needs me", produced by a
 * session that has actually reached the tools. It doubles as the only honest
 * proof the wiring works: if the MCP server failed to start, the reply says so
 * instead of a banner claiming success over a window with no tools.
 *
 * It costs one turn. `BLUESPACE_NO_WAKE=1` turns it off, and any argument at all
 * suppresses it (see `main`) because a captain who typed something has already
 * said what the first turn should be.
 */
export const WAKE_PROMPT =
  'Session start: run the wake sweep before anything else. Read open decisions and fleet ' +
  'state from the tools, then open with what needs me, what came back, and what is still ' +
  'running — leave out any category that is empty. If nothing is in flight, say so in one ' +
  'line and ask what I want built. Do not describe your tools or narrate how you work.';

// ---------------------------------------------------------------------------
// The launch argv
// ---------------------------------------------------------------------------

export interface HelmLaunchInput {
  /** Absolute path to the captain's own `claude`, already resolved. */
  claudePath: string;
  /** Inline `--mcp-config` JSON. Never a path into `~/.claude`. */
  mcpConfigJson: string;
  /** Install root, granted with `--add-dir` so the skill is readable. */
  root: string;
  /** `CLAUDE.md` plus orientation. */
  systemPromptAppend: string;
  /** Everything the captain typed after `bluespace`, verbatim and in order. */
  captainArgs: readonly string[];
  /** Drop the captain's own MCP servers. Opt-in; see `docs/compliance.md`. */
  strictMcp: boolean;
  /** The opening turn, or undefined for a window that waits. */
  openingPrompt?: string | undefined;
}

/**
 * Build the exact argv `bluespace` launches, in the one order that works.
 *
 * Exported and pure because this array IS the contract, the same way
 * `buildLaunchArgv` is for a Crew — and because the ordering rule below is
 * invisible at the call site and a reader "tidying" it would break the product
 * in a way no type checks.
 *
 * THE ORDERING RULE. `--mcp-config <configs...>` and `--add-dir <directories...>`
 * are VARIADIC: they swallow every following token that does not start with `-`,
 * including the captain's prompt. Measured on 2.1.223:
 *
 *     claude -p --add-dir /some/dir "reply OK"
 *       -> Error: Input must be provided ... when using --print   (prompt eaten)
 *     claude -p --mcp-config '{"mcpServers":{}}' "reply OK"
 *       -> Error: MCP config file not found: <cwd>/reply OK       (prompt eaten)
 *
 * So the last flag BlueSpace injects must take exactly one value, and
 * `--append-system-prompt` does. Everything the captain passes, and the opening
 * prompt, sit safely after it. Keep it last.
 */
export function buildHelmArgv(input: HelmLaunchInput): string[] {
  // An opening prompt after the captain's own argv could land inside a variadic
  // flag of theirs (`bluespace --add-dir /x` + our prompt = a second directory).
  // The caller only offers one when they typed nothing; a violation is a bug
  // here, not a launch to muddle through.
  if (input.openingPrompt !== undefined && input.captainArgs.length > 0) {
    throw new Error('bluespace: refusing to append an opening prompt after the captain’s own arguments');
  }

  const argv = [input.claudePath, '--mcp-config', input.mcpConfigJson];

  // A bare flag terminates the variadic above it, which is why this may sit here.
  if (input.strictMcp) argv.push('--strict-mcp-config');

  argv.push('--add-dir', input.root);
  argv.push('--append-system-prompt', input.systemPromptAppend); // must stay last

  argv.push(...input.captainArgs);
  if (input.openingPrompt !== undefined) argv.push(input.openingPrompt);

  return argv;
}

/** Truthy-ish env, spelled once so the three call sites cannot disagree. */
function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name]?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Whether to isolate the window from the captain's own MCP servers.
 *
 * Default OFF, and that is a choice rather than an omission. Measured on 2.1.223
 * against a machine with five user-scoped servers: `--strict-mcp-config` really
 * does drop all of them (the session reported exactly one server, ours), and
 * without it the captain's five load alongside ours. Both halves verified.
 *
 * Isolation was rejected as the default because it takes something away that
 * BlueSpace did not give and does not own. Helm does intake and judgement — it
 * reads links the captain pastes and looks things up before writing a brief —
 * and a launcher that silently deletes their web search to make our window
 * tidier is a worse tool than one extra server in a list. Nothing in the
 * compliance argument needs isolation either: what matters there is that the
 * session is interactive and the captain's own, not that it is minimal.
 *
 * `BLUESPACE_STRICT_MCP=1` turns it on for anyone who wants the clean room —
 * a slow or broken server of theirs delaying every Helm launch is the real case
 * for it.
 */
export function strictMcpRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return envFlag(env, 'BLUESPACE_STRICT_MCP');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function errLine(s: string): void {
  process.stderr.write(`${s}\n`);
}

/**
 * Run the window and report how it ended. Nothing here decides argv.
 *
 * `spawn` with inherited stdio rather than the `execFile` the rest of this
 * codebase uses: `execFile` buffers output for a callback, and this child is an
 * interactive full-screen program that has to own the real TTY. It is still an
 * argv array and still no shell, which is what that convention protects.
 *
 * Signals. SIGINT is delivered by the terminal to the whole foreground group, so
 * the child already has it and the launcher's only job is to not die first —
 * otherwise the shell prompt comes back while Claude Code is still drawing.
 * SIGTERM and SIGHUP are not delivered that way, so they are forwarded. Both
 * listeners are removed on exit: a registered signal listener holds the event
 * loop open, and a launcher that outlives its window is a hang.
 *
 * The window inherits the captain's environment untouched — it is their session
 * and their login. `stdio` and `env` are parameters for exactly one reason: a
 * test can then drive a real child process without handing it the suite's
 * terminal, and can tell a stand-in `claude` where to record what it saw.
 */
export async function launchWindow(
  claudePath: string,
  args: readonly string[],
  options: { stdio?: 'inherit' | 'ignore'; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const child = spawn(claudePath, [...args], {
    stdio: options.stdio ?? 'inherit',
    env: options.env ?? process.env,
  });

  const swallow = (): void => {
    /* the child got it too; let it decide when to go */
  };
  const onTerm = (): void => void child.kill('SIGTERM');
  const onHup = (): void => void child.kill('SIGHUP');
  process.on('SIGINT', swallow);
  process.on('SIGTERM', onTerm);
  process.on('SIGHUP', onHup);

  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', (e: NodeJS.ErrnoException) => {
        // It resolved a moment ago and still will not exec. Same advice either
        // way: the adapter's error already spells out install / sign-in /
        // CLAUDE_CLI_PATH, so it is reused rather than paraphrased.
        reject(new ClaudeCliUnavailableError(`\`${claudePath}\` could not be started (${e.code ?? e.message})`));
      });
      child.once('exit', (code, signal) => {
        // A window killed by a signal exits the way the captain's shell expects
        // it to, instead of being flattened into 0 or 1.
        resolve(signal !== null ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 0));
      });
    });
  } finally {
    process.off('SIGINT', swallow);
    process.off('SIGTERM', onTerm);
    process.off('SIGHUP', onHup);
  }
}

/**
 * Assemble the launch and hand over the terminal.
 *
 * Exported so a test can run the whole path — argv, spawn, exit code — against a
 * stand-in `claude` rather than the real one, which costs money and cannot be
 * asserted on.
 */
export async function runLauncher(
  captainArgs: readonly string[],
  options: { root?: string; entry?: string; env?: NodeJS.ProcessEnv; stdio?: 'inherit' | 'ignore' } = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const root = options.root ?? installRoot();

  let claudePath: string;
  let systemPromptAppend: string;
  try {
    claudePath = resolveClaudeBinary(env);
    systemPromptAppend = helmSystemPrompt(root);
  } catch (e: unknown) {
    errLine(e instanceof Error ? e.message : String(e));
    return 1;
  }

  // Nothing the captain typed is inspected. The only question asked of their
  // argv is whether it is empty, and that settles one thing: whether the opening
  // turn is ours to choose or theirs.
  const wake =
    captainArgs.length === 0 && !envFlag(env, 'BLUESPACE_NO_WAKE') ? WAKE_PROMPT : undefined;

  const argv = buildHelmArgv({
    claudePath,
    mcpConfigJson: helmMcpConfig(options.entry ?? blueEntry()),
    root,
    systemPromptAppend,
    captainArgs,
    strictMcp: strictMcpRequested(env),
    openingPrompt: wake,
  });

  try {
    const launchOptions: { stdio?: 'inherit' | 'ignore'; env: NodeJS.ProcessEnv } = { env };
    if (options.stdio !== undefined) launchOptions.stdio = options.stdio;
    return await launchWindow(claudePath, argv.slice(1), launchOptions);
  } catch (e: unknown) {
    errLine(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

/**
 * Only launch when this file was the command, not when it was imported.
 *
 * `main` at module scope would mean a test that imports `buildHelmArgv` opens a
 * Claude Code window. Both sides are realpath'd because the installed `bluespace`
 * on PATH is a symlink into `dist/cli/`.
 */
function isEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return fs.realpathSync(invoked) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await runLauncher(process.argv.slice(2));
}
