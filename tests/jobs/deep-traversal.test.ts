import { describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import * as t from '@/db/schema';
import { DEEP_TRAVERSAL_MAX_HOPS, DEEP_TRAVERSAL_MAX_NODES } from '@/config/constants';
import { loadFixture } from '@/fixtures/load';
import { replayUpstream, seedUpstream } from '@/fixtures/replay-upstream';
import { runDeepTraversal } from '@/jobs/traverse';
import { getTestDb, testDatabaseIsUp, type TestDb } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { buildAssessableSupplier, openJob } from '../support/pipeline';

/**
 * The Deep Traversal, replayed against the bodies one real walk read
 * (SPEC §8.5, §19.1; network spec §6, ticket 02).
 *
 * ## What it asserts, and what it deliberately does not
 *
 * **Invariants, not a member count.** A recording freezes one afternoon's
 * answer, and the Sayari graph moves: Yazaki's family was 17 members when §8.1
 * was measured and 50 on the page recorded for `enrich/yazaki`. A test that
 * pinned the number would go red for a reason that is not a bug in this app,
 * and — worse — would be *green* for a walk that had silently stopped following
 * the cursor as long as the count happened to match. So what is checked is what
 * must be true of any walk: every Path anchored on the root, no hop past the
 * cap, no more Paths than the node cap, and truncation recorded whenever the
 * walk stopped anywhere but the end of the graph.
 *
 * ## Why it starts from an enriched Supplier
 *
 * `buildAssessableSupplier` runs resolve and enrich offline, so the Profile
 * arrives with its **one-hop Corporate family already written** as `graph_path`
 * rows of `kind: 'family'` — which is the state the second and third tests
 * need and the state the recording was made from. A Deep Traversal that
 * reaches a subsidiary downward writes into the **same `kind: 'family'`
 * rows**, distinguished by `discovered_by_job`; only an upward find is
 * `kind: 'deep_traversal'` — so the interesting question was never *does it
 * write rows* but *what does it do to the rows that were already there*.
 */

const ROSTER_NAME = 'Yazaki';
const FIXTURE = 'traverse/yazaki';

/**
 * resolve → enrich → a traverse Job, all offline: the recorded fixture answers
 * every upstream read, and the keyless wrapper throws by name on anything it
 * did not record.
 */
async function arrange(db: TestDb) {
  await resetDerived(db);
  const { supplierId, runId } = await buildAssessableSupplier(db, ROSTER_NAME);
  await seedUpstream(db, await loadFixture(FIXTURE));

  const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplierId) });
  const entityId = match?.entityId;
  if (!entityId) throw new Error(`"${ROSTER_NAME}" should have a settled Match by now`);

  return { supplierId, runId, entityId };
}

/** Every Path this walk could have written — downward `family`, upward `deep_traversal`. */
const WALK_KINDS = ['family', 'deep_traversal'] as const;

describe('a Deep Traversal over the bodies one real walk read', () => {
  it('holds its caps, anchors every terminal on the root, and records truncation', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const { runId, entityId } = await arrange(db);

    const jobId = await openJob(db, runId, 'traverse', entityId);
    const walk = await runDeepTraversal(
      { db, upstream: replayUpstream(db, runId, jobId), jobId },
      { entityId },
    );

    const rows = await db
      .select()
      .from(t.graphPath)
      .where(and(eq(t.graphPath.rootEntityId, entityId), inArray(t.graphPath.kind, WALK_KINDS)));

    // Every Path hangs off the Profile the walk was asked about. A row
    // anchored anywhere else would be another company's Network in this one's.
    expect(rows.length).toBeGreaterThan(0);
    expect([...new Set(rows.map((row) => row.rootEntityId))]).toEqual([entityId]);

    // A `family` row is always `down`; a `deep_traversal` row this walk wrote
    // is always `up` — the invariant the schema's own CHECK enforces for the
    // first and this file's own write-side rule enforces for the second.
    for (const row of rows) {
      if (row.kind === 'family') expect(row.direction).toBe('down');
    }

    // Both caps, on the stored rows rather than on the walk's own arithmetic.
    expect(rows.length).toBeLessThanOrEqual(DEEP_TRAVERSAL_MAX_NODES);
    for (const row of rows) {
      expect(row.hopDepth).toBeGreaterThanOrEqual(1);
      expect(row.hopDepth).toBeLessThanOrEqual(DEEP_TRAVERSAL_MAX_HOPS);
    }

    // A walk that stopped anywhere but the end of the graph says so, and one
    // that did not is allowed to claim a complete Network. `truncated` travels
    // on the rows, because that is where the badge reads it.
    const deepRows = rows.filter((row) => row.discoveredByJob === jobId);
    expect(deepRows.length).toBeGreaterThan(0);
    expect([...new Set(deepRows.map((row) => row.truncated))]).toEqual([
      walk.stoppedBy !== 'exhausted',
    ]);

    // `reachable` is the API's own count, and only when it says it finished.
    if (walk.reachable != null) {
      expect(walk.reachable).toBeGreaterThanOrEqual(walk.explored);
    }

    // Every terminal is a company this app now holds a row for, so a
    // Citation on one resolves to a live local entity rather than to a name
    // in a payload.
    const entities = await db.select({ id: t.entity.id }).from(t.entity);
    const known = new Set(entities.map((row) => row.id));
    expect(rows.filter((row) => !known.has(row.terminalEntityId))).toEqual([]);
  });

  it('is a dated, citable fact: every Path cites an Enrichment of this Job', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const { runId, entityId } = await arrange(db);

    const jobId = await openJob(db, runId, 'traverse', entityId);
    await runDeepTraversal({ db, upstream: replayUpstream(db, runId, jobId), jobId }, { entityId });

    const enrichments = await db
      .select()
      .from(t.enrichment)
      .where(
        and(
          eq(t.enrichment.source, 'sayari_deep_traversal'),
          eq(t.enrichment.subjectKey, entityId),
        ),
      );
    expect(enrichments.length).toBeGreaterThan(0);
    expect([...new Set(enrichments.map((row) => row.jobId))]).toEqual([jobId]);

    /**
     * **One Enrichment per page, and each Path cites the page it arrived on.**
     * An Enrichment points at the raw body it was projected from, so a single
     * row covering a five-page walk would leave four fifths of these Paths
     * citing a body they do not appear in.
     */
    const rows = await db
      .select()
      .from(t.graphPath)
      .where(
        and(eq(t.graphPath.rootEntityId, entityId), eq(t.graphPath.discoveredByJob, jobId)),
      );
    const ids = new Set(enrichments.map((row) => row.id));
    expect(rows.filter((row) => !ids.has(row.enrichmentId))).toEqual([]);

    /**
     * Every hop this walk could resolve to an edge is a real, citable
     * `entity_relationship` row — `graph_path.edge_ids` is a list of ids into
     * that table, not a copy of the raw path (network spec §6).
     */
    const edgeIds = rows.flatMap((row) => row.edgeIds as string[]);
    if (edgeIds.length > 0) {
      const edges = await db
        .select({ id: t.entityRelationship.id })
        .from(t.entityRelationship)
        .where(inArray(t.entityRelationship.id, edgeIds));
      expect(new Set(edges.map((e) => e.id))).toEqual(new Set(edgeIds));
    }
  });

  it('adds deeper terminals without taking the earlier rows’ provenance', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const { runId, entityId } = await arrange(db);

    /**
     * The one-hop family as `enrich` left it: which companies, when each was
     * first seen, and the fact that no Job discovered them — the automatic
     * read did, so `discovered_by_job` is null and must stay null.
     */
    const before = await db
      .select()
      .from(t.graphPath)
      .where(and(eq(t.graphPath.rootEntityId, entityId), eq(t.graphPath.kind, 'family')));
    expect(before.length, 'the pipeline should have written a one-hop family').toBeGreaterThan(0);
    expect([...new Set(before.map((row) => row.discoveredByJob))]).toEqual([null]);
    const wasThere = new Map(before.map((row) => [row.terminalEntityId, row]));

    const jobId = await openJob(db, runId, 'traverse', entityId);
    await runDeepTraversal({ db, upstream: replayUpstream(db, runId, jobId), jobId }, { entityId });

    const after = await db
      .select()
      .from(t.graphPath)
      .where(and(eq(t.graphPath.rootEntityId, entityId), eq(t.graphPath.kind, 'family')));

    // The walk reads past the fifty-node first page the automatic read stops
    // at, so it can only add.
    expect(after.length).toBeGreaterThan(before.length);
    for (const row of before) {
      expect(after.map((r) => r.terminalEntityId)).toContain(row.terminalEntityId);
    }

    for (const row of after) {
      const earlier = wasThere.get(row.terminalEntityId);
      if (!earlier) continue;
      /**
       * **Provenance is not re-stamped by a read that did not discover it.**
       * `first_seen_at` is what the *new evidence* chip is computed from
       * (SPEC §12.1), so re-stamping it would light the chip on every member of
       * a family the app has held for weeks; and `discovered_by_job` is the
       * column that tells the two reads apart, so a Deep Traversal claiming a
       * member the automatic read already had would erase the distinction the
       * column exists for.
       */
      expect(row.firstSeenAt.getTime()).toBe(earlier.firstSeenAt.getTime());
      expect(row.discoveredByJob).toBeNull();
      // And a member reachable in one hop stays one hop away, whichever walk
      // arrives at it next and however long its path was this time.
      expect(row.hopDepth).toBeLessThanOrEqual(earlier.hopDepth);
    }

    // The rows the deep walk genuinely found downward are marked as its own —
    // still `kind: 'family'`, since a downward find is a Family member
    // whichever read reached it.
    const added = after.filter((row) => !wasThere.has(row.terminalEntityId));
    expect(added.length).toBeGreaterThan(0);
    expect([...new Set(added.map((row) => row.discoveredByJob))]).toEqual([jobId]);
  });
});
