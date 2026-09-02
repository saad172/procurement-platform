import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
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
 * (SPEC §8.5, §19.1).
 *
 * ## What it asserts, and what it deliberately does not
 *
 * **Invariants, not a member count.** A recording freezes one afternoon's
 * answer, and the Sayari graph moves: Yazaki's family was 17 members when §8.1
 * was measured and 50 on the page recorded for `enrich/yazaki`. A test that
 * pinned the number would go red for a reason that is not a bug in this app,
 * and — worse — would be *green* for a walk that had silently stopped following
 * the cursor as long as the count happened to match. So what is checked is what
 * must be true of any walk: every member anchored on the root, no hop past the
 * cap, no more members than the node cap, and truncation recorded whenever the
 * walk stopped anywhere but the end of the graph.
 *
 * ## Why it starts from an enriched Supplier
 *
 * `buildAssessableSupplier` runs resolve and enrich offline, so the Profile
 * arrives with its **one-hop Corporate family already written** — which is the
 * state the second test needs and the state the recording was made from. SPEC
 * §8.5: a Deep Traversal that reaches a subsidiary writes into the same
 * `family_member` table, so the interesting question was never *does it write
 * rows* but *what does it do to the rows that were already there*.
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

describe('a Deep Traversal over the bodies one real walk read', () => {
  it('holds its caps, anchors every member on the root, and records truncation', async () => {
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
      .from(t.familyMember)
      .where(eq(t.familyMember.rootEntityId, entityId));

    // Every member hangs off the Profile the walk was asked about. A member
    // anchored anywhere else would be another company's family in this one's.
    expect(rows.length).toBeGreaterThan(0);
    expect([...new Set(rows.map((row) => row.rootEntityId))]).toEqual([entityId]);

    // Both caps, on the stored rows rather than on the walk's own arithmetic.
    expect(rows.length).toBeLessThanOrEqual(DEEP_TRAVERSAL_MAX_NODES);
    for (const row of rows) {
      expect(row.hopDepth).toBeGreaterThanOrEqual(1);
      expect(row.hopDepth).toBeLessThanOrEqual(DEEP_TRAVERSAL_MAX_HOPS);
    }

    // A walk that stopped anywhere but the end of the graph says so, and one
    // that did not is allowed to claim a complete family. `truncated` travels
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

    // Every member is a company this app now holds a row for, so a Citation on
    // one resolves to a live local entity rather than to a name in a payload.
    const entities = await db.select({ id: t.entity.id }).from(t.entity);
    const known = new Set(entities.map((row) => row.id));
    expect(rows.filter((row) => !known.has(row.memberEntityId))).toEqual([]);
  });

  it('is a dated, citable fact: every member cites an Enrichment of this Job', async () => {
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
     * **One Enrichment per page, and each member cites the page it arrived on.**
     * An Enrichment points at the raw body it was projected from, so a single
     * row covering a five-page walk would leave four fifths of these members
     * citing a body they do not appear in.
     */
    const rows = await db
      .select()
      .from(t.familyMember)
      .where(
        and(eq(t.familyMember.rootEntityId, entityId), eq(t.familyMember.discoveredByJob, jobId)),
      );
    const ids = new Set(enrichments.map((row) => row.id));
    expect(rows.filter((row) => !ids.has(row.enrichmentId))).toEqual([]);
  });

  it('adds deeper members without taking the earlier rows’ provenance', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const { runId, entityId } = await arrange(db);

    /**
     * The one-hop family as `enrich` left it: which companies, when each was
     * first seen, and the fact that no Job discovered them — the automatic read
     * did, so `discovered_by_job` is null and must stay null.
     */
    const before = await db
      .select()
      .from(t.familyMember)
      .where(eq(t.familyMember.rootEntityId, entityId));
    expect(before.length, 'the pipeline should have written a one-hop family').toBeGreaterThan(0);
    expect([...new Set(before.map((row) => row.discoveredByJob))]).toEqual([null]);
    const wasThere = new Map(before.map((row) => [row.memberEntityId, row]));

    const jobId = await openJob(db, runId, 'traverse', entityId);
    await runDeepTraversal({ db, upstream: replayUpstream(db, runId, jobId), jobId }, { entityId });

    const after = await db
      .select()
      .from(t.familyMember)
      .where(eq(t.familyMember.rootEntityId, entityId));

    // The walk reads past the fifty-node first page the automatic read stops
    // at, so it can only add.
    expect(after.length).toBeGreaterThan(before.length);
    for (const row of before) {
      expect(after.map((r) => r.memberEntityId)).toContain(row.memberEntityId);
    }

    for (const row of after) {
      const earlier = wasThere.get(row.memberEntityId);
      if (!earlier) continue;
      /**
       * **Provenance is not re-stamped by a read that did not discover it.**
       * `first_seen_at` is what the *new evidence* chip is computed from
       * (SPEC §12.1), so re-stamping it would light the chip on every member of
       * a family the app has held for weeks; and `discovered_by_job` is the
       * column SPEC §8.5 uses to tell the two reads apart, so a Deep Traversal
       * claiming a member the automatic read already had would erase the
       * distinction the column exists for.
       */
      expect(row.firstSeenAt.getTime()).toBe(earlier.firstSeenAt.getTime());
      expect(row.discoveredByJob).toBeNull();
      // And a member reachable in one hop stays one hop away, whichever walk
      // arrives at it next and however long its path was this time.
      expect(row.hopDepth).toBeLessThanOrEqual(earlier.hopDepth);
    }

    // The rows the deep walk genuinely found are marked as its own.
    const added = after.filter((row) => !wasThere.has(row.memberEntityId));
    expect(added.length).toBeGreaterThan(0);
    expect([...new Set(added.map((row) => row.discoveredByJob))]).toEqual([jobId]);
  });
});
