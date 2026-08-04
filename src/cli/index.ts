#!/usr/bin/env node
/**
 * `blue` — the BlueSpace command line.
 *
 * This module owns the terminal surface of BlueSpace: argv parsing (by hand, no
 * framework), the interactive Helm session, and the read-only views over the
 * Blackbox (`ps`, `log`, `inbox`, `map`). It composes the other modules and
 * holds no domain logic of its own — every state change goes through the
 * Orchestrator, and every fact it prints is a projection over the event log.
 *
 * No vendor SDK appears here. The interactive Helm session is an
 * `adapter.converse()` — the captain's turns go in as strings and come back as
 * `AdapterEvent`s, and which harness is underneath is the adapter's business.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { assertClaudeCliAvailable, createClaudeAdapter } from '../adapters/claude.js';
import { requireCapability, type HarnessAdapter } from '../adapters/types.js';
import { Blackbox, projectCrewLog } from '../blackbox/index.js';
import { ProjectRegistry, configPath, loadConfig, saveConfig } from '../config/index.js';
import type { BlueConfig } from '../config/index.js';
import { Orchestrator } from '../orchestrator/index.js';
import { WorktreeManager } from '../worktree/index.js';
import { isTerminal } from '../types/domain.js';
import type {
  DeliveryMode,
  DispatchProfile,
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
  formatDuration,
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
 * BlueSpace runs its crews through the captain's own Claude CLI, so the one hard
 * requirement is that the CLI is installed and signed in. The SDK spawns it
 * lazily, which means a missing or signed-out CLI would otherwise surface as a
 * dead crew partway through a task — after a worktree exists and the captain has
 * been told work started. Checking here turns that into one sentence at startup.
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
  L.push(`  blue                        ${dim('talk to Helm (interactive session)')}`);
  L.push(`  blue <command> [options]`);
  L.push('');
  L.push(bold('COMMANDS'));
  const rows: Array<[string, string]> = [
    ['inbox', 'answer the decisions waiting on you  ← start here'],
    ['ps', 'what the fleet is doing right now'],
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
  L.push(bold('CONFIG KEYS'));
  L.push(
    `  ${dim('permissionMode')} default|dontAsk|plan|bypassPermissions|async   ${dim('model')} <string>`,
  );
  L.push(
    `  ${dim('effort')} low|medium|high|xhigh|max   ${dim('maxConcurrentCrew')} <int>   ${dim('maxRework')} <int>`,
  );
  L.push(`  ${dim('maxBudgetUsdPerTask')} <number>`);
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

function version(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8');
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
  const adapter = createClaudeAdapter();

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

function cmdPs(b: Boot): number {
  const tasks = b.orch.tasks();
  if (tasks.length === 0) {
    out('');
    out(dim('No tasks yet. Run `blue` and tell Helm what you want built.'));
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

const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'dontAsk',
  'plan',
  'bypassPermissions',
  'async',
];
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
// Interactive Helm session
// ---------------------------------------------------------------------------

/** `mcp__tools__create_task` reads better as `create_task`. */
function prettyToolName(name: string): string {
  const m = /^mcp__[^_]+__(.+)$/.exec(name);
  return m?.[1] ?? name;
}

const HELM_BANNER = [
  '',
  `${bold('BlueSpace')} ${dim('· you talk to Helm; Helm briefs the crew')}`,
  dim('  /ps  /inbox  /help  /exit    ctrl-c to stand down'),
  '',
].join('\n');

async function runHelm(): Promise<number> {
  // Nothing here is worth booting without a usable CLI, and the failure must be a
  // sentence rather than a stack trace. Local read-only commands (ps, config,
  // projects, log) deliberately do NOT go through this — they never spawn an agent.
  if (!requireClaudeCli()) return 1;

  const b = boot();

  const helm = await import('../agents/helm/index.js');

  // A harness that cannot host a conversation cannot run Helm. Say so here,
  // before the orchestrator starts and before the captain types anything.
  requireCapability(b.adapter, 'conversation');

  // The orchestrator is code and runs for as long as the captain is at the helm.
  b.orch.start();

  const abort = new AbortController();

  // Helm does intake and judgement, never Crew work: it needs no budget or turn
  // ceiling of its own, and the model is the captain's global choice.
  const profile: DispatchProfile = { permissionMode: 'bypassPermissions' };
  if (b.config.model !== undefined) profile.model = b.config.model;

  const convo = await b.adapter.converse({
    systemPrompt: helm.HELM_SYSTEM_PROMPT,
    tools: helm.helmTools(b.orch, b.registry),
    cwd: process.cwd(),
    profile,
    signal: abort.signal,
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
    historySize: 250,
  });
  const PROMPT = process.stdin.isTTY === true ? `${cyan('›')} ` : '';
  rl.setPrompt(PROMPT);

  let busy = false;
  let wroteTurnOutput = false;
  let atLineStart = true;
  let exitCode = 0;
  let finished = false;
  /**
   * stdin reached EOF while there was still work to do.
   *
   * A pipe delivers its buffered lines and then closes immediately, so `close`
   * lands while the first turn is still running. Shutting down there would
   * discard the answer the captain piped in and asked for. Instead we remember
   * that no more input is coming and exit once the queue has drained.
   */
  let inputClosed = false;
  let resolveDone: (code: number) => void = () => undefined;
  const done = new Promise<number>((resolve) => {
    resolveDone = resolve;
  });

  const shutdown = (code: number): void => {
    if (finished) return;
    finished = true;
    exitCode = code;
    out('');
    out(dim('Standing down. Every decision and every dollar is in the Blackbox.'));
    try {
      abort.abort();
    } catch {
      /* already aborted */
    }
    void convo.close().catch(() => undefined);
    rl.close();
    b.close();
    resolveDone(exitCode);
  };

  const readyForInput = (): void => {
    busy = false;
    wroteTurnOutput = false;
    atLineStart = true;
    if (finished) return;
    const nudge = decisionNudge(b.orch.openDecisions());
    if (nudge !== undefined) out(nudge);
    // Piped input: the queue is empty and stdin is gone, so this was the last turn.
    if (inputClosed) {
      shutdown(0);
      return;
    }
    rl.resume();
    rl.prompt();
  };

  // ---- Helm's output stream -----------------------------------------------

  /** Open the turn's output block once, then track whether the cursor is at column 0. */
  const beginOutput = (): void => {
    if (!wroteTurnOutput) {
      wroteTurnOutput = true;
      atLineStart = true;
      out('');
    }
  };

  const emit = (text: string): void => {
    beginOutput();
    process.stdout.write(text);
    atLineStart = text.endsWith('\n');
  };

  const emitLine = (text: string): void => {
    beginOutput();
    process.stdout.write(`${atLineStart ? '' : '\n'}${text}\n`);
    atLineStart = true;
  };

  /**
   * Lines the captain got in ahead of the turn they belong after.
   *
   * A conversation runs one turn at a time — sending into a live turn is
   * refused, not interleaved — and `rl.pause()` only holds back a TTY. A pipe
   * delivers whatever it has buffered, so those lines wait here and go out as
   * their own turns rather than colliding with the one in flight.
   */
  const queued: string[] = [];

  /**
   * One turn: hand the captain's line to the conversation and render the events
   * it streams back. The iterable ends with the turn — the session behind it
   * stays up for the next line.
   */
  const runTurn = async (line: string): Promise<void> => {
    const startedAt = Date.now();
    let costUsd = 0;

    try {
      for await (const ev of convo.send(line)) {
        if (finished) break;

        switch (ev.type) {
          case 'text':
            if (ev.text.trim() !== '') emit(ev.text);
            break;
          case 'tool_use':
            emitLine(dim(`  · ${prettyToolName(ev.name)}`));
            break;
          case 'usage':
            costUsd = ev.costUsd;
            break;
          case 'exit': {
            if (wroteTurnOutput && !atLineStart) process.stdout.write('\n');
            if (!ev.ok) out(red(`  Helm stopped: ${ev.reason ?? 'unknown error'}`));
            out(dim(`  ${formatUsd(costUsd)} · ${formatDuration(Date.now() - startedAt)}`));
            break;
          }
          default:
            break;
        }
      }
    } catch (e: unknown) {
      if (finished) return;
      errOut('');
      errOut(red(`Helm session ended: ${errorMessage(e)}`));
      shutdown(1);
      return;
    }

    if (finished) return;

    const next = queued.shift();
    if (next !== undefined) {
      wroteTurnOutput = false;
      atLineStart = true;
      void runTurn(next);
      return;
    }

    readyForInput();
  };

  // ---- The captain's input ------------------------------------------------
  const handleLocal = (line: string): boolean => {
    switch (line) {
      case '/exit':
      case '/quit':
        shutdown(0);
        return true;
      case '/help':
        out(usage());
        return true;
      case '/ps':
        cmdPs(b);
        return true;
      case '/inbox':
        void runInbox({ orch: b.orch, registry: b.registry }, { listOnly: true });
        return true;
      default:
        return false;
    }
  };

  rl.on('line', (raw) => {
    const line = raw.trim();
    if (line === '') {
      if (!busy) rl.prompt();
      return;
    }
    if (line.startsWith('/') && handleLocal(line)) {
      if (!busy && !finished) rl.prompt();
      return;
    }
    if (busy) {
      queued.push(line);
      return;
    }
    busy = true;
    wroteTurnOutput = false;
    rl.pause();
    void runTurn(line);
  });

  rl.on('close', () => {
    if (finished) return;
    // Work still in flight (a pipe, or Ctrl-D mid-turn): let it finish, then exit.
    if (busy || queued.length > 0) {
      inputClosed = true;
      return;
    }
    shutdown(0);
  });

  // readline swallows SIGINT when the terminal is attached, so listen on both.
  rl.on('SIGINT', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  out(HELM_BANNER);
  const nudge = decisionNudge(b.orch.openDecisions());
  if (nudge !== undefined) {
    out(nudge);
    out('');
  }
  rl.prompt();

  const code = await done;
  // The harness subprocess can outlive the stream; do not hang the terminal.
  setTimeout(() => process.exit(code), 1500).unref();
  return code;
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

  if (command === undefined) return await runHelm();

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
