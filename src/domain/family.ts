import {
  dedupePsaAgainstBase,
  effectiveLevel,
  isCountryDerived,
  parseRiskObject,
  type RiskFactor,
  type RiskLevel,
} from './scoring/risk-factors';

/**
 * The Corporate family (SPEC §8).
 *
 * Graduated from a measurement, and it changed the heaviest Criterion in the
 * app. Three facts carry the whole design:
 *
 * 1. **The family costs one call, not 25.** `traversal.ownership` returns each
 *    path terminal as a **full entity with its `risk` block inline**, so the
 *    family read never has to fan out into fifty `getEntity` calls. That price
 *    is what put it on the *standard* enrichment path rather than behind a
 *    button — and a badge that only appears when someone thinks to ask is a
 *    badge the Shortlist cannot be trusted to carry.
 *
 * 2. **The family is downward-only and psa-routed.** The paths run through one
 *    or two `possibly_same_as` hops to *other records of the same company*:
 *    Sayari splits a company across records and the ownership hangs off the
 *    others. On the measured company `traversal.ubo` returned 0 and
 *    ownership-typed `traversal.traversal` at depth 2 returned 0, while
 *    `traversal.ownership` reached all 17 members.
 *
 * 3. **A family member's risk badges and never deducts.** The seed contains two
 *    shared-parent pairs, so a deduction would move two Suppliers' ranks off one
 *    shared fact — the double-count already refused for shared ownership.
 *    **Ranks do not move.**
 */

export type FamilyMemberRisk = {
  entityId: string;
  label: string;
  country: string | null;
  factors: RiskFactor[];
  /**
   * Ownership hops from the root, `possibly_same_as` steps not counted.
   *
   * A Deep Traversal reaches members at depth 2 and 3 that the automatic read
   * stopped short of, and CONTEXT says such a member is *a Family member like
   * any other* — so the depth is carried on the same type rather than on a
   * parallel one, and the panel renders it in the same table.
   */
  hopDepth: number;
  /** True when a Deep Traversal found it rather than the automatic read. */
  fromDeepTraversal: boolean;
};

/**
 * How much of a family one read covered.
 *
 * `explored` is how many members are held; `reachable` is how many the API says
 * exist. `partial` is the third fact and it is not derivable from the other
 * two: a walk that stopped at its own cap holds a known count of an **unknown**
 * total, which reads identically to a complete small family unless it is said.
 */
export type FamilyCoverage = {
  explored: number;
  reachable: number | null;
  /** True when the walk stopped at a cap rather than at the end of the graph. */
  partial?: boolean | undefined;
};

/**
 * The Family exposure badge, in **three** states — and **the state names carry
 * the decision** (SPEC §8.4).
 *
 * Collapsing *not covered* into *no exposure found* would report an empty
 * ownership graph in the same ink as a genuinely clean family. Six of twelve
 * sampled families returned zero members, including several that certainly have
 * subsidiaries, so the two are not rare edge cases — they are most of the roster.
 */
type Covered = { explored: number; reachable: number | null; partial: boolean };

/** One member the badge names, with the hop that reached it. */
export type FamilyExposureMember = {
  entityId: string;
  label: string;
  level: RiskLevel;
  factors: string[];
  /** Rendered beside the name, so hop 3 is visibly not hop 1. */
  hopDepth: number;
  fromDeepTraversal: boolean;
};

export type FamilyExposure =
  | ({ state: 'not_covered' } & Covered)
  | ({ state: 'no_exposure_found' } & Covered)
  | ({
      state: 'exposure_found';
      worstLevel: RiskLevel;
      membersWithExposure: number;
      /** Named so a compliance sentence can cite the member's OWN entity. */
      members: FamilyExposureMember[];
    } & Covered);

export function computeFamilyExposure(
  members: readonly FamilyMemberRisk[],
  coverage: FamilyCoverage,
): FamilyExposure {
  // The coverage precondition, applied unamended (SPEC §8.2): no family badge
  // unless at least one member came back. An empty ownership graph is not a
  // clean family — it is an unexplored one.
  const covered: Covered = {
    explored: coverage.explored,
    reachable: coverage.reachable,
    partial: coverage.partial ?? false,
  };

  if (members.length === 0) {
    return { state: 'not_covered', ...covered };
  }

  const withExposure: FamilyExposureMember[] = [];
  for (const member of members) {
    const scored = dedupePsaAgainstBase(member.factors.filter((f) => !isCountryDerived(f)));
    let worst: RiskLevel | undefined;
    const names: string[] = [];
    for (const factor of scored) {
      const level = effectiveLevel(factor);
      if (!level) continue;
      names.push(factor.name);
      if (!worst || rank(level) > rank(worst)) worst = level;
    }
    if (worst)
      withExposure.push({
        entityId: member.entityId,
        label: member.label,
        level: worst,
        factors: names,
        hopDepth: member.hopDepth,
        fromDeepTraversal: member.fromDeepTraversal,
      });
  }

  if (withExposure.length === 0) {
    return { state: 'no_exposure_found', ...covered };
  }

  const worstLevel = withExposure.reduce<RiskLevel>(
    (worst, m) => (rank(m.level) > rank(worst) ? m.level : worst),
    'relevant',
  );

  return {
    state: 'exposure_found',
    worstLevel,
    membersWithExposure: withExposure.length,
    members: withExposure,
    ...covered,
  };
}

const rank = (level: RiskLevel) => (level === 'high' ? 3 : level === 'elevated' ? 2 : 1);

/**
 * The sentence the badge renders as — *"high · 2 of 17 explored"*, and
 * *"17 of 2 275 nodes explored"* where the API said how far it searched.
 *
 * The phrasing is the honest one: an absent family member proves nothing,
 * because the read is capped.
 *
 * ## The coverage clause, stated as a rule
 *
 * Three cases, and the third is what a Deep Traversal added:
 *
 * 1. **The reachable set is known and larger than what we hold** — the API
 *    finished searching (`partial_results: false`) and reported how many nodes
 *    it visited. *"200 of 5 047 nodes explored"*.
 *
 *    **The unit is named, and that is load-bearing.** `explored_count` counts
 *    the nodes the traversal walked, not the companies in the family: the
 *    Yazaki ownership call reports 5,047 against a family of seventeen. Written
 *    as *"17 of 5,047 explored"* the sentence reads as a family of five
 *    thousand companies, which is a coverage claim nobody measured — the same
 *    class of quietly-wrong figure as the *"28 of 100 explored"* a doubled
 *    family once produced. Saying *nodes* is the difference between reporting
 *    how wide the search was and inventing how big the family is.
 * 2. **The walk stopped at a cap and the reachable set is unknown** — the API
 *    itself returned partial results, so the number it reports bounds nothing.
 *    *"200 explored to the cap"*: the count is a floor, and saying only *"200
 *    explored"* would let a walk that ran out of budget read as a family of
 *    exactly 200.
 * 3. **Neither** — the walk ran to the end of the graph. *"17 explored"*, and
 *    for once that is the whole family.
 *
 * Case 2 exists because a Deep Traversal is *defined* by its caps (CONTEXT:
 * *within a hop and node cap*), so hitting one is its ordinary outcome rather
 * than an error — and an ordinary outcome still has to be said out loud.
 */
export function describeFamilyExposure(exposure: FamilyExposure): string {
  const coverage =
    exposure.reachable != null && exposure.reachable > exposure.explored
      ? `${exposure.explored} of ${exposure.reachable.toLocaleString('en-US')} nodes explored`
      : exposure.partial
        ? `${exposure.explored} explored to the cap`
        : `${exposure.explored} explored`;

  switch (exposure.state) {
    case 'not_covered':
      return `Not covered — the ownership graph returned nobody. This is not the same as a clean family.`;
    case 'no_exposure_found':
      return `No exposure found across ${coverage}. An absent member proves nothing: the read is capped.`;
    case 'exposure_found':
      return `${exposure.worstLevel} · ${exposure.membersWithExposure} of ${coverage}`;
  }
}

/**
 * **When two Sayari endpoints disagree about an entity's risk, union them with
 * per-factor provenance** (SPEC §8.2).
 *
 * Measured: one company carried **10** factors in the traversal payload and
 * **6** from `getEntity`, and the four missing from the second included an
 * elevated forced-labour factor. Taking either endpoint as authoritative would
 * have dropped it.
 */
export function unionRiskFactors(
  sources: readonly { source: string; risk: unknown }[],
): { factor: RiskFactor; sources: string[] }[] {
  const merged = new Map<string, { factor: RiskFactor; sources: string[] }>();

  for (const { source, risk } of sources) {
    for (const factor of parseRiskObject(risk)) {
      const existing = merged.get(factor.name);
      if (!existing) {
        merged.set(factor.name, { factor, sources: [source] });
        continue;
      }
      existing.sources.push(source);
      // Where both report a level, keep the worse one: a factor reported as
      // `high` by one endpoint and `elevated` by another is at least elevated,
      // and understating it is the more dangerous error.
      if (
        factor.level &&
        (!existing.factor.level || rank(factor.level) > rank(existing.factor.level))
      ) {
        existing.factor = { ...existing.factor, level: factor.level };
      }
      // Keep whichever traversal path we have; it is the evidence a sentence cites.
      if (!existing.factor.traversalPath && factor.traversalPath) {
        existing.factor = { ...existing.factor, traversalPath: factor.traversalPath };
      }
    }
  }

  return [...merged.values()];
}

/**
 * The endpoint that produced an entity payload, for the risk provenance
 * `upsertEntity` writes on every merge (SPEC §8.2 D5).
 *
 * Open-ended by design — a template-literal-style union rather than a closed
 * enum — because the SDK has more entity-shaped endpoints than this ticket
 * touches (`entitySummary` for the pre-pass Candidates, `resolution`,
 * `searchEntity`, …) and a factor's `sources` array is a citation list, not a
 * schema: a name this build has not named yet still merges and still gets
 * remembered, rather than being coerced into a lie or refused.
 */
export type EntitySource =
  | 'getEntity'
  | 'ownership'
  | 'ubo'
  | 'traversal'
  | 'entitySummary'
  | 'resolution'
  | 'searchEntity'
  | (string & {});

/**
 * Merges a newly-sighted `risk` object into what a previous `upsertEntity`
 * call already wrote, for one factor at a time (SPEC §8.2 D5).
 *
 * This is **not** `unionRiskFactors` reused, and the difference is why a
 * separate function exists: `unionRiskFactors` gives every factor parsed out
 * of one `risk` blob the *same* source label, which is exactly right for
 * combining two freshly-fetched payloads in memory, but wrong here — the
 * *existing* side of this merge is a row that may already carry a different
 * source list **per factor**, the residue of every merge before this one.
 * Labelling the whole existing blob "existing" would discard that history on
 * every write.
 *
 * Kept per factor: the union of names, the **worse** level where both sides
 * report one (understating is the more dangerous error — the same call
 * `unionRiskFactors` makes), the traversal path from whichever side has one,
 * and the union of sources.
 *
 * **Two return values, for two columns.** `risk` keeps Sayari's own shape —
 * `level`, `value`, `metadata`, nothing added — because
 * `src/tools/catalog/reads.ts` hands it to a model turn verbatim; `sources` is
 * the flat `{ [factorName]: string[] }` map `upsertEntity` writes to the
 * sibling `risk_sources` column. See the schema comment on `entity.risk` for
 * why the two are not one jsonb blob: an inline `sources` key broke two
 * assess/recommend replays the first time this was tried, because the exact
 * shape of `entity.risk` reaches a live prompt unfiltered.
 *
 * Returns `undefined` when this sighting says nothing about risk at all, so
 * `upsertEntity`'s "a column moves only when the incoming sighting states it"
 * rule holds for `risk` exactly as it does for every other column — a caller
 * that gets `undefined` back knows to leave both columns alone.
 */
export function mergeRiskForUpsert(
  existingRisk: unknown,
  existingSources: unknown,
  incomingRisk: unknown,
  source: EntitySource,
): { risk: Record<string, unknown>; sources: Record<string, string[]> } | undefined {
  if (incomingRisk === undefined) return undefined;

  const priorSourcesByName = parseSourceMap(existingSources);
  const merged = new Map<string, RiskFactor & { sources: string[] }>();
  for (const factor of parseRiskObject(existingRisk)) {
    merged.set(factor.name, { ...factor, sources: priorSourcesByName[factor.name] ?? [] });
  }
  for (const factor of parseRiskObject(incomingRisk)) {
    const prior = merged.get(factor.name);
    if (!prior) {
      merged.set(factor.name, { ...factor, sources: [source] });
      continue;
    }
    merged.set(factor.name, {
      ...prior,
      level:
        factor.level && (!prior.level || rank(factor.level) > rank(prior.level))
          ? factor.level
          : prior.level,
      // Keep whichever traversal path is already on file; it is the evidence
      // a compliance sentence cites, and a `getEntity` body never carries one
      // to begin with.
      traversalPath: prior.traversalPath ?? factor.traversalPath,
      value: prior.value ?? factor.value,
      sources: prior.sources.includes(source) ? prior.sources : [...prior.sources, source],
    });
  }

  const risk: Record<string, unknown> = {};
  const sources: Record<string, string[]> = {};
  for (const [name, factor] of merged) {
    risk[name] = {
      level: factor.level ?? null,
      value: factor.value ?? null,
      metadata: {
        ...(factor.country != null ? { country: factor.country } : {}),
        ...(factor.traversalPath != null ? { traversal_path: factor.traversalPath } : {}),
      },
    };
    sources[name] = factor.sources;
  }
  return { risk, sources };
}

/** Reads the `risk_sources` column back into a plain `{ name: sources[] }` map. */
function parseSourceMap(riskSources: unknown): Record<string, string[]> {
  if (!riskSources || typeof riskSources !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [name, raw] of Object.entries(riskSources as Record<string, unknown>)) {
    if (Array.isArray(raw)) out[name] = raw.filter((s): s is string => typeof s === 'string');
  }
  return out;
}
