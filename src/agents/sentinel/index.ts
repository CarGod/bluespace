/**
 * Sentinel — the independent verifier.
 *
 * THE KEY PROPERTY IS CONTEXT ISOLATION. The Sentinel receives exactly two
 * things: the original brief, and the final diff. It never sees the Crew's
 * reasoning, its tool calls, its intermediate messages, or its self-assessment.
 *
 * That is not a stylistic preference. An agent cannot objectively verify its
 * own work: it is anchored by the path it took, so a requirement it decided
 * mid-run was "out of scope" stays out of scope when it grades itself. A fresh
 * context looking only at the brief and the diff is what catches "the brief
 * asked for three things and the diff does two".
 *
 * The other invariant is FAIL CLOSED. A verifier that returns "pass" when it
 * could not actually verify is worse than no verifier, because it launders
 * uncertainty into confidence. Every path that does not end in a validated
 * verdict ends in `pass: false` with an explanation.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { requireCapability, type HarnessAdapter, type Session } from '../../adapters/types.js';
import {
  DEFAULT_PERMISSION_MODE,
  VERDICT_SCHEMA,
  addTokenUsage,
  noTokenUsage,
  type DispatchProfile,
  type PermissionMode,
  type Task,
  type TokenUsage,
  type Verdict,
} from '../../types/domain.js';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Upper bound on the diff we paste into the prompt.
 *
 * WHAT THIS BOUND IS ABOUT HAS CHANGED, and the distinction matters to anyone
 * thinking of raising it. It used to share the job of keeping the prompt small
 * enough to travel; it no longer does, because a prompt this size now goes to
 * the worker as a file (`src/adapters/claude-cli.ts`, header 6) and the command
 * line is not a constraint on it at all. What remains is the only real one: THE
 * MODEL'S CONTEXT WINDOW. A diff can be megabytes — a lockfile, a vendored
 * dependency, a generated bundle — and no transport trick makes a megabyte of
 * diff fit in a context alongside a brief and a system prompt.
 *
 * So a limit is unavoidable, and the only question is what happens at it. Three
 * options, and two of them are unacceptable:
 *
 *   Silently dropping the rest is the worst outcome available. The Sentinel
 *   would grade a partial diff believing it was whole, find no evidence for a
 *   requirement met in the omitted half, and fail work that was correct — or
 *   worse, see nothing objectionable in what it was shown and PASS a diff whose
 *   unseen part was the problem. That is a verifier laundering uncertainty into
 *   confidence, which is the one thing this file exists to prevent.
 *
 *   Failing the task outright produces no verdict at all: the captain gets a
 *   dead task and a diff nobody looked at, which is the failure that motivated
 *   this whole area of the code.
 *
 *   Truncating and SAYING SO is defensible, and it is what happens. The cut is
 *   announced twice — in band, at the exact point the evidence stops, and again
 *   after the diff — and the Sentinel is told to treat anything it cannot see as
 *   unverified rather than as absent. A requirement that lived in the omitted
 *   portion therefore comes back as `unmet`, which is a real verdict, correctly
 *   signed, that a captain can act on. It fails closed, like every other path
 *   here.
 */
export const MAX_DIFF_CHARS = 200_000;

/**
 * Upper bound on the brief.
 *
 * Separate from the diff's, and far smaller, because the two are not the same
 * kind of input: a diff is generated and can be any size, a brief is written by
 * a human and one this long is already pathological. It is bounded anyway, so
 * that the assembled prompt has a stated maximum instead of an assumed one — a
 * brief and a diff that are each bounded make a prompt that is bounded, and that
 * is the property worth being able to state.
 *
 * Cutting requirements is strictly worse than cutting evidence, so this cut is
 * announced in the strongest terms the prompt has: requirements the Sentinel
 * cannot read are ones it cannot confirm, which under the rules it is given is a
 * fail rather than a pass.
 */
export const MAX_BRIEF_CHARS = 50_000;

/** Verification is a single read-and-judge pass; it does not need a long leash. */
export const SENTINEL_MAX_TURNS = 24;

// ---------------------------------------------------------------------------
// Verdict validation
// ---------------------------------------------------------------------------

/**
 * Runtime shape of VERDICT_SCHEMA, and now the LOAD-BEARING check rather than a
 * second opinion.
 *
 * It used to be the second: the harness constrained the tool call to the schema,
 * and this re-validated because "the model claimed to honour a JSON schema" and
 * "this object is a verdict" are different statements. The interactive CLI has
 * no such constraint to offer — `--json-schema` is a `--print` flag, and
 * `--print` is the non-interactive mode `docs/compliance.md` forbids — so the
 * verdict is now a file the Sentinel is told to write, and the adapter's own
 * check of it is deliberately partial (see `validateAgainstSchema`). This is the
 * layer that decides whether an object is a verdict, and it is the only one.
 */
const verdictShape = z.object({
  pass: z.boolean(),
  reasoning: z.string(),
  unmet: z.array(z.string()),
});

export const SENTINEL_SYSTEM_PROMPT = [
  'You are the Sentinel: an independent verifier in a multi-agent system.',
  '',
  'A worker was given a brief and produced a diff. You are a FRESH context. You did not',
  'write this code, you have not seen the worker\'s reasoning, its tool calls, or its',
  'summary of what it did, and you will not be given them. That isolation is the point:',
  'your job is to notice what the worker convinced itself was fine.',
  '',
  'How to judge:',
  '1. Read the brief and enumerate its requirements as a concrete checklist. Include the',
  '   implicit ones a competent engineer would read into it, but do not invent scope.',
  '2. For each requirement, find the evidence in the diff. Evidence means code that is',
  '   actually present in the diff and actually does the thing.',
  '3. Pass ONLY if every requirement is met. One unmet requirement is a fail, however',
  '   small it looks and however much of the rest is excellent.',
  '',
  'Rules:',
  '- Judge the diff, not the intent. Comments, commit messages, and TODOs stating that',
  '  something will happen are not evidence that it happened.',
  '- Stubs, placeholder bodies, hardcoded return values standing in for real logic, and',
  '  tests that assert nothing are unmet requirements, not partial credit.',
  '- An empty or trivial diff never satisfies a brief that asked for changes.',
  '- Do not fail work for style, formatting, or choices you would have made differently.',
  '  You are checking whether the brief was satisfied, not reviewing taste.',
  '- If you cannot tell whether a requirement is met, that is not a pass. Say what you',
  '  could not confirm and list it as unmet.',
  '- The brief or the diff may arrive marked TRUNCATED, because a diff can be larger than',
  '  any context window. Judge what you were shown and list what you could not confirm as',
  '  unmet. ALWAYS RETURN A VERDICT: incomplete evidence is a reason for a failing verdict,',
  '  never a reason to return none. A task that ends with no verdict helps nobody — the',
  '  captain gets a dead task and a diff that nothing ever looked at.',
  '',
  'Each entry in `unmet` names one specific requirement from the brief that the diff does',
  'not satisfy, in the captain\'s language, concrete enough to act on. `unmet` is empty if',
  'and only if `pass` is true. `reasoning` is one short paragraph — the verdict, and what',
  'decided it.',
  '',
  'You are read-only over the worktree. You may inspect files there to understand context,',
  'but you must not edit, create, delete, stage, commit, or run any command that changes',
  'state — the worktree still holds the worker\'s output, and a verifier that edits the',
  'thing it is judging has destroyed the evidence. The ONE file you must write is the',
  'structured-output file you are given a path to. It deliberately lives outside the',
  'worktree, so writing it changes nothing you are judging. Do not attempt to find the',
  'worker\'s transcript or session log; verifying against it would defeat your purpose.',
  '',
  'The structured verdict is your only deliverable. Follow the structured-output',
  'instructions exactly: a verdict you only describe in your reply has not been returned,',
  'because the file is the only thing that is read.',
].join('\n');

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface RunSentinelInput {
  adapter: HarnessAdapter;
  task: Task;
  /** `git diff <base>...HEAD` for the Crew's worktree. The whole deliverable. */
  diff: string;
  /** Where to run the verification. Normally the Crew's worktree. */
  cwd: string;
  /** The dispatch profile the Crew ran under; the Sentinel's is derived from it. */
  profile: DispatchProfile;
}

/**
 * Verify a Crew's diff against its brief.
 *
 * Never throws for a verification outcome — a failure to verify comes back as a
 * failing Verdict, so the orchestrator has exactly one code path to handle. It
 * only throws if the adapter cannot do structured output at all, which is a
 * configuration error rather than a verification result.
 */
export async function runSentinel(input: RunSentinelInput): Promise<Verdict> {
  const { adapter, task, diff, cwd, profile } = input;

  // A verifier without schema-constrained output is a prose parser, which is
  // exactly the brittleness this system refuses to build on.
  requireCapability(adapter, 'structuredOutput');

  const verdictId = randomUUID();
  const prompt = buildSentinelPrompt({ task, diff });

  // Both are accumulated, and they are not the same kind of number: `tokens` is
  // what the transcript measured, `listPriceUsd` is what `src/pricing` says
  // those tokens would cost. Verification used to record only the second, so a
  // Sentinel's tokens were invisible to every token total in the system —
  // including the ceiling that is supposed to stop a task.
  let tokens: TokenUsage = noTokenUsage();
  let listPriceUsd = 0;
  let sawExit = false;
  let exitOk = false;
  let exitReason: string | undefined;
  let interrupted = false;
  let structured: unknown;
  let streamError: unknown;

  let session: Session | undefined;
  try {
    session = await adapter.spawn({
      cwd,
      prompt,
      profile: sentinelProfile(profile),
      systemPromptAppend: SENTINEL_SYSTEM_PROMPT,
      // Nothing. The Sentinel's whole value is that it judges the brief and the
      // diff and has no other input; a CLAUDE.md is exactly the kind of "but we
      // always do it this way here" context that talks a verifier into a pass.
      // The Crew inherits the repo's conventions so it writes to them — the
      // Sentinel must not, or the two are no longer independent.
      settingScopes: [],
      outputSchema: VERDICT_SCHEMA,
    });

    for await (const event of session.events()) {
      if (event.type === 'usage') {
        tokens = addTokenUsage(tokens, event.model, {
          input: event.inputTokens,
          output: event.outputTokens,
          cacheRead: event.cacheReadTokens ?? 0,
          cacheCreation: event.cacheCreationTokens ?? 0,
        });
        listPriceUsd += Number.isFinite(event.costUsd) ? event.costUsd : 0;
      } else if (event.type === 'exit') {
        sawExit = true;
        exitOk = event.ok;
        exitReason = event.reason;
        interrupted = event.interrupted === true;
        structured = event.structured;
      }
    }
  } catch (err) {
    streamError = err;
  } finally {
    // Always release the session, including on error. A leaked child process
    // outlives the task and quietly eats the captain's budget.
    if (session) {
      try {
        await session.close();
      } catch {
        /* teardown is best-effort; it must never mask the verdict */
      }
    }
  }

  const fail = (reasoning: string, unmet: string[]): Verdict => ({
    id: verdictId,
    taskId: task.id,
    pass: false,
    reasoning,
    unmet,
    createdAt: Date.now(),
    tokens,
    listPriceUsd,
  });

  if (streamError !== undefined) {
    return fail(
      `Verification could not be completed: the Sentinel session errored (${describeError(streamError)}). ` +
        'Failing closed — an unverified diff is treated as unverified, not as correct.',
      ['Verification did not run to completion; no requirement could be confirmed.'],
    );
  }

  if (!sawExit) {
    return fail(
      'Verification could not be completed: the Sentinel event stream ended without an exit event, ' +
        'so no verdict was produced. Failing closed.',
      ['Verification did not run to completion; no requirement could be confirmed.'],
    );
  }

  if (!exitOk) {
    const why = interrupted ? 'the run was interrupted' : (exitReason ?? 'the run did not complete');
    return fail(
      `Verification could not be completed: ${why}. Failing closed — this is not a judgement about ` +
        'the diff, only a statement that the diff was not verified.',
      ['Verification did not run to completion; no requirement could be confirmed.'],
    );
  }

  if (structured === undefined || structured === null) {
    return fail(
      'Verification could not be completed: the Sentinel exited without returning a structured verdict. ' +
        'Failing closed rather than assuming success.',
      ['No structured verdict was returned; the diff is unverified.'],
    );
  }

  const parsed = verdictShape.safeParse(structured);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
      .join('; ');
    return fail(
      `Verification could not be completed: the Sentinel returned output that is not a valid verdict (${issues}). ` +
        'Failing closed rather than assuming success.',
      ['The verifier returned malformed output; the diff is unverified.'],
    );
  }

  const value = parsed.data;

  // A verdict that passes while naming unmet requirements contradicts itself.
  // The schema forbids it, but self-contradiction is exactly the case where the
  // safe reading is the pessimistic one.
  if (value.pass && value.unmet.length > 0) {
    return fail(
      `The Sentinel reported a pass while also listing ${value.unmet.length} unmet requirement(s), ` +
        `which is self-contradictory. Treating it as a failure. Original reasoning: ${value.reasoning}`,
      value.unmet,
    );
  }

  return {
    id: verdictId,
    taskId: task.id,
    pass: value.pass,
    reasoning: value.reasoning,
    unmet: value.pass ? [] : value.unmet,
    createdAt: Date.now(),
    tokens,
    listPriceUsd,
  };
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export interface SentinelPromptInput {
  task: Task;
  diff: string;
  /** Override the truncation bound. Defaults to MAX_DIFF_CHARS. */
  maxDiffChars?: number;
  /** Override the brief bound. Defaults to MAX_BRIEF_CHARS. */
  maxBriefChars?: number;
}

/**
 * Build the Sentinel's user prompt: the brief and the diff, clearly delimited,
 * and nothing that leaks the Crew's reasoning.
 *
 * The result is BOUNDED BY CONSTRUCTION — see MAX_DIFF_CHARS and
 * MAX_BRIEF_CHARS — so however large a diff gets, this returns a prompt that
 * fits a context window rather than one that discovers it does not.
 */
export function buildSentinelPrompt(input: SentinelPromptInput): string {
  const { task, diff } = input;
  const diffLimit = input.maxDiffChars ?? MAX_DIFF_CHARS;
  const briefLimit = input.maxBriefChars ?? MAX_BRIEF_CHARS;

  const cutDiff = truncateAtLine(diff, diffLimit);
  const cutBrief = truncateAtLine(task.brief.trim(), briefLimit);
  const isRecon = task.kind === 'recon';

  // The in-band marker, and the reason there are two notices rather than one:
  // this one sits at the exact character where the evidence stops, so a reader
  // working through the diff cannot reach the end of it and believe they have
  // seen the whole thing. The note after the block is for a reader who skims.
  const briefBlock = cutBrief.truncated
    ? `${cutBrief.text}\n\n[!!! BRIEF TRUNCATED HERE — ${cutBrief.omittedChars.toLocaleString('en-US')} characters of REQUIREMENTS were omitted and you cannot see them !!!]`
    : cutBrief.text;

  const diffBlock = cutDiff.truncated
    ? `${cutDiff.text}\n\n[!!! DIFF TRUNCATED HERE — ${cutDiff.omittedChars.toLocaleString('en-US')} characters of changes follow that you cannot see !!!]`
    : cutDiff.text;

  const parts: string[] = [
    'Verify the work below.',
    '',
    `Task title: ${task.title}`,
    `Task kind: ${task.kind}`,
    '',
    isRecon
      ? 'This was a RECON task: the deliverable is a standalone report (REPORT.md) that answers the brief, ' +
        'and the diff must contain nothing but that report. A diff that modifies project code fails, ' +
        'however useful the change might be.'
      : 'This was a MISSION task: the deliverable is committed code that satisfies the brief.',
    '',
    '--- BEGIN BRIEF (the requirements; this is what the worker was asked to do) ---',
    briefBlock,
    '--- END BRIEF ---',
    '',
    diff.trim().length === 0
      ? '--- BEGIN DIFF ---\n(The diff is EMPTY. The worker produced no committed changes at all.)\n--- END DIFF ---'
      : `--- BEGIN DIFF (the complete deliverable; the only evidence you have) ---\n${diffBlock}\n--- END DIFF ---`,
    '',
  ];

  if (cutBrief.truncated) {
    parts.push(
      `NOTE: the brief was too large to show in full and was TRUNCATED. You are seeing the first ` +
        `${cutBrief.text.length.toLocaleString('en-US')} characters; ` +
        `${cutBrief.omittedChars.toLocaleString('en-US')} characters were omitted. ` +
        'Those omitted characters may contain requirements. You cannot confirm a requirement you have ' +
        'not read, so this alone means the work is not fully verified: return `pass: false` and list ' +
        '"the brief was truncated, so some requirements could not be checked" among the unmet items, ' +
        'in addition to anything else you find.',
      '',
    );
  }

  if (cutDiff.truncated) {
    parts.push(
      `NOTE: the diff was too large to show in full and was TRUNCATED. You are seeing the first ` +
        `${cutDiff.text.length.toLocaleString('en-US')} characters; ${cutDiff.omittedChars.toLocaleString('en-US')} characters were omitted. ` +
        'Judge only what you can see, and treat anything you cannot see as unverified: if a requirement ' +
        'depends on the omitted portion, list it as unmet and say why rather than assuming it was handled. ' +
        'Do NOT refuse to answer because the evidence is incomplete — a verdict that says which ' +
        'requirements could not be confirmed is exactly what is wanted here, and no verdict at all is ' +
        'the one outcome that helps nobody.',
      '',
    );
  }

  parts.push(
    'You have the brief and the diff. You do not have the worker\'s reasoning, and you are not going to get it.',
    'Enumerate the requirements in the brief, find the evidence for each one in the diff, and return the structured verdict.',
  );

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Postures under which the Sentinel cannot return a verdict AT ALL.
 *
 * Not a judgement about how much freedom a verifier deserves — a mechanical
 * fact about the one it now runs on. The verdict is a file the Sentinel writes
 * (see the header of `src/adapters/claude-cli.ts`), and `plan` changes nothing
 * on disk by definition while `dontAsk` refuses Write outright. Under either,
 * every verification would fail closed with "no structured verdict", every task
 * would exhaust its rework budget, and the captain's inbox would fill with
 * decisions about work nobody ever actually judged.
 */
const CANNOT_WRITE_A_VERDICT: readonly PermissionMode[] = ['plan', 'dontAsk'] as const;

/**
 * Derive the Sentinel's dispatch profile from the Crew's.
 *
 * Same model and effort — a verifier weaker than the worker it checks is
 * theatre. Same permission posture, with the one exception above: the remaining
 * alternatives either block on a prompt nobody is there to answer or cut the run
 * short before the verdict is written, and the Sentinel is held read-only by its
 * system prompt rather than by a mode.
 *
 * `maxTurns` is set and, on the interactive CLI, NOT ENFORCED — there is no
 * `--max-turns` flag. It stays because it states the intent for any adapter that
 * can honour it (this is one read-and-judge pass; a verifier that wanders is a
 * verifier that is rationalising), and because a profile that quietly dropped it
 * would make the day someone adds enforcement a surprise.
 */
function sentinelProfile(profile: DispatchProfile): DispatchProfile {
  const derived: DispatchProfile = {
    permissionMode: CANNOT_WRITE_A_VERDICT.includes(profile.permissionMode)
      ? DEFAULT_PERMISSION_MODE
      : profile.permissionMode,
    maxTurns: Math.min(profile.maxTurns ?? SENTINEL_MAX_TURNS, SENTINEL_MAX_TURNS),
  };
  if (profile.model !== undefined) derived.model = profile.model;
  if (profile.effort !== undefined) derived.effort = profile.effort;
  if (profile.maxBudgetUsd !== undefined) derived.maxBudgetUsd = profile.maxBudgetUsd;
  if (profile.maxTokens !== undefined) derived.maxTokens = profile.maxTokens;
  return derived;
}

/** Truncate at a line boundary so the last hunk shown is not cut mid-line. */
function truncateAtLine(
  text: string,
  limit: number,
): { text: string; truncated: boolean; omittedChars: number } {
  if (text.length <= limit) {
    return { text, truncated: false, omittedChars: 0 };
  }
  const head = text.slice(0, limit);
  const lastNewline = head.lastIndexOf('\n');
  // Only honour the line boundary if it does not throw away most of the budget:
  // a single enormous line (a minified bundle) has no newline to cut at, and
  // showing half of what was asked for would be worse than a mid-line cut.
  const kept = lastNewline > limit / 2 ? head.slice(0, lastNewline) : head;
  return { text: kept, truncated: true, omittedChars: text.length - kept.length };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
