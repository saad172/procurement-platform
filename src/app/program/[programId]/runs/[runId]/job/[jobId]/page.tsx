import { notFound } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import { loadJobPage } from '@/db/queries/job-page';
import { Breadcrumb } from '@/components/breadcrumb';
import { LiveRefresh } from '@/components/live-refresh';

/**
 * The Trace (SPEC §3.7, §19.1) — the bottom of the Runs branch.
 *
 * Every turn is stored as **the whole `BetaMessage` verbatim**, which is what
 * makes the replay-bar claim *provable by the tests existing* rather than
 * asserted: a fixture is an **export of one real Job's rows**, and a Trace that
 * could not drive a replay never met the bar.
 *
 * That storage decision paid for itself during the build — a validation failure
 * on a 40-sentence assessment was diagnosed entirely offline, by replaying
 * these rows through the validator with no live model call.
 *
 * The reasoning shown is a **summary, never the chain of thought**.
 *
 * A Job still running writes turns into this table as it goes, so the page
 * re-reads until the Job settles — the Trace is the most detailed live view the
 * app has, and it was previously only readable after the fact.
 */
export const dynamic = 'force-dynamic';

export default async function TracePage({
  params,
}: {
  params: Promise<{ programId: string; runId: string; jobId: string }>;
}) {
  const { programId, runId, jobId } = await params;

  const data = await loadJobPage(getPooledDb(), { programId, runId, jobId });
  if (!data) notFound();

  const {
    job,
    program,
    turns,
    usage,
  } = data;
  return (
    <main>
      <Breadcrumb
        trail={[
          { label: program.name, href: `/program/${programId}` },
          { label: 'Runs', href: `/program/${programId}/runs` },
          { label: 'Run', href: `/program/${programId}/runs/${runId}` },
          { label: `${job.kind} trace` },
        ]}
      />
      <h1>{job.kind} trace</h1>
      <p className="sub">
        {turns.length} turn{turns.length === 1 ? '' : 's'} ·{' '}
        <span className="badge">{job.traceFidelity}</span>
        {job.traceFidelity === 'timeline' ? (
          <span className="note"> — a dossier’s context is rewritten server-side, so this cannot drive a replay</span>
        ) : null}
        {' · '}
        <LiveRefresh
          active={job.state === 'queued' || job.state === 'running'}
          idle={`${job.state} — this trace is complete`}
        />
      </p>

      {turns.map((turn) => {
        const response = turn.response as {
          content?: { type: string; text?: string; name?: string; thinking?: string }[];
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        const blocks = response.content ?? [];
        const thinking = blocks.filter((b) => b.type === 'thinking');
        const text = blocks.filter((b) => b.type === 'text');
        const toolUses = blocks.filter((b) => b.type === 'tool_use');

        return (
          <section key={turn.id} className="card" style={{ marginTop: '0.8rem' }}>
            <h3 style={{ marginTop: 0, display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
              <span>Turn {turn.n}</span>
              <span className="badge mute">{turn.stopReason ?? '—'}</span>
              <span className="note" style={{ fontWeight: 400 }}>
                {response.usage?.input_tokens?.toLocaleString('en-US')} in ·{' '}
                {response.usage?.output_tokens?.toLocaleString('en-US')} out
              </span>
            </h3>

            {thinking.length > 0 ? (
              <details>
                <summary className="note">Reasoning — a summary, never the chain of thought</summary>
                <p className="note" style={{ whiteSpace: 'pre-wrap' }}>
                  {thinking.map((b) => b.thinking).join('\n\n')}
                </p>
              </details>
            ) : null}

            {text.map((block, index) => (
              <p key={index} style={{ whiteSpace: 'pre-wrap', margin: '0.5rem 0' }}>
                {block.text}
              </p>
            ))}

            {toolUses.length > 0 ? (
              <p style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', margin: '0.5rem 0 0' }}>
                {toolUses.map((block, index) => (
                  <span key={index} className="badge">{block.name}</span>
                ))}
              </p>
            ) : null}

            {turn.toolDigestHash ? (
              <p className="note" style={{ margin: '0.5rem 0 0' }}>
                {/*
                  The tool digest: names a human can read, plus a hash a test can
                  compare. A hash mismatch is a WARNING — a changed tool schema
                  is exactly the drift that leaves a fixture stale while it still
                  passes.
                */}
                tool digest <code className="mono">{turn.toolDigestHash.slice(0, 12)}</code>
              </p>
            ) : null}
          </section>
        );
      })}

      <p className="note" style={{ marginTop: '1rem' }}>
        {usage.length} usage event{usage.length === 1 ? '' : 's'} recorded for this job. Usage lives on
        one table, not on the trace — one number, one home.
      </p>
    </main>
  );
}
