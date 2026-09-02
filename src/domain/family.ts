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
 * The sentence the badge renders as — *"high · 2 of 17 members"*, and
 * *"17 of 2 275 explored"* where the read was truncated.
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
 *    it visited. *"200 of 5 047 explored"*, which is SPEC §8.2's own phrasing.
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
      ? `${exposure.explored} of ${exposure.reachable.toLocaleString('en-US')} explored`
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
