import type * as t from '@/db/schema';
import { nearestPlant, proximityBand, type PlantPoint, type Point } from './geo';

/**
 * Pure shaping for the Program page, split out of `loadProgramPage` (SPEC
 * §13.1) so the read and the derivation can be tested apart.
 *
 * `db/queries/program-page.ts` reads every row exactly once —
 * `readProgramRows()` — and everything here takes those rows and produces
 * what the three page sections show. Nothing in this file touches a database.
 */

type MatchRow = {
  supplierId: string;
  status: 'accepted' | 'needs_review' | 'not_found';
  entityId: string | null;
  settledBy: 'rules' | 'agents' | 'human' | 'discovered';
};

/** One row per accepted Match, keyed by Supplier — the shape every section reads. */
export function deriveMatchBySupplier(matches: readonly MatchRow[]): Map<string, MatchRow> {
  return new Map(matches.map((m) => [m.supplierId, m]));
}

/** Suppliers with a published standard Assessment, as a lookup rather than a count. */
export function deriveAssessedIds(assessedRows: readonly { supplierId: string }[]): Set<string> {
  return new Set(assessedRows.map((row) => row.supplierId));
}

/**
 * Where each Supplier sits, for the Plant map — and the proximity band each
 * one falls in, computed once so the map's dots and the roster table's filter
 * can never disagree about which band a company is in.
 *
 * The fallback order mirrors `enrich-supplier` exactly: Sayari's own
 * coordinate on the resolved Profile first, then the Nominatim `geocode` row
 * keyed on the Supplier. A Supplier with neither is left out rather than
 * placed at a default, and the caller reports how many that is.
 */
export function deriveSupplierPoints(args: {
  suppliers: readonly (typeof t.supplier.$inferSelect)[];
  matchBySupplier: Map<string, MatchRow>;
  assessedIds: Set<string>;
  profilePoints: readonly { supplierId: string; lat: number | null; lon: number | null }[];
  geocodePoints: readonly { supplierKey: string; lat: number | null; lon: number | null }[];
  plants: readonly PlantPoint[];
}): {
  supplierPoints: { id: string; name: string; country: string; status: string; assessed: boolean; lat: number; lon: number }[];
  bandBySupplier: Map<string, string>;
} {
  const { suppliers, matchBySupplier, assessedIds, profilePoints, geocodePoints, plants } = args;

  const pointBySupplier = new Map<string, Point>();
  for (const row of geocodePoints) {
    if (row.lat == null || row.lon == null) continue;
    pointBySupplier.set(row.supplierKey, { lat: row.lat, lon: row.lon });
  }
  for (const row of profilePoints) {
    if (row.lat == null || row.lon == null) continue;
    pointBySupplier.set(row.supplierId, { lat: row.lat, lon: row.lon });
  }

  const bandBySupplier = new Map<string, string>();
  const supplierPoints = suppliers.flatMap((supplier) => {
    const point = pointBySupplier.get(supplier.id);
    if (!point) return [];
    const nearest = nearestPlant(point, plants);
    if (nearest) bandBySupplier.set(supplier.id, proximityBand(nearest.km));
    return [
      {
        id: supplier.id,
        name: supplier.rosterName ?? 'a promoted lead',
        country: supplier.rosterCountry ?? 'unknown',
        status: matchBySupplier.get(supplier.id)?.status ?? 'not yet run',
        assessed: assessedIds.has(supplier.id),
        ...point,
      },
    ];
  });

  return { supplierPoints, bandBySupplier };
}

/** How many Suppliers bid on each Category, for the ledger's "Bidders" column. */
export function deriveBiddersByCategory(bidderCountRows: readonly { categoryId: string }[]): Map<string, number> {
  const biddersByCategory = new Map<string, number>();
  for (const row of bidderCountRows) {
    biddersByCategory.set(row.categoryId, (biddersByCategory.get(row.categoryId) ?? 0) + 1);
  }
  return biddersByCategory;
}

type RecommendationRow = {
  categoryId: string;
  versions: {
    n: number;
    evaluatorOutcome: 'passed' | 'published_with_objections';
    humanMark: string | null;
    picks: { role: string; supplier: { rosterName: string | null } }[];
  }[];
};

/**
 * What each Category's argued case actually says, not merely whether a row
 * exists — the award Pick and the evaluator's outcome, at the weight the
 * Category page states them. Latest version by `n`; a header with no version
 * is not an argued case, and counts as none.
 */
export function deriveCategoryRecommendations(recommendations: readonly RecommendationRow[]) {
  return new Map(
    recommendations.flatMap((rec) => {
      const version = rec.versions[0];
      if (!version) return [];
      const award = version.picks.find((pick) => pick.role === 'award');
      return [
        [
          rec.categoryId,
          {
            n: version.n,
            evaluatorOutcome: version.evaluatorOutcome,
            humanMark: version.humanMark,
            awardedTo: award?.supplier.rosterName ?? null,
          },
        ] as const,
      ];
    }),
  );
}

type RecommendJobRow = {
  subjectId: string;
  state: string;
  jobId: string;
  runId: string;
};

/**
 * A Recommend that ran and published nothing is not the same as one nobody
 * asked for, and with only the recommendation table both rows read blank.
 * Last attempt wins; it is only ever read for a Category with no published
 * version, so a `done` Job needs no special case.
 */
export function deriveCategoryAttempts(recommendJobs: readonly RecommendJobRow[], programId: string) {
  const attemptByCategory = new Map<string, { outcome: 'in_flight' | 'refused' | 'broke'; href: string }>();
  for (const job of recommendJobs) {
    const href = `/program/${programId}/runs/${job.runId}/job/${job.jobId}`;
    if (job.state === 'queued' || job.state === 'running' || job.state === 'paused_on_budget') {
      attemptByCategory.set(job.subjectId, { outcome: 'in_flight', href });
    } else if (job.state === 'terminated') {
      attemptByCategory.set(job.subjectId, { outcome: 'refused', href });
    } else if (job.state === 'failed') {
      attemptByCategory.set(job.subjectId, { outcome: 'broke', href });
    }
  }
  return attemptByCategory;
}

/**
 * The rows only a person can settle, **named** — a count alone makes them
 * anonymous, and two roster names are what turns "2 waiting" into a task.
 */
export function deriveWaitingOnYou(
  suppliers: readonly (typeof t.supplier.$inferSelect)[],
  matchBySupplier: Map<string, MatchRow>,
): { count: number; names: string[] } {
  const waiting = suppliers.filter((row) => matchBySupplier.get(row.id)?.status === 'needs_review');
  return {
    count: waiting.length,
    names: waiting.map((row) => row.rosterName ?? 'a promoted lead'),
  };
}
