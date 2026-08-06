/**
 * Pending delivery — how much verified work is sitting on `blue/dev` waiting
 * for a pull request.
 *
 * The captain's policy has two halves. Work merges into `blue/dev`
 * automatically once he says so; `main` is reached **only** through a pull
 * request that he opens himself. BlueSpace does not open it, cannot open it, and
 * has no tool that could. What it can do is notice — and say once — that
 * `blue/dev` is three verified tasks ahead of `main`.
 *
 * So this module answers exactly one question, in two depths:
 *
 *   summary — "N landed tasks on blue/dev are not in main yet". Cheap enough to
 *             ride along on `list_tasks`, which is the tool Helm is REQUIRED to
 *             call before reporting fleet state. A reminder that depends on an
 *             optional extra call is a reminder that never fires.
 *   detail  — the same thing plus the tasks, their briefs, the Sentinel's
 *             verdicts, and the exact `gh pr create` command. Fetched when the
 *             captain asks for it, because a multi-line shell command on every
 *             fleet read is tokens spent on something nobody asked for yet.
 *
 * IT GOES QUIET BY ITSELF. Pending-ness is measured by asking git whether each
 * merge commit is an ancestor of the default branch, so the moment the captain's
 * pull request merges, the count drops to zero without anybody telling BlueSpace
 * that it happened.
 *
 * Nothing here writes. Every git invocation is a read through the argv-array
 * helper, and the `gh` command is a STRING FOR A HUMAN TO PASTE — BlueSpace
 * never runs it.
 */

import type { Blackbox } from '../blackbox/index.js';
import { projectTasks } from '../blackbox/index.js';
import type { Task, TaskId } from '../types/domain.js';
import type { BlueEvent } from '../types/events.js';
import { INTEGRATION_BRANCH, integrationStatus, isMergedInto } from '../worktree/index.js';

import type { LandDeps } from './land.js';

/** One landed task that is on the integration branch and not yet in main. */
export interface DeliveredTask {
  taskId: TaskId;
  title: string;
  branch: string;
  mergeCommit: string;
  /** First paragraph of the brief — what was asked for. */
  brief: string;
  /** The Sentinel's reasoning for passing it, when the log carries one. */
  verdict?: string;
}

export interface PendingDelivery {
  projectId: string;
  project: string;
  repoPath: string;
  devBranch: string;
  defaultBranch: string;
  /** Landed tasks merged into the integration branch and not yet in main. */
  tasks: number;
  /** Commits on the integration branch the default branch does not have. */
  commits: number;
  /** Commits on the default branch the integration branch does not have. */
  behind: number;
  /** Detail, only when it was asked for. */
  landed?: DeliveredTask[];
  /**
   * The command that opens the pull request, ready to paste. Absent when the
   * repository has no `origin` — there is nowhere to open one.
   */
  prCommand?: string;
}

export interface DeliveryOptions {
  /** Include the landed tasks and the `gh pr create` command. */
  detail?: boolean;
  /** Limit to one project. */
  projectId?: string;
}

/**
 * Every project with verified work waiting to be delivered, newest merge last.
 *
 * A project is only considered when the log says BlueSpace has actually merged
 * something into it, which bounds the git work to projects in active delivery:
 * a fleet that has landed nothing does no git at all here.
 */
export async function pendingDelivery(
  deps: LandDeps,
  opts: DeliveryOptions = {},
): Promise<PendingDelivery[]> {
  const merges = deps.blackbox.read({ types: ['task.merged'] });
  if (merges.length === 0) return [];

  const byProject = new Map<string, MergeRecord[]>();
  for (const event of merges) {
    if (event.type !== 'task.merged') continue;
    if (opts.projectId !== undefined && event.projectId !== opts.projectId) continue;
    const list = byProject.get(event.projectId) ?? [];
    // One entry per task: landing something twice (or re-landing after a PR)
    // must not count it twice.
    const existing = list.findIndex((m) => m.taskId === event.taskId);
    const record: MergeRecord = {
      taskId: event.taskId,
      branch: event.branch,
      into: event.into,
      commit: event.commit,
    };
    if (existing >= 0) list[existing] = record;
    else list.push(record);
    byProject.set(event.projectId, list);
  }

  const out: PendingDelivery[] = [];
  for (const [projectId, records] of byProject) {
    const entry = await describeProject(deps, projectId, records, opts);
    if (entry !== undefined) out.push(entry);
  }
  return out;
}

interface MergeRecord {
  taskId: TaskId;
  branch: string;
  into: string;
  commit: string;
}

async function describeProject(
  deps: LandDeps,
  projectId: string,
  records: MergeRecord[],
  opts: DeliveryOptions,
): Promise<PendingDelivery | undefined> {
  const project = deps.registry.get(projectId);
  // Unregistered since the merge: not a fleet the captain is being reminded
  // about, and `worktreeFor` has no path to work with.
  if (project === undefined) return undefined;

  const devBranch = project.devBranch ?? records[records.length - 1]?.into ?? INTEGRATION_BRANCH;

  try {
    const worktrees = deps.worktreeFor(project.path);
    const status = await integrationStatus(worktrees, devBranch);
    if (!status.exists || status.ahead === 0) return undefined;

    const defaultRef = await worktrees.defaultBranchRef();
    const pending: MergeRecord[] = [];
    for (const record of records) {
      if (!(await isMergedInto(worktrees, record.commit, defaultRef))) pending.push(record);
    }
    // Ahead by commits nobody here landed (a hand-pushed commit on the
    // integration branch) is not something to nag the captain about.
    if (pending.length === 0) return undefined;

    const entry: PendingDelivery = {
      projectId,
      project: project.name,
      repoPath: project.path,
      devBranch,
      defaultBranch: status.defaultBranch,
      tasks: pending.length,
      commits: status.ahead,
      behind: status.behind,
    };

    if (opts.detail === true) {
      const landed = describeTasks(deps.blackbox.read(), pending);
      entry.landed = landed;
      if (status.hasOrigin) {
        entry.prCommand = pullRequestCommand({
          repoPath: project.path,
          devBranch,
          defaultBranch: status.defaultBranch,
          project: project.name,
          landed,
        });
      }
    }
    return entry;
  } catch {
    // A repository that has moved or been deleted is not a reason to fail a
    // fleet read. It simply has no deliverable state to report.
    return undefined;
  }
}

/** Titles, briefs and verdicts for the pending tasks, in merge order. */
function describeTasks(events: BlueEvent[], pending: MergeRecord[]): DeliveredTask[] {
  const tasks = projectTasks(events);
  const verdicts = new Map<TaskId, string>();
  for (const e of events) {
    if (e.type === 'sentinel.verdict' && e.pass) verdicts.set(e.taskId, e.reasoning);
  }

  return pending.map((record) => {
    const task: Task | undefined = tasks.get(record.taskId);
    const entry: DeliveredTask = {
      taskId: record.taskId,
      title: task?.title ?? record.taskId,
      branch: record.branch,
      mergeCommit: record.commit,
      brief: firstParagraph(task?.brief ?? '', 400),
    };
    const verdict = verdicts.get(record.taskId) ?? task?.summary;
    if (verdict !== undefined && verdict.trim() !== '') {
      entry.verdict = firstParagraph(verdict, 300);
    }
    return entry;
  });
}

// ---------------------------------------------------------------------------
// The command the captain pastes
// ---------------------------------------------------------------------------

/**
 * Build the `gh pr create` invocation, body and all.
 *
 * A string, for a human, to paste into their own shell. BlueSpace does not open
 * the pull request in this version and does not execute this — which is also
 * why single-quoting it correctly matters: the captain is going to run it.
 */
export function pullRequestCommand(input: {
  repoPath: string;
  devBranch: string;
  defaultBranch: string;
  project: string;
  landed: DeliveredTask[];
}): string {
  const { repoPath, devBranch, landed } = input;
  // `origin/main` is what the manager calls a default branch with no local
  // copy; a pull request base is the branch name on the remote.
  const base = input.defaultBranch.replace(/^origin\//, '');

  const title =
    landed.length === 1 && landed[0] !== undefined
      ? landed[0].title
      : `${input.project}: ${landed.length} landed tasks`;

  const body = [
    `Landed on \`${devBranch}\` by BlueSpace. Every task below was verified by an independent Sentinel against its brief.`,
    '',
    ...landed.flatMap((task) => [
      `### ${task.title}`,
      '',
      `Branch \`${task.branch}\` · merge \`${task.mergeCommit.slice(0, 12)}\``,
      '',
      task.brief === '' ? '_No brief recorded._' : `**Brief.** ${task.brief}`,
      ...(task.verdict !== undefined ? ['', `**Sentinel.** ${task.verdict}`] : []),
      '',
    ]),
  ].join('\n');

  return [
    `cd ${shellQuote(repoPath)}`,
    `git push -u origin ${shellQuote(devBranch)}`,
    `gh pr create --base ${shellQuote(base)} --head ${shellQuote(devBranch)} --title ${shellQuote(title)} --body ${shellQuote(body)}`,
  ].join(' && \\\n  ');
}

/**
 * POSIX single-quoting: wrap in single quotes, and close/escape/reopen for each
 * embedded quote. Nothing inside single quotes is interpreted by a shell, so a
 * task title containing `$(rm -rf ~)` is text and stays text.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function firstParagraph(text: string, max: number): string {
  const paragraph = text
    .split(/\r?\n\s*\r?\n/)
    .map((p) => p.trim())
    .find((p) => p !== '');
  const flat = (paragraph ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}
