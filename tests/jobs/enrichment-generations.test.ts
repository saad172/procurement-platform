import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { latestCountryIndicators } from '@/db/queries/enrichments';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { buildAssessableSupplier, reEnrichSupplier } from '../support/pipeline';

/**
 * **A second Enrichment of the same Supplier may not move a Criterion when the
 * upstream body has not moved** (SPEC §7.2, §9.1).
 *
 * ## The bug, stated as it was
 *
 * `enrichNegativeNews` inserted `news_item` rows with a random id and no
 * conflict target, and `assembleScoringInput` then read **every** `news_item`
 * for the entity — with no filter on which Enrichment fetched them. So the
 * second enrichment of a Profile counted every article twice: nine Yazaki
 * articles read as eighteen, and the flag-weighted figure behind the media
 * signal Criterion doubled with them. A Score fell because someone had clicked
 * *Run* twice.
 *
 * `country_indicator` had the same shape and a worse symptom, because the read
 * carried **no `ORDER BY` at all** and `countryResilience` folds the rows into
 * a `Map` by indicator code: after a re-enrich, which generation's value and
 * year reached the Score was decided by Postgres row order.
 *
 * ## Why this is asserted rather than recorded
 *
 * A replay fixture cannot guard it. A recording freezes whatever the run did,
 * so a fixture recorded from a single enrichment says nothing about the second
 * one, and a fixture recorded from a doubled count would make the suite green
 * exactly when the app repeats the bug. This runs the enrich Job twice against
 * the same cached bodies and asserts the two runs agree — offline, spending
 * nothing, in about a second.
 */

const ROSTER_NAME = 'Yazaki';

describe('a re-enrichment cannot change what the upstream body said', () => {
  it('leaves the article count and the media raw inputs identical', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    await resetDerived(db);
    const built = await buildAssessableSupplier(db, ROSTER_NAME);

    const match = await db.query.match.findFirst({
      where: eq(t.match.supplierId, built.supplierId),
    });
    const entityId = match?.entityId;
    expect(entityId, 'the pipeline should have settled a Match').toBeTruthy();

    const first = await mediaValue(db, built.supplierId);
    const firstArticles = await newsRowCount(db, entityId!);
    expect(
      firstArticles,
      'the recorded negativeNews body should carry articles, or nothing here can double',
    ).toBeGreaterThan(0);
    expect(first.rawInputs.articleCount).toBe(firstArticles);

    await reEnrichSupplier(db, built);

    /**
     * **The second generation has to exist, or this test proves nothing.**
     *
     * The doubling needed two Enrichments of one subject to read at once. If a
     * future change made re-enrichment a no-op — a cache short-circuit, say —
     * every assertion below would pass for a reason that has nothing to do
     * with the fix, so the precondition is asserted rather than assumed.
     */
    const generations = await db
      .select({ generation: t.enrichment.generation })
      .from(t.enrichment)
      .where(
        and(
          eq(t.enrichment.source, 'sayari_negative_news'),
          eq(t.enrichment.subjectKey, entityId!),
        ),
      );
    expect(generations.map((row) => row.generation).sort()).toEqual([0, 1]);
    expect(
      await newsRowCount(db, entityId!),
      'each generation keeps its own rows — that is what append-only means',
    ).toBe(firstArticles * 2);

    const second = await mediaValue(db, built.supplierId);
    expect(second.rawInputs).toEqual(first.rawInputs);
    expect(second.value).toBe(first.value);
  });

  it('leaves the country resilience raw inputs identical', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    await resetDerived(db);
    const built = await buildAssessableSupplier(db, ROSTER_NAME);
    const first = await currentCriterion(db, built.supplierId, 'country_resilience');

    await reEnrichSupplier(db, built);

    const second = await currentCriterion(db, built.supplierId, 'country_resilience');
    expect(second.rawInputs).toEqual(first.rawInputs);
    expect(second.value).toBe(first.value);
  });
});

/**
 * The World Bank read, on two generations that disagree.
 *
 * Written straight into the tables rather than through the Job, because the
 * fixture holds one body per indicator and the case worth pinning is two
 * generations carrying **different** values — the case where an order that is
 * not total silently picks the older figure.
 */
describe('latestCountryIndicators takes the newer generation', () => {
  const COUNTRY = 'ZZT';
  const CODE = 'LP.LPI.OVRL.XQ';

  it('returns the newest generation whichever order the rows were inserted in', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);

    const [response] = await db
      .insert(t.upstreamResponse)
      .values({
        source: 'worldbank',
        endpoint: 'v2.indicator',
        paramsHash: `test:${COUNTRY}`,
        params: { country: COUNTRY } as never,
        body: {} as never,
        bodyHash: 'test',
        via: 'raw',
      })
      .returning({ id: t.upstreamResponse.id });

    // Generation 1 first, generation 0 second: insertion order is the thing
    // this must not depend on, so it is deliberately the wrong way round. Both
    // carry the SAME `fetched_at`, which is what a warm cache produces and
    // what makes a timestamp useless as the ordering key.
    const fetchedAt = new Date('2026-01-01T00:00:00Z');
    for (const [generation, value, year] of [
      [1, 4.05, 2023],
      [0, 3.11, 2018],
    ] as const) {
      const [enrichment] = await db
        .insert(t.enrichment)
        .values({
          source: 'world_bank',
          subjectKind: 'country',
          subjectKey: `${COUNTRY}:${CODE}`,
          requestParams: { country: COUNTRY, indicator: CODE } as never,
          generation,
          upstreamResponseId: response!.id,
          fetchedAt,
        })
        .returning({ id: t.enrichment.id });
      await db.insert(t.countryIndicator).values({
        enrichmentId: enrichment!.id,
        country: COUNTRY,
        indicatorCode: CODE,
        indicatorLabel: 'LPI overall',
        year,
        value,
      });
    }

    const rows = await latestCountryIndicators(db, COUNTRY);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(4.05);
    expect(rows[0]!.year, 'the year travels with the value it belongs to').toBe(2023);
  });
});

async function newsRowCount(db: Awaited<ReturnType<typeof getTestDb>>, entityId: string) {
  const rows = await db.select().from(t.newsItem).where(eq(t.newsItem.entityId, entityId));
  return rows.length;
}

async function currentCriterion(
  db: Awaited<ReturnType<typeof getTestDb>>,
  supplierId: string,
  key: string,
) {
  const row = await db.query.criterionValue.findFirst({
    where: and(
      eq(t.criterionValue.supplierId, supplierId),
      eq(t.criterionValue.criterionKey, key),
      eq(t.criterionValue.isCurrent, true),
    ),
  });
  if (!row) throw new Error(`no current ${key} value for ${supplierId}`);
  return { value: row.value, rawInputs: row.rawInputs as Record<string, unknown> };
}

async function mediaValue(db: Awaited<ReturnType<typeof getTestDb>>, supplierId: string) {
  const row = await currentCriterion(db, supplierId, 'media_signal');
  return {
    value: row.value,
    rawInputs: row.rawInputs as { articleCount: number; weightedCount: number },
  };
}
