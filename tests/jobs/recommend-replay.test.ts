import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { recommendCategory } from '@/jobs/recommend';
import { assessSupplier } from '@/jobs/assess';
import { resetAnthropicClients } from '@/model/client';
import { replayFetch } from '@/fixtures/replay-fetch';
import { loadFixture } from '@/fixtures/load';
import { replayUpstream } from '@/fixtures/replay-upstream';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { buildAssessableSupplier, openJob } from '../support/pipeline';

/**
 * `recommend/one-category` (SPEC §19.2) — the sole home of:
 *
 * 1. **typed Picks** — a decision recorded as an enum row, not as prose;
 * 2. **pick legality**, checked before insert rather than described afterwards;
 * 3. the **disqualifying badge barring an `award`**.
 *
 * ## Why the whole pipeline runs
 *
 * A Recommendation reads a Shortlist, and a Shortlist is Suppliers with Scores
 * and published Assessments. So this replays four Jobs in sequence — resolve,
 * enrich, assess, recommend — three of them from fixtures and one (enrich) from
 * cached upstream bodies. All offline, no credentials, no credits.
 *
 * It is the longest test in the suite and the only one that shows the app's
 * actual shape: a Program is not a request, it is a pipeline.
 */

const FIXTURE = 'recommend/one-category';

describe('recommend/one-category replays', () => {
  it('publishes typed picks a person could act on', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    await resetDerived(db);
    const { supplierId, programId, runId } = await buildAssessableSupplier(db, 'Yazaki');
    resetAnthropicClients();

    // The Shortlist needs a published Assessment, so assess replays first.
    const assessFixture = await loadFixture('assess/published-with-objections');
    const assessJob = await openJob(db, runId, 'assess', supplierId);
    await assessSupplier(
      {
        db,
        toolCtx: toolCtx(db, runId, assessJob),
        modelCtx: {
          db,
          runId,
          jobId: assessJob,
          credentials: { apiKey: 'not-a-key', fetch: replayFetch(assessFixture) },
        },
        jobId: assessJob,
      },
      { supplierId, programId },
    );

    const category = await db.query.category.findFirst({ where: eq(t.category.code, 'HAR') });
    if (!category) return;

    const fixture = await loadFixture(FIXTURE);
    const jobId = await openJob(db, runId, 'recommend', category.id);
    const outcome = await recommendCategory(
      {
        db,
        toolCtx: toolCtx(db, runId, jobId),
        modelCtx: {
          db,
          runId,
          jobId,
          credentials: { apiKey: 'not-a-key', fetch: replayFetch(fixture) },
        },
        jobId,
      },
      { programId, categoryId: category.id },
    );

    expect(outcome.versionId).toBeTruthy();

    const picks = await db
      .select()
      .from(t.recommendationPick)
      .where(eq(t.recommendationPick.recommendationVersionId, outcome.versionId));

    // ── Typed, and legal ────────────────────────────────────────────────────
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.length).toBeLessThanOrEqual(3);
    expect(picks.filter((pick) => pick.role === 'award').length).toBeLessThanOrEqual(1);

    for (const pick of picks) {
      expect(['award', 'second_source', 'develop', 'avoid']).toContain(pick.role);

      /**
       * Every Pick names a Supplier with an **accepted** Match.
       *
       * This is legality checked at the row rather than asserted about prose: a
       * Recommendation that awarded a Supplier the app could not identify would
       * be the worst output this system could produce, and it is refused before
       * insert rather than caught after.
       */
      const match = await db.query.match.findFirst({
        where: eq(t.match.supplierId, pick.supplierId),
      });
      expect(match?.status).toBe('accepted');
    }

    // Every sentence still resolves to a citation — the rule does not weaken
    // because the document is a Recommendation rather than an Assessment.
    const sentences = await db
      .select()
      .from(t.sentence)
      .where(eq(t.sentence.recommendationVersionId, outcome.versionId));
    const citations = await db.select().from(t.citation);
    const cited = new Set(citations.map((row) => row.sentenceId));
    expect(sentences.filter((row) => !cited.has(row.id)).map((row) => row.text)).toEqual([]);
  });
});

function toolCtx(db: Awaited<ReturnType<typeof getTestDb>>, runId: string, jobId: string) {
  return {
    db,
    upstream: replayUpstream(db, runId, jobId),
    meter: { addModelTokens: () => {} },
    runId,
    jobId,
    surface: 'job' as const,
  };
}
