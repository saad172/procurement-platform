import { notFound } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import { loadSettlePage } from '@/db/queries/settle-page';
import { Breadcrumb } from '@/components/breadcrumb';
import { Answer, PastAttempts, SettleForm, SharedChecks, Standard } from './sections';

/**
 * Settling one parked roster row (SPEC §6.8).
 *
 * A page renders, `db/queries` reads, `domain` derives: this file is the
 * loader call and its sections, in order; `sections.tsx` holds one component
 * per `<h2>`, plus the chrome ahead of the first one.
 *
 * **Cached-first.** Everything here is already stored; nothing on this page
 * spends a Sayari credit, because a review page that charged for being opened
 * would be charging for curiosity.
 */
export default async function SettleRowPage({
  params,
  searchParams,
}: {
  params: Promise<{ programId: string; supplierId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { programId, supplierId } = await params;
  const query = await searchParams;

  const data = await loadSettlePage(getPooledDb(), { programId, supplierId, query });
  if (!data) notFound();

  const { supplier, match, programName } = data;

  return (
    <main>
      {/*
        A real trail, not a parent pointer. The rest of the app renders
        `[program, current]` everywhere; the citation page builds the owner's
        trail from the record itself and this does the same, so the reader can
        get back to the list of what is still waiting without the back button.
      */}
      <Breadcrumb
        trail={[
          { label: programName, href: `/program/${programId}` },
          { label: 'Needs review', href: `/program/${programId}/needs-review` },
          { label: supplier.rosterName ?? 'This row' },
        ]}
      />
      <h1>{supplier.rosterName}</h1>
      <p className="sub">
        Roster row {supplier.rosterIndex} · {supplier.rosterAddress} · {supplier.rosterCountry}{' '}
        <span className={`badge ${match.status === 'needs_review' ? 'warn' : 'bad'}`}>
          {match.status.replace(/_/g, ' ')}
        </span>
      </p>

      <Answer data={data} programId={programId} />
      <Standard />
      <SharedChecks data={data} />
      <SettleForm data={data} programId={programId} />
      <PastAttempts data={data} />
    </main>
  );
}
