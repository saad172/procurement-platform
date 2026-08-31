'use server';

import { revalidatePath } from 'next/cache';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { enqueueJob, openRun } from '@/jobs/runs';
import { RUN_BUDGET_USD_PER_SUPPLIER } from '@/config/constants';

/**
 * The **Run affordance** (SPEC §4.3, §5.1).
 *
 * *"The reviewer's first action is Run, not an import."* Everything the app can
 * do starts here, and every one of these opens **its own Run** — because every
 * amount the app spends has to sit inside exactly one Run with no orphan path,
 * and charging a later decision to an earlier run would move a total somebody
 * has already read.
 *
 * The count defaults to **10 of 50** with the full roster one click away. Ten is
 * not timidity: a full run is fifty resolve ladders and fifty enrichment
 * fan-outs, and a reviewer who wants to see the shape of the thing should not
 * have to spend the whole budget to do it.
 */

/** What a Run of this size will cost, from the committed constant. */
function estimate(supplierCount: number): string {
  return (RUN_BUDGET_USD_PER_SUPPLIER * supplierCount).toFixed(2);
}

/**
 * Resolve, then enrich, for the next `count` unresolved Suppliers.
 *
 * **Unresolved first, in roster order.** Re-running a Supplier that already has
 * a Match spends for no new information, and taking them in roster order makes
 * "the first ten" mean the same thing twice.
 */
export async function startRun(formData: FormData): Promise<void> {
  const programId = String(formData.get('programId'));
  const count = Math.max(1, Math.min(50, Number(formData.get('count') ?? 10)));

  const db = getPooledDb();

  const unresolved = await db
    .select({ id: t.supplier.id, name: t.supplier.rosterName })
    .from(t.supplier)
    .leftJoin(t.match, eq(t.match.supplierId, t.supplier.id))
    .where(and(eq(t.supplier.programId, programId), isNull(t.match.id)))
    .orderBy(asc(t.supplier.rosterIndex))
    .limit(count);

  if (unresolved.length === 0) return;

  const runId = await openRun(db, {
    programId,
    trigger: 'full',
    subjectLabel: `resolve and enrich ${unresolved.length} supplier(s)`,
    supplierCount: unresolved.length,
  });

  /**
   * Only `resolve` is queued. Enrichment depends on a settled Match, and a Job
   * queued now would dequeue before its Supplier had one — so the worker
   * enqueues the follow-on when a Match lands, and a row that parks at
   * `needs_review` correctly never gets one.
   */
  for (const supplier of unresolved) {
    await enqueueJob(db, { runId, kind: 'resolve', subjectType: 'supplier', subjectId: supplier.id });
  }

  revalidatePath(`/program/${programId}`);
  revalidatePath(`/program/${programId}/runs`);
}

/** One Supplier, re-run end to end. Its own Run, subject-labelled. */
export async function reassessSupplier(formData: FormData): Promise<void> {
  const programId = String(formData.get('programId'));
  const supplierId = String(formData.get('supplierId'));

  const db = getPooledDb();
  const supplier = await db.query.supplier.findFirst({ where: eq(t.supplier.id, supplierId) });
  if (!supplier) return;

  const runId = await openRun(db, {
    programId,
    trigger: 'reassess',
    subjectLabel: `re-assess ${supplier.rosterName ?? supplierId}`,
    supplierCount: 1,
  });
  await enqueueJob(db, { runId, kind: 'assess', subjectType: 'supplier', subjectId: supplierId });

  revalidatePath(`/program/${programId}/supplier/${supplierId}`);
  revalidatePath(`/program/${programId}/runs`);
}

/** Re-fetch the six enrichment sources for one Supplier and re-score it. */
export async function reenrichSupplier(formData: FormData): Promise<void> {
  const programId = String(formData.get('programId'));
  const supplierId = String(formData.get('supplierId'));

  const db = getPooledDb();
  const supplier = await db.query.supplier.findFirst({ where: eq(t.supplier.id, supplierId) });
  if (!supplier) return;

  const runId = await openRun(db, {
    programId,
    trigger: 'full',
    subjectLabel: `re-enrich ${supplier.rosterName ?? supplierId}`,
    supplierCount: 1,
  });
  await enqueueJob(db, { runId, kind: 'enrich', subjectType: 'supplier', subjectId: supplierId });

  revalidatePath(`/program/${programId}/supplier/${supplierId}`);
  revalidatePath(`/program/${programId}/runs`);
}

/** A Recommendation for one Category. Always a new version; the diff may be empty. */
export async function runRecommendation(formData: FormData): Promise<void> {
  const programId = String(formData.get('programId'));
  const categoryId = String(formData.get('categoryId'));

  const db = getPooledDb();
  const category = await db.query.category.findFirst({ where: eq(t.category.id, categoryId) });
  if (!category) return;

  const runId = await openRun(db, {
    programId,
    trigger: 'rerun_recommendation',
    subjectLabel: `recommend ${category.code}`,
    supplierCount: 1,
  });
  await enqueueJob(db, { runId, kind: 'recommend', subjectType: 'category', subjectId: categoryId });

  revalidatePath(`/program/${programId}/category/${categoryId}`);
  revalidatePath(`/program/${programId}/runs`);
}

/** Discover proposes Leads from trade data. It proposes and never adds. */
export async function runDiscover(formData: FormData): Promise<void> {
  const programId = String(formData.get('programId'));
  const categoryId = String(formData.get('categoryId'));

  const db = getPooledDb();
  const runId = await openRun(db, {
    programId,
    trigger: 'discover',
    subjectLabel: 'discover leads',
    supplierCount: 1,
  });
  await enqueueJob(db, { runId, kind: 'discover', subjectType: 'category', subjectId: categoryId });

  revalidatePath(`/program/${programId}/category/${categoryId}`);
  revalidatePath(`/program/${programId}/runs`);
}

/**
 * **Resume** a run paused on budget (SPEC §18.4).
 *
 * The increment is the same formula applied to the Suppliers still unfinished —
 * *"adds $18 for the 6 suppliers left"* — because a flat step is arbitrary and a
 * free-text box would hole the code-constant discipline.
 */
export async function resumeRun(formData: FormData): Promise<void> {
  const programId = String(formData.get('programId'));
  const runId = String(formData.get('runId'));

  const db = getPooledDb();
  const [remaining] = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(t.job)
    .where(and(eq(t.job.runId, runId), inArray(t.job.state, ['queued', 'paused_on_budget'])))) as [
    { n: number },
  ];

  await db
    .update(t.run)
    .set({
      state: 'running',
      budgetUsd: sql`coalesce(${t.run.budgetUsd}, 0) + ${estimate(remaining?.n ?? 1)}`,
    })
    .where(eq(t.run.id, runId));

  // The Jobs it paused go back in the queue; the worker picks them up.
  await db
    .update(t.job)
    .set({ state: 'queued' })
    .where(and(eq(t.job.runId, runId), eq(t.job.state, 'paused_on_budget')));

  revalidatePath(`/program/${programId}/runs/${runId}`);
  revalidatePath(`/program/${programId}/runs`);
}
