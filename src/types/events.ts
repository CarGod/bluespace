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
  TokenCounts,
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
  /**
   * Branch name for a mission; for a recon, the path of the report ARCHIVED out
   * of the worktree (`<dataDir>/reports/<taskId>.md`), which is why it outlives
   * reclamation. Absent when a recon wrote no report — `summary` says so.
   * Never a PR url — nothing here opens one.
   */
  artifact?: string;
  summary: string;
}

export interface TaskFailed {
  type: 'task.failed';
  taskId: TaskId;
  reason: string;
}

/**
 * The captain landed a verified task: its branch was merged into the project's
 * integration branch.
 *
 * The first write BlueSpace has ever made to one of the captain's repositories,
 * so it is in the log like everything else — `blue log <taskId>` shows the merge
 * next to the verdict that justified it, and the projection reads it to decide
 * whether a worktree is reclaimable.
 *
 * `into` is ALWAYS the integration branch and is recorded verbatim rather than
 * derived: it is the evidence of where the work actually went, and a later
 * reader must not have to guess from a constant that may since have changed.
 * It is never the default branch — nothing in BlueSpace merges into main.
 */
export interface TaskMerged {
  type: 'task.merged';
  taskId: TaskId;
  /** Denormalized so delivery status can group merges without a full fold. */
  projectId: ProjectId;
  /** The task branch that was merged, e.g. `blue/<taskId>`. */
  branch: string;
  /** The integration branch it was merged into, e.g. `blue/dev`. */
  into: string;
  /** Tip of `into` after the merge. */
  commit: string;
  /** Absolute path of the repository whose `into` branch moved. */
  repoPath: string;
  /**
   * True when the branch was already contained in `into` and nothing moved —
   * landing something twice. Recorded rather than suppressed, because "I already
   * did that" is an answer the captain may need to see in the log.
   */
  alreadyMerged?: boolean;
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
  /**
   * True when this Crew was launched with `ANTHROPIC_API_KEY` in its
   * environment, so its tokens are billed per token rather than drawn from a
   * subscription quota.
   *
   * Written here because metering is a property of the RUN, and every reader of
   * this log is a different process at a different time: `blue ps` in a shell
   * with no key must still report a metered task's dollars as spend, and must
   * never report a subscription task's as anything but a list-price equivalent.
   * Absent on events written before this field existed — read as `false`, which
   * errs toward calling a fiction a fiction.
   */
  metered?: boolean;
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

/**
 * One message's consumption, as the transcript reported it.
 *
 * The token counts and `model` are MEASURED — they are what `message.usage` and
 * `message.model` said. `costUsd` is DERIVED: `src/pricing` multiplying those
 * counts by a list-price table. On a subscription run nobody is charged it; see
 * `TokenCounts` in types/domain.ts. The field keeps its name because this log is
 * append-only and every event already on disk spells it this way, but nothing
 * downstream may present it as spend unless `crew.spawned.metered` was true.
 */
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
// Helm's own window
// ---------------------------------------------------------------------------

/**
 * A Helm window opened, and here is where to find what it does.
 *
 * THE ONE SPENDER THAT USED TO BE OUTSIDE THE LOG. Every other consumer here is
 * a process BlueSpace starts and watches. Helm is not: it runs in the captain's
 * own terminal, and it has `Agent`, so it can fan out. Observed — a template
 * upgrade in which Helm spawned two sub-agents that burned 153.4k and 128.5k
 * tokens in two minutes while `blue ps` showed nothing and the Starmap said
 * "Nothing needs you · 0 crew working". The captain's question was exactly that:
 * *"map 里面为啥看不到当前执行的任务"*.
 *
 * This event does not carry the spend, and cannot: nothing in this process is
 * watching that window. It carries the ONE FACT that makes the spend findable
 * afterwards — the harness's session id, which is the name of the transcript on
 * disk and of the `subagents/` directory beside it. `src/helm/window.ts` reads
 * those; `blue ps` folds this event to know which ones to read.
 *
 * Written by `blue mcp`, from `CLAUDE_CODE_SESSION_ID` in its own environment.
 * That is the only vantage point that knows: the MCP server is spawned BY the
 * window, so it is handed the window's session id whatever flags the window was
 * launched with — including `--continue` and `--resume`, which `--session-id`
 * cannot be combined with at all ("Error: --session-id can only be used with
 * --continue or --resume if --fork-session is also specified", measured on
 * 2.1.224). Making the launcher mint the id instead would have broken
 * `bluespace --continue` outright.
 */
export interface HelmWindowOpened {
  type: 'helm.window_opened';
  /** The harness's own session id — a UUID, and the transcript's filename. */
  sessionId: string;
  /** Where the captain ran `bluespace`. Shown so two windows are tellable apart. */
  cwd: string;
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
  /** Derived, like `crew.usage.costUsd`. Real money only on a metered run. */
  costUsd: number;
  /**
   * Tokens the verification consumed, keyed by model.
   *
   * Added because verification is not free and its tokens used to vanish: the
   * event carried a dollar figure and nothing else, so a task's token total
   * silently excluded every Sentinel run — and on a subscription the dollar
   * figure was the one number that did not mean anything. Absent on events
   * written before this field existed.
   */
  tokensByModel?: Record<string, TokenCounts>;
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

/**
 * The captain has taken a finished task off the board, or put it back.
 *
 * A VIEW FACT, NOT A LIFECYCLE ONE — which is why it is a separate event rather
 * than a state. Dismissing changes nothing about what happened: the task stays
 * `failed`, its worktree stays on disk, its branch stays where it is, and its
 * tokens still count towards every total. It says only that the captain is done
 * looking at it.
 *
 * It is an EVENT rather than something the browser remembers because the board
 * is a fold over this log and nothing else. A dismissal kept in `localStorage`
 * would be invisible to `blue ps`, would not survive a different browser, and
 * would be the one piece of fleet state that lives outside the Blackbox.
 *
 * Reversible on purpose, and by the same event: `dismissed: false` puts it back,
 * so the log records the captain changing their mind rather than losing the fact
 * that they once cleared it.
 */
export interface TaskDismissed {
  type: 'task.dismissed';
  taskId: TaskId;
  /** False restores it to the board. */
  dismissed: boolean;
}

export type BlueEventBody =
  | TaskCreated
  | TaskDispatched
  | TaskStateChanged
  | TaskCompleted
  | TaskFailed
  | TaskMerged
  | TaskDismissed
  | CrewSpawned
  | CrewText
  | CrewThinking
  | CrewToolUse
  | CrewToolResult
  | CrewUsage
  | CrewExited
  | HelmWindowOpened
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
