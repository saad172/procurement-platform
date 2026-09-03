import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { getRegistry } from '@/tools';
import type { Estimate, ToolContext } from '@/tools';
import { getTestDb, testDatabaseIsUp, type TestDb } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { seededProgram } from '../support/seeded-program';

/**
 * `enqueue_check_every_pair`'s own estimate arithmetic and confirm gate
 * (network spec §7; ticket 04, unit 04e).
 *
 * The estimator's whole job is `n(n-1)/2` over the accepted Suppliers
 * actually bidding one Category — never a guess, never a call — mirroring
 * `enqueue_deep_traversal`'s own arithmetic-over-caps estimator. `PWR` is the
 * seed roster's widest Category (`src/db/seed-data/roster.ts`'s own
 * comment); this suite only reads its authored rows and writes derived
 * `match`/`entity` rows of its own, cleared between tests by `resetDerived`.
 */

/** A settled, accepted Match on `entityId` — the only fact the estimator reads a Supplier for. */
async function accept(db: TestDb, supplierId: string, entityId: string): Promise<void> {
  await db.insert(t.entity).values({ id: entityId, label: entityId }).onConflictDoNothing();
  await db.insert(t.match).values({ supplierId, status: 'accepted', entityId, settledBy: 'human' });
}

async function pwrCategory(db: TestDb) {
  const program = await seededProgram(db);
  const category = await db.query.category.findFirst({
    where: (row, { and: allOf, eq: equals }) =>
      allOf(equals(row.programId, program.id), equals(row.code, 'PWR')),
  });
  if (!category) throw new Error('seed roster no longer carries a PWR category');
  const bidders = await db
    .select({ supplierId: t.supplierCategory.supplierId })
    .from(t.supplierCategory)
    .where(eq(t.supplierCategory.categoryId, category.id));
  return { programId: program.id, categoryId: category.id, supplierIds: bidders.map((b) => b.supplierId) };
}

/** The gate as chat reaches it: the registry's own tool and its `confirm`. */
async function estimate(
  db: TestDb,
  runId: string,
  input: { programId: string; categoryId: string },
): Promise<Estimate> {
  const ctx: ToolContext = {
    db,
    upstream: {} as never, // an estimator reads local rows only — never touches this
    meter: { addModelTokens: () => {} },
    runId,
    surface: 'chat',
  };
  const tool = getRegistry().byName.get('enqueue_check_every_pair')!;
  return tool.confirm!(input, ctx);
}

async function openEstimateRun(db: TestDb, programId: string): Promise<string> {
  const [run] = await db
    .insert(t.run)
    .values({ programId, state: 'running', trigger: 'thread', subjectLabel: 'estimate only' })
    .returning({ id: t.run.id });
  return run!.id;
}

describe('enqueue_check_every_pair', () => {
  it('is confirm-gated — presence of `confirm` IS the gate', () => {
    const tool = getRegistry().byName.get('enqueue_check_every_pair');
    expect(tool).toBeTruthy();
    expect(tool!.confirm).toBeTypeOf('function');
    expect(tool!.enqueues).toBe('pairs');
    expect(tool!.effect).toBe('write');
    expect(tool!.spends).toEqual(['sayari']);
  });

  it('estimates n(n-1)/2 sayariCalls over the accepted suppliers actually bidding the category', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const { programId, categoryId, supplierIds } = await pwrCategory(db);
    expect(supplierIds.length).toBeGreaterThanOrEqual(4);
    const [s1, s2, s3, s4] = supplierIds;

    await accept(db, s1!, 'estimate-ent-1');
    await accept(db, s2!, 'estimate-ent-2');
    await accept(db, s3!, 'estimate-ent-3');
    await accept(db, s4!, 'estimate-ent-4');
    // A fifth bidder left unsettled must not count toward n.
    const runId = await openEstimateRun(db, programId);

    const result = await estimate(db, runId, { programId, categoryId });

    // 4 accepted suppliers -> C(4,2) = 6 pairs.
    expect(result.spends.sayariCalls).toEqual({ min: 0, max: 6 });
    expect(result.what).toContain('4');
    expect(result.basis).toContain('6');
  });

  it('does not count a supplier whose match is unsettled or needs review', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const { programId, categoryId, supplierIds } = await pwrCategory(db);
    const [s1, s2, s3] = supplierIds;

    await accept(db, s1!, 'estimate-ur-1');
    await accept(db, s2!, 'estimate-ur-2');
    await db.insert(t.match).values({
      supplierId: s3!,
      status: 'needs_review',
      settledBy: 'human',
    });
    const runId = await openEstimateRun(db, programId);

    const result = await estimate(db, runId, { programId, categoryId });

    // 2 accepted suppliers -> C(2,2-1)/... = 1 pair, not 3.
    expect(result.spends.sayariCalls).toEqual({ min: 0, max: 1 });
  });

  it('reports no pair to check when fewer than two suppliers are accepted', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const { programId, categoryId, supplierIds } = await pwrCategory(db);

    await accept(db, supplierIds[0]!, 'estimate-solo');
    const runId = await openEstimateRun(db, programId);

    const result = await estimate(db, runId, { programId, categoryId });

    expect(result.spends.sayariCalls).toEqual({ min: 0, max: 0 });
    expect(result.what.toLowerCase()).toContain('no pair');
  });

  it('reads local rows only — never touches upstream to produce the estimate', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const { programId, categoryId, supplierIds } = await pwrCategory(db);
    await accept(db, supplierIds[0]!, 'estimate-noupstream-1');
    await accept(db, supplierIds[1]!, 'estimate-noupstream-2');
    const runId = await openEstimateRun(db, programId);

    // `upstream: {} as never` above would throw the moment anything on it is
    // called — reaching a result at all is the proof nothing did.
    await expect(estimate(db, runId, { programId, categoryId })).resolves.toBeTruthy();
  });

  it('handler opens a Run with trigger "pairs" and enqueues a category-subject pairs Job', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const { programId, categoryId } = await pwrCategory(db);

    const tool = getRegistry().byName.get('enqueue_check_every_pair')!;
    const ctx: ToolContext = {
      db,
      upstream: {} as never,
      meter: { addModelTokens: () => {} },
      runId: 'unused-by-this-handler',
      surface: 'chat',
    };
    const result = await tool.handler({ programId, categoryId }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { runId, jobId } = result.data as { runId: string; jobId: string };

    const run = await db.query.run.findFirst({ where: eq(t.run.id, runId) });
    expect(run?.trigger).toBe('pairs');
    expect(run?.programId).toBe(programId);

    const job = await db.query.job.findFirst({ where: eq(t.job.id, jobId) });
    expect(job?.kind).toBe('pairs');
    expect(job?.subjectType).toBe('category');
    expect(job?.subjectId).toBe(categoryId);
    expect(job?.state).toBe('queued');
  });
});
