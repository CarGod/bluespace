#!/usr/bin/env node
/**
 * `blue` — the BlueSpace command line.
 *
 * This module owns the terminal surface: argv parsing (by hand, no framework),
 * the read-only views over the Blackbox (`ps`, `log`, `inbox`, `map`), the
 * registry and config editors, and `blue mcp` — the stdio server that the
 * captain's own Claude Code window launches.
 *
 * What is deliberately NOT here any more is a conversation. `blue` used to open
 * a readline REPL and drive Helm through `adapter.converse()`. It does not, and
 * the reason is `docs/compliance.md`: the line Anthropic draws is "is a person
 * interacting with it", and a REPL that relays typed lines into a programmatic
 * session is on the wrong side of it. The captain now types into a real
 * interactive Claude Code window and BlueSpace hangs off it as an MCP server.
 * The REPL was deleted rather than deprecated — a second front door is a second
 * way to end up back on the wrong side, and it would have to be maintained.
 *
 * What remains is worth more than it was, not less: these views are the
 * captain's only unmediated look at the fleet. Everything printed here is a
 * projection over the event log, and every state change goes through the
 * Orchestrator. No vendor SDK appears in this file.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertClaudeCliAvailable,
  createClaudeCliAdapter,
  resolveAuth,
} from '../adapters/claude-cli.js';
import type { HarnessAdapter } from '../adapters/types.js';
import { Blackbox, projectCrewLog, projectHelmWindows } from '../blackbox/index.js';
import {
  PERMISSION_MODES,
  ProjectRegistry,
  addressTerm,
  configPath,
  detectLanguage,
  findRepositories,
  loadConfig,
  localeVarInEffect,
  normalizeLanguage,
  registerProjects,
  resolveHelmPosture,
  saveConfig,
} from '../config/index.js';
import type { BlueConfig, ConfigPatch } from '../config/index.js';
import { landTask, pendingDelivery, LandRefusedError } from '../land/index.js';
import { CrewNotHeldError, Orchestrator } from '../orchestrator/index.js';
import {
  DevBranchConflictError,
  INTEGRATION_BRANCH,
  MergeConflictError,
  WorktreeManager,
} from '../worktree/index.js';
import { addTokenCounts, isTerminal, noTokens, totalTokens } from '../types/domain.js';
import type {
  DeliveryMode,
  Effort,
  PermissionMode,
  Project,
  Task,
  TaskState,
  TokenCounts,
} from '../types/domain.js';
import type { BlueEvent } from '../types/events.js';

import { cancelOutcome } from './cancel.js';
import { runGc } from './gc.js';
import { decisionNudge, runInbox } from './inbox.js';
import { helmWindowsInView, psView } from './ps.js';
import {
  bold,
  clockTime,
  colourState,
  cyan,
  describeEvent,
  dim,
  formatTokens,
  formatTokensByModel,
  formatUsd,
  formatUsdEquivalent,
  green,
  padEnd,
  red,
  relTime,
  renderTable,
  setColourEnabled,
  shortId,
  stateGlyph,
  truncate,
  visibleWidth,
  yellow,
} from './format.js';

// ---------------------------------------------------------------------------
// Tiny output helpers
// ---------------------------------------------------------------------------

const out = (s = ''): void => {
  process.stdout.write(`${s}\n`);
};
const errOut = (s = ''): void => {
  process.stderr.write(`${s}\n`);
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Gate every path that will actually run an agent.
 *
 * BlueSpace runs its crews as real interactive sessions of the captain's own
 * `claude`, so the one hard requirement is that the CLI is installed and signed
 * in. A worker is launched into a terminal session, which means a missing or
 * signed-out CLI would otherwise surface as a window that dies without ever
 * signalling readiness — after a worktree exists and the captain has been told
 * work started. Checking here turns that into one sentence at startup.
 *
 * Returns false (having already printed the reason) rather than throwing, so the
 * caller exits with a clean status instead of a stack trace.
 */
function requireClaudeCli(): boolean {
  try {
    assertClaudeCliAvailable();
    return true;
  } catch (e: unknown) {
    errOut(red(errorMessage(e)));
    return false;
  }
}

// ---------------------------------------------------------------------------
// argv parsing — by hand, no framework
// ---------------------------------------------------------------------------

/** Long flags that consume the next token as their value. Everything else is boolean. */
const VALUE_FLAGS = new Set([
  'name',
  'desc',
  'description',
  'delivery',
  'port',
  'interval',
  'limit',
  'depends-on',
  'scan',
]);

type Flags = Map<string, string | true>;

interface Parsed {
  positionals: string[];
  flags: Flags;
}

function parseArgv(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Flags = new Map();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (arg === '--') {
      for (const rest of argv.slice(i + 1)) positionals.push(rest);
      break;
    }

    if (arg.startsWith('--') && arg.length > 2) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      if (VALUE_FLAGS.has(body)) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags.set(body, next);
          i++;
          continue;
        }
      }
      flags.set(body, true);
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      for (const ch of arg.slice(1)) flags.set(ch, true);
      continue;
    }

    positionals.push(arg);
  }

  return { positionals, flags };
}

function flagStr(flags: Flags, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = flags.get(n);
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function flagBool(flags: Flags, ...names: string[]): boolean {
  for (const n of names) if (flags.has(n)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function usage(): string {
  const L: string[] = [];
  L.push('');
  L.push(`${bold('blue')} ${dim('— a captain and an AI crew. One conversation in, a fleet of agents out.')}`);
  L.push('');
  L.push(bold('USAGE'));
  L.push(`  blue <command> [options]`);
  L.push(`  blue                        ${dim('how to reach Helm — there is no prompt here')}`);
  L.push('');
  L.push(bold('COMMANDS'));
  const rows: Array<[string, string]> = [
    ['mcp', "serve Helm's tools over stdio  ← `bluespace` starts this for you"],
    ['inbox', 'read the decisions waiting on you (answer them through Helm)'],
    ['ps', 'what the fleet is doing, and how to watch a worker'],
    ['log <taskId>', "replay one task's events from the Blackbox"],
    ['map', 'start the Starmap server and print its URL'],
    ['land <taskId>', `merge a verified task into ${INTEGRATION_BRANCH}  (never into main)`],
    // Deliberately vaguer than it was. The old line promised a Crew stopped and
    // a worktree removed for every cancellation; a queued task has neither, and
    // a running one is only stoppable from the process that holds it. The
    // command itself now says which of the three happened — the summary should
    // not pre-empt it with the most dramatic one.
    ['cancel <taskId>', 'end a task — it says what it actually stopped'],
    ['gc', 'reclaim the worktrees whose work is merged  [--dry-run] [--force]'],
    ['projects', 'list registered projects'],
    ['projects add <path…>', 'register one repo, several, or --scan <dir> for a folder of them'],
    ['projects rm <id>', 'forget a project'],
    ['config', 'print the effective config and where it lives'],
    ['config set <k> <v>', 'change one setting (validated)'],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) L.push(`  ${padEnd(k, w)}  ${dim(v)}`);
  L.push('');
  L.push(bold('TALKING TO HELM'));
  L.push(`  ${cyan(LAUNCH_COMMAND)}${dim('  — opens a Claude Code window that IS Helm. Nothing to register.')}`);
  L.push(`  ${dim('run it in any repo; it takes claude’s own flags: bluespace --model opus, bluespace "…"')}`);
  L.push(`  ${dim('plain `claude` stays plain. `blue mcp` is not for typing into: stdout is the protocol.')}`);
  L.push(`  ${dim(`ran \`claude mcp add\` for BlueSpace before? undo it: ${REMOVE_COMMAND}`)}`);
  L.push('');
  L.push(bold('ENVIRONMENT'));
  L.push(`  ${dim('BLUESPACE_STRICT_MCP=1')}  ${dim('(bluespace) load only BlueSpace’s MCP server, drop your own')}`);
  L.push(`  ${dim('BLUESPACE_NO_WAKE=1')}     ${dim('(bluespace) open silently instead of on a wake sweep')}`);
  // Spelled out rather than summarised as "unrestricted": a captain reading this
  // line is deciding whether to turn off the thing that makes work trackable,
  // and "gives Helm more tools" is not what they would be agreeing to.
  L.push(`  ${dim('BLUESPACE_UNCLAMPED=1')}   ${dim('(bluespace) give Helm back Bash/Edit/Write — it can then do')}`);
  L.push(`  ${' '.repeat(24)}${dim('the work itself, with no worktree, no Sentinel, no token')}`);
  L.push(`  ${' '.repeat(24)}${dim('ceiling, nothing in `blue ps` and no record in the Blackbox')}`);
  L.push(`  ${' '.repeat(24)}${dim('(Helm has sub-agents either way; clamped, they inherit the')}`);
  L.push(`  ${' '.repeat(24)}${dim('same denials and cannot write a file or run a command)')}`);
  L.push(`  ${dim('CLAUDE_CLI_PATH')}         ${dim('point at a `claude` that is not on PATH')}`);
  L.push('');
  L.push(bold('CONFIG KEYS'));
  // Spelled from the same constants `blue config set` validates against. Help
  // text that lists modes by hand is help text that eventually names one the
  // loader rejects — which is exactly what happened to the last copy of these
  // two lines when PermissionMode was rewritten to mirror the harness.
  L.push(`  ${dim('permissionMode')} ${PERMISSION_MODES.join('|')}`);
  L.push(`  ${dim('effort')} ${EFFORTS.join('|')}   ${dim('model')} <string>`);
  // Spelled out because "language" reads like a display setting and is not one:
  // it is the language Helm writes to the captain in, and leaving it unset is a
  // real answer rather than a missing one.
  L.push(
    `  ${dim('language')} <zh-CN|en|…>       ${dim('what Helm writes to you in; unset = follow what you write')}`,
  );
  L.push(
    `  ${dim('maxConcurrentCrew')} <int>   ${dim('maxRework')} <int>   ${dim('maxTokensPerTask')} <int>   ${dim('maxBudgetUsdPerTask')} <number>`,
  );
  L.push('');
  L.push(bold('OPTIONS'));
  L.push(`  -h, --help                  ${dim('this text')}`);
  L.push(`  -V, --version               ${dim('print the version')}`);
  L.push(`      --no-color              ${dim('never emit ANSI colour')}`);
  L.push(`  -a, --all                   ${dim('(ps) every task ever, not just what is in flight or recent')}`);
  L.push(`  -f, --follow                ${dim('(log) keep streaming new events')}`);
  L.push(`      --limit <n>             ${dim('(log) show only the last n events')}`);
  L.push(`      --list                  ${dim('(inbox) render only, do not prompt')}`);
  L.push(`      --scan <dir>            ${dim('(projects add) register every repo directly inside <dir>')}`);
  L.push(`      --port <n>              ${dim('(map) port to listen on')}`);
  L.push(`      --orchestrate           ${dim('(map) also run the dispatch loop')}`);
  L.push(`  -n, --dry-run               ${dim('(gc) report what would be reclaimed, change nothing')}`);
  L.push(`      --force                 ${dim('(gc) also take unmerged and dirty worktrees — asks first')}`);
  L.push(`  ${' '.repeat(24)}${dim('(cancel) record it anyway when no Crew is held here')}`);
  L.push(`  -y, --yes                   ${dim('(gc) skip the --force confirmation')}`);
  L.push('');
  return L.join('\n');
}

/**
 * The one word that reaches Helm.
 *
 * This used to be `claude mcp add -s user bluespace -- blue mcp`, and that
 * instruction is gone rather than softened. It was wrong twice. It put the fleet
 * tools in every Claude Code session on the machine, permanently, for a tool the
 * captain was only trying out — and it never produced Helm anyway, because an
 * MCP server supplies tools and Helm's rules live in `CLAUDE.md`, which loads
 * only when the working directory is the BlueSpace repo. In the captain's own
 * project it delivered the levers and no contract: a model that can create
 * tasks without knowing that `create_task` only enqueues.
 *
 * `bluespace` supplies both halves for one invocation and leaves nothing behind.
 * See `src/cli/bluespace.ts`. Anyone who already ran the old command should undo
 * it — `REMOVE_COMMAND` below.
 */
const LAUNCH_COMMAND = 'bluespace';

/** For captains who ran the old instruction; harmless if they never did. */
const REMOVE_COMMAND = 'claude mcp remove -s user bluespace';

/**
 * Did a previous version's instruction leave a user-scoped server behind?
 *
 * Read-only, and offered rather than acted on: `~/.claude.json` is the captain's
 * file and BlueSpace does not write it — that is the entire point of the
 * launcher. Detecting it means the removal advice is shown to the people who
 * need it and to nobody else, which is the difference between help and noise.
 */
function hasUserScopedMcpRegistration(): boolean {
  return (
    safe(() => {
      const raw = fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8');
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      return parsed.mcpServers?.['bluespace'] !== undefined;
    }) === true
  );
}

/** The installed package root — `dist/cli/index.js` sits two levels down. */
function installRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/**
 * The launcher that ships beside this file, for a captain whose PATH does not
 * have it. Derived from this module's own location rather than from the install
 * root, so it stays right in a linked checkout too.
 */
function launcherPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'bluespace.js');
}

/**
 * Where to read why the REPL is gone.
 *
 * A path only if there is a file at the end of it: `docs/` is not in the
 * published package, and pointing an npm user at an absolute path to nothing is
 * worse than naming the file and letting them find it in the repo.
 */
function complianceDoc(): string {
  const local = path.join(installRoot(), 'docs', 'compliance.md');
  return safe(() => fs.existsSync(local)) === true ? local : 'docs/compliance.md in the BlueSpace repo';
}

function version(): string {
  try {
    const raw = fs.readFileSync(path.join(installRoot(), 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// ---------------------------------------------------------------------------
// Bootstrap — config, blackbox, registry, adapter, orchestrator
// ---------------------------------------------------------------------------

interface Boot {
  config: BlueConfig;
  blackbox: Blackbox;
  registry: ProjectRegistry;
  adapter: HarnessAdapter;
  orch: Orchestrator;
  /** `<dataDir>/worktrees` — every project's worktrees are cut under it. */
  worktreeRoot: string;
  /** The same per-project managers the orchestrator dispatches with. */
  worktreeFor(projectPath: string): WorktreeManager;
  close(): void;
}

function boot(): Boot {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });

  const blackbox = Blackbox.open(path.join(config.dataDir, 'blackbox.db'));
  const registry = ProjectRegistry.open(config.dataDir);
  const adapter = createClaudeCliAdapter();

  // Worktrees live under the data directory, NOT the manager's tmpdir default: a
  // landed task keeps its worktree because the branch it built is the deliverable,
  // and the OS reaps its temp directory. Losing finished work to /tmp cleanup is
  // not a tradeoff, it is a bug. `blue gc` reclaims from here on the merged test.
  const worktreeRoot = path.join(config.dataDir, 'worktrees');
  const worktrees = new Map<string, WorktreeManager>();
  const worktreeFor = (projectPath: string): WorktreeManager => {
    let wm = worktrees.get(projectPath);
    if (wm === undefined) {
      wm = new WorktreeManager(projectPath, { root: worktreeRoot });
      worktrees.set(projectPath, wm);
    }
    return wm;
  };

  const orch = new Orchestrator({ blackbox, adapter, config, registry, worktreeFor });

  let closed = false;
  return {
    config,
    blackbox,
    registry,
    adapter,
    orch,
    worktreeRoot,
    worktreeFor,
    close(): void {
      if (closed) return;
      closed = true;
      try {
        orch.stop();
      } catch {
        /* stopping a loop that never started is not an error */
      }
      try {
        blackbox.close();
      } catch {
        /* the log is append-only; a failed close loses nothing */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// blue ps
// ---------------------------------------------------------------------------

/**
 * Attach commands for the crews that have one, keyed by crew id.
 *
 * A Crew is a real interactive session on the captain's machine, and watching
 * one — or taking it over mid-task — is the point of running them that way. The
 * command is minted by the session backend at spawn and recorded on
 * `crew.spawned`; `blue ps` is a separate short-lived process with no live
 * `Session` to ask, so the Blackbox is the only place it can come from. Empty
 * for a headless adapter, which is why every caller treats it as optional
 * rather than printing a line nobody can act on.
 */
function attachCommands(b: Boot): Map<string, string> {
  const byCrew = new Map<string, string>();
  const events = safe(() => b.blackbox.read({ types: ['crew.spawned'] })) ?? [];
  for (const e of events) {
    if (e.type !== 'crew.spawned') continue;
    if (e.attachCommand !== undefined) byCrew.set(e.crewId, e.attachCommand);
  }
  return byCrew;
}

/**
 * What is merged onto an integration branch and still outside the default one.
 *
 * Printed rather than nagged: it is a fact about the repository, so it goes
 * where the captain is already looking (`blue ps`, `blue projects`) and says
 * nothing at all when there is nothing waiting. BlueSpace does not open the pull
 * request, and no line here pretends otherwise.
 */
async function printPendingDelivery(b: Boot): Promise<void> {
  let pending;
  try {
    pending = await pendingDelivery({
      blackbox: b.blackbox,
      registry: b.registry,
      worktreeFor: b.worktreeFor,
    });
  } catch {
    return; // a git failure is not a reason to fail a read-only view
  }
  if (pending.length === 0) return;

  out('');
  out(bold('Waiting on a pull request'));
  for (const d of pending) {
    out(
      `  ${cyan(d.project)}  ${d.devBranch} ${dim('→')} ${d.defaultBranch}  ${dim(
        `${plural(d.tasks, 'landed task')} · ${plural(d.commits, 'commit')}${
          d.behind > 0 ? ` · ${plural(d.behind, 'commit')} behind` : ''
        }`,
      )}`,
    );
  }
  out(dim('  BlueSpace never opens one — ask Helm for the `gh pr create` command.'));
}

/**
 * What Helm's own window has been spending, read off disk.
 *
 * WHY THIS SECTION EXISTS, AND WHY IT IS PHRASED THE WAY IT IS. The captain
 * asked for a template upgrade; Helm launched two sub-agents that spent 153.4k
 * and 128.5k tokens in two minutes; `blue ps` printed nothing and the Starmap
 * said "Nothing needs you · 0 crew working" the whole time. Their question was
 * *"map 里面为啥看不到当前执行的任务"*, and the honest answer was that BlueSpace
 * had built a whole token-accounting layer and then left its own front door
 * outside it.
 *
 * IT IS NOT LIVE AND THE HEADING SAYS SO, IN EVERY LANGUAGE THIS PRINTS IN.
 * There is no process here watching that window — `blue ps` is reading files
 * another process wrote — so a sub-agent that started a moment ago has written
 * nothing yet and is genuinely absent from this list. Calling this a live view
 * would reproduce the original bug with better numbers on it: the captain would
 * read an empty section as an idle Helm, which is exactly what they did before.
 * "as of <time>" is the whole fix and it is not decoration.
 *
 * TOKENS, NOT DOLLARS, for the same reason the table above uses them: a Helm
 * window is the captain's own login on their own subscription.
 */
async function printHelmFanout(b: Boot, flags: Flags): Promise<void> {
  const refs = helmWindowsInView(projectHelmWindows(b.blackbox.read()), {
    all: flagBool(flags, 'all', 'a'),
  });
  if (refs.length === 0) return;

  const { readHelmWindows } = await import('../helm/index.js');
  let windows;
  try {
    windows = await readHelmWindows(refs);
  } catch {
    // Reading someone else's files is best-effort by construction. A `blue ps`
    // that failed because a transcript was mid-write would be a worse tool than
    // one that quietly omits a section.
    return;
  }
  if (windows.length === 0) return;

  out('');
  const observedAt = windows[0]?.observedAt ?? Date.now();
  out(
    `${bold('Helm')} ${dim(`· your own window · read from its transcript, as of ${clockTime(observedAt)} — not live`)}`,
  );

  for (const w of windows) {
    const own = totalTokens(w.own.totals);
    const all = totalTokens(w.total.totals);
    out(
      `  ${cyan(truncate(tildePath(w.cwd), 44))}  ${dim(shortId(w.sessionId))}  ` +
        `${bold(formatTokens(all))} ${dim('tokens')}${dim(` · ${formatTokens(own)} in the window itself`)}`,
    );
    for (const agent of w.subagents) {
      // The description is what makes a row actionable: it is the thing the
      // captain reads to decide whether that fan-out should have been a task.
      const label = agent.description ?? dim('(no description recorded)');
      out(
        `    ${dim('↳')} ${padEnd(truncate(agent.agentType ?? 'sub-agent', 16), 16)} ` +
          `${padEnd(truncate(label, 42), 42)} ${formatTokens(totalTokens(agent.tokens.totals))}`,
      );
    }
  }

  const fannedOut = windows.reduce((n, w) => n + w.subagents.length, 0);
  if (fannedOut > 0) {
    // Said once, under the numbers, because the numbers are what make it land:
    // a sub-agent is genuinely cheaper than a task and genuinely accountable to
    // nothing, and the captain is entitled to know which they just paid for.
    out(
      dim(
        `  ${plural(fannedOut, 'sub-agent')} — Helm's own, not the fleet's: no worktree, no Sentinel, no ceiling, and nothing above.`,
      ),
    );
  }
}

/** `~/aulp` rather than `/Users/liufei/aulp` — the captain's own word for it. */
function tildePath(p: string): string {
  const home = os.homedir();
  return p === home ? '~' : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

async function cmdPs(b: Boot, flags: Flags): Promise<number> {
  const tasks = b.orch.tasks();
  if (tasks.length === 0) {
    out('');
    out(dim('No tasks yet. Ask Helm for something — run `bluespace` and say what you want built.'));
    // NOT AN EARLY RETURN ANY MORE, and that is the whole point of this change:
    // "no tasks" was precisely the screen the captain was looking at while two
    // of Helm's sub-agents burned 282k tokens. An empty fleet and an idle Helm
    // are different states and this command now distinguishes them.
    await printHelmFanout(b, flags);
    out('');
    return 0;
  }

  // The horizon lives in `./ps.ts` so it can be tested; this file cannot be
  // imported without running the CLI.
  const { shown, elided } = psView(tasks, { all: flagBool(flags, 'all', 'a') });

  if (shown.length === 0) {
    // Everything is over and none of it is recent. Say the state of the fleet
    // first — that is the question — and then where the history went.
    out('');
    out(dim('Nothing in flight.'));
    out(dim(`${plural(elided, 'finished task')} older than a day — \`blue ps --all\` to see them.`));
    out('');
    return 0;
  }

  const sorted = [...shown].sort((x, y) => {
    const ax = isTerminal(x.state) ? 1 : 0;
    const ay = isTerminal(y.state) ? 1 : 0;
    if (ax !== ay) return ax - ay;
    return y.updatedAt - x.updatedAt;
  });

  const projectName = (id: string): string => {
    const p = safe(() => b.registry.get(id));
    return p ? p.name : shortId(id);
  };

  // TOKENS, NOT DOLLARS, IN THE COLUMN. A Crew is the captain's own Claude Code
  // session on their own login, so its tokens come out of a subscription quota
  // and no dollar amount is charged for them; the only number that is measured
  // rather than modelled is the token count. See `TokenCounts` in
  // types/domain.ts. Dollars come back below, once, for the metered case.
  const rows = sorted.map((t) => [
    `${stateGlyph(t.state)} ${dim(shortId(t.id))}`,
    colourState(t.state),
    cyan(truncate(projectName(t.projectId), 18)),
    truncate(t.title, 46),
    formatTokens(totalTokens(t.tokens.totals)),
    dim(relTime(t.createdAt)),
  ]);

  out('');
  out(
    renderTable(
      [
        { header: 'id' },
        { header: 'state' },
        { header: 'project' },
        { header: 'title', max: 46 },
        { header: 'tokens', align: 'right' },
        { header: 'age', align: 'right' },
      ],
      rows,
    ),
  );

  // THE ELISION IS VISIBLE, and it sits between the rows and the totals — which
  // is exactly where a reader notices that the counts below cover more than the
  // table above. A view that quietly dropped rows would be a worse bug than the
  // one this horizon fixes.
  if (elided > 0) {
    out(dim(`… and ${plural(elided, 'older finished task')} — \`blue ps --all\``));
  }

  // THE TOTALS ARE THE WHOLE FLEET, always, over `tasks` rather than the rows on
  // screen. `--all` changes what is printed and never what is counted: "what has
  // this cost me" has one answer, and a number that moved when the captain
  // passed a display flag would be worth less than no number.
  const counts = new Map<TaskState, number>();
  let fleetTokens: TokenCounts = noTokens();
  const fleetByModel: Record<string, TokenCounts> = {};
  let meteredUsd = 0;
  let unmeteredUsd = 0;
  for (const t of tasks) {
    counts.set(t.state, (counts.get(t.state) ?? 0) + 1);
    fleetTokens = addTokenCounts(fleetTokens, t.tokens.totals);
    for (const [model, c] of Object.entries(t.tokens.byModel)) {
      fleetByModel[model] = addTokenCounts(fleetByModel[model] ?? noTokens(), c);
    }
    if (t.metered) meteredUsd += t.listPriceUsd;
    else unmeteredUsd += t.listPriceUsd;
  }

  const summary = [...counts.entries()]
    .sort((a, b2) => b2[1] - a[1])
    .map(([state, n]) => `${n} ${colourState(state)}`)
    .join(dim(' · '));

  out('');
  out(
    `${summary}${dim('  ·  ')}${bold(formatTokens(totalTokens(fleetTokens)))} ${dim('tokens')}`,
  );
  const byModel = formatTokensByModel(fleetByModel);
  if (byModel !== '') out(dim('  by model: ') + byModel);
  // Two figures, never added together: one is an invoice, the other is not.
  if (meteredUsd > 0) {
    out(`${dim('  metered (ANTHROPIC_API_KEY): ')}${bold(formatUsd(meteredUsd))} ${dim('spent')}`);
  }
  if (unmeteredUsd > 0) {
    out(
      dim(
        `  on your Claude subscription: no dollar cost — those tokens draw down your plan's quota (${formatUsdEquivalent(unmeteredUsd)})`,
      ),
    );
  }

  // A task's `crewId` is its LATEST dispatch, which is what makes this lookup
  // correct across rework: an earlier crew's window is gone with the crew.
  const attach = attachCommands(b);
  const watchable: Array<[string, string]> = [];
  for (const t of sorted) {
    if (isTerminal(t.state)) continue;
    const crewId = t.crewId;
    if (crewId === undefined) continue;
    const command = attach.get(crewId);
    if (command !== undefined) watchable.push([shortId(t.id), command]);
  }
  if (watchable.length > 0) {
    out('');
    out(dim('watch a crew — a live session you can read and type into:'));
    for (const [id, command] of watchable) out(`  ${dim(id)}  ${cyan(command)}`);
  }

  // After the fleet, because the fleet is the answer to "what is running" and
  // this is the answer to "what else is spending".
  await printHelmFanout(b, flags);

  await printPendingDelivery(b);

  const open = b.orch.openDecisions();
  const nudge = decisionNudge(open);
  if (nudge !== undefined) {
    out('');
    out(nudge);
  }
  out('');
  return 0;
}

// ---------------------------------------------------------------------------
// blue log <taskId>
// ---------------------------------------------------------------------------

function resolveTask(b: Boot, hint: string): Task | undefined {
  const exact = safe(() => b.orch.task(hint));
  if (exact) return exact;
  const tasks = b.orch.tasks();
  const byPrefix = tasks.filter((t) => t.id.startsWith(hint));
  if (byPrefix.length === 1) return byPrefix[0];
  if (byPrefix.length > 1) return undefined;
  const lower = hint.toLowerCase();
  const byTitle = tasks.filter((t) => t.title.toLowerCase().includes(lower));
  return byTitle.length === 1 ? byTitle[0] : undefined;
}

function eventLine(e: BlueEvent, metered: boolean): string {
  const { label, detail } = describeEvent(e, { metered });
  const head = `${dim(clockTime(e.at))} ${padEnd(label, 12)}`;
  const gutter = ' '.repeat(visibleWidth(head) + 1);
  const [first = '', ...rest] = detail.split('\n');
  const lines = [`${head} ${first}`];
  for (const line of rest) lines.push(`${gutter}${line}`);
  return lines.join('\n');
}

/**
 * Collect every event that belongs to a task. Task-scoped events carry
 * `taskId`; Crew chatter only carries `crewId`, so the crew ids are derived
 * from the dispatch events and folded back in, ordered by `seq`.
 */
function taskEvents(b: Boot, taskId: string): BlueEvent[] {
  const direct = b.blackbox.read({ taskId });
  const crewIds = new Set<string>();
  for (const e of direct) {
    if (e.type === 'task.dispatched') crewIds.add(e.crewId);
    if (e.type === 'crew.spawned') crewIds.add(e.crewId);
  }

  const merged = new Map<number, BlueEvent>();
  for (const e of direct) merged.set(e.seq, e);

  if (crewIds.size > 0) {
    const all = b.blackbox.read();
    for (const crewId of crewIds) {
      for (const e of projectCrewLog(all, crewId)) merged.set(e.seq, e);
    }
  }

  return [...merged.values()].sort((x, y) => x.seq - y.seq);
}

async function cmdLog(b: Boot, hint: string | undefined, flags: Flags): Promise<number> {
  if (hint === undefined || hint === '') {
    errOut(red('blue log needs a task id.'));
    errOut(dim('Run `blue ps` to see them.'));
    return 1;
  }

  const task = resolveTask(b, hint);
  if (task === undefined) {
    errOut(red(`No single task matches "${hint}".`));
    errOut(dim('Run `blue ps` to see them.'));
    return 1;
  }

  const project = safe(() => b.registry.get(task.projectId));

  out('');
  out(`${stateGlyph(task.state)} ${bold(task.title)} ${dim(`(${shortId(task.id)})`)}`);
  out(
    dim(
      `${task.kind} · ${project ? project.name : task.projectId} · ${formatTokens(
        totalTokens(task.tokens.totals),
      )} tokens · ${task.reworkCount} rework · created ${relTime(task.createdAt)}`,
    ) + `  ${colourState(task.state)}`,
  );
  // The split, on its own line, because it is the answer to "what did this
  // cost" that is actually true: which model spent how much of the quota.
  const byModel = formatTokensByModel(task.tokens.byModel);
  if (byModel !== '') out(dim('tokens: ') + byModel);
  if (task.metered) {
    out(dim(`metered run (ANTHROPIC_API_KEY) · ${formatUsd(task.listPriceUsd)} spent`));
  } else if (task.listPriceUsd > 0) {
    out(
      dim(
        `Claude subscription run — these tokens drew down your plan's quota and were not billed (${formatUsdEquivalent(task.listPriceUsd)})`,
      ),
    );
  }
  if (task.worktree !== undefined) out(dim(`worktree ${task.worktree}`));
  out('');

  const events = taskEvents(b, task.id);
  if (events.length === 0) {
    out(dim('No events recorded yet.'));
    out('');
    return 0;
  }

  const limitRaw = flagStr(flags, 'limit');
  const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : undefined;
  const shown =
    limit !== undefined && Number.isFinite(limit) && limit > 0 && events.length > limit
      ? events.slice(-limit)
      : events;
  if (shown.length < events.length) {
    out(dim(`… ${events.length - shown.length} earlier events hidden`));
  }
  for (const e of shown) out(eventLine(e, task.metered));

  if (!flagBool(flags, 'follow', 'f')) {
    out('');
    return 0;
  }

  // --follow: tail the log by polling `sinceSeq`.
  //
  // `Blackbox.subscribe` only observes appends made through *this* process's
  // handle, and the process doing the appending is a different `blue` (the
  // interactive session, or `blue map --orchestrate`). Polling reads through
  // SQLite, so it sees the other process's commits. Crew ids are tracked as
  // they appear, so chatter from a Crew dispatched *after* we attached shows up
  // too.
  out('');
  out(dim('following — ctrl-c to stop'));

  const crewIds = new Set<string>();
  for (const e of events) {
    if (e.type === 'task.dispatched' || e.type === 'crew.spawned') crewIds.add(e.crewId);
  }
  let lastSeq = events.length > 0 ? (events[events.length - 1]?.seq ?? 0) : 0;

  return await new Promise<number>((resolve) => {
    const timer = setInterval(() => {
      let fresh: BlueEvent[];
      try {
        fresh = b.blackbox.read({ sinceSeq: lastSeq });
      } catch {
        return; // a transient read failure should not kill the tail
      }
      for (const e of fresh) {
        if (e.seq <= lastSeq) continue;
        lastSeq = e.seq;
        if (
          (e.type === 'task.dispatched' || e.type === 'crew.spawned') &&
          e.taskId === task.id
        ) {
          crewIds.add(e.crewId);
        }
        const belongs =
          ('taskId' in e && e.taskId === task.id) || ('crewId' in e && crewIds.has(e.crewId));
        if (belongs) out(eventLine(e, task.metered));
      }
    }, 400);

    const stop = (): void => {
      clearInterval(timer);
      out('');
      resolve(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

// ---------------------------------------------------------------------------
// blue projects
// ---------------------------------------------------------------------------

async function cmdProjects(b: Boot, rest: string[], flags: Flags): Promise<number> {
  const sub = rest[0];

  if (sub === undefined || sub === 'list' || sub === 'ls') {
    const projects = b.registry.list();
    if (projects.length === 0) {
      out('');
      out(dim('No projects registered. Add one with `blue projects add <path>`.'));
      out('');
      return 0;
    }
    out('');
    out(
      renderTable(
        [
          { header: 'id' },
          { header: 'name' },
          { header: 'delivery' },
          { header: 'path', max: 48 },
          { header: 'added', align: 'right' },
        ],
        projects.map((p) => [
          dim(shortId(p.id)),
          cyan(p.name),
          p.delivery,
          p.path,
          dim(relTime(p.addedAt)),
        ]),
      ),
    );
    out('');
    for (const p of projects) {
      if (p.description.trim() !== '') {
        out(`${dim(shortId(p.id))}  ${dim(truncate(p.description, 100))}`);
      }
    }
    await printPendingDelivery(b);
    out('');
    return 0;
  }

  if (sub === 'add') return await cmdProjectsAdd(b, rest.slice(1), flags);

  if (sub === 'rm' || sub === 'remove') {
    const hint = rest[1];
    if (hint === undefined) {
      errOut(red('blue projects rm needs a project id.'));
      return 1;
    }
    let target: Project | undefined = safe(() => b.registry.get(hint));
    if (target === undefined) {
      const matches = safe(() => b.registry.resolve(hint)) ?? [];
      if (matches.length === 1) {
        target = matches[0];
      } else if (matches.length > 1) {
        errOut(red(`"${hint}" matches ${matches.length} projects:`));
        for (const m of matches) errOut(`  ${dim(shortId(m.id))}  ${m.name}  ${dim(m.path)}`);
        return 1;
      }
    }
    if (target === undefined) {
      errOut(red(`No project matches "${hint}".`));
      return 1;
    }
    try {
      b.registry.remove(target.id);
      out(`${green('✓')} forgot ${bold(target.name)} ${dim('(the repo itself is untouched)')}`);
      return 0;
    } catch (e) {
      errOut(red(`Could not remove: ${errorMessage(e)}`));
      return 1;
    }
  }

  errOut(red(`Unknown: blue projects ${sub}`));
  errOut(dim('Try: list | add <path…> [--scan <dir>] | rm <id>'));
  return 1;
}

/**
 * `blue projects add <path…> [--scan <dir>]`.
 *
 * The same operation Helm's `add_projects` performs, through the same
 * `registerProjects` (see `src/config/register.ts`) — the `blue/dev` rule and
 * the bare-`blue` refusal are in there rather than duplicated at both call
 * sites, which is how they used to drift.
 *
 * PARTIAL SUCCESS EXITS 0 WHEN ANYTHING REGISTERED. A directory of ten repos
 * where one is already registered is a successful run with a note, not a
 * failure; exit 1 is reserved for "nothing was registered", which is the only
 * outcome a script should stop on. Every refusal is printed either way.
 *
 * `--name` and `--desc` are single-repository options and are refused for a
 * batch rather than applied to all of them — one name for eight projects is
 * never what was meant, and silently ignoring a flag the captain typed is worse
 * than saying it does not fit.
 */
async function cmdProjectsAdd(b: Boot, rawPaths: string[], flags: Flags): Promise<number> {
  const scanDir = flagStr(flags, 'scan');
  if (rawPaths.length === 0 && scanDir === undefined) {
    errOut(red('blue projects add needs a path.'));
    errOut(dim('One repo: blue projects add ~/code/api'));
    errOut(dim('Many:     blue projects add ~/code/api ~/code/web'));
    errOut(dim('A folder: blue projects add --scan ~/code'));
    return 1;
  }

  const deliveryRaw = flagStr(flags, 'delivery');
  if (deliveryRaw !== undefined && deliveryRaw !== 'pr' && deliveryRaw !== 'local') {
    errOut(red(`delivery must be "pr" or "local", got "${deliveryRaw}".`));
    return 1;
  }
  const delivery: DeliveryMode | undefined = deliveryRaw;

  const scanned = scanDir === undefined ? [] : findRepositories(scanDir);
  if (scanDir !== undefined && scanned.length === 0) {
    errOut(red(`No git repositories directly inside ${path.resolve(scanDir)}.`));
    errOut(dim('The scan takes the subdirectories that are repo roots; it does not recurse.'));
    if (rawPaths.length === 0) return 1;
  }

  const paths = [...rawPaths.map((p) => path.resolve(p)), ...scanned];
  const name = flagStr(flags, 'name');
  const description = flagStr(flags, 'desc', 'description');
  if (paths.length > 1 && (name !== undefined || description !== undefined)) {
    errOut(red('--name and --desc describe one project; this is registering ' + paths.length + '.'));
    errOut(dim('Register them without, then `blue projects add <one>` or ask Helm to describe them.'));
    return 1;
  }

  const outcomes = await registerProjects(
    { registry: b.registry, worktreeFor: b.worktreeFor },
    paths.map((p) => ({
      path: p,
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(delivery !== undefined ? { delivery } : {}),
    })),
  );

  out('');
  let registered = 0;
  let undescribed = 0;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      registered += 1;
      if (outcome.project.description.trim() === '') undescribed += 1;
      out(
        `${green('✓')} ${bold(outcome.project.name)} ${dim(`(${shortId(outcome.project.id)})`)}  ${dim(outcome.project.path)}`,
      );
      out(
        dim(
          `  ${
            outcome.devBranchCreated
              ? `created ${outcome.devBranch} off ${outcome.base}`
              : `adopted the existing ${outcome.devBranch}`
          } — landed work is merged there, never into your default branch`,
        ),
      );
      continue;
    }
    // `already_registered` is dimmed rather than reddened: re-running a scan
    // after adding one repo by hand is the normal way to use this, and eight
    // red lines saying "you already did that" reads like eight failures.
    const already = outcome.reason === 'already_registered';
    out(
      `${already ? dim('·') : red('✗')} ${dim(outcome.path)}  ${already ? dim(outcome.message) : yellow(outcome.message)}`,
    );
    if (outcome.reason === 'branch_conflict') {
      out(
        dim(
          '  Every BlueSpace branch lives under blue/, so this repo cannot be managed until that name is free.',
        ),
      );
    }
  }

  out('');
  const refused = outcomes.length - registered;
  out(
    `${bold(plural(registered, 'project'))} registered${refused > 0 ? dim(` · ${refused} not`) : ''}`,
  );
  if (undescribed > 0) {
    // Said once for the batch rather than once per project: the description is
    // what `resolve_project` routes by, and this is the only moment the captain
    // is looking at the list of things that lack one.
    out(
      dim(
        `  ${plural(undescribed, 'project')} with no description — Helm routes ambiguous requests by it. Ask Helm to fill them in, or use --desc when adding one.`,
      ),
    );
  }
  out('');
  return registered > 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// blue config
// ---------------------------------------------------------------------------

// Imported, not redeclared. Two copies of an enum drift, and the one that
// drifts is always the one nobody is looking at — here that would mean
// `blue config set` accepting a mode the loader then rejects.
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * What `blue config` says about the language — including, when it is unset, what
 * Helm would work out for itself.
 *
 * A row that just said "(unset)" would leave the captain unable to answer the
 * only question they have when Helm greets them in the wrong language: where did
 * it get that idea. So the fallback is shown with the variable it came from, and
 * an environment that names no language is shown as what it is — not a silent
 * vote for English.
 */
function languageRow(config: BlueConfig): string {
  if (config.language !== undefined) {
    return `${config.language} ${dim(`(Helm writes to you in this, and calls you ${addressTerm(config.language)})`)}`;
  }
  const detected = detectLanguage();
  if (detected === undefined) {
    return dim('(unset) no language in this shell — Helm follows whatever you write to it');
  }
  return dim(
    `(unset) ${detected}, detected from ${localeVarInEffect() ?? 'the environment'} — Helm follows what you write`,
  );
}

/** An unset Helm pin resolves to a default and says which it is doing. */
function helmPostureRow(pinned: unknown, resolved: string): string {
  return pinned === undefined ? `${resolved} ${dim('(default — not pinned)')}` : resolved;
}

function printConfig(config: BlueConfig): void {
  // Read here rather than stored: this line describes what WOULD happen to a
  // task dispatched from this shell, which is a property of the environment,
  // not of the config file. What a past task actually cost is recorded on the
  // task itself (`Task.metered`).
  const metered = resolveAuth().kind === 'api-key';
  const posture = resolveHelmPosture(config);
  const rows: Array<[string, string]> = [
    ['permissionMode', config.permissionMode],
    ['model', config.model ?? dim('(harness default)')],
    ['effort', config.effort ?? dim('(harness default)')],
    [
      'maxTokensPerTask',
      config.maxTokensPerTask > 0
        ? `${config.maxTokensPerTask.toLocaleString('en-US')} ${dim('(the ceiling that stops a task)')}`
        : red('0 — no token ceiling; nothing stops a runaway task'),
    ],
    [
      'maxBudgetUsdPerTask',
      `${formatUsd(config.maxBudgetUsdPerTask)} ${dim(
        metered
          ? '(enforced — this shell has ANTHROPIC_API_KEY set)'
          : '(not enforced: no ANTHROPIC_API_KEY, so runs draw on your Claude subscription and cost no dollars)',
      )}`,
    ],
    ['maxConcurrentCrew', String(config.maxConcurrentCrew)],
    ['maxRework', String(config.maxRework)],
    ['language', languageRow(config)],
    // The Helm window, not a Crew. Printed with the resolved value AND the
    // provenance, because unset and off look identical on a screen that shows
    // only the value — and only one of them tracks the default if it changes.
    ['helmUltracode', helmPostureRow(config.helmUltracode, String(posture.ultracode))],
    ['helmPermissionMode', helmPostureRow(config.helmPermissionMode, posture.permissionMode)],
    ['dataDir', dim(config.dataDir)],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  out('');
  for (const [k, v] of rows) out(`  ${dim(padEnd(k, w))}  ${v}`);
  out('');
  out(dim(`  config file  ${configPath()}`));
  out('');
}

function cmdConfig(b: Boot, rest: string[]): number {
  const sub = rest[0];

  if (sub === undefined || sub === 'show' || sub === 'get') {
    printConfig(b.config);
    return 0;
  }

  if (sub !== 'set') {
    errOut(red(`Unknown: blue config ${sub}`));
    errOut(dim('Try: blue config  |  blue config set <key> <value>'));
    return 1;
  }

  const key = rest[1];
  const value = rest[2];
  if (key === undefined || value === undefined) {
    errOut(red('blue config set needs a key and a value.'));
    errOut(
      dim(
        'Keys: permissionMode, model, effort, language, maxConcurrentCrew, maxRework, maxTokensPerTask, maxBudgetUsdPerTask,\n' +
          '      helmUltracode, helmPermissionMode  (the `bluespace` window, not a crew)',
      ),
    );
    return 1;
  }

  // `null` is how `mergeConfig` is told to CLEAR an optional field. `undefined`
  // means "leave it alone", so the three `-` branches below must send null —
  // written the other way, `blue config set model -` set a key mergeConfig then
  // correctly ignored, and the model stayed exactly where it was.
  const patch: ConfigPatch = {};

  switch (key) {
    case 'permissionMode': {
      if (!PERMISSION_MODES.includes(value as PermissionMode)) {
        errOut(red(`permissionMode must be one of: ${PERMISSION_MODES.join(', ')}`));
        return 1;
      }
      patch.permissionMode = value as PermissionMode;
      break;
    }
    case 'helmUltracode': {
      if (value === '-' || value === 'default') {
        patch.helmUltracode = null;
        break;
      }
      // The three spellings a captain reaches for, and nothing looser: an
      // unrecognised value here must not quietly read as false and turn off the
      // thing they were trying to turn on.
      if (['true', 'on', '1', 'yes'].includes(value)) patch.helmUltracode = true;
      else if (['false', 'off', '0', 'no'].includes(value)) patch.helmUltracode = false;
      else {
        errOut(red(`helmUltracode must be true or false (or "-" for the default), got "${value}".`));
        return 1;
      }
      break;
    }
    case 'helmPermissionMode': {
      if (value === '-' || value === 'default') {
        patch.helmPermissionMode = null;
        break;
      }
      if (!PERMISSION_MODES.includes(value as PermissionMode)) {
        errOut(red(`helmPermissionMode must be one of: ${PERMISSION_MODES.join(', ')}`));
        return 1;
      }
      if (value === 'bypassPermissions') {
        // Measured, and worth a line before they hit it rather than after: the
        // window opens on a consent modal defaulting to "No, exit", and
        // accepting writes a permanent machine-wide flag into ~/.claude.json.
        // The Helm window has no Bash, Edit or Write for it to unlock either.
        errOut(
          yellow(
            'Note: bypassPermissions opens the window on a modal only you can dismiss, and dismissing it ' +
              'writes bypassPermissionsModeAccepted into your global config for every Claude Code session ' +
              'on this machine. It unlocks nothing here — Helm has no Bash, Edit or Write to unlock.',
          ),
        );
      }
      patch.helmPermissionMode = value as PermissionMode;
      break;
    }
    case 'model': {
      patch.model = value === '-' || value === 'default' ? null : value;
      break;
    }
    case 'language': {
      if (value === '-' || value === 'default') {
        // Clearing is a real setting, not an absence of one: it means "follow
        // whatever I write", which is also what an undetectable locale means.
        patch.language = null;
        break;
      }
      const language = normalizeLanguage(value);
      if (language === undefined) {
        errOut(red(`language must name a language, got "${value}".`));
        errOut(
          dim(
            'Try a tag (zh-CN, en, ja) or a name (「Simplified Chinese」). "C" and "POSIX" name no ' +
              'language. Use "-" to clear it and let Helm follow whatever you write.',
          ),
        );
        return 1;
      }
      patch.language = language;
      break;
    }
    case 'effort': {
      if (value === '-' || value === 'default') {
        patch.effort = null;
        break;
      }
      if (!EFFORTS.includes(value as Effort)) {
        errOut(red(`effort must be one of: ${EFFORTS.join(', ')} (or "-" to clear)`));
        return 1;
      }
      patch.effort = value as Effort;
      break;
    }
    case 'maxConcurrentCrew':
    case 'maxRework': {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n < 0 || String(n) !== value.trim()) {
        errOut(red(`${key} must be a non-negative integer, got "${value}".`));
        return 1;
      }
      if (key === 'maxConcurrentCrew' && n < 1) {
        errOut(red('maxConcurrentCrew must be at least 1 — otherwise nothing ever dispatches.'));
        return 1;
      }
      patch[key] = n;
      break;
    }
    case 'maxTokensPerTask': {
      const n = Number.parseInt(value, 10);
      if (!Number.isInteger(n) || n < 0 || String(n) !== value.trim()) {
        errOut(red(`maxTokensPerTask must be a non-negative integer, got "${value}".`));
        return 1;
      }
      if (n === 0) {
        // Allowed, because a captain who means it should be able to; said out
        // loud, because on a subscription this is the ONLY ceiling there is.
        errOut(
          yellow(
            'maxTokensPerTask 0 disables the token ceiling. On a Claude subscription that leaves a task with no consumption ceiling at all.',
          ),
        );
      }
      patch.maxTokensPerTask = n;
      break;
    }
    case 'maxBudgetUsdPerTask': {
      const n = Number.parseFloat(value);
      if (!Number.isFinite(n) || n <= 0) {
        errOut(red(`maxBudgetUsdPerTask must be a positive number, got "${value}".`));
        return 1;
      }
      if (resolveAuth().kind !== 'api-key') {
        errOut(
          dim(
            'Note: maxBudgetUsdPerTask only bounds a metered run (ANTHROPIC_API_KEY set). Crews on your Claude subscription spend quota, not dollars — maxTokensPerTask is what stops them.',
          ),
        );
      }
      patch.maxBudgetUsdPerTask = n;
      break;
    }
    case 'dataDir': {
      errOut(red('dataDir is not settable from the CLI — it would orphan the existing Blackbox.'));
      return 1;
    }
    default: {
      errOut(red(`Unknown config key "${key}".`));
      errOut(
        dim(
          'Keys: permissionMode, model, effort, language, maxConcurrentCrew, maxRework, maxTokensPerTask, maxBudgetUsdPerTask',
        ),
      );
      return 1;
    }
  }

  try {
    const next = saveConfig(patch);
    // `-` now genuinely clears (it used to send an `undefined` mergeConfig
    // ignores), so the confirmation has to say what happened rather than echo a
    // dash back at the captain as if it were the new value.
    const cleared = patch[key as keyof ConfigPatch] === null;
    out(cleared ? `${green('✓')} ${key} cleared` : `${green('✓')} ${key} = ${bold(String(value))}`);
    printConfig(next);
    return 0;
  } catch (e) {
    errOut(red(`Could not save config: ${errorMessage(e)}`));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// blue map
// ---------------------------------------------------------------------------

async function cmdMap(b: Boot, flags: Flags): Promise<number> {
  const { startServer } = await import('../server/index.js');

  const portRaw = flagStr(flags, 'port');
  const port = portRaw !== undefined ? Number.parseInt(portRaw, 10) : undefined;
  if (portRaw !== undefined && (!Number.isInteger(port) || (port as number) < 0)) {
    errOut(red(`--port must be an integer, got "${portRaw}".`));
    return 1;
  }

  // Viewing the map needs no Claude CLI; running the dispatch loop does.
  const orchestrate = flagBool(flags, 'orchestrate');
  if (orchestrate) {
    if (!requireClaudeCli()) return 1;
    b.orch.start();
  }

  const opts: { blackbox: Blackbox; orch: Orchestrator; port?: number } = {
    blackbox: b.blackbox,
    orch: b.orch,
  };
  if (port !== undefined) opts.port = port;

  let server: { url: string; close(): Promise<void> };
  try {
    server = await startServer(opts);
  } catch (e) {
    errOut(red(`Could not start the Starmap: ${errorMessage(e)}`));
    return 1;
  }

  out('');
  out(`${bold('Starmap')} ${dim('→')} ${cyan(server.url)}`);
  out(
    dim(
      orchestrate
        ? '  dispatch loop running — ctrl-c to stop'
        : '  view only; pass --orchestrate to also run the dispatch loop',
    ),
  );
  out('');

  return await new Promise<number>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      out('');
      out(dim('Starmap down.'));
      void server
        .close()
        .catch(() => undefined)
        .then(() => resolve(0));
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

// ---------------------------------------------------------------------------
// blue gc
// ---------------------------------------------------------------------------

/**
 * Reclaim the worktrees whose tasks are over.
 *
 * Needs no Claude CLI and starts no fleet: it reads the task projection, asks
 * git what is merged, and removes only what the answer allows. See `./gc.ts`
 * for the reporting rules and `src/worktree/reclaim.ts` for the decision.
 */
async function cmdGc(b: Boot, flags: Flags): Promise<number> {
  return await runGc(
    {
      tasks: () => b.orch.tasks(),
      projects: () => b.registry.list(),
      worktreeFor: (projectPath: string) => b.worktreeFor(projectPath),
      worktreeRoot: b.worktreeRoot,
    },
    {
      dryRun: flagBool(flags, 'dry-run', 'n'),
      force: flagBool(flags, 'force'),
      yes: flagBool(flags, 'yes', 'y'),
    },
  );
}

// ---------------------------------------------------------------------------
// blue land <taskId>
// ---------------------------------------------------------------------------

/**
 * Merge one verified task's branch into the project's integration branch.
 *
 * The captain's own hands on the same implementation Helm's `land_task` calls —
 * `src/land/`. Nothing is decided here: this resolves the task id the way every
 * other `blue` command does, hands it over, and renders whatever comes back.
 *
 * The two outcomes worth reading carefully are the refusals. A task that never
 * passed verification and a merge that conflicts BOTH change nothing at all, and
 * both are reported as answers rather than as crashes — with, in the conflict
 * case, the files to look at.
 */
async function cmdLand(b: Boot, hint: string | undefined): Promise<number> {
  if (hint === undefined || hint === '') {
    errOut(red('blue land needs a task id.'));
    errOut(dim('Run `blue ps` to see them.'));
    return 1;
  }

  const task = resolveTask(b, hint);
  if (task === undefined) {
    errOut(red(`No single task matches "${hint}".`));
    errOut(dim('Run `blue ps` to see them.'));
    return 1;
  }

  try {
    const report = await landTask(
      { blackbox: b.blackbox, registry: b.registry, worktreeFor: b.worktreeFor },
      task.id,
    );

    out('');
    if (report.alreadyMerged) {
      out(
        `${dim('·')} ${bold(report.title)} ${dim(`(${shortId(report.taskId)})`)} was already in ${cyan(report.devBranch)} ${dim('— nothing changed')}`,
      );
    } else {
      out(
        `${green('✓')} merged ${cyan(report.branch)} into ${bold(cyan(report.devBranch))} ${dim(`· ${report.commit.slice(0, 12)}`)}`,
      );
      out(`  ${dim(report.title)}`);
    }
    // Said every time, on purpose: this is the promise the whole design rests
    // on, and a captain should be able to confirm it at a glance.
    out(dim(`  ${report.defaultBranch} was not touched — it is reached only by a pull request you open.`));
    if (report.defaultBranchMoved) {
      out(
        yellow(
          `  note: ${report.defaultBranch} moved while this ran. That is a commit in the repository, not BlueSpace.`,
        ),
      );
    }
    if (report.adoptedDevBranch) {
      out(dim(`  ${report.devBranch} is now this project's integration branch (it predates delivery).`));
    }

    const ahead = report.status.ahead;
    if (ahead > 0) {
      out('');
      out(
        `${cyan(report.devBranch)} is ${bold(plural(ahead, 'commit'))} ahead of ${report.status.defaultBranch}` +
          (report.status.behind > 0 ? dim(` · ${plural(report.status.behind, 'commit')} behind`) : ''),
      );
      out(dim('  `blue projects` → delivery; ask Helm for the `gh pr create` command when you want it.'));
    }
    out('');
    return 0;
  } catch (e) {
    out('');
    if (e instanceof MergeConflictError) {
      errOut(`${red('✗')} ${bold('conflict')} — nothing was merged, nothing was changed.`);
      for (const file of e.files) errOut(`  ${yellow(file)}`);
      errOut(
        dim(
          `  ${e.into} and ${e.branch} are exactly as they were. Resolve it yourself, or task a Crew with the rebase.`,
        ),
      );
      return 1;
    }
    if (e instanceof LandRefusedError) {
      errOut(`${red('✗')} ${errorMessage(e)}`);
      return 1;
    }
    if (e instanceof DevBranchConflictError) {
      errOut(`${red('✗')} ${errorMessage(e)}`);
      return 1;
    }
    errOut(red(`Could not land: ${errorMessage(e)}`));
    return 1;
  }
}

// ---------------------------------------------------------------------------
// blue cancel <taskId>
// ---------------------------------------------------------------------------

/**
 * End a task from the terminal.
 *
 * The gap this fills, in the captain's words, looking at two dead tasks:
 * *"这任务怎么结束啊，我们貌似没有结束任务的指令吗"*. There was `blue land` and
 * `blue gc` and no way to stop anything — cancelling was reachable only through
 * Helm's `cancel_task`, which means opening a window to end a task you can see
 * in front of you.
 *
 * Same implementation as that tool: `Orchestrator.cancelTask`, which is where
 * the state walk and the teardown live and where they stay.
 *
 * THE CROSS-PROCESS GAP IS THE WHOLE DESIGN OF THIS COMMAND. A Crew's session
 * handle exists only inside the process that spawned it — `blue mcp`, or `blue
 * map --orchestrate` — and this is neither. So the orchestrator refuses rather
 * than writing `cancelled` over a Crew that keeps running, and this prints where
 * to go instead. `blue inbox` has said the same thing about answering decisions
 * since long before this command existed; it is the same handle and the same
 * honesty.
 *
 * `--force` is for the case the refusal cannot distinguish: the fleet process
 * died and took the handle with it, leaving a task nothing can ever cancel. It
 * records the cancellation and does NOTHING else — it cannot stop a session it
 * has no handle for, and it deliberately does not delete the worktree, which may
 * be the only copy of work in progress. The output says exactly that rather than
 * printing a tick that means less than it looks like.
 *
 * A QUEUED TASK IS THE COMMON CASE AND IS NOT A CROSS-PROCESS PROBLEM AT ALL:
 * nothing was ever spawned for it, so cancelling is a pure log write that every
 * process can do correctly, and the orchestrator exempts it from the refusal
 * above. It gets its own line under the tick for the same reason `--force` does —
 * a Crew that never existed was not stopped, and a worktree that was never made
 * was not removed.
 */
async function cmdCancel(b: Boot, hint: string | undefined, flags: Flags): Promise<number> {
  if (hint === undefined || hint === '') {
    errOut(red('blue cancel needs a task id.'));
    errOut(dim('Run `blue ps` to see them.'));
    return 1;
  }

  const task = resolveTask(b, hint);
  if (task === undefined) {
    errOut(red(`No single task matches "${hint}".`));
    errOut(dim('Run `blue ps` to see them.'));
    return 1;
  }

  if (isTerminal(task.state)) {
    out('');
    out(
      `${dim('·')} ${bold(task.title)} ${dim(`(${shortId(task.id)})`)} is already ${colourState(task.state)} ${dim('— nothing to end')}`,
    );
    // The likeliest reason they typed this: the row is still on the screen.
    out(dim('  Finished tasks drop off `blue ps` after a day; the Blackbox keeps them forever.'));
    out('');
    return 0;
  }

  const force = flagBool(flags, 'force');

  // BOTH READ BEFORE THE CANCEL, and that is not tidiness.
  //
  // `cancelTask` tears the session down, and teardown is what removes the task
  // from the orchestrator's live map — so asking `holdsCrew` afterwards can only
  // ever answer "no", including in the one case where a Crew really was stopped.
  // `task` is the projection from before the walk, so its `crewId` still says
  // whether anything was ever spawned at all.
  const heldCrew = b.orch.holdsCrew(task.id);
  const hadCrew = task.crewId !== undefined;

  try {
    await b.orch.cancelTask(task.id, { force });
  } catch (e) {
    if (e instanceof CrewNotHeldError) {
      errOut('');
      errOut(`${red('✗')} ${bold(task.title)} ${dim(`(${shortId(task.id)})`)} was not cancelled.`);
      errOut(dim(`  Its Crew is running in another process, and only that process can stop it.`));
      errOut(dim(`  Cancel it in the Helm window (\`bluespace\`), or wherever \`blue map --orchestrate\` is running.`));
      errOut(
        dim(
          `  If that process is gone, \`blue cancel ${shortId(task.id)} --force\` records the cancellation — it cannot stop the Crew or remove the worktree.`,
        ),
      );
      errOut('');
      return 1;
    }
    errOut(red(`Could not cancel: ${errorMessage(e)}`));
    return 1;
  }

  const after = b.orch.task(task.id);
  out('');
  out(
    `${green('✓')} ${colourState(after?.state ?? 'cancelled')} ${bold(task.title)} ${dim(`(${shortId(task.id)})`)}`,
  );
  // THE LINE UNDER THE TICK NAMES WHAT ACTUALLY HAPPENED — see `./cancel.ts`,
  // where the rule lives so that a test can hold it.
  switch (cancelOutcome({ hadCrew, heldCrew })) {
    case 'never_ran':
      out(dim('  It never left the queue — nothing was running, and no worktree was ever made.'));
      break;
    case 'crew_stopped':
      out(dim('  Crew stopped, worktree removed. Commits it made survive on the branch.'));
      break;
    case 'recorded_only':
      // Only reachable under `--force`; without it the orchestrator refuses. Said
      // in full, because a tick above a half-truth is how a captain ends up
      // believing a session stopped that did not.
      out(yellow('  Recorded only. This process held no Crew for it:'));
      out(dim('  if the session is still alive it is still running — `blue ps` prints its attach command.'));
      out(dim('  the worktree was left in place; `blue gc` decides what is safe to reclaim.'));
      break;
  }
  out('');
  return 0;
}

/** `3 commits` / `1 commit` — the CLI says numbers with their nouns. */
function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// blue mcp
// ---------------------------------------------------------------------------

/**
 * Hand Helm's tools to a Claude Code window.
 *
 * Not a command the captain runs: `bluespace` names it in the `--mcp-config` it
 * passes, and the window spawns it. Left reachable by hand because it is how the
 * server is debugged, and because a captain who prefers to wire it up their own
 * way should not be prevented — only warned that tools without `CLAUDE.md` are
 * half of Helm (see `LAUNCH_COMMAND`). Nothing in this function
 * may print — stdout is the protocol stream from the moment `runMcp` starts, and
 * a single stray line desynchronizes the client into what looks like a hang.
 * `requireClaudeCli` writes to stderr, which is why it is safe here.
 */
async function cmdMcp(b: Boot): Promise<number> {
  // Crews are the captain's own `claude`, so a missing or signed-out CLI means
  // every task this server accepts would die after dispatch. Say so now, on
  // stderr, where the client puts it in its MCP log.
  if (!requireClaudeCli()) return 1;
  const { runMcp } = await import('../mcp/index.js');
  return await runMcp({
    orch: b.orch,
    registry: b.registry,
    // What `land_task` needs to merge and to record the merge. Same log and
    // same managers the orchestrator uses, so a landed task's merge event sits
    // in the same stream as the verdict that justified it.
    deps: { blackbox: b.blackbox, worktreeFor: b.worktreeFor },
  });
}

// ---------------------------------------------------------------------------
// blue — no subcommand
// ---------------------------------------------------------------------------

/**
 * What a bare `blue` does now that there is no REPL behind it.
 *
 * This used to open a prompt, so the captain who types `blue` out of habit is
 * exactly the person this text exists for. It says the thing changed, gives the
 * one command that makes Helm reachable, and then gets out of the way — a
 * "removed" notice with no path forward would leave them stranded in the same
 * terminal they were stranded in before.
 *
 * Read-only, and cheap: it opens the Blackbox only to surface waiting decisions,
 * because a captain standing at a terminal wondering what to do is precisely
 * when a blocked fleet is worth a line. A failure to open it is not worth
 * mentioning — the guidance above it is still the answer.
 */
function cmdFrontDoor(): number {
  out('');
  out(`${bold('BlueSpace')} ${dim('· you talk to Helm in a real Claude Code window')}`);
  out('');
  out('There is no prompt here. Helm is a Claude Code session — the levers arrive as an');
  out('MCP server and the rules as a system prompt, both for that window only — so the');
  out(`thing you type into is a real interactive session; see ${dim(complianceDoc())}.`);
  out('');
  out(bold('Open it'));
  out(`  ${cyan(LAUNCH_COMMAND)}${dim('  — in any repo. Nothing to register, nothing left behind.')}`);
  // The absolute path is worth the ugly line: the bin is only on PATH after a
  // global install, and this is the package that is running right now.
  out(dim(`  bluespace not on your PATH? Run: node ${launcherPath()}`));
  out(dim(`  plain \`claude\` is unchanged — no BlueSpace tools, no BlueSpace rules.`));
  if (hasUserScopedMcpRegistration()) {
    out('');
    out(bold('You still have the old global install'));
    out(`  ${cyan(REMOVE_COMMAND)}`);
    out(dim('  it puts the fleet tools in every session you open, with none of Helm’s rules.'));
  }
  out('');
  out(bold('From this terminal'));
  const rows: Array<[string, string]> = [
    ['blue ps', 'what the fleet is doing, and how to watch a worker'],
    ['blue inbox', 'read the decisions waiting on you'],
    ['blue map', 'the Starmap, in a browser'],
    ['blue --help', 'everything else'],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) out(`  ${padEnd(k, w)}  ${dim(v)}`);

  const nudge = safe(() => {
    const b = boot();
    try {
      return decisionNudge(b.orch.openDecisions());
    } finally {
      b.close();
    }
  });
  if (nudge !== undefined) {
    out('');
    out(nudge);
  }

  out('');
  return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

async function main(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgv(argv);

  if (flagBool(flags, 'no-color', 'no-colour')) setColourEnabled(false);
  if (flagBool(flags, 'color', 'colour')) setColourEnabled(true);

  const command = positionals[0];

  if (flagBool(flags, 'help', 'h') || command === 'help') {
    out(usage());
    return 0;
  }
  if (flagBool(flags, 'version', 'V')) {
    out(version());
    return 0;
  }

  if (command === undefined) return cmdFrontDoor();

  let b: Boot;
  try {
    b = boot();
  } catch (e) {
    errOut(red(`Could not start: ${errorMessage(e)}`));
    return 1;
  }

  try {
    switch (command) {
      case 'ps':
      case 'status':
        return await cmdPs(b, flags);

      case 'inbox':
        return await runInbox(
          { orch: b.orch, registry: b.registry },
          { listOnly: flagBool(flags, 'list') },
        );

      case 'log':
        return await cmdLog(b, positionals[1], flags);

      case 'projects':
      case 'project':
        return await cmdProjects(b, positionals.slice(1), flags);

      case 'land':
        return await cmdLand(b, positionals[1]);

      // No `stop` alias: `blue stop` reads like "stop the fleet", and this ends
      // exactly one task.
      case 'cancel':
        return await cmdCancel(b, positionals[1], flags);

      case 'config':
        return cmdConfig(b, positionals.slice(1));

      case 'map':
      case 'starmap':
        return await cmdMap(b, flags);

      case 'gc':
        return await cmdGc(b, flags);

      case 'mcp':
        return await cmdMcp(b);

      default:
        errOut(red(`Unknown command: ${command}`));
        out(usage());
        return 1;
    }
  } finally {
    b.close();
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    errOut(red(`blue: ${errorMessage(e)}`));
    process.exitCode = 1;
  });
