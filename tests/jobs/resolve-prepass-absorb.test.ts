import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import {
  resolveSupplier,
  toCandidateFacts,
  type PrepassCandidateInfo,
  type ResolveDeps,
} from '@/jobs/resolve';
import { runDiscriminators } from '@/domain/match/discriminators';
import { PREPASS_CANDIDATES } from '@/config/constants';
import { seedTestProgram } from '@/db/seed-test-program';
import { TEST_PROGRAM } from '@/db/seed-data/test-program';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';

/**
 * **C4.** `resolveSupplier` only ever fetched the first `PREPASS_CANDIDATES`
 * (5) rows of the batch pre-pass via `getEntity`, but the ladder's `Map` of
 * pre-pass evidence used to be built from that same sliced list — so a
 * Candidate an agent surfaced later from row 6+ of the pre-pass (a real row
 * Sayari's own resolution scored, just ranked below the fetch cutoff)
 * settled with null evidence: no `score`, no `match_strength`, nothing to
 * show on the Needs Review ladder or in `match_candidate`.
 *
 * Fixed by building the Map from the UNSLICED pre-pass list and consulting
 * it in `absorbCandidates`, whichever rung actually surfaced the Candidate.
 */

const ROSTER = {
  name: 'Sumitomo',
  address: 'Marunouchi, Chiyoda-ku, Tokyo',
  country: 'JPN',
  hasCategory: true,
};

/** Six pre-pass rows — one more than `PREPASS_CANDIDATES` fetches. */
const CANDIDATES = Array.from({ length: PREPASS_CANDIDATES + 1 }, (_, i) => ({
  id: `${String.fromCharCode(65 + i).repeat(22)}`,
  label: `SUMITOMO ROW ${i + 1}`,
  countries: ['JPN'],
}));
const ROW_SIX = CANDIDATES[PREPASS_CANDIDATES]!;

const prepassCandidates: PrepassCandidateInfo[] = CANDIDATES.map((c, i) => ({
  entityId: c.id,
  score: 1000 - i,
  matchStrength: i === PREPASS_CANDIDATES ? 'strong' : 'weak',
  explanation: undefined,
  highlight: undefined,
}));

const upstream = {
  sayari: {
    getEntity: async ({ id }: { id: string }) => {
      const found = CANDIDATES.find((c) => c.id === id);
      if (!found) throw new Error(`no such candidate ${id}`);
      return { data: found, cacheHit: true };
    },
  },
} as never;

describe('a Candidate an agent surfaces from row 6+ of the pre-pass keeps its own evidence (C4)', () => {
  it('carries the pre-pass score and match_strength onto the stored match_candidate row', async () => {
    if (!(await testDatabaseIsUp())) return;
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

    // `runRound` is invoked BEFORE row six is absorbed into `state.seen` — it
    // is what the round's own search rung is about to find, not something it
    // was handed — so its Discriminator facts are built directly rather than
    // looked up from the round's `candidates` argument.
    const rowSixFacts = toCandidateFacts(ROW_SIX as never);
    const runRound: NonNullable<ResolveDeps['runRound']> = async () => {
      const verdicts = runDiscriminators(ROSTER, rowSixFacts);
      return {
        // Both agents agree on row six — a real pre-pass row `gatherPrepassCandidates`
        // never fetched, only found here because the round's own search rung
        // named it.
        resolverPick: ROW_SIX.id,
        evaluatorPick: ROW_SIX.id,
        resolverVerdicts: verdicts,
        evaluatorVerdicts: verdicts,
        objection: undefined,
        rungsUsed: ['R1', 'R2'],
        entityIdsSeen: [{ entityId: ROW_SIX.id, rung: 'R2' }],
      };
    };

    const outcome = await resolveSupplier(
      { db, upstream, runRound },
      { supplierId: supplier.id, roster: ROSTER, prepassCandidates },
    );

    expect(outcome.status).toBe('accepted');
    expect(outcome.entityId).toBe(ROW_SIX.id);

    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplier.id) });
    const attempt = await db.query.matchAttempt.findFirst({
      where: eq(t.matchAttempt.matchId, match!.id),
      with: { candidates: true },
    });
    const row = attempt!.candidates.find((c) => c.entityId === ROW_SIX.id)!;

    // Row six's own pre-pass evidence, not null — the fix.
    expect(Number(row.score)).toBe(1000 - PREPASS_CANDIDATES);
    expect(row.matchStrength).toBe('strong');
    // And it made it onto the settled Match too (A2).
    expect(match?.matchStrength).toBe('strong');
  });
});
