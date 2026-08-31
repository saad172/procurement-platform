import { describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { settleMatch } from '@/domain/match/settle-match';
import { settleRowByHand } from '@/jobs/settle-by-hand';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';

/**
 * Settling a parked row by hand, against the real database.
 *
 * **The before and after.** The form used to read a 22-character entity id out
 * of a free-text box and pass it to `settleMatch` unread. The foreign key and
 * the transaction meant bad data never reached a table — so this was never a
 * corruption bug — but a typo surfaced as an *unhandled error with no message*:
 * a 500 on a page carrying one form per parked row, which does not say which
 * row threw or what was wrong with it.
 *
 * What is asserted here is that every refusal is now a sentence and **writes
 * nothing**, and that the two paths that should write do write: the run opens,
 * the attempt appends, and enrichment is queued behind the run that the
 * decision paid for.
 *
 * The candidates are real rows rather than a fake, because the thing being
 * tested is precisely whether the id is checked against them.
 */

const ENTITY_A = 'AAAAAAAAAAAAAAAAAAAAAA';
const ENTITY_B = 'BBBBBBBBBBBBBBBBBBBBBB';
/** Well-formed, in the store, and never a candidate for this row. */
const ELSEWHERE = 'CCCCCCCCCCCCCCCCCCCCCC';

async function park() {
  const db = await getTestDb();
  await resetDerived(db);

  /**
   * The Programme comes from the Supplier, never from `findFirst()` — a second
   * Programme is seeded on purpose (SPEC §19.3) and `findFirst` returns
   * whichever one the planner happens to reach first.
   */
  const supplier = await db.query.supplier.findFirst({
    where: (row, { eq: is }) => is(row.rosterName, 'NSK'),
  });

  for (const [id, label] of [
    [ENTITY_A, 'NSK LTD.'],
    [ENTITY_B, 'NSK LTD /ADR/'],
    [ELSEWHERE, 'SOMEBODY ELSE LTD.'],
  ]) {
    await db.insert(t.entity).values({ id: id!, label: label!, country: 'JPN' }).onConflictDoNothing();
  }

  // Parked by an agent, with two candidates — the state the page renders.
  await settleMatch(db, {
    supplierId: supplier!.id,
    status: 'needs_review',
    entityId: null,
    settledBy: 'agents',
    candidates: [
      { entityId: ENTITY_A, foundByRung: 'R1', verdicts: [] },
      { entityId: ENTITY_B, foundByRung: 'R2', verdicts: [] },
    ],
  });

  return { db, programId: supplier!.programId, supplierId: supplier!.id };
}

const form = (fields: Record<string, string>) => new Map(Object.entries(fields));

describe('a refusal is a sentence, and writes nothing', () => {
  /** Absent from the candidates is not a reason to refuse: it is the point of the escape hatch. */
  it('settles on a record in the store that this row never listed', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, programId, supplierId } = await park();

    const before = await db.select().from(t.run);
    const outcome = await settleRowByHand(db, {
      fields: form({ choice: 'other', entityId: ELSEWHERE }),
      supplierId,
      programId,
    });

    // It exists in the store, so it settles — being absent from the candidates
    // is not a reason to refuse a record somebody found in Sayari's own UI.
    expect(outcome.ok).toBe(true);
    expect(await db.select().from(t.run)).toHaveLength(before.length + 1);
  });

  /**
   * The path that used to 500. `settleMatch` would have thrown on the foreign
   * key with nothing said about which form or which id.
   */
  it('refuses an id that is not in the entity store, without touching the database', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, programId, supplierId } = await park();

    const attemptsBefore = await db.select().from(t.matchAttempt);
    const outcome = await settleRowByHand(db, {
      fields: form({ choice: 'other', entityId: 'ZZZZZZZZZZZZZZZZZZZZZZ' }),
      supplierId,
      programId,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(/is not a record this app has fetched/);
    // Nothing written: no attempt, no run, and the Match still parked.
    expect(await db.select().from(t.matchAttempt)).toHaveLength(attemptsBefore.length);
    expect(await db.select().from(t.run)).toHaveLength(0);
    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplierId) });
    expect(match!.status).toBe('needs_review');
  });

  it('refuses a malformed id before it reaches the database at all', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, programId, supplierId } = await park();

    const outcome = await settleRowByHand(db, {
      fields: form({ choice: 'other', entityId: 'oops' }),
      supplierId,
      programId,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(/22 characters/);
    expect(await db.select().from(t.run)).toHaveLength(0);
  });

  it('refuses a roster row that belongs to another programme', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, supplierId } = await park();

    const outcome = await settleRowByHand(db, {
      fields: form({ choice: `entity:${ENTITY_A}` }),
      supplierId,
      programId: '00000000-0000-0000-0000-000000000000',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toMatch(/not in this programme/);
    expect(await db.select().from(t.run)).toHaveLength(0);
  });
});

describe('settling on a listed candidate', () => {
  it('accepts it, appends an attempt, and opens a run of its own', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, programId, supplierId } = await park();

    const outcome = await settleRowByHand(db, {
      fields: form({ choice: `entity:${ENTITY_A}`, note: 'Two sources where the rest have one.' }),
      supplierId,
      programId,
    });
    expect(outcome).toMatchObject({ ok: true, settled: 'accepted' });

    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplierId) });
    expect(match!.status).toBe('accepted');
    expect(match!.entityId).toBe(ENTITY_A);
    expect(match!.settledBy).toBe('human');

    /**
     * **Append-only.** The agent's parked attempt and the human override are
     * both on the record; one erasing the other would lose the disagreement
     * that is the whole reason the row reached a person.
     */
    const attempts = await db
      .select()
      .from(t.matchAttempt)
      .where(eq(t.matchAttempt.matchId, match!.id))
      .orderBy(desc(t.matchAttempt.attemptN));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.settledBy).toBe('human');
    expect(attempts[0]!.note).toBe('Two sources where the rest have one.');
    expect(attempts[1]!.settledBy).toBe('agents');

    // The spend the decision unblocked is attributable to the decision.
    const runs = await db.select().from(t.run);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe('settlement');
    expect(runs[0]!.subjectLabel).toBe('settle NSK');

    const jobs = await db.select().from(t.job).where(eq(t.job.runId, outcome.ok ? outcome.runId : ''));
    expect(jobs.map((job) => job.kind)).toEqual(['enrich']);
  });
});

describe('not found is a finding, and is recorded as one', () => {
  it('settles the row and queues nothing, because nothing was unblocked', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, programId, supplierId } = await park();

    const outcome = await settleRowByHand(db, {
      fields: form({ choice: 'not_found', note: 'None of the nine is the roster company.' }),
      supplierId,
      programId,
    });
    expect(outcome).toMatchObject({ ok: true, settled: 'not_found' });

    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplierId) });
    expect(match!.status).toBe('not_found');
    expect(match!.entityId).toBeNull();

    /**
     * A Run still opens. It cost nothing, and a settlement with no Run would be
     * the one decision on the branch with no place in the spend ledger.
     */
    const runs = await db.select().from(t.run);
    expect(runs).toHaveLength(1);
    const jobs = await db.select().from(t.job);
    expect(jobs).toHaveLength(0);
  });

  /** An empty box is not a finding, and no longer submits as one. */
  it('does not read an empty escape hatch as not found', async () => {
    if (!(await testDatabaseIsUp())) return;
    const { db, programId, supplierId } = await park();

    const outcome = await settleRowByHand(db, {
      fields: form({ choice: 'other', entityId: '' }),
      supplierId,
      programId,
    });
    expect(outcome.ok).toBe(false);
    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplierId) });
    expect(match!.status).toBe('needs_review');
  });
});
