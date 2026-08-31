import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { resolveSupplier, toCandidateFacts } from '@/jobs/resolve';
import { runDiscriminators } from '@/domain/match/discriminators';
import { MAX_ROUNDS } from '@/config/constants';
import { seedTestProgram } from '@/db/seed-test-program';
import { TEST_PROGRAM } from '@/db/seed-data/test-program';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';

/**
 * `needs_review` — **tested without a fixture, and that is the spec's own
 * instruction rather than a shortcut.**
 *
 * SPEC §19.3 splits results a real run will not produce into two kinds:
 * *inputs control it* → arrange and record for real; *the model's output
 * controls it* → a loop-driver unit test with a hand-written fake.
 *
 * Whether two independently-prompted agents **disagree** is squarely the
 * second. It was attempted as an arrangement twice and both attempts converged
 * (finding 82), which is the honest outcome and leaves nothing to record —
 * forcing one would mean editing a result into a fixture.
 *
 * So the fake supplies the one thing that cannot be arranged: two picks that
 * differ, three Rounds running. Everything else is the real `resolveSupplier` —
 * the real gate, the real Discriminators, the real `settleMatch`, and real rows
 * read back.
 */

const ROSTER = {
  name: 'Sumitomo',
  address: 'Marunouchi, Chiyoda-ku, Tokyo',
  country: 'JPN',
  hasCategory: true,
};

/** Two entities in the roster's country, so `needs_review` is the legal outcome. */
const CANDIDATES = [
  { id: 'AAAAAAAAAAAAAAAAAAAAAA', label: 'SUMITOMO ELECTRIC INDUSTRIES, LTD.', countries: ['JPN'] },
  { id: 'BBBBBBBBBBBBBBBBBBBBBB', label: 'SUMITOMO CORPORATION', countries: ['JPN'] },
];

describe('resolveSupplier when the agents never converge', () => {
  it('parks at needs_review, storing both agents per-Discriminator verdicts', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    await seedTestProgram(db);

    const supplier = await db.query.supplier.findFirst({
      where: and(eq(t.supplier.programId, TEST_PROGRAM.id), eq(t.supplier.rosterName, 'Sumitomo')),
    });
    if (!supplier) return;

    // The Entities must exist locally: `match_candidate.entity_id` is a foreign
    // key, which is the constraint that caught finding 49.
    await db.insert(t.entity).values(
      CANDIDATES.map((c) => ({ id: c.id, label: c.label, country: c.countries[0]! })),
    ).onConflictDoNothing();

    const facts = CANDIDATES.map((c) => toCandidateFacts(c as never));
    let rounds = 0;

    const outcome = await resolveSupplier(
      {
        db,
        /**
         * A minimal upstream that hands back the two Candidates.
         *
         * `resolveSupplier` fetches every entity a Round reports seeing, so it
         * can store the pick before settling (finding 49) — that path is real
         * and has to run. What is faked is only where the bytes come from.
         */
        upstream: {
          sayari: {
            getEntity: async ({ id }: { id: string }) => {
              const found = CANDIDATES.find((c) => c.id === id);
              if (!found) throw new Error(`no such candidate ${id}`);
              return { data: found, cacheHit: true };
            },
          },
        } as never,
        runRound: async ({ roundN }) => {
          rounds = roundN;
          // The one thing that cannot be arranged: two picks that differ, every
          // Round. Neither agent is told what the other said — our code
          // compares the ids, which is what makes this a disagreement rather
          // than a refusal to agree.
          return {
            resolverPick: CANDIDATES[0]!.id,
            evaluatorPick: CANDIDATES[1]!.id,
            resolverVerdicts: runDiscriminators(ROSTER, facts[0]!),
            evaluatorVerdicts: runDiscriminators(ROSTER, facts[1]!),
            objection: 'The two independent reads disagreed.',
            rungsUsed: ['R1', 'R2'],
            entityIdsSeen: CANDIDATES.map((c) => c.id),
          };
        },
      },
      {
        supplierId: supplier.id,
        roster: ROSTER,
        prepassEntityIds: [],
      },
    );

    // ── The outcome, and that it cost every Round ──────────────────────────
    expect(outcome.status).toBe('needs_review');
    expect(outcome.entityId).toBeNull();
    expect(outcome.settledBy).toBe('agents');
    expect(rounds).toBe(MAX_ROUNDS);

    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplier.id) });
    expect(match?.status).toBe('needs_review');
    expect(match?.entityId).toBeNull();

    /**
     * **Both agents' verdicts are stored, per Candidate.**
     *
     * This is what the Needs Review view reads: a person choosing between two
     * companies needs to see where the two reads differed, Discriminator by
     * Discriminator. A stored pick without the verdicts behind it would be an
     * answer with no argument.
     */
    const attempt = await db.query.matchAttempt.findFirst({
      where: eq(t.matchAttempt.matchId, match!.id),
      with: { candidates: { with: { verdicts: true } } },
    });
    expect(attempt?.candidates ?? []).toHaveLength(CANDIDATES.length);

    const reporters = new Set(
      (attempt?.candidates ?? []).flatMap((c) => (c.verdicts ?? []).map((v) => v.reportedBy)),
    );
    expect(reporters.has('resolver')).toBe(true);
    expect(reporters.has('evaluator')).toBe(true);

    // Attributed to the agent that named that Candidate, not sprayed across
    // both — otherwise the view could not show where the reads differed.
    const byEntity = new Map(
      (attempt?.candidates ?? []).map((c) => [
        c.entityId,
        new Set((c.verdicts ?? []).map((v) => v.reportedBy)),
      ]),
    );
    expect(byEntity.get(CANDIDATES[0]!.id)?.has('resolver')).toBe(true);
    expect(byEntity.get(CANDIDATES[1]!.id)?.has('evaluator')).toBe(true);

    // `needs_review` rather than `not_found`, because Candidates in the
    // roster's country WERE seen — there is somebody to choose between.
    expect(
      (attempt?.candidates ?? []).every((c) => CANDIDATES.some((k) => k.id === c.entityId)),
    ).toBe(true);
  });
});
