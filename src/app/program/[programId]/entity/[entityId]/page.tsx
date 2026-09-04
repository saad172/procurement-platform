import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import { loadEntityPage } from '@/db/queries/entity-page';
import { ChatDock } from '@/components/chat-dock';
import {
  Attributes,
  Heading,
  PathsThroughEntity,
  RelationshipCounts,
  Relationships,
  RiskFactors,
  Sources,
  SourcePayload,
} from './sections';

/**
 * The Sayari entity page (SPEC §13.1, §13.7) — level four of the spine.
 *
 * A page renders, `db/queries` reads, `domain` derives: this file is the
 * loader call and its sections, in order; `sections.tsx` holds one component
 * per `<h2>`, plus the chrome ahead of the first one.
 *
 * The risk table is the interesting part, because it shows *how each factor was
 * treated* rather than only that it exists — which variant it carries, whether
 * it deducted, and if not, why not.
 */
export default async function EntityPage({
  params,
}: {
  params: Promise<{ programId: string; entityId: string }>;
}) {
  const { programId, entityId } = await params;

  const data = await loadEntityPage(getPooledDb(), { programId, entityId });
  if (!data) notFound();

  return (
    <main>
      <Heading data={data} programId={programId} />

      <div className="grid two">
        <Attributes data={data} />
        <RelationshipCounts data={data} />
      </div>

      <Sources data={data} />
      <RiskFactors data={data} />
      <PathsThroughEntity data={data} programId={programId} />

      <p className="note" style={{ marginTop: '1rem' }}>
        <Link href={`/program/${programId}` as never}>← back to the program</Link>
      </p>

      <Relationships data={data} />
      <SourcePayload data={data} programId={programId} entityId={entityId} />

      <ChatDock programId={programId} />
    </main>
  );
}
