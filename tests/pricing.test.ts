/**
 * Pricing tests.
 *
 * Every expected dollar figure below is computed by hand in the test itself, from
 * the published per-million rate and the multiplier — never by calling the module
 * and asserting it agrees with itself. A test that asks the implementation for the
 * answer would pass just as happily with the rate table transposed.
 *
 * Sums are compared with `toBeCloseTo(..., 12)` rather than `toBe`: the rates are
 * decimal and binary floating point is not, so the last bit of `0.1 * 3` depends on
 * association order. Twelve decimal places is far tighter than any budget cares
 * about and far looser than the noise.
 */

import { describe, expect, it } from 'vitest';

import {
  CACHE_MULTIPLIERS,
  InvalidUsageError,
  MODEL_RATES,
  RATES_AS_OF,
  UNKNOWN_MODEL_RATE,
  priceUsage,
  resolveModelRate,
  type TranscriptUsage,
} from '../src/pricing/index.js';

const MILLION = 1_000_000;

describe('rate table', () => {
  it('carries the published rates for every documented model', () => {
    const published: ReadonlyArray<readonly [string, number, number]> = [
      ['claude-fable-5', 10, 50],
      ['claude-mythos-5', 10, 50],
      ['claude-opus-5', 5, 25],
      ['claude-opus-4-8', 5, 25],
      ['claude-opus-4-7', 5, 25],
      ['claude-opus-4-6', 5, 25],
      ['claude-opus-4-5', 5, 25],
      ['claude-sonnet-5', 3, 15],
      ['claude-sonnet-4-6', 3, 15],
      ['claude-sonnet-4-5', 3, 15],
      ['claude-haiku-4-5', 1, 5],
    ];

    for (const [id, input, output] of published) {
      expect(MODEL_RATES[id], id).toEqual({ inputPerMTok: input, outputPerMTok: output });
    }
    expect(Object.keys(MODEL_RATES).sort()).toEqual(published.map(([id]) => id).sort());
  });

  it('states when it was copied, because a stale table fails silently', () => {
    expect(RATES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('uses the documented cache multipliers', () => {
    expect(CACHE_MULTIPLIERS.read).toBe(0.1);
    expect(CACHE_MULTIPLIERS.write5m).toBe(1.25);
    expect(CACHE_MULTIPLIERS.write1h).toBe(2.0);
  });
});

describe('priceUsage — plain input and output', () => {
  it('prices an exact model at its published rate', () => {
    // 1,000,000 input @ $5/MTok = $5.00; 200,000 output @ $25/MTok = $5.00.
    const result = priceUsage('claude-opus-5', {
      input_tokens: 1_000_000,
      output_tokens: 200_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });

    expect(result.breakdown.inputUsd).toBeCloseTo(5, 12);
    expect(result.breakdown.outputUsd).toBeCloseTo(5, 12);
    expect(result.usd).toBeCloseTo(10, 12);
    expect(result.match).toBe('exact');
    expect(result.estimated).toBe(false);
    expect(result.pricedAs).toBe('claude-opus-5');
    expect(result.model).toBe('claude-opus-5');
  });

  it('prices a cheap model with awkward token counts', () => {
    // 12,345 @ $1/MTok = $0.012345; 6,789 @ $5/MTok = $0.033945.
    const result = priceUsage('claude-haiku-4-5', {
      input_tokens: 12_345,
      output_tokens: 6_789,
    });

    expect(result.breakdown.inputUsd).toBeCloseTo(12_345 / MILLION, 12);
    expect(result.breakdown.outputUsd).toBeCloseTo((6_789 * 5) / MILLION, 12);
    expect(result.usd).toBeCloseTo((12_345 * 1 + 6_789 * 5) / MILLION, 12);
  });

  it('treats absent token fields as zero rather than as an error', () => {
    const result = priceUsage('claude-sonnet-5', { output_tokens: 1_000 });
    expect(result.breakdown.inputUsd).toBe(0);
    expect(result.breakdown.cacheReadUsd).toBe(0);
    expect(result.usd).toBeCloseTo((1_000 * 15) / MILLION, 12);
  });
});

describe('priceUsage — cache reads', () => {
  it('charges cache reads at 0.1x the input rate', () => {
    // 4,000,000 read tokens @ (0.1 x $3/MTok) = $1.20.
    const result = priceUsage('claude-sonnet-5', { cache_read_input_tokens: 4_000_000 });

    expect(result.breakdown.cacheReadUsd).toBeCloseTo((4_000_000 * (3 * 0.1)) / MILLION, 12);
    expect(result.breakdown.cacheReadUsd).toBeCloseTo(1.2, 12);
    expect(result.usd).toBeCloseTo(1.2, 12);
  });
});

describe('priceUsage — cache writes, both TTL paths', () => {
  it('uses the cache_creation split when it is present', () => {
    // sonnet-5 input rate $3/MTok.
    //   1h: 10,000 @ (2.0 x 3) = $6/MTok  -> $0.060
    //   5m: 20,000 @ (1.25 x 3) = $3.75/MTok -> $0.075
    const usage: TranscriptUsage = {
      cache_creation_input_tokens: 30_000,
      cache_creation: {
        ephemeral_1h_input_tokens: 10_000,
        ephemeral_5m_input_tokens: 20_000,
      },
    };
    const result = priceUsage('claude-sonnet-5', usage);

    expect(result.breakdown.cacheWrite1hUsd).toBeCloseTo((10_000 * (3 * 2.0)) / MILLION, 12);
    expect(result.breakdown.cacheWrite1hUsd).toBeCloseTo(0.06, 12);
    expect(result.breakdown.cacheWrite5mUsd).toBeCloseTo((20_000 * (3 * 1.25)) / MILLION, 12);
    expect(result.breakdown.cacheWrite5mUsd).toBeCloseTo(0.075, 12);
    expect(result.usd).toBeCloseTo(0.135, 12);
  });

  it('falls back to 5-minute pricing for the whole total when the split is absent', () => {
    // Same 30,000 tokens, all billed at 1.25x: 30,000 @ $3.75/MTok = $0.1125.
    const result = priceUsage('claude-sonnet-5', { cache_creation_input_tokens: 30_000 });

    expect(result.breakdown.cacheWrite5mUsd).toBeCloseTo((30_000 * (3 * 1.25)) / MILLION, 12);
    expect(result.breakdown.cacheWrite5mUsd).toBeCloseTo(0.1125, 12);
    expect(result.breakdown.cacheWrite1hUsd).toBe(0);
    expect(result.usd).toBeCloseTo(0.1125, 12);
  });

  it('prices the same total differently depending on the TTL mix', () => {
    // The whole reason the split is read at all: 2x vs 1.25x on identical volume.
    const total = { cache_creation_input_tokens: 30_000 };
    const allShort = priceUsage('claude-sonnet-5', total);
    const allLong = priceUsage('claude-sonnet-5', {
      ...total,
      cache_creation: { ephemeral_1h_input_tokens: 30_000, ephemeral_5m_input_tokens: 0 },
    });

    expect(allLong.usd).toBeCloseTo((30_000 * (3 * 2.0)) / MILLION, 12);
    expect(allLong.usd).toBeCloseTo(0.18, 12);
    expect(allShort.usd).toBeCloseTo(0.1125, 12);
    expect(allLong.usd).toBeGreaterThan(allShort.usd);
  });

  it('bills volume the split fails to account for at the 5-minute rate', () => {
    // Split covers 15,000 of a stated 30,000 total; the missing 15,000 is not dropped.
    const result = priceUsage('claude-sonnet-5', {
      cache_creation_input_tokens: 30_000,
      cache_creation: {
        ephemeral_1h_input_tokens: 10_000,
        ephemeral_5m_input_tokens: 5_000,
      },
    });

    expect(result.breakdown.cacheWrite1hUsd).toBeCloseTo((10_000 * (3 * 2.0)) / MILLION, 12);
    expect(result.breakdown.cacheWrite5mUsd).toBeCloseTo((20_000 * (3 * 1.25)) / MILLION, 12);
    expect(result.usd).toBeCloseTo(0.06 + 0.075, 12);
  });

  it('trusts a split that exceeds the stated total', () => {
    const result = priceUsage('claude-sonnet-5', {
      cache_creation_input_tokens: 0,
      cache_creation: {
        ephemeral_1h_input_tokens: 10_000,
        ephemeral_5m_input_tokens: 20_000,
      },
    });
    expect(result.usd).toBeCloseTo(0.135, 12);
  });
});

describe('priceUsage — every component at once', () => {
  it('sums input, output, cache read and both cache writes', () => {
    // opus-5: input $5, output $25 per MTok.
    //   input        100,000 @ 5     = $0.5
    //   output        40,000 @ 25    = $1.0
    //   cache read   500,000 @ 0.5   = $0.25
    //   write 5m     200,000 @ 6.25  = $1.25
    //   write 1h     100,000 @ 10    = $1.0
    const result = priceUsage('claude-opus-5', {
      input_tokens: 100_000,
      output_tokens: 40_000,
      cache_read_input_tokens: 500_000,
      cache_creation_input_tokens: 300_000,
      cache_creation: {
        ephemeral_1h_input_tokens: 100_000,
        ephemeral_5m_input_tokens: 200_000,
      },
    });

    expect(result.breakdown.inputUsd).toBeCloseTo(0.5, 12);
    expect(result.breakdown.outputUsd).toBeCloseTo(1.0, 12);
    expect(result.breakdown.cacheReadUsd).toBeCloseTo(0.25, 12);
    expect(result.breakdown.cacheWrite5mUsd).toBeCloseTo(1.25, 12);
    expect(result.breakdown.cacheWrite1hUsd).toBeCloseTo(1.0, 12);
    expect(result.usd).toBeCloseTo(4.0, 12);
  });
});

describe('zero-token usage', () => {
  it('is exactly zero dollars for an empty usage object', () => {
    const result = priceUsage('claude-opus-5', {});
    expect(result.usd).toBe(0);
    expect(result.breakdown).toEqual({
      inputUsd: 0,
      outputUsd: 0,
      cacheReadUsd: 0,
      cacheWrite5mUsd: 0,
      cacheWrite1hUsd: 0,
    });
    expect(result.estimated).toBe(false);
  });

  it('is zero for explicit zeros, including a zeroed split', () => {
    const result = priceUsage('claude-fable-5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    });
    expect(result.usd).toBe(0);
  });

  it('is still zero — but still flagged — for an unknown model with no tokens', () => {
    const result = priceUsage('claude-nebula-9', {});
    expect(result.usd).toBe(0);
    expect(result.match).toBe('unknown');
    expect(result.estimated).toBe(true);
  });
});

describe('model resolution', () => {
  it('matches a known id exactly', () => {
    expect(resolveModelRate('claude-haiku-4-5')).toEqual({
      rate: { inputPerMTok: 1, outputPerMTok: 5 },
      match: 'exact',
      pricedAs: 'claude-haiku-4-5',
    });
  });

  it('falls back to the family prefix for an unseen point release', () => {
    const cases: ReadonlyArray<readonly [string, number, number]> = [
      ['claude-opus-4-9', 5, 25],
      ['claude-opus-6', 5, 25],
      ['claude-sonnet-6', 3, 15],
      ['claude-haiku-5', 1, 5],
      ['claude-fable-6', 10, 50],
      ['claude-mythos-6', 10, 50],
    ];

    for (const [model, input, output] of cases) {
      const resolved = resolveModelRate(model);
      expect(resolved.match, model).toBe('family');
      expect(resolved.rate, model).toEqual({ inputPerMTok: input, outputPerMTok: output });
    }
  });

  it('reports an explicit unknown outcome for a string it cannot place', () => {
    for (const model of ['claude-nebula-9', 'gpt-5', 'some-internal-alias', '']) {
      const resolved = resolveModelRate(model);
      expect(resolved.match, model).toBe('unknown');
      expect(resolved.pricedAs, model).toBe('unknown-model');
    }
    expect(resolveModelRate(undefined).match).toBe('unknown');
  });

  it('does not answer a table lookup with something off Object.prototype', () => {
    // A model string is parsed JSON off disk. A bare `RATES[model]` answers
    // these with an inherited function or object — not undefined, so it would
    // be reported as an EXACT match, and then every rate read off it is
    // undefined, every product NaN, and the caller floors NaN to $0. That is
    // the one outcome this module exists to make impossible.
    for (const model of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      const resolved = resolveModelRate(model);
      expect(resolved.match, model).toBe('unknown');
      expect(resolved.rate, model).toEqual(UNKNOWN_MODEL_RATE);

      const priced = priceUsage(model, { input_tokens: 1_000_000, output_tokens: 0 });
      expect(Number.isFinite(priced.usd), model).toBe(true);
      expect(priced.usd, model).toBeGreaterThan(0);
    }
  });
});

describe('unknown models are never free', () => {
  it('prices an unknown model at the most expensive known family', () => {
    const dearestInput = Math.max(...Object.values(MODEL_RATES).map((r) => r.inputPerMTok));
    const dearestOutput = Math.max(...Object.values(MODEL_RATES).map((r) => r.outputPerMTok));

    expect(UNKNOWN_MODEL_RATE.inputPerMTok).toBe(dearestInput);
    expect(UNKNOWN_MODEL_RATE.outputPerMTok).toBe(dearestOutput);
    expect(UNKNOWN_MODEL_RATE).toEqual({ inputPerMTok: 10, outputPerMTok: 50 });
  });

  it('charges real dollars for a renamed model, and says the figure is an estimate', () => {
    // The failure this prevents: a $0 price, a budget ceiling that never fires.
    const usage: TranscriptUsage = { input_tokens: 1_000_000, output_tokens: 100_000 };
    const result = priceUsage('claude-something-we-have-never-heard-of', usage);

    expect(result.usd).toBeCloseTo((1_000_000 * 10 + 100_000 * 50) / MILLION, 12);
    expect(result.usd).toBeCloseTo(15, 12);
    expect(result.usd).toBeGreaterThan(0);
    expect(result.match).toBe('unknown');
    expect(result.estimated).toBe(true);
    expect(result.model).toBe('claude-something-we-have-never-heard-of');
  });

  it('never prices an unknown model below any known one for the same tokens', () => {
    const usage: TranscriptUsage = {
      input_tokens: 250_000,
      output_tokens: 80_000,
      cache_read_input_tokens: 900_000,
      cache_creation_input_tokens: 40_000,
      cache_creation: {
        ephemeral_1h_input_tokens: 15_000,
        ephemeral_5m_input_tokens: 25_000,
      },
    };
    const unknown = priceUsage('mystery-model', usage);

    for (const id of Object.keys(MODEL_RATES)) {
      expect(unknown.usd, id).toBeGreaterThanOrEqual(priceUsage(id, usage).usd);
    }
  });

  it('flags a family match as an estimate too', () => {
    const result = priceUsage('claude-opus-4-9', { input_tokens: 1_000_000 });
    expect(result.usd).toBeCloseTo(5, 12);
    expect(result.match).toBe('family');
    expect(result.estimated).toBe(true);
    expect(result.pricedAs).toBe('claude-opus-*');
  });

  it('prices a missing model string rather than skipping it', () => {
    const result = priceUsage(undefined, { input_tokens: 1_000_000 });
    expect(result.usd).toBeCloseTo(10, 12);
    expect(result.estimated).toBe(true);
    expect(result.model).toBeUndefined();
  });
});

describe('malformed token counts', () => {
  it('throws rather than silently pricing garbage at zero', () => {
    const bad: ReadonlyArray<TranscriptUsage> = [
      { input_tokens: -1 },
      { output_tokens: Number.NaN },
      { cache_read_input_tokens: Number.POSITIVE_INFINITY },
      { cache_creation_input_tokens: -100 },
      { cache_creation: { ephemeral_1h_input_tokens: -5 } },
      { cache_creation: { ephemeral_5m_input_tokens: Number.NaN } },
    ];

    for (const usage of bad) {
      expect(() => priceUsage('claude-opus-5', usage)).toThrow(InvalidUsageError);
    }
  });

  it('names the offending field', () => {
    try {
      priceUsage('claude-opus-5', { cache_read_input_tokens: -3 });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidUsageError);
      expect((err as InvalidUsageError).name).toBe('InvalidUsageError');
      expect((err as InvalidUsageError).field).toBe('cache_read_input_tokens');
      expect((err as InvalidUsageError).value).toBe(-3);
    }
  });
});

describe('purity', () => {
  it('is deterministic and does not touch its input', () => {
    const usage: TranscriptUsage = {
      input_tokens: 1_234,
      output_tokens: 567,
      cache_read_input_tokens: 89_000,
      cache_creation_input_tokens: 4_000,
      cache_creation: {
        ephemeral_1h_input_tokens: 1_000,
        ephemeral_5m_input_tokens: 3_000,
      },
    };
    const snapshot = structuredClone(usage);

    expect(priceUsage('claude-opus-5', usage)).toEqual(priceUsage('claude-opus-5', usage));
    expect(usage).toEqual(snapshot);
  });
});
