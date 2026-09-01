import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as t from '@/db/schema';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { buildAssessableSupplier } from '../support/pipeline';

/**
 * **Ownership is read from the matched company's OWN payload, and from no
 * other** (SPEC §9.3, BUILD-NOTES finding 100).
 *
 * ## What this is guarding against, stated as the bug it was
 *
 * `enrichSupplier` used to find that payload like this:
 *
 * ```ts
 * db.query.upstreamResponse.findFirst({
 *   where: and(eq(endpoint, 'entity.getEntity'), eq(source, 'sayari')),
 * })
 * ```
 *
 * — no filter on *which* entity and no order. The resolve Job caches one body
 * per candidate it considered, so this Supplier leaves **seven** of them, all
 * written by `seedUpstream` in a single statement and therefore all carrying
 * the same `fetched_at`. Whichever row Postgres reached became "the entity",
 * while the `entityId` handed alongside it stayed the matched one — so
 * `parseRelationships` attributed another company's relationships to this
 * company and `storeRelationships` wrote them down.
 *
 * On this fixture that meant `YAZAKI INDIA PRIVATE LIMITED`'s relationship set
 * stored as the Japanese parent's, including `ssRv0fzea7pcW0r_8IgTug`, a
 * company the parent's own payload does not mention anywhere.
 *
 * ## Why the replay suite could not catch it, and this can
 *
 * It surfaced as `assess/published-with-objections` missing at turn 3 — the
 * entity rows those edges upsert are what `get_entity` hands the model — and
 * for three sessions it read as fixture drift. A replay fixture cannot guard
 * this, because a recording simply freezes whichever way the coin landed: the
 * committed fixture encoded the **wrong** pick, so the suite was green exactly
 * when the app repeated the bug and red when it did not.
 *
 * This asserts the invariant instead of a recorded outcome, and it runs
 * offline in under a second.
 */

const ROSTER_NAME = 'Yazaki';

describe('enrich reads ownership from the matched entity, not from any cached body', () => {
  it("writes only edges the matched company's own payload states", async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    await resetDerived(db);
    const { supplierId } = await buildAssessableSupplier(db, ROSTER_NAME);

    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplierId) });
    expect(match?.entityId, 'the pipeline should have settled a Match').toBeTruthy();
    const matchedId = match!.entityId!;

    /**
     * **The ambiguity has to still be there, or this test proves nothing.**
     *
     * The bug needed more than one cached `entity.getEntity` body to choose
     * wrongly between. If a future fixture ever caches only the matched one,
     * every assertion below passes for a reason that has nothing to do with
     * the fix — so the precondition is asserted rather than assumed.
     */
    const cached = await db
      .select({ id: sql<string>`${t.upstreamResponse.body}->>'id'` })
      .from(t.upstreamResponse)
      .where(
        and(
          eq(t.upstreamResponse.source, 'sayari'),
          eq(t.upstreamResponse.endpoint, 'entity.getEntity'),
        ),
      );
    expect(
      cached.length,
      'the seeded fixtures should cache several candidate bodies, or there is nothing to choose wrongly between',
    ).toBeGreaterThan(1);
    expect(cached.map((row) => row.id)).toContain(matchedId);

    const own = await db.query.upstreamResponse.findFirst({
      where: and(
        eq(t.upstreamResponse.source, 'sayari'),
        eq(t.upstreamResponse.endpoint, 'entity.getEntity'),
        sql`${t.upstreamResponse.body}->>'id' = ${matchedId}`,
      ),
    });
    expect(own, `no cached body for the matched entity ${matchedId}`).toBeTruthy();
    const ownPayload = JSON.stringify(own!.body);

    const edges = await db.select().from(t.entityRelationship);
    expect(edges.length, "enrich should have written the matched company's edges").toBeGreaterThan(
      0,
    );

    // Every edge is anchored on the matched company.
    expect([...new Set(edges.map((edge) => edge.fromEntityId))]).toEqual([matchedId]);

    /**
     * And every target is a company the matched company's own payload names.
     * A substring test over the raw body is deliberately crude: it is the
     * weakest claim that still fails on the bug, and it cannot be satisfied by
     * the projection agreeing with itself.
     */
    const foreign = edges
      .map((edge) => edge.toEntityId)
      .filter((targetId) => !ownPayload.includes(targetId));
    expect(
      [...new Set(foreign)],
      "these targets appear in no part of the matched company's own payload",
    ).toEqual([]);
  });
});
