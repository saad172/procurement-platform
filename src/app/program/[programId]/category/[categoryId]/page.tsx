import { notFound } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import { loadCategoryPage } from '@/db/queries/category-page';
import { Breadcrumb } from '@/components/breadcrumb';
import { ChatDock } from '@/components/chat-dock';
import { LeadsTable } from './leads';
import { ArguedCase, Answers, ConcentrationMap, Excluded, Shortlist, TheWorking } from './sections';

/**
 * The Category page (SPEC §13.3, §13.6) — level two of the spine.
 *
 * A page renders, `db/queries` reads, `domain` derives: this file is the
 * loader call and its sections, in order; `sections.tsx` holds one component
 * per `<h2>`. `LeadsTable` is its own file beside this one and already
 * carries its own `<h2>`, so it is called here rather than re-homed.
 */
export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ programId: string; categoryId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { programId, categoryId } = await params;
  const query = await searchParams;

  const data = await loadCategoryPage(getPooledDb(), { programId, categoryId, query });
  if (!data) notFound();

  const { program, category, shortlist, leads } = data;

  return (
    <main>
      <Breadcrumb
        trail={[
          { label: program.name, href: `/program/${programId}` },
          { label: `${category.code} — ${category.name}` },
        ]}
      />
      <h1>{category.name}</h1>
      <p className="sub">
        {shortlist.totalCount} {shortlist.totalCount === 1 ? 'company' : 'companies'} bidding
        {shortlist.excluded.length > 0
          ? ` · ${shortlist.excluded.length} that cannot be ranked yet`
          : ''}
        {data.scoredLine
          ? ` · ${data.scoredLine.label}, ${Number(data.scoredLine.rate)}% duty into ${program.importingCountry}`
          : ''}
      </p>

      <Answers data={data} programId={programId} categoryId={categoryId} />
      <Shortlist data={data} programId={programId} />
      <ConcentrationMap data={data} programId={programId} />
      <Excluded data={data} programId={programId} />

      <LeadsTable
        programId={programId}
        categoryId={categoryId}
        categoryCode={category.code}
        leads={leads}
        showDismissed={query.dismissed === '1'}
      />

      <ArguedCase data={data} programId={programId} categoryId={categoryId} />
      <TheWorking data={data} programId={programId} categoryId={categoryId} />
      <ChatDock programId={programId} />
    </main>
  );
}
