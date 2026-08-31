import Link from 'next/link';
import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { RUN_BUDGET_USD_PER_SUPPLIER } from '@/config/constants';
import { resumeRun } from '../../run-actions';
import { Breadcrumb } from '@/components/breadcrumb';
import { runSpendUsd } from '@/jobs/runs';

/**
 * One Run, and its Jobs (SPEC §18.4, §18.6).
 *
 * The estimate-versus-actual comparison lives here and is **written back
 * nowhere**: a stored actual would silently rewrite a figure someone has read.
 */
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

  // What resuming would actually pay for: the jobs that never finished.
  const unfinished = jobs.filter((job) => job.state === 'queued' || job.state === 'paused_on_budget').length;
  const actualUsd = await runSpendUsd(db, runId);

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
            $3.00 × N formula applied to the suppliers still unfinished.
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
              <th className="num">Tool calls</th>
              <th className="num">Tokens</th>
              <th>Trace</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 ? (
              <tr><td colSpan={6} className="empty">This run spawned no jobs.</td></tr>
            ) : (
              jobs.map((job) => (
                <tr key={job.id}>
                  <td>{job.kind}</td>
                  <td className="mono note">{job.subjectId.slice(0, 12)}…</td>
                  <td><JobState job={job} /></td>
                  <td className="num note">
                    {job.toolCallsUsed} / {job.toolCallCap}
                  </td>
                  <td className="num note">
                    {job.tokenCap === 0 ? 'n/a' : `${job.tokensUsed.toLocaleString('en-US')} / ${job.tokenCap.toLocaleString('en-US')}`}
                  </td>
                  <td>
                    <Link href={`/program/${programId}/runs/${runId}/job/${job.id}` as never}>
                      {job.traceFidelity === 'replayable' ? 'replayable' : 'timeline'}
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}

/**
 * **`terminated` names a number you set; `failed` names something that broke**
 * (SPEC §18.4) — and the two carry different actions, amber against red.
 */
function JobState({ job }: { job: typeof t.job.$inferSelect }) {
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
