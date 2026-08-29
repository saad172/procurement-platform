import { and, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import {
  buildShortlist,
  dataConfidence,
  scoreFromStoredValues,
  type ShortlistRow,
  type StoredCriterionValue,
  type WeightVector,
} from '@/domain/score';
import { EXPECTED_ENRICHMENTS } from '@/domain/scoring/anchors';
import { isDisqualifying } from '@/domain/scoring/risk-factors';
import { unionRiskFactors } from '@/domain/family';
import type { Facets } from '@/lib/view-state';

/**
 * The queries every page runs for SSR (SPEC §13.6, §9.4).
 *
 * **A page renders what a Citation points at.** So it reads the *stored*
 * `criterion_value` rows and combines them with the weight vector from the URL,
 * rather than recomputing each Criterion from live rows — a recomputation could
 * show a figure that differs from the one a published sentence cites, which is
 * exactly the drift `criterion_value` is append-only to prevent.
 *
 * That also makes the live weight rail cheap: a drag re-ranks from rows already
 * on the page, with no upstream call and no Job.
 *
 * Two rules from §13.6 live here rather than in a component, because a
 * component could forget them:
 *
 * - **A Shortlist is never filtered.** Filtering marks rows hidden; ranks are
 *   computed over the unfiltered set, always, and a Recommendation runs against
 *   that same unfiltered list.
 * - **A filtered row keeps its true rank**, so visible rows read 2, 5, 7 with
 *   the gaps left in. **The gap is the disclosure.**
 */

export type ShortlistEntry = ShortlistRow & {
  /** False when a filter hides it. It keeps its rank either way. */
  visible: boolean;
  country: string | null;
  matchStatus: string | null;
  entityId: string | null;
};

export type ShortlistResult = {
  ranked: ShortlistEntry[];
  excluded: { row: ShortlistEntry; reason: 'no_match' | 'no_category' }[];
  /** "showing 4 of 9" — the crop, stated once per page. */
  visibleCount: number;
  totalCount: number;
};

/** Everything a page needs about one Supplier, read from stored rows. */
export type SupplierSnapshot = {
  supplierId: string;
  displayName: string;
  country: string | null;
  matchStatus: string | null;
  matchAccepted: boolean;
  entityId: string | null;
  categoryIds: string[];
  values: StoredCriterionValue[];
  dataConfidenceBand: ReturnType<typeof dataConfidence>;
  disqualifyingFactors: string[];
};

export async function loadSupplierSnapshots(
  db: Database,
  args: { programId: string; supplierIds?: string[] | undefined },
): Promise<SupplierSnapshot[]> {
  const suppliers = await db.select().from(t.supplier).where(eq(t.supplier.programId, args.programId));
  const wanted = args.supplierIds ? new Set(args.supplierIds) : undefined;

  const out: SupplierSnapshot[] = [];
  for (const supplier of suppliers) {
    if (wanted && !wanted.has(supplier.id)) continue;

    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplier.id) });
    const profile = match?.entityId
      ? await db.query.entity.findFirst({ where: eq(t.entity.id, match.entityId) })
      : undefined;
    const categories = await db
      .select({ categoryId: t.supplierCategory.categoryId })
      .from(t.supplierCategory)
      .where(eq(t.supplierCategory.supplierId, supplier.id));
    const rows = await db
      .select()
      .from(t.criterionValue)
      .where(and(eq(t.criterionValue.supplierId, supplier.id), eq(t.criterionValue.isCurrent, true)));

    const factors = profile
      ? unionRiskFactors([{ source: 'getEntity', risk: profile.risk }]).map((u) => u.factor)
      : [];
    const disqualifyingFactors = factors.filter(isDisqualifying).map((f) => f.name);
    if (profile?.sanctioned) disqualifyingFactors.push('sanctioned');

    const presentEnrichments = await db
      .selectDistinct({ source: t.enrichment.source })
      .from(t.enrichment)
      .where(eq(t.enrichment.subjectKey, match?.entityId ?? supplier.id));

    out.push({
      supplierId: supplier.id,
      displayName: supplier.rosterName ?? profile?.label ?? supplier.id,
      country: profile?.country ?? supplier.rosterCountry ?? null,
      matchStatus: match?.status ?? null,
      matchAccepted: match?.status === 'accepted',
      entityId: match?.entityId ?? null,
      categoryIds: categories.map((c) => c.categoryId),
      values: rows.map((row) => ({
        criterionKey: row.criterionKey,
        categoryId: row.categoryId,
        value: row.value,
        unknownReason: row.unknownReason,
        rawInputs: (row.rawInputs ?? {}) as Record<string, unknown>,
        anchorLine: row.anchorLine,
      })),
      dataConfidenceBand: dataConfidence({
        supplierId: supplier.id,
        displayName: supplier.rosterName ?? supplier.id,
        match: { status: (match?.status ?? 'needs_review') as never, entityId: match?.entityId ?? undefined },
        profile: profile
          ? {
              entityId: profile.id,
              legalName: profile.label,
              distinctSourceCount: profile.distinctSourceCount ?? undefined,
              sanctioned: profile.sanctioned,
              pep: profile.pep,
              closed: profile.closed,
              riskFactors: factors,
              relationshipsTruncated: profile.relationshipsTruncated,
            }
          : undefined,
        owners: [],
        countryIndicators: [],
        presentEnrichments: presentEnrichments
          .map((e) => e.source)
          .filter((source): source is (typeof EXPECTED_ENRICHMENTS)[number] =>
            (EXPECTED_ENRICHMENTS as readonly string[]).includes(source),
          ),
      }),
      disqualifyingFactors,
    });
  }
  return out;
}

/** Scores one snapshot against a weight vector, for one Category or none. */
export function scoreSnapshot(
  snapshot: SupplierSnapshot,
  weights: WeightVector | undefined,
  categoryId: string | null,
) {
  return scoreFromStoredValues(
    {
      supplierId: snapshot.supplierId,
      displayName: snapshot.displayName,
      values: snapshot.values,
      dataConfidence: snapshot.dataConfidenceBand,
      disqualifyingFactors: snapshot.disqualifyingFactors,
      matchAccepted: snapshot.matchAccepted,
      hasCategory: categoryId ? snapshot.categoryIds.includes(categoryId) : snapshot.categoryIds.length > 0,
      categoryId,
    },
    weights,
  );
}

/** Does this Supplier survive the filter? Hidden, never removed. */
function matchesFacets(
  entry: { country: string | null; matchStatus: string | null; score: number | null },
  facets: Facets,
): boolean {
  if (facets.country?.length && !facets.country.includes(entry.country ?? '')) return false;
  if (facets.matchStatus?.length && !facets.matchStatus.includes(entry.matchStatus ?? '')) return false;
  if (facets.scoreBand?.length) {
    const band = entry.score == null ? 'none' : entry.score >= 80 ? 'high' : entry.score >= 60 ? 'mid' : 'low';
    if (!facets.scoreBand.includes(band)) return false;
  }
  return true;
}

export async function loadShortlist(
  db: Database,
  args: {
    programId: string;
    categoryId: string;
    weights?: WeightVector | undefined;
    facets?: Facets | undefined;
  },
): Promise<ShortlistResult> {
  const bidders = await db
    .select({ supplierId: t.supplierCategory.supplierId })
    .from(t.supplierCategory)
    .where(eq(t.supplierCategory.categoryId, args.categoryId));

  const snapshots = await loadSupplierSnapshots(db, {
    programId: args.programId,
    supplierIds: bidders.map((b) => b.supplierId),
  });

  const scored = snapshots.map((snapshot) => scoreSnapshot(snapshot, args.weights, args.categoryId));

  // Ranks are computed over the UNFILTERED set, always.
  const { ranked, excluded } = buildShortlist(scored);
  const byId = new Map(snapshots.map((s) => [s.supplierId, s]));

  const decorate = (row: ShortlistRow): ShortlistEntry => {
    const snapshot = byId.get(row.supplierId);
    const entry = {
      ...row,
      country: snapshot?.country ?? null,
      matchStatus: snapshot?.matchStatus ?? null,
      entityId: snapshot?.entityId ?? null,
      visible: true,
    };
    return { ...entry, visible: matchesFacets(entry, args.facets ?? {}) };
  };

  const decorated = ranked.map(decorate);

  return {
    ranked: decorated,
    // The filter REACHES the Excluded block: a `needs review` filter showing an
    // empty Shortlist and six excluded rows is the honest result.
    excluded: excluded.map((e) => ({ row: decorate({ ...e.row, rank: null }), reason: e.reason })),
    visibleCount: decorated.filter((r) => r.visible).length,
    totalCount: decorated.length,
  };
}

/**
 * A Supplier page **always states its rank against the unfiltered Shortlist**
 * ("2 of 9"), whatever the filter is doing above it.
 */
export function rankSentence(entry: ShortlistEntry | undefined, total: number): string {
  if (!entry?.rank) return 'not ranked';
  return `${entry.rank} of ${total}`;
}
