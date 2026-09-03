import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { settleMatch, type CandidateRecord } from '@/domain/match/settle-match';
import { getTestDb, testDatabaseIsUp } from '../../support/test-db';
import { resetDerived } from '../../support/reset';
import { seededProgram } from '../../support/seeded-program';

/**
 * **Resolution evidence kept** (ticket 01 item A, SPEC §6.2/§6.3).
 *
 * `settleMatch` already wrote `candidate.score`, `candidate.matchStrength` and
 * `candidate.explanation` into `match_candidate` — the bug was that nothing
 * upstream of it ever supplied them, so all three read null on every row in
 * the database. `highlight` had no column at all. This is the settler's own
 * contract, tested directly: given the four values, does the row hold them
 * back unchanged, and does `match.match_strength` get the accepted
 * Candidate's own value.
 *
 * The `explanation` / `highlight` bodies below are shaped like the recorded
 * `resolve/rules-r0` fixture's own row for AMERICAN AXLE & MANUFACTURING INC
 * — `score: 216.92903`, `match_strength: {"value": "strong"}`, the `name` /
 * `address` / `country` keys both blocks carry, and `address` entries' own
 * `matchQuality`, per `tests/fixtures/resolve/rules-r0.json` — rather than a
 * live call, per the hard rule against one.
 */

const TEST_ROSTER_NAME = 'Settle Match Evidence Test Co';

const EXPLANATION = {
  name: [
    {
      scores: { fz: 0.87, l1: 1, l2: 1, lv: 0.93, tf: 0.39 },
      matched: '<em>TEST</em> <em>EVIDENCE</em> CO',
      uploaded: 'Test Evidence Co',
      evaluator: 'algo',
      highQualityMatchName: true,
    },
  ],
  address: [
    {
      scores: { '9p': 1 },
      matched: '1 <em>TEST</em> STREET',
      uploaded: '1 Test Street',
      matchQuality: 'high',
    },
  ],
  country: [{ matched: '<em>USA</em>', uploaded: 'USA' }],
};

const HIGHLIGHT = {
  name: ['<em>TEST</em> <em>EVIDENCE</em> CO'],
  address: ['1 <em>TEST</em> STREET'],
  country: ['<em>USA</em>'],
};

type Setup = { supplierId: string; entityId: string };

async function seedSupplierAndEntity(db: Awaited<ReturnType<typeof getTestDb>>): Promise<Setup> {
  const program = await seededProgram(db);
  const entityId = `test-entity-${crypto.randomUUID()}`;

  await db.insert(t.entity).values({ id: entityId, label: 'TEST EVIDENCE CO', country: 'USA' });

  await db
    .delete(t.supplier)
    .where(and(eq(t.supplier.programId, program.id), eq(t.supplier.rosterName, TEST_ROSTER_NAME)));

  const [supplier] = await db
    .insert(t.supplier)
    .values({
      programId: program.id,
      origin: 'imported',
      rosterIndex: 9002,
      rosterName: TEST_ROSTER_NAME,
      rosterAddress: '1 Test Street',
      rosterCountry: 'USA',
    })
    .returning({ id: t.supplier.id });

  return { supplierId: supplier!.id, entityId };
}

describe('settleMatch keeps the four evidence fields, from a body shaped like a recorded one', () => {
  it('reads back score, match_strength, explanation and highlight for a Candidate', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const setup = await seedSupplierAndEntity(db);

    const candidate: CandidateRecord = {
      entityId: setup.entityId,
      foundByRung: 'R1',
      queryProvenance: 'batch resolution pre-pass over the roster row',
      score: 216.92903,
      matchStrength: 'strong',
      explanation: EXPLANATION,
      highlight: HIGHLIGHT,
      verdicts: [{ reportedBy: 'rules', results: [] }],
    };

    await settleMatch(db, {
      supplierId: setup.supplierId,
      status: 'accepted',
      entityId: setup.entityId,
      settledBy: 'rules',
      matchStrength: 'strong',
      candidates: [candidate],
    });

    const match = await db.query.match.findFirst({
      where: eq(t.match.supplierId, setup.supplierId),
    });
    // `match.match_strength` — Sayari's own value for the ACCEPTED Candidate,
    // not merely stored per-candidate.
    expect(match?.matchStrength).toBe('strong');

    const attempt = await db.query.matchAttempt.findFirst({
      where: eq(t.matchAttempt.matchId, match!.id),
      with: { candidates: true },
    });
    const row = attempt?.candidates.find((c) => c.entityId === setup.entityId);
    expect(row, 'the candidate row should exist').toBeTruthy();

    expect(Number(row!.score)).toBeCloseTo(216.92903, 3);
    expect(row!.matchStrength).toBe('strong');
    expect(row!.explanation).toEqual(EXPLANATION);
    // The column ticket 01 item A adds: `highlight` is Sayari's own record of
    // WHAT MATCHED THE TEXT, a different record from `explanation` (its own
    // per-field match-quality record), so its own column rather than folded
    // into one that already means something else.
    expect(row!.highlight).toEqual(HIGHLIGHT);
  });

  it('leaves all four null when the Candidate carries none — an agent-found Candidate has no resolution row', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const setup = await seedSupplierAndEntity(db);

    await settleMatch(db, {
      supplierId: setup.supplierId,
      status: 'accepted',
      entityId: setup.entityId,
      settledBy: 'agents',
      candidates: [
        {
          entityId: setup.entityId,
          foundByRung: 'R2',
          verdicts: [{ reportedBy: 'resolver', results: [] }],
        },
      ],
    });

    const match = await db.query.match.findFirst({
      where: eq(t.match.supplierId, setup.supplierId),
    });
    expect(match?.matchStrength).toBeNull();

    const attempt = await db.query.matchAttempt.findFirst({
      where: eq(t.matchAttempt.matchId, match!.id),
      with: { candidates: true },
    });
    const row = attempt?.candidates.find((c) => c.entityId === setup.entityId);
    expect(row?.score).toBeNull();
    expect(row?.matchStrength).toBeNull();
    expect(row?.explanation).toBeNull();
    expect(row?.highlight).toBeNull();
  });
});
