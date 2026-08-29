import type { riskLevel } from '@/db/schema';

/**
 * Classifying a Sayari risk factor (SPEC §9.3).
 *
 * This is the subtlest 60 lines in the scoring code, and it earned that by
 * being got wrong first. Factor names are **compound, not suffixed** — the
 * variant word sits *inside* the name:
 *
 *     forced_labor_aspi_origin_subtier_product_blueprint
 *                                ^^^^^^^ variant, mid-name
 *     exports_bis_high_priority_items_critical_components_indirect
 *     export_controls_adjacent
 *     psa_exports_bis_high_priority_items_direct
 *
 * Two implementations look right and are not:
 *
 * 1. **A split on the trailing token** reads the first name above as *bare*
 *    and deducts `high` at full weight. Measured: that pins six of eight
 *    sampled Suppliers to zero — most of the roster.
 * 2. **A substring search** is worse in a quieter way: `indirect` *contains*
 *    `direct`, so every `_indirect` factor would be read as `_direct` and
 *    scored a band too harshly.
 *
 * So the match is on **whole underscore-delimited tokens**, which is neither.
 */

export type RiskLevel = (typeof riskLevel.enumValues)[number];

/**
 * **Two axes, not one.**
 *
 * SPEC §9.2 lists a six-valued taxonomy — `_direct`, `_indirect`, `_subtier`,
 * `_adjacent`, `psa_`, bare — which reads as one axis. The live data says
 * otherwise: `psa_exports_bis_high_priority_items_direct` *and*
 * `psa_exports_bis_high_priority_items_indirect` both exist, so a factor can be
 * a Twin's **and** carry a distance word.
 *
 * They are separated here because they answer different questions:
 *
 * - **variant** — how far the fact is from the company, which sets the weight
 *   band: `_indirect` and `_adjacent` score one band down, `_subtier` does not
 *   score at all.
 * - **provenance** — *whose record* the fact came from. A `psa_` factor belongs
 *   to a **Twin**: another Sayari record of the same company. Sayari has already
 *   decided the risk is this company's, so it deducts at whatever band its
 *   variant says — but it may not move the award gate.
 *
 * Collapsing them loses the second half of `psa_..._indirect`, and it was a
 * failing dedupe test on a real factor name that surfaced it.
 */
export type FactorVariant = 'direct' | 'indirect' | 'subtier' | 'adjacent' | 'bare';
export type FactorProvenance = 'own' | 'twin';

export type RiskFactor = {
  /** The raw factor name, as Sayari keys it. */
  name: string;
  level: RiskLevel | undefined;
  /**
   * Present on **country-derived** factors, which is how they are identified.
   * `cpi_score`, `eu_high_risk_third` and `basel_aml` all carry it.
   */
  country: unknown;
  /** The evidence a compliance sentence cites. */
  traversalPath: unknown;
  value: unknown;
};

/** Levels in order, so "one band down" is an index shift rather than a table. */
const LEVELS: readonly RiskLevel[] = ['relevant', 'elevated', 'high'];

/**
 * The deduction table (SPEC §9.2). **Provisional** — to be re-fit after the
 * first full roster run, and the re-fit now has to re-fit a Criterion whose
 * *input set* changed, not only its thresholds.
 */
export const DEDUCTION_BY_LEVEL: Record<RiskLevel, number> = {
  high: 40,
  elevated: 20,
  relevant: 8,
};

/** State ownership is its own deduction, not a level. */
export const STATE_OWNERSHIP_DEDUCTION = 25;

/**
 * The four families in which a `high` factor pins the Score to 0 and raises the
 * **disqualifying badge** (SPEC §9.2).
 *
 * Matched on token membership like the variants, for the same reason.
 */
const PINNING_FAMILY_TOKENS: readonly (readonly string[])[] = [
  ['sanctioned'],
  ['sanctions'],
  ['export', 'controls'],
  ['exports', 'bis'],
  ['forced', 'labor'],
];

const tokensOf = (name: string): string[] => name.toLowerCase().split('_').filter(Boolean);

/**
 * Reads the distance word off the name.
 *
 * Precedence follows the scoring rule rather than the name's word order:
 * `subtier` first because it removes the factor from scoring entirely, then the
 * one-band-down pair, then `direct`. A name with none of them is bare — which
 * is the common case and scores at full weight.
 */
export function variantOf(name: string): FactorVariant {
  const tokens = new Set(tokensOf(name));
  if (tokens.has('subtier')) return 'subtier';
  if (tokens.has('indirect')) return 'indirect';
  if (tokens.has('adjacent')) return 'adjacent';
  if (tokens.has('direct')) return 'direct';
  return 'bare';
}

/**
 * A `psa_` factor is a **Twin's**: another Sayari record of the same company.
 *
 * *A Twin is the same company for evidence and never for identity.* Its risk is
 * the Supplier's risk — Sayari has already made that call by writing `psa_*`
 * onto the Profile itself — so refusing it would refuse a signal we cache.
 */
export function isTwinFactor(name: string): boolean {
  return name.toLowerCase().startsWith('psa_');
}

export function provenanceOf(name: string): FactorProvenance {
  return isTwinFactor(name) ? 'twin' : 'own';
}

/** True when the factor belongs to a family a `high` can be disqualifying in. */
export function isPinningFamily(name: string): boolean {
  const tokens = tokensOf(name);
  return PINNING_FAMILY_TOKENS.some((family) => family.every((token) => tokens.includes(token)));
}

/**
 * A country-derived factor is excluded from Compliance risk, because scoring it
 * there would **double-count Country resilience** (SPEC §9.2).
 *
 * Identified by `metadata.country` rather than by a name list, so a
 * country-derived factor we have not seen before is excluded too.
 */
export function isCountryDerived(factor: RiskFactor): boolean {
  return factor.country != null;
}

/** `psa_exports_bis_..._direct` → `exports_bis_..._direct`. */
export function baseNameOf(name: string): string {
  return name.toLowerCase().startsWith('psa_') ? name.slice(4) : name;
}

/**
 * The level a factor is *scored* at, after the variant adjustment.
 *
 * - `subtier` → `undefined`: it is a badge and an Assessment sentence, never a
 *   deduction.
 * - `indirect` / `adjacent` → one band down. `high` becomes `elevated`, and
 *   `relevant` falls off the bottom to nothing.
 * - `direct`, `psa`, `bare` → unchanged, at full weight.
 */
export function effectiveLevel(factor: RiskFactor): RiskLevel | undefined {
  if (!factor.level) return undefined;
  const variant = variantOf(factor.name);
  if (variant === 'subtier') return undefined;
  if (variant !== 'indirect' && variant !== 'adjacent') return factor.level;

  const index = LEVELS.indexOf(factor.level);
  return index > 0 ? LEVELS[index - 1] : undefined;
}

/**
 * Whether this factor raises the **disqualifying badge**, which forces a
 * Recommendation's verdict to `do_not_shortlist` or `escalate` and bars an
 * `award` or `second_source` pick.
 *
 * Two exclusions, and they are the same rule stated twice (SPEC §8.3):
 *
 *   > **A fact reached through a graph edge may move the argument, and may not
 *   > move the award gate.**
 *
 * - A `psa_` factor belongs to a **Twin** — another record of the same company.
 *   It deducts at its variant's band, because Sayari has already decided the
 *   risk is this company's, but it does not disqualify.
 * - `_indirect` and `_adjacent` are one band down, so a `high` becomes
 *   `elevated` and cannot reach the pin. That falls out of `effectiveLevel`
 *   rather than needing its own rule.
 *
 * **Honest cost, which the write-up must state:** a Supplier whose Twin record
 * is owned by a forced-labour-reported entity can still be awarded. It shows a
 * cut Score and a lit badge; it is not blocked.
 */
export function isDisqualifying(factor: RiskFactor): boolean {
  if (isTwinFactor(factor.name)) return false;
  return effectiveLevel(factor) === 'high' && isPinningFamily(factor.name);
}

/**
 * Deduplicates `psa_X` against a base `X` already present, keeping the base.
 *
 * This also repairs a double-count the original scoring rule shipped: a company
 * carrying both `exports_bis_..._direct` and its `psa_` twin was deducted
 * twice for one fact.
 */
export function dedupePsaAgainstBase(factors: readonly RiskFactor[]): RiskFactor[] {
  const ownNames = new Set(
    factors.filter((f) => !isTwinFactor(f.name)).map((f) => f.name.toLowerCase()),
  );
  return factors.filter(
    (f) => !isTwinFactor(f.name) || !ownNames.has(baseNameOf(f.name).toLowerCase()),
  );
}

/** Turns Sayari's `risk` object into the flat list the Criteria work over. */
export function parseRiskObject(risk: unknown): RiskFactor[] {
  if (!risk || typeof risk !== 'object') return [];
  return Object.entries(risk as Record<string, unknown>).map(([name, raw]) => {
    const detail = (raw ?? {}) as {
      level?: unknown;
      value?: unknown;
      metadata?: { country?: unknown; traversal_path?: unknown } | null;
    };
    const level = typeof detail.level === 'string' ? detail.level : undefined;
    return {
      name,
      level: LEVELS.includes(level as RiskLevel) ? (level as RiskLevel) : undefined,
      country: detail.metadata?.country ?? null,
      traversalPath: detail.metadata?.traversal_path ?? null,
      value: detail.value ?? null,
    };
  });
}
