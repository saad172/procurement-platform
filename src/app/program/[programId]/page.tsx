import { notFound } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import { loadProgramPage } from '@/db/queries/program-page';
import { Breadcrumb } from '@/components/breadcrumb';
import { ChatDock } from '@/components/chat-dock';
import { Answers, TheWorking, WhereYouStand } from './sections';

/**
 * The Program page (SPEC §13.2) — the top of the spine.
 *
 *     Program → Category → Supplier → Sayari entity → record
 *
 * Four charts, all of which survive, each answering a question the Category
 * table cannot. **The charts are the filter control**: clicking Germany on the
 * country bars narrows the table below, and there is no separate filter UI.
 *
 * A page renders, `db/queries` reads, `domain` derives: this file is the
 * loader call and its sections, in order; `sections.tsx` holds one component
 * per `<h2>`, and `db/queries/program-page.ts` holds the one read they share.
 */
export const dynamic = 'force-dynamic';

export default async function ProgramPage({
  params,
  searchParams,
}: {
  params: Promise<{ programId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { programId } = await params;
  const query = await searchParams;
  const db = getPooledDb();

  const data = await loadProgramPage(db, { programId, query });
  if (!data) notFound();

  const { program } = data;

  return (
    <main>
      <Breadcrumb trail={[{ label: program.name }]} />
      <h1>{program.name}</h1>
      <p className="sub">
        {program.vehicleClass} · importing into {program.importingCountry} · {program.sourcingHorizon}
      </p>

      <Answers data={data} />
      <WhereYouStand data={data} programId={programId} />
      <TheWorking data={data} programId={programId} />
      <ChatDock programId={programId} />
    </main>
  );
}
