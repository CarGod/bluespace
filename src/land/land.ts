/**
 * Landing — merging a verified task's branch into the project's integration
 * branch.
 *
 * ONE IMPLEMENTATION, TWO SURFACES. `blue land <taskId>` and Helm's `land_task`
 * both call `landTask()`; neither has any logic of its own beyond rendering the
 * result. A second copy of these rules would be a second place for "never touch
 * main" to be true on Tuesday and false on Wednesday.
 *
 * The git mechanics — the isolated worktree, the target assertions, the abort —
 * are in `src/worktree/dev.ts`. What lives here is the POLICY:
 *
 *   - only a task the Sentinel passed may land (`ready` or `landed`);
 *   - a recon has no diff and can never land;
 *   - the merge target is the branch RECORDED ON THE PROJECT, never a constant
 *     read at merge time — and a project registered before delivery existed is
 *     adopted here, explicitly, rather than crashing or being silently skipped;
 *   - the merge goes in the Blackbox, because everything else does.
 *
 * This module writes to the captain's repository. It is the only module in
 * BlueSpace that does, and it writes exactly one thing: a merge commit on
 * `blue/dev`.
 */

import type { Blackbox } from '../blackbox/index.js';
import { projectTask } from '../blackbox/index.js';
import type { ProjectRegistry } from '../config/index.js';
import type { Project, Task, TaskId } from '../types/domain.js';
import {
  INTEGRATION_BRANCH,
  ensureIntegrationBranch,
  integrationStatus,
  mergeTaskBranch,
  taskBranchName,
  type IntegrationStatus,
  type WorktreeManager,
} from '../worktree/index.js';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface LandDeps {
  /** The log. The merge is appended here; the task is projected from it. */
  blackbox: Blackbox;
  registry: ProjectRegistry;
  /** The same per-project managers the orchestrator dispatches with. */
  worktreeFor(projectPath: string): WorktreeManager;
}

/**
 * A refusal: the task is not landable, or the project is not in a state where
 * landing means anything. Distinct from a git failure so callers can tell the
 * captain "no, and here is why" instead of "something went wrong".
 */
export class LandRefusedError extends Error {
  constructor(
    message: string,
    /** Short machine-readable cause, e.g. `not_verified`, `recon`. */
    readonly reason: string,
  ) {
    super(message);
    this.name = 'LandRefusedError';
  }
}

/** States from which a task may be landed: the Sentinel has passed its diff. */
const LANDABLE_STATES = new Set<Task['state']>(['ready', 'landed']);

export interface LandReport {
  taskId: TaskId;
  title: string;
  projectId: string;
  project: string;
  repoPath: string;
  /** The task branch that was merged. */
  branch: string;
  /** The integration branch it went into. Never the default branch. */
  devBranch: string;
  /** True when this call adopted the integration branch for a legacy project. */
  adoptedDevBranch: boolean;
  /** Tip of the integration branch after the merge. */
  commit: string;
  /** True when the branch was already contained; nothing moved. */
  alreadyMerged: boolean;
  /** The branch that was NOT touched, by name. */
  defaultBranch: string;
  /** True if the default branch moved meanwhile — the captain committing, not us. */
  defaultBranchMoved: boolean;
  /** Where the integration branch stands afterwards. Feeds the PR reminder. */
  status: IntegrationStatus;
}

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

/**
 * Merge one verified task's branch into its project's integration branch.
 *
 * Throws `LandRefusedError` for anything that is not landable, and the typed
 * errors from `src/worktree/dev.ts` (`MergeConflictError`, `MergeTargetError`,
 * `DevBranchConflictError`) for anything git refuses. A conflict leaves the
 * repository exactly as it was.
 */
export async function landTask(deps: LandDeps, taskId: TaskId): Promise<LandReport> {
  const task = projectTask(deps.blackbox.read(), taskId);
  if (task === undefined) {
    throw new LandRefusedError(`no task with id ${taskId}`, 'unknown_task');
  }

  // A recon produces a report, not a diff. There is no branch worth merging and
  // nothing verified it, so this is a refusal on two counts.
  if (task.kind === 'recon') {
    throw new LandRefusedError(
      `task ${taskId} is a recon: it produced a report, not code. There is nothing to merge, ` +
        `and nothing verified it — a recon has no diff for the Sentinel to grade.`,
      'recon',
    );
  }

  if (!LANDABLE_STATES.has(task.state)) {
    throw new LandRefusedError(
      `task ${taskId} is ${task.state}, not verified. Only a task the Sentinel passed can land ` +
        `(state ready or landed). Nothing was merged.`,
      'not_verified',
    );
  }

  const project = resolveProject(deps, task);
  const worktrees = deps.worktreeFor(project.path);

  // Create-or-adopt, every time. A recorded branch the captain has since
  // deleted (the normal thing to do after a pull request merges) is recreated
  // off the default branch, which is exactly where the next round of work
  // belongs.
  const recorded = project.devBranch;
  const setup = await ensureIntegrationBranch(worktrees, recorded ?? INTEGRATION_BRANCH);
  const devBranch = setup.branch;

  // Pin it on the project the first time it is used, so a future rename of the
  // constant cannot retarget this project's merges.
  let adopted = false;
  if (recorded === undefined) {
    deps.registry.update(project.id, { devBranch });
    adopted = true;
  }

  const branch = taskBranchName(task.id);
  const report = await mergeTaskBranch({
    worktrees,
    branch,
    into: devBranch,
    message: mergeMessage(task, branch, devBranch),
  });

  deps.blackbox.append({
    type: 'task.merged',
    taskId: task.id,
    projectId: project.id,
    branch,
    into: devBranch,
    commit: report.commit,
    repoPath: await worktrees.repoRoot(),
    alreadyMerged: report.alreadyMerged,
  });

  return {
    taskId: task.id,
    title: task.title,
    projectId: project.id,
    project: project.name,
    repoPath: await worktrees.repoRoot(),
    branch,
    devBranch,
    adoptedDevBranch: adopted,
    commit: report.commit,
    alreadyMerged: report.alreadyMerged,
    defaultBranch: report.defaultBranch,
    defaultBranchMoved: report.defaultBranchMoved,
    status: await integrationStatus(worktrees, devBranch),
  };
}

function resolveProject(deps: LandDeps, task: Task): Project {
  const project = deps.registry.get(task.projectId);
  if (project === undefined) {
    throw new LandRefusedError(
      `task ${task.id} belongs to project ${task.projectId}, which is no longer registered. ` +
        `Register it again (\`blue projects add <path>\`) and land it then — the branch is ` +
        `untouched in the meantime.`,
      'unknown_project',
    );
  }
  return project;
}

/**
 * The merge commit message.
 *
 * Written for whoever reads `git log` in six months with no BlueSpace at hand:
 * what landed, which task it was, and what the verifier said about it. The
 * summary comes from the Sentinel's own verdict (it is recorded as the task's
 * summary when the diff passes), so the merge carries its justification.
 *
 * IT STARTS WITH THE WORD `Merge`, AND THAT IS LOAD-BEARING. It used to open
 * with `Land <title>`, which read better and cost a captain two failed landings:
 * their repository's `commit-msg` hook enforces a house format on every commit
 * and exempts git's own merge messages by matching `Merge *` on the first line.
 * A merge commit that does not look like one is a merge commit that hooks,
 * tooling and `git log --oneline` all have to be taught about individually.
 *
 * BlueSpace does NOT pass `--no-verify` here, and should not: the captain's
 * hooks are the captain's, every commit that contains actual work is the Crew's
 * and goes through them inside the worktree, and a fleet that silently disarmed
 * a repository's checks would be a worse neighbour than one that occasionally
 * cannot land. Conforming is the fix; bypassing was not.
 */
function mergeMessage(task: Task, branch: string, into: string): string {
  const lines = [`Merge ${branch} into ${into} — ${task.title}`, '', `Task: ${task.id}`];
  const summary = task.summary?.trim();
  if (summary !== undefined && summary !== '') {
    lines.push('', `Sentinel: ${firstLine(summary, 400)}`);
  }
  return `${lines.join('\n')}\n`;
}

function firstLine(text: string, max: number): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== '')?.trim() ?? '';
  return line.length <= max ? line : `${line.slice(0, max)}…`;
}
