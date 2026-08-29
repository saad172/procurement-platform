import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { buildShortlist, scoreSupplier, type ShortlistRow, type WeightVector } from '@/domain/score';
import type { SupplierScoringInput } from '@/domain/scoring/types';
import { unionRiskFactors } from '@/domain/family';
import type { Facets } from '@/lib/view-state';

/**
 * The Shortlist query (SPEC §13.6, §9.4).
 *
 * Assembles the scoring input from stored rows and hands it to the **same pure
 * `score.ts` the browser calls**, so a server-rendered ranking and a ranking
 * re-computed after a weight drag cannot disagree.
 *
 * Two rules from §13.6 are implemented here rather than in the component,
 * because a component could forget them:
 *
 * - **A Shortlist is never filtered.** Filtering marks rows hidden; it does not
 *   remove them, and a Recommendation always runs against the unfiltered list.
 * - **A filtered row keeps its true rank**, so visible rows read 2, 5, 7 rather
 *   than renumbering. **The gap is the disclosure** — impossible to overlook,
 *   and sitting exactly where it matters.
 */

export type ShortlistEntry = ShortlistRow & {
  /** False when a filter hides it. It keeps its rank either way. */
  visible: boolean;
  rosterCountry: string | null;
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

/** Everything one Supplier's Criteria are computed from, read from rows. */
export async function loadScoringInputs(
  db: Database,
  args: { programId: string; supplierIds?: string[] | undefined },
): Promise<{ input: SupplierScoringInput; categoryIds: string[]; matchStatus: string | null }[]> {
  const suppliers = await db
    .select()
    .from(t.supplier)
    .where(
      args.supplierIds?.length
        ? and(eq(t.supplier.programId, args.programId), inArray(t.supplier.id, args.supplierIds))
        : eq(t.supplier.programId, args.programId),
    );

  const out: { input: SupplierScoringInput; categoryIds: string[]; matchStatus: string | null }[] = [];

  for (const supplier of suppliers) {
    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplier.id) });
    const profile = match?.entityId
      ? await db.query.entity.findFirst({ where: eq(t.entity.id, match.entityId) })
      : undefined;
    const categories = await db
      .select({ categoryId: t.supplierCategory.categoryId })
      .from(t.supplierCategory)
      .where(eq(t.supplierCategory.supplierId, supplier.id));

    const values = await db
      .select()
      .from(t.criterionValue)
      .where(and(eq(t.criterionValue.supplierId, supplier.id), eq(t.criterionValue.isCurrent, true)));

    out.push({
      matchStatus: match?.status ?? null,
      categoryIds: categories.map((c) => c.categoryId),
      input: {
        supplierId: supplier.id,
        displayName: supplier.rosterName ?? profile?.label ?? supplier.id,
        match: {
          status: (match?.status ?? 'needs_review') as SupplierScoringInput['match']['status'],
          entityId: match?.entityId ?? undefined,
        },
        profile: profile
          ? {
              entityId: profile.id,
              legalName: profile.label,
              country: profile.country ?? undefined,
              lat: profile.lat ?? undefined,
              lon: profile.lon ?? undefined,
              distinctSourceCount: profile.distinctSourceCount ?? undefined,
              sanctioned: profile.sanctioned,
              pep: profile.pep,
              closed: profile.closed,
              riskFactors: unionRiskFactors([{ source: 'getEntity', risk: profile.risk }]).map((u) => u.factor),
              psaCount: profile.psaCount ?? undefined,
              relationshipCount: (profile.relationshipCount as Record<string, number> | null) ?? undefined,
              relationshipsTruncated: profile.relationshipsTruncated,
            }
          : undefined,
        owners: [],
        countryIndicators: [],
        presentEnrichments: [],
        // The stored values are authoritative for a page render: they are what
        // a published sentence cites, and recomputing them here from scratch
        // would risk the page showing a number no Citation points at.
        ...restoreFromStoredValues(values),
      },
    });
  }

  return out;
}

/**
 * Rebuilds the Criterion inputs from the **stored** `criterion_value` rows.
 *
 * A page must render what a Citation points at. Recomputing a Criterion from
 * live rows at render time could show a figure that differs from the one a
 * published sentence cites — which is the drift `criterion_value` is
 * append-only to prevent.
 */
function restoreFromStoredValues(
  values: (typeof t.criterionValue.$inferSelect)[],
): Partial<SupplierScoringInput> {
  const byKey = new Map(values.map((v) => [v.criterionKey, v]));
  const raw = (key: string) => (byKey.get(key)?.rawInputs ?? {}) as Record<string, unknown>;

  const proximity = raw('proximity');
  const tariff = raw('tariff_exposure');
  const media = raw('media_signal');

  return {
    nearestPlant:
      typeof proximity.km === 'number'
        ? {
            code: String(proximity.nearestPlant ?? '?'),
            city: String(proximity.nearestPlantCity ?? '?'),
            km: proximity.km,
          }
        : undefined,
    tariff:
      typeof tariff.hsCode === 'string'
        ? {
            hsCode: tariff.hsCode,
            mfnRatePct: typeof tariff.mfnRatePct === 'number' ? tariff.mfnRatePct : null,
            mexicoRatePct: typeof tariff.mexicoRatePct === 'number' ? tariff.mexicoRatePct : null,
          }
        : undefined,
    news:
      typeof media.articleCount === 'number'
        ? {
            ranOnResolvedLegalName: true,
            articles: Array.from({ length: media.articleCount }, () => ({
              seriousFlags: 0,
              moderateFlags: 0,
            })),
          }
        : undefined,
  };
}

/** Does this Supplier survive the filter? Hidden, never removed. */
function matchesFacets(
  entry: { rosterCountry: string | null; matchStatus: string | null; score: number | null },
  facets: Facets,
): boolean {
  if (facets.country?.length && !facets.country.includes(entry.rosterCountry ?? '')) return false;
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

  const inputs = await loadScoringInputs(db, {
    programId: args.programId,
    supplierIds: bidders.map((b) => b.supplierId),
  });

  const scored = inputs.map(({ input, categoryIds }) =>
    scoreSupplier(input, args.weights, { hasCategory: categoryIds.includes(args.categoryId) }),
  );

  // Ranks are computed over the UNFILTERED set, always.
  const { ranked, excluded } = buildShortlist(scored);

  const rosterById = new Map(
    inputs.map(({ input, matchStatus }) => [input.supplierId, { matchStatus, entityId: input.match.entityId ?? null }]),
  );
  const countryById = new Map(inputs.map(({ input }) => [input.supplierId, input.profile?.country ?? null]));

  const decorate = (row: ShortlistRow): ShortlistEntry => {
    const meta = rosterById.get(row.supplierId);
    const entry = {
      ...row,
      rosterCountry: countryById.get(row.supplierId) ?? null,
      matchStatus: meta?.matchStatus ?? null,
      entityId: meta?.entityId ?? null,
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
