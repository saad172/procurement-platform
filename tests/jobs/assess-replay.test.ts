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
 * `assess/passes-at-round-1` — a whole Assessment, replayed end to end.
 *
 * ## Why it is not `published-with-objections`
 *
 * SPEC §19.2 names that case, and this recording is not it. **Fixing the number
 * check's false positives removed the disagreement the name described**: the
 * three-Round arguments that produced dissent were the evaluator objecting to a
 * postcode, a quoted anchor line, a roster index and a statute number — every
 * one of them wrong (findings 59, 60, 67). With those fixed, the evaluator
 * agrees at Round 1.
 *
 * That is the right outcome for the app and it leaves a fixture named for
 * something it no longer shows, so it is renamed for what it does show.
 * `published-with-objections` still needs a **genuine** disagreement, arranged
 * in the inputs rather than manufactured by a broken check — see BUILD-NOTES
 * finding 69.
 *
 * ## What this one proves
 *
 * The whole loop, replayed: a proposer that reads rows and submits, our eight
 * code checks passing over the submitted payload, a stateless evaluator that
 * agrees, and a transactional publish in which **every sentence resolves to at
 * least one Citation**. Its inputs are built by running resolve and enrich —
 * see `buildAssessableSupplier` for why that beats snapshotting them.
 */

const FIXTURE = 'assess/passes-at-round-1';

describe('assess/passes-at-round-1 replays', () => {
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

    // `passed` means the evaluator agreed; the loop still records the Round.
    expect(outcome.evaluatorOutcome).toBe('passed');

    // A Round is the unit the ceiling counts, and it is not raisable from the UI.
    expect(outcome.roundsUsed).toBeLessThanOrEqual(MAX_ROUNDS);

    const version = await db.query.assessmentVersion.findFirst({
      where: eq(t.assessmentVersion.id, outcome.versionId),
    });
    expect(version?.evaluatorOutcome).toBe('passed');

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
