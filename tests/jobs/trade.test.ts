import { describe, expect, it } from 'vitest';
import { eq, and, inArray } from 'drizzle-orm';
import * as t from '@/db/schema';
import {
  loadCategoryHsHeadings,
  resolveTradeEntityId,
  runSupplyChainUpstreamTradeTraversal,
  runTradeFootprint,
  runTradeJob,
} from '@/jobs/trade';
import type { EnrichContext } from '@/jobs/enrich';
import { UpstreamError } from '@/upstream/errors';
import { getTestDb, testDatabaseIsUp, testSql } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { seededProgram } from '../support/seeded-program';

/**
 * The trade Job (network spec §4.3, §5; ticket 05, unit 05b).
 *
 * Every upstream boundary is stubbed directly on `ctx.upstream.sayari.*`,
 * the same house style `tests/jobs/pairs.test.ts`/`tests/jobs/shortest-
 * path.test.ts` use — no live call, no credential, a hand-built body shaped
 * the way the projected `SayariXxx` type describes it (snake_case field
 * names, since these tests bypass the zod projection layer entirely and
 * stub the already-projected result `call()` would have produced).
 */

const NOW = new Date('2026-09-03T00:00:00.000Z');

async function insertUpstreamResponse(endpoint: string, params: unknown): Promise<string> {
  const [row] = await testSql()`
    INSERT INTO upstream_response (source, endpoint, params_hash, params, body, body_hash, via)
    VALUES ('sayari', ${endpoint}, ${'trade-test-fixture:' + endpoint + ':' + JSON.stringify(params)}, ${JSON.stringify(params)}::jsonb, '{}'::jsonb, 'trade-test-fixture', 'sdk')
    RETURNING id`;
  return row!.id as string;
}

function stub<T>(endpoint: string, data: T) {
  const calls: unknown[] = [];
  const fn = async (params: unknown) => {
    calls.push(params);
    const upstreamResponseId = await insertUpstreamResponse(endpoint, params);
    return {
      data,
      cacheHit: false,
      via: 'sdk' as const,
      fetchedAt: new Date(),
      upstreamResponseId,
      bodyHash: 'trade-test-fixture',
    };
  };
  return { fn, calls };
}

const FOOTPRINT_ROOT = 'trade-root';

function footprintBody(entityId: string) {
  return {
    data: [
      {
        id: entityId,
        label: 'Root Co',
        countries: ['USA'],
        metadata: {
          shipments: 120,
          latest_shipment_date: '2026-08-01',
          hs_codes: [{ key: '850440', value: 'Static converters', doc_count: 45 }],
        },
      },
    ],
    size: { count: 1 },
    next: false,
    limit: 1,
    offset: 0,
  };
}

function buyersBody() {
  return {
    data: [
      {
        id: 'buyer-1',
        label: 'Buyer One',
        countries: ['USA'],
        risk: { sanctioned: { level: 'elevated' } },
        sanctioned: true,
        pep: false,
        metadata: { shipments: 5, hs_codes: [] },
      },
      {
        id: 'buyer-2',
        label: 'Buyer Two',
        countries: ['CAN'],
        metadata: { shipments: 2, hs_codes: [] },
      },
    ],
    size: { count: 2 },
    next: false,
  };
}

function shipmentsBody() {
  return {
    data: [
      {
        id: 'ship-1',
        buyer: [{ id: 'buyer-1', names: ['Buyer One'], countries: ['USA'] }],
        arrival_date: ['2026-07-01'],
        departure_date: ['2026-06-01'],
        product_origin: ['DEU'],
        hs_codes: [{ code: '850440', description: 'Static converters' }],
        monetary_value: [{ value: 1000, currency: 'USD', context: 'fob' }],
        weight: [{ value: 500, unit: 'kg', type: 'gross' }],
        record: 'rec-ship-1',
      },
    ],
    size: { count: 1 },
    next: false,
  };
}

function buildFootprintCtx(entityId: string, db: Awaited<ReturnType<typeof getTestDb>>) {
  const suppliers = stub('trade.searchSuppliers', footprintBody(entityId));
  const buyers = stub('trade.searchBuyers', buyersBody());
  const shipments = stub('trade.searchShipments', shipmentsBody());
  const ctx: EnrichContext = {
    db,
    upstream: {
      sayari: {
        tradeSearchSuppliers: suppliers.fn,
        tradeSearchBuyers: buyers.fn,
        tradeSearchShipments: shipments.fn,
      },
    } as never,
  };
  return { ctx, suppliers, buyers, shipments };
}

describe('runTradeFootprint: calls 1–3', () => {
  it('calls all three endpoints with filter.supplierId: [entityId], and the shipments call with a month-range arrivalDate', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: FOOTPRINT_ROOT, label: 'Root Co' });

    const { ctx, suppliers, buyers, shipments } = buildFootprintCtx(FOOTPRINT_ROOT, db);
    await runTradeFootprint(ctx, { entityId: FOOTPRINT_ROOT, now: NOW });

    expect(suppliers.calls[0]).toEqual({ supplierId: [FOOTPRINT_ROOT], limit: 1 });
    expect(buyers.calls[0]).toEqual({ supplierId: [FOOTPRINT_ROOT], limit: 50 });
    expect(shipments.calls[0]).toEqual({
      supplierId: [FOOTPRINT_ROOT],
      arrivalDate: '2024-09|2026-09',
      limit: 50,
    });
  });

  it('writes one trade_footprint row under its own Enrichment, with the HS facet and shipment count', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: FOOTPRINT_ROOT, label: 'Root Co' });

    const { ctx } = buildFootprintCtx(FOOTPRINT_ROOT, db);
    const result = await runTradeFootprint(ctx, { entityId: FOOTPRINT_ROOT, now: NOW });

    expect(result.footprintWritten).toBe(true);
    const rows = await db
      .select()
      .from(t.tradeFootprint)
      .where(eq(t.tradeFootprint.enrichmentId, result.footprintEnrichmentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.shipmentCount).toBe(120);
    expect(rows[0]!.latestShipmentDate).toBe('2026-08-01');
    expect(rows[0]!.hsFacet).toEqual([{ key: '850440', value: 'Static converters', docCount: 45 }]);
  });

  it('writes trade_buyer rows, ranked in the order the search returned them', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: FOOTPRINT_ROOT, label: 'Root Co' });

    const { ctx } = buildFootprintCtx(FOOTPRINT_ROOT, db);
    const result = await runTradeFootprint(ctx, { entityId: FOOTPRINT_ROOT, now: NOW });

    expect(result.buyerCount).toBe(2);
    const rows = await db
      .select()
      .from(t.tradeBuyer)
      .where(eq(t.tradeBuyer.enrichmentId, result.buyersEnrichmentId))
      .orderBy(t.tradeBuyer.rank);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      rank: 0,
      buyerEntityId: 'buyer-1',
      buyerName: 'Buyer One',
      countries: ['USA'],
      sanctioned: true,
      pep: false,
    });
    expect(rows[1]).toMatchObject({ rank: 1, buyerEntityId: 'buyer-2', buyerName: 'Buyer Two' });
  });

  it('writes trade_shipment rows, citable to their own record', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: FOOTPRINT_ROOT, label: 'Root Co' });

    const { ctx } = buildFootprintCtx(FOOTPRINT_ROOT, db);
    const result = await runTradeFootprint(ctx, { entityId: FOOTPRINT_ROOT, now: NOW });

    expect(result.shipmentCount).toBe(1);
    const rows = await db
      .select()
      .from(t.tradeShipment)
      .where(eq(t.tradeShipment.enrichmentId, result.shipmentsEnrichmentId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shipmentId: 'ship-1',
      record: 'rec-ship-1',
      productOrigin: ['DEU'],
    });
    expect(rows[0]!.buyer).toEqual([{ id: 'buyer-1', name: 'Buyer One', countries: ['USA'] }]);
    expect(rows[0]!.hsCodes).toEqual([{ code: '850440', description: 'Static converters' }]);
    expect(rows[0]!.monetaryValue).toEqual([{ value: 1000, currency: 'USD', context: 'fob' }]);
    expect(rows[0]!.weight).toEqual([{ value: 500, unit: 'kg', type: 'gross' }]);
  });

  it('records three separate Enrichment rows, one per call, all under sayari_trade_footprint, sharing one counted generation', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: FOOTPRINT_ROOT, label: 'Root Co' });

    const { ctx } = buildFootprintCtx(FOOTPRINT_ROOT, db);
    const result = await runTradeFootprint(ctx, { entityId: FOOTPRINT_ROOT, now: NOW });

    const ids = [result.footprintEnrichmentId, result.buyersEnrichmentId, result.shipmentsEnrichmentId];
    expect(new Set(ids).size).toBe(3);

    const rows = await db
      .select()
      .from(t.enrichment)
      .where(
        and(eq(t.enrichment.source, 'sayari_trade_footprint'), eq(t.enrichment.subjectKey, FOOTPRINT_ROOT)),
      )
      .orderBy(t.enrichment.generation);
    expect(rows.map((r) => r.generation)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.id)).toEqual(ids);
  });

  it('still records the footprint Enrichment when searchSuppliers returns no row, but writes no trade_footprint row', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: FOOTPRINT_ROOT, label: 'Root Co' });

    const suppliers = stub('trade.searchSuppliers', { data: [], size: { count: 0 }, next: false });
    const buyers = stub('trade.searchBuyers', { data: [], size: { count: 0 }, next: false });
    const shipments = stub('trade.searchShipments', { data: [], size: { count: 0 }, next: false });
    const ctx: EnrichContext = {
      db,
      upstream: {
        sayari: {
          tradeSearchSuppliers: suppliers.fn,
          tradeSearchBuyers: buyers.fn,
          tradeSearchShipments: shipments.fn,
        },
      } as never,
    };

    const result = await runTradeFootprint(ctx, { entityId: FOOTPRINT_ROOT, now: NOW });
    expect(result.footprintWritten).toBe(false);
    const rows = await db
      .select()
      .from(t.tradeFootprint)
      .where(eq(t.tradeFootprint.enrichmentId, result.footprintEnrichmentId));
    expect(rows).toHaveLength(0);
    // The call was still made and is still citable — see `runTradeFootprint`'s
    // own doc comment: unlike `findAndWriteShortestPath`'s "no Path, no
    // further cost", the trade Job's calls are fixed-cost every run.
    const enrichmentRow = await db.query.enrichment.findFirst({
      where: eq(t.enrichment.id, result.footprintEnrichmentId),
    });
    expect(enrichmentRow).toBeTruthy();
  });
});

// ── Call 4: supplyChain.upstreamTradeTraversal ──────────────────────────────

const SC_ROOT = 'supply-chain-root';
const TIER1 = 'supply-chain-tier1';
const TIER2 = 'supply-chain-tier2';

function twoTierBody(rootId: string) {
  return {
    filters: {},
    data: {
      paths: [
        {
          source_entity_id: rootId,
          path: [
            {
              tier: 1,
              entity_id: TIER1,
              components: [
                {
                  hs_code: '850440',
                  arrival_countries: ['USA'],
                  departure_countries: ['DEU'],
                  min_date: '2024-01-01',
                  max_date: '2024-06-01',
                },
              ],
            },
          ],
        },
        {
          source_entity_id: rootId,
          path: [
            {
              tier: 1,
              entity_id: TIER1,
              components: [
                {
                  hs_code: '850440',
                  arrival_countries: ['USA'],
                  departure_countries: ['DEU'],
                  min_date: '2024-01-01',
                  max_date: '2024-06-01',
                },
              ],
            },
            {
              tier: 2,
              entity_id: TIER2,
              components: [
                {
                  hs_code: '850450',
                  arrival_countries: ['DEU'],
                  departure_countries: ['CHN'],
                  min_date: '2023-06-01',
                  max_date: '2024-01-01',
                },
              ],
            },
          ],
        },
      ],
      entities: {
        [TIER1]: { id: TIER1, type: 'company', label: 'Tier 1 Co', risk_factors: [], countries: ['DEU'] },
        [TIER2]: {
          id: TIER2,
          type: 'company',
          label: 'Tier 2 Co',
          risk_factors: ['forced_labor_uflpa_origin_subtier'],
          countries: ['CHN'],
        },
      },
    },
    explored_count: 42,
    partial_results: false,
  };
}

function buildSupplyChainCtx(body: unknown) {
  return stub('supplyChain.upstreamTradeTraversal', body);
}

describe('runSupplyChainUpstreamTradeTraversal: call 4', () => {
  it('calls with id, component, the fixed risk stems, maxDepth: 2, and minDate 24 months back', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: SC_ROOT, label: 'SC Root Co' });

    const upstream = buildSupplyChainCtx(twoTierBody(SC_ROOT));
    const ctx: EnrichContext = { db, upstream: { sayari: { upstreamTradeTraversal: upstream.fn } } as never };

    await runSupplyChainUpstreamTradeTraversal(ctx, {
      entityId: SC_ROOT,
      component: ['850440', '850440'],
      now: NOW,
    });

    const requested = upstream.calls[0] as Record<string, unknown>;
    expect(requested.id).toBe(SC_ROOT);
    expect(requested.component).toEqual(['850440']); // deduped
    expect(requested.maxDepth).toBe(2);
    expect(requested.minDate).toBe('2024-09-03');
    expect(Array.isArray(requested.risk)).toBe(true);
    expect((requested.risk as string[]).length).toBeGreaterThan(0);
  });

  it('writes one graph_path row per distinct terminal, kind supply_chain, direction upstream, hop depth from tier', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: SC_ROOT, label: 'SC Root Co' });

    const upstream = buildSupplyChainCtx(twoTierBody(SC_ROOT));
    const ctx: EnrichContext = { db, upstream: { sayari: { upstreamTradeTraversal: upstream.fn } } as never };

    const result = await runSupplyChainUpstreamTradeTraversal(ctx, {
      entityId: SC_ROOT,
      component: ['850440'],
      now: NOW,
    });

    expect(result.pathsConsidered).toBe(2);
    const rows = await db.select().from(t.graphPath).where(eq(t.graphPath.rootEntityId, SC_ROOT));
    expect(rows).toHaveLength(2);
    const byTerminal = new Map(rows.map((r) => [r.terminalEntityId, r]));
    expect(byTerminal.get(TIER1)).toMatchObject({ kind: 'supply_chain', direction: 'upstream', hopDepth: 1 });
    expect(byTerminal.get(TIER2)).toMatchObject({ kind: 'supply_chain', direction: 'upstream', hopDepth: 2 });
    expect(byTerminal.get(TIER2)!.edgeIds).toHaveLength(2);
  });

  it('writes entity_relationship edges root→tier1→tier2, subject closer to root, target the new (upstream) entity, relationshipType supplied_by', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: SC_ROOT, label: 'SC Root Co' });

    const upstream = buildSupplyChainCtx(twoTierBody(SC_ROOT));
    const ctx: EnrichContext = { db, upstream: { sayari: { upstreamTradeTraversal: upstream.fn } } as never };
    await runSupplyChainUpstreamTradeTraversal(ctx, { entityId: SC_ROOT, component: ['850440'], now: NOW });

    const edges = await db
      .select()
      .from(t.entityRelationship)
      .where(inArray(t.entityRelationship.fromEntityId, [SC_ROOT, TIER1]));
    expect(edges).toHaveLength(2);

    const rootToTier1 = edges.find((e) => e.fromEntityId === SC_ROOT && e.toEntityId === TIER1);
    expect(rootToTier1).toMatchObject({ relationshipType: 'supplied_by', hopDepth: 1 });
    expect(rootToTier1!.sourceRecordId).toMatch(/^synthetic:supply_chain:/);

    const tier1ToTier2 = edges.find((e) => e.fromEntityId === TIER1 && e.toEntityId === TIER2);
    expect(tier1ToTier2).toMatchObject({ relationshipType: 'supplied_by', hopDepth: 2 });
  });

  it('is idempotent: running twice writes the same entity_relationship rows, not double', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: SC_ROOT, label: 'SC Root Co' });

    const runOnce = async () => {
      const upstream = buildSupplyChainCtx(twoTierBody(SC_ROOT));
      const ctx: EnrichContext = {
        db,
        upstream: { sayari: { upstreamTradeTraversal: upstream.fn } } as never,
      };
      return runSupplyChainUpstreamTradeTraversal(ctx, {
        entityId: SC_ROOT,
        component: ['850440'],
        now: NOW,
      });
    };

    await runOnce();
    const afterFirst = await db
      .select()
      .from(t.entityRelationship)
      .where(inArray(t.entityRelationship.fromEntityId, [SC_ROOT, TIER1]));
    expect(afterFirst).toHaveLength(2);

    await runOnce();
    const afterSecond = await db
      .select()
      .from(t.entityRelationship)
      .where(inArray(t.entityRelationship.fromEntityId, [SC_ROOT, TIER1]));
    expect(afterSecond).toHaveLength(2);
    expect(new Set(afterSecond.map((r) => r.id))).toEqual(new Set(afterFirst.map((r) => r.id)));
  });

  it('never fabricates a leveled risk block from riskFactors, and never overwrites an entity’s existing risk', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: SC_ROOT, label: 'SC Root Co' });
    // TIER2's riskFactors carries a forced-labour name on the payload — but
    // the entity already holds a leveled risk block from an earlier sighting.
    const existingRisk = { sanctioned: { level: 'high', value: true, metadata: {} } };
    await db.insert(t.entity).values({ id: TIER2, label: 'Pre-existing Tier 2', risk: existingRisk });

    const upstream = buildSupplyChainCtx(twoTierBody(SC_ROOT));
    const ctx: EnrichContext = { db, upstream: { sayari: { upstreamTradeTraversal: upstream.fn } } as never };
    await runSupplyChainUpstreamTradeTraversal(ctx, { entityId: SC_ROOT, component: ['850440'], now: NOW });

    const tier2 = await db.query.entity.findFirst({ where: eq(t.entity.id, TIER2) });
    expect(tier2!.risk).toEqual(existingRisk);
  });

  it('stops a chain at a segment whose entity is missing from the entities map, writing nothing for it', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: SC_ROOT, label: 'SC Root Co' });

    const body = twoTierBody(SC_ROOT);
    // Drop TIER1 from the entities map — the first hop of both paths becomes unresolvable.
    delete (body.data.entities as Record<string, unknown>)[TIER1];

    const upstream = buildSupplyChainCtx(body);
    const ctx: EnrichContext = { db, upstream: { sayari: { upstreamTradeTraversal: upstream.fn } } as never };
    const result = await runSupplyChainUpstreamTradeTraversal(ctx, {
      entityId: SC_ROOT,
      component: ['850440'],
      now: NOW,
    });

    expect(result.members).toHaveLength(0);
    const rows = await db.select().from(t.graphPath).where(eq(t.graphPath.rootEntityId, SC_ROOT));
    expect(rows).toHaveLength(0);
  });

  it('records discoveredByJob as the triggering Job id, and reads coverage off the envelope', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: SC_ROOT, label: 'SC Root Co' });
    const jobId = '22222222-2222-4222-8222-222222222222';

    const body = { ...twoTierBody(SC_ROOT), partial_results: true, explored_count: 999 };
    const upstream = buildSupplyChainCtx(body);
    const ctx: EnrichContext = {
      db,
      upstream: { sayari: { upstreamTradeTraversal: upstream.fn } } as never,
      jobId,
    };
    await runSupplyChainUpstreamTradeTraversal(ctx, { entityId: SC_ROOT, component: ['850440'], now: NOW });

    const rows = await db.select().from(t.graphPath).where(eq(t.graphPath.rootEntityId, SC_ROOT));
    expect(rows.every((r) => r.discoveredByJob === jobId)).toBe(true);
    // partial_results: true means explored_count is not trusted (the same
    // rule enrichFamily/enrichOwnership apply to their own envelopes).
    expect(rows.every((r) => r.truncated === true && r.exploredCount === null)).toBe(true);
  });

  /**
   * Regression for BUILD-NOTES finding 161. Live against Yazaki, this call
   * came back a bare Sayari `404` (`not_found`, `src/upstream/classify.ts`)
   * — the endpoint is a resource fetch, not a search, and answers "nothing
   * upstream matches this filter" that way rather than `200` with an empty
   * `data.paths`, unlike the three `trade.search*` calls above. Left
   * uncaught, that 404 used to propagate out of this function, fail the
   * whole trade Job, and discard the three already-written footprint calls'
   * work — over a Profile that legitimately has no upstream chain to show.
   */
  it('returns an empty result, not a throw, when Sayari answers 404 (nothing upstream, not a failure)', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: SC_ROOT, label: 'SC Root Co' });

    const notFound = new UpstreamError({
      kind: 'not_found',
      source: 'sayari',
      endpoint: 'supplyChain.upstreamTradeTraversal',
      message: 'sayari has no supplyChain.upstreamTradeTraversal result for these parameters (404).',
      statusCode: 404,
    });
    const ctx: EnrichContext = {
      db,
      upstream: {
        sayari: {
          upstreamTradeTraversal: async () => {
            throw notFound;
          },
        },
      } as never,
    };

    const result = await runSupplyChainUpstreamTradeTraversal(ctx, {
      entityId: SC_ROOT,
      component: ['850440'],
      now: NOW,
    });

    expect(result).toEqual({
      enrichmentId: null,
      members: [],
      truncated: false,
      reachable: null,
      pathsConsidered: 0,
    });
    const rows = await db.select().from(t.graphPath).where(eq(t.graphPath.rootEntityId, SC_ROOT));
    expect(rows).toHaveLength(0);
    const enrichments = await db
      .select()
      .from(t.enrichment)
      .where(eq(t.enrichment.source, 'sayari_supply_chain_upstream'));
    expect(enrichments).toHaveLength(0);
  });

  it('still throws every other UpstreamErrorKind — only not_found is treated as empty', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: SC_ROOT, label: 'SC Root Co' });

    const rateLimited = new UpstreamError({
      kind: 'rate_limit',
      source: 'sayari',
      endpoint: 'supplyChain.upstreamTradeTraversal',
      message: 'sayari rate-limited supplyChain.upstreamTradeTraversal (429).',
      statusCode: 429,
    });
    const ctx: EnrichContext = {
      db,
      upstream: {
        sayari: {
          upstreamTradeTraversal: async () => {
            throw rateLimited;
          },
        },
      } as never,
    };

    await expect(
      runSupplyChainUpstreamTradeTraversal(ctx, { entityId: SC_ROOT, component: ['850440'], now: NOW }),
    ).rejects.toThrow(rateLimited);
  });
});

// ── The Category's six-digit HS codes ───────────────────────────────────────

describe('resolveTradeEntityId', () => {
  /**
   * Regression for BUILD-NOTES finding 161: `tradeJobHandler`
   * (`src/worker/main.ts`) used to read `job.subjectId` straight into
   * `runTradeJob`'s `entityId`, on the belief the trade Job's subject was
   * already a Sayari entity id, like `traverse`'s. `enqueue_trade` actually
   * enqueues `subjectType: 'supplier'`, `subjectId: supplier.id`
   * (`tests/tools/enqueue-trade.test.ts` asserts that call shape directly) —
   * so a real, worker-driven trade Job was the first thing to ever pass a
   * Supplier's own uuid to a Sayari call expecting its entity id. This
   * exercises the resolution step the worker now performs first.
   */
  it("resolves a Supplier row's own id to its accepted Match's entity id", async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const program = await seededProgram(db);
    const supplier = await db.query.supplier.findFirst({
      where: (row, { eq: equals }) => equals(row.programId, program.id),
    });
    if (!supplier) throw new Error('the approved Program has no seeded suppliers');

    const entityId = 'resolve-trade-entity-id-entity';
    await db.insert(t.entity).values({ id: entityId, label: 'Entity Co' });
    await db
      .insert(t.match)
      .values({ supplierId: supplier.id, status: 'accepted', entityId, settledBy: 'human' });

    await expect(resolveTradeEntityId(db, supplier.id)).resolves.toBe(entityId);
  });

  it('returns null for a Supplier with no Match at all', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const program = await seededProgram(db);
    const supplier = await db.query.supplier.findFirst({
      where: (row, { eq: equals }) => equals(row.programId, program.id),
    });
    if (!supplier) throw new Error('the approved Program has no seeded suppliers');

    await expect(resolveTradeEntityId(db, supplier.id)).resolves.toBeNull();
  });

  it('returns null for a Supplier whose Match is not accepted', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const program = await seededProgram(db);
    const supplier = await db.query.supplier.findFirst({
      where: (row, { eq: equals }) => equals(row.programId, program.id),
    });
    if (!supplier) throw new Error('the approved Program has no seeded suppliers');

    await db.insert(t.match).values({ supplierId: supplier.id, status: 'needs_review', settledBy: 'human' });

    await expect(resolveTradeEntityId(db, supplier.id)).resolves.toBeNull();
  });
});

describe('loadCategoryHsHeadings', () => {
  it('returns the six-digit heading of every HS line on every Category an accepted Supplier bidding this entity carries', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const program = await seededProgram(db);
    const category = await db.query.category.findFirst({
      where: (row, { and: allOf, eq: equals }) => allOf(equals(row.programId, program.id), equals(row.code, 'PWR')),
    });
    if (!category) throw new Error('seed roster no longer carries a PWR category');
    const bidder = await db
      .select({ supplierId: t.supplierCategory.supplierId })
      .from(t.supplierCategory)
      .where(eq(t.supplierCategory.categoryId, category.id))
      .limit(1);
    const supplierId = bidder[0]!.supplierId;

    const entityId = 'hs-heading-entity';
    await db.insert(t.entity).values({ id: entityId, label: 'Entity Co' });
    await db
      .insert(t.match)
      .values({ supplierId, status: 'accepted', entityId, settledBy: 'human' });

    const headings = await loadCategoryHsHeadings(db, entityId);
    expect(headings).toContain('850440');
  });

  it('returns an empty array when no accepted match names this entity id', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const headings = await loadCategoryHsHeadings(db, 'no-such-profile');
    expect(headings).toEqual([]);
  });
});

// ── The whole Job ────────────────────────────────────────────────────────────

describe('runTradeJob: the whole trade Job', () => {
  it('makes exactly four upstream calls and returns a summary of all four', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const entityId = 'trade-job-entity';
    await db.insert(t.entity).values({ id: entityId, label: 'Entity Co' });

    const suppliers = stub('trade.searchSuppliers', footprintBody(entityId));
    const buyers = stub('trade.searchBuyers', buyersBody());
    const shipments = stub('trade.searchShipments', shipmentsBody());
    const upstreamTraversal = stub('supplyChain.upstreamTradeTraversal', twoTierBody(entityId));

    const ctx: EnrichContext = {
      db,
      upstream: {
        sayari: {
          tradeSearchSuppliers: suppliers.fn,
          tradeSearchBuyers: buyers.fn,
          tradeSearchShipments: shipments.fn,
          upstreamTradeTraversal: upstreamTraversal.fn,
        },
      } as never,
    };

    const result = await runTradeJob(ctx, { entityId, now: NOW });

    expect(suppliers.calls).toHaveLength(1);
    expect(buyers.calls).toHaveLength(1);
    expect(shipments.calls).toHaveLength(1);
    expect(upstreamTraversal.calls).toHaveLength(1);
    expect(result.footprintWritten).toBe(true);
    expect(result.buyerCount).toBe(2);
    expect(result.shipmentCount).toBe(1);
    expect(result.supplyChainPathCount).toBeGreaterThan(0);
  });
});
