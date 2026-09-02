import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { runResolveJob } from '@/jobs/resolve-job';
import { resetAnthropicClients } from '@/model/client';
import { replayFetch } from '@/fixtures/replay-fetch';
import { loadFixture } from '@/fixtures/load';
import { seedUpstream, replayUpstream } from '@/fixtures/replay-upstream';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { seededProgram } from '../support/seeded-program';
import { resetDerived } from '../support/reset';
import { JOB_CAPS } from '@/config/constants';

/**
 * `resolve/agree-r1` (SPEC §19.2) — the sole home of two claims:
 *
 * 1. **agreement is our code comparing two entity ids**, not either agent's
 *    word;
 * 2. a Match so settled records `settled_by = 'agents'`.
 *
 * ## What makes this fixture load-bearing
 *
 * Both agents are real model turns replayed verbatim, and the comparison
 * between them is ours. A unit test could assert that `a === b` settles — it
 * could not show two independently-prompted agents actually landing on the same
 * company, which is the only evidence that the second agent is worth its tokens.
 *
 * ## Both halves are keyless
 *
 * The model comes from `replayFetch`; the upstream comes from
 * `createUpstream` **with no credentials**, over the 13 bodies the recording
 * read. A wrapper built without credentials cannot fall through to a live call:
 * it stops and names the key it missed. So a lookup the recording never made
 * fails loudly instead of quietly costing a credit.
 *
 * ## And the replay has to have served every turn
 *
 * A miss reaches the SDK as a `400`, so a drifted fixture reads downstream as a
 * Round that produced no submission — which for some resolve outcomes is legal
 * (`arranged-replay.test.ts` documents a sibling fixture that stayed green on
 * eighteen misses). `replay.misses` is asserted first here for the same reason,
 * even though this test's `accepted` / `settled_by = 'agents'` assertions could
 * not survive a miss on their own.
 *
 * **This test is red until the fixture is re-recorded.** The Discriminator
 * changes on this branch moved the resolver's own first prompt: `summarise()`
 * prints `addresses=N` per Candidate and `toCandidateFacts` now keeps address
 * blocks carrying only a line, so turn 1 no longer matches. Re-record with
 * `pnpm fixtures:record-replayable agree-r1` and follow what the recording did
 * rather than re-rolling for the old outcome (finding 79).
 */

const FIXTURE = 'resolve/agree-r1';

describe('resolve/agree-r1 replays', () => {
  it('settles by agents, on an entity both independently named', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const fixture = await loadFixture(FIXTURE);

    // A replay is a function of the database it starts from, and the recorded
    // run saw a freshly-seeded one. See `resetDerived` for the suite-ordering
    // failure this prevents.
    await resetDerived(db);

    const supplier = await db.query.supplier.findFirst({
      where: eq(t.supplier.rosterName, 'Yazaki'),
    });
    if (!supplier) return;

    await seedUpstream(db, fixture);
    resetAnthropicClients();

    const program = await seededProgram(db);
    const [run] = await db
      .insert(t.run)
      .values({ programId: program!.id, state: 'running', trigger: 'full', subjectLabel: 'replay' })
      .returning({ id: t.run.id });
    const [job] = await db
      .insert(t.job)
      .values({
        runId: run!.id,
        kind: 'resolve',
        subjectType: 'supplier',
        subjectId: supplier.id,
        state: 'running',
        toolCallCap: JOB_CAPS.resolve.toolCalls,
        tokenCap: JOB_CAPS.resolve.tokens,
      })
      .returning({ id: t.job.id });

    const upstream = replayUpstream(db, run!.id, job!.id);
    // Held rather than inlined, so the replay's own bookkeeping is readable.
    const replay = replayFetch(fixture);
    const outcome = await runResolveJob(
      {
        db,
        upstream,
        round: {
          toolCtx: {
            db,
            upstream,
            meter: { addModelTokens: () => {} },
            runId: run!.id,
            jobId: job!.id,
            surface: 'job',
          },
          modelCtx: {
            db,
            runId: run!.id,
            jobId: job!.id,
            credentials: { apiKey: 'not-a-key', fetch: replay },
          },
        },
        jobId: job!.id,
      },
      { supplierId: supplier.id },
    );

    /**
     * **Every recorded turn was served, and none drifted.** Asserted before the
     * outcome, because an outcome alone cannot tell a faithful replay from a
     * fixture that served nothing.
     */
    expect(
      replay.misses,
      `the replay drifted ${replay.misses} time(s); it served turns ${replay.served.join(', ') || '(none)'} of ${fixture.turns.length} recorded`,
    ).toBe(0);
    expect(replay.served).toHaveLength(fixture.turns.length);

    expect(outcome.status).toBe('accepted');
    expect(outcome.settledBy).toBe('agents');
    expect(outcome.entityId).toBeTruthy();

    // ── The row the UI reads, not the value the function returned ───────────
    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplier.id) });
    expect(match?.status).toBe('accepted');
    expect(match?.settledBy).toBe('agents');
    expect(match?.entityId).toBe(outcome.entityId);

    /**
     * The picked entity has a local row.
     *
     * This is the constraint that caught the bug: `match.entity_id` is a
     * foreign key, and the agents can name a company found through a rung tool
     * that the Job never stored. The Job absorbs what a Round saw before
     * settling, and the FK is what makes that non-optional.
     */
    const entity = await db.query.entity.findFirst({ where: eq(t.entity.id, outcome.entityId!) });
    expect(entity, 'the agents settled on an entity with no local row').toBeDefined();
  });

  it('records the rungs it actually climbed', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    const attempt = await db.query.matchAttempt.findFirst({
      orderBy: (row, { desc }) => desc(row.createdAt),
    });
    if (!attempt) return;

    // R1 is the batch pre-pass and always runs. R2 appears only because the
    // agents climbed to it — recorded from the tool calls they made, not
    // assumed. It used to be hardcoded to ['R1'], which made the ladder look
    // free.
    const rungs = attempt.rungsUsed as string[];
    expect(rungs).toContain('R1');
    expect(rungs.length).toBeGreaterThan(1);
  });
});
