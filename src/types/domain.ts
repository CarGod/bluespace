/**
 * BlueSpace domain types.
 *
 * Roles are split by FUNCTION, not by rank:
 *   Captain  — the human. Makes decisions, nothing else.
 *   Helm     — the single agent the captain talks to. Intake + judgement only.
 *   Crew     — a worker. One per task, runs in a disposable git worktree.
 *   Sentinel — an independent verifier. Sees the brief and the diff, never the
 *              Crew's reasoning. That isolation is the whole point.
 *
 * The orchestrator itself is CODE, not an agent. Helm decides *what*; the
 * orchestrator decides *when*, *in what order*, and *what to do when it breaks*.
 */

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export type TaskId = string;
export type CrewId = string;
export type DecisionId = string;
export type ProjectId = string;
export type VerdictId = string;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * What a task is expected to produce.
 *   mission — changes code, produces a local branch in a worktree. Nothing in
 *             BlueSpace pushes it, opens a pull request for it, or merges it;
 *             `Project.delivery` is a hint for the brief, not an action.
 *   recon   — investigates, produces a written report. Never pushes.
 */
export type TaskKind = 'mission' | 'recon';

/**
 * Task lifecycle. Every transition is an event in the Blackbox; the current
 * state is always a projection, never a stored mutable field.
 *
 *   queued ──► dispatched ──► working ──┬──► verifying ──┬──► ready ──► landed
 *                                       │                │
 *                                       ├──► awaiting_decision (blocks on captain)
 *                                       │                │
 *                                       │                └──► needs_rework ──► working
 *                                       └──► failed / cancelled
 */
export type TaskState =
  | 'queued'
  | 'dispatched'
  | 'working'
  | 'awaiting_decision'
  | 'verifying'
  | 'needs_rework'
  | 'ready'
  | 'landed'
  | 'failed'
  | 'cancelled';

/** States from which no further work happens without a new dispatch. */
export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  'landed',
  'failed',
  'cancelled',
] as const;

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

export interface Task {
  id: TaskId;
  kind: TaskKind;
  projectId: ProjectId;
  title: string;
  /** The full brief handed to the Crew as its opening message. */
  brief: string;
  state: TaskState;
  /** Task ids that must reach a terminal-success state before this dispatches. */
  dependsOn: TaskId[];
  createdAt: number;
  updatedAt: number;
  /** Set once dispatched. */
  crewId?: CrewId;
  worktree?: string;
  /** Accumulated USD across every Crew and Sentinel run for this task. */
  costUsd: number;
  /** Verification attempts so far; bounded by orchestrator config. */
  reworkCount: number;
}

// ---------------------------------------------------------------------------
// Dispatch profile — the axes the orchestrator threads into the adapter
// ---------------------------------------------------------------------------

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * Permission posture for a spawned Crew.
 *
 * These are exactly the modes `claude --permission-mode` accepts. That is not a
 * coincidence and not a convenience: BlueSpace launches real Claude Code
 * sessions, so inventing a vocabulary here would only create values that have
 * to be mapped onto the real ones, and a mapping is a place for a mode to
 * quietly become a different mode. If the harness gains a mode, add it here; if
 * it loses one, this list is what fails the build.
 *
 * The two that look right and are not:
 *
 *   `dontAsk` reads like "proceed without prompting". It does the opposite —
 *   it DENIES Edit and Write outright. A Crew launched with it reads the repo,
 *   attempts the change, is refused, and writes an explanation addressed to a
 *   human who is not there. Verified on 2.1.222; see tests/compliance-smoke.
 *
 *   `bypassPermissions` works, but puts a modal warning in front of the first
 *   run that only a human can dismiss — and dismissing it writes a permanent,
 *   machine-wide `bypassPermissionsModeAccepted` into the captain's global
 *   config. An unattended fleet cannot answer it, and it should not be the
 *   price of trying the tool.
 *
 * `auto` is the default because it is the one posture that edits files, runs
 * commands, needs no dialog, and leaves no global state behind.
 */
export type PermissionMode =
  /** Edits and commands proceed unattended, no dialog, no global state. */
  | 'auto'
  /** File edits auto-approved; other tools still prompt. Attended runs only. */
  | 'acceptEdits'
  /** Plans and reports, changes nothing. Useful for a dry run on a new repo. */
  | 'plan'
  /** Prompts on anything sensitive. Only meaningful with a human attached. */
  | 'manual'
  /** Refuses writes. Present because the harness has it — see the note above. */
  | 'dontAsk'
  /** Fully unrestricted. Costs a one-time modal and a global config write. */
  | 'bypassPermissions';

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'auto';

export interface DispatchProfile {
  model?: string;
  effort?: Effort;
  permissionMode: PermissionMode;
  /**
   * USD ceiling for a single run, and ADVISORY unless the adapter says otherwise.
   *
   * The SDK stopped the query at it. An interactive Claude Code session cannot:
   * `--max-budget-usd` is documented "only works with --print", and `--print` is
   * the non-interactive mode `docs/compliance.md` rules out. It is still stated
   * here because it is the captain's number and an adapter that can enforce it
   * must — but the ceiling that actually stops a run is the orchestrator's
   * per-task one, which watches `usage` events. See `#enforceBudget`.
   */
  maxBudgetUsd?: number;
  /**
   * Cap on agentic turns for a single run. Same story as `maxBudgetUsd`: the SDK
   * enforced it, the interactive CLI has no `--max-turns` at all, and the honest
   * backstop is the adapter's turn timeout.
   */
  maxTurns?: number;
}

// ---------------------------------------------------------------------------
// Decisions — the captain's inbox. The product's front page.
// ---------------------------------------------------------------------------

export interface DecisionOption {
  id: string;
  label: string;
  detail?: string;
}

export interface Decision {
  id: DecisionId;
  taskId: TaskId;
  question: string;
  options: DecisionOption[];
  /** Enough context to answer without opening the worktree. */
  context?: string;
  openedAt: number;
  resolvedAt?: number;
  /** Either an option id or free-text from the captain. */
  answer?: string;
}

// ---------------------------------------------------------------------------
// Verification — Sentinel's contract
// ---------------------------------------------------------------------------

export interface Verdict {
  id: VerdictId;
  taskId: TaskId;
  pass: boolean;
  /** Why it passed or failed, in the captain's language. */
  reasoning: string;
  /** Requirements from the brief that the diff does not satisfy. */
  unmet: string[];
  createdAt: number;
  costUsd: number;
}

/**
 * The shape of a verdict, as JSON Schema, handed to the adapter as
 * `SpawnRequest.outputSchema`.
 *
 * It used to be a protocol constraint: the SDK validated the tool call against
 * it, and malformed output was impossible rather than merely caught. On an
 * interactive session it is an INSTRUCTION — the Sentinel is given this schema
 * and a path, and writes a file. So it is quoted to the model verbatim, which is
 * why every `description` here is written to be read by one: they are the only
 * explanation it gets of what each field means.
 */
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    pass: {
      type: 'boolean',
      description: 'True only if the diff satisfies every requirement in the brief.',
    },
    reasoning: {
      type: 'string',
      description: 'One short paragraph explaining the verdict, in plain language.',
    },
    unmet: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Requirements stated in the brief that the diff does not satisfy. Empty when pass is true.',
    },
  },
  required: ['pass', 'reasoning', 'unmet'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

/**
 * How the captain intends to take delivery of a project's branches.
 *
 * METADATA, NOT BEHAVIOUR. Nothing in BlueSpace pushes, opens a pull request, or
 * merges, and `pr` does not change that — it is context Helm can read when it
 * writes a brief (say, to ask for commits shaped for review). Every task ends the
 * same way in either mode: a local branch in a worktree that the captain moves by
 * hand. `pr` is the default only because it is the commoner intent.
 */
export type DeliveryMode = 'pr' | 'local';

export interface Project {
  id: ProjectId;
  name: string;
  /** Absolute path to the repo. BlueSpace references projects in place. */
  path: string;
  /** What the project is, in plain language. Used to route ambiguous requests. */
  description: string;
  delivery: DeliveryMode;
  /** Per-project override of the global permission posture. */
  permissionMode?: PermissionMode;
  defaultBranch?: string;
  addedAt: number;
}
