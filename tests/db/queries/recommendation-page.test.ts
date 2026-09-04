import { describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import * as t from '@/db/schema';
import { loadRecommendationPage } from '@/db/queries/recommendation-page';
import { getTestDb, testDatabaseIsUp } from '../../support/test-db';
import { resetDerived } from '../../support/reset';
import { seededProgram } from '../../support/seeded-program';

/**
 * The Recommendation page's Concentration Paths (network spec §4.2, §7, §8,
 * ticket 05 unit 05g) — "the Picks' Paths beside the conditions that name
 * them". `loadConcentrationPaths` (`src/db/queries/recommendation-page.ts`,
 * module-private, exercised here through `loadRecommendationPage` exactly as
 * a page would call it) matches a `second_source` Pick to the `shortest_path`
 * Path the recommend Job's ninth check wrote for it — `graph_path.kind =
 * 'shortest_path'`, rooted at the AWARD's own entity id, terminal at that
 * Pick's own entity id (`findConcentrations`, `src/jobs/recommend.ts`).
 *
 * Seeded directly, the same way `family-paths.test.ts`'s own suites prove the
 * read side without depending on the recommend Job's write side having run
 * in this worktree.
 */
describe('loadRecommendationPage — Concentration Paths, matched Pick to shortest_path Path', () => {
  const AWARD_ENTITY = 'test-concentration-award-entity';
  const SECOND_SOURCE_ENTITY = 'test-concentration-second-source-entity';
  const UNMATCHED_SECOND_SOURCE_ENTITY = 'test-concentration-unmatched-second-source-entity';
  const AWARD_ROSTER_NAME = 'Concentration Paths Award Co (test)';
  const SECOND_SOURCE_ROSTER_NAME = 'Concentration Paths Second Source Co (test)';
  const UNMATCHED_ROSTER_NAME = 'Concentration Paths Unmatched Second Source Co (test)';

  async function seedRecommendationFixture(args: { withShortestPath: boolean }) {
    const db = await getTestDb();
    await resetDerived(db);
    const program = await seededProgram(db);
    const category = await db.query.category.findFirst({
      where: eq(t.category.programId, program.id),
    });
    if (!category) throw new Error('no seeded category to attach a recommendation to');

    await db.insert(t.entity).values([
      { id: AWARD_ENTITY, label: 'Award Company', country: 'USA' },
      { id: SECOND_SOURCE_ENTITY, label: 'Second Source Company', country: 'MEX' },
      { id: UNMATCHED_SECOND_SOURCE_ENTITY, label: 'Unmatched Second Source', country: 'CAN' },
    ]);

    // `supplier` is an AUTHORED table (`src/db/schema/authored.ts`) —
    // `resetDerived` above leaves it alone on purpose (that function's own
    // doc comment), so a Supplier this fixture inserts survives into the
    // NEXT test's own `resetDerived()` call rather than being wiped by it.
    // Cleared here **by roster name**, matching this suite's own established
    // convention for a scratch Supplier (`settle-match.test.ts`,
    // `site-country.test.ts`, `needs-review-query.test.ts` all delete by
    // name before insert, never by roster index) — a fixed roster INDEX
    // collided across two of those files and this one before this comment
    // was written (9002/9003 are already claimed elsewhere), which is
    // exactly the failure mode deleting by name avoids: two files can want
    // the same free-standing index number, but never the same name.
    await db
      .delete(t.supplier)
      .where(
        and(
          eq(t.supplier.programId, program.id),
          inArray(t.supplier.rosterName, [
            AWARD_ROSTER_NAME,
            SECOND_SOURCE_ROSTER_NAME,
            UNMATCHED_ROSTER_NAME,
          ]),
        ),
      );

    // Roster indexes deliberately past the seeded roster's own range (the
    // seed's own program carries 50 rows, per `seededProgram`'s own doc
    // comment) AND past every other file's own claimed 90xx/91xx/92xx block
    // (grepped at the time this was written) — belt-and-braces alongside the
    // by-name delete above, since two DIFFERENT names can still collide on
    // the SAME index within one `pnpm test` invocation if neither cleans up
    // afterward.
    const [awardSupplier] = await db
      .insert(t.supplier)
      .values({
        programId: program.id,
        origin: 'imported',
        rosterIndex: 9301,
        rosterName: AWARD_ROSTER_NAME,
      })
      .returning({ id: t.supplier.id });
    const [secondSourceSupplier] = await db
      .insert(t.supplier)
      .values({
        programId: program.id,
        origin: 'imported',
        rosterIndex: 9302,
        rosterName: SECOND_SOURCE_ROSTER_NAME,
      })
      .returning({ id: t.supplier.id });
    const [unmatchedSupplier] = await db
      .insert(t.supplier)
      .values({
        programId: program.id,
        origin: 'imported',
        rosterIndex: 9303,
        rosterName: UNMATCHED_ROSTER_NAME,
      })
      .returning({ id: t.supplier.id });

    await db.insert(t.match).values([
      { supplierId: awardSupplier!.id, status: 'accepted', entityId: AWARD_ENTITY, settledBy: 'rules' },
      {
        supplierId: secondSourceSupplier!.id,
        status: 'accepted',
        entityId: SECOND_SOURCE_ENTITY,
        settledBy: 'rules',
      },
      {
        supplierId: unmatchedSupplier!.id,
        status: 'accepted',
        entityId: UNMATCHED_SECOND_SOURCE_ENTITY,
        settledBy: 'rules',
      },
    ]);

    const [recommendation] = await db
      .insert(t.recommendation)
      .values({ programId: program.id, categoryId: category.id })
      .returning({ id: t.recommendation.id });
    const [version] = await db
      .insert(t.recommendationVersion)
      .values({
        recommendationId: recommendation!.id,
        n: 1,
        frozenInputs: {},
        evaluatorOutcome: 'passed',
      })
      .returning({ id: t.recommendationVersion.id });

    await db.insert(t.recommendationPick).values([
      { recommendationVersionId: version!.id, supplierId: awardSupplier!.id, role: 'award', rank: 1 },
      {
        recommendationVersionId: version!.id,
        supplierId: secondSourceSupplier!.id,
        role: 'second_source',
        rank: 2,
      },
      // A second_source Pick the ninth check never found a Path for — the
      // common case (network spec §4.2's "No Path, no further cost"): most
      // second sources are NOT a Concentration.
      {
        recommendationVersionId: version!.id,
        supplierId: unmatchedSupplier!.id,
        role: 'second_source',
        rank: 3,
      },
    ]);

    if (args.withShortestPath) {
      const [upstreamResponse] = await db
        .insert(t.upstreamResponse)
        .values({
          source: 'sayari',
          endpoint: 'traversal.shortestPath',
          paramsHash: 'test-hash-recommendation-page-shortest-path',
          params: { entities: [AWARD_ENTITY, SECOND_SOURCE_ENTITY] },
          body: {},
          bodyHash: 'test-body-hash-recommendation-page-shortest-path',
          via: 'sdk',
        })
        .returning({ id: t.upstreamResponse.id });
      const [enrichment] = await db
        .insert(t.enrichment)
        .values({
          source: 'sayari_shortest_path',
          subjectKind: 'entity',
          subjectKey: AWARD_ENTITY,
          requestParams: { entities: [AWARD_ENTITY, SECOND_SOURCE_ENTITY] },
          upstreamResponseId: upstreamResponse!.id,
        })
        .returning({ id: t.enrichment.id });
      await db
        .insert(t.record)
        .values([{ id: 'source/rec-recommendation-page-shortest-path/1700000000000' }]);
      const [edge] = await db
        .insert(t.entityRelationship)
        .values({
          fromEntityId: AWARD_ENTITY,
          toEntityId: SECOND_SOURCE_ENTITY,
          relationshipType: 'shareholder_of',
          sourceRecordId: 'source/rec-recommendation-page-shortest-path/1700000000000',
        })
        .returning({ id: t.entityRelationship.id });
      await db.insert(t.graphPath).values({
        rootEntityId: AWARD_ENTITY,
        terminalEntityId: SECOND_SOURCE_ENTITY,
        kind: 'shortest_path',
        direction: 'either',
        hopDepth: 1,
        edgeIds: [edge!.id],
        enrichmentId: enrichment!.id,
      });
    }

    return { db, program, category };
  }

  it('matches the second_source Pick a shortest_path Path was found for, and names the award correctly', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, program, category } = await seedRecommendationFixture({ withShortestPath: true });

    const page = await loadRecommendationPage(db, { programId: program.id, categoryId: category.id });
    expect(page).toBeDefined();
    expect(page!.concentrationPaths).toHaveLength(1);

    const row = page!.concentrationPaths[0]!;
    // The Path's own root_entity_id is always the AWARD's, never the second
    // source's (`findConcentrations`'s own `rootEntityId: awardEntityId`) —
    // this is exactly the field a diagram's `roots` prop needs and
    // `path.terminalEntityId`/`path.label` do NOT carry.
    expect(row.award.entityId).toBe(AWARD_ENTITY);
    expect(row.pick.entityLabel).toBe('Second Source Company');
    expect(row.path.terminalEntityId).toBe(SECOND_SOURCE_ENTITY);
    expect(row.path.edges.map((e) => e.sourceRecordId)).toEqual([
      'source/rec-recommendation-page-shortest-path/1700000000000',
    ]);

    // The OTHER second_source Pick (no shortest_path row was ever written for
    // it) is silently absent — not an error, not a placeholder row.
    expect(
      page!.concentrationPaths.some((r) => r.pick.entityLabel === 'Unmatched Second Source'),
    ).toBe(false);
  });

  it('returns an empty array when no shortest_path Path was ever found — the common case', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, program, category } = await seedRecommendationFixture({ withShortestPath: false });

    const page = await loadRecommendationPage(db, { programId: program.id, categoryId: category.id });
    expect(page).toBeDefined();
    expect(page!.concentrationPaths).toEqual([]);
  });
});
