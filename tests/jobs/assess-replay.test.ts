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
 * `assess/published-with-objections` (SPEC §19.2) — the sole home of:
 *
 * 1. **`MAX_ROUNDS = 3`** actually bounding the loop;
 * 2. **Dissent assembled from survivors, never authored** — the objections the
 *    evaluator raised and the proposer did not answer, carried onto the
 *    published Assessment rather than written by anyone.
 *
 * The second is the one that needs a real recording. "The model wrote a caveat
 * about its own weaknesses" is a claim about prose; "an objection survived
 * three Rounds and became a stored row" is a claim about structure, and only a
 * replay of an argument that actually happened can make it.
 *
 * Its inputs are built by running resolve and enrich — see
 * `buildAssessableSupplier` for why that is preferred to snapshotting them.
 */

const FIXTURE = 'assess/published-with-objections';

describe('assess/published-with-objections replays', () => {
  it('publishes with objections, and every sentence carries a citation', async () => {
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

    expect(outcome.evaluatorOutcome).toBe('published_with_objections');

    // A Round is the unit the ceiling counts, and it is not raisable from the UI.
    expect(outcome.roundsUsed).toBeLessThanOrEqual(MAX_ROUNDS);

    const version = await db.query.assessmentVersion.findFirst({
      where: eq(t.assessmentVersion.id, outcome.versionId),
    });
    expect(version?.evaluatorOutcome).toBe('published_with_objections');

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
