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
 * A replay miss is handed to the SDK as a `400`, so what the Job sees is a
 * Round that produced no submission — and for a refusal that is a legal
 * outcome. `resolve/not-found` once asserted `not_found`, no entity, no
 * Candidates, three Rounds; a replay that served **nothing at all** produces
 * exactly that, and the fixture was green on eighteen misses.
 *
 * So each test reads `replay.misses` off the fetch and requires zero. That
 * turns *"the outcome still looks right"* into *"every recorded turn was
 * served, and none drifted"*, which is the claim a fixture exists to make.
 *
 * ## `resolve/not-found` no longer records a `not_found`, and it keeps the name
 *
 * Re-recorded on 2026-09-02 against the tightened Match gate, the arranged
 * unfindable Supplier settled **`needs_review` with 34 Candidates** — three
 * Rounds, no agreement — where the 2026-08-31 recording settled `not_found`
 * with none. Nothing was arranged differently: the ladder now climbs to R3a and
 * queries the roster *street*, so Danish companies carrying the token
 * "Nordhavn" and German companies on an "Industriestraße" come back, get
 * absorbed, and are describable. A Match with describable Candidates is one a
 * person can choose among, and that is `needs_review` by definition.
 *
 * **The fixture keeps its name deliberately.** Renaming it would quietly erase
 * the comparison; the honest record is that the row arranged to be unfindable
 * is now parked rather than refused, and the assertions below read the legal
 * set rather than the outcome the old ones hoped for (finding 79).
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
  it('settles the arranged unfindable row without an entity, after climbing the ladder', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, supplier, outcome, replay, fixture } = await arrange(
      'resolve/not-found',
      'Nordhavn Präzisionsteile Vertriebsgesellschaft',
    );

    // First, because "no pick" and "not found" are indistinguishable downstream.
    expectFaithfulReplay(replay, fixture);

    /**
     * **The legal set, not the outcome one recording happened to produce.**
     *
     * A row arranged so no company answers to its name can end in exactly two
     * places, and which one it reaches is a fact about what the graph returned:
     * `not_found` if the ladder saw nothing worth describing, `needs_review` if
     * it saw companies a person could be asked about. The 2026-08-31 recording
     * did the first; the 2026-09-02 one does the second.
     *
     * What must hold in both is the only thing this fixture is evidence for:
     * **nothing was settled on**, and the refusal came after the search rather
     * than before it.
     */
    expect(['not_found', 'needs_review']).toContain(outcome.status);
    expect(outcome.entityId).toBeNull();

    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplier.id) });
    expect(match?.status).toBe(outcome.status);
    expect(match?.entityId).toBeNull();

    const attempt = await db.query.matchAttempt.findFirst({
      where: eq(t.matchAttempt.matchId, match!.id),
      with: { candidates: true },
    });

    /**
     * **The Candidate list is the difference between the two outcomes**, and it
     * is asserted as that rather than as a count.
     *
     * `settleMatch` records every Candidate the ladder *absorbed* — the ones it
     * fetched and could describe. `not_found` stores none, because there is
     * nobody for a person to choose among, and an empty list is the evidence
     * rather than an absence of it. `needs_review` stores them for exactly the
     * opposite reason. A test that demanded one number would be asserting which
     * way the graph answered.
     */
    const candidates = attempt?.candidates ?? [];
    if (outcome.status === 'not_found') expect(candidates).toHaveLength(0);
    else expect(candidates.length).toBeGreaterThan(0);

    // It refused AFTER searching, not before: the agent Rounds ran.
    expect(outcome.rounds).toBeGreaterThan(0);
    expect(outcome.settledBy).toBe('agents');

    /**
     * **No ceiling fired**, which is the shape SPEC §18.3 asks for.
     *
     * This is the most expensive resolve Job the build has: absence is
     * expensive, and the recording spends 72 tool calls proving it. Against the
     * old ceiling of 60 it stopped part-way through Round 3 and reported
     * `terminated`; the ceiling was re-fit to 180 from that measurement, and a
     * healthy run now finishes.
     */
    expect(outcome.terminatedReason).toBeFalsy();

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
