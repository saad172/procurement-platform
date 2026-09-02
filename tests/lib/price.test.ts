import { describe, expect, it } from 'vitest';
import { priceOf } from '@/lib/price';
import {
  CACHE_READ_PRICE_MULTIPLIER,
  CACHE_WRITE_PRICE_MULTIPLIER,
  MODEL_PRICE_USD_PER_MTOK,
} from '@/config/constants';

/**
 * SPEC §18.1, §18.6.
 *
 * The arithmetic was written out three times — the model chokepoint, the budget
 * check and the Runs page — and every copy priced a cached read at the plain
 * input rate. These pin the two multipliers that made the copies wrong, because
 * a figure labelled *a committed price constant, not a bill* is only honest if
 * the constant is applied the way the vendor bills it.
 */

const OPUS = MODEL_PRICE_USD_PER_MTOK['claude-opus-5']!;
const none = {
  model: 'claude-opus-5',
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

describe('priceOf', () => {
  it('prices a plain input token at the table rate', () => {
    expect(priceOf({ ...none, inputTokens: 1_000_000 })).toBeCloseTo(OPUS.input, 10);
  });

  it('prices an output token at the output rate', () => {
    expect(priceOf({ ...none, outputTokens: 1_000_000 })).toBeCloseTo(OPUS.output, 10);
  });

  it('prices a cache READ at a tenth of an input token, not at one', () => {
    expect(priceOf({ ...none, cacheReadInputTokens: 1_000_000 })).toBeCloseTo(
      OPUS.input * CACHE_READ_PRICE_MULTIPLIER,
      10,
    );
    // The bug this replaces: the same million tokens billed as plain input.
    expect(priceOf({ ...none, cacheReadInputTokens: 1_000_000 })).not.toBeCloseTo(OPUS.input, 10);
  });

  it('prices a cache WRITE at a quarter more than an input token', () => {
    expect(priceOf({ ...none, cacheCreationInputTokens: 1_000_000 })).toBeCloseTo(
      OPUS.input * CACHE_WRITE_PRICE_MULTIPLIER,
      10,
    );
  });

  it('falls back to opus for a model id the table does not name', () => {
    // Server-side refusal fallback can serve a turn from a model we did not
    // choose, and a turn we cannot name is still a turn somebody paid for.
    expect(priceOf({ ...none, model: 'claude-something-unreleased', inputTokens: 1_000_000 })).toBe(
      priceOf({ ...none, inputTokens: 1_000_000 }),
    );
  });

  it('prices an upstream row at zero, because Sayari publishes no per-call price', () => {
    expect(priceOf({ ...none, model: null, inputTokens: 1_000_000 })).toBe(0);
  });
});
