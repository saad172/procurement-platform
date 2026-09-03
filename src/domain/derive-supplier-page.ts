import { computeFamilyExposure, type FamilyCoverage, type FamilyExposure } from './family';
import { parseRiskObject } from './scoring/risk-factors';
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
  hopDepth: number;
  truncated: boolean;
  /**
   * The read's own envelope figure (`graph_path.explored_count`, network
   * spec §6) — how many nodes THAT walk visited, sometimes in the thousands.
   * Not a row count: `family_member.explored_count`, the app's own
   * capped-at-50 tally of distinct members held, has no successor column on
   * `graph_path` — `widestCoverage` below now counts the rows themselves,
   * which the table's `(root, terminal, kind)` unique index makes safe.
   */
  reachableCount: number | null;
  /** Null when the automatic family read found it; a Job id for a Deep Traversal. */
  discoveredByJob: string | null;
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
  coverage: FamilyCoverage;
  exposure: FamilyExposure;
} {
  const coverage = widestCoverage(familyRows);

  const exposure = computeFamilyExposure(
    familyRows.map((row) => ({
      entityId: row.member.id,
      label: row.member.label,
      country: row.member.country,
      // `row.member.risk` already carries every endpoint's per-factor
      // provenance — `upsertEntity` merges it on every write (SPEC §8.2 D5).
      factors: parseRiskObject(row.member.risk),
      hopDepth: row.hopDepth,
      // Read off the row rather than assumed: a Deep Traversal writes into this
      // same table and is distinguished by `discovered_by_job` (SPEC §8.5).
      fromDeepTraversal: row.discoveredByJob != null,
    })),
    coverage,
  );

  return { coverage, exposure };
}

/**
 * The coverage of the **widest** read this family holds, not of whichever row
 * came back first.
 *
 * Every member row carries the *reachable* figure of the read that wrote it,
 * so once a Deep Traversal has run there are two envelopes in the table: the
 * automatic read's and the deep walk's own, wider one. `familyRows[0]` picked
 * between them by whatever order Postgres returned — which is the same
 * total-order mistake that has read as fixture drift three times in this
 * build (findings 61, 81, 100), except that here it would silently understate
 * a family the app had already paid to explore. The widest envelope is the
 * right one: a walk that reported reaching further reported a superset, and
 * `truncated` travels with it so a bigger number cannot arrive without the
 * caveat that earned it.
 *
 * **`explored` is now a row count, and that reverses this function's own
 * earlier rule** (see this file's own history and `graph_path.explored_count`'s
 * comment). `family_member` could hold the same member twice — Bosch and
 * Magna each stored 100 rows for 50 members before a unique index existed —
 * which is exactly why `explored` used to be read off a column instead of
 * counted. `graph_path`'s `(root_entity_id, terminal_entity_id, kind)` unique
 * index rules that out at the database, and `graph_path` carries no row-count
 * column of its own to read instead — so `familyRows.length` is both the only
 * option and, because of that index, a safe one.
 */
function widestCoverage(familyRows: readonly FamilyRow[]): FamilyCoverage {
  const widest = familyRows.reduce<FamilyRow | undefined>(
    (best, row) =>
      best == null || (row.reachableCount ?? 0) > (best.reachableCount ?? 0) ? row : best,
    undefined,
  );
  return {
    explored: familyRows.length,
    reachable: widest?.reachableCount ?? null,
    partial: widest?.truncated ?? false,
  };
}

/** Risk factors on the company itself, as against on its family — the entity's own stored `risk` block. */
export function deriveOwnRiskFactorCount(entityRisk: unknown): number {
  return parseRiskObject(entityRisk ?? null).length;
}

/** The oldest Enrichment age is the freshest-checked claim the page can make about the whole company. */
export function deriveFreshestAge(enrichments: readonly { ageDays: number }[]): number | null {
  return enrichments.reduce<number | null>(
    (best, e) => (best == null || e.ageDays < best ? e.ageDays : best),
    null,
  );
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
