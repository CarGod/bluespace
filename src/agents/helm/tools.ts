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
import type { Decision, Project, Task, TaskKind, TaskState } from '../../types/domain.js';
import type { ProjectRegistry } from '../../config/index.js';
import type { Orchestrator } from '../../orchestrator/index.js';

// ---------------------------------------------------------------------------
// Schema vocabulary (mirrors src/types/domain.ts)
// ---------------------------------------------------------------------------

const TASK_KINDS = ['mission', 'recon'] as const satisfies readonly TaskKind[];

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
    costUsd: usd(t.costUsd),
    reworkCount: t.reworkCount,
    crewId: t.crewId,
    worktree: t.worktree,
    // The deliverable, and the only path here that survives `blue gc`:
    // `worktree` is a directory the captain may reclaim, while a recon's
    // `artifact` is the report archived out of it.
    artifact: t.artifact,
    outcome: t.summary,
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

function countByState(tasks: Task[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tasks) {
    counts[t.state] = (counts[t.state] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Helm's nine tools, described vendor-neutrally.
 *
 * `src/mcp/run.ts` hands them straight to the stdio server, which is what puts
 * them in the captain's Claude Code window as `mcp__bluespace__*`. Nothing here
 * knows that; a second transport would need no change on this side.
 */
export function helmTools(orch: Orchestrator, registry: ProjectRegistry): ToolDef[] {
  const nameOf = (projectId: string): string | undefined => registry.get(projectId)?.name;

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
      'List tasks across the whole fleet with their state, project, cost and dependencies.',
      'Call this before answering any question about what is running, what finished, or what is stuck, and before reporting progress — so what you tell the captain matches what is actually true.',
      'Pass state to narrow to one lifecycle stage.',
    ].join(' '),
    inputSchema: object({
      state: enumOf(TASK_STATES, 'Optional lifecycle filter. Omit to see the whole fleet.'),
    }),
    handler: async (input) => {
      const state = optionalEnum(input, 'state', TASK_STATES);
      const all = orch.tasks();
      const tasks = state === undefined ? all : all.filter((t) => t.state === state);
      return ok({
        filter: state ?? 'all',
        count: tasks.length,
        byState: countByState(all),
        totalCostUsd: usd(all.reduce((sum, t) => sum + t.costUsd, 0)),
        tasks: tasks.map((t) => taskView(t, nameOf(t.projectId))),
      });
    },
  };

  const getTask: ToolDef = {
    name: 'get_task',
    description: [
      'Fetch one task in full: its current state, brief, accumulated cost, rework count, worktree, dependencies, and once it has landed, its artifact and outcome.',
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
      'When the goal itself has changed, cancel the task and create a new one instead — steering a Crew toward a different objective produces worse work than a clean brief.',
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

  const cancelTask: ToolDef = {
    name: 'cancel_task',
    description: [
      'Stop a task, end its Crew, and delete its worktree directory.',
      'Call this when the captain abandons the work, or when you created a task against the wrong project or the wrong goal.',
      'Cancellation is final for the task and cannot be undone. Uncommitted work in the worktree is lost; commits the Crew made survive on the branch, which is kept whenever it holds anything not already in the base branch. If the work is still wanted, create a replacement task in the same turn.',
    ].join(' '),
    inputSchema: object({ taskId: str('Task id to cancel.') }, ['taskId']),
    handler: async (input) => {
      const taskId = requireString(input, 'taskId');
      await orch.cancelTask(taskId);
      const task = orch.task(taskId);
      return ok({ taskId, cancelled: true, state: task?.state ?? 'unknown' });
    },
  };

  return [
    listProjects,
    resolveProject,
    createTask,
    listTasks,
    getTask,
    openDecisions,
    answerDecision,
    steerTask,
    cancelTask,
  ];
}
