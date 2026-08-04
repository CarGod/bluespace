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
import { VERDICT_SCHEMA, type DispatchProfile, type Task, type Verdict } from '../../types/domain.js';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Upper bound on the diff we paste into the prompt. A diff larger than this is
 * almost always a lockfile, a vendored dependency, or a generated bundle — but
 * we never silently drop the rest: the prompt says exactly how much was cut and
 * tells the Sentinel to treat unseen changes as unverified.
 */
export const MAX_DIFF_CHARS = 200_000;

/** Verification is a single read-and-judge pass; it does not need a long leash. */
export const SENTINEL_MAX_TURNS = 24;

// ---------------------------------------------------------------------------
// Verdict validation
// ---------------------------------------------------------------------------

/**
 * Runtime shape of VERDICT_SCHEMA. The schema is enforced by the harness at the
 * tool-call layer, but we re-validate here: "the model claimed to honour a JSON
 * schema" and "this object is a verdict" are different statements, and only the
 * second one is safe to act on.
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
  '',
  'Each entry in `unmet` names one specific requirement from the brief that the diff does',
  'not satisfy, in the captain\'s language, concrete enough to act on. `unmet` is empty if',
  'and only if `pass` is true. `reasoning` is one short paragraph — the verdict, and what',
  'decided it.',
  '',
  'You are read-only. You may inspect files in the working tree to understand context,',
  'but you must not edit, create, delete, stage, commit, or run any command that changes',
  'state — the worktree still holds the worker\'s output. Do not attempt to find the',
  'worker\'s transcript or session log; verifying against it would defeat your purpose.',
  '',
  'Return the structured verdict. Nothing else.',
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

  let costUsd = 0;
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
      outputSchema: VERDICT_SCHEMA,
    });

    for await (const event of session.events()) {
      if (event.type === 'usage') {
        costUsd += Number.isFinite(event.costUsd) ? event.costUsd : 0;
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
    costUsd,
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
    costUsd,
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
}

/**
 * Build the Sentinel's user prompt: the brief and the diff, clearly delimited,
 * and nothing that leaks the Crew's reasoning.
 */
export function buildSentinelPrompt(input: SentinelPromptInput): string {
  const { task, diff } = input;
  const limit = input.maxDiffChars ?? MAX_DIFF_CHARS;
  const { text, truncated, omittedChars } = truncateDiff(diff, limit);
  const isRecon = task.kind === 'recon';

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
    task.brief.trim(),
    '--- END BRIEF ---',
    '',
    diff.trim().length === 0
      ? '--- BEGIN DIFF ---\n(The diff is EMPTY. The worker produced no committed changes at all.)\n--- END DIFF ---'
      : `--- BEGIN DIFF (the complete deliverable; the only evidence you have) ---\n${text}\n--- END DIFF ---`,
    '',
  ];

  if (truncated) {
    parts.push(
      `NOTE: the diff was too large to show in full and was TRUNCATED. You are seeing the first ` +
        `${text.length.toLocaleString('en-US')} characters; ${omittedChars.toLocaleString('en-US')} characters were omitted. ` +
        'Judge only what you can see, and treat anything you cannot see as unverified: if a requirement ' +
        'depends on the omitted portion, list it as unmet and say why rather than assuming it was handled.',
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
 * Derive the Sentinel's dispatch profile from the Crew's.
 *
 * Same model and effort — a verifier weaker than the worker it checks is
 * theatre. Same permission posture, because the alternative postures either
 * block on a prompt nobody is there to answer or cut the run short before the
 * structured verdict is produced; the Sentinel is held read-only by its system
 * prompt instead. Turns are capped tighter: this is one read-and-judge pass, and
 * a verifier that wanders is a verifier that is rationalising.
 */
function sentinelProfile(profile: DispatchProfile): DispatchProfile {
  const derived: DispatchProfile = {
    permissionMode: profile.permissionMode,
    maxTurns: Math.min(profile.maxTurns ?? SENTINEL_MAX_TURNS, SENTINEL_MAX_TURNS),
  };
  if (profile.model !== undefined) derived.model = profile.model;
  if (profile.effort !== undefined) derived.effort = profile.effort;
  if (profile.maxBudgetUsd !== undefined) derived.maxBudgetUsd = profile.maxBudgetUsd;
  return derived;
}

/** Truncate at a line boundary so the last hunk shown is not cut mid-line. */
function truncateDiff(
  diff: string,
  limit: number,
): { text: string; truncated: boolean; omittedChars: number } {
  if (diff.length <= limit) {
    return { text: diff, truncated: false, omittedChars: 0 };
  }
  const head = diff.slice(0, limit);
  const lastNewline = head.lastIndexOf('\n');
  const text = lastNewline > limit / 2 ? head.slice(0, lastNewline) : head;
  return { text, truncated: true, omittedChars: diff.length - text.length };
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
