import type { SayariRecord } from '@/upstream/projections/sayari';

/**
 * What a model sees when it fetches a Sayari source record.
 *
 * A record's `references` block embeds every entity the record mentions —
 * each one a fully-populated entity, not a summary or an id. Nothing
 * downstream reads that block; a record is fetched so a citation can point
 * at a local, citable row, not so a model can read what else it mentions.
 * So the references themselves are dropped here, and only their count
 * survives — enough to say "this record also mentions four other companies"
 * without shipping four companies' worth of risk factors and addresses to
 * say it.
 */
export type RecordView = {
  id: string;
  source: string | null;
  label: string | null;
  publicationDate: string | null;
  acquisitionDate: string | null;
  documentUrl: string | null;
  /** How many entities `references` held — the count, not the entities. */
  referencesCount: number | null;
};

export function toRecordView(record: SayariRecord): RecordView {
  return {
    id: record.id,
    source: record.source ?? null,
    label: record.label ?? null,
    publicationDate: record.publication_date ?? null,
    acquisitionDate: record.acquisition_date ?? null,
    documentUrl: record.document_url ?? null,
    referencesCount: record.references_count ?? null,
  };
}
