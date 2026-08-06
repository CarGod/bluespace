/**
 * Harness adapter contract.
 *
 * Designed to the HIGHEST standard, not the lowest common denominator: an
 * adapter that cannot do something declares it in `capabilities` and the rest
 * of the system degrades gracefully. The opposite approach — assuming a
 * terminal and reconstructing semantics from rendered text — is what makes
 * this kind of tool brittle, so it is deliberately not an option here.
 *
 * Nothing above this layer may import a vendor SDK.
 */

import type { DispatchProfile } from '../types/domain.js';

// ---------------------------------------------------------------------------
// Normalized events — every adapter maps its native stream onto this union
// ---------------------------------------------------------------------------

export type AdapterEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'thinking' }
  | { type: 'tool_use'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; ok: boolean; result?: string }
  /**
   * What one message consumed.
   *
   * The token counts and `model` are MEASURED — the transcript said so. `costUsd`
   * is DERIVED: those counts multiplied by a list-price table (`src/pricing`).
   * It is money only if `HarnessAdapter.metered` is true; on a subscription it is
   * what the same tokens would have cost on the API. Everything above this layer
   * accounts in tokens for exactly that reason.
   */
  | {
      type: 'usage';
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      model?: string;
    }
  | {
      type: 'exit';
      ok: boolean;
      interrupted?: boolean;
      reason?: string;
      /** Present when the run was asked for structured output. */
      structured?: unknown;
    };

// ---------------------------------------------------------------------------
// Capabilities — declared, never assumed
// ---------------------------------------------------------------------------

export interface AdapterCapabilities {
  /** Can a running session be cleanly interrupted? */
  interrupt: boolean;
  /** Can a finished session be resumed or forked from a checkpoint? */
  fork: boolean;
  /**
   * Does the stream report per-message consumption at all — token counts and
   * the model that spent them? Whether those tokens are billed in dollars is a
   * separate question, answered by `HarnessAdapter.metered`.
   */
  cost: boolean;
  /** Does the stream expose individual tool calls, not just final text? */
  toolEvents: boolean;
  /** Can the run be constrained to a JSON Schema? (Sentinel needs this.) */
  structuredOutput: boolean;
  /** Can messages be pushed into a live session? (Rework, and `steer_task`.) */
  steer: boolean;
  /**
   * Can it host a multi-turn conversation with caller-supplied tools?
   *
   * False on the only adapter there is, and nothing calls `converse()` any more:
   * Helm used to run on this surface from `blue`'s REPL, and now runs in the
   * captain's own Claude Code window over MCP. It stays declared because it is
   * the honest answer to "what can this adapter do", and `requireCapability`
   * turns the answer into a refusal instead of a surprise.
   */
  conversation: boolean;
}

// ---------------------------------------------------------------------------
// Tools, and the conversation surface no adapter implements
// ---------------------------------------------------------------------------

/**
 * A tool the caller hosts, described vendor-neutrally.
 *
 * `inputSchema` is JSON Schema because that is the one tool-description format
 * every harness can consume. The transport translates it into whatever its
 * protocol wants; callers never learn what that is. This is the boundary that
 * keeps Helm's tools — and therefore the orchestrator's entire control surface —
 * from being welded to one vendor. Today the only consumer is the MCP server in
 * `src/mcp/`, which hands these out verbatim; `ConversationRequest` below is the
 * other consumer this type was designed for, and nothing implements it.
 */
export interface ToolDef {
  name: string;
  /**
   * What the tool does AND when to call it. Prescriptive trigger conditions
   * measurably improve tool selection, so a description that only says what
   * the tool does is an incomplete one.
   */
  description: string;
  /** JSON Schema object describing the input. */
  inputSchema: Record<string, unknown>;
  /** Returns the text handed back to the model. Throwing is reported as a tool error. */
  handler(input: Record<string, unknown>): Promise<string>;
}

/**
 * Which on-disk configuration scopes a run inherits.
 *
 *   user    ~/.claude/  — CLAUDE.md, rules, skills, settings.json (and its hooks)
 *   project <cwd>/      — CLAUDE.md, .claude/rules, .claude/skills, .claude/settings.json
 *   local   <cwd>/      — CLAUDE.local.md, .claude/settings.local.json
 *
 * BlueSpace always states this explicitly. Omitting it is NOT "inherit nothing":
 * the harness treats an absent value as all three scopes, so leaving it unset
 * means every Crew silently runs the captain's personal interactive-session
 * hooks, and the set of things loaded changes whenever the captain edits a file
 * nobody was thinking about. A dispatch decision this load-bearing belongs in
 * the code that makes it, not in a default.
 *
 * Note that some inputs are read no matter what this says — the global
 * `~/.claude.json` and auto-memory under `~/.claude/projects/` among them.
 * `[]` narrows the blast radius; it does not produce a hermetic run.
 */
export type SettingScope = 'user' | 'project' | 'local';

export interface ConversationRequest {
  systemPrompt: string;
  tools: ToolDef[];
  cwd?: string;
  profile: DispatchProfile;
  /** On-disk scopes to inherit. Required: see {@link SettingScope}. */
  settingScopes: readonly SettingScope[];
  signal?: AbortSignal;
}

export interface Conversation {
  readonly id: string;
  /**
   * Send one turn. The returned iterable yields that turn's events and ends
   * when the assistant finishes; the underlying session persists, so the next
   * send() continues the same conversation rather than starting over.
   */
  send(message: string): AsyncIterable<AdapterEvent>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

export interface SpawnRequest {
  /** Working directory. For a Crew this is its disposable git worktree. */
  cwd: string;
  /** The opening message — for a Crew, its brief. */
  prompt: string;
  profile: DispatchProfile;
  /** On-disk scopes to inherit. Required: see {@link SettingScope}. */
  settingScopes: readonly SettingScope[];
  /**
   * Extra instructions appended to the harness's own system prompt.
   *
   * Load-bearing beyond its own text: supplying it is also what selects the
   * harness's native system prompt. A run that omits it gets the harness's
   * minimal prompt instead — the tools, but not the operating instructions
   * that make them behave like the product. Every worker passes one.
   */
  systemPromptAppend: string;
  /** Constrain the final result to this JSON Schema. Requires `structuredOutput`. */
  outputSchema?: unknown;
  /** Resume a prior session instead of starting fresh. Requires `fork`. */
  resume?: { sessionId: string; atMessageId?: string; fork?: boolean };
  /** Cancellation. Every adapter must honour this. */
  signal?: AbortSignal;
}

export interface Session {
  readonly id: string;
  /**
   * Literally what the captain types to watch this worker or take it over,
   * when the adapter runs workers somewhere a human can reach. Undefined for
   * an adapter whose runs are headless — which is a real difference in what
   * the tool can do, so it is surfaced rather than papered over.
   *
   * Carried into the Blackbox on `crew.spawned` so `blue ps` and the Starmap
   * can print it. A value nobody can act on is not worth an event.
   */
  readonly attachCommand?: string;
  /** The normalized event stream. Ends when the run exits. */
  events(): AsyncIterable<AdapterEvent>;
  /** Push a follow-up message into a live session. Requires `steer`. */
  send(message: string): Promise<void>;
  /** Ask the session to stop at a safe boundary. Requires `interrupt`. */
  interrupt(): Promise<void>;
  /** Terminate and release resources. Safe to call more than once. */
  close(): Promise<void>;
}

export interface HarnessAdapter {
  readonly name: string;
  readonly capabilities: AdapterCapabilities;
  /**
   * True when this adapter's runs are BILLED PER TOKEN — an API key, a cloud
   * provider endpoint, anything that produces an invoice.
   *
   * A capability describes what an adapter can do; this describes what its runs
   * cost, which is a different axis and the one that decides whether a dollar
   * figure may be shown to the captain at all. On the default path (the
   * captain's own Claude subscription) tokens draw down a quota and the dollars
   * `src/pricing` computes are an equivalence, not spend.
   *
   * Optional, and absent means NOT metered: an adapter that has not thought
   * about the question has not earned the right to have its estimates called
   * money.
   */
  readonly metered?: boolean;
  /** Run a one-shot worker (a Crew, or a Sentinel). */
  spawn(req: SpawnRequest): Promise<Session>;
  /**
   * Run a multi-turn conversation with hosted tools. Requires `conversation`,
   * which no adapter here declares — see {@link AdapterCapabilities.conversation}.
   */
  converse(req: ConversationRequest): Promise<Conversation>;
}

/** Thrown when a caller asks for something the adapter declared unsupported. */
export class UnsupportedCapabilityError extends Error {
  constructor(
    readonly adapter: string,
    readonly capability: keyof AdapterCapabilities,
  ) {
    super(`adapter "${adapter}" does not support capability "${capability}"`);
    this.name = 'UnsupportedCapabilityError';
  }
}

export function requireCapability(
  adapter: HarnessAdapter,
  capability: keyof AdapterCapabilities,
): void {
  if (!adapter.capabilities[capability]) {
    throw new UnsupportedCapabilityError(adapter.name, capability);
  }
}
