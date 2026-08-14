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

/**
 * Every state a task can be in, in lifecycle order.
 *
 * Exported because more than one surface has to enumerate them and they must not
 * drift: the Starmap board draws a column per state whether or not anything is
 * in it, and a state missing from that list would be a state the captain never
 * learns exists until it is holding up their work.
 */
export const TASK_STATES: readonly TaskState[] = [
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
] as const;

/** States from which no further work happens without a new dispatch. */
export const TERMINAL_TASK_STATES: readonly TaskState[] = [
  'landed',
  'failed',
  'cancelled',
] as const;

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_TASK_STATES.includes(state);
}

// ---------------------------------------------------------------------------
// Tokens — the only quantity a run actually reports
// ---------------------------------------------------------------------------

/**
 * THE PRIMARY UNIT OF CONSUMPTION IN BLUESPACE. Read this before adding a
 * dollar figure anywhere.
 *
 * A Claude Code transcript reports two facts about what a turn consumed:
 * `message.usage` (four token counts) and `message.model`. That is the whole
 * ground truth. Dollars are not in it, and on BlueSpace's default and
 * documented path — the captain's own Claude subscription, see
 * `docs/compliance.md` — dollars do not exist at all: those tokens draw down a
 * quota, and no invoice is ever produced for them. `src/pricing/` can say what
 * the same tokens WOULD cost at API list price, which is a real answer to a
 * different question and a precise-looking fiction if presented as spend.
 *
 * So tokens are what BlueSpace accumulates, ceilings, and reports. Dollars are
 * derived, labelled, and only shown when the run is actually metered.
 */
export interface TokenCounts {
  input: number;
  output: number;
  /** Tokens served from an existing prompt cache. Usually the largest count. */
  cacheRead: number;
  /** Tokens written into the prompt cache. */
  cacheCreation: number;
}

/** Bucket for tokens whose model the transcript did not name. */
export const UNKNOWN_MODEL = 'unknown';

export function noTokens(): TokenCounts {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

/**
 * All four kinds summed.
 *
 * The kinds are NOT interchangeable — a cache read is a tenth of an input token
 * at list price, and cache reads dominate an agentic run — so this total is a
 * volume measure, not a value one. It is what `maxTokensPerTask` bounds, which
 * makes the ceiling honest (it counts what the transcript counts) and blunt
 * (a cache-heavy task reaches it sooner than an equally expensive uncached one).
 * That tradeoff is deliberate: the alternative is a weighted total, and a weight
 * is a price by another name.
 */
export function totalTokens(counts: TokenCounts): number {
  return counts.input + counts.output + counts.cacheRead + counts.cacheCreation;
}

export function addTokenCounts(a: TokenCounts, b: Partial<TokenCounts>): TokenCounts {
  return {
    input: a.input + (b.input ?? 0),
    output: a.output + (b.output ?? 0),
    cacheRead: a.cacheRead + (b.cacheRead ?? 0),
    cacheCreation: a.cacheCreation + (b.cacheCreation ?? 0),
  };
}

/**
 * Tokens accumulated over one or more runs, kept BY MODEL.
 *
 * The breakdown is not decoration: "3.1M tokens" answers nothing on its own,
 * because 3.1M Haiku tokens and 3.1M Opus tokens are different amounts of the
 * captain's quota. `totals` is the sum of every entry in `byModel`, always.
 */
export interface TokenUsage {
  totals: TokenCounts;
  byModel: Record<string, TokenCounts>;
}

export function noTokenUsage(): TokenUsage {
  return { totals: noTokens(), byModel: {} };
}

/** Fold one run's counts into a {@link TokenUsage}, returning a new value. */
export function addTokenUsage(
  usage: TokenUsage,
  model: string | undefined,
  counts: Partial<TokenCounts>,
): TokenUsage {
  const key = model !== undefined && model !== '' ? model : UNKNOWN_MODEL;
  const existing = usage.byModel[key] ?? noTokens();
  return {
    totals: addTokenCounts(usage.totals, counts),
    byModel: { ...usage.byModel, [key]: addTokenCounts(existing, counts) },
  };
}

/** Fold two accumulations together — a Sentinel's tokens into its task's. */
export function mergeTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  let out: TokenUsage = { totals: a.totals, byModel: { ...a.byModel } };
  for (const [model, counts] of Object.entries(b.byModel)) {
    out = addTokenUsage(out, model, counts);
  }
  return out;
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
  /**
   * The task this one continues, if any. See `task.created.resumeOf`.
   *
   * Presentation and provenance only: nothing about dispatch reads it except
   * the one branch that adopts the ancestor's worktree instead of cutting a
   * fresh one.
   */
  resumeOf?: TaskId;
  /** Set once dispatched. */
  crewId?: CrewId;
  worktree?: string;
  /**
   * What the task delivered, from `task.completed`: a branch name for a
   * mission, the ARCHIVED report path for a recon.
   *
   * Carried on the task, not left in the event log, because `worktree` is a
   * directory `blue gc` may reclaim and this is the copy that outlives it —
   * anything answering "where is the deliverable" has to be able to read it
   * without replaying the log. Absent until the task lands, and absent on a
   * recon that wrote no report.
   */
  artifact?: string;
  /** The one-line outcome recorded with `artifact`; says so when there is none. */
  summary?: string;
  /**
   * The integration branch this task's branch was merged into, once the captain
   * landed it. Absent until then, and absent forever for work that landed
   * nowhere.
   *
   * NOT the same thing as the `landed` state, which means only that verification
   * is over. This field is the record of an actual git merge, and it is what
   * entitles `blue gc` to reclaim the worktree: the safe rule is "the commits
   * are already in the branch they were merged into", and this names that
   * branch. A task without it is measured against the default branch exactly as
   * before, which is what keeps landing-nowhere from becoming reclaimable.
   */
  mergedInto?: string;
  /** Commit id of the merge on {@link mergedInto}. */
  mergeCommit?: string;
  mergedAt?: number;
  /**
   * When the captain took this task off the board, if they have.
   *
   * Presentation only. It does not change the state, does not touch the
   * worktree or the branch, and does not remove the task from any total — a
   * dismissed failure is still a failure that spent tokens. Anything reporting
   * what the fleet DID must ignore this field; only what the fleet SHOWS may
   * read it. See `task.dismissed` in types/events.ts.
   */
  dismissedAt?: number;
  /**
   * Tokens consumed by every Crew and Sentinel run for this task, by model.
   * THE quantity: it is measured, not inferred, and it is what `maxTokensPerTask`
   * bounds. See {@link TokenCounts}.
   */
  tokens: TokenUsage;
  /**
   * Whether this task's runs were billed per token.
   *
   * True when the Crew was launched with `ANTHROPIC_API_KEY` in the environment
   * (`resolveAuth` in `src/adapters/claude-cli.ts`), which is the only case where
   * {@link listPriceUsd} is money anybody is charged. Recorded per task rather
   * than read from the current environment because it is a fact about the RUN:
   * `blue ps` may be typed months later, in a shell configured differently, and
   * "what did this cost" must not change answer because of that.
   *
   * False for a task dispatched before this was recorded. A task nobody could
   * prove was metered is reported as a subscription task, because the failure
   * that matters is presenting a quota draw-down as spend.
   */
  metered: boolean;
  /**
   * What {@link tokens} would cost at API list price, per `src/pricing`.
   *
   * SPEND ONLY WHEN {@link metered} IS TRUE. On a subscription this is an
   * equivalence, not a charge — the tokens came out of a quota — and every
   * surface that prints it must say so. Kept because it is genuinely useful
   * (it is the one number that compares an Opus task to a Haiku one), and
   * because an API-key run needs a real cost.
   */
  listPriceUsd: number;
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
   * TOKEN ceiling for a single run, and the one denominated in something every
   * run actually reports. Same advisory status as `maxBudgetUsd` — no
   * `claude` flag enforces it either — but unlike dollars it is meaningful on
   * a subscription, so the orchestrator's per-task version of this is the
   * ceiling that stops a runaway Crew. See `#enforceCeilings`.
   */
  maxTokens?: number;
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
  /** Tokens the verification consumed, by model. Billed to the task it verified. */
  tokens: TokenUsage;
  /** List-price equivalent of {@link tokens}. See `Task.listPriceUsd`. */
  listPriceUsd: number;
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
 * METADATA, NOT BEHAVIOUR. Nothing in BlueSpace pushes or opens a pull request,
 * and `pr` does not change that — it is context Helm can read when it writes a
 * brief (say, to ask for commits shaped for review). Every task ends the same way
 * in either mode: a local branch in a worktree.
 *
 * It does not select the delivery path either. There is exactly one, and it is
 * the same in both modes: the captain says to land a verified task, it is merged
 * into {@link Project.devBranch}, and reaching the default branch from there is a
 * pull request they open by hand. `pr` is the default only because it is the
 * commoner intent.
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
  /**
   * The integration branch every landed task in this project is merged into —
   * `blue/dev`, created or adopted at registration.
   *
   * RECORDED PER PROJECT rather than read from the constant at merge time, so
   * that renaming `INTEGRATION_BRANCH` in a future version cannot silently
   * retarget the merges of a project already using the old name. The recorded
   * value always wins.
   *
   * Absent on projects registered before delivery existed. Those are adopted on
   * first use — the same create-or-adopt rule runs then, and the result is
   * written back here — rather than being rejected or crashing. See
   * `src/land/land.ts`.
   */
  devBranch?: string;
  addedAt: number;
}
