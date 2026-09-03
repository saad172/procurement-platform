import { describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import * as t from '@/db/schema';
import { enrichWatchlist, type EnrichContext } from '@/jobs/enrich';
import type { TraversalWalkParams } from '@/upstream/endpoints';
import { WATCHLIST_TRAVERSAL_LIMIT, WATCHLIST_TRAVERSAL_MAX_DEPTH } from '@/config/constants';
import { getTestDb, testDatabaseIsUp, testSql } from '../support/test-db';
import { resetDerived } from '../support/reset';

/**
 * The watchlist read — the second automatic call per accepted Profile
 * (network spec §4.1, ticket 02). No recorded fixture exists for
 * `traversal.watchlist` yet (out of scope for this ticket — the whole
 * roster's fixtures are re-recorded once, at the end of the ticket, per the
 * network spec's own build order), so this is a unit test against a
 * hand-built envelope, shaped like the recorded ownership one
 * (`tests/fixtures/enrich/yazaki.json`) rather than replayed through it —
 * the same precedent `tests/jobs/enrich-owner-edges.test.ts` sets for the
 * typed owner-edge read.
 */

const ROOT_ID = 'watchlist-root';
const LISTED_DIRECT = 'watchlist-listed-direct';
const PSA_HOP = 'watchlist-psa-hop';
const LISTED_VIA_PSA = 'watchlist-listed-via-psa';

/**
 * Two paths: one direct hop to a Listed entity, and one that runs through a
 * `possibly_same_as` hop first — so the psa-exclusion rule
 * (`ownershipHopDepth`) has something to prove on a Path this file writes,
 * not only on the family read's own.
 */
const watchlistBody = {
  data: [
    {
      path: [
        {
          field: 'sanctioned_by',
          entity: { id: LISTED_DIRECT, label: 'Listed Direct Co', risk: { sanctions: { level: 'high' } } },
          relationships: {
            sanctioned_by: {
              values: [
                {
                  record: 'rec-direct',
                  from_date: '2019-01-01',
                  to_date: null,
                  attributes: { shares: [{ percentage: 10 }] },
                },
              ],
            },
          },
        },
      ],
      target: { id: LISTED_DIRECT, label: 'Listed Direct Co', risk: { sanctions: { level: 'high' } } },
    },
    {
      path: [
        {
          field: 'possibly_same_as',
          entity: { id: PSA_HOP, label: 'PSA Hop Co' },
          relationships: {},
        },
        {
          field: 'shareholder_of',
          entity: { id: LISTED_VIA_PSA, label: 'Listed Via Psa Co', risk: { pep: { level: 'elevated' } } },
          relationships: {
            shareholder_of: {
              values: [{ record: 'rec-via-psa', from_date: '2021-06-01', to_date: null }],
            },
          },
        },
      ],
      target: { id: LISTED_VIA_PSA, label: 'Listed Via Psa Co', risk: { pep: { level: 'elevated' } } },
    },
  ],
  next: false,
  offset: 0,
  limit: WATCHLIST_TRAVERSAL_LIMIT,
  min_depth: 1,
  max_depth: WATCHLIST_TRAVERSAL_MAX_DEPTH,
  explored_count: 12,
  partial_results: false,
};

async function buildCtx(db: Awaited<ReturnType<typeof getTestDb>>): Promise<EnrichContext> {
  return {
    db,
    upstream: {
      sayari: {
        watchlist: async (params: unknown) => {
          const [payload] = await testSql()`
            INSERT INTO upstream_response (source, endpoint, params_hash, params, body, body_hash, via)
            VALUES ('sayari', 'traversal.watchlist', 'watchlist-fixture', ${JSON.stringify(params)}::jsonb, '{}'::jsonb, 'watchlist-fixture', 'sdk')
            RETURNING id`;
          return {
            data: watchlistBody,
            cacheHit: false,
            via: 'sdk' as const,
            fetchedAt: new Date(),
            upstreamResponseId: payload!.id as string,
            bodyHash: 'watchlist-fixture',
          };
        },
      },
    } as never,
    jobId: undefined,
  };
}

describe('enrichWatchlist: the second automatic call', () => {
  it('calls the endpoint at the documented defaults', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: ROOT_ID, label: 'Root Co' });

    let requested: unknown;
    const ctx = await buildCtx(db);
    ctx.upstream.sayari.watchlist = async (params: TraversalWalkParams) => {
      requested = params;
      return (await buildCtx(db)).upstream.sayari.watchlist(params);
    };

    await enrichWatchlist(ctx, { entityId: ROOT_ID });

    // network spec §4.1: `maxDepth: 4`, `psa: true`, `limit: 50`, and no
    // `relationships` at all — the endpoint's own default 31 types.
    expect(requested).toMatchObject({
      id: ROOT_ID,
      maxDepth: WATCHLIST_TRAVERSAL_MAX_DEPTH,
      psa: true,
      limit: WATCHLIST_TRAVERSAL_LIMIT,
    });
    expect((requested as { relationships?: unknown }).relationships).toBeUndefined();
  });

  it('writes a Path of kind watchlist, direction either, per Listed entity', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: ROOT_ID, label: 'Root Co' });

    const ctx = await buildCtx(db);
    const result = await enrichWatchlist(ctx, { entityId: ROOT_ID });

    expect(result.truncated).toBe(false);
    // Read off the envelope's own `explored_count`, not inferred from how
    // many Paths came back.
    expect(result.reachable).toBe(12);

    const rows = await db
      .select()
      .from(t.graphPath)
      .where(and(eq(t.graphPath.rootEntityId, ROOT_ID), eq(t.graphPath.kind, 'watchlist')));
    expect(rows.map((r) => r.terminalEntityId).sort()).toEqual(
      [LISTED_DIRECT, LISTED_VIA_PSA].sort(),
    );
    for (const row of rows) {
      expect(row.direction).toBe('either');
      expect(row.discoveredByJob).toBeNull();
      expect(row.truncated).toBe(false);
      expect(row.partialResults).toBe(false);
      expect(row.exploredCount).toBe(12);
    }

    // The direct Path is one ownership-counted hop; the psa Path is ALSO one,
    // because the `possibly_same_as` step does not count (the one hop-depth
    // rule this ticket makes every kind share).
    const byTerminal = new Map(rows.map((r) => [r.terminalEntityId, r]));
    expect(byTerminal.get(LISTED_DIRECT)?.hopDepth).toBe(1);
    expect(byTerminal.get(LISTED_VIA_PSA)?.hopDepth).toBe(1);

    // `edge_ids` cites real `entity_relationship` rows, in hop order.
    for (const row of rows) {
      const edgeIds = row.edgeIds as string[];
      expect(edgeIds.length).toBeGreaterThan(0);
      const edges = await db
        .select()
        .from(t.entityRelationship)
        .where(inArray(t.entityRelationship.id, edgeIds));
      expect(edges).toHaveLength(edgeIds.length);
    }

    // The psa Path's edges are BOTH hops, in order — a `possibly_same_as`
    // step is excluded from the ownership hop-depth count, but it is still a
    // real, citable edge between two records of the same company, and
    // `summarisePath` chains the second hop's subject off it (root → PSA_HOP
    // → the terminal), not off the root directly.
    const viaPsaEdgeId = byTerminal.get(LISTED_VIA_PSA)!.edgeIds as string[];
    expect(viaPsaEdgeId).toHaveLength(2);
    const viaPsaEdgesById = new Map(
      (
        await db
          .select()
          .from(t.entityRelationship)
          .where(inArray(t.entityRelationship.id, viaPsaEdgeId))
      ).map((e) => [e.id, e]),
    );
    const viaPsaEdges = viaPsaEdgeId.map((id) => viaPsaEdgesById.get(id)!);
    expect(viaPsaEdges.map((e) => [e.fromEntityId, e.toEntityId, e.relationshipType])).toEqual([
      [ROOT_ID, PSA_HOP, 'possibly_same_as'],
      [PSA_HOP, LISTED_VIA_PSA, 'shareholder_of'],
    ]);
    expect(viaPsaEdges[1]?.sourceRecordId).toBe('rec-via-psa');

    // The intermediate psa-hop entity was upserted too — the FK the edge
    // above depends on.
    const psaHopEntity = await db.query.entity.findFirst({ where: eq(t.entity.id, PSA_HOP) });
    expect(psaHopEntity).toBeTruthy();

    // And the read is a citable Enrichment under its own source, distinct
    // from the ownership family's.
    const enrichmentRow = await db.query.enrichment.findFirst({
      where: and(eq(t.enrichment.subjectKey, ROOT_ID), eq(t.enrichment.source, 'sayari_watchlist')),
    });
    expect(enrichmentRow).toBeTruthy();
    expect(rows.every((r) => r.enrichmentId === enrichmentRow!.id)).toBe(true);
  });

  it('records truncation and null reachable when the envelope says results are partial', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: ROOT_ID, label: 'Root Co' });

    const ctx = await buildCtx(db);
    ctx.upstream.sayari.watchlist = async (params: TraversalWalkParams) => {
      const base = await (await buildCtx(db)).upstream.sayari.watchlist(params);
      return { ...base, data: { ...base.data, partial_results: true, explored_count: 9999 } };
    };

    const result = await enrichWatchlist(ctx, { entityId: ROOT_ID });
    expect(result.truncated).toBe(true);
    // Partial results means the figure bounds nothing — unknown, not 9999.
    expect(result.reachable).toBeNull();

    const rows = await db
      .select()
      .from(t.graphPath)
      .where(and(eq(t.graphPath.rootEntityId, ROOT_ID), eq(t.graphPath.kind, 'watchlist')));
    expect(rows.every((r) => r.truncated === true && r.partialResults === true)).toBe(true);
    expect(rows.every((r) => r.exploredCount === null)).toBe(true);
  });
});
