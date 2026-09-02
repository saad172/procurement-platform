import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { runResolveJob } from '@/jobs/resolve-job';
import { resetAnthropicClients } from '@/model/client';
import { replayFetch, type ReplayFetch } from '@/fixtures/replay-fetch';
import type { Fixture } from '@/fixtures/types';
import { loadFixture } from '@/fixtures/load';
import { replayUpstream, seedUpstream } from '@/fixtures/replay-upstream';
import { seedTestProgram } from '@/db/seed-test-program';
import { TEST_PROGRAM } from '@/db/seed-data/test-program';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { openJob } from '../support/pipeline';

/**
 * The two outcomes a run over the approved roster does not produce (SPEC §19.3).
 *
 * **Arranged in the inputs, never edited into a fixture.** Each Supplier below
 * was chosen so its outcome is a fact about the world rather than a setting:
 * a name with no company behind it, and a company on every sanctions list.
 * Then the real pipeline ran and what it did was recorded.
 *
 * They live in their own Program so the approved seed stays untouched —
 * `seed-facts.test.ts` asserts three published findings about exactly those
 * fifty rows, and a fifty-first would make them wrong.
 *
 * ## Every test here asserts the replay served every turn
 *
 * **Both fixtures currently miss, and `resolve/not-found` was green anyway.**
 * A replay miss is handed to the SDK as a `400`, so what the Job sees is a
 * Round that produced no submission — and for `not_found` that is a legal
 * outcome. The assertions read `not_found`, no entity, no Candidates, three
 * Rounds; a replay that served nothing at all produces exactly that. The
 * fixture was passing by coincidence, on eighteen misses.
 *
 * So each test now reads `replay.misses` off the fetch and requires zero. That
 * turns *"the outcome still looks right"* into *"every recorded turn was
 * served, and none drifted"*, which is the claim a fixture exists to make.
 *
 * **These tests are red until the fixtures are re-recorded**, and that is the
 * truthful state: the Discriminator changes on this branch moved the resolver's
 * own first prompt — `summarise()` prints `addresses=N` per Candidate and
 * `toCandidateFacts` now keeps address blocks carrying only a line — so turn 1
 * no longer matches. Re-record with `pnpm fixtures:record-replayable not-found`
 * and `… sanctioned`, then read what the recording actually did rather than
 * re-rolling for the outcome the old assertions expected (finding 79).
 */

async function arrange(fixtureName: string, rosterName: string) {
  const db = await getTestDb();
  const fixture = await loadFixture(fixtureName);

  await resetDerived(db);
  await seedTestProgram(db);
  await seedUpstream(db, fixture);
  resetAnthropicClients();

  const supplier = await db.query.supplier.findFirst({
    where: and(eq(t.supplier.programId, TEST_PROGRAM.id), eq(t.supplier.rosterName, rosterName)),
  });
  if (!supplier) throw new Error(`the arranged program has no supplier "${rosterName}"`);

  const [run] = await db
    .insert(t.run)
    .values({
      programId: TEST_PROGRAM.id,
      state: 'running',
      trigger: 'full',
      subjectLabel: fixtureName,
    })
    .returning({ id: t.run.id });
  const jobId = await openJob(db, run!.id, 'resolve', supplier.id);
  const upstream = replayUpstream(db, run!.id, jobId);

  // Held rather than inlined, so the test can read what the replay actually did.
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
          jobId,
          surface: 'job',
        },
        modelCtx: {
          db,
          runId: run!.id,
          jobId,
          credentials: { apiKey: 'not-a-key', fetch: replay },
        },
      },
      jobId,
    },
    { supplierId: supplier.id },
  );

  return { db, supplier, outcome, replay, fixture };
}

/**
 * **The replay served every recorded turn, and drifted on none.**
 *
 * Asserted first in every test here, because an outcome assertion alone cannot
 * tell a faithful replay from a fixture that served nothing — see the file
 * header for the eighteen-miss case that made this necessary.
 */
function expectFaithfulReplay(replay: ReplayFetch, fixture: Fixture): void {
  expect(
    replay.misses,
    `the replay drifted ${replay.misses} time(s); it served turns ${replay.served.join(', ') || '(none)'} of ${fixture.turns.length} recorded`,
  ).toBe(0);
  expect(replay.served).toHaveLength(fixture.turns.length);
}

describe('resolve/not-found replays', () => {
  it('settles not_found, with no entity and no candidate in the roster country', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, supplier, outcome, replay, fixture } = await arrange(
      'resolve/not-found',
      'Nordhavn Präzisionsteile Vertriebsgesellschaft',
    );

    // First, because "no pick" and "not found" are indistinguishable downstream.
    expectFaithfulReplay(replay, fixture);

    expect(outcome.status).toBe('not_found');
    expect(outcome.entityId).toBeNull();

    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplier.id) });
    expect(match?.status).toBe('not_found');
    expect(match?.entityId).toBeNull();

    /**
     * **`not_found` is not `needs_review`**, and the difference is what was
     * seen rather than what was decided: `not_found` means no Candidate in the
     * roster's country was ever seen, so there is nothing for a person to
     * choose among. The Excluded block renders them differently for that reason.
     */
    const attempt = await db.query.matchAttempt.findFirst({
      where: eq(t.matchAttempt.matchId, match!.id),
      with: { candidates: true },
    });
    /**
     * **No stored Candidate at all**, which is the signature rather than an
     * absence of evidence.
     *
     * `settleMatch` records every Candidate the ladder *absorbed* — the ones it
     * fetched and could describe. The agents ran the full ladder over 47
     * recorded turns and finished with nothing worth storing, which is exactly
     * what "no company by this name exists" looks like from inside the loop.
     *
     * The contrast with `needs_review` is the whole point: that outcome stores
     * the Candidates so a person can choose among them. Here there is nobody to
     * choose.
     */
    expect(attempt?.candidates ?? []).toHaveLength(0);

    // It refused AFTER searching, not before: the agent Rounds ran.
    expect(outcome.rounds).toBeGreaterThan(0);
    expect(outcome.settledBy).toBe('agents');

    // And the rungs it climbed are on the row, so "what did it take to decide
    // there is nothing here" is answerable.
    expect(attempt?.rungsUsed as string[]).toContain('R1');
  });
});

describe('resolve/sanctioned replays', () => {
  it('matches a sanctioned company and stores the badge as a fact from the graph', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, supplier, outcome, replay, fixture } = await arrange(
      'resolve/sanctioned',
      'Rosoboronexport',
    );

    expectFaithfulReplay(replay, fixture);

    expect(outcome.status).toBe('accepted');
    expect(outcome.entityId).toBeTruthy();

    /**
     * The badge is **read from the entity**, not set by us.
     *
     * A Supplier we had marked sanctioned ourselves would prove only that the
     * renderer reads our own column. This one is on every major sanctions list,
     * so `sanctioned: true` arriving from Sayari is the fact the disqualifying
     * rule is supposed to act on.
     */
    const entity = await db.query.entity.findFirst({ where: eq(t.entity.id, outcome.entityId!) });
    expect(entity, 'the match settled on an entity with no local row').toBeDefined();
    expect(entity?.sanctioned).toBe(true);

    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplier.id) });
    expect(match?.status).toBe('accepted');
  });
});
