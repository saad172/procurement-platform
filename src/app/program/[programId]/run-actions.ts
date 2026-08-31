'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { enqueueJob, openRun, settleRunState } from '@/jobs/runs';
import { loadWorkerHealth, retryableJobs, suppliersNeeding } from '@/db/queries/runs';
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
    await enqueueJob(db, { runId, kind: 'resolve', subjectType: 'supplier', subjectId: supplier.id });
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
 * without this the Programme strip's *"N of 50 assessed"* can only ever be
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
  await db
    .update(t.job)
    .set({
      state: 'queued',
      error: null,
      terminatedReason: null,
      startedAt: null,
      finishedAt: null,
      lockedAt: null,
      attempt: sql`${t.job.attempt} + 1`,
    })
    .where(eq(t.job.id, jobId));

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

  await db
    .update(t.job)
    .set({
      state: 'queued',
      error: null,
      terminatedReason: null,
      startedAt: null,
      finishedAt: null,
      lockedAt: null,
      attempt: sql`${t.job.attempt} + 1`,
    })
    .where(
      inArray(
        t.job.id,
        stuck.map((job) => job.id),
      ),
    );

  await settleRunState(db, runId);
  toRun(programId, runId);
}

/**
 * **Stop a Run.**
 *
 * Queued Jobs are cancelled so nothing else is ever dequeued for this Run, and
 * the Run itself is marked `cancelled` so the Runs list says what happened
 * rather than showing a run that simply stopped moving.
 *
 * **It does not interrupt a Job already in flight, and the button says so.**
 * The worker holds a claimed Job for the length of its Round and polls nothing;
 * stopping mid-Round would mean either a cancellation channel the worker checks
 * — which is a second control path through the dequeue loop — or killing the
 * process, which is not something a web page should do. What this buys is the
 * thing that actually matters: **the queue stops**. Four in-flight Rounds
 * finish; the forty-three behind them never start.
 *
 * That distinction is why the queued Jobs are cancelled rather than left
 * queued. A Run "stopped" by killing the worker looks identical to one waiting
 * for a worker, and starting a worker later for something else would silently
 * resume it — spending the rest of a budget somebody had decided not to spend.
 */
export async function cancelRun(formData: FormData): Promise<void> {
  const programId = String(formData.get('programId'));
  const runId = String(formData.get('runId'));

  const db = getPooledDb();
  await db
    .update(t.job)
    .set({ state: 'cancelled', finishedAt: new Date(), lockedAt: null })
    .where(and(eq(t.job.runId, runId), eq(t.job.state, 'queued')));

  await db
    .update(t.run)
    .set({ state: 'cancelled', finishedAt: new Date() })
    .where(eq(t.run.id, runId));

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
  await enqueueJob(db, { runId, kind: 'recommend', subjectType: 'category', subjectId: categoryId });

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

  toRun(programId, runId);
}
