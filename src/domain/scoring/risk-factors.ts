import type { riskLevel } from '@/db/schema';
import { entitySchema } from '@/upstream/projections/sayari';

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
  /**
   * Which endpoint(s) have ever reported this factor — `getEntity`,
   * `ownership`, `traversal`, … — once `upsertEntity`'s merge has written it
   * back (SPEC §8.2 D5). Absent on a factor freshly parsed straight out of a
   * Sayari payload that has not yet been through that merge.
   */
  sources?: string[] | undefined;
  /**
   * The structured evidence behind this factor, from `attributes.risk_
   * intelligence` — a program name, a listing authority, the list itself, a
   * reason and an effective-date range, where Sayari attaches them. Absent on
   * a factor `attachRiskIntelligence` was never given a matching entry for,
   * which is the common case: the attribute is populated for the sanctions/
   * export-control family and largely empty elsewhere.
   */
  riskIntelligence?: RiskIntelligenceEntry[] | undefined;
};

/**
 * One entry of `attributes.risk_intelligence` matched to a `RiskFactor` by
 * `properties.type` (see `attachRiskIntelligence`) — the specific program,
 * authority and date range behind a factor name, rather than the bare name
 * alone. A compliance sentence that can cite "Autonomous (Ukraine), Consolidated
 * Australian Sanctions List, from 2022-03-18" says more than one that can only
 * cite `sanctioned`.
 */
export type RiskIntelligenceEntry = {
  /** Which sanctions/export-control/etc. program this hit is under. */
  program: string | undefined;
  /** The authority or list operator that issued the listing. */
  authority: string | undefined;
  /** The list name. */
  list: string | undefined;
  /** Free-text listing rationale, when Sayari attaches one. */
  reason: string | undefined;
  /** The date this hit came into effect, when Sayari attaches one. */
  fromDate: string | undefined;
  /** The date this hit stopped applying, when Sayari attaches one. */
  toDate: string | undefined;
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
 * The families in which a `high` factor pins the Score to 0 and raises the
 * **disqualifying badge** (SPEC §9.2) — every token combination that names a
 * `sanctions`, `export_controls` or `forced_labor` factor.
 *
 * Matched on token membership like the variants, for the same reason.
 *
 * **Checked against `ontology.getRiskFactors`' own `categories` field**, not
 * guessed at: fetching the full ~720-factor vocabulary and comparing each
 * factor's own `categories` array against what this list would classify it as
 * found 143 factors Sayari itself categorises `sanctions`,
 * `export_controls`, `forced_labor` or `sanctions_and_export_control_lists`
 * (the same disqualifying family under a fourth, list-specific category
 * string) that the five original token families missed entirely — program-
 * specific names with no literal "sanctioned"/"sanctions"/"export"+
 * "controls"/"forced"+"labor" tokens in them at all: `wro_entity` (a US
 * Customs Withhold Release Order, forced labor), `controlled_by_ofac_sdn`
 * (Treasury's SDN list, sanctions), `owned_by_usa_bis_entity` (Commerce's
 * Entity List, export controls), and around 140 more of the same shape. Every
 * family below is a token verified to appear ONLY on factors in one of the
 * four disqualifying categories, across the full fetched vocabulary — not a
 * guess at what a name might mean. `['exports', 'bis']` from the original
 * five is gone: `['bis']` alone is a strict superset of it, verified the same
 * way, so keeping both was dead weight. One factor, `military_end_use_china_
 * keywords`, still slips past every family here (a compound name none of the
 * verified tokens covers alone without also risking a name this vocabulary
 * does not contain yet) — left uncorrected rather than guessed at.
 */
const PINNING_FAMILY_TOKENS: readonly (readonly string[])[] = [
  ['sanctioned'],
  ['sanctions'],
  ['export', 'controls'],
  ['forced', 'labor'],
  /** Bureau of Industry and Security — the Commerce Dept.'s export-controls arm. */
  ['bis'],
  /** BIS's Military End User list. */
  ['meu'],
  /** Treasury's OFAC sanctions programs. */
  ['ofac'],
  /** US Customs' Withhold Release Order list — forced labor. */
  ['wro'],
  /** The forced-labor-flagged region. */
  ['xinjiang'],
  /** Sheffield Hallam University's forced-labor-in-supply-chain reports. */
  ['sheffield'],
  /** The Arms Export Control Act debarred list. */
  ['aeca'],
  /** State Dept.'s International Security and Nonproliferation sanctions. */
  ['isn'],
  /** Japan METI's end-user export-controls list. */
  ['meti'],
  /** Japan MOFA's export-ban list. */
  ['mofa'],
  /** NDAA §889's covered-telecom-equipment export-controls list. */
  ['ndaa'],
  /** NDAA §1260H's Chinese military companies list. */
  ['1260h'],
  /** China's Military-Industrial Complex list. */
  ['cmic'],
  /** China's military-civil fusion export-controls flag. */
  ['military', 'end', 'use'],
  /** Entities licensed with Russia's FSB. */
  ['fsb'],
  /** DOL ILAB's forced/child-labor goods list. */
  ['ilab'],
  /** Conflict-minerals sourcing — forced labor. */
  ['conflict', 'minerals'],
  /** Russia-specific import/export sanctions (coal, gold, oil, "important goods"). */
  ['russian'],
  /** The EU/UK/US 50%-ownership-rule sanctions extensions. */
  ['percent', 'rule'],
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

/**
 * Turns Sayari's `risk` object into the flat list the Criteria work over.
 *
 * **Reads exactly the three keys Sayari's own shape carries — `level`,
 * `value`, `metadata` — and no more.** `src/tools/catalog/reads.ts` passes
 * `entity.risk` to a model turn **verbatim, with no projection**
 * (`risk: match.entity.risk`), so this column's shape is load-bearing beyond
 * this function: an extra key here would be an extra key in a live prompt,
 * silently different from every recorded fixture that predates it. That is
 * why the risk union's per-factor provenance (SPEC §8.2 D5) lives on the
 * *sibling* `risk_sources` column instead — see its own comment, and
 * `attachRiskSources` below, which is the one place the two are joined back
 * together for a caller that wants both.
 */
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

/**
 * Joins `parseRiskObject`'s factors back up with the `risk_sources` column,
 * for a caller that wants to say *which endpoint(s) reported this* (SPEC §8.2
 * D5) — never a caller whose output could reach a model turn verbatim, since
 * that is precisely the case `parseRiskObject` itself stays clear of.
 */
export function attachRiskSources(
  factors: readonly RiskFactor[],
  riskSources: unknown,
): RiskFactor[] {
  if (!riskSources || typeof riskSources !== 'object') return [...factors];
  const bySources = riskSources as Record<string, unknown>;
  return factors.map((factor) => {
    const raw = bySources[factor.name];
    const sources = Array.isArray(raw)
      ? raw.filter((s): s is string => typeof s === 'string')
      : undefined;
    return sources && sources.length > 0 ? { ...factor, sources } : factor;
  });
}

/**
 * Reads one `attributes.risk_intelligence` entry's `properties` bag into a
 * `RiskIntelligenceEntry`, or `undefined` when the entry carries none of the
 * named fields at all — an entry whose only content is a free-form key this
 * app does not read (e.g. "Listing Information", "License Policy") attaches
 * nothing rather than an object of all-`undefined` fields.
 *
 * Reads snake_case keys (`from_date`, `to_date`) — the same casing every
 * other reader in this file expects off Sayari data, because normalising key
 * casing is the upstream projection layer's job, not this one's (see
 * `parseRiskObject`'s own `metadata.traversal_path`, never `traversalPath`,
 * for the same rule).
 */
function riskIntelligenceEntryOf(properties: unknown): RiskIntelligenceEntry | undefined {
  if (!properties || typeof properties !== 'object') return undefined;
  const p = properties as Record<string, unknown>;
  const entry: RiskIntelligenceEntry = {
    program: typeof p.program === 'string' ? p.program : undefined,
    authority: typeof p.authority === 'string' ? p.authority : undefined,
    list: typeof p.list === 'string' ? p.list : undefined,
    reason: typeof p.reason === 'string' && p.reason.length > 0 ? p.reason : undefined,
    fromDate: typeof p.from_date === 'string' ? p.from_date : undefined,
    toDate: typeof p.to_date === 'string' ? p.to_date : undefined,
  };
  return Object.values(entry).some((v) => v !== undefined) ? entry : undefined;
}

/**
 * Every `attributes.risk_intelligence` entry, grouped by its
 * `properties.type` — **the same vocabulary a flat `risk` object's keys
 * use**, measured directly against a real payload: a `risk_intelligence`
 * entry with `properties.type: "sanctioned_aus_dfat"` sits on an entity whose
 * `risk` object carries a `sanctioned_aus_dfat` key of its own. That shared
 * vocabulary is what `attachRiskIntelligence` joins on.
 *
 * Accepts either the attribute block's own `{ data: [...] }` shape or a bare
 * array of entries, so a caller holding either can pass it straight through
 * without unwrapping it first.
 */
function riskIntelligenceByType(riskIntelligence: unknown): Map<string, RiskIntelligenceEntry[]> {
  const byType = new Map<string, RiskIntelligenceEntry[]>();
  const rows = Array.isArray(riskIntelligence)
    ? riskIntelligence
    : riskIntelligence && typeof riskIntelligence === 'object'
      ? (riskIntelligence as { data?: unknown }).data
      : undefined;
  if (!Array.isArray(rows)) return byType;

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const properties = (row as { properties?: unknown }).properties;
    const type = (properties as { type?: unknown } | undefined)?.type;
    if (typeof type !== 'string' || type.length === 0) continue;
    const entry = riskIntelligenceEntryOf(properties);
    if (!entry) continue;
    const key = type.toLowerCase();
    const existing = byType.get(key);
    if (existing) existing.push(entry);
    else byType.set(key, [entry]);
  }
  return byType;
}

/**
 * Joins `parseRiskObject`'s factors with the structured evidence Sayari
 * attaches on `attributes.risk_intelligence` — a program, an authority, a
 * list name, a reason and an effective-date range, matched to a factor by
 * name (`properties.type` and a `risk` key are the same vocabulary on the
 * same entity, per `riskIntelligenceByType`'s own doc comment). A factor with
 * no matching entry is returned unchanged, the same "nothing to add"
 * behaviour `attachRiskSources` has for a factor `risk_sources` never named.
 *
 * Deliberately mirrors `attachRiskSources`'s shape: a second sibling join,
 * over a second piece of provenance, onto the same `parseRiskObject` output
 * — never a reason to widen `parseRiskObject` itself, for the reason its own
 * doc comment gives (SPEC §8.2 D5's `risk`-reaches-a-model-turn-verbatim
 * rule applies here exactly as it does to `risk_sources`).
 */
export function attachRiskIntelligence(
  factors: readonly RiskFactor[],
  riskIntelligence: unknown,
): RiskFactor[] {
  const byType = riskIntelligenceByType(riskIntelligence);
  if (byType.size === 0) return [...factors];
  return factors.map((factor) => {
    const entries = byType.get(factor.name.toLowerCase());
    return entries && entries.length > 0 ? { ...factor, riskIntelligence: entries } : factor;
  });
}

/**
 * `attributes.risk_intelligence`, off a cached `upstream_response` row for the
 * SAME entity — a program, an authority, a list name and an effective-date
 * range behind a factor, where Sayari attaches them. The one shared reader for
 * `attachRiskIntelligence`'s second argument, used both by a page's own render
 * (`db/queries/entity-page.ts`) and by live compliance-risk scoring
 * (`jobs/enrich-supplier.ts`), so the two never drift onto two different ideas
 * of "the cached body".
 *
 * Undefined whenever `source` itself is — most entities were never fetched on
 * their own and carry no cached body of their own to read, and that is the
 * common, harmless case: `attachRiskIntelligence` already treats "nothing to
 * join" as "leave every factor as it was". A body that no longer parses
 * against `entitySchema` reads as absent too, rather than failing the caller.
 */
export function cachedRiskIntelligenceOf(source: { body: unknown } | null | undefined): unknown {
  if (!source) return undefined;
  const parsed = entitySchema.safeParse(source.body);
  return parsed.success ? parsed.data.attributes?.['risk_intelligence'] : undefined;
}
