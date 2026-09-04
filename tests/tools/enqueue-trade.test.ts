import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { getRegistry } from '@/tools';
import type { Estimate, ToolContext } from '@/tools';
import { getTestDb, testDatabaseIsUp, type TestDb } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { seededProgram } from '../support/seeded-program';

/**
 * `enqueue_trade`'s confirm estimate and its `enqueueJob(kind: 'trade', ...)`
 * call shape (network spec §4.3, §8; ticket 05, unit 05c).
 *
 * **`openRun`/`enqueueJob` are mocked at the module boundary, unlike
 * `enqueue_check_every_pair`'s own test** (`enqueue-check-every-pair.test.ts`,
 * which calls the real functions because `pairs` was already a live `JobKind`/
 * `RunTrigger` member when that test was written). `trade` is neither yet —
 * both live in unit 05b's files (`src/config/constants.ts`'s `JOB_CAPS`,
 * `src/jobs/runs.ts`'s `RunTrigger`), not yet merged into this branch's base —
 * so the real `enqueueJob` would throw reading `JOB_CAPS['trade']` before this
 * suite could assert anything about the call it made. Mocking is exactly what
 * this ticket's own brief asks for: prove the CALL SHAPE
 * (`kind: 'trade'`, `subjectType: 'supplier'`, `subjectId`, `params.
 * categoryId`), not that a real Job row landed — the same division
 * `recommend-concentration.test.ts` keeps for `findAndWriteShortestPath`.
 */
vi.mock('@/jobs/runs', () => ({
  openRun: vi.fn(),
  enqueueJob: vi.fn(),
}));

import { enqueueJob, openRun } from '@/jobs/runs';

const mockOpenRun = vi.mocked(openRun);
const mockEnqueueJob = vi.mocked(enqueueJob);

async function firstSupplier(
  db: TestDb,
  programId: string,
): Promise<{ id: string; rosterName: string | null }> {
  const [row] = await db
    .select({ id: t.supplier.id, rosterName: t.supplier.rosterName })
    .from(t.supplier)
    .where(eq(t.supplier.programId, programId))
    .orderBy(t.supplier.rosterIndex)
    .limit(1);
  if (!row) throw new Error('the approved Program has no seeded suppliers');
  return row;
}

async function firstCategory(db: TestDb, programId: string): Promise<string> {
  const category = await db.query.category.findFirst({
    where: (row, { eq: equals }) => equals(row.programId, programId),
  });
  if (!category) throw new Error('the approved Program has no seeded categories');
  return category.id;
}

const CTX: ToolContext = {
  db: {} as never, // the estimator reads no local row at all — see its own doc comment
  upstream: {} as never, // an estimator reads local rows only — never touches this
  meter: { addModelTokens: () => {} },
  runId: 'unused-by-this-estimator',
  surface: 'chat',
};

describe('enqueue_trade', () => {
  beforeEach(() => {
    mockOpenRun.mockReset();
    mockEnqueueJob.mockReset();
  });

  it('is confirm-gated — presence of `confirm` IS the gate', () => {
    const tool = getRegistry().byName.get('enqueue_trade');
    expect(tool).toBeTruthy();
    expect(tool!.confirm).toBeTypeOf('function');
    expect(tool!.enqueues).toBe('trade');
    expect(tool!.effect).toBe('write');
    expect(tool!.spends).toEqual(['sayari']);
    expect(tool!.surfaces).toEqual(['chat']);
    expect(tool!.latency).toBe('fast');
  });

  it('estimates a fixed 4 sayariCalls, with no arithmetic and no local row read', async () => {
    const tool = getRegistry().byName.get('enqueue_trade')!;
    const result: Estimate = await tool.confirm!(
      { supplierId: 'irrelevant-to-the-estimate', categoryId: 'irrelevant-to-the-estimate' },
      CTX,
    );
    expect(result.spends.sayariCalls).toBe(4);
    expect(result.basis.toLowerCase()).toContain('four');
    expect(result.caveats.join(' ')).toMatch(/never deducted/);
  });

  it('handler objects when the supplier does not exist, and touches neither mock', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const tool = getRegistry().byName.get('enqueue_trade')!;
    const ctx: ToolContext = { ...CTX, db };
    // `supplier.id` is a uuid column — a well-formed uuid nothing seeds, so the
    // query itself succeeds and returns no row, rather than erroring on shape.
    const noSuchSupplier = '00000000-0000-0000-0000-000000000000';

    const result = await tool.handler(
      { supplierId: noSuchSupplier, categoryId: '00000000-0000-0000-0000-000000000000' },
      ctx,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.objections[0]).toContain(noSuchSupplier);
    expect(mockOpenRun).not.toHaveBeenCalled();
    expect(mockEnqueueJob).not.toHaveBeenCalled();
  });

  it('handler opens a Run and enqueues a supplier-subject trade Job carrying categoryId in params', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);
    const program = await seededProgram(db);
    const supplier = await firstSupplier(db, program.id);
    const categoryId = await firstCategory(db, program.id);

    mockOpenRun.mockResolvedValue('mock-run-id');
    mockEnqueueJob.mockResolvedValue('mock-job-id');

    const tool = getRegistry().byName.get('enqueue_trade')!;
    const ctx: ToolContext = { ...CTX, db };
    const result = await tool.handler({ supplierId: supplier.id, categoryId }, ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ runId: 'mock-run-id', jobId: 'mock-job-id' });

    expect(mockOpenRun).toHaveBeenCalledTimes(1);
    expect(mockOpenRun).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ programId: program.id, trigger: 'trade', supplierCount: 1 }),
    );

    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueJob).toHaveBeenCalledWith(db, {
      runId: 'mock-run-id',
      kind: 'trade',
      subjectType: 'supplier',
      subjectId: supplier.id,
      params: { categoryId },
    });
  });
});
