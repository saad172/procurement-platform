import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { assessSupplier } from '@/jobs/assess';
import { resetAnthropicClients } from '@/model/client';
import { replayFetch } from '@/fixtures/replay-fetch';
import { loadFixture } from '@/fixtures/load';
import { replayUpstream } from '@/fixtures/replay-upstream';
import { MAX_ROUNDS } from '@/config/constants';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { buildAssessableSupplier, openJob } from '../support/pipeline';

/**
 * `assess/published-with-objections` (SPEC §19.2) — a whole Assessment,
 * replayed end to end, ending in a disagreement neither side resolved.
 *
 * ## The dissent here is real, and it was right
 *
 * An earlier recording under this name was renamed away, because the
 * disagreement it captured was the evaluator objecting to our own broken number
 * check (finding 69). This one is different: the evaluator argued that the
 * cited rows *"carry only a key and a value"* and do not support the
 * sub-structure the draft attributes to them. It said so across three Rounds
 * and no draft could answer it — because it held one read tool where the
 * proposer held four (finding 76).
 *
 * ## The outcome is asserted as a set, not a value
 *
 * The first version of this test pinned `passed`, then `published_with_objections`,
 * then `passed` again — chasing whichever outcome the latest recording happened
 * to produce. That is a test measuring the recording rather than the code.
 *
 * What holds for **every** published Assessment is asserted instead: it
 * published, it stayed inside MAX_ROUNDS, every sentence resolves to at least
 * one Citation, and `limits` is present. The *particular* outcome is read from
 * the run rather than demanded of it.
 */

const FIXTURE = 'assess/published-with-objections';

describe('assess/published-with-objections replays', () => {
  it('publishes, and every sentence carries a citation', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const fixture = await loadFixture(FIXTURE);

    await resetDerived(db);
    const { supplierId, programId, runId } = await buildAssessableSupplier(db, 'Yazaki');
    resetAnthropicClients();

    const jobId = await openJob(db, runId, 'assess', supplierId);
    const upstream = replayUpstream(db, runId, jobId);

    const outcome = await assessSupplier(
      {
        db,
        toolCtx: {
          db,
          upstream,
          meter: { addModelTokens: () => {} },
          runId,
          jobId,
          surface: 'job',
        },
        modelCtx: {
          db,
          runId,
          jobId,
          credentials: { apiKey: 'not-a-key', fetch: replayFetch(fixture) },
        },
        jobId,
      },
      { supplierId, programId },
    );

    // Either publishable outcome. Pinning one made this test measure which
    // recording it happened to be given rather than what the code does.
    expect(['passed', 'published_with_objections']).toContain(outcome.evaluatorOutcome);

    // A Round is the unit the ceiling counts, and it is not raisable from the UI.
    expect(outcome.roundsUsed).toBeLessThanOrEqual(MAX_ROUNDS);

    const version = await db.query.assessmentVersion.findFirst({
      where: eq(t.assessmentVersion.id, outcome.versionId),
    });
    expect(version?.evaluatorOutcome).toBe(outcome.evaluatorOutcome);

    /**
     * **Every sentence resolves to at least one Citation.**
     *
     * Not a spot check: the whole point of the Citation rule is that it holds
     * for all of them, and a published Assessment with one uncited sentence is
     * the failure the rule exists to make impossible.
     */
    const sentences = await db
      .select()
      .from(t.sentence)
      .where(eq(t.sentence.assessmentVersionId, outcome.versionId));
    expect(sentences.length).toBeGreaterThan(0);

    const citations = await db.select().from(t.citation);
    const cited = new Set(citations.map((row) => row.sentenceId));
    const uncited = sentences.filter((row) => !cited.has(row.id));
    expect(uncited.map((row) => row.text), 'these sentences resolve to no citation').toEqual([]);

    // `limits` is mandatory: an Assessment that admits nothing has not been
    // checked, it has been agreed with.
    expect(sentences.some((row) => row.section === 'limits')).toBe(true);
  });

  it('records a Round per exchange, with the evaluator having spoken', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    const rounds = await db.select().from(t.round);
    expect(rounds.length).toBeGreaterThan(0);

    // Both roles appear: a loop that only ever recorded the proposer would
    // report agreement it never sought.
    const roles = new Set(rounds.map((row) => row.role));
    expect(roles.has('proposer')).toBe(true);
    expect(roles.has('evaluator')).toBe(true);
  });
});
