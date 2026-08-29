/**
 * The fixed anchors (SPEC §9.1).
 *
 * Every Criterion returns **0–100 where higher is better for this Program**,
 * from an anchor declared here as a documented constant.
 *
 * **Anchors are never derived from the roster.** 42 of 50 rows are G7 origins,
 * so a min-max stretch across this roster would magnify a rounding difference
 * between Germany and Japan into a visible score gap. A value outside its
 * anchor **clamps, visibly** — the clamp is reported, not hidden.
 *
 * Each anchor carries the sentence the UI renders beside the number, because
 * **the app may never render a Criterion number alone**: every value shows as a
 * band plus its raw input, so *Compliance risk 92* cannot be misread as *very
 * risky*.
 */

/** Clamps into 0–100 and reports whether it had to. */
export function clamp100(value: number): { value: number; clamped: boolean } {
  if (Number.isNaN(value)) return { value: 0, clamped: true };
  if (value < 0) return { value: 0, clamped: true };
  if (value > 100) return { value: 100, clamped: true };
  return { value, clamped: false };
}

// ── Tariff exposure ──────────────────────────────────────────────────────────

/**
 * 0–10% MFN, linear. 0% → 100, 2.5% → 75, 3.4% → 66, 4.2% → 58, 5% → 50.
 *
 * The anchor is tightened to 10% rather than left open because every rate in
 * the seed sits between 0 and 5%, and a wider anchor would compress the whole
 * roster into the top of the scale.
 */
export const TARIFF_ANCHOR_MAX_RATE_PCT = 10;

export function tariffScore(mfnRatePct: number): number {
  return clamp100(100 * (1 - Math.min(mfnRatePct, TARIFF_ANCHOR_MAX_RATE_PCT) / TARIFF_ANCHOR_MAX_RATE_PCT)).value;
}

export const TARIFF_ANCHOR_LINE = `0–${TARIFF_ANCHOR_MAX_RATE_PCT}% MFN, linear — 0% scores 100, ${TARIFF_ANCHOR_MAX_RATE_PCT}% or more scores 0`;

// ── Proximity ────────────────────────────────────────────────────────────────

/**
 * 8 000 km, **linear-clamped, not square-rooted**.
 *
 * The prototype used a square root, which asserts precision a head-office
 * centroid does not have. The measurement that settled it: the roster has
 * **no Supplier at all between 824 km and 6 082 km** — 14 rows at 48–824 km,
 * 20 at 6 082–7 039 km, 16 at 10 102–11 878 km. With a gap that wide, the shape
 * of the curve between the clusters is decoration.
 */
export const PROXIMITY_ANCHOR_MAX_KM = 8_000;

export function proximityScore(km: number): number {
  return clamp100(100 * (1 - Math.min(km, PROXIMITY_ANCHOR_MAX_KM) / PROXIMITY_ANCHOR_MAX_KM)).value;
}

export const PROXIMITY_ANCHOR_LINE = `0–${PROXIMITY_ANCHOR_MAX_KM.toLocaleString('en-US')} km to the nearest Plant, linear — measured from a registered address, which is not a factory`;

// ── Media signal ─────────────────────────────────────────────────────────────

/**
 * A **flag-weighted** count, not a raw one, anchored 0–20.
 *
 * Weighting matters because article counts on roster names ran 0–9 and a raw
 * count would let nine unflagged mentions of a common trade name outweigh one
 * flagged report.
 */
export const MEDIA_ANCHOR_MAX_WEIGHTED = 20;
export const MEDIA_FLAG_WEIGHTS = { serious: 3, moderate: 1, unflagged: 0.5 } as const;

export function mediaScore(weightedCount: number): number {
  return clamp100(100 * (1 - Math.min(weightedCount, MEDIA_ANCHOR_MAX_WEIGHTED) / MEDIA_ANCHOR_MAX_WEIGHTED)).value;
}

export const MEDIA_ANCHOR_LINE = `flag-weighted article count 0–${MEDIA_ANCHOR_MAX_WEIGHTED} (serious ×${MEDIA_FLAG_WEIGHTS.serious}, moderate ×${MEDIA_FLAG_WEIGHTS.moderate}, unflagged ×${MEDIA_FLAG_WEIGHTS.unflagged})`;

// ── Country resilience ───────────────────────────────────────────────────────

/**
 * Six World Bank indicators at fixed sub-weights summing to 100.
 *
 * LPI is 1–5 and is rescaled `(x−1)/4×100`. The five WGI dimensions use the
 * World Bank's **own `.SC` 0–100 scale** rather than the −2.5..2.5 estimate,
 * because `.SC` ships with confidence bounds (`.SC_LB` / `.SC_UB`) — and the
 * bounds are what let the UI render a band. **Overlapping bands are not a real
 * difference**, and on a 42/50 G7 roster most of them overlap.
 *
 * GDP per capita is context and is never scored.
 */
export const COUNTRY_INDICATORS = [
  { code: 'LP.LPI.OVRL.XQ', label: 'Logistics Performance Index', subWeight: 35, scale: 'lpi' },
  { code: 'GOV_WGI_PV.EST.SC', label: 'Political stability', subWeight: 20, scale: 'sc' },
  { code: 'GOV_WGI_RL.EST.SC', label: 'Rule of law', subWeight: 15, scale: 'sc' },
  { code: 'GOV_WGI_RQ.EST.SC', label: 'Regulatory quality', subWeight: 10, scale: 'sc' },
  { code: 'GOV_WGI_CC.EST.SC', label: 'Control of corruption', subWeight: 10, scale: 'sc' },
  { code: 'GOV_WGI_GE.EST.SC', label: 'Government effectiveness', subWeight: 10, scale: 'sc' },
] as const;

/** LPI is 1–5; the WGI `.SC` codes are already 0–100. */
export function normaliseIndicator(scale: 'lpi' | 'sc', raw: number): number {
  return scale === 'lpi' ? clamp100(((raw - 1) / 4) * 100).value : clamp100(raw).value;
}

export const COUNTRY_ANCHOR_LINE =
  'LPI rescaled from 1–5, plus five WGI dimensions on the World Bank’s own 0–100 scale, at fixed sub-weights';

// ── Data confidence bands ────────────────────────────────────────────────────

/**
 * The gate on *clean* (SPEC §9.2). **Provisional.**
 *
 * `sourceCount` is an **object keyed by source hash**, so the band counts
 * **distinct sources**, and the UI must say which it means.
 *
 * **Honest cost:** the floors are absolute, so a Supplier in a sparse registry
 * reads `thin` more often than a German one. It costs no points — that is
 * exactly why data confidence was demoted from a Criterion to a badge — so this
 * is a threshold question folded into the post-roster re-fit rather than a
 * fairness one.
 */
export const DATA_CONFIDENCE = {
  strong: { minDistinctSources: 15, minEnrichments: 'all' },
  adequate: { minDistinctSources: 5, minEnrichments: 3 },
} as const;

/**
 * The Enrichments a Supplier with an accepted Match should have. The checklist
 * is what data confidence counts — **never a row count**, because country and
 * tariff Enrichments are shared across Suppliers and would inflate it.
 */
export const EXPECTED_ENRICHMENTS = [
  'sayari_negative_news',
  'sayari_ownership_family',
  'world_bank',
  'gleif',
  'usitc',
  'nominatim',
] as const;
