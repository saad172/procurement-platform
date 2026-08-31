import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq, inArray } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { RUN_BUDGET_USD_PER_SUPPLIER } from '@/config/constants';
import { cancelRun, resumeRun, retryJob, retryRun } from '../../run-actions';
import { Breadcrumb } from '@/components/breadcrumb';
import { LiveRefresh } from '@/components/live-refresh';
import { runSpendUsd } from '@/jobs/runs';
import {
  loadJobActivity,
  retryableJobs,
  runPhases,
  runProgress,
  loadWorkerHealth,
  type JobActivity,
  type RunProgress,
} from '@/db/queries/runs';

/**
 * One Run, and its Jobs (SPEC §18.4, §18.6).
 *
 * **This is the page a click on Run lands on**, so it has to answer *is
 * anything happening?* before it answers *what did it cost?*. The worker holds
 * no inbound port (SPEC §2.2), so the page re-reads rather than subscribes, and
 * stops the moment nothing is queued or running.
 *
 * The estimate-versus-actual comparison lives here and is **written back
 * nowhere**: a stored actual would silently rewrite a figure someone has read.
 */
export const dynamic = 'force-dynamic';

export default async function RunPage({
  params,
}: {
  params: Promise<{ programId: string; runId: string }>;
}) {
  const { programId, runId } = await params;
  const db = getPooledDb();

  const run = await db.query.run.findFirst({ where: eq(t.run.id, runId) });
  const program = await db.query.program.findFirst({ where: eq(t.program.id, programId) });
  if (!run || !program) notFound();

  const jobs = await db.select().from(t.job).where(eq(t.job.runId, runId)).orderBy(t.job.createdAt);

  const progress = runProgress(jobs);
  /**
   * Counted from the Trace, not from `job.tool_calls_used` — those two columns
   * are written by nothing, so the old `0 / 40` was not a slow number, it was
   * an absent one. The Trace rows land turn by turn, which is what makes this
   * readable while the Job is still running.
   */
  const activity = await loadJobActivity(
    db,
    jobs.map((job) => job.id),
  );
  const subjects = await loadSubjects(db, jobs);

  // What resuming would actually pay for: the jobs that never finished.
  const unfinished = jobs.filter((job) => job.state === 'queued' || job.state === 'paused_on_budget').length;
  const actualUsd = await runSpendUsd(db, runId);
  /**
   * Liveness, asked once. It answers two questions on this page: whether queued
   * jobs will ever be picked up, and whether a job sitting in `running` is
   * working or orphaned by a worker that died holding it.
   */
  const { workerUp, nowMs } = await loadWorkerHealth(db);
  const phases = runPhases(jobs);
  const stuck = retryableJobs(jobs, workerUp, nowMs);

  return (
    <main>
      <Breadcrumb
        trail={[
          { label: program.name, href: `/program/${programId}` },
          { label: 'Runs', href: `/program/${programId}/runs` },
          { label: run.subjectLabel ?? run.trigger },
        ]}
      />
      <h1>{run.subjectLabel ?? run.trigger}</h1>
      <p className="sub">
        {/*
          "up to $30 · actual $21.40". The pre-run figure is labelled "up to"
          because it assumes every Job runs to MAX_ROUNDS, and the accumulating
          gap is itself the evidence the estimator is ceiling-shaped.
        */}
        {run.estimateUsd ? `up to $${Number(run.estimateUsd).toFixed(2)} · ` : ''}
        actual ${actualUsd.toFixed(4)}
        {run.budgetUsd ? ` · budget $${Number(run.budgetUsd).toFixed(2)}` : ' · no budget (a thread’s run)'}
      </p>

      {/*
        The progress strip, and the only thing on the page that moves. It is
        first because a reviewer who has just pressed Run is asking one
        question, and the cost line above is not the answer to it.
      */}
      <section className="card" aria-label="Progress">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
          <strong>
            {progress.settled} of {progress.total} job{progress.total === 1 ? '' : 's'}{' '}
            {progress.cancelled > 0 && progress.cancelled === progress.total - progress.done - progress.failed - progress.terminated
              ? 'settled'
              : 'finished'}
          </strong>
          <LiveRefresh active={progress.active} idle="Nothing left to watch — this is the final state." />
        </div>

        {/*
          One bar per phase, not one bar over everything. A pipeline Run's job
          list grows as each phase queues the next, so a single "N of M" steps
          backwards every time the run gets further — which reads as losing
          ground. Split by phase and every bar only fills.
        */}
        {phases.length === 0 ? (
          <p className="note" style={{ margin: '0.6rem 0 0' }}>This run spawned no jobs.</p>
        ) : (
          <div style={{ display: 'grid', gap: '0.5rem', margin: '0.7rem 0 0' }}>
            {phases.map((phase) => (
              <Phase key={phase.kind} kind={phase.kind} progress={phase.progress} />
            ))}
          </div>
        )}

        {progress.active ? (
          <form action={cancelRun} style={{ marginTop: '0.8rem' }}>
            <input type="hidden" name="programId" value={programId} />
            <input type="hidden" name="runId" value={runId} />
            <button type="submit" className="badge bad" style={{ cursor: 'pointer', padding: '0.45rem 0.8rem' }}>
              {/*
                Named by what it will actually do. With nothing queued there is
                nothing to cancel — the button still marks the run stopped, but
                promising to "cancel the 0 jobs still queued" would be a control
                describing work it is not about to do.
              */}
              {progress.queued > 0
                ? `Stop · cancel the ${progress.queued} job${progress.queued === 1 ? '' : 's'} still queued`
                : 'Stop this run'}
            </button>
            <span className="note" style={{ marginLeft: '0.6rem' }}>
              {/*
                Honest about its own reach. The worker holds a claimed Job for
                the length of its Round and polls nothing, so what this stops is
                the queue — not the work already in flight.
              */}
              {progress.running > 0
                ? `The ${progress.running} already running will finish their round; nothing after them starts.`
                : 'Nothing further will be dequeued for this run.'}
            </span>
          </form>
        ) : null}

        {stuck.length > 0 ? (
          <form action={retryRun} style={{ marginTop: '0.8rem' }}>
            <input type="hidden" name="programId" value={programId} />
            <input type="hidden" name="runId" value={runId} />
            <button type="submit" className="badge warn" style={{ cursor: 'pointer', padding: '0.45rem 0.8rem' }}>
              Retry {stuck.length} stopped job{stuck.length === 1 ? '' : 's'}
            </button>
            <span className="note" style={{ marginLeft: '0.6rem' }}>
              {/*
                One act on the run, for the same reason resuming is: a reviewer
                reading "six failed" is making one decision, not six.
              */}
              Puts them back in the queue. The worker is the only thing that runs a job, so this
              queues rather than re-runs.
            </span>
          </form>
        ) : null}

        {!workerUp && progress.queued > 0 ? (
          <p className="note warn" style={{ marginTop: '0.6rem' }}>
            {/*
              A Job queued with nothing listening sits in `queued` for ever, and
              a progress bar frozen at 0 reads as slowness rather than as an
              absent process. Naming it is the difference.
            */}
            <strong>No worker has picked anything up in the last five minutes.</strong> These jobs
            will wait rather than run. Start one with <code>pnpm worker</code>, or{' '}
            <code>docker compose up worker</code>.
          </p>
        ) : null}
      </section>

      {run.state === 'paused_on_budget' ? (
        <section className="card" style={{ borderColor: '#f0dcb4' }}>
          <h3 style={{ marginTop: 0 }}>Paused on budget</h3>
          <p className="note" style={{ margin: 0 }}>
            {/*
              The only state that returns to `running`. The run budget is a
              spending decision a person may revise; a per-Job ceiling is a
              correctness backstop they may not.
            */}
            In-flight jobs stopped at their next round boundary and queued jobs stayed queued, so
            resuming is one act on the run rather than one per job. The increment comes from the same
            $8.00 × N formula applied to the suppliers still unfinished.
          </p>

          {/*
            One click, and the increment is derived rather than chosen. A flat
            step would be arbitrary and a free-text box would hole the
            code-constant discipline (SPEC §18.4).
          */}
          <form action={resumeRun} style={{ marginTop: '0.7rem' }}>
            <input type="hidden" name="programId" value={programId} />
            <input type="hidden" name="runId" value={runId} />
            <button type="submit" className="badge" style={{ cursor: 'pointer', padding: '0.45rem 0.8rem' }}>
              Continue · adds ${(RUN_BUDGET_USD_PER_SUPPLIER * unfinished).toFixed(2)} for the{' '}
              {unfinished} job{unfinished === 1 ? '' : 's'} left
            </button>
          </form>
        </section>
      ) : null}

      <h2>Jobs</h2>
      <div className="card scroll-x">
        <table>
          <thead>
            <tr>
              <th>Kind</th>
              <th>Subject</th>
              <th>State</th>
              <th>Doing</th>
              <th className="num">Upstream calls</th>
              <th className="num">Tokens</th>
              <th>Trace</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 ? (
              <tr><td colSpan={7} className="empty">This run spawned no jobs.</td></tr>
            ) : (
              jobs.map((job) => {
                const now = activity.get(job.id);
                return (
                  <tr key={job.id}>
                    <td>{job.kind}</td>
                    <td>
                      {/*
                        The subject, named and linked. A truncated uuid told a
                        reviewer nothing, and this row is also the way back to
                        the page the result lands on.
                      */}
                      <Subject programId={programId} job={job} subjects={subjects} />
                    </td>
                    <td><JobState job={job} stranded={stuck.includes(job)} /></td>
                    <td className="note"><Doing job={job} activity={now} /></td>
                    <td className="num note">
                      {/*
                        The ceiling counts outbound attempts, so that is what is
                        shown against it. A Job that runs a model has both
                        numbers and they are different questions: how much
                        reasoning it did, and how much it spent doing it.
                      */}
                      {now?.upstreamCalls ?? 0} / {job.toolCallCap}
                      {now?.toolCalls ? (
                        <div className="note">{now.toolCalls} model tool call{now.toolCalls === 1 ? '' : 's'}</div>
                      ) : null}
                    </td>
                    <td className="num note">
                      {job.tokenCap === 0
                        ? 'n/a'
                        : `${(now?.tokens ?? 0).toLocaleString('en-US')} / ${job.tokenCap.toLocaleString('en-US')}`}
                    </td>
                    <td>
                      <Link href={`/program/${programId}/runs/${runId}/job/${job.id}` as never}>
                        {now?.turns ? `${now.turns} turn${now.turns === 1 ? '' : 's'}` : 'timeline'}
                      </Link>
                      {stuck.includes(job) ? (
                        <form action={retryJob} style={{ marginTop: '0.3rem' }}>
                          <input type="hidden" name="programId" value={programId} />
                          <input type="hidden" name="runId" value={runId} />
                          <input type="hidden" name="jobId" value={job.id} />
                          <button
                            type="submit"
                            className="badge"
                            style={{ cursor: 'pointer', padding: '0.15rem 0.45rem', fontSize: '0.75rem' }}
                          >
                            retry
                          </button>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <p className="note">
        Tool calls and tokens are counted from the Trace rows themselves, which is why they move
        while a job is still running.
      </p>
    </main>
  );
}

/** One phase of the pipeline, and how far through it the run is. */
function Phase({ kind, progress }: { kind: string; progress: RunProgress }) {
  const pct = progress.total === 0 ? 0 : (progress.settled / progress.total) * 100;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem' }}>
        <strong>{kind}</strong>
        <span className="note">
          {progress.settled} of {progress.total}
          {progress.running > 0 ? ` · ${progress.running} running` : ''}
          {progress.queued > 0 ? ` · ${progress.queued} queued` : ''}
          {progress.terminated > 0 ? ` · ${progress.terminated} at a ceiling` : ''}
          {progress.failed > 0 ? ` · ${progress.failed} failed` : ''}
          {progress.pausedOnBudget > 0 ? ` · ${progress.pausedOnBudget} paused` : ''}
          {/*
            A cancelled Job is *settled*, so it counts in the numerator — and a
            phase reading "47 of 47" with forty-three of them cancelled would
            report a run that was stopped as a run that finished. It is the one
            end state that has to be named for the total to mean anything.
          */}
          {progress.cancelled > 0 ? ` · ${progress.cancelled} cancelled` : ''}
        </span>
      </div>
      <div className="bar" style={{ marginTop: '0.25rem' }}>
        <i
          className={progress.failed > 0 ? 'bad' : progress.terminated > 0 ? 'warn' : undefined}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * **`terminated` names a number you set; `failed` names something that broke**
 * (SPEC §18.4) — and the two carry different actions, amber against red.
 */
function JobState({ job, stranded }: { job: typeof t.job.$inferSelect; stranded: boolean }) {
  /**
   * A Job stuck in `running` with nothing alive to be running it is not
   * running. Saying so is the difference between a page that looks slow and a
   * page that tells you a worker died holding this row.
   */
  if (job.state === 'running' && stranded) {
    return (
      <>
        <span className="badge warn">stranded</span>
        <div className="note">claimed by a worker that is no longer running — retry it</div>
      </>
    );
  }
  if (job.state === 'terminated') {
    return (
      <>
        <span className="badge warn">terminated</span>
        <div className="note">{job.terminatedReason ?? 'stopped at a ceiling'} — re-run it</div>
      </>
    );
  }
  if (job.state === 'failed') {
    return (
      <>
        <span className="badge bad">failed</span>
        <div className="note">{job.error ?? 'something broke'} — retry it</div>
      </>
    );
  }
  if (job.state === 'done') return <span className="badge good">done</span>;
  if (job.state === 'paused_on_budget') return <span className="badge warn">paused on budget</span>;
  return <span className="badge mute">{job.state}</span>;
}

/**
 * What this Job reached for most recently.
 *
 * The tool names of the latest turn that called anything — the cheapest honest
 * answer to *what is it doing*, and it needs no new storage to give.
 */
function Doing({
  job,
  activity,
}: {
  job: typeof t.job.$inferSelect;
  activity: JobActivity | undefined;
}) {
  if (job.state === 'queued') return <>waiting for a worker</>;
  if (!activity || activity.turns === 0) {
    return <>{job.state === 'running' ? 'starting…' : '—'}</>;
  }
  if (activity.lastTools.length === 0) return <>turn {activity.turns}</>;
  return (
    <span className="mono">
      {activity.lastTools.slice(0, 3).join(', ')}
      {activity.lastTools.length > 3 ? ` +${activity.lastTools.length - 3}` : ''}
    </span>
  );
}

/** The Supplier or Category a Job is about, linked to its own page. */
function Subject({
  programId,
  job,
  subjects,
}: {
  programId: string;
  job: typeof t.job.$inferSelect;
  subjects: Map<string, string>;
}) {
  const name = subjects.get(job.subjectId);
  if (!name) return <span className="mono note">{job.subjectId.slice(0, 12)}…</span>;

  const href =
    job.subjectType === 'supplier'
      ? `/program/${programId}/supplier/${job.subjectId}`
      : job.subjectType === 'category'
        ? `/program/${programId}/category/${job.subjectId}`
        : null;

  return href ? <Link href={href as never}>{name}</Link> : <>{name}</>;
}

/**
 * The names behind the subject ids, in two queries rather than one per row.
 */
async function loadSubjects(
  db: ReturnType<typeof getPooledDb>,
  jobs: (typeof t.job.$inferSelect)[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();

  const supplierIds = jobs.filter((job) => job.subjectType === 'supplier').map((job) => job.subjectId);
  if (supplierIds.length > 0) {
    const rows = await db
      .select({ id: t.supplier.id, name: t.supplier.rosterName })
      .from(t.supplier)
      .where(inArray(t.supplier.id, supplierIds));
    for (const row of rows) names.set(row.id, row.name ?? row.id.slice(0, 12));
  }

  const categoryIds = jobs.filter((job) => job.subjectType === 'category').map((job) => job.subjectId);
  if (categoryIds.length > 0) {
    const rows = await db
      .select({ id: t.category.id, code: t.category.code, name: t.category.name })
      .from(t.category)
      .where(inArray(t.category.id, categoryIds));
    for (const row of rows) names.set(row.id, `${row.code} · ${row.name}`);
  }

  return names;
}
