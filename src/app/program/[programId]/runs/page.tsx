import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import { loadRunsPage } from '@/db/queries/runs-page';
import { Breadcrumb } from '@/components/breadcrumb';
import { LiveRefresh } from '@/components/live-refresh';

/**
 * The Runs branch (SPEC §18.5) — `Program → Runs → Run → Trace`.
 *
 * A **branch off the Program page, not a sixth level of the spine**, because
 * "what did it cost?" is a different question from "which supplier?".
 *
 * **No filter bar**, deliberately: not filtering means there is no denominator
 * to disclose. Every run this program has ever had is here, newest first.
 *
 * **Completeness deliberately does not live here** — it sits on the Program
 * strip, because *is my work done?* and *what did it cost?* are different
 * questions and only the first belongs where a person starts.
 */
export default async function RunsPage({
  params,
}: {
  params: Promise<{ programId: string }>;
}) {
  const { programId } = await params;

  const data = await loadRunsPage(getPooledDb(), { programId });
  if (!data) notFound();

  const {
    program,
    runs,
    running,
    insights,
    totalUsd,
    answers,
  } = data;
  return (
    <main>
      <Breadcrumb trail={[{ label: program.name, href: `/program/${programId}` }, { label: 'What has run' }]} />
      <h1>What has run, and what it cost</h1>
      <p className="sub">
        {runs.length} {runs.length === 1 ? 'batch' : 'batches'} of work · $
        {totalUsd.toFixed(2)} spent in total
        {running ? <> · <LiveRefresh active /></> : null}
      </p>

      {/* ── The answers, before the ledger ── */}
      {answers.map((answer) => (
        <div
          key={answer.said}
          className={`answer ${answer.tone === 'neutral' ? '' : answer.tone}`}
        >
          <p className="said">{answer.said}</p>
          <p className="because">{answer.because}</p>
          {answer.actions.length > 0 ? (
            <div className="do">
              {answer.actions.map((action) => (
                <Link
                  key={action.label}
                  className={`btn ${action.primary ? 'primary' : ''}`}
                  href={action.href as never}
                >
                  {action.label}
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      ))}

      <h2>Everything that has run</h2>
      <div className="card scroll-x">
        {runs.length === 0 ? (
          <p className="empty">Nothing has run yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>State</th>
                <th className="num">Jobs</th>
                <th className="num">Duration</th>
                <th className="num">Up to</th>
                <th className="num">Actual</th>
                <th className="num">Sayari calls</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((row) => (
                <tr key={row.run.id}>
                  <td className="note">{row.run.createdAt.toISOString().slice(0, 16).replace('T', ' ')}</td>
                  <td>
                    <Link href={`/program/${programId}/runs/${row.run.id}` as never}>
                      {row.run.subjectLabel ?? row.run.trigger}
                    </Link>
                  </td>
                  <td>
                    <RunState state={row.run.state} terminated={row.terminatedCount} />
                  </td>
                  <td className="num">{row.jobCount}</td>
                  <td className="num note">
                    {row.durationMs != null ? `${Math.round(row.durationMs / 1000)}s` : '—'}
                  </td>
                  {/*
                    Labelled "up to" because it assumes every Job runs to
                    MAX_ROUNDS. The accumulating gap between the two columns is
                    itself the evidence the estimator is ceiling-shaped, which is
                    what the write-up should say rather than claiming a
                    calibrated forecast.
                  */}
                  <td className="num note">
                    {row.run.estimateUsd ? `$${Number(row.run.estimateUsd).toFixed(2)}` : '—'}
                  </td>
                  <td className="num">${row.actualUsd.toFixed(4)}</td>
                  <td className="num">{row.sayariCalls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/*
        Sayari's own usage block sits ONCE at the foot of this page and is
        identical on every program, because it is account-scoped. The two
        numbers are not the same kind of thing, so they are shown separately
        with no delta anywhere: reconciliation stays a human act.
      */}
      <h2>The working</h2>
      <p className="note" style={{ margin: '-0.4rem 0 0.8rem', maxWidth: '56rem' }}>
        Two numbers the ledger cannot show, and what Sayari&rsquo;s own counters say.
      </p>
      <div className="grid two">
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Settled without a model</h3>
          <p style={{ fontSize: '1.3rem', fontWeight: 620, margin: '0 0 0.3rem' }}>
            {insights.settledByRules.rules} of {insights.settledByRules.total} settled by rules — 0 tokens
          </p>
          <p className="note" style={{ margin: 0 }}>
            Each of these passed all eight discriminators and was independently confirmed by a GLEIF
            exact-LEI join. A company with no LEI can never clear that bar, which is the safe
            direction of failure — and how often it happens is a result, not a defect.
          </p>
        </section>

        <section className="card">
          <h3 style={{ marginTop: 0 }}>Rounds</h3>
          <p style={{ fontSize: '1.3rem', fontWeight: 620, margin: '0 0 0.3rem' }}>
            {insights.rounds.total} rounds · {insights.rounds.codeRejections} spent on code rejections
          </p>
          <p className="note" style={{ margin: 0 }}>
            {/*
              This makes Round consumption a QUALITY number rather than only a
              cost one: a code rejection is the citation, number-fidelity or
              caveat checks refusing a draft before it was written anywhere.
            */}
            A code rejection is the citation, number-fidelity, caveat or pick-legality checks refusing
            a draft before anything was inserted. Rounds spent that way are the validator working,
            not waste.
          </p>
        </section>
      </div>

      <h3>Your Sayari account</h3>
      <section className="card">
        <p className="note" style={{ marginTop: 0 }}>
          Sayari reports seven endpoint-class counters, <strong>account-wide</strong>, over a rolling
          year — with no program dimension and no dollar figure. It is a different number from the
          count above, scoped differently and lagging, so the two are never netted against each other.
        </p>
        <p className="note" style={{ marginBottom: 0 }}>
          <code className="mono">negativeNews</code> has no bucket there at all, so it does not appear
          in Sayari&rsquo;s figure however many times it ran. And no per-class price is published, so
          any &ldquo;credits in dollars&rdquo; number would be one we invented.
        </p>
      </section>

      <p className="note" style={{ marginTop: '1rem' }}>
        Dollar figures on this page are computed from a committed price constant, not a bill.
      </p>
    </main>
  );
}

/** `terminated` names a number you set; `failed` names something that broke. */
function RunState({ state, terminated }: { state: string; terminated: number }) {
  if (state === 'failed') return <span className="badge bad">failed</span>;
  if (state === 'paused_on_budget') return <span className="badge warn">paused on budget</span>;
  if (state === 'done') {
    return (
      <>
        <span className="badge good">done</span>
        {terminated > 0 ? (
          <span className="badge warn" title="A terminated job does not fail its run">
            {terminated} stopped at a ceiling
          </span>
        ) : null}
      </>
    );
  }
  return <span className="badge mute">{state.replace(/_/g, ' ')}</span>;
}
