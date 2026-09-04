import { afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import {
  ownerEdgeGap,
  parseTypedOwnerEdges,
  readOwnerEdges,
  storeRelationships,
  type EnrichContext,
} from '@/jobs/enrich';
import type { ParsedEdge } from '@/domain/parse-relationships';
import type { SayariEntity } from '@/upstream/projections/sayari';
import {
  getTestDb,
  testDatabaseIsUp,
  testSql,
  closeTestDb,
  START_TEST_DB_HINT,
} from '../support/test-db';
import { resetDerived } from '../support/reset';

/**
 * **Typed owner-edge read** (SPEC §16.6, ticket 01 item B) and **the
 * minimum-hop rule** (item D).
 *
 * `readOwnerEdges` only ever parsed the entity payload's own relationship
 * window; `traversal.traversal` had no callers. This is a unit test against
 * hand-built bodies shaped like the recorded ones — a live typed read is
 * listed under **Re-record** in the PR, because no fixture holds one.
 */

const up = await testDatabaseIsUp();

/** A ParsedEdge builder, for the pure `ownerEdgeGap` tests below. */
const parsedEdge = (relationshipType: string, targetId: string): ParsedEdge => ({
  subjectId: 'ROOT',
  targetId,
  targetLabel: targetId,
  targetType: 'company',
  relationshipType,
  former: false,
  startDate: null,
  endDate: null,
  sourceRecordId: null,
  attributes: null,
  targetEntity: { id: targetId, label: targetId },
});

describe('ownerEdgeGap: relationship_count vs the window, per type', () => {
  it('is empty when relationship_count names no upward-ownership type at all', () => {
    const entity = {
      id: 'ROOT',
      label: 'Root',
      relationship_count: { owner_of: 5, has_officer: 3 },
    } as SayariEntity;
    expect(ownerEdgeGap(entity, [])).toEqual([]);
  });

  it('is empty when the window already carries as many edges of the type as claimed', () => {
    const entity = {
      id: 'ROOT',
      label: 'Root',
      relationship_count: { has_shareholder: 1 },
    } as SayariEntity;
    expect(ownerEdgeGap(entity, [parsedEdge('has_shareholder', 'P1')])).toEqual([]);
  });

  it('names the type relationship_count claims more of than the window delivered', () => {
    const entity = {
      id: 'ROOT',
      label: 'Root',
      relationship_count: { has_shareholder: 2, notify_party_of: 1 },
    } as SayariEntity;
    const edges = [parsedEdge('has_shareholder', 'P1'), parsedEdge('notify_party_of', 'B1')];
    expect(ownerEdgeGap(entity, edges)).toEqual(['has_shareholder']);
  });

  /**
   * The instruction this guards, stated as a test: `relationshipsTruncated`
   * fires on ANY truncated window — a trade-swamped one included — and says
   * nothing about whether an OWNER edge specifically was lost. Here the
   * window is not truncated at all (one edge claimed, one edge returned), and
   * the gap is still real because the one edge that came back is not the
   * `has_shareholder` one `relationship_count` names.
   */
  it('flags a type-specific gap even where the window is not truncated overall', () => {
    const entity = {
      id: 'ROOT',
      label: 'Root',
      relationship_count: { has_shareholder: 1 },
    } as SayariEntity;
    expect(ownerEdgeGap(entity, [parsedEdge('notify_party_of', 'B1')])).toEqual([
      'has_shareholder',
    ]);
  });
});

describe('parseTypedOwnerEdges: a traversal path read as an edge', () => {
  const ROOT = 'ROOT';

  it('turns a one-hop path into an edge named from the field, subject-first', () => {
    const body = {
      data: [
        {
          path: [
            {
              field: 'has_shareholder',
              entity: { id: 'PARENT', label: 'Parent Co', type: 'company' },
            },
          ],
          target: {
            id: 'PARENT',
            label: 'Parent Co',
            type: 'company',
            risk: { basel_aml: { level: 'relevant' } },
          },
        },
      ],
    };
    const edges = parseTypedOwnerEdges(body, ROOT);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      subjectId: ROOT,
      targetId: 'PARENT',
      targetLabel: 'Parent Co',
      relationshipType: 'has_shareholder',
      former: false,
    });
  });

  it('drops a path whose terminal is a bare id — nothing is invented', () => {
    const body = { data: [{ path: [{ field: 'has_shareholder', entity: 'Y' }], target: 'Y' }] };
    expect(parseTypedOwnerEdges(body, ROOT)).toEqual([]);
  });

  it('drops the root appearing as its own terminal', () => {
    const body = {
      data: [{ path: [{ field: 'has_shareholder', entity: { id: ROOT } }], target: { id: ROOT } }],
    };
    expect(parseTypedOwnerEdges(body, ROOT)).toEqual([]);
  });

  it('drops a path that names no field', () => {
    const body = {
      data: [{ path: [{ entity: { id: 'X', label: 'X' } }], target: { id: 'X', label: 'X' } }],
    };
    expect(parseTypedOwnerEdges(body, ROOT)).toEqual([]);
  });

  /**
   * **The record id, dates and shares off the path's own relationships
   * group** (PR #19 review item P3). Without a `sourceRecordId`,
   * `storeRelationships`' unique key `(from, to, type, source_record_id)`
   * treats a re-sighting of an already-stored edge as a NEW row — Postgres
   * does not treat two NULLs as equal for a unique constraint, so every
   * typed read of the same owner duplicated it. Shaped like a group entry
   * `traversalPathRelationshipsSchema` projects, one `values[]` entry per
   * occurrence, the same shape `path[].relationships` carries on the
   * Corporate family read.
   */
  it('carries the record id, dates and shares off the path relationships group', () => {
    const body = {
      data: [
        {
          path: [
            {
              field: 'has_shareholder',
              entity: { id: 'PARENT', label: 'Parent Co', type: 'company' },
              relationships: {
                has_shareholder: {
                  values: [
                    {
                      record: 'parent-rec-1',
                      from_date: '2020-01-01',
                      to_date: null,
                      attributes: { shares: [{ percentage: 60 }] },
                    },
                  ],
                },
              },
            },
          ],
          target: { id: 'PARENT', label: 'Parent Co', type: 'company' },
        },
      ],
    };
    const edges = parseTypedOwnerEdges(body, ROOT);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceRecordId: 'parent-rec-1',
      startDate: '2020-01-01',
      endDate: null,
      attributes: { shares: [{ percentage: 60 }] },
    });
  });
});

describe.skipIf(!up)(
  `storeRelationships takes the minimum hop depth on conflict (needs: ${START_TEST_DB_HINT})`,
  () => {
    const FROM = 'store-relationships-from';
    const TO = 'store-relationships-to';

    const edge = (): ParsedEdge => ({
      subjectId: FROM,
      targetId: TO,
      targetLabel: 'TO CO',
      targetType: 'company',
      relationshipType: 'has_shareholder',
      former: false,
      startDate: null,
      endDate: null,
      sourceRecordId: 'rec-1',
      attributes: null,
      targetEntity: { id: TO, label: 'TO CO' },
    });

    const hopDepthOf = async () => {
      const [row] = await testSql()`
        SELECT hop_depth FROM entity_relationship
        WHERE from_entity_id = ${FROM} AND to_entity_id = ${TO} AND relationship_type = 'has_shareholder'
      `;
      return row?.hop_depth as number | undefined;
    };

    afterAll(async () => {
      if (!up) return;
      await testSql()`DELETE FROM entity_relationship WHERE from_entity_id = ${FROM}`;
      await testSql()`DELETE FROM entity WHERE id IN (${FROM}, ${TO})`;
    });

    it('keeps the minimum hop depth seen so far, in either direction', async () => {
      const db = await getTestDb();
      await testSql()`DELETE FROM entity_relationship WHERE from_entity_id = ${FROM}`;
      await testSql()`DELETE FROM entity WHERE id IN (${FROM}, ${TO})`;
      await db.insert(t.entity).values({ id: FROM, label: 'FROM CO' }).onConflictDoNothing();

      // Depth 3, then depth 1 — the schema comment's own example.
      await storeRelationships(db, [edge()], undefined, { hopDepth: 3 });
      expect(await hopDepthOf()).toBe(3);
      await storeRelationships(db, [edge()], undefined, { hopDepth: 1 });
      expect(await hopDepthOf()).toBe(1);

      // Then depth 2 — the minimum stays 1, a later, worse sighting does not
      // move it back out.
      await storeRelationships(db, [edge()], undefined, { hopDepth: 2 });
      expect(await hopDepthOf()).toBe(1);
    });
  },
);

describe.skipIf(!up)(`the typed owner-edge read (needs: ${START_TEST_DB_HINT})`, () => {
  const ROOT_ID = 'owner-edges-fixture-root';
  const KNOWN_PARENT_ID = 'owner-edges-fixture-known-parent';
  const RECOVERED_PARENT_ID = 'owner-edges-fixture-recovered-parent';

  /**
   * Shaped like a real `getEntity` body: `relationship_count` says two
   * `has_shareholder` edges exist, but a trade-swamped window carries only
   * one of them (SPEC §16.6) — the same measured shape as the Yazaki entity
   * payload in `tests/fixtures/resolve/agree-r1.json`, with the count turned
   * up so the gap this ticket fixes actually fires.
   */
  const ownPayload: SayariEntity = {
    id: ROOT_ID,
    label: 'FIXTURE SUBJECT CO',
    relationship_count: { has_shareholder: 2, notify_party_of: 5000 },
    relationships: {
      data: [
        {
          former: false,
          target: { id: KNOWN_PARENT_ID, label: 'Known Parent Ltd', type: 'company', risk: {} },
          types: {
            has_shareholder: [
              {
                former: false,
                record: 'rec-known',
                attributes: { shares: [{ percentage: 51 }] },
                acquisitionDate: '2020-01-01',
              },
            ],
          },
        },
      ],
    },
  } as unknown as SayariEntity;

  /** The hand-built typed traversal response — shaped like `tests/fixtures/enrich/yazaki.json`'s ownership paths. */
  const typedTraversalBody = {
    data: [
      {
        path: [{ field: 'has_shareholder', entity: { id: RECOVERED_PARENT_ID } }],
        target: {
          id: RECOVERED_PARENT_ID,
          label: 'Recovered Parent Ltd',
          type: 'company',
          risk: { exports_ilab_forced_labor: { level: 'high' } },
        },
      },
    ],
  };

  afterAll(async () => {
    if (!up) return;
    await testSql()`DELETE FROM entity_relationship`;
    await testSql()`DELETE FROM entity WHERE id IN (${ROOT_ID}, ${KNOWN_PARENT_ID}, ${RECOVERED_PARENT_ID})`;
    await testSql()`DELETE FROM enrichment WHERE subject_key = ${ROOT_ID}`;
    await closeTestDb();
  });

  it('reads the missing owner with a typed traversal when relationship_count shows a gap', async () => {
    const db = await getTestDb();
    await resetDerived(db);
    // The root already exists, the way it always does by the time `enrich`
    // reaches this read — the resolve Job stored it when the Match settled.
    await db.insert(t.entity).values({ id: ROOT_ID, label: 'FIXTURE SUBJECT CO' });

    let requested: unknown;
    const ctx: EnrichContext = {
      db,
      upstream: {
        sayari: {
          traversal: async (params: unknown) => {
            requested = params;
            const [payload] = await testSql()`
              INSERT INTO upstream_response (source, endpoint, params_hash, params, body, body_hash, via)
              VALUES ('sayari', 'traversal.traversal', 'owner-edges-fixture', '{}'::jsonb, '{}'::jsonb, 'owner-edges-fixture', 'sdk')
              RETURNING id`;
            return {
              data: typedTraversalBody,
              cacheHit: false,
              via: 'sdk' as const,
              fetchedAt: new Date(),
              upstreamResponseId: payload!.id as string,
              bodyHash: 'owner-edges-fixture',
            };
          },
        },
      } as never,
      jobId: undefined,
    };

    const { owners, gapCoverage } = await readOwnerEdges(ctx, {
      entityId: ROOT_ID,
      entity: ownPayload,
    });

    // Asked for exactly the type the window was short on.
    expect(requested).toMatchObject({
      id: ROOT_ID,
      maxDepth: 1,
      relationships: ['has_shareholder'],
    });

    // Both owners are present — the window's own and the recovered one — and
    // neither crowds out the other.
    expect(owners.map((o) => o.entityId).sort()).toEqual(
      [KNOWN_PARENT_ID, RECOVERED_PARENT_ID].sort(),
    );
    const recovered = owners.find((o) => o.entityId === RECOVERED_PARENT_ID);
    expect(recovered?.riskFactors.map((f) => f.name)).toContain('exports_ilab_forced_labor');

    // The gap-fill traversal answered, so the owner set is complete.
    expect(gapCoverage).toBe('complete');

    // The recovered edge is stored, at hop depth 1, discoverable the same way
    // as any other edge.
    const stored = await db.query.entityRelationship.findFirst({
      where: and(
        eq(t.entityRelationship.fromEntityId, ROOT_ID),
        eq(t.entityRelationship.toEntityId, RECOVERED_PARENT_ID),
      ),
    });
    expect(stored).toMatchObject({ relationshipType: 'has_shareholder', hopDepth: 1 });

    // And the read itself is a citable Enrichment, under its own source.
    const enrichmentRow = await db.query.enrichment.findFirst({
      where: and(
        eq(t.enrichment.subjectKey, ROOT_ID),
        eq(t.enrichment.source, 'sayari_owner_edges'),
      ),
    });
    expect(enrichmentRow).toBeTruthy();
  });

  /**
   * **The typed read re-echoing an owner the window already stored must not
   * duplicate it** (PR #19 review item P3). `ownerEdgeGap` fires per TYPE,
   * not per target — so a window short one `has_shareholder` edge triggers a
   * traversal that legitimately answers with every `has_shareholder` edge it
   * finds, `KNOWN_PARENT_ID` among them, even though the window already held
   * that one. Before the fix this produced a second `entity_relationship`
   * row for it (no record id meant the unique key never caught the repeat)
   * and a duplicated "Current owners" row on the Entity page.
   */
  it('does not duplicate a stored owner the typed read re-echoes', async () => {
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: ROOT_ID, label: 'FIXTURE SUBJECT CO' });

    const reEchoingBody = {
      data: [
        // Genuinely new.
        {
          path: [{ field: 'has_shareholder', entity: { id: RECOVERED_PARENT_ID } }],
          target: {
            id: RECOVERED_PARENT_ID,
            label: 'Recovered Parent Ltd',
            type: 'company',
            risk: {},
          },
        },
        // The window's own KNOWN_PARENT_ID, re-returned by the type-filtered
        // traversal because the gap is per TYPE, not per target.
        {
          path: [{ field: 'has_shareholder', entity: { id: KNOWN_PARENT_ID } }],
          target: { id: KNOWN_PARENT_ID, label: 'Known Parent Ltd', type: 'company', risk: {} },
        },
      ],
    };

    const ctx: EnrichContext = {
      db,
      upstream: {
        sayari: {
          traversal: async () => {
            const [payload] = await testSql()`
              INSERT INTO upstream_response (source, endpoint, params_hash, params, body, body_hash, via)
              VALUES ('sayari', 'traversal.traversal', 'owner-edges-fixture-2', '{}'::jsonb, '{}'::jsonb, 'owner-edges-fixture-2', 'sdk')
              RETURNING id`;
            return {
              data: reEchoingBody,
              cacheHit: false,
              via: 'sdk' as const,
              fetchedAt: new Date(),
              upstreamResponseId: payload!.id as string,
              bodyHash: 'owner-edges-fixture-2',
            };
          },
        },
      } as never,
      jobId: undefined,
    };

    const { owners } = await readOwnerEdges(ctx, { entityId: ROOT_ID, entity: ownPayload });

    // One rendered owner per company — the re-echoed KNOWN_PARENT_ID must not
    // appear twice.
    expect(owners.filter((o) => o.entityId === KNOWN_PARENT_ID)).toHaveLength(1);

    // And one stored row, not two.
    const stored = await db.query.entityRelationship.findMany({
      where: and(
        eq(t.entityRelationship.fromEntityId, ROOT_ID),
        eq(t.entityRelationship.toEntityId, KNOWN_PARENT_ID),
      ),
    });
    expect(stored).toHaveLength(1);
  });

  it('asks for nothing extra when the window already accounts for every claimed owner edge', async () => {
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: ROOT_ID, label: 'FIXTURE SUBJECT CO' });

    let called = false;
    const ctx: EnrichContext = {
      db,
      upstream: {
        sayari: {
          traversal: async () => {
            called = true;
            throw new Error('should not have been called — no relationship_count gap');
          },
        },
      } as never,
      jobId: undefined,
    };

    const completePayload: SayariEntity = {
      id: ROOT_ID,
      label: 'FIXTURE SUBJECT CO',
      relationship_count: { has_shareholder: 1 },
      relationships: {
        data: [
          {
            former: false,
            target: { id: KNOWN_PARENT_ID, label: 'Known Parent Ltd', type: 'company', risk: {} },
            types: { has_shareholder: [{ former: false, record: 'rec-known' }] },
          },
        ],
      },
    } as unknown as SayariEntity;

    const { owners, gapCoverage } = await readOwnerEdges(ctx, {
      entityId: ROOT_ID,
      entity: completePayload,
    });
    expect(called).toBe(false);
    expect(owners.map((o) => o.entityId)).toEqual([KNOWN_PARENT_ID]);
    // No gap was ever detected, so there was nothing to fill — 'complete' by
    // construction, the same as a gap that was detected and filled.
    expect(gapCoverage).toBe('complete');
  });

  /**
   * **A failed gap-fill traversal must not read as a complete owner set.**
   * A Sayari 5xx or timeout that survives `call()`'s own retries during the
   * gap-fill read falls back to the window's own edges — correctly, since
   * inventing owners would be worse — but the fallback must be recorded, not
   * silent. The window almost always carries at least one owner edge
   * already, so `owners` comes back non-empty here and indistinguishable
   * from a genuinely complete read unless something else says otherwise.
   * `gapCoverage` is that something else: it names the failure independently
   * of how many owners `owners` ends up holding.
   */
  it("marks gapCoverage 'unknown' when the gap-fill traversal fails, keeping the window's own edges", async () => {
    const db = await getTestDb();
    await resetDerived(db);
    await db.insert(t.entity).values({ id: ROOT_ID, label: 'FIXTURE SUBJECT CO' });

    const ctx: EnrichContext = {
      db,
      upstream: {
        sayari: {
          traversal: async () => {
            throw Object.assign(new Error('upstream 503'), { statusCode: 503 });
          },
        },
      } as never,
      jobId: undefined,
    };

    const { owners, gapCoverage } = await readOwnerEdges(ctx, {
      entityId: ROOT_ID,
      entity: ownPayload,
    });

    // The window's own edge survives the failed gap-fill — falling back is
    // still the right call, it just must not look complete.
    expect(owners.map((o) => o.entityId)).toEqual([KNOWN_PARENT_ID]);
    expect(gapCoverage).toBe('unknown');
  });
});
