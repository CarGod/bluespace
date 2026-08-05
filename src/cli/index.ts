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
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertClaudeCliAvailable, createClaudeCliAdapter } from '../adapters/claude-cli.js';
import type { HarnessAdapter } from '../adapters/types.js';
import { Blackbox, projectCrewLog } from '../blackbox/index.js';
import {
  PERMISSION_MODES,
  ProjectRegistry,
  configPath,
  loadConfig,
  saveConfig,
} from '../config/index.js';
import type { BlueConfig } from '../config/index.js';
import { Orchestrator } from '../orchestrator/index.js';
import { WorktreeManager } from '../worktree/index.js';
import { isTerminal } from '../types/domain.js';
import type {
  DeliveryMode,
  Effort,
  PermissionMode,
  Project,
  Task,
  TaskState,
} from '../types/domain.js';
import type { BlueEvent } from '../types/events.js';

import { decisionNudge, runInbox } from './inbox.js';
import {
  bold,
  clockTime,
  colourState,
  cyan,
  describeEvent,
  dim,
  formatUsd,
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
    ['mcp', "serve Helm's tools over stdio  ← your Claude Code window runs this"],
    ['inbox', 'answer the decisions waiting on you'],
    ['ps', 'what the fleet is doing, and how to watch a worker'],
    ['log <taskId>', "replay one task's events from the Blackbox"],
    ['map', 'start the Starmap server and print its URL'],
    ['projects', 'list registered projects'],
    ['projects add <path>', 'register a repo  [--name X] [--desc Y] [--delivery pr|local]'],
    ['projects rm <id>', 'forget a project'],
    ['config', 'print the effective config and where it lives'],
    ['config set <k> <v>', 'change one setting (validated)'],
  ];
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) L.push(`  ${padEnd(k, w)}  ${dim(v)}`);
  L.push('');
  L.push(bold('TALKING TO HELM'));
  L.push(`  ${cyan(MCP_ADD_COMMAND)}`);
  L.push(`  ${dim('register once, then say what you want built in your own Claude Code window.')}`);
  L.push(`  ${dim('`blue mcp` is not for typing into: stdout is the protocol stream.')}`);
  L.push('');
  L.push(bold('CONFIG KEYS'));
  // Spelled from the same constants `blue config set` validates against. Help
  // text that lists modes by hand is help text that eventually names one the
  // loader rejects — which is exactly what happened to the last copy of these
  // two lines when PermissionMode was rewritten to mirror the harness.
  L.push(`  ${dim('permissionMode')} ${PERMISSION_MODES.join('|')}`);
  L.push(`  ${dim('effort')} ${EFFORTS.join('|')}   ${dim('model')} <string>`);
  L.push(
    `  ${dim('maxConcurrentCrew')} <int>   ${dim('maxRework')} <int>   ${dim('maxBudgetUsdPerTask')} <number>`,
  );
  L.push('');
  L.push(bold('OPTIONS'));
  L.push(`  -h, --help                  ${dim('this text')}`);
  L.push(`  -V, --version               ${dim('print the version')}`);
  L.push(`      --no-color              ${dim('never emit ANSI colour')}`);
  L.push(`  -f, --follow                ${dim('(log) keep streaming new events')}`);
  L.push(`      --list                  ${dim('(inbox) render only, do not prompt')}`);
  L.push(`      --port <n>              ${dim('(map) port to listen on')}`);
  L.push(`      --orchestrate           ${dim('(map) also run the dispatch loop')}`);
  L.push('');
  return L.join('\n');
}

/**
 * The one line that wires BlueSpace into the captain's Claude Code window.
 *
 * Written out in full rather than described, because the whole product is
 * unreachable until it has been run once and a command you can paste is the
 * difference between a setup step and a support question. `-s user` registers
 * it for every directory: Helm is fleet-wide, and a server scoped to whichever
 * folder the captain happened to be in would vanish the moment they moved.
 */
const MCP_ADD_COMMAND = 'claude mcp add -s user bluespace -- blue mcp';

/** The installed package root — `dist/cli/index.js` sits two levels down. */
function installRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** This exact file, for a captain who needs to spell the MCP command out in full. */
function entryPath(): string {
  return fileURLToPath(import.meta.url);
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
  // not a tradeoff, it is a bug.
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

function cmdPs(b: Boot): number {
  const tasks = b.orch.tasks();
  if (tasks.length === 0) {
    out('');
    out(dim('No tasks yet. Ask Helm for something in your Claude Code window.'));
    out(dim(`Not set up yet? ${MCP_ADD_COMMAND}`));
    out('');
    return 0;
  }

  const sorted = [...tasks].sort((x, y) => {
    const ax = isTerminal(x.state) ? 1 : 0;
    const ay = isTerminal(y.state) ? 1 : 0;
    if (ax !== ay) return ax - ay;
    return y.updatedAt - x.updatedAt;
  });

  const projectName = (id: string): string => {
    const p = safe(() => b.registry.get(id));
    return p ? p.name : shortId(id);
  };

  const rows = sorted.map((t) => [
    `${stateGlyph(t.state)} ${dim(shortId(t.id))}`,
    colourState(t.state),
    cyan(truncate(projectName(t.projectId), 18)),
    truncate(t.title, 46),
    formatUsd(t.costUsd),
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
        { header: 'cost', align: 'right' },
        { header: 'age', align: 'right' },
      ],
      rows,
    ),
  );

  const counts = new Map<TaskState, number>();
  let total = 0;
  for (const t of sorted) {
    counts.set(t.state, (counts.get(t.state) ?? 0) + 1);
    total += t.costUsd;
  }

  const summary = [...counts.entries()]
    .sort((a, b2) => b2[1] - a[1])
    .map(([state, n]) => `${n} ${colourState(state)}`)
    .join(dim(' · '));

  out('');
  out(`${summary}${dim('  ·  ')}${bold(formatUsd(total))} ${dim('spent')}`);

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

function eventLine(e: BlueEvent): string {
  const { label, detail } = describeEvent(e);
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
      `${task.kind} · ${project ? project.name : task.projectId} · ${formatUsd(task.costUsd)} · ${
        task.reworkCount
      } rework · created ${relTime(task.createdAt)}`,
    ) + `  ${colourState(task.state)}`,
  );
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
  for (const e of shown) out(eventLine(e));

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
        if (belongs) out(eventLine(e));
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

function cmdProjects(b: Boot, rest: string[], flags: Flags): number {
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
    out('');
    return 0;
  }

  if (sub === 'add') {
    const raw = rest[1];
    if (raw === undefined) {
      errOut(red('blue projects add needs a path.'));
      return 1;
    }
    const abs = path.resolve(raw);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      errOut(red(`Not a directory: ${abs}`));
      return 1;
    }
    if (!fs.existsSync(path.join(abs, '.git'))) {
      errOut(yellow(`Warning: ${abs} has no .git — Crew worktrees need a git repo.`));
    }

    const deliveryRaw = flagStr(flags, 'delivery');
    if (deliveryRaw !== undefined && deliveryRaw !== 'pr' && deliveryRaw !== 'local') {
      errOut(red(`delivery must be "pr" or "local", got "${deliveryRaw}".`));
      return 1;
    }

    const name = flagStr(flags, 'name') ?? path.basename(abs);
    const description = flagStr(flags, 'desc', 'description') ?? '';

    const input: {
      name: string;
      path: string;
      description: string;
      delivery?: DeliveryMode;
    } = { name, path: abs, description };
    if (deliveryRaw !== undefined) input.delivery = deliveryRaw;

    try {
      const project = b.registry.add(input);
      out('');
      out(`${green('✓')} registered ${bold(project.name)} ${dim(`(${shortId(project.id)})`)}`);
      out(dim(`  ${project.path}  ·  delivery ${project.delivery}`));
      if (project.description.trim() === '') {
        out(
          dim(
            '  No description — Helm routes ambiguous requests by description. Add one with --desc.',
          ),
        );
      }
      out('');
      return 0;
    } catch (e) {
      errOut(red(`Could not register: ${errorMessage(e)}`));
      return 1;
    }
  }

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
  errOut(dim('Try: list | add <path> | rm <id>'));
  return 1;
}

// ---------------------------------------------------------------------------
// blue config
// ---------------------------------------------------------------------------

// Imported, not redeclared. Two copies of an enum drift, and the one that
// drifts is always the one nobody is looking at — here that would mean
// `blue config set` accepting a mode the loader then rejects.
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function printConfig(config: BlueConfig): void {
  const rows: Array<[string, string]> = [
    ['permissionMode', config.permissionMode],
    ['model', config.model ?? dim('(harness default)')],
    ['effort', config.effort ?? dim('(harness default)')],
    ['maxBudgetUsdPerTask', formatUsd(config.maxBudgetUsdPerTask)],
    ['maxConcurrentCrew', String(config.maxConcurrentCrew)],
    ['maxRework', String(config.maxRework)],
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
        'Keys: permissionMode, model, effort, maxConcurrentCrew, maxRework, maxBudgetUsdPerTask',
      ),
    );
    return 1;
  }

  const patch: Partial<BlueConfig> = {};

  switch (key) {
    case 'permissionMode': {
      if (!PERMISSION_MODES.includes(value as PermissionMode)) {
        errOut(red(`permissionMode must be one of: ${PERMISSION_MODES.join(', ')}`));
        return 1;
      }
      patch.permissionMode = value as PermissionMode;
      break;
    }
    case 'model': {
      patch.model = value === '-' || value === 'default' ? undefined : value;
      break;
    }
    case 'effort': {
      if (value === '-' || value === 'default') {
        patch.effort = undefined;
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
    case 'maxBudgetUsdPerTask': {
      const n = Number.parseFloat(value);
      if (!Number.isFinite(n) || n <= 0) {
        errOut(red(`maxBudgetUsdPerTask must be a positive number, got "${value}".`));
        return 1;
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
          'Keys: permissionMode, model, effort, maxConcurrentCrew, maxRework, maxBudgetUsdPerTask',
        ),
      );
      return 1;
    }
  }

  try {
    const next = saveConfig(patch);
    out(`${green('✓')} ${key} = ${bold(String(value))}`);
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
// blue mcp
// ---------------------------------------------------------------------------

/**
 * Hand Helm's tools to the captain's own Claude Code window.
 *
 * This is the front door: the captain talks to Helm in a window they already
 * had, and BlueSpace is a stdio MCP server it launched. Nothing in this function
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
  return await runMcp({ orch: b.orch, registry: b.registry });
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
  out(`${bold('BlueSpace')} ${dim('· you talk to Helm in your own Claude Code window')}`);
  out('');
  out('There is no prompt here any more. Helm is an MCP server that your Claude Code');
  out('window launches, so the session you type into is a real interactive one — which');
  out(`is the whole point; see ${dim(complianceDoc())}.`);
  out('');
  out(bold('Set it up once'));
  out(`  ${cyan(MCP_ADD_COMMAND)}`);
  // The absolute path is worth the ugly line: `blue` is only on PATH after a
  // global install, and this is the exact file that is running right now.
  out(dim(`  blue not on your PATH? Replace \`blue mcp\` with: node ${entryPath()} mcp`));
  out('');
  out(bold('Then'));
  out(`  ${cyan('claude')}${dim('  — in any repo, and say what you want built. Helm briefs the crew.')}`);
  out('');
  out(bold('From this terminal'));
  const rows: Array<[string, string]> = [
    ['blue ps', 'what the fleet is doing, and how to watch a worker'],
    ['blue inbox', 'answer the decisions waiting on you'],
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
        return cmdPs(b);

      case 'inbox':
        return await runInbox(
          { orch: b.orch, registry: b.registry },
          { listOnly: flagBool(flags, 'list') },
        );

      case 'log':
        return await cmdLog(b, positionals[1], flags);

      case 'projects':
      case 'project':
        return cmdProjects(b, positionals.slice(1), flags);

      case 'config':
        return cmdConfig(b, positionals.slice(1));

      case 'map':
      case 'starmap':
        return await cmdMap(b, flags);

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
