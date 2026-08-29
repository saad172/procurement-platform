import { and, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { computeFamilyExposure, unionRiskFactors } from '@/domain/family';
import { nearestPlant } from '@/domain/geo';
import { scoreSupplier } from '@/domain/score';
import { parseRiskObject } from '@/domain/scoring/risk-factors';
import type { SupplierScoringInput } from '@/domain/scoring/types';
import {
  enrichCountry,
  enrichFamily,
  enrichGeocode,
  enrichLei,
  enrichNegativeNews,
  enrichTariff,
  loadPlants,
  readOwnerEdges,
  writeCriterionValue,
  type EnrichContext,
} from './enrich';
import type { SayariEntity } from '@/upstream/projections/sayari';

/**
 * The enrich Job for one Supplier (SPEC §7, §8, §9).
 *
 * Fetches what is missing, then recomputes every Criterion value through the
 * same pure `score.ts` the browser calls — so a value written here and a value
 * computed during a weight drag cannot disagree.
 *
 * **A Supplier with no accepted Match is enriched no further than its country.**
 * There is no Profile to fetch news or ownership for, and the Criteria all
 * return `unknown` anyway (SPEC §13.3).
 */

export type EnrichResult = {
  supplierId: string;
  enrichmentsWritten: string[];
  criterionValuesWritten: number;
  familyMembers: number;
  skipped: string | undefined;
};

export async function enrichSupplier(
  ctx: EnrichContext,
  args: { supplierId: string; programId: string },
): Promise<EnrichResult> {
  const { db } = ctx;
  const written: string[] = [];

  const supplier = await db.query.supplier.findFirst({ where: eq(t.supplier.id, args.supplierId) });
  if (!supplier) throw new Error(`no supplier ${args.supplierId}`);

  const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplier.id) });
  const categories = await db
    .select({ categoryId: t.supplierCategory.categoryId })
    .from(t.supplierCategory)
    .where(eq(t.supplierCategory.supplierId, supplier.id));

  // ── No Profile: nothing to enrich, and the Criteria will say why ──────────
  if (!match || match.status !== 'accepted' || !match.entityId) {
    const values = await writeAllCriteria(db, {
      supplier,
      programId: args.programId,
      categoryIds: categories.map((c) => c.categoryId),
      input: unresolvedInput(supplier),
      jobId: ctx.jobId,
    });
    return {
      supplierId: supplier.id,
      enrichmentsWritten: [],
      criterionValuesWritten: values,
      familyMembers: 0,
      skipped: `match is ${match?.status ?? 'absent'}, so there is no profile to enrich`,
    };
  }

  const profileRow = await db.query.entity.findFirst({ where: eq(t.entity.id, match.entityId) });
  if (!profileRow) throw new Error(`profile entity ${match.entityId} is not stored`);

  // ── 1. Negative news, on the RESOLVED LEGAL NAME ─────────────────────────
  const news = await enrichNegativeNews(ctx, {
    entityId: match.entityId,
    resolvedLegalName: profileRow.label,
  });
  written.push(news.enrichmentId);

  // ── 2. The Corporate family — one call, on the standard path ─────────────
  const family = await enrichFamily(ctx, { entityId: match.entityId });
  written.push(family.enrichmentId);

  // ── 3. Country indicators, shared across every Supplier in the country ───
  if (profileRow.country) {
    const country = await enrichCountry(ctx, { country: profileRow.country });
    written.push(...country.enrichmentIds);
  }

  // ── 4. GLEIF, where there is an LEI to join on ───────────────────────────
  if (profileRow.lei) {
    const lei = await enrichLei(ctx, { entityId: match.entityId, lei: profileRow.lei });
    if (lei) written.push(lei.enrichmentId);
  }

  // ── 5. Tariffs, per Category's default HS line ───────────────────────────
  const tariffByCategory = new Map<string, { hsCode: string; mfnRatePct: number | null }>();
  for (const { categoryId } of categories) {
    const line = await db.query.categoryHsLine.findFirst({
      where: and(eq(t.categoryHsLine.categoryId, categoryId), eq(t.categoryHsLine.isDefault, true)),
    });
    if (!line) continue;
    const tariff = await enrichTariff(ctx, { hsCode: line.hsCode });
    written.push(tariff.enrichmentId);
    tariffByCategory.set(categoryId, { hsCode: line.hsCode, mfnRatePct: tariff.mfnRatePct });
  }

  // ── 6. Geocoding — ONLY where Sayari has no coordinate of its own ────────
  let lat = profileRow.lat;
  let lon = profileRow.lon;
  let coordinatePrecision = lat != null ? 'building' : undefined;
  if (lat == null && supplier.rosterAddress) {
    const geocode = await enrichGeocode(ctx, {
      subjectKey: supplier.id,
      address: supplier.rosterAddress,
    });
    written.push(geocode.enrichmentId);
    lat = geocode.lat;
    lon = geocode.lon;
    coordinatePrecision = geocode.precision;
  }

  // ── Assemble the scoring input ───────────────────────────────────────────
  const cachedEntity = await db.query.upstreamResponse.findFirst({
    where: and(
      eq(t.upstreamResponse.endpoint, 'entity.getEntity'),
      eq(t.upstreamResponse.source, 'sayari'),
    ),
  });
  const owners = cachedEntity
    ? await readOwnerEdges(ctx, {
        entityId: match.entityId,
        entity: cachedEntity.body as SayariEntity,
      }).catch(() => [])
    : [];

  const plants = await loadPlants(db, args.programId);
  const nearest = nearestPlant(lat != null && lon != null ? { lat, lon } : undefined, plants);

  const indicators = profileRow.country
    ? await db
        .select()
        .from(t.countryIndicator)
        .where(eq(t.countryIndicator.country, profileRow.country))
    : [];

  const newsRows = await db
    .select()
    .from(t.newsItem)
    .where(eq(t.newsItem.entityId, match.entityId));

  const presentEnrichments = [
    'sayari_negative_news',
    'sayari_ownership_family',
    ...(profileRow.country ? ['world_bank'] : []),
    ...(profileRow.lei ? ['gleif'] : []),
    ...(tariffByCategory.size > 0 ? ['usitc'] : []),
    ...(coordinatePrecision ? ['nominatim'] : []),
  ];

  const baseInput: SupplierScoringInput = {
    supplierId: supplier.id,
    displayName: supplier.rosterName ?? profileRow.label,
    match: { status: 'accepted', entityId: match.entityId },
    profile: {
      entityId: match.entityId,
      legalName: profileRow.label,
      country: profileRow.country ?? undefined,
      lat: lat ?? undefined,
      lon: lon ?? undefined,
      coordinatePrecision,
      distinctSourceCount: profileRow.distinctSourceCount ?? undefined,
      sanctioned: profileRow.sanctioned,
      pep: profileRow.pep,
      closed: profileRow.closed,
      // Unioned with per-factor provenance across the endpoints that reported.
      riskFactors: unionRiskFactors([{ source: 'getEntity', risk: profileRow.risk }]).map((u) => u.factor),
      psaCount: profileRow.psaCount ?? undefined,
      relationshipCount: (profileRow.relationshipCount as Record<string, number> | null) ?? undefined,
      relationshipsTruncated: profileRow.relationshipsTruncated,
    },
    owners: owners.map((o) => ({
      entityId: o.entityId,
      label: o.label,
      riskFactors: o.riskFactors,
      isStateOwned: o.isStateOwned,
    })),
    countryIndicators: indicators.map((i) => ({
      code: i.indicatorCode,
      value: i.value,
      lowerBound: i.lowerBound,
      upperBound: i.upperBound,
      year: i.year,
    })),
    nearestPlant: nearest,
    news: {
      ranOnResolvedLegalName: true,
      articles: newsRows.map((n) => scoreArticle(n.riskFlags)),
    },
    presentEnrichments,
  };

  const criterionValuesWritten = await writeAllCriteria(db, {
    supplier,
    programId: args.programId,
    categoryIds: categories.map((c) => c.categoryId),
    input: baseInput,
    tariffByCategory,
    jobId: ctx.jobId,
  });

  // The family badge is computed, never stored — like the Score and the
  // Shortlist. It reads from `family_member` rows on demand.
  const exposure = computeFamilyExposure(family.members, {
    explored: family.members.length,
    reachable: family.truncated ? null : family.members.length,
  });

  return {
    supplierId: supplier.id,
    enrichmentsWritten: written,
    criterionValuesWritten,
    familyMembers: family.members.length,
    skipped: exposure.state === 'not_covered' ? 'family not covered — the ownership graph returned nobody' : undefined,
  };
}

/** Serious flags weigh ×3, moderate ×1, unflagged ×0.5 (SPEC §9.2). */
function scoreArticle(riskFlags: unknown): { seriousFlags: number; moderateFlags: number } {
  const flags = Array.isArray(riskFlags) ? riskFlags.map(String) : [];
  const serious = flags.filter((f) => /sanction|forced_labor|export_control|corruption|fraud/i.test(f)).length;
  return { seriousFlags: serious, moderateFlags: flags.length - serious };
}

function unresolvedInput(supplier: typeof t.supplier.$inferSelect): SupplierScoringInput {
  return {
    supplierId: supplier.id,
    displayName: supplier.rosterName ?? '(promoted lead)',
    match: { status: 'needs_review' },
    owners: [],
    countryIndicators: [],
    presentEnrichments: [],
  };
}

/**
 * Writes every Criterion value.
 *
 * Tariff exposure is written **per Category**, because it differs per Category;
 * the other five are written **once at `category = null`**, because they do not.
 * That nullability is what lets an uncategorised Supplier carry five values and
 * no Score at all.
 */
async function writeAllCriteria(
  db: Database,
  args: {
    supplier: typeof t.supplier.$inferSelect;
    programId: string;
    categoryIds: string[];
    input: SupplierScoringInput;
    tariffByCategory?: Map<string, { hsCode: string; mfnRatePct: number | null }> | undefined;
    jobId?: string | undefined;
  },
): Promise<number> {
  let written = 0;

  const nonTariff = scoreSupplier(args.input, undefined, { hasCategory: args.categoryIds.length > 0 });
  for (const criterion of nonTariff.criteria) {
    if (criterion.key === 'tariff_exposure') continue;
    await writeCriterionValue(db, {
      supplierId: args.supplier.id,
      programId: args.programId,
      categoryId: null,
      criterionKey: criterion.key,
      value: criterion.outcome.status === 'value' ? criterion.outcome.value : null,
      unknownReason: criterion.outcome.status === 'unknown' ? criterion.outcome.reason : null,
      rawInputs: criterion.outcome.rawInputs,
      anchorLine: criterion.outcome.anchorLine,
      jobId: args.jobId,
    });
    written += 1;
  }

  for (const categoryId of args.categoryIds) {
    const tariff = args.tariffByCategory?.get(categoryId);
    const perCategory = scoreSupplier(
      { ...args.input, tariff: tariff ? { hsCode: tariff.hsCode, mfnRatePct: tariff.mfnRatePct } : undefined },
      undefined,
      { hasCategory: true },
    );
    const criterion = perCategory.criteria.find((c) => c.key === 'tariff_exposure')!;
    await writeCriterionValue(db, {
      supplierId: args.supplier.id,
      programId: args.programId,
      categoryId,
      criterionKey: 'tariff_exposure',
      value: criterion.outcome.status === 'value' ? criterion.outcome.value : null,
      unknownReason: criterion.outcome.status === 'unknown' ? criterion.outcome.reason : null,
      rawInputs: criterion.outcome.rawInputs,
      anchorLine: criterion.outcome.anchorLine,
      jobId: args.jobId,
    });
    written += 1;
  }

  return written;
}

export { parseRiskObject };
