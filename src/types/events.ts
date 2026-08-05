/**
 * Blackbox event schema — the single source of truth for the whole system.
 *
 * Everything the captain ever sees is a projection over this log. There is no
 * separate mutable state table: task state, cost, the decision inbox, and the
 * Starmap views are all derived by folding events. That is what makes the UI
 * cheap to build and the system honest about what actually happened.
 *
 * Rules:
 *  - Events are append-only and never edited.
 *  - Every event carries `at` (epoch ms) and a monotonic `seq` assigned by the
 *    store on append. Consumers order by `seq`, never by `at`.
 *  - Adding a field is fine. Changing the meaning of one is not — add a new
 *    event type instead.
 */

import type {
  CrewId,
  DecisionId,
  DecisionOption,
  Effort,
  PermissionMode,
  ProjectId,
  TaskId,
  TaskKind,
  TaskState,
  VerdictId,
} from './domain.js';

export interface EventMeta {
  /** Assigned by the store on append. Strictly increasing. */
  seq: number;
  at: number;
}

// ---------------------------------------------------------------------------
// Task lifecycle
// ---------------------------------------------------------------------------

export interface TaskCreated {
  type: 'task.created';
  taskId: TaskId;
  kind: TaskKind;
  projectId: ProjectId;
  title: string;
  brief: string;
  dependsOn: TaskId[];
}

export interface TaskDispatched {
  type: 'task.dispatched';
  taskId: TaskId;
  crewId: CrewId;
  worktree: string;
  model?: string;
  effort?: Effort;
  permissionMode: PermissionMode;
}

export interface TaskStateChanged {
  type: 'task.state_changed';
  taskId: TaskId;
  from: TaskState;
  to: TaskState;
  /** Short machine-readable cause, e.g. 'sentinel_failed', 'decision_opened'. */
  reason?: string;
}

export interface TaskCompleted {
  type: 'task.completed';
  taskId: TaskId;
  /** Branch name for a mission, report path for a recon. Never a PR url — nothing here opens one. */
  artifact?: string;
  summary: string;
}

export interface TaskFailed {
  type: 'task.failed';
  taskId: TaskId;
  reason: string;
}

// ---------------------------------------------------------------------------
// Crew activity — mirrored from the adapter's event stream
// ---------------------------------------------------------------------------

export interface CrewSpawned {
  type: 'crew.spawned';
  crewId: CrewId;
  taskId: TaskId;
  /** The harness's own session id, so a Crew can be resumed or forked later. */
  sessionId?: string;
  cwd: string;
  /**
   * Literally what the captain types to watch this Crew or take it over —
   * `Session.attachCommand`, verbatim.
   *
   * Recorded here because it is the only way another process can learn it:
   * `blue ps` and the Starmap hold no live `Session`, and the command is minted
   * by the session backend at spawn. Absent for a headless adapter, so every
   * reader treats it as optional rather than printing a line nobody can act on.
   */
  attachCommand?: string;
}

export interface CrewText {
  type: 'crew.text';
  crewId: CrewId;
  text: string;
}

export interface CrewThinking {
  type: 'crew.thinking';
  crewId: CrewId;
}

export interface CrewToolUse {
  type: 'crew.tool_use';
  crewId: CrewId;
  toolUseId: string;
  name: string;
  /** Truncated for storage; the full input stays in the harness transcript. */
  inputPreview: string;
}

export interface CrewToolResult {
  type: 'crew.tool_result';
  crewId: CrewId;
  toolUseId: string;
  ok: boolean;
  resultPreview?: string;
}

export interface CrewUsage {
  type: 'crew.usage';
  crewId: CrewId;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  model?: string;
}

export interface CrewExited {
  type: 'crew.exited';
  crewId: CrewId;
  ok: boolean;
  interrupted?: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface DecisionOpened {
  type: 'decision.opened';
  decisionId: DecisionId;
  taskId: TaskId;
  question: string;
  options: DecisionOption[];
  context?: string;
}

export interface DecisionResolved {
  type: 'decision.resolved';
  decisionId: DecisionId;
  taskId: TaskId;
  answer: string;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface SentinelStarted {
  type: 'sentinel.started';
  taskId: TaskId;
  verdictId: VerdictId;
}

export interface SentinelVerdict {
  type: 'sentinel.verdict';
  taskId: TaskId;
  verdictId: VerdictId;
  pass: boolean;
  reasoning: string;
  unmet: string[];
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectRegistered {
  type: 'project.registered';
  projectId: ProjectId;
  name: string;
  path: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Union
// ---------------------------------------------------------------------------

export type BlueEventBody =
  | TaskCreated
  | TaskDispatched
  | TaskStateChanged
  | TaskCompleted
  | TaskFailed
  | CrewSpawned
  | CrewText
  | CrewThinking
  | CrewToolUse
  | CrewToolResult
  | CrewUsage
  | CrewExited
  | DecisionOpened
  | DecisionResolved
  | SentinelStarted
  | SentinelVerdict
  | ProjectRegistered;

export type BlueEventType = BlueEventBody['type'];

/** A persisted event: a body plus store-assigned metadata. */
export type BlueEvent = BlueEventBody & EventMeta;

/** Narrow a persisted event to one variant. */
export function isEvent<T extends BlueEventType>(
  e: BlueEvent,
  type: T,
): e is Extract<BlueEventBody, { type: T }> & EventMeta {
  return e.type === type;
}
