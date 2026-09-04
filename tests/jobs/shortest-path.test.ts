import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import * as t from '@/db/schema';
import { findAndWriteShortestPath } from '@/jobs/shortest-path';
import type { EnrichContext } from '@/jobs/enrich';
import { getTestDb, testDatabaseIsUp, testSql } from '../support/test-db';
import { resetDerived } from '../support/reset';

/**
 * KNOWN GAP, stated plainly rather than left to a source comment: every
 * `traversal.shortestPath` body below (`foundPathBody`, `noPathBody`) is a
 * hand-authored stand-in envelope, NOT a replayed real fixture. It is shaped
 * to match this project's own Zod schema for the endpoint
 * (`shortestPathSchemaInner`, `src/upstream/projections/sayari.ts`) as that
 * schema reads today, but it has never round-tripped through an actual
 * Sayari response, and right now it cannot: Sayari's own
 * `traversal.shortestPath` endpoint has a confirmed, ongoing outage,
 * independently verified two ways — this project's own calls all return a
 * real, well-formed `408 Timeout Error` body rather than any success, and a
 * completely separate client (Sayari's own official Python SDK, sharing no
 * code with this project) hit the same endpoint directly and failed the same
 * way on every attempt. That rules out a bug on this project's side.
 *
 * Do not "fix" this by fabricating a fixture or by deleting/weakening this
 * stub — it is the best available coverage until Sayari's endpoint recovers.
 * Once it does, replace the hand-built bodies below with a real captured
 * response (this project's own fixture-recording tooling, e.g. `pnpm
 * fixtures:record`, run against a live `pairs` or `recommend` Job), and this
 * note can come out.
 *
 * ---
 *
 * The shared shortest-path helper (network spec §4.2, §7; ticket 04, unit
 * 04b) — the single call site both the recommend Job's ninth submit check
 * (04c) and the *Check every pair* `pairs` Job (04e) will call as a library
 * function, next round. No recorded fixture exists for
 * `traversal.shortestPath` yet, so this is a unit test against a hand-built
 * envelope shaped like `shortestPathSchemaInner`
 * (`src/upstream/projections/sayari.ts`) — the same precedent
 * `tests/jobs/enrich-watchlist.test.ts` sets for a traversal-shaped read with
 * no recorded body.
 */

const ROOT_ID = 'shortest-path-root';
const TARGET_ID = 'shortest-path-target';
const JOB_ID = '11111111-1111-4111-8111-111111111111';

/** One direct hop from ROOT to TARGET — the shape `data[0]` holds when a path is found. */
const foundPathBody = {
  entities: [ROOT_ID, TARGET_ID],
  data: [
    {
      source: ROOT_ID,
      target: { id: TARGET_ID, label: 'Target Co', risk: { sanctions: { level: 'elevated' } } },
      path: [
        {
          field: 'shareholder_of',
          entity: { id: TARGET_ID, label: 'Target Co', risk: { sanctions: { level: 'elevated' } } },
          relationships: {
            shareholder_of: {
              values: [{ record: 'rec-shortest', from_date: '2020-01-01', to_date: null }],
            },
          },
        },
      ],
    },
  ],
};

/** The zero-entries shape a call with no shared Path returns — spec §4.2's "no Path". */
const noPathBody = { entities: [ROOT_ID, TARGET_ID], data: [] };

function buildShortestPath(db: Awaited<ReturnType<typeof getTestDb>>, body: unknown) {
  return async (params: unknown) => {
    const [payload] = await testSql()`
      INSERT INTO upstream_response (source, endpoint, params_hash, params, body, body_hash, via)
      VALUES ('sayari', 'traversal.shortestPath', ${'shortest-path-fixture:' + JSON.stringify(params)}, ${JSON.stringify(params)}::jsonb, '{}'::jsonb, 'shortest-path-fixture', 'sdk')
      RETURNING id`;
    return {
      data: body,
      cacheHit: false,
      via: 'sdk' as const,
      fetchedAt: new Date(),
      upstreamResponseId: payload!.id as string,
      bodyHash: 'shortest-path-fixture',
    };
  };
}

async function buildCtx(
  db: Awaited<ReturnType<typeof getTestDb>>,
  body: unknown,
  jobId?: string,
): Promise<EnrichContext> {
  return {
    db,
    upstream: {
      sayari: {
        shortestPath: buildShortestPath(db, body),
      },
    } as never,
    jobId,
  };
}

describe('findAndWriteShortestPath: the shared shortest-path helper', () => {
  beforeAll(() => {
    // Loud on purpose (see the file's own top comment): every test in this
    // file replays a hand-authored stand-in for `traversal.shortestPath`,
    // not a captured real response, because Sayari's own endpoint is
    // confirmed down. A green `pnpm test` run should not let that go unsaid.
    console.warn(
      '[KNOWN GAP] tests/jobs/shortest-path.test.ts stubs traversal.shortestPath with a ' +
        'hand-authored envelope, not a replayed fixture — Sayari\'s endpoint has a confirmed, ' +
        'independently-verified ongoing outage. Re-record via this project\'s fixture tooling ' +
        'once it recovers.',
    );
  });

  it('calls the endpoint with entities: [root, target], in that order', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: ROOT_ID, label: 'Root Co' });

    let requested: unknown;
    const ctx = await buildCtx(db, foundPathBody);
    ctx.upstream.sayari.shortestPath = async (params) => {
      requested = params;
      return (await buildCtx(db, foundPathBody)).upstream.sayari.shortestPath(params);
    };

    await findAndWriteShortestPath(ctx, {
      rootEntityId: ROOT_ID,
      targetEntityId: TARGET_ID,
      discoveredByJob: null,
    });

    expect(requested).toEqual({ entities: [ROOT_ID, TARGET_ID] });
  });

  it('writes a graph_path row of kind shortest_path, direction either, hardcoded coverage', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: ROOT_ID, label: 'Root Co' });

    const ctx = await buildCtx(db, foundPathBody, JOB_ID);
    const result = await findAndWriteShortestPath(ctx, {
      rootEntityId: ROOT_ID,
      targetEntityId: TARGET_ID,
      discoveredByJob: JOB_ID,
    });

    expect(result).toEqual({ terminalEntityId: TARGET_ID });

    const rows = await db
      .select()
      .from(t.graphPath)
      .where(
        and(
          eq(t.graphPath.rootEntityId, ROOT_ID),
          eq(t.graphPath.terminalEntityId, TARGET_ID),
          eq(t.graphPath.kind, 'shortest_path'),
        ),
      );
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.direction).toBe('either');
    expect(row.hopDepth).toBe(1);
    expect(row.truncated).toBe(false);
    expect(row.partialResults).toBe(false);
    expect(row.exploredCount).toBeNull();
    expect(row.discoveredByJob).toBe(JOB_ID);

    // `edge_ids` cites a real, resolvable `entity_relationship` row.
    const edgeIds = row.edgeIds as string[];
    expect(edgeIds).toHaveLength(1);
    const edges = await db
      .select()
      .from(t.entityRelationship)
      .where(inArray(t.entityRelationship.id, edgeIds));
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      fromEntityId: ROOT_ID,
      toEntityId: TARGET_ID,
      relationshipType: 'shareholder_of',
      sourceRecordId: 'rec-shortest',
    });

    // The read is a citable Enrichment under its own source, keyed on the root.
    const enrichmentRow = await db.query.enrichment.findFirst({
      where: and(
        eq(t.enrichment.subjectKey, ROOT_ID),
        eq(t.enrichment.source, 'sayari_shortest_path'),
      ),
    });
    expect(enrichmentRow).toBeTruthy();
    expect(row.enrichmentId).toBe(enrichmentRow!.id);

    // The terminal entity itself was upserted — the FK the edge depends on.
    const targetEntity = await db.query.entity.findFirst({ where: eq(t.entity.id, TARGET_ID) });
    expect(targetEntity).toBeTruthy();
  });

  it('returns undefined and writes nothing when no Path is found', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: ROOT_ID, label: 'Root Co' });

    const ctx = await buildCtx(db, noPathBody);
    const result = await findAndWriteShortestPath(ctx, {
      rootEntityId: ROOT_ID,
      targetEntityId: TARGET_ID,
      discoveredByJob: null,
    });

    expect(result).toBeUndefined();

    const rows = await db
      .select()
      .from(t.graphPath)
      .where(and(eq(t.graphPath.rootEntityId, ROOT_ID), eq(t.graphPath.kind, 'shortest_path')));
    expect(rows).toHaveLength(0);

    // No Path, no further cost (spec §4.2): not even an Enrichment is written.
    const enrichmentRow = await db.query.enrichment.findFirst({
      where: and(
        eq(t.enrichment.subjectKey, ROOT_ID),
        eq(t.enrichment.source, 'sayari_shortest_path'),
      ),
    });
    expect(enrichmentRow).toBeUndefined();
  });

  it('reuses writeGraphPaths\'s own upsert: a repeat call does not duplicate the row', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: ROOT_ID, label: 'Root Co' });

    const ctx = await buildCtx(db, foundPathBody);
    await findAndWriteShortestPath(ctx, {
      rootEntityId: ROOT_ID,
      targetEntityId: TARGET_ID,
      discoveredByJob: null,
    });
    const second = await findAndWriteShortestPath(ctx, {
      rootEntityId: ROOT_ID,
      targetEntityId: TARGET_ID,
      discoveredByJob: null,
    });

    expect(second).toEqual({ terminalEntityId: TARGET_ID });

    const rows = await db
      .select()
      .from(t.graphPath)
      .where(
        and(
          eq(t.graphPath.rootEntityId, ROOT_ID),
          eq(t.graphPath.terminalEntityId, TARGET_ID),
          eq(t.graphPath.kind, 'shortest_path'),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
