/**
 * Helm's tool surface.
 *
 * These are the only levers Helm has on the fleet. Each one is a thin wrapper: it
 * calls the orchestrator (or the project registry), formats the result as text, and
 * returns. No business logic lives here — ordering, retry, budget, dispatch and
 * teardown belong to the orchestrator, which is code.
 *
 * Descriptions are written to say *when* to call a tool, not merely what it does;
 * prescriptive triggers are what actually improve tool selection.
 *
 * Nothing in this file knows which harness runs it. A tool is a `ToolDef`: a name,
 * a description, a JSON Schema, and a handler returning text. The transport turns
 * that into whatever its protocol wants — including catching a throw and reporting
 * it to the model as a tool error, which is why these handlers throw freely. Today
 * that transport is `src/mcp/server.ts`, which returns a throw as `{isError: true}`
 * so Helm can read the message and correct itself.
 */

import type { ToolDef } from '../../adapters/types.js';
import { totalTokens } from '../../types/domain.js';
import type {
  Decision,
  DeliveryMode,
  Project,
  Task,
  TaskKind,
  TaskState,
} from '../../types/domain.js';
import type { Blackbox } from '../../blackbox/index.js';
import {
  findRepositories,
  registerProject,
  registerProjects,
  type ProjectRegistry,
  type RegisterInput,
} from '../../config/index.js';
import { landTask, pendingDelivery, type LandDeps, type PendingDelivery } from '../../land/index.js';
import type { Orchestrator } from '../../orchestrator/index.js';
import type { WorktreeManager } from '../../worktree/index.js';

// ---------------------------------------------------------------------------
// Schema vocabulary (mirrors src/types/domain.ts)
// ---------------------------------------------------------------------------

const TASK_KINDS = ['mission', 'recon'] as const satisfies readonly TaskKind[];

const DELIVERY_MODES = ['pr', 'local'] as const satisfies readonly DeliveryMode[];

const TASK_STATES = [
  'queued',
  'dispatched',
  'working',
  'awaiting_decision',
  'verifying',
  'needs_rework',
  'ready',
  'landed',
  'failed',
  'cancelled',
] as const satisfies readonly TaskState[];

/** Compile-time guard: adding a TaskKind/TaskState without listing it above fails here. */
type MissingKinds = Exclude<TaskKind, (typeof TASK_KINDS)[number]>;
type MissingStates = Exclude<TaskState, (typeof TASK_STATES)[number]>;
const _kindsAreExhaustive: [MissingKinds] extends [never] ? true : MissingKinds = true;
const _statesAreExhaustive: [MissingStates] extends [never] ? true : MissingStates = true;
void _kindsAreExhaustive;
void _statesAreExhaustive;

// ---------------------------------------------------------------------------
// JSON Schema helpers — small on purpose; this is a description format, not a
// validation library.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function object(properties: Json, required: string[] = []): Json {
  const schema: Json = { type: 'object', properties };
  if (required.length > 0) schema['required'] = required;
  return schema;
}

function str(description: string): Json {
  return { type: 'string', description };
}

function enumOf(values: readonly string[], description: string): Json {
  return { type: 'string', enum: [...values], description };
}

function arrayOfStrings(description: string): Json {
  return { type: 'array', items: { type: 'string' }, description };
}

const NO_INPUT: Json = object({});

// ---------------------------------------------------------------------------
// Argument readers
//
// The model supplies these, so they are checked rather than trusted. A throw
// here reaches Helm as a tool error naming the field, which it can correct on
// the next call — far better than a downstream crash on `undefined`.
// ---------------------------------------------------------------------------

function requireString(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required and must be a non-empty string.`);
  }
  return value;
}

function optionalEnum<T extends string>(
  input: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${field} must be one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

function requireEnum<T extends string>(
  input: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = optionalEnum(input, field, allowed);
  if (value === undefined) throw new Error(`${field} is required (one of: ${allowed.join(', ')}).`);
  return value;
}

function optionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  return value.trim() === '' ? undefined : value;
}

function optionalStringArray(
  input: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const value = input[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value as string[];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Every tool answers in text; structured payloads go back as pretty JSON. */
function ok(payload: unknown): string {
  return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
}

function usd(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function iso(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

function projectView(p: Project): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    description: p.description,
    delivery: p.delivery,
    defaultBranch: p.defaultBranch,
    // Where landed work is merged to. Absent on a project registered before
    // delivery existed; it is adopted the first time something lands there.
    devBranch: p.devBranch,
  };
}

/**
 * What a task consumed, in the only unit that is measured.
 *
 * The dollar figure is deliberately keyed DIFFERENTLY depending on whether the
 * run was metered, rather than carrying one `costUsd` field with a caveat
 * beside it. A caveat is something a model can skim; a key named
 * `apiListPriceEquivalentUsd` cannot be reported as spend without noticing.
 * On the default path — the captain's Claude subscription — those tokens drew
 * down a plan quota and no dollar amount was ever charged.
 */
function usageView(t: Task): Record<string, unknown> {
  const tokens = {
    total: totalTokens(t.tokens.totals),
    input: t.tokens.totals.input,
    output: t.tokens.totals.output,
    cacheRead: t.tokens.totals.cacheRead,
    cacheCreation: t.tokens.totals.cacheCreation,
    byModel: Object.fromEntries(
      Object.entries(t.tokens.byModel).map(([model, c]) => [
        model,
        { total: totalTokens(c), ...c },
      ]),
    ),
  };
  if (t.metered) {
    return {
      tokens,
      metered: true,
      costUsd: usd(t.listPriceUsd),
      costNote:
        'Metered run (ANTHROPIC_API_KEY): this is real spend, priced from BlueSpace\'s own list-price table.',
    };
  }
  return {
    tokens,
    metered: false,
    apiListPriceEquivalentUsd: usd(t.listPriceUsd),
    costNote:
      'NOT a cost. This task ran on the captain\'s Claude subscription, where tokens draw down a plan quota and are never billed in dollars. Report tokens by model; quote the equivalent only if asked what the same work would cost on the API.',
  };
}

function taskView(t: Task, projectName?: string): Record<string, unknown> {
  return {
    id: t.id,
    title: t.title,
    kind: t.kind,
    state: t.state,
    projectId: t.projectId,
    project: projectName,
    dependsOn: t.dependsOn,
    ...usageView(t),
    reworkCount: t.reworkCount,
    crewId: t.crewId,
    worktree: t.worktree,
    // The deliverable, and the only path here that survives `blue gc`:
    // `worktree` is a directory the captain may reclaim, while a recon's
    // `artifact` is the report archived out of it.
    artifact: t.artifact,
    outcome: t.summary,
    // Merged is not the same as landed, and Helm has to be able to tell the
    // captain which one happened. Absent until `land_task` merged the branch.
    mergedInto: t.mergedInto,
    mergedAt: iso(t.mergedAt),
    createdAt: iso(t.createdAt),
    updatedAt: iso(t.updatedAt),
  };
}

function decisionView(d: Decision): Record<string, unknown> {
  return {
    id: d.id,
    taskId: d.taskId,
    question: d.question,
    options: d.options.map((o) => ({ id: o.id, label: o.label, detail: o.detail })),
    context: d.context,
    openedAt: iso(d.openedAt),
    answer: d.answer,
    resolvedAt: iso(d.resolvedAt),
  };
}

/**
 * The same accounting for a whole fleet. Split by metering rather than summed:
 * a fleet with one API-key task and twenty subscription ones has no single
 * dollar figure, and adding them would report the quota draw-down as money.
 */
function fleetUsageView(tasks: Task[]): Record<string, unknown> {
  let total = 0;
  const byModel: Record<string, number> = {};
  let meteredUsd = 0;
  let unmeteredUsd = 0;
  for (const t of tasks) {
    total += totalTokens(t.tokens.totals);
    for (const [model, c] of Object.entries(t.tokens.byModel)) {
      byModel[model] = (byModel[model] ?? 0) + totalTokens(c);
    }
    if (t.metered) meteredUsd += t.listPriceUsd;
    else unmeteredUsd += t.listPriceUsd;
  }
  return {
    totalTokens: total,
    tokensByModel: byModel,
    ...(meteredUsd > 0 ? { meteredCostUsd: usd(meteredUsd) } : {}),
    ...(unmeteredUsd > 0
      ? {
          subscriptionApiListPriceEquivalentUsd: usd(unmeteredUsd),
          subscriptionNote:
            'Subscription tasks have no dollar cost; the figure above is what their tokens would cost at API list price.',
        }
      : {}),
  };
}

function countByState(tasks: Task[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tasks) {
    counts[t.state] = (counts[t.state] ?? 0) + 1;
  }
  return counts;
}

/**
 * The pull-request reminder, in its short form.
 *
 * Carried on `list_tasks` because that is the tool Helm must call before saying
 * anything about the fleet: a reminder that rides on a tool nobody is obliged to
 * call is a reminder that never arrives. The `gh` command deliberately is NOT
 * here — see `delivery_status` — because it is long, and because the captain has
 * not asked for it yet at the moment this fires.
 */
function deliveryView(entries: PendingDelivery[]): Record<string, unknown> | undefined {
  if (entries.length === 0) return undefined;
  return {
    projects: entries.map((d) => ({
      projectId: d.projectId,
      project: d.project,
      devBranch: d.devBranch,
      defaultBranch: d.defaultBranch,
      landedTasksNotInDefaultBranch: d.tasks,
      commitsAhead: d.commits,
      commitsBehind: d.behind,
    })),
    note:
      'Verified work is merged and waiting on a pull request the captain opens by hand — BlueSpace ' +
      'does not open one. Worth ONE clause the first time you notice it in a session, phrased as an ' +
      'offer, not a prompt. Do not repeat it, and never make it the lead. Call delivery_status when ' +
      'they want the command.',
  };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * What the tools need beyond the orchestrator and the registry.
 *
 * Only the delivery tools use these — landing is the one thing Helm does that
 * reaches a real repository, and it needs a git manager to do it and the log to
 * record it. Required rather than optional: a tool surface that silently loses
 * `land_task` because a caller forgot an argument is worse than a compile error.
 */
export interface HelmToolDeps {
  /** The append-only log. `land_task` records the merge here. */
  blackbox: Blackbox;
  /** The same per-project managers the orchestrator dispatches with. */
  worktreeFor(projectPath: string): WorktreeManager;
}

/**
 * Every tool name, in one place a module with no dependencies can read.
 *
 * Exists for `HELM_ALLOWED_TOOLS` in the launcher: the window pre-approves these
 * by their prefixed names, and the launcher has no orchestrator with which to
 * build a real tool surface and ask. `helmTools()` checks the two agree on every
 * call rather than trusting this to be maintained.
 */
export const HELM_TOOL_NAMES: readonly string[] = [
  'list_projects',
  'resolve_project',
  'create_task',
  'list_tasks',
  'get_task',
  'open_decisions',
  'answer_decision',
  'steer_task',
  'amend_task',
  'cancel_task',
  'land_task',
  'delivery_status',
  'add_project',
  'add_projects',
  'describe_project',
  'remove_project',
];

/**
 * Helm's tools, described vendor-neutrally.
 *
 * `src/mcp/run.ts` hands them straight to the stdio server, which is what puts
 * them in the captain's Claude Code window as `mcp__bluespace__*`. Nothing here
 * knows that; a second transport would need no change on this side.
 *
 * Fifteen of them now, and exactly three reach the captain's repository at all:
 * `land_task`, the only tool in BlueSpace's history that writes a COMMIT, and
 * `add_project` / `add_projects`, which create the `blue/dev` ref and nothing
 * else. That is the same boundary `CLAUDE.md` states; if a fourth ever writes,
 * both have to change together. `describe_project` and `remove_project` write
 * only to BlueSpace's own registry, described so plainly that Helm can promise
 * the captain, truthfully, that neither touches a single file in the repository.
 */
export function helmTools(
  orch: Orchestrator,
  registry: ProjectRegistry,
  deps: HelmToolDeps,
): ToolDef[] {
  const nameOf = (projectId: string): string | undefined => registry.get(projectId)?.name;
  const landDeps: LandDeps = {
    blackbox: deps.blackbox,
    registry,
    worktreeFor: deps.worktreeFor,
  };

  /** Best effort: a git failure must never take down a plain fleet read. */
  const delivery = async (projectId?: string): Promise<PendingDelivery[]> => {
    try {
      return await pendingDelivery(
        landDeps,
        projectId === undefined ? {} : { projectId },
      );
    } catch {
      return [];
    }
  };

  const listProjects: ToolDef = {
    name: 'list_projects',
    description: [
      'List every project registered with BlueSpace, with its name, absolute path, description and delivery mode.',
      'Call this when the captain asks what projects exist, when you are about to ask them to disambiguate and want to name real candidates, or when a project id you were given does not resolve.',
      'For routing a single request to a project, resolve_project is cheaper and ranks the candidates for you.',
    ].join(' '),
    inputSchema: NO_INPUT,
    handler: async () => {
      const projects = registry.list();
      return ok({ count: projects.length, projects: projects.map(projectView) });
    },
  };

  const resolveProject: ToolDef = {
    name: 'resolve_project',
    description: [
      'Rank registered projects against a free-text hint: a project name, a fragment of one, a subject area, a file path, or the captain\'s own words for what they want changed.',
      'Call this at the start of any request whose project the captain did not name explicitly, before creating a task.',
      'Exactly one candidate means proceed and name that project in your reply so the captain can correct you; several or none means ask them one short question with the candidates named.',
    ].join(' '),
    inputSchema: object(
      { hint: str('What the captain said, or the part of it that identifies the project.') },
      ['hint'],
    ),
    handler: async (input) => {
      const hint = requireString(input, 'hint');
      const matches = registry.resolveScored(hint);
      return ok({
        hint,
        count: matches.length,
        candidates: matches.map((m) => ({ ...projectView(m.project), score: m.score })),
      });
    },
  };

  const createTask: ToolDef = {
    name: 'create_task',
    description: [
      'Create a task and queue it for dispatch. This is the only thing that starts a Crew; nothing else does.',
      'Call this once you know the project and the shape of the work. Call it several times in one turn when the work splits into pieces that can run at the same time.',
      "kind is 'mission' for anything that changes code (the default, and most work) and 'recon' for investigation that produces a report and never pushes.",
      'The brief is the entire context the Crew will have: state the goal, the constraints that are not obvious from the code, and what done looks like, without referring to this conversation.',
      'Pass dependsOn only for tasks that genuinely cannot be written until another task\'s outcome exists — not merely because two tasks touch the same file.',
    ].join(' '),
    inputSchema: object(
      {
        kind: enumOf(
          TASK_KINDS,
          "'mission' changes code and produces a branch; 'recon' investigates and produces a report.",
        ),
        projectId: str(
          'Project id from the registry. Resolve it first if the captain did not name the project.',
        ),
        title: str('Short label the captain would still recognize a week from now.'),
        brief: str('The full, self-contained instruction handed to the Crew as its opening message.'),
        dependsOn: arrayOfStrings(
          'Task ids that must succeed first. Semantic dependencies only; omit otherwise so the work runs in parallel.',
        ),
      },
      ['kind', 'projectId', 'title', 'brief'],
    ),
    handler: async (input) => {
      const kind = requireEnum(input, 'kind', TASK_KINDS);
      const projectId = requireString(input, 'projectId');
      const title = requireString(input, 'title');
      const brief = requireString(input, 'brief');
      const dependsOn = optionalStringArray(input, 'dependsOn');

      // Checked here rather than left to dispatch. The orchestrator does reject
      // an unknown project — with `unknown_project:<id>`, minutes later, on a
      // task this handler already reported as queued. A throw reaches Helm now,
      // naming the ids that exist, and costs one corrected call.
      if (!registry.get(projectId)) {
        const known = registry.list();
        throw new Error(
          `No project with id ${projectId}. ` +
            (known.length > 0
              ? `Registered ids: ${known.map((p) => p.id).join(', ')}. Use resolve_project if you are unsure which one the captain means.`
              : `No projects are registered — the captain adds one with \`blue projects add <path>\`.`),
        );
      }

      const task = orch.createTask({ kind, projectId, title, brief, dependsOn });
      return ok({
        created: taskView(task, nameOf(task.projectId)),
        note: 'Queued. The orchestrator dispatches it once its dependencies are satisfied and there is capacity.',
      });
    },
  };

  const listTasks: ToolDef = {
    name: 'list_tasks',
    description: [
      'List tasks across the whole fleet with their state, project, token usage by model, and dependencies.',
      'Call this before answering any question about what is running, what finished, or what is stuck, and before reporting progress — so what you tell the captain matches what is actually true.',
      'Pass state to narrow to one lifecycle stage.',
      'It also reports pendingDelivery when landed work is sitting on a project\'s integration branch and is not in the default branch yet — that is the pull-request reminder; read the note it carries before mentioning it.',
    ].join(' '),
    inputSchema: object({
      state: enumOf(TASK_STATES, 'Optional lifecycle filter. Omit to see the whole fleet.'),
    }),
    handler: async (input) => {
      const state = optionalEnum(input, 'state', TASK_STATES);
      const all = orch.tasks();
      const tasks = state === undefined ? all : all.filter((t) => t.state === state);
      const pending = deliveryView(await delivery());
      return ok({
        filter: state ?? 'all',
        count: tasks.length,
        byState: countByState(all),
        ...fleetUsageView(all),
        ...(pending !== undefined ? { pendingDelivery: pending } : {}),
        tasks: tasks.map((t) => taskView(t, nameOf(t.projectId))),
      });
    },
  };

  const getTask: ToolDef = {
    name: 'get_task',
    description: [
      'Fetch one task in full: its current state, brief, tokens consumed by model, rework count, worktree, dependencies, and once it has landed, its artifact and outcome.',
      'Call this when the captain asks about a specific piece of work, and before saying that any single task is finished — the state here is the only thing that entitles you to say so.',
      "artifact is the deliverable: the branch name for a mission, and for a recon the path of the report, which was archived out of the worktree and is what you should read. Prefer it over worktree, which is a directory `blue gc` may have reclaimed. A landed recon with no artifact wrote no report — say that rather than guessing.",
    ].join(' '),
    inputSchema: object({ taskId: str('Task id returned by create_task or list_tasks.') }, [
      'taskId',
    ]),
    handler: async (input) => {
      const taskId = requireString(input, 'taskId');
      const task = orch.task(taskId);
      if (!task) throw new Error(`No task with id ${taskId}. Use list_tasks to see current task ids.`);
      // The brief is carried here and nowhere else: it is what you dispatched, and
      // it is far too long to repeat once per row in list_tasks.
      return ok({ ...taskView(task, nameOf(task.projectId)), brief: task.brief });
    },
  };

  const openDecisions: ToolDef = {
    name: 'open_decisions',
    description: [
      'List the decisions currently waiting on the captain, each with its question, options and context.',
      'Call this whenever the captain asks what needs them, at the start of a session where work was already in flight, and any time the fleet looks stalled — a stalled fleet is usually a task blocked on a decision.',
    ].join(' '),
    inputSchema: NO_INPUT,
    handler: async () => {
      const decisions = orch.openDecisions();
      return ok({ count: decisions.length, decisions: decisions.map(decisionView) });
    },
  };

  const answerDecision: ToolDef = {
    name: 'answer_decision',
    description: [
      'Resolve one open decision with the captain\'s answer and unblock the task waiting on it.',
      'Call this as soon as the captain has answered — the task stays blocked until you do.',
      'answer is either the id of an option that was offered or the captain\'s own words. Do not answer on their behalf; if their reply is ambiguous, ask which option they meant.',
    ].join(' '),
    inputSchema: object(
      {
        decisionId: str('Decision id from open_decisions.'),
        answer: str('An offered option id, or the captain\'s verbatim answer.'),
      },
      ['decisionId', 'answer'],
    ),
    handler: async (input) => {
      const decisionId = requireString(input, 'decisionId');
      const answer = requireString(input, 'answer');
      await orch.resolveDecision(decisionId, answer);
      return ok({ decisionId, answer, resolved: true });
    },
  };

  const steerTask: ToolDef = {
    name: 'steer_task',
    description: [
      'Push a message into a Crew that is already running: a correction, a constraint that surfaced after dispatch, or an answer the Crew is waiting on.',
      'Call this when the captain changes their mind about work in flight and the change is small enough for the Crew to absorb without restarting.',
      'When the change alters what "done" means — an extra requirement, a different target, a constraint the diff must satisfy — use `amend_task` instead: steering moves the Crew but leaves the Sentinel grading the old brief, so the Crew does as it is told and then fails verification for it.',
      'Cancel and start again only when the goal is genuinely a different job; a Crew half redirected produces worse work than a stranger with a clean brief, but a NEW TASK COSTS THE WHOLE CYCLE AGAIN.',
      'Only works while the task is actually running.',
    ].join(' '),
    inputSchema: object(
      {
        taskId: str('Task id of a running task.'),
        message: str('The guidance, written for the Crew rather than the captain.'),
      },
      ['taskId', 'message'],
    ),
    handler: async (input) => {
      const taskId = requireString(input, 'taskId');
      const message = requireString(input, 'message');
      await orch.steer(taskId, message);
      return ok({ taskId, steered: true, message });
    },
  };

  const amendTask: ToolDef = {
    name: 'amend_task',
    description: [
      'Change what a task is FOR, while it is still in flight: an extra requirement, a constraint that surfaced after dispatch, a correction to the goal.',
      'Call this when the captain refines work they already asked for: "actually, also do X", "no, not like that", "and make sure it handles Y".',
      'It appends to the task\'s brief, so the Sentinel grades the diff against the job as it now stands, and it pushes the same words into the Crew if one is running.',
      'PREFER THIS OVER A NEW TASK. A fresh task pays for the whole cycle again — a Crew that re-reads the repository, re-derives the plan, and re-verifies from nothing, which is tens of minutes and millions of tokens. Amending costs one turn of a Crew that already has all of that in its head.',
      'Use `steer_task` instead only when the message changes nothing about what "done" means — an answer to a question, a hint about where to look, a nudge on style.',
      'It refuses on a landed, failed or cancelled task: their briefs are the question a verdict was already measured against. Create a task for genuinely new work.',
    ].join(' '),
    inputSchema: object(
      {
        taskId: str('Task id of a task that has not finished.'),
        addendum: str(
          'What changed, written for the Crew and specific enough for the Sentinel to check. Not a summary of the conversation.',
        ),
      },
      ['taskId', 'addendum'],
    ),
    handler: async (input) => {
      const taskId = requireString(input, 'taskId');
      const addendum = requireString(input, 'addendum');
      const outcome = await orch.amendTask(taskId, addendum);
      const task = orch.task(taskId);
      return ok({
        taskId,
        amended: true,
        amendments: task?.amendments ?? 1,
        deliveredToCrew: outcome.deliveredToCrew,
        state: task?.state ?? 'unknown',
        note: outcome.deliveredToCrew
          ? 'The brief now includes it and the running Crew has been told.'
          : 'The brief now includes it. No Crew is running, so it applies when the task dispatches.',
      });
    },
  };

  const cancelTask: ToolDef = {
    name: 'cancel_task',
    description: [
      'Stop a task, end its Crew, and delete its worktree directory.',
      'Call this when the captain abandons the work, or when you created a task against the wrong project or the wrong goal.',
      'Cancellation is final for the task and cannot be undone. Uncommitted work in the worktree is lost; commits the Crew made survive on the branch, which is kept whenever it holds anything not already in the base branch. If the work is still wanted, create a replacement task in the same turn.',
      'It REFUSES, changing nothing, when the Crew is running in a different process — a second Helm window, or a `blue map --orchestrate`. Stopping a session needs the handle, and only the process that spawned it has one. Tell the captain where to cancel it rather than trying again; a task marked cancelled while its Crew keeps working is the one failure they cannot see.',
    ].join(' '),
    inputSchema: object({ taskId: str('Task id to cancel.') }, ['taskId']),
    handler: async (input) => {
      const taskId = requireString(input, 'taskId');
      await orch.cancelTask(taskId);
      const task = orch.task(taskId);
      return ok({ taskId, cancelled: true, state: task?.state ?? 'unknown' });
    },
  };

  // -------------------------------------------------------------------------
  // Delivery — the only tools that reach a real repository
  // -------------------------------------------------------------------------

  const landTaskTool: ToolDef = {
    name: 'land_task',
    description: [
      "Merge one verified task's branch into its project's integration branch (`blue/dev`), in a temporary worktree BlueSpace owns and deletes afterwards.",
      'Call this ONLY when the captain has said to land it — "合并吧", "land it", "merge that one". Never on your own initiative, never because a task looks finished, and never for several tasks because they asked about one.',
      'IT NEVER TOUCHES THE DEFAULT BRANCH. Nothing in BlueSpace merges into main; main is reached only through a pull request the captain opens by hand. It also never touches the captain\'s own checkout — the merge happens in a separate worktree, so uncommitted work in their working copy is not at risk.',
      'It REFUSES, changing nothing: a task the Sentinel did not pass (anything not ready or landed), a recon (it produced a report, not a diff, and nothing verified it), a task whose project is no longer registered, and any merge that conflicts — a conflict aborts and reports the conflicting files, leaving both branches exactly as they were.',
      'Those refusals are NOT a licence to call it and let it decide. The one thing they do not cover is the only one that matters here: a merge the captain did not ask for succeeds, and it is a real commit in their repository.',
      'Re-landing the SAME task is harmless — the second call reports the branch is already contained and merges nothing. That is idempotence, not permission to land anything else.',
      'After it lands, say what merged and into what, and never call it shipped, pushed, deployed or merged to main.',
    ].join(' '),
    inputSchema: object(
      { taskId: str('Task id of a verified (ready or landed) mission.') },
      ['taskId'],
    ),
    handler: async (input) => {
      const taskId = requireString(input, 'taskId');
      const report = await landTask(landDeps, taskId);
      return ok({
        landed: {
          taskId: report.taskId,
          title: report.title,
          project: report.project,
          branch: report.branch,
          mergedInto: report.devBranch,
          mergeCommit: report.commit,
          alreadyMerged: report.alreadyMerged,
          repo: report.repoPath,
        },
        untouched: {
          defaultBranch: report.defaultBranch,
          note: `${report.defaultBranch} was not written to. Landing never merges into it.`,
          ...(report.defaultBranchMoved
            ? {
                warning: `${report.defaultBranch} moved while this merge ran — that is someone committing in the repository, not BlueSpace.`,
              }
            : {}),
        },
        ...(report.adoptedDevBranch
          ? {
              adoptedDevBranch: `${report.devBranch} is now recorded as this project's integration branch; it was registered before delivery existed.`,
            }
          : {}),
        pendingDelivery: {
          devBranch: report.devBranch,
          defaultBranch: report.status.defaultBranch,
          commitsAhead: report.status.ahead,
          commitsBehind: report.status.behind,
          note: 'Say what landed. Mention the pull request only as an offer, and only once per session — call delivery_status if they want the command.',
        },
      });
    },
  };

  const deliveryStatus: ToolDef = {
    name: 'delivery_status',
    description: [
      "Report what is waiting to be delivered: the landed tasks sitting on each project's integration branch that the default branch does not have yet, with their briefs, the Sentinel's verdicts, and the exact `gh pr create` command that opens the pull request.",
      'Call this when the captain asks about a pull request, asks what is waiting to go out, says to open one, or when they take up a reminder you raised from list_tasks.',
      'BlueSpace does NOT open the pull request. Hand the captain the command and let them run it; there is no tool here that pushes or opens one.',
      'An empty result means nothing is waiting — say that rather than inventing a reason.',
    ].join(' '),
    inputSchema: object({
      projectId: str('Optional project id. Omit for every project with work waiting.'),
    }),
    handler: async (input) => {
      const projectId = optionalString(input, 'projectId');
      const entries = await pendingDelivery(landDeps, {
        detail: true,
        ...(projectId !== undefined ? { projectId } : {}),
      });
      return ok({
        count: entries.length,
        projects: entries,
        note:
          entries.length === 0
            ? 'Nothing is waiting for delivery: no landed task is sitting on an integration branch outside the default branch.'
            : 'prCommand is for the captain to run in their own shell. BlueSpace does not push and does not open pull requests.',
      });
    },
  };

  // -------------------------------------------------------------------------
  // Fleet management — registry metadata, and nothing but
  // -------------------------------------------------------------------------

  const addProject: ToolDef = {
    name: 'add_project',
    description: [
      'Register ONE git repository with BlueSpace so tasks can be created against it, by absolute path.',
      'Call this when the captain names a single repository and you already have its description — otherwise call add_projects, which takes a list or a directory to scan and registers them all in one call. Never call this one in a loop.',
      'THIS REGISTERS A REFERENCE. BlueSpace works on repos in place: it does not copy, move, clone, modify or delete the repository, and it does not change any file in it. The one thing it writes is the `blue/dev` integration branch, created off the default branch if it is not already there — a branch ref, no commits, no working-tree changes.',
      'It refuses a path that is not a git repository root, one already registered, and a repository with a branch named `blue` (git cannot hold both `blue` and `blue/dev`, and every task branch is `blue/<taskId>`) — the captain has to rename that branch first.',
      'A description is what resolve_project routes ambiguous requests by, so it is worth having — but it is NOT a precondition. Register now; fill it in with describe_project when you know.',
    ].join(' '),
    inputSchema: object(
      {
        path: str('Absolute path to the repository root — the directory containing .git.'),
        name: str('Short name the captain uses for it. Defaults to the directory name.'),
        description: str(
          'What the project is, in one line. Used to route ambiguous requests. Omit it rather than delaying the registration to go and find out.',
        ),
        delivery: enumOf(
          DELIVERY_MODES,
          "How the captain takes delivery. Metadata only — nothing here pushes or opens a PR. Defaults to 'pr'.",
        ),
      },
      ['path'],
    ),
    handler: async (input) => {
      const repoPath = requireString(input, 'path');
      const name = optionalString(input, 'name');
      const description = optionalString(input, 'description');
      const deliveryMode = optionalEnum(input, 'delivery', DELIVERY_MODES);

      const outcome = await registerProject(
        { registry, worktreeFor: deps.worktreeFor },
        {
          path: repoPath,
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(deliveryMode !== undefined ? { delivery: deliveryMode } : {}),
        },
      );

      // A single registration reports its refusal as a tool ERROR rather than a
      // result. The captain asked for this one repository; a `{ok:false}` object
      // is something a model can skim past and report as done. `add_projects`
      // is the opposite case — there, a refusal is one row of a report.
      if (!outcome.ok) throw new Error(`${repoPath}: ${outcome.message}`);

      return ok({
        registered: projectView(outcome.project),
        devBranch: outcome.devBranchCreated
          ? `created ${outcome.devBranch} off ${outcome.base}`
          : `adopted the existing ${outcome.devBranch}`,
        note: 'The repository was not moved, copied or modified. BlueSpace references it in place.',
        ...(outcome.project.description === ''
          ? {
              missingDescription:
                'Registered with no description, which is what resolve_project routes by. Fill it in with describe_project once you know what this project is.',
            }
          : {}),
      });
    },
  };

  const addProjects: ToolDef = {
    name: 'add_projects',
    description: [
      'Register MANY git repositories in one call: a list of paths, a directory to scan for repositories, or both.',
      'Call this the moment the captain names more than one repository, or a directory of them — "把 ~/aulp 目录下所有的项目都加入管理", "add everything under ~/code". It is one call and one turn; calling add_project eight times is eight round trips the captain waits through.',
      'scan looks at the directories directly inside the path given and takes the ones that are git repository roots. It does not recurse — a deep walk finds vendored checkouts and submodules nobody asked to manage. Pass paths for anything the scan would not reach.',
      'DESCRIPTIONS ARE NOT REQUIRED AND SHOULD NOT DELAY THIS. Registration is immediate; a description is enrichment. Register first, then fill them in with describe_project — reading a repository per project to write one is the part worth doing in parallel sub-agents, not in this turn.',
      'Each path is independent and nothing throws: the result lists what registered, what was already registered, what is not a git repository root, and what is blocked by a branch named `blue`. Report the registered count first and the refusals as a short list.',
      'Same guarantees as add_project, per repository: nothing is copied, moved or modified, and the one write is the `blue/dev` branch ref.',
    ].join(' '),
    inputSchema: object({
      paths: arrayOfStrings(
        'Absolute paths to repository roots. Combine freely with scan; duplicates are reported as already registered rather than added twice.',
      ),
      scan: str(
        'A directory whose immediate subdirectories are searched for git repository roots — the captain\'s ~/code or ~/aulp. One level only.',
      ),
      delivery: enumOf(
        DELIVERY_MODES,
        "Delivery mode applied to every project in this call. Metadata only. Defaults to 'pr'.",
      ),
    }),
    handler: async (input) => {
      const paths = optionalStringArray(input, 'paths') ?? [];
      const scan = optionalString(input, 'scan');
      const deliveryMode = optionalEnum(input, 'delivery', DELIVERY_MODES);

      const scanned = scan === undefined ? [] : findRepositories(scan);
      if (scan !== undefined && scanned.length === 0 && paths.length === 0) {
        throw new Error(
          `No git repositories directly inside ${scan}. The scan takes the subdirectories that are repository roots and does not recurse — check the path, or pass the repositories in \`paths\`.`,
        );
      }
      if (paths.length === 0 && scan === undefined) {
        throw new Error('Give either paths (an array of repository roots) or scan (a directory to search).');
      }

      // Order matters only for the report; the captain's own list comes first
      // because it is the part they typed. Duplicates between the two fall out
      // as `already_registered` on the second sighting rather than being
      // silently dropped, which is the honest thing to show.
      const inputs: RegisterInput[] = [...paths, ...scanned].map((p) => ({
        path: p,
        ...(deliveryMode !== undefined ? { delivery: deliveryMode } : {}),
      }));

      const outcomes = await registerProjects({ registry, worktreeFor: deps.worktreeFor }, inputs);
      const registered: Record<string, unknown>[] = [];
      const refusals: Record<string, unknown>[] = [];
      for (const outcome of outcomes) {
        if (outcome.ok) registered.push(projectView(outcome.project));
        else refusals.push({ path: outcome.path, reason: outcome.reason, detail: outcome.message });
      }

      return ok({
        registered: registered.length,
        refused: refusals.length,
        ...(scan !== undefined ? { scanned: { directory: scan, repositoriesFound: scanned.length } } : {}),
        projects: registered,
        refusals,
        note:
          registered.length === 0
            ? 'Nothing was registered. Read the refusals — "already_registered" is not a failure.'
            : 'Registered with no descriptions. resolve_project routes by description, so fill them in with describe_project; reading each repository to write one line is work to fan out, not to do here.',
      });
    },
  };

  const describeProject: ToolDef = {
    name: 'describe_project',
    description: [
      "Set or replace a registered project's one-line description, and optionally its name — the text resolve_project ranks ambiguous requests against.",
      'Call this after a bulk add_projects, once you know what each repository actually is, and whenever the captain corrects what a project is for.',
      'This writes ONE field in BlueSpace\'s own registry. It does not touch the repository, its branches or any file in it.',
      'Finding out what a repository is by reading it is exactly the work to hand to parallel sub-agents — one per project, each returning a sentence — and then call this once per answer.',
    ].join(' '),
    inputSchema: object(
      {
        projectId: str('Project id from list_projects, resolve_project or add_projects.'),
        description: str('What the project is, in one line, in the terms the captain would use.'),
        name: str('Optional new short name, if the directory name was not what they call it.'),
      },
      ['projectId', 'description'],
    ),
    handler: async (input) => {
      const projectId = requireString(input, 'projectId');
      const description = requireString(input, 'description');
      const name = optionalString(input, 'name');

      if (!registry.get(projectId)) {
        throw new Error(
          `No project with id ${projectId}. Use list_projects to see the registered ids.`,
        );
      }

      const project = registry.update(projectId, {
        description,
        ...(name !== undefined ? { name } : {}),
      });
      return ok({
        updated: projectView(project),
        note: 'Registry metadata only. Nothing in the repository was read, moved or changed by this call.',
      });
    },
  };

  const removeProject: ToolDef = {
    name: 'remove_project',
    description: [
      'Unregister a project: BlueSpace forgets where the repository is and stops offering it as a destination for work.',
      'Call this ONLY when the captain has asked for the project itself to be unregistered — "remove that project", "unlink it", "deregister it", "stop tracking that repo", "别管这个项目了". Never on your own initiative.',
      'Pausing is not unregistering. "Stop working on X", "park that for now", "deprioritise it", "cancel that task" are all about WORK, not about the registry: answer them with cancel_task or with nothing at all. Unregistering is what breaks every task id already pointing at it, and the captain did not ask for that.',
      'THIS DELETES NOTHING. It removes one entry from BlueSpace\'s own registry file. The repository, its branches (including `blue/dev` and any `blue/<taskId>`), its worktrees, its history and every file in it are left exactly as they are — you can tell the captain that plainly. add_project puts it straight back.',
      'Two consequences worth saying out loud: tasks already in the log keep pointing at a project id that no longer resolves, and `blue gc` stops managing that repository\'s worktrees, so any disk they hold stays held until it is registered again.',
    ].join(' '),
    inputSchema: object({ projectId: str('Project id from list_projects or resolve_project.') }, [
      'projectId',
    ]),
    handler: async (input) => {
      const projectId = requireString(input, 'projectId');
      const project = registry.get(projectId);
      if (!project) {
        throw new Error(
          `No project with id ${projectId}. Use list_projects to see the registered ids.`,
        );
      }
      registry.remove(projectId);
      return ok({
        unregistered: projectView(project),
        note: `BlueSpace no longer references ${project.path}. Nothing on disk was moved, modified or deleted.`,
      });
    },
  };

  const tools = [
    listProjects,
    resolveProject,
    createTask,
    listTasks,
    getTask,
    openDecisions,
    answerDecision,
    steerTask,
    amendTask,
    cancelTask,
    landTaskTool,
    deliveryStatus,
    addProject,
    addProjects,
    describeProject,
    removeProject,
  ];

  // The launcher pre-approves these by name so the opening turn is not a
  // permission dialog (`HELM_ALLOWED_TOOLS`), and it cannot construct a tool
  // surface to read the names off — it has no orchestrator. A tool added here
  // and forgotten there prompts on first use, months later, in front of whoever
  // calls it first. This is the check that fails instead, at startup, always.
  const declared = new Set(HELM_TOOL_NAMES);
  const actual = tools.map((t) => t.name);
  const missing = actual.filter((n) => !declared.has(n));
  const stale = HELM_TOOL_NAMES.filter((n) => !actual.includes(n));
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `helmTools() and HELM_TOOL_NAMES disagree — ` +
        `${missing.length > 0 ? `not declared: ${missing.join(', ')}. ` : ''}` +
        `${stale.length > 0 ? `declared but absent: ${stale.join(', ')}.` : ''}`,
    );
  }

  return tools;
}
