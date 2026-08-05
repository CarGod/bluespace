/**
 * `blue gc` — reclaim the worktrees whose tasks are over.
 *
 * The rule, in the captain's words: *once the code is merged into its git
 * branch, the worktree can be deleted*. `src/worktree/reclaim.ts` decides that;
 * this module owns only the terminal surface — what to sweep, how to say what
 * happened, and the one interaction that stands between `--force` and somebody's
 * unmerged afternoon.
 *
 * Two things it is careful about.
 *
 * IT REPORTS REFUSALS AS ANSWERS, NOT ERRORS. A worktree kept because its branch
 * has three commits that are not in `main` is the system working. It gets a line
 * that says what to do about it ("merge or delete the branch first"), not a
 * warning colour and an exit code.
 *
 * IT WILL NOT DESTROY UNMERGED WORK WITHOUT A HUMAN. `--force` lists exactly
 * what it is about to take and waits for a typed confirmation. On a
 * non-interactive stdin there is nobody to ask, so it refuses outright unless
 * `--yes` says the captain already decided — a cron job that silently deleted a
 * Crew's only copy of something would be the worst bug this program could have.
 */

import * as readline from 'node:readline';

import type { Project, Task } from '../types/domain.js';
import {
  directorySize,
  reclaimWorktrees,
  sweepOrphanDirectories,
  type KeptEntry,
  type ReclaimResult,
  type ReclaimedEntry,
  type WorktreeManager,
} from '../worktree/index.js';
import { bold, cyan, dim, formatBytes, green, red, shortId, yellow } from './format.js';

export interface GcDeps {
  /**
   * The Blackbox task projection — the authority on what is still live. Read
   * fresh at the start of each sweep.
   *
   * `blue gc` deliberately passes no `livePaths` to the sweep: it is its own
   * process, so it holds no Crew and could only invent one. The projection is
   * enough because terminal task states are absorbing — nothing this reads as
   * finished can go back to running. The residue is the gap between the
   * orchestrator writing `landed` and the Crew process it is closing actually
   * exiting; a worktree in that gap is only touched if it is ALSO clean and
   * already merged, which at the moment a task lands it is not.
   */
  tasks(): Task[];
  projects(): Project[];
  worktreeFor(projectPath: string): WorktreeManager;
  /** `<dataDir>/worktrees` — where every worktree is cut, across all projects. */
  worktreeRoot: string;
}

export interface GcOptions {
  dryRun?: boolean;
  force?: boolean;
  /** Skip the confirmation. The only way to force a sweep without a terminal. */
  yes?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Override the TTY test. Defaults to whether stdin is a terminal. */
  interactive?: boolean;
}

/** Run the sweep. Returns a process exit code. */
export async function runGc(deps: GcDeps, opts: GcOptions = {}): Promise<number> {
  const out = opts.output ?? process.stdout;
  const write = (s = ''): void => {
    out.write(`${s}\n`);
  };

  const force = opts.force === true;
  const dryRun = opts.dryRun === true;

  if (force && !dryRun) {
    // Decide the whole sweep first, so the captain is shown the real list rather
    // than a description of one.
    const plan = await sweep(deps, { force: true, dryRun: true });
    if (plan.reclaimed.length === 0) {
      renderReport(write, deps, plan, {
        dryRun: false,
        bytesInUse: await directorySize(deps.worktreeRoot),
      });
      return plan.errors.length > 0 ? 1 : 0;
    }

    write('');
    write(`${bold(red('blue gc --force'))} will remove ${plural(plan.reclaimed.length, 'worktree')}:`);
    write('');
    for (const entry of plan.reclaimed) write(renderDestruction(entry));
    write('');
    write(dim(`${formatBytes(plan.bytesFreed)} of directories. This cannot be undone.`));

    const confirmed = await confirm(opts, write);
    if (confirmed !== true) return confirmed === false ? 1 : 0;
  }

  const result = await sweep(deps, { force, dryRun });
  // Measured after the sweep, so the total is what is on disk NOW — the number
  // exists to make growth visible, and a stale one would hide exactly that.
  const bytesInUse = await directorySize(deps.worktreeRoot);
  renderReport(write, deps, result, { dryRun, bytesInUse });
  return result.errors.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Sweeping every registered project, plus whatever nobody claims
// ---------------------------------------------------------------------------

/**
 * One manager per registered project, then a pass over the leftovers.
 *
 * The worktree root is shared by every project while a manager only speaks for
 * one repository, so a directory belonging to project B looks unclaimable to
 * project A's manager. Sweeping every project first and handing the union of
 * claimed paths to the orphan pass is what stops A from calling B's live
 * worktree debris.
 */
async function sweep(
  deps: GcDeps,
  opts: { force: boolean; dryRun: boolean },
): Promise<ReclaimResult> {
  const tasks = deps.tasks();
  const merged: ReclaimResult = { reclaimed: [], kept: [], bytesFreed: 0, errors: [] };
  const claimed = new Set<string>();

  for (const project of deps.projects()) {
    let manager: WorktreeManager;
    try {
      manager = deps.worktreeFor(project.path);
    } catch (err) {
      merged.errors.push({ path: project.path, message: errorMessage(err) });
      continue;
    }

    const result = await reclaimWorktrees(manager, tasks, {
      force: opts.force,
      dryRun: opts.dryRun,
    });
    absorb(merged, result, claimed);
  }

  absorb(
    merged,
    await sweepOrphanDirectories(deps.worktreeRoot, {
      claimed,
      force: opts.force,
      dryRun: opts.dryRun,
    }),
    claimed,
  );

  merged.bytesFreed = merged.reclaimed.reduce((sum, e) => sum + e.bytes, 0);
  return merged;
}

/**
 * Fold one pass into the running total, keeping `claimed` current.
 *
 * Paths are deduplicated because two registry entries can point at the same
 * repository, and reporting one worktree twice would double the byte count as
 * well as the line.
 */
function absorb(merged: ReclaimResult, result: ReclaimResult, claimed: Set<string>): void {
  for (const entry of result.reclaimed) {
    if (claimed.has(entry.path)) continue;
    claimed.add(entry.path);
    merged.reclaimed.push(entry);
  }
  for (const entry of result.kept) {
    if (claimed.has(entry.path)) continue;
    claimed.add(entry.path);
    merged.kept.push(entry);
  }
  for (const err of result.errors) merged.errors.push(err);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderReport(
  write: (s?: string) => void,
  deps: GcDeps,
  result: ReclaimResult,
  mode: { dryRun: boolean; bytesInUse: number },
): void {
  write('');

  if (result.reclaimed.length > 0) {
    const verb = mode.dryRun ? 'would reclaim' : 'reclaimed';
    write(
      `${green('✓')} ${verb} ${bold(plural(result.reclaimed.length, 'worktree'))} ${dim(
        `· ${formatBytes(result.bytesFreed)}${mode.dryRun ? ' would be freed' : ' freed'}`,
      )}`,
    );
    for (const entry of result.reclaimed) {
      write(`  ${dim(name(entry.path))}  ${dim(formatBytes(entry.bytes))}  ${describeTaken(entry)}`);
    }
  } else {
    write(dim(mode.dryRun ? 'Nothing would be reclaimed.' : 'Nothing to reclaim.'));
  }

  if (result.kept.length > 0) {
    write('');
    write(`${bold(plural(result.kept.length, 'worktree'))} kept:`);
    for (const entry of result.kept) {
      write(`  ${dim(name(entry.path))}  ${dim(formatBytes(entry.bytes))}  ${describeKept(entry)}`);
    }
  }

  if (result.errors.length > 0) {
    write('');
    write(`${red('!')} ${plural(result.errors.length, 'problem')}:`);
    for (const err of result.errors) write(`  ${dim(name(err.path))}  ${red(err.message)}`);
  }

  // The whole point of printing a total: `~/.bluespace/worktrees` used to grow
  // without bound and nothing ever said so.
  write('');
  write(`${dim(deps.worktreeRoot)}  ${bold(formatBytes(mode.bytesInUse))} ${dim('in use')}`);
  write('');
}

function describeTaken(entry: ReclaimedEntry): string {
  const bits: string[] = [];
  if (entry.branch !== undefined) bits.push(cyan(entry.branch));
  const destroys = entry.destroys;
  if (destroys !== undefined) {
    if (destroys.uncommitted) {
      bits.push(
        red(destroys.baseBranch === undefined ? 'untracked directory destroyed' : 'uncommitted work destroyed'),
      );
    }
    if (destroys.unlandedCommits > 0) {
      bits.push(
        yellow(
          `${plural(destroys.unlandedCommits, 'commit')} not in ${
            destroys.baseBranch ?? 'the base branch'
          }` + (destroys.branchKept ? ` ${dim('(kept on the branch)')}` : ''),
        ),
      );
    }
  } else {
    bits.push(dim('merged'));
  }
  return bits.join(dim(' · '));
}

/** A refusal, said the way the captain would say it, with the way out. */
function describeKept(entry: KeptEntry): string {
  const branch = entry.branch !== undefined ? cyan(entry.branch) : dim('no branch');
  const reason = entry.reason;

  switch (reason.kind) {
    case 'live':
      return `${branch} ${dim('·')} ${yellow('still live')}${
        reason.state !== undefined ? dim(` — task is ${reason.state}`) : ''
      }${reason.taskId !== undefined ? dim(` (${shortId(reason.taskId)})`) : ''}`;

    case 'uncommitted':
      return `${branch} ${dim('·')} ${yellow('uncommitted changes')} ${dim(
        '— commit them, or throw them away with `blue gc --force`',
      )}`;

    case 'unlanded':
      return `${branch} ${dim('·')} ${yellow(
        `${plural(reason.commits, 'commit')} not in ${reason.baseBranch}`,
      )} ${dim('— merge or delete the branch first')}`;

    case 'not-ours':
      // NOT "not a BlueSpace worktree": a `blue/` worktree with a detached HEAD
      // lands here too, and telling the captain it is not ours invites them to
      // delete by hand the one place a Crew's commits sit on no branch.
      return `${dim('a git worktree this sweep does not manage — left alone')}`;

    case 'debris':
      return `${yellow('git does not know this directory')} ${dim(
        '— check it, then remove it by hand or with `blue gc --force`',
      )}`;

    default:
      return dim(unreachable(reason));
  }
}

function renderDestruction(entry: ReclaimedEntry): string {
  const destroys = entry.destroys;
  const head = `  ${bold(name(entry.path))}  ${dim(formatBytes(entry.bytes))}`;
  if (destroys === undefined) {
    return `${head}  ${dim('merged — nothing at risk')}`;
  }
  const losses: string[] = [];
  if (destroys.uncommitted) {
    // No base branch means git never knew this directory at all, so "uncommitted
    // changes" understates it: the whole thing is unrecoverable.
    losses.push(
      destroys.baseBranch === undefined
        ? red('git knows nothing about this directory — all of it goes')
        : red('uncommitted changes — no other copy exists'),
    );
  }
  if (destroys.unlandedCommits > 0) {
    losses.push(
      destroys.branchKept
        ? yellow(
            `${plural(destroys.unlandedCommits, 'commit')} not in ${
              destroys.baseBranch ?? 'the base branch'
            } — kept on ${entry.branch ?? 'the branch'}, but the checkout goes`,
          )
        : yellow(`${plural(destroys.unlandedCommits, 'commit')} not in the base branch`),
    );
  }
  return `${head}  ${losses.join(dim(' · '))}`;
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

/**
 * Ask before destroying. Returns true to proceed, false to refuse (an error the
 * caller reports as a non-zero exit), and undefined when the captain declined —
 * which is a normal outcome, not a failure.
 */
async function confirm(
  opts: GcOptions,
  write: (s?: string) => void,
): Promise<boolean | undefined> {
  if (opts.yes === true) {
    write('');
    write(dim('--yes given; proceeding.'));
    return true;
  }

  const input = opts.input ?? process.stdin;
  const isTty =
    opts.interactive ?? (input === process.stdin && process.stdin.isTTY === true);

  if (!isTty) {
    write('');
    write(red('Refusing: --force needs a confirmation and stdin is not a terminal.'));
    write(dim('Run it in a terminal, or pass --yes if you have already decided.'));
    write('');
    return false;
  }

  write('');
  const answer = await ask(input, opts.output ?? process.stdout, `Type ${bold('yes')} to remove them: `);
  if (answer.trim().toLowerCase() !== 'yes') {
    write('');
    write(dim('Nothing was removed.'));
    write('');
    return undefined;
  }
  return true;
}

function ask(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  prompt: string,
): Promise<string> {
  const rl = readline.createInterface({
    input,
    output,
    terminal: input === process.stdin && process.stdin.isTTY === true,
  });
  return new Promise<string>((resolve) => {
    let settled = false;
    const done = (value: string): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(value);
    };
    // A closed stdin is a "no": there is nobody there to say yes.
    rl.on('close', () => done(''));
    rl.question(prompt, done);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The last path segment — the full path is noise in a list of twenty. */
function name(p: string): string {
  const parts = p.split('/').filter((s) => s !== '');
  return parts.length > 0 ? (parts[parts.length - 1] as string) : p;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function unreachable(reason: never): string {
  return `unknown reason ${JSON.stringify(reason)}`;
}
