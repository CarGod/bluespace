/**
 * `blue inbox` — the decision inbox.
 *
 * This is the screen that replaces switching between terminal windows. Every
 * Crew that gets stuck opens a Decision instead of stalling silently; this
 * module renders the whole queue in one place — question, numbered options,
 * which task and project it belongs to, how long it has been waiting — and
 * lets the captain answer right there, by number or free text.
 *
 * Owns rendering and stdin interaction only. Resolution goes through
 * `Orchestrator.resolveDecision`, which appends the event and unblocks the task.
 */

import * as readline from 'node:readline';

import type { Decision, Project, Task } from '../types/domain.js';
import type { Orchestrator } from '../orchestrator/index.js';
import type { ProjectRegistry } from '../config/index.js';
import {
  bold,
  colourState,
  cyan,
  dim,
  formatDuration,
  green,
  indent,
  plural,
  relTime,
  shortId,
  yellow,
} from './format.js';

export interface InboxDeps {
  orch: Orchestrator;
  registry: ProjectRegistry;
}

export interface InboxOptions {
  /** Render the queue and exit without prompting. */
  listOnly?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** What the captain typed, normalized. */
type Reply =
  | { kind: 'answer'; answer: string }
  | { kind: 'skip' }
  | { kind: 'quit' }
  | { kind: 'eof' };

/**
 * Run the inbox. Returns a process exit code.
 * Exits 0 when there is nothing waiting — with one cheerful line.
 */
export async function runInbox(deps: InboxDeps, opts: InboxOptions = {}): Promise<number> {
  const out = opts.output ?? process.stdout;
  const write = (s: string): void => {
    out.write(`${s}\n`);
  };

  const open = deps.orch.openDecisions();

  if (open.length === 0) {
    write(green('All clear — nothing is waiting on you. ✦'));
    return 0;
  }

  write('');
  write(
    `${bold(yellow(String(open.length)))} ${
      open.length === 1 ? 'decision is' : 'decisions are'
    } waiting on you.`,
  );

  if (opts.listOnly) {
    for (const [i, decision] of open.entries()) {
      write('');
      write(renderDecision(decision, i + 1, open.length, deps));
    }
    write('');
    write(dim('Run `blue inbox` without --list to answer them.'));
    return 0;
  }

  const input = opts.input ?? process.stdin;
  const rl = readline.createInterface({
    input,
    output: out,
    terminal: input === process.stdin && process.stdin.isTTY === true,
  });
  const reader = new LineReader(rl);

  let answered = 0;
  let skipped = 0;
  let quit = false;

  try {
    for (const [i, decision] of open.entries()) {
      // A decision can be resolved out from under us by Helm or the Starmap
      // while we are sitting here; re-check before spending the captain's time.
      if (!deps.orch.openDecisions().some((d) => d.id === decision.id)) {
        continue;
      }

      write('');
      write(renderDecision(decision, i + 1, open.length, deps));
      write('');

      const reply = await promptFor(reader, rl, decision, out);

      if (reply.kind === 'quit' || reply.kind === 'eof') {
        quit = true;
        skipped += open.length - i;
        break;
      }
      if (reply.kind === 'skip') {
        skipped++;
        write(dim('  skipped'));
        continue;
      }

      try {
        await deps.orch.resolveDecision(decision.id, reply.answer);
        answered++;
        write(`  ${green('✓')} answered: ${bold(reply.answer)}`);
      } catch (err) {
        skipped++;
        write(`  ${yellow('!')} could not resolve: ${errorMessage(err)}`);
      }
    }
  } finally {
    rl.close();
  }

  write('');
  const parts: string[] = [];
  if (answered > 0) parts.push(green(plural(answered, 'decision') + ' answered'));
  if (skipped > 0) parts.push(dim(plural(skipped, 'decision') + ' still waiting'));
  write(parts.length > 0 ? parts.join(dim(' · ')) : dim('Nothing changed.'));
  if (quit && skipped > 0) write(dim('Run `blue inbox` again when you are ready.'));
  write('');

  return 0;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderDecision(
  decision: Decision,
  index: number,
  total: number,
  deps: InboxDeps,
): string {
  const task = safeTask(deps.orch, decision.taskId);
  const project = task ? safeProject(deps.registry, task.projectId) : undefined;
  const lines: string[] = [];

  lines.push(dim(`── ${index}/${total} ${'─'.repeat(Math.max(0, 52 - String(index + total).length))}`));
  lines.push('');
  lines.push(indent(bold(decision.question), 2));
  lines.push('');

  if (decision.context && decision.context.trim() !== '') {
    for (const line of decision.context.trim().split('\n')) {
      lines.push(indent(dim(line), 2));
    }
    lines.push('');
  }

  const meta: Array<[string, string]> = [];
  meta.push([
    'task',
    task
      ? `${task.title} ${dim(`(${shortId(task.id)})`)} ${colourState(task.state)}`
      : dim(shortId(decision.taskId)),
  ]);
  meta.push(['project', project ? cyan(project.name) : dim(task?.projectId ?? 'unknown')]);
  meta.push(['waiting', yellow(formatDuration(Date.now() - decision.openedAt))]);
  meta.push(['opened', dim(relTime(decision.openedAt))]);

  const labelWidth = Math.max(...meta.map(([k]) => k.length));
  for (const [k, v] of meta) {
    lines.push(indent(`${dim(k.padEnd(labelWidth))}  ${v}`, 2));
  }

  if (decision.options.length > 0) {
    lines.push('');
    for (const [i, opt] of decision.options.entries()) {
      lines.push(indent(`${bold(String(i + 1))}) ${opt.label}`, 2));
      if (opt.detail && opt.detail.trim() !== '') {
        lines.push(indent(dim(opt.detail.trim()), 7));
      }
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Buffers every line readline emits.
 *
 * `rl.question` registers a *one-shot* listener, so on a non-TTY stdin — where
 * the whole pipe flushes in a single tick — any line after the first is
 * dropped on the floor. Queueing lines as they arrive makes `blue inbox`
 * scriptable (`printf '1\n2\n' | blue inbox`) as well as interactive.
 */
class LineReader {
  private readonly buffered: string[] = [];
  private readonly waiters: Array<(line: string | null) => void> = [];
  private closed = false;

  constructor(rl: readline.Interface) {
    rl.on('line', (line: string) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.buffered.push(line);
    });
    rl.on('close', () => {
      this.closed = true;
      while (this.waiters.length > 0) this.waiters.shift()?.(null);
    });
  }

  /** Next line, or `null` once the input is exhausted. */
  next(): Promise<string | null> {
    const buffered = this.buffered.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

async function promptFor(
  reader: LineReader,
  rl: readline.Interface,
  decision: Decision,
  out: NodeJS.WritableStream,
): Promise<Reply> {
  const n = decision.options.length;
  const hint =
    n > 0
      ? `${dim('Answer')} ${bold(n === 1 ? '1' : `1-${n}`)}${dim(', free text, [s]kip, [q]uit')}`
      : dim('Type your answer, or [s]kip, [q]uit');

  for (;;) {
    out.write(`${hint}\n`);
    rl.setPrompt('› ');
    rl.prompt();
    const raw = await reader.next();
    if (raw === null) return { kind: 'eof' };

    const line = raw.trim();
    if (line === '') return { kind: 'skip' };

    const lower = line.toLowerCase();
    if (lower === 's' || lower === 'skip') return { kind: 'skip' };
    if (lower === 'q' || lower === 'quit' || lower === 'exit') return { kind: 'quit' };

    if (n > 0 && /^\d+$/.test(line)) {
      const pick = Number.parseInt(line, 10);
      const option = decision.options[pick - 1];
      if (option === undefined) {
        out.write(`${yellow(`  There is no option ${pick}. Pick 1-${n}, or type an answer.`)}\n`);
        continue;
      }
      return { kind: 'answer', answer: option.id };
    }

    return { kind: 'answer', answer: line };
  }
}

// ---------------------------------------------------------------------------
// Lookups that must never throw mid-render
// ---------------------------------------------------------------------------

function safeTask(orch: Orchestrator, id: string): Task | undefined {
  try {
    return orch.task(id);
  } catch {
    return undefined;
  }
}

function safeProject(registry: ProjectRegistry, id: string): Project | undefined {
  try {
    return registry.get(id);
  } catch {
    return undefined;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One-line nudge used by the interactive Helm session after every turn. */
export function decisionNudge(open: Decision[]): string | undefined {
  if (open.length === 0) return undefined;
  const oldest = open.reduce((a, b) => (a.openedAt <= b.openedAt ? a : b));
  const waited = formatDuration(Date.now() - oldest.openedAt);
  return `${yellow('◆')} ${bold(plural(open.length, 'decision'))} waiting${
    open.length === 1 ? '' : ` (oldest ${waited})`
  } — run ${bold('blue inbox')}${dim(' or ask me to show them')}`;
}
