'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import {
  cancelRun as cancelRunState,
  enqueueJob,
  openRun,
  requeueJobs,
  resumeRun as resumeRunBudget,
  settleRunState,
} from '@/jobs/runs';
import { loadWorkerHealth, retryableJobs, suppliersNeeding } from '@/db/queries/runs';

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

/**
 * Where a click on Run should land.
 *
 * **The Run page, every time.** Enqueuing changes nothing the page you clicked
 * from renders — the unresolved count only falls when a Match lands — so
 * staying put makes a started Run indistinguishable from a dropped click. The
 * Run page is the one surface that shows Jobs moving, and it carries the
 * breadcrumb back to wherever the result will appear.
 *
 * `redirect` throws, so it is the last thing every action does.
 */
function toRun(programId: string, runId: string): never {
  revalidatePath(`/program/${programId}`);
  revalidatePath(`/program/${programId}/runs`);
  redirect(`/program/${programId}/runs/${runId}` as never);
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
    trigger: 'pipeline',
    subjectLabel: `run ${unresolved.length} supplier(s) end to end`,
    supplierCount: unresolved.length,
  });

  /**
   * Only `resolve` is queued, and the Run carries the rest.
   *
   * Every later stage depends on the previous one's output — enrichment needs a
   * settled Match, an assessment needs criterion values — so a Job queued now
   * would dequeue before the thing it reads existed. The worker chains each hop
   * as the one before it succeeds, into this same Run, which is why a row that
   * parks at `needs_review` correctly gets neither.
   */
  for (const supplier of unresolved) {
    await enqueueJob(db, {
      runId,
      kind: 'resolve',
      subjectType: 'supplier',
      subjectId: supplier.id,
    });
  }

  toRun(programId, runId);
}

/**
 * **Enrich the roster** — the stage a Run reaches but never finishes for you.
 *
 * The worker chains `resolve → enrich` when a Match is accepted, so a run that
 * completes normally leaves nothing here to do. It exists because that chain is
 * the *only* thing that queues an enrichment: a roster resolved by a worker
 * that lacked the chaining, or settled through Needs Review before it existed,
 * has forty-nine accepted Matches and no way to enrich them short of forty-nine
 * clicks on forty-nine Supplier pages.
 *
 * **Enrichment runs no model** (SPEC §7.1). It spends upstream calls, and the
 * per-Supplier dollar constant is a whole-pipeline ceiling rather than a
 * forecast of this — which is why the panel says so instead of quoting it flat.
 */
export async function enrichRoster(formData: FormData): Promise<void> {
  const programId = String(formData.get('programId'));
  const count = Math.max(1, Math.min(50, Number(formData.get('count') ?? 10)));

  const db = getPooledDb();
  const supplierIds = await suppliersNeeding(db, programId, 'enrich', count);
  if (supplierIds.length === 0) return;

  const runId = await openRun(db, {
    programId,
    trigger: 'pipeline',
    subjectLabel: `enrich and assess ${supplierIds.length} supplier(s)`,
    supplierCount: supplierIds.length,
  });
  for (const supplierId of supplierIds) {
    await enqueueJob(db, { runId, kind: 'enrich', subjectType: 'supplier', subjectId: supplierId });
  }

  toRun(programId, runId);
}

/**
 * **Assess the roster.**
 *
 * Nothing chains into `assess` — not the worker, not any other action — so
 * without this the Program strip's *"N of 50 assessed"* can only ever be
 * moved one Supplier at a time. An assessment argues from criterion values, so
 * this queues only Suppliers that have them; a Supplier with none would produce
 * a Job that had nothing to argue from.
 */
export async function assessRoster(formData: FormData): Promise<void> {
  const programId = String(formData.get('programId'));
  const count = Math.max(1, Math.min(50, Number(formData.get('count') ?? 10)));

  const db = getPooledDb();
  const supplierIds = await suppliersNeeding(db, programId, 'assess', count);
  if (supplierIds.length === 0) return;

  const runId = await openRun(db, {
    programId,
    trigger: 'reassess',
    subjectLabel: `assess ${supplierIds.length} supplier(s)`,
    supplierCount: supplierIds.length,
  });
  for (const supplierId of supplierIds) {
    await enqueueJob(db, { runId, kind: 'assess', subjectType: 'supplier', subjectId: supplierId });
  }

  toRun(programId, runId);
}

/**
 * **Put a stopped Job back in the queue.**
 *
 * Every state a Job can stop in without finishing is recoverable, and none of
 * them had a control: `failed` printed an error and a full stop, `terminated`
 * said *re-run it* next to nothing that would, and a Job left `running` by a
 * killed worker held its row for ever while the Run never settled. Getting out
 * of any of the three meant an UPDATE by hand.
 *
 * **It re-queues rather than re-runs.** The worker is the only thing that
 * executes a Job, and a server action that executed one would be a second
 * implementation of the dequeue path — with none of its budget checks.
 *
 * `attempt` is incremented rather than reset, because how many times something
 * had to be retried is exactly what a reader wants when it fails again.
 */
export async function retryJob(formData: FormData): Promise<void> {
  const programId = String(formData.get('programId'));
  const runId = String(formData.get('runId'));
  const jobId = String(formData.get('jobId'));

  const db = getPooledDb();
  await requeueJobs(db, [jobId]);

  // The run is running again the moment one of its jobs is.
  await settleRunState(db, runId);
  toRun(programId, runId);
}

/**
 * Every stopped Job in one Run, back in the queue — **one act on the run**.
 *
 * The same argument as resuming a paused Run (SPEC §18.4): a reviewer looking
 * at "six failed" is making one decision, not six, and asking them to click six
 * times is asking them to make it six times.
 *
 * A `running` Job counts as stopped only when no worker has picked anything up
 * recently. That check is the difference between recovering a killed worker's
 * orphans and yanking four Jobs out from under a healthy one.
 */
export async function retryRun(formData: FormData): Promise<void> {
  const programId = String(formData.get('programId'));
  const runId = String(formData.get('runId'));

  const db = getPooledDb();
  const jobs = await db.select().from(t.job).where(eq(t.job.runId, runId));
  const { workerUp, nowMs } = await loadWorkerHealth(db);
  const stuck = retryableJobs(jobs, workerUp, nowMs);
  if (stuck.length === 0) return;

  await requeueJobs(
    db,
    stuck.map((job) => job.id),
  );

  await settleRunState(db, runId);
  toRun(programId, runId);
}

/**
 * **Stop a Run**, and say so on the button: it does not interrupt a Job already
 * in flight. What it buys is that the queue stops — the in-flight Rounds
 * finish, the ones behind them never start. `cancelRun` in `jobs/runs.ts`
 * carries the rest of the argument.
 */
export async function cancelRun(formData: FormData): Promise<void> {
  const programId = String(formData.get('programId'));
  const runId = String(formData.get('runId'));

  await cancelRunState(getPooledDb(), runId);
  toRun(programId, runId);
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
  toRun(programId, runId);
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
  toRun(programId, runId);
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
  await enqueueJob(db, {
    runId,
    kind: 'recommend',
    subjectType: 'category',
    subjectId: categoryId,
  });

  revalidatePath(`/program/${programId}/category/${categoryId}`);
  toRun(programId, runId);
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
  toRun(programId, runId);
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

  /**
   * `jobs/runs.ts` already had a `resumeRun`, and this file had written a second
   * one. They were not the same: this one counted `remaining?.n ?? 1`, so
   * resuming a Run with nothing left to do **added $3 for a Supplier that did
   * not exist**, and rounded the increment to two decimals against the other's
   * four. Two implementations of one act, disagreeing about money.
   */
  await resumeRunBudget(getPooledDb(), runId);
  toRun(programId, runId);
}
