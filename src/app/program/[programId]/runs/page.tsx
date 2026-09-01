import { notFound } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import { loadRunsPage } from '@/db/queries/runs-page';
import { Breadcrumb } from '@/components/breadcrumb';
import { LiveRefresh } from '@/components/live-refresh';
import { Answers, Ledger, TheWorking } from './sections';

/**
 * The Runs branch (SPEC §18.5) — `Program → Runs → Run → Trace`.
 *
 * A **branch off the Program page, not a sixth level of the spine**, because
 * "what did it cost?" is a different question from "which supplier?".
 *
 * A page renders, `db/queries` reads, `domain` derives: this file is the
 * loader call and its sections, in order; `sections.tsx` holds one component
 * per `<h2>`.
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

  const { program, runs, running, totalUsd } = data;

  return (
    <main>
      <Breadcrumb trail={[{ label: program.name, href: `/program/${programId}` }, { label: 'What has run' }]} />
      <h1>What has run, and what it cost</h1>
      <p className="sub">
        {runs.length} {runs.length === 1 ? 'batch' : 'batches'} of work · $
        {totalUsd.toFixed(2)} spent in total
        {running ? <> · <LiveRefresh active /></> : null}
      </p>

      <Answers data={data} />
      <Ledger data={data} programId={programId} />
      <TheWorking data={data} />
    </main>
  );
}
