import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { derivedId } from '@/db/derived-id';
import { FAMILY_TRAVERSAL_LIMIT } from '@/config/constants';
import { COUNTRY_INDICATORS } from '@/domain/scoring/anchors';
import { unionRiskFactors, type FamilyMemberRisk } from '@/domain/family';
import { nearestPlant, type PlantPoint } from '@/domain/geo';
import { parseRiskObject } from '@/domain/scoring/risk-factors';
import { upsertEntity } from './resolve';
import type { Upstream, UpstreamResult } from '@/upstream';
import type { SayariEntity } from '@/upstream/projections/sayari';

/**
 * The enrichment fan-out (SPEC §7, §8).
 *
 * Six sources per accepted Profile — or per country and per HS line, which are
 * **shared across Suppliers** and are exactly why data confidence cannot be a
 * row count on the Supplier.
 *
 * **Deterministic: no model runs here.** That is why this Job needs no fixture
 * (SPEC §19.2) and why it calls `src/upstream/call()` directly rather than
 * going through the tool registry — the registry is a *model-facing* catalog.
 *
 * Two rules apply to all six:
 *
 * 1. `fetched_at` is displayed with an age badge, and an aged Enrichment forces
 *    the caveat line rather than blocking anything. **No TTL, no background
 *    refresh** — a background TTL would spend credits on page views.
 * 2. Tariff trade-action flags are **authored, never computed**: they key on
 *    facts this app does not have.
 */

export type EnrichContext = { db: Database; upstream: Upstream; jobId?: string | undefined };

/** Records one dated call as an `enrichment` row — the Citation target. */
async function recordEnrichment(
  ctx: EnrichContext,
  args: {
    source: (typeof t.enrichmentSource.enumValues)[number];
    subjectKind: (typeof t.enrichmentSubjectKind.enumValues)[number];
    subjectKey: string;
    requestParams: Record<string, unknown>;
    result: UpstreamResult<unknown>;
  },
): Promise<string> {
  // Append-only: a re-fetch writes a new row for the same subject, so the
  // generation is what separates them. Counted, not timestamped, so two runs an
  // hour apart agree.
  const [{ generation }] = (await ctx.db
    .select({ generation: sql<number>`count(*)::int` })
    .from(t.enrichment)
    .where(
      and(
        eq(t.enrichment.source, args.source),
        eq(t.enrichment.subjectKind, args.subjectKind),
        eq(t.enrichment.subjectKey, args.subjectKey),
      ),
    )) as [{ generation: number }];

  const [row] = await ctx.db
    .insert(t.enrichment)
    .values({
      id: derivedId('enrichment', `${args.source}:${args.subjectKind}:${args.subjectKey}`, generation),
      source: args.source,
      subjectKind: args.subjectKind,
      subjectKey: args.subjectKey,
      requestParams: args.requestParams as never,
      upstreamResponseId: args.result.upstreamResponseId,
      fetchedAt: args.result.fetchedAt,
      jobId: ctx.jobId ?? null,
    })
    .returning({ id: t.enrichment.id });
  return row!.id;
}

// ── 1. Negative news ─────────────────────────────────────────────────────────

/**
 * **The input is the resolved legal name, never the roster trade name.**
 *
 * The endpoint takes a bare name, so disambiguation is ours. Running it on
 * "Bosch" would return articles about a company we have not identified, and a
 * zero result would be meaningless in a way that looks exactly like a clean
 * record.
 */
export async function enrichNegativeNews(
  ctx: EnrichContext,
  args: { entityId: string; resolvedLegalName: string },
): Promise<{ enrichmentId: string; articleCount: number }> {
  const result = await ctx.upstream.sayari.negativeNews({ name: args.resolvedLegalName });
  const enrichmentId = await recordEnrichment(ctx, {
    source: 'sayari_negative_news',
    subjectKind: 'entity',
    subjectKey: args.entityId,
    requestParams: { resolvedLegalName: args.resolvedLegalName },
    result,
  });

  const articles = result.data.data ?? [];
  for (const article of articles) {
    await ctx.db.insert(t.newsItem).values({
      enrichmentId,
      entityId: args.entityId,
      title: article.title ?? '(untitled)',
      sourceName: article.source ?? null,
      url: article.url ?? null,
      publishedAt: parseDate(article.published),
      riskFlags: (article.risk_flags ?? null) as never,
    });
  }
  return { enrichmentId, articleCount: articles.length };
}

// ── 2. World Bank ────────────────────────────────────────────────────────────

/** Shared across every Supplier in the country — hence six calls, not fifty. */
export async function enrichCountry(
  ctx: EnrichContext,
  args: { country: string },
): Promise<{ enrichmentIds: string[]; indicatorsReturned: number }> {
  const enrichmentIds: string[] = [];
  let returned = 0;

  for (const spec of COUNTRY_INDICATORS) {
    const result = await ctx.upstream.worldbank.indicator({
      country: args.country,
      indicator: spec.code,
    });
    const enrichmentId = await recordEnrichment(ctx, {
      source: 'world_bank',
      subjectKind: 'country',
      subjectKey: `${args.country}:${spec.code}`,
      requestParams: { country: args.country, indicator: spec.code, mrnev: 1 },
      result,
    });
    enrichmentIds.push(enrichmentId);

    const rows = Array.isArray(result.data) && Array.isArray(result.data[1]) ? result.data[1] : [];
    for (const row of rows) {
      if (row.value == null) continue;
      returned += 1;
      await ctx.db.insert(t.countryIndicator).values({
        enrichmentId,
        country: args.country,
        indicatorCode: spec.code,
        indicatorLabel: spec.label,
        year: row.date ? Number(row.date) : null,
        value: row.value,
        // `.SC_LB` / `.SC_UB` where the indicator carries them. Overlapping
        // bands are not a real difference, and the UI renders the band.
        lowerBound: null,
        upperBound: null,
      });
    }
  }
  return { enrichmentIds, indicatorsReturned: returned };
}

// ── 3. GLEIF ─────────────────────────────────────────────────────────────────

export async function enrichLei(
  ctx: EnrichContext,
  args: { entityId: string; lei: string },
): Promise<{ enrichmentId: string } | undefined> {
  const result = await ctx.upstream.gleif.joinLei({ lei: args.lei });
  const record = result.data.data;
  if (!record) return undefined;

  const enrichmentId = await recordEnrichment(ctx, {
    source: 'gleif',
    subjectKind: 'entity',
    subjectKey: args.entityId,
    requestParams: { lei: args.lei },
    result,
  });

  const entity = record.attributes?.entity;
  await ctx.db.insert(t.leiRecord).values({
    enrichmentId,
    lei: args.lei,
    legalName: entity?.legalName?.name ?? '(unnamed)',
    legalAddressLine: entity?.legalAddress?.addressLines?.join(', ') ?? null,
    legalCity: entity?.legalAddress?.city ?? null,
    legalPostcode: entity?.legalAddress?.postalCode ?? null,
    legalCountry: entity?.legalAddress?.country ?? null,
    status: entity?.status ?? null,
    registrationStatus: record.attributes?.registration?.status ?? null,
  });
  return { enrichmentId };
}

// ── 4. Tariffs ───────────────────────────────────────────────────────────────

/**
 * Shared across Suppliers, per HS line.
 *
 * The (origin → MEX) duty is **fetched and rendered beside** the scored figure
 * and is never scored, because the Program stores one importer and the Mexican
 * Plant makes that an explicit proxy.
 */
export async function enrichTariff(
  ctx: EnrichContext,
  args: { hsCode: string },
): Promise<{ enrichmentId: string; mfnRatePct: number | null }> {
  const result = await ctx.upstream.usitc.tariff({ hsCode: args.hsCode });
  const enrichmentId = await recordEnrichment(ctx, {
    source: 'usitc',
    subjectKind: 'hs_line',
    subjectKey: args.hsCode,
    requestParams: { hsCode: args.hsCode },
    result,
  });

  const rows = Array.isArray(result.data) ? result.data : [];
  const line = rows.find((r) => r.htsno?.replace(/\./g, '').startsWith(args.hsCode.replace(/\./g, '')));
  const mfnRatePct = parseRate(line?.general ?? null);

  await ctx.db.insert(t.tariffLine).values({
    enrichmentId,
    hsCode: args.hsCode,
    importerCountry: 'USA',
    description: line?.description ?? null,
    mfnRate: mfnRatePct?.toFixed(3) ?? null,
    rateText: line?.general ?? null,
  });
  return { enrichmentId, mfnRatePct };
}

/**
 * A date, or null — never an `Invalid Date`.
 *
 * `new Date(x)` returns an Invalid Date rather than throwing, and the failure
 * then surfaces four layers away inside the Postgres driver as
 * `RangeError: Invalid time value`, naming neither the field nor the row. An
 * unparseable published date is a normal thing for a news feed to contain, so
 * it is handled here where the field's name is still in scope.
 */
export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** "Free" is 0%; "5%" is 5. Anything else is null rather than a guess. */
export function parseRate(text: string | null): number | null {
  if (!text) return null;
  if (/free/i.test(text)) return 0;
  const match = /(\d+(?:\.\d+)?)\s*%/.exec(text);
  return match ? Number(match[1]) : null;
}

// ── 5. Geocoding ─────────────────────────────────────────────────────────────

/**
 * **For Plants and unresolved rows only** (SPEC §7.1).
 *
 * Sayari's own `x`/`y` supersedes this for a resolved Profile, so calling it
 * there would spend a rate-limited request to learn something already known.
 */
export async function enrichGeocode(
  ctx: EnrichContext,
  args: { subjectKey: string; address: string },
): Promise<{ enrichmentId: string; lat: number | null; lon: number | null; precision: string }> {
  const result = await ctx.upstream.nominatim.geocode({ q: args.address });
  const enrichmentId = await recordEnrichment(ctx, {
    source: 'nominatim',
    subjectKind: 'address',
    subjectKey: args.subjectKey,
    requestParams: { address: args.address },
    result,
  });

  const hit = result.data[0];
  const precision = precisionOf(hit?.addresstype ?? hit?.type ?? null);
  await ctx.db.insert(t.geocode).values({
    enrichmentId,
    queryAddress: args.address,
    lat: hit?.lat ? Number(hit.lat) : null,
    lon: hit?.lon ? Number(hit.lon) : null,
    precision,
    displayName: hit?.display_name ?? null,
    provider: 'nominatim',
  });
  return {
    enrichmentId,
    lat: hit?.lat ? Number(hit.lat) : null,
    lon: hit?.lon ? Number(hit.lon) : null,
    precision,
  };
}

/**
 * Every geocode records its precision, because **4 of 6 sampled addresses
 * missed at building precision**. A city centroid is not a factory, and the UI
 * must say which it got rather than imply a surveyed point.
 */
export function precisionOf(addressType: string | null): (typeof t.geocodePrecision.enumValues)[number] {
  if (!addressType) return 'unknown';
  if (/^(building|house|amenity|industrial|commercial|office)$/i.test(addressType)) return 'building';
  if (/^(road|street|residential|pedestrian)$/i.test(addressType)) return 'street';
  if (/^(suburb|neighbourhood|quarter|hamlet|village)$/i.test(addressType)) return 'locality';
  if (/^(city|town|municipality)$/i.test(addressType)) return 'city';
  if (/^(state|province|region|county)$/i.test(addressType)) return 'region';
  if (/^country$/i.test(addressType)) return 'country';
  return 'unknown';
}

// ── 6. The Corporate family ──────────────────────────────────────────────────

/**
 * **One call at `limit: 50`, on the standard enrichment path** (SPEC §8).
 *
 * Every path terminal arrives as a full entity with its `risk` block inline, so
 * this never fans out. Truncation is recorded, which is what makes *"17 of
 * 2 275 explored"* the honest phrasing.
 */
export async function enrichFamily(
  ctx: EnrichContext,
  args: { entityId: string },
): Promise<{ enrichmentId: string; members: FamilyMemberRisk[]; truncated: boolean }> {
  const result = await ctx.upstream.sayari.ownership({
    id: args.entityId,
    limit: FAMILY_TRAVERSAL_LIMIT,
  });
  const enrichmentId = await recordEnrichment(ctx, {
    source: 'sayari_ownership_family',
    subjectKind: 'entity',
    subjectKey: args.entityId,
    requestParams: { entityId: args.entityId, limit: FAMILY_TRAVERSAL_LIMIT },
    result,
  });

  const paths = result.data.data ?? [];
  const byId = new Map<string, { entity: SayariEntity; path: unknown; depth: number }>();

  for (const path of paths) {
    // The `target` is the family member, and it arrives complete. Falling back
    // to the last path element covers the shape where it does not.
    const terminal = path.target ?? path.path?.[path.path.length - 1]?.entity;
    if (!terminal || typeof terminal !== 'object' || !('id' in terminal)) continue;
    const entity = terminal as SayariEntity;
    if (entity.id === args.entityId) continue;
    if (!byId.has(entity.id)) {
      byId.set(entity.id, {
        entity,
        // The SHAPE of the path, not the entities along it. Each hop's entity
        // is already upserted into `entity` and would be stored twice — and
        // measured, one raw path was 605 KB, because a traversal payload
        // carries a complete entity at every hop. What the UI renders is the
        // route: which relationship types it ran through, and which
        // `possibly_same_as` hops it took to get there.
        path: summarisePath(path.path),
        depth: path.path?.length ?? 1,
      });
    }
  }

  const truncated = paths.length >= FAMILY_TRAVERSAL_LIMIT;
  const members: FamilyMemberRisk[] = [];

  for (const [entityId, { entity, path, depth }] of byId) {
    await upsertEntity(ctx.db, entity);
    await ctx.db
      .insert(t.familyMember)
      .values({
        enrichmentId,
        rootEntityId: args.entityId,
        memberEntityId: entityId,
        path: (path ?? null) as never,
        hopDepth: depth,
        discoveredByJob: null,
        truncated,
        exploredCount: byId.size,
        reachableCount: null,
      })
      .onConflictDoNothing();

    members.push({
      entityId,
      label: entity.label,
      country: entity.countries?.[0] ?? null,
      // Union with per-factor provenance: the traversal payload and getEntity
      // disagree, and taking either as authoritative drops real factors.
      factors: unionRiskFactors([{ source: 'traversal', risk: entity.risk }]).map((u) => u.factor),
      fromDeepTraversal: false,
    });
  }

  return { enrichmentId, members, truncated };
}

/**
 * Reduces a traversal path to its route: one entry per hop, carrying the
 * relationship field and the entity id it reached.
 *
 * The entities themselves are upserted into `entity` by the caller, so storing
 * them again here would duplicate megabytes per Supplier — and a read tool
 * returning them wholesale is what fired the assess Job's 450,000-token ceiling.
 */
function summarisePath(path: unknown): { field: string | null; entityId: string | null }[] {
  if (!Array.isArray(path)) return [];
  return path.map((hop) => {
    const step = (hop ?? {}) as { field?: unknown; entity?: unknown };
    const entity = step.entity;
    return {
      field: typeof step.field === 'string' ? step.field : null,
      entityId:
        typeof entity === 'string'
          ? entity
          : entity && typeof entity === 'object' && 'id' in entity
            ? String((entity as { id: unknown }).id)
            : null,
    };
  });
}

// ── Owner edges ──────────────────────────────────────────────────────────────

/**
 * Current one-hop owner edges, for the Ownership exposure Criterion.
 *
 * Where `relationshipCount` says owner edges exist but the entity payload's
 * window was swamped by trade edges, this reads them with a **type-filtered
 * traversal at `maxDepth: 1`** rather than paging the entity payload — which is
 * cheaper and answers the question directly.
 */
export async function readOwnerEdges(
  ctx: EnrichContext,
  args: { entityId: string; entity: SayariEntity },
): Promise<{ entityId: string; label: string; riskFactors: ReturnType<typeof parseRiskObject>; isStateOwned: boolean }[]> {
  const owners: { entityId: string; label: string; riskFactors: ReturnType<typeof parseRiskObject>; isStateOwned: boolean }[] = [];

  for (const raw of args.entity.relationships?.data ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const edge = raw as { type?: unknown; former?: unknown; entity?: unknown; target?: unknown };
    const type = typeof edge.type === 'string' ? edge.type : '';
    // Only CURRENT owner edges are scored: a former owner is not an owner.
    if (!/owner|shareholder|parent/i.test(type) || edge.former === true) continue;

    const target = (edge.target ?? edge.entity) as SayariEntity | string | undefined;
    if (!target || typeof target === 'string') continue;

    await upsertEntity(ctx.db, target);
    const factors = parseRiskObject(target.risk);
    owners.push({
      entityId: target.id,
      label: target.label,
      riskFactors: factors,
      isStateOwned: factors.some((f) => /soe|state_owned|government/i.test(f.name)),
    });

    await ctx.db
      .insert(t.entityRelationship)
      .values({
        fromEntityId: target.id,
        toEntityId: args.entityId,
        relationshipType: type,
        former: false,
        hopDepth: 1,
        sourceRecordId: null,
      })
      .onConflictDoNothing();
  }
  return owners;
}

/** The Plants a Supplier's proximity is measured against. */
export async function loadPlants(db: Database, programId: string): Promise<PlantPoint[]> {
  const rows = await db.select().from(t.plant).where(eq(t.plant.programId, programId));
  return rows.map((p) => ({ code: p.code, city: p.city, lat: p.lat, lon: p.lon }));
}

export { nearestPlant };

/**
 * Writes a Criterion value **append-only**, superseding the previous current
 * row rather than updating it (SPEC §3.5).
 *
 * Append-only because a published Assessment cites a `criterion_value` row: if
 * a re-enrich could overwrite it in place, a cited number would change
 * underneath the sentence that argued from it.
 */
export async function writeCriterionValue(
  db: Database,
  args: {
    supplierId: string;
    programId: string;
    categoryId: string | null;
    criterionKey: string;
    value: number | null;
    unknownReason: string | null;
    rawInputs: Record<string, unknown>;
    anchorLine: string;
    jobId?: string | undefined;
  },
): Promise<string> {
  const previous = await db.query.criterionValue.findFirst({
    where: and(
      eq(t.criterionValue.supplierId, args.supplierId),
      eq(t.criterionValue.programId, args.programId),
      eq(t.criterionValue.criterionKey, args.criterionKey),
      eq(t.criterionValue.isCurrent, true),
      args.categoryId
        ? eq(t.criterionValue.categoryId, args.categoryId)
        : eq(t.criterionValue.criterionKey, args.criterionKey),
    ),
  });

  const [{ generation }] = (await db
    .select({ generation: sql<number>`count(*)::int` })
    .from(t.criterionValue)
    .where(
      and(
        eq(t.criterionValue.supplierId, args.supplierId),
        eq(t.criterionValue.criterionKey, args.criterionKey),
      ),
    )) as [{ generation: number }];

  const [row] = await db
    .insert(t.criterionValue)
    .values({
      id: derivedId('criterion_value', `${args.supplierId}:${args.criterionKey}`, generation),
      supplierId: args.supplierId,
      programId: args.programId,
      categoryId: args.categoryId,
      criterionKey: args.criterionKey,
      value: args.value,
      unknownReason: args.unknownReason,
      rawInputs: args.rawInputs as never,
      anchorLine: args.anchorLine,
      supersedesId: previous?.id ?? null,
      isCurrent: true,
      jobId: args.jobId ?? null,
    })
    .returning({ id: t.criterionValue.id });

  if (previous) {
    await db.update(t.criterionValue).set({ isCurrent: false }).where(eq(t.criterionValue.id, previous.id));
  }
  return row!.id;
}
