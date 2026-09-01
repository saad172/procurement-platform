import { notFound } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import { loadRunPage } from '@/db/queries/run-page';
import { Breadcrumb } from '@/components/breadcrumb';
import { Jobs, PausedOnBudget, Progress } from './sections';

/**
 * One Run, and its Jobs (SPEC §18.4, §18.6).
 *
 * A page renders, `db/queries` reads, `domain` derives: this file is the
 * loader call and its sections, in order; `sections.tsx` holds one component
 * per `<h2>`, plus the chrome ahead of the first one.
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

  const data = await loadRunPage(getPooledDb(), { programId, runId });
  if (!data) notFound();

  const { run, program, actualUsd } = data;

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
        {run.budgetUsd
          ? ` · budget $${Number(run.budgetUsd).toFixed(2)}`
          : ' · no budget (a thread’s run)'}
      </p>

      <Progress data={data} programId={programId} runId={runId} />
      <PausedOnBudget data={data} programId={programId} runId={runId} />
      <Jobs data={data} programId={programId} runId={runId} />
    </main>
  );
}
