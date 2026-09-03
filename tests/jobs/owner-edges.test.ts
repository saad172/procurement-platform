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

    /**
     * **The Corporate family traversal is unambiguous in a way `getEntity` is
     * not.** `traversal.ownership` is keyed by `id` in its own request params
     * (`params_hash`), so there is no cached-body-choosing ambiguity for it —
     * unlike `entity.getEntity`, which the resolve Job fetches once per
     * candidate. Since ticket 02, `enrichFamily` upserts an `entity_relationship`
     * row for every hop of every Path this read returns (network spec §6), so
     * `entity_relationship` now legitimately holds edges anchored on
     * intermediate Path entities, not only on the matched company — those rows
     * are a different, correct fact this test is not about, and the
     * traversal's own cached body is what explains them.
     */
    const ownership = await db.query.upstreamResponse.findFirst({
      where: and(
        eq(t.upstreamResponse.source, 'sayari'),
        eq(t.upstreamResponse.endpoint, 'traversal.ownership'),
        sql`${t.upstreamResponse.params}->>'id' = ${matchedId}`,
      ),
    });
    const ownershipPayload = ownership ? JSON.stringify(ownership.body) : '';

    const edges = await db.select().from(t.entityRelationship);
    expect(edges.length, "enrich should have written the matched company's edges").toBeGreaterThan(
      0,
    );

    // Every edge is anchored either on the matched company itself (the
    // `getEntity` window, `readOwnerEdges`) or on an entity the matched
    // company's own, unambiguously-keyed family traversal names as a Path hop
    // — never on some other cached candidate's payload.
    const misanchored = edges
      .map((edge) => edge.fromEntityId)
      .filter((id) => id !== matchedId && !ownershipPayload.includes(id));
    expect(
      [...new Set(misanchored)],
      "these edges are anchored on an entity neither the matched company nor its own family traversal names",
    ).toEqual([]);

    /**
     * And every target is a company one of the matched company's own,
     * unambiguously-attributed payloads names. A substring test over the raw
     * body is deliberately crude: it is the weakest claim that still fails on
     * the original bug (a wrong candidate's `getEntity` body misattributed as
     * this one's), and it cannot be satisfied by the projection agreeing with
     * itself.
     */
    const foreign = edges
      .map((edge) => edge.toEntityId)
      .filter((targetId) => !ownPayload.includes(targetId) && !ownershipPayload.includes(targetId));
    expect(
      [...new Set(foreign)],
      "these targets appear in no part of the matched company's own payloads",
    ).toEqual([]);
  });
});

/**
 * **Country threading** (finding 107): whatever country the World Bank fetch
 * used is exactly the country `country_resilience` and `tariff_exposure`
 * score, on the same Supplier this file already builds through the real
 * pipeline.
 *
 * Yazaki's roster and Profile both read `JPN`, so this is the **non-diverging**
 * case — `deriveSiteCountry`'s `tests/jobs/site-country.test.ts` covers the
 * `pass`/`fail`/`unavailable`/no-verdict branches directly against the
 * database; `tests/domain/score.test.ts` covers the divergent rendering. What
 * this level adds is the one thing neither of those touches: that the real
 * `enrichSupplier` fan-out fetches and the real Criteria score **the same**
 * country, end to end.
 */
describe('enrich fetches and scores one country, end to end (finding 107)', () => {
  it("country_resilience and the world_bank fetch agree on Yazaki's site country", async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    await resetDerived(db);
    const { supplierId } = await buildAssessableSupplier(db, ROSTER_NAME);

    const countryValue = await db.query.criterionValue.findFirst({
      where: and(
        eq(t.criterionValue.supplierId, supplierId),
        eq(t.criterionValue.criterionKey, 'country_resilience'),
        eq(t.criterionValue.isCurrent, true),
      ),
    });
    expect(countryValue, 'country_resilience should have written a current value').toBeTruthy();
    const rawInputs = countryValue!.rawInputs as { country?: string | null };
    expect(rawInputs.country).toBeTruthy();

    const fetched = await db
      .select({ country: t.countryIndicator.country })
      .from(t.countryIndicator)
      .where(eq(t.countryIndicator.country, rawInputs.country!));
    expect(
      fetched.length,
      `country_resilience scored ${rawInputs.country}, but no world_bank row was fetched for it`,
    ).toBeGreaterThan(0);

    const tariffValue = await db.query.criterionValue.findFirst({
      where: and(
        eq(t.criterionValue.supplierId, supplierId),
        eq(t.criterionValue.criterionKey, 'tariff_exposure'),
        eq(t.criterionValue.isCurrent, true),
      ),
    });
    const tariffRaw = tariffValue!.rawInputs as { originCountry?: string | null };
    expect(tariffRaw.originCountry).toBe(rawInputs.country);
  });
});
