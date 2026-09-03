import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { loadParkedRow } from '@/db/queries/needs-review';
import { settleMatch, type CandidateRecord } from '@/domain/match/settle-match';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { seededProgram } from '../support/seeded-program';

/**
 * `loadParkedRow` (SPEC §6.8; ticket 01 item A follow-up, E1).
 *
 * **Narrowed to the columns this page renders.** `match_candidate` now
 * carries `explanation`/`highlight` (2–8 KB each), and this view has nothing
 * to say about Sayari's own resolution evidence, only about the
 * Discriminator ladder — so the query selects `id`/`foundByRung`/
 * `queryProvenance` and the entity columns used, never the whole row. Proven
 * here by function, not by inspecting the generated SQL: the same shape a
 * whole-row select would have produced, aggregated the same way across
 * attempts.
 */

const TEST_ROSTER_NAME = 'Needs Review Query Test Co';

async function seedSupplierAndEntities(db: Awaited<ReturnType<typeof getTestDb>>) {
  const program = await seededProgram(db);
  const entityA = `needs-review-query-a-${crypto.randomUUID()}`;
  const entityB = `needs-review-query-b-${crypto.randomUUID()}`;

  await db.insert(t.entity).values([
    {
      id: entityA,
      label: 'CANDIDATE A CO',
      country: 'USA',
      city: 'Detroit',
      addressLine: '1 Test Street',
      lei: 'LEI-A',
      distinctSourceCount: 2,
    },
    { id: entityB, label: 'CANDIDATE B CO', country: 'USA' },
  ]);

  await db
    .delete(t.supplier)
    .where(and(eq(t.supplier.programId, program.id), eq(t.supplier.rosterName, TEST_ROSTER_NAME)));
  const [supplier] = await db
    .insert(t.supplier)
    .values({
      programId: program.id,
      origin: 'imported',
      rosterIndex: 9003,
      rosterName: TEST_ROSTER_NAME,
      rosterAddress: '1 Test Street',
      rosterCountry: 'USA',
    })
    .returning({ id: t.supplier.id });

  return { programId: program.id, supplierId: supplier!.id, entityA, entityB };
}

const candidate = (entityId: string, rung: string): CandidateRecord => ({
  entityId,
  foundByRung: rung,
  queryProvenance: `found at rung ${rung}`,
  score: 12,
  matchStrength: 'strong',
  explanation: { name: [{ match_quality: 'high' }] },
  highlight: { name: ['<em>x</em>'] },
  verdicts: [
    {
      reportedBy: 'rules',
      results: [{ discriminator: 'country', verdict: 'pass', reasoning: 'same country' }],
    },
  ],
});

describe('loadParkedRow', () => {
  it('reads back a parked row, with candidates deduped and verdicts merged across attempts', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const { programId, supplierId, entityA, entityB } = await seedSupplierAndEntities(db);

    // Attempt 1: candidate A only, parked.
    await settleMatch(db, {
      supplierId,
      status: 'needs_review',
      entityId: null,
      settledBy: 'rules',
      candidates: [candidate(entityA, 'R1')],
    });
    // Attempt 2: candidate A again (a second sighting of the same entity, a
    // different rung) plus candidate B — proves the cross-attempt dedupe.
    await settleMatch(db, {
      supplierId,
      status: 'needs_review',
      entityId: null,
      settledBy: 'agents',
      candidates: [candidate(entityA, 'R2'), candidate(entityB, 'R1')],
    });

    const detail = await loadParkedRow(db, { programId, supplierId });
    expect(detail).toBeTruthy();
    expect(detail!.attempts).toHaveLength(2);

    // One row per entity, not one per (attempt, entity) pair.
    expect(detail!.candidates).toHaveLength(2);
    const a = detail!.candidates.find((c) => c.entityId === entityA)!;
    expect(a).toBeTruthy();
    expect(a.label).toBe('CANDIDATE A CO');
    expect(a.city).toBe('Detroit');
    expect(a.lei).toBe('LEI-A');
    expect(a.distinctSourceCount).toBe(2);
    // Both attempts' verdicts for entity A survive, merged onto one row.
    expect(a.verdicts.length).toBeGreaterThanOrEqual(2);

    const b = detail!.candidates.find((c) => c.entityId === entityB)!;
    expect(b).toBeTruthy();
    expect(b.label).toBe('CANDIDATE B CO');
    // No explicit cleanup: random per-run entity ids never collide, and
    // `resetDerived()` clears the derived rows referencing them next run.
  });

  it('returns null for a program id that names no program', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const { supplierId } = await seedSupplierAndEntities(db);

    const detail = await loadParkedRow(db, {
      programId: '00000000-0000-0000-0000-000000000000',
      supplierId,
    });
    expect(detail).toBeNull();
  });
});
