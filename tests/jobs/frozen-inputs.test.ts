import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { buildEvidence, buildFrozenInputs } from '@/jobs/assess';
import { loadShortlist } from '@/db/queries/shortlist';
import { DEFAULT_WEIGHTS, WEIGHTED_CRITERIA } from '@/domain/score';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { buildAssessableSupplier } from '../support/pipeline';

/**
 * What an Assessment and a Recommendation freeze, and what the eight checks are
 * told (SPEC §10.4, §10.6).
 *
 * Both are built from real rows by `assess.ts` and read by nothing else, so
 * they are exercised here against the pipeline's own output rather than against
 * a hand-written map — the point of the two changes below is precisely that
 * they now agree with what the Category page computes, and a fake would agree
 * with whatever it was written to agree with.
 */

describe('the frozen inputs', () => {
  it('freeze the effective weight vector, the ranked order and each rank', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const { supplierId, programId } = await buildAssessableSupplier(db, 'Yazaki');

    const categories = await db
      .select({ categoryId: t.supplierCategory.categoryId })
      .from(t.supplierCategory)
      .where(eq(t.supplierCategory.supplierId, supplierId));
    expect(categories.length).toBeGreaterThan(0);

    const frozen = await buildFrozenInputs(db, { programId, supplierIds: [supplierId] });

    // Every weighted Criterion carries a weight, whether or not the Program
    // saved one for it — this is the vector `scores` was computed with, and a
    // vector missing a key could not have produced them.
    expect(Object.keys(frozen.effectiveWeights).sort()).toEqual([...WEIGHTED_CRITERIA].sort());
    for (const key of WEIGHTED_CRITERIA) {
      expect(frozen.effectiveWeights[key]).toBeTypeOf('number');
    }

    for (const { categoryId } of categories) {
      const shortlist = await loadShortlist(db, {
        programId,
        categoryId,
        weights: frozen.effectiveWeights,
      });
      // THE SHORTLIST ORDER, not the argument's supplier ids: what is frozen is
      // what the Category page ranks, computed by the same function.
      expect(frozen.shortlistOrder[categoryId]).toEqual(
        shortlist.ranked.map((row) => row.supplierId),
      );
      expect(frozen.shortlistRanks[`${supplierId}:${categoryId}`]).toBe(
        shortlist.ranked.find((row) => row.supplierId === supplierId)?.rank ?? null,
      );
    }
  });

  it('give the checks the disqualifying badge and the scores the shortlist gives', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const supplier = await db.query.supplier.findFirst({
      where: eq(t.supplier.rosterName, 'Yazaki'),
    });
    if (!supplier) return;

    const frozenInputs = await buildFrozenInputs(db, {
      programId: supplier.programId,
      supplierIds: [supplier.id],
    });
    const evidence = await buildEvidence(db, {
      programId: supplier.programId,
      supplierIds: [supplier.id],
      frozenInputs,
      citations: [],
    });
    const facts = evidence.suppliers.get(supplier.id)!;

    // A Score per Category, and only the Categories that have one.
    for (const categoryId of facts.categoriesWithScore) {
      expect(facts.categoryIds).toContain(categoryId);
      expect(frozenInputs.scores[`${supplier.id}:${categoryId}`]).not.toBeNull();
    }
    for (const categoryId of facts.categoryIds) {
      if (facts.categoriesWithScore.includes(categoryId)) continue;
      expect(frozenInputs.scores[`${supplier.id}:${categoryId}`] ?? null).toBeNull();
    }

    /**
     * The badge as the Shortlist lights it: a disqualifying **risk factor** or
     * `sanctioned`, never `sanctioned` alone. Read here off the Shortlist row
     * rather than restated, because restating it is how the two came to differ.
     */
    const shortlist = await loadShortlist(db, {
      programId: supplier.programId,
      categoryId: facts.categoryIds[0]!,
      weights: DEFAULT_WEIGHTS,
    });
    const row = shortlist.ranked.find((entry) => entry.supplierId === supplier.id);
    if (row) expect(facts.disqualifying).toBe(row.disqualifying);

    const profile = await db.query.match.findFirst({
      where: and(eq(t.match.supplierId, supplier.id), eq(t.match.status, 'accepted')),
    });
    expect(profile).toBeDefined();
  });
});
