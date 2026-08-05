/**
 * Token counts -> USD. BlueSpace's own pricing, because nothing else will do it.
 *
 * The vendor SDK reported `costUsd` per turn and we simply believed it. Interactive
 * Claude Code sessions do not: the on-disk transcript carries token counts and a
 * model string, and that is all. The per-task budget ceiling and `projectCost` are
 * both denominated in dollars, so the conversion is now BlueSpace's problem, and a
 * wrong answer here means the budget kill fires early, late, or never.
 *
 * THE TABLE BELOW IS A POINT-IN-TIME COPY, TAKEN 2026-08-04, of Anthropic's public
 * per-million-token rates. It is not fetched, and nothing at runtime will notice
 * when it goes stale. RE-CHECK IT whenever a model ships, a price changes, or this
 * file's date starts looking old — a stale table is the silent-failure mode of this
 * module, because every number it produces still looks perfectly plausible.
 *
 * Two decisions carry the module:
 *
 *  1. UNKNOWN MODELS ARE NEVER FREE. An unrecognized model string is priced at the
 *     most expensive known family and reported as an estimate. The failure this
 *     prevents is specific: a renamed model silently priced at $0, a budget that
 *     therefore never trips, and a task that runs until something else stops it.
 *     Over-charging a budget is recoverable; a ceiling that cannot fire is not.
 *  2. THE CACHE-CREATION SPLIT IS USED WHEN PRESENT. A 1-hour cache write costs 2x
 *     the input rate and a 5-minute one costs 1.25x — a 60% difference on what is
 *     often the largest line item in an agentic turn. Collapsing both into one
 *     "cache write" number would be wrong by that much on every cached run.
 *
 * Pure: no I/O, no clock, no randomness. Same inputs, same dollars, forever.
 */

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

/** Dollars per million tokens for one model. */
export interface ModelRate {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

/**
 * Published list prices, USD per million tokens, as of {@link RATES_AS_OF}.
 *
 * Introductory and promotional prices are deliberately NOT encoded: they expire on
 * a date, and a table that silently disagrees with the invoice after that date is
 * worse than one that is uniformly a little conservative.
 */
const RATES = {
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-mythos-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
} as const satisfies Record<string, ModelRate>;

/** The date the rates above were copied from Anthropic's pricing page. */
export const RATES_AS_OF = '2026-08-04';

/** Exported so callers and tests can inspect the whole table, not just query it. */
export const MODEL_RATES: Readonly<Record<string, ModelRate>> = RATES;

/** Model ids this table prices exactly. */
export type KnownModelId = keyof typeof RATES;

/**
 * Cache pricing is expressed as multipliers on the model's INPUT rate, which is
 * why there is one set of numbers here rather than a per-model cache column.
 */
export const CACHE_MULTIPLIERS = {
  /** Reading an existing cache entry. */
  read: 0.1,
  /** Writing a cache entry with the default 5-minute TTL. */
  write5m: 1.25,
  /** Writing a cache entry with the 1-hour TTL. */
  write1h: 2.0,
} as const;

/**
 * Family prefixes, MOST EXPENSIVE FIRST.
 *
 * Order is load-bearing twice over: the first matching prefix wins, so a model
 * string that somehow matches two families is priced at the dearer of them, and
 * the first entry doubles as the rate for a string that matches nothing at all.
 * Both tie-breaks deliberately round against us rather than against the budget.
 */
const FAMILY_FALLBACKS = [
  { prefix: 'claude-fable', rate: RATES['claude-fable-5'] },
  { prefix: 'claude-mythos', rate: RATES['claude-mythos-5'] },
  { prefix: 'claude-opus', rate: RATES['claude-opus-5'] },
  { prefix: 'claude-sonnet', rate: RATES['claude-sonnet-5'] },
  { prefix: 'claude-haiku', rate: RATES['claude-haiku-4-5'] },
] as const;

/** What an unrecognized model string is priced at. See decision (1) in the header. */
export const UNKNOWN_MODEL_RATE: ModelRate = FAMILY_FALLBACKS[0].rate;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * The TTL breakdown of `cache_creation_input_tokens`. Absent on older transcripts,
 * which is the only reason this module has a fallback path at all.
 *
 * Fields are nullable because this is parsed JSON off disk, not a value we built.
 */
export interface CacheCreationSplit {
  ephemeral_1h_input_tokens?: number | null;
  ephemeral_5m_input_tokens?: number | null;
}

/** `message.usage` as the Claude Code transcript writes it. */
export interface TranscriptUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  /** TOTAL cache-creation tokens; `cache_creation` splits this same total by TTL. */
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: CacheCreationSplit | null;
}

/** Thrown when a token count is negative or not a finite number. */
export class InvalidUsageError extends Error {
  constructor(
    readonly field: string,
    readonly value: unknown,
  ) {
    super(`usage field "${field}" is not a token count: ${String(value)}`);
    this.name = 'InvalidUsageError';
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** How the model string was resolved to a rate. Anything but `exact` is a guess. */
export type RateMatch = 'exact' | 'family' | 'unknown';

export interface RateResolution {
  readonly rate: ModelRate;
  readonly match: RateMatch;
  /** The table entry or family whose rate was used, for logs and audits. */
  readonly pricedAs: string;
}

/** Per-component dollars. Sums to {@link PriceResult.usd}. */
export interface PriceBreakdown {
  readonly inputUsd: number;
  readonly outputUsd: number;
  readonly cacheReadUsd: number;
  readonly cacheWrite5mUsd: number;
  readonly cacheWrite1hUsd: number;
}

export interface PriceResult {
  readonly usd: number;
  /** The model string exactly as the transcript gave it. */
  readonly model: string | undefined;
  readonly match: RateMatch;
  readonly pricedAs: string;
  /**
   * True when `match` is not `exact`. Callers that surface a cost to the captain,
   * or that decide a budget kill, should say so — the number is a lower bound on
   * confidence, not on dollars.
   */
  readonly estimated: boolean;
  readonly breakdown: PriceBreakdown;
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * Resolve a model string to a rate: exact key, then documented family prefix, then
 * the explicit unknown outcome. Exported because "what did we think this model
 * was?" is a question worth answering without pricing a fake turn.
 */
export function resolveModelRate(model: string | undefined): RateResolution {
  if (model !== undefined && model !== '') {
    const exact = MODEL_RATES[model];
    if (exact !== undefined) {
      return { rate: exact, match: 'exact', pricedAs: model };
    }
    for (const family of FAMILY_FALLBACKS) {
      if (model.startsWith(family.prefix)) {
        return { rate: family.rate, match: 'family', pricedAs: `${family.prefix}-*` };
      }
    }
  }
  return { rate: UNKNOWN_MODEL_RATE, match: 'unknown', pricedAs: 'unknown-model' };
}

/** Convert one transcript `message.usage` block into dollars. */
export function priceUsage(model: string | undefined, usage: TranscriptUsage): PriceResult {
  const { rate, match, pricedAs } = resolveModelRate(model);

  const input = tokenCount(usage.input_tokens, 'input_tokens');
  const output = tokenCount(usage.output_tokens, 'output_tokens');
  const cacheRead = tokenCount(usage.cache_read_input_tokens, 'cache_read_input_tokens');
  const { write5m, write1h } = splitCacheCreation(usage);

  const breakdown: PriceBreakdown = {
    inputUsd: perMillion(input, rate.inputPerMTok),
    outputUsd: perMillion(output, rate.outputPerMTok),
    cacheReadUsd: perMillion(cacheRead, rate.inputPerMTok * CACHE_MULTIPLIERS.read),
    cacheWrite5mUsd: perMillion(write5m, rate.inputPerMTok * CACHE_MULTIPLIERS.write5m),
    cacheWrite1hUsd: perMillion(write1h, rate.inputPerMTok * CACHE_MULTIPLIERS.write1h),
  };

  return {
    usd:
      breakdown.inputUsd +
      breakdown.outputUsd +
      breakdown.cacheReadUsd +
      breakdown.cacheWrite5mUsd +
      breakdown.cacheWrite1hUsd,
    model,
    match,
    pricedAs,
    estimated: isEstimate(match),
    breakdown,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isEstimate(match: RateMatch): boolean {
  switch (match) {
    case 'exact':
      return false;
    case 'family':
    case 'unknown':
      return true;
    default: {
      // Compile-time exhaustiveness: a new RateMatch member fails to build here.
      const unreachable: never = match;
      void unreachable;
      return true;
    }
  }
}

/**
 * Split cache-creation tokens by TTL.
 *
 * `cache_creation` is authoritative for the TTL mix and `cache_creation_input_tokens`
 * for the volume, and the two can disagree — a transcript written across a schema
 * change, a field the harness stopped emitting. Any volume the split fails to
 * account for is billed at 5 minutes rather than dropped, so a partial split
 * under-states cost by at most the multiplier gap instead of by whole tokens.
 * A split that exceeds the total is trusted as-is, for the same reason.
 */
function splitCacheCreation(usage: TranscriptUsage): { write5m: number; write1h: number } {
  const total = tokenCount(usage.cache_creation_input_tokens, 'cache_creation_input_tokens');
  const split = usage.cache_creation;
  if (split === undefined || split === null) {
    // Pre-split transcripts only ever wrote 5-minute entries.
    return { write5m: total, write1h: 0 };
  }

  const write1h = tokenCount(split.ephemeral_1h_input_tokens, 'ephemeral_1h_input_tokens');
  const stated5m = tokenCount(split.ephemeral_5m_input_tokens, 'ephemeral_5m_input_tokens');
  const unaccounted = Math.max(0, total - (write1h + stated5m));
  return { write5m: stated5m + unaccounted, write1h };
}

function tokenCount(value: number | null | undefined, field: string): number {
  if (value === undefined || value === null) return 0;
  if (!Number.isFinite(value) || value < 0) throw new InvalidUsageError(field, value);
  return value;
}

function perMillion(tokens: number, ratePerMTok: number): number {
  return (tokens * ratePerMTok) / 1_000_000;
}
