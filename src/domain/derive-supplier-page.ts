import { computeFamilyExposure, unionRiskFactors, type FamilyExposure } from './family';
import { rankSentence, type ShortlistEntry } from '@/db/queries/shortlist';

/**
 * Pure shaping for the Supplier page, split out of `loadSupplierPage` (SPEC
 * §13.1) so the read and the derivation can be tested apart.
 *
 * `db/queries/supplier-page.ts` reads every row exactly once —
 * `readSupplierRows()` — and everything here takes those rows and produces
 * what the page's sections show. Nothing in this file touches a database.
 */

type FamilyRow = {
  member: { id: string; label: string; country: string | null; risk: unknown };
  exploredCount: number | null;
  reachableCount: number | null;
};

/**
 * The Corporate family's coverage and exposure, combined — a Supplier page
 * always needs both together, and computing them apart risks the count and
 * the badge disagreeing about the same family.
 *
 * **The coverage figures are read, not counted.** `exploredCount` is what the
 * traversal itself reported; counting rows instead answers a different
 * question — how many rows we hold — which is only accidentally the same
 * number (BUILD-NOTES: the family stored twice for Bosch and Magna once made
 * the badge read *"28 of 100 explored"* against a truth of 14 of 50).
 */
export function deriveFamilyCoverageAndExposure(familyRows: readonly FamilyRow[]): {
  coverage: { explored: number; reachable: number | null };
  exposure: FamilyExposure;
} {
  const coverage = {
    explored: familyRows[0]?.exploredCount ?? familyRows.length,
    reachable: familyRows[0]?.reachableCount ?? null,
  };

  const exposure = computeFamilyExposure(
    familyRows.map((row) => ({
      entityId: row.member.id,
      label: row.member.label,
      country: row.member.country,
      factors: unionRiskFactors([{ source: 'getEntity', risk: row.member.risk }]).map((u) => u.factor),
      fromDeepTraversal: false,
    })),
    coverage,
  );

  return { coverage, exposure };
}

/** Risk factors on the company itself, as against on its family — the entity's own `risk` block, unioned with nothing else. */
export function deriveOwnRiskFactorCount(entityRisk: unknown): number {
  return unionRiskFactors([{ source: 'getEntity', risk: entityRisk ?? null }]).length;
}

/** The oldest Enrichment age is the freshest-checked claim the page can make about the whole company. */
export function deriveFreshestAge(enrichments: readonly { ageDays: number }[]): number | null {
  return enrichments.reduce<number | null>((best, e) => (best == null || e.ageDays < best ? e.ageDays : best), null);
}

/**
 * The rank against the **unfiltered** Shortlist of the Supplier's first
 * Category — a Supplier page always states it, whatever a filter is doing
 * above it, because "6th of 9" is the figure that gives a score a scale.
 */
export function deriveSupplierRank(
  shortlist: { ranked: ShortlistEntry[]; totalCount: number } | undefined,
  supplierId: string,
): string {
  if (!shortlist) return 'not ranked';
  return rankSentence(
    shortlist.ranked.find((row) => row.supplierId === supplierId),
    shortlist.totalCount,
  );
}
