import {
  CACHE_READ_PRICE_MULTIPLIER,
  CACHE_WRITE_PRICE_MULTIPLIER,
  MODEL_PRICE_USD_PER_MTOK,
} from '@/config/constants';

/**
 * The one place a model turn becomes dollars (SPEC §18.1, §18.6).
 *
 * ## Why it is one function
 *
 * There were three, and all three were wrong in the same way: `run-loop.ts`,
 * `jobs/runs.ts` and `db/queries/runs.ts` each summed
 * `input + cache_creation + cache_read` and priced the total at the plain input
 * rate. A cached read costs a tenth of an input token and a cache write costs a
 * quarter more, so a Job that cached well was over-billed by the app's own Run
 * page and one that wrote a large prefix was under-billed — in three files that
 * would have had to be corrected in three places.
 *
 * The figure is computed from a **committed price constant, not a bill**, and
 * every surface that renders one says so. That claim is only honest if there is
 * a single arithmetic behind it.
 *
 * ## Keyed by model id though we only ever ask for one
 *
 * Server-side refusal fallback can serve a turn from a model we did not choose
 * (SPEC §17.5), so the price table is keyed and an unknown id falls back to
 * `claude-opus-5` rather than pricing at zero — a turn we cannot name is still a
 * turn somebody paid for.
 */

/**
 * The token counts of one turn, named as `usage_event` names them.
 *
 * A `BetaMessage`'s `usage` uses the API's snake_case, so the two callers that
 * hold one project it here; every other caller passes a `usage_event` row
 * straight through, which is the shape this is written for.
 */
export type PricedTokens = {
  model: string | null | undefined;
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
  cacheCreationInputTokens: number | null | undefined;
  cacheReadInputTokens: number | null | undefined;
};

export function priceOf(usage: PricedTokens): number {
  // An upstream row carries no model: Sayari publishes no per-call price, so
  // there is no dollar figure to compute and inventing one would be worse.
  if (!usage.model) return 0;

  const price = MODEL_PRICE_USD_PER_MTOK[usage.model] ?? MODEL_PRICE_USD_PER_MTOK['claude-opus-5']!;
  const perInputToken = price.input / 1_000_000;

  return (
    (usage.inputTokens ?? 0) * perInputToken +
    (usage.cacheCreationInputTokens ?? 0) * perInputToken * CACHE_WRITE_PRICE_MULTIPLIER +
    (usage.cacheReadInputTokens ?? 0) * perInputToken * CACHE_READ_PRICE_MULTIPLIER +
    ((usage.outputTokens ?? 0) * price.output) / 1_000_000
  );
}
