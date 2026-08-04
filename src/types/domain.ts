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
 *   mission — changes code, produces a branch (and optionally a PR).
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

/** States where the fleet is blocked on the captain, not on compute. */
export const BLOCKED_TASK_STATES: readonly TaskState[] = ['awaiting_decision'] as const;

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
 * BlueSpace defaults to `bypassPermissions` (fully autonomous — the point of
 * the tool), and the captain can dial it back per project or globally in
 * config. `bypassPermissions` additionally requires
 * `allowDangerouslySkipPermissions: true` on the SDK call; the adapter sets
 * that automatically and it is NOT a separate knob.
 */
export type PermissionMode =
  | 'default'
  | 'dontAsk'
  | 'plan'
  | 'bypassPermissions'
  | 'async';

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'bypassPermissions';

export interface DispatchProfile {
  model?: string;
  effort?: Effort;
  permissionMode: PermissionMode;
  /** Hard USD ceiling for a single Crew run. The SDK stops the query at it. */
  maxBudgetUsd?: number;
  /** Hard cap on agentic turns for a single Crew run. */
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
 * JSON Schema handed to the Sentinel via the SDK's `outputFormat`, so the
 * verdict is validated at the tool-call layer instead of parsed out of prose.
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
