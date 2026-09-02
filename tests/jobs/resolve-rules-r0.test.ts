import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { runResolveJob } from '@/jobs/resolve-job';
import { DISCRIMINATOR_NAMES } from '@/domain/match/discriminators';
import { resetAnthropicClients } from '@/model/client';
import { loadFixture } from '@/fixtures/load';
import { seedUpstream, replayUpstream } from '@/fixtures/replay-upstream';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { seededProgram } from '../support/seeded-program';
import { resetDerived } from '../support/reset';
import { JOB_CAPS } from '@/config/constants';

/**
 * `resolve/rules-r0` (SPEC §6.3, finding 106's "auto-accept gate was right
 * about identity") — a Match settled by the gate ALONE: plain code, zero
 * Rounds, zero model turns.
 *
 * Recorded live from roster row 1, "Bosch" (`src/db/seed-data/roster.ts:34`),
 * against the dev database on 2026-09-02: `entity.getEntity` × 5, one
 * `resolution.resolutionPost`, one `gleif.byId`, every one a cache hit
 * (`ms = 0`), so recording spent no Sayari credits. `loadTurnRows`
 * (`src/fixtures/record.ts`) needed a one-line extension to accept a
 * zero-turn `resolve` Job — see its own comment.
 *
 * **Not Syntegon.** The roster comment on `ROSTER` predicts Sayari's
 * *name-only* top hit is the divested Syntegon. The batch pre-pass this build
 * actually sends carries the roster's address and country alongside the name
 * (`src/jobs/resolve-job.ts`), which ranks the real German company first — the
 * five candidates this recording returned are all named "Bosch" in some form,
 * and none of them is Syntegon. This test asserts what was actually measured,
 * not the older name-only prediction.
 */

const FIXTURE = 'resolve/rules-r0';
const ACCEPTED_ENTITY_ID = 'vo4mAQFjLR-65BNY5iuM2g';

describe('resolve/rules-r0 replays', () => {
  it('settles by rules alone, in zero Rounds and zero model turns', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const fixture = await loadFixture(FIXTURE);

    await resetDerived(db);

    const supplier = await db.query.supplier.findFirst({
      where: eq(t.supplier.rosterName, 'Bosch'),
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

    // No `round` deps at all — the gate settles alone, or this Job parks. A
    // `runRound` here would make "zero model turns" untestable: the fixture
    // has none to replay, so any attempt to reach one throws a cache miss.
    const outcome = await runResolveJob(
      { db, upstream: replayUpstream(db, run!.id, job!.id), jobId: job!.id },
      { supplierId: supplier.id },
    );

    expect(outcome.status).toBe('accepted');
    expect(outcome.settledBy).toBe('rules');
    expect(outcome.rounds).toBe(0);
    expect(outcome.entityId).toBe(ACCEPTED_ENTITY_ID);

    // ── The row the UI reads, not the value the function returned ───────────
    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplier.id) });
    expect(match?.status).toBe('accepted');
    expect(match?.settledBy).toBe('rules');
    expect(match?.entityId).toBe(ACCEPTED_ENTITY_ID);

    // Zero model turns — not "few", zero. No `runRound` was ever handed to
    // `resolveSupplier`, and this is the row a Trace view would read.
    const turns = await db.query.traceTurn.findMany({ where: eq(t.traceTurn.jobId, job!.id) });
    expect(turns).toHaveLength(0);

    const attempt = await db.query.matchAttempt.findFirst({
      where: eq(t.matchAttempt.matchId, match!.id),
      with: { candidates: { with: { entity: true, verdicts: true } } },
    });
    expect(attempt?.rungsUsed as string[]).toEqual(['R1']);
    expect(attempt?.settledBy).toBe('rules');

    // Several "Bosch" decoys were considered — every candidate's label carries
    // the brand token, which is what makes them decoys rather than noise —
    // and exactly one was accepted.
    const candidates = attempt?.candidates ?? [];
    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.every((c) => /bosch/i.test(c.entity.label))).toBe(true);

    const accepted = candidates.find((c) => c.entityId === ACCEPTED_ENTITY_ID);
    const rejected = candidates.filter((c) => c.entityId !== ACCEPTED_ENTITY_ID);
    expect(accepted, 'the accepted entity should be stored as one of the candidates').toBeTruthy();
    expect(rejected.length).toBeGreaterThan(0);

    // The accepted candidate's eight verdicts are all `pass`.
    const verdicts = accepted!.verdicts;
    expect(verdicts).toHaveLength(8);
    expect(new Set(verdicts.map((v) => v.discriminator))).toEqual(new Set(DISCRIMINATOR_NAMES));
    expect(verdicts.every((v) => v.verdict === 'pass')).toBe(true);
  });
});
