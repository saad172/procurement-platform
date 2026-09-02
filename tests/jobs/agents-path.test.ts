import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { resolveSupplier, toCandidateFacts, type ResolveDeps } from '@/jobs/resolve';
import { runDiscriminators } from '@/domain/match/discriminators';
import { seedTestProgram } from '@/db/seed-test-program';
import { TEST_PROGRAM } from '@/db/seed-data/test-program';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';

/**
 * **What the Job does with what the agents hand back** (SPEC §6).
 *
 * Driven by a hand-written `runRound`, for the same reason
 * `needs-review.test.ts` is: what two agents pick is the model's output, and
 * SPEC §19.3 says that kind of case is a loop-driver test with a fake rather
 * than a recording. Everything below the fake is the real `resolveSupplier` —
 * the real gate, the real Discriminators, the real `settleMatch`, real rows
 * read back.
 *
 * Each case here is a way the agreement path was wrong about its own answer.
 */

const ROSTER = {
  name: 'Sumitomo',
  address: 'Marunouchi, Chiyoda-ku, Tokyo',
  country: 'JPN',
  hasCategory: true,
};

const CANDIDATES = [
  { id: 'AAAAAAAAAAAAAAAAAAAAAA', label: 'SUMITOMO ELECTRIC INDUSTRIES, LTD.', countries: ['JPN'] },
  { id: 'BBBBBBBBBBBBBBBBBBBBBB', label: 'SUMITOMO CORPORATION', countries: ['JPN'] },
];

/** Hands back the two Candidates and nothing else. */
const upstream = {
  sayari: {
    getEntity: async ({ id }: { id: string }) => {
      const found = CANDIDATES.find((c) => c.id === id);
      if (!found) throw new Error(`no such candidate ${id}`);
      return { data: found, cacheHit: true };
    },
  },
} as never;

async function arrange() {
  const db = await getTestDb();
  await resetDerived(db);
  await seedTestProgram(db);

  const supplier = await db.query.supplier.findFirst({
    where: and(eq(t.supplier.programId, TEST_PROGRAM.id), eq(t.supplier.rosterName, 'Sumitomo')),
  });
  if (!supplier) throw new Error('the arranged program has no supplier "Sumitomo"');

  await db
    .insert(t.entity)
    .values(CANDIDATES.map((c) => ({ id: c.id, label: c.label, country: c.countries[0]! })))
    .onConflictDoNothing();

  const facts = CANDIDATES.map((c) => toCandidateFacts(c as never));
  return { db, supplier, facts };
}

describe('an agreed entity id has to be one this Job holds', () => {
  it('treats an unknown id as non-convergence, and says so in the objection', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, supplier, facts } = await arrange();

    /**
     * Nothing checked this. The agents write the id, so it can be one no rung
     * returned, one whose fetch failed, or one that is not an entity at all —
     * and settling on it wrote a `match.entity_id` with no local row, which the
     * foreign key refuses. Before the key refuses it, it is a Match pointing at
     * a company the app cannot describe.
     */
    const objections: (string | undefined)[] = [];
    const runRound: NonNullable<ResolveDeps['runRound']> = async ({ objection }) => {
      objections.push(objection);
      return {
        resolverPick: 'ZZZZZZZZZZZZZZZZZZZZZZ',
        evaluatorPick: 'ZZZZZZZZZZZZZZZZZZZZZZ',
        resolverVerdicts: runDiscriminators(ROSTER, facts[0]!),
        evaluatorVerdicts: runDiscriminators(ROSTER, facts[0]!),
        objection: undefined,
        rungsUsed: ['R1'],
        entityIdsSeen: CANDIDATES.map((c) => ({ entityId: c.id, rung: 'R1' })),
      };
    };

    const outcome = await resolveSupplier(
      { db, upstream, runRound },
      { supplierId: supplier.id, roster: ROSTER, prepassEntityIds: [] },
    );

    expect(outcome.status).toBe('needs_review');
    expect(outcome.entityId).toBeNull();

    // Round 1 gets no objection; Rounds 2 and 3 are told what happened, and the
    // id is named so the next Round can say where it came from.
    expect(objections[0]).toBeUndefined();
    expect(objections[1]).toMatch(/ZZZZZZZZZZZZZZZZZZZZZZ/);
    expect(objections[1]).toMatch(/not one of the candidates this job holds/);
  });
});

describe('each candidate row carries its own verdicts', () => {
  it('does not write the winner’s reasoning against every other candidate', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, supplier, facts } = await arrange();

    /**
     * The agreement path wrote **the picked entity's eight verdicts against
     * every candidate row it stored**, so a Needs Review page for an accepted
     * Match showed the losing Candidates each carrying the winner's own
     * reasoning — every one apparently passing all eight, and the record of why
     * they lost gone. The non-convergence path had always done it right; the
     * two now share one function.
     */
    const runRound: NonNullable<ResolveDeps['runRound']> = async () => ({
      resolverPick: CANDIDATES[0]!.id,
      evaluatorPick: CANDIDATES[0]!.id,
      resolverVerdicts: runDiscriminators(ROSTER, facts[0]!),
      evaluatorVerdicts: runDiscriminators(ROSTER, facts[0]!),
      objection: undefined,
      rungsUsed: ['R1', 'R2'],
      entityIdsSeen: [
        { entityId: CANDIDATES[0]!.id, rung: 'R1' },
        // Surfaced by an R2 search, not by the pre-pass.
        { entityId: CANDIDATES[1]!.id, rung: 'R2' },
      ],
    });

    const outcome = await resolveSupplier(
      { db, upstream, runRound },
      { supplierId: supplier.id, roster: ROSTER, prepassEntityIds: [CANDIDATES[0]!.id] },
    );
    expect(outcome.status).toBe('accepted');
    expect(outcome.settledBy).toBe('agents');
    expect(outcome.entityId).toBe(CANDIDATES[0]!.id);

    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplier.id) });
    const attempt = await db.query.matchAttempt.findFirst({
      where: eq(t.matchAttempt.matchId, match!.id),
      with: { candidates: { with: { verdicts: true } } },
    });

    const winner = attempt!.candidates.find((c) => c.entityId === CANDIDATES[0]!.id)!;
    const loser = attempt!.candidates.find((c) => c.entityId === CANDIDATES[1]!.id)!;

    // The winner carries both agents' reads, because both named it.
    expect(new Set(winner.verdicts.map((v) => v.reportedBy))).toEqual(
      new Set(['resolver', 'evaluator']),
    );
    // The loser carries our own run over ITSELF, reported as `rules` — and the
    // reasoning quotes its own label, which is the check that it is not the
    // winner's verdicts wearing the loser's id.
    expect(new Set(loser.verdicts.map((v) => v.reportedBy))).toEqual(new Set(['rules']));
    expect(loser.verdicts.find((v) => v.discriminator === 'name_cover')!.reasoning).toContain(
      'SUMITOMO CORPORATION',
    );
  });

  it('records the rung that surfaced each Candidate, not the highest one climbed', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const attempt = await db.query.matchAttempt.findFirst({
      orderBy: (row, { desc }) => desc(row.createdAt),
      with: { candidates: true },
    });
    if (!attempt) return;

    const byId = new Map(attempt.candidates.map((c) => [c.entityId, c]));
    expect(byId.get(CANDIDATES[0]!.id)?.foundByRung).toBe('R1');
    expect(byId.get(CANDIDATES[1]!.id)?.foundByRung).toBe('R2');
    expect(byId.get(CANDIDATES[1]!.id)?.queryProvenance).toMatch(/rung R2/);
  });
});
