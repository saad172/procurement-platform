import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import { loadCitationPage } from '@/db/queries/citation-page';
import { Breadcrumb } from '@/components/breadcrumb';
import { ChatDock } from '@/components/chat-dock';
import { Citations } from './sections';

/**
 * Where the `❡` lands (SPEC §13.7) — **the bottom of the assessment's spine**.
 *
 * A page renders, `db/queries` reads, `domain` derives: this file is the
 * loader call and its one section, in order — the reasoning for the route and
 * for listing rather than redirecting lives in `sections.tsx`, beside the
 * component it names.
 */
export default async function CitationPage({
  params,
}: {
  params: Promise<{ programId: string; sentenceId: string }>;
}) {
  const { programId, sentenceId } = await params;

  const data = await loadCitationPage(getPooledDb(), { programId, sentenceId });
  if (!data) notFound();

  const { trail, sentence, owner } = data;

  return (
    <main>
      <Breadcrumb trail={trail} />
      <h1>What this sentence rests on</h1>
      <p className="sub">
        {owner.kind === 'assessment'
          ? `${owner.supplierName} · assessment version ${owner.versionN}`
          : `${owner.categoryName} · recommendation version ${owner.versionN}`}{' '}
        · {sentence.section.replace(/_/g, ' ')}
      </p>

      <div className="card">
        <p style={{ margin: 0 }}>{sentence.text}</p>
      </div>

      <Citations data={data} />

      <p className="note" style={{ marginTop: '1rem' }}>
        <Link
          href={
            (owner.kind === 'assessment'
              ? `/program/${programId}/supplier/${owner.supplierId}`
              : `/program/${programId}/category/${owner.categoryId}/recommendation`) as never
          }
        >
          ← back to the {owner.kind}
        </Link>
      </p>
      <ChatDock programId={programId} />
    </main>
  );
}
