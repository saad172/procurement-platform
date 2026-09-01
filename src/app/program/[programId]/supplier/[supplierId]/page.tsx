import { notFound } from 'next/navigation';
import { getPooledDb } from '@/db/client';
import { ChatDock } from '@/components/chat-dock';
import { loadSupplierPage } from '@/db/queries/supplier-page';
import {
  Answer,
  CorporateFamily,
  Enrichments,
  Heading,
  TheWorking,
  WhatWasConcluded,
  WhereItStands,
  WhoItIs,
} from './sections';

/**
 * The Supplier page (SPEC §13.1) — level three, and **one long scroll**.
 *
 * A page renders, `db/queries` reads, `domain` derives: this file is the
 * loader call and its sections, in order — the answer-first ordering and the
 * reasoning behind it live in `sections.tsx`, beside the components it names.
 *
 * The spine is still navigation rather than stacked columns: a column would cap
 * this pane at a column's width, and these are the widest things in the app.
 */
export default async function SupplierPage({
  params,
  searchParams,
}: {
  params: Promise<{ programId: string; supplierId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { programId, supplierId } = await params;
  const query = await searchParams;

  const data = await loadSupplierPage(getPooledDb(), { programId, supplierId, query });
  if (!data) notFound();

  return (
    <main>
      <Heading data={data} programId={programId} />
      <Answer data={data} />
      <WhereItStands data={data} />
      <WhoItIs data={data} programId={programId} />
      <WhatWasConcluded data={data} programId={programId} />
      <TheWorking data={data} programId={programId} supplierId={supplierId} />
      <CorporateFamily data={data} programId={programId} />
      <Enrichments data={data} />
      <ChatDock programId={programId} />
    </main>
  );
}
