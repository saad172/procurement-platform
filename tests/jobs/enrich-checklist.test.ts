import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { enrichSupplier } from '@/jobs/enrich-supplier';
import { upsertEntity } from '@/jobs/resolve';
import { settleMatch } from '@/domain/match/settle-match';
import { dataConfidence } from '@/domain/score';
import { EXPECTED_ENRICHMENTS } from '@/domain/scoring/anchors';
import { loadFixture } from '@/fixtures/load';
import { replayUpstream, seedUpstream } from '@/fixtures/replay-upstream';
import { getTestDb, testDatabaseIsUp, type TestDb } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { seededProgram } from '../support/seeded-program';
import { openJob } from '../support/pipeline';

/**
 * The data-confidence checklist is **what answered**, not what was asked
 * (SPEC §9.2).
 *
 * The band gates what may be called *clean*, so every item in it is a claim
 * about coverage: `gleif` present because the Profile carried an LEI said the
 * register had confirmed something it had never been asked about.
 *
 * ## Why this settles its Match by hand
 *
 * It is an **enrich** test and nothing here is about resolution, so it seeds
 * the two fixtures' cached bodies and settles on the entity the resolve loop
 * would have chosen — the same move `smoke:enrich` makes. That keeps it
 * independent of the resolve fixture, which is what the rest of the enrich
 * suite is not.
 */

const YAZAKI_ENTITY = 'CX3012yTGIhgMxcZG6hgnA';

describe('the data-confidence checklist', () => {
  it('counts a site Sayari located, so a well-covered Profile can still reach strong', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const { supplierId, programId, runId, jobId } = await settleYazakiByHand(db);

    const result = await enrichSupplier(
      {
        db,
        upstream: replayUpstream(db, runId, jobId),
        meter: { addModelTokens: () => {} },
        runId,
        jobId,
      } as never,
      { supplierId, programId },
    );

    /**
     * **The geocoder was never called** — Sayari's own `x`/`y` supersedes it
     * for a resolved Profile (SPEC §7.1), so no `nominatim` Enrichment exists
     * for this Supplier and none should.
     */
    const geocodes = await db
      .select()
      .from(t.enrichment)
      .where(and(eq(t.enrichment.source, 'nominatim'), eq(t.enrichment.subjectKey, supplierId)));
    expect(geocodes).toEqual([]);

    // And the checklist still counts the item, because the item is a located
    // site rather than a particular provider's row.
    expect(result.presentEnrichments).toContain('nominatim');

    // The consequence, stated where it bites: with every source answering and
    // a well-sourced Profile, the band is `strong`. Requiring the geocoder's
    // own row would have put `strong` out of reach for the best-covered
    // Profiles on the roster — the ones Sayari already knows where to find.
    expect(EXPECTED_ENRICHMENTS.every((source) => result.presentEnrichments.includes(source))).toBe(
      true,
    );
    expect(
      dataConfidence({
        supplierId,
        displayName: 'Yazaki',
        match: { status: 'accepted', entityId: YAZAKI_ENTITY },
        profile: {
          entityId: YAZAKI_ENTITY,
          legalName: 'Yazaki',
          distinctSourceCount: 20,
          sanctioned: false,
          pep: false,
          closed: false,
          riskFactors: [],
          relationshipsTruncated: false,
        },
        owners: [],
        countryIndicators: [],
        presentEnrichments: result.presentEnrichments,
      }),
    ).toBe('strong');
  });
});

/** Seeds the cached bodies and settles the Match the resolve loop would have. */
async function settleYazakiByHand(
  db: TestDb,
): Promise<{ supplierId: string; programId: string; runId: string; jobId: string }> {
  const program = await seededProgram(db);
  const supplier = await db.query.supplier.findFirst({
    where: (row, { eq: is }) => is(row.rosterName, 'Yazaki'),
  });
  if (!program || !supplier) throw new Error('no seeded Yazaki');

  await seedUpstream(db, await loadFixture('resolve/agree-r1'));
  await seedUpstream(db, await loadFixture('enrich/yazaki'));

  const [run] = await db
    .insert(t.run)
    .values({ programId: program.id, state: 'running', trigger: 'full', subjectLabel: 'checklist' })
    .returning({ id: t.run.id });
  const jobId = await openJob(db, run!.id, 'enrich', supplier.id);

  const fetched = await replayUpstream(db, run!.id, jobId).sayari.getEntity({ id: YAZAKI_ENTITY });
  await upsertEntity(db, fetched.data);
  await settleMatch(db, {
    supplierId: supplier.id,
    status: 'accepted',
    entityId: YAZAKI_ENTITY,
    settledBy: 'human',
    note: 'Settled by hand: this test is about enrichment, not about resolution.',
  });

  return { supplierId: supplier.id, programId: program.id, runId: run!.id, jobId };
}
