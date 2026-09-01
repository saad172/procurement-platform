import { and, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';

/**
 * What a sentence cites, resolved to live rows (SPEC §13.7).
 *
 * **A Citation is a hop, not a tooltip**, and a hop needs somewhere to land.
 * The `❡` after every published sentence pointed at a route that did not exist:
 * 169 links, every one of them a 404, on the three Assessments published so
 * far. The evidence was never missing — all 169 sentences carry at least one
 * Citation and there are 236 of them in total — so the fix is the landing
 * place, not the link.
 *
 * The `citation` table's one-of CHECK guarantees exactly one target group per
 * row, so this reads as a closed set of six kinds. Three are in use today
 * (`criterion_value` 146, `entity` 72, `match` 18); the other three are
 * resolved anyway, because a Citation kind that appears for the first time
 * should render rather than vanish.
 *
 * **A dangling Citation renders as dangling.** `submit-checks` refuses to
 * publish one and the database's foreign keys refuse to store one, so this
 * should never happen — but a page that silently dropped an unresolvable row
 * would turn the strongest claim in the build into one nobody could check.
 */

export type CitationTargetKind =
  | 'entity'
  | 'record'
  | 'enrichment'
  | 'criterion_value'
  | 'match'
  | 'shortlist';

export type ResolvedCitation = {
  id: string;
  kind: CitationTargetKind;
  /** What this citation points at, in the reader's words. */
  title: string;
  /** The line under it: what the row actually says. */
  detail: string | null;
  /** Where clicking it goes. Null when the target has no page of its own. */
  href: string | null;
  /** Set when the row the citation names is not there. */
  dangling: boolean;
};

export type SentenceEvidence = {
  sentence: { id: string; section: string; ordinal: number; text: string };
  /** Which published thing the sentence belongs to, for the trail. */
  owner:
    | { kind: 'assessment'; supplierId: string; supplierName: string; versionN: number }
    | { kind: 'recommendation'; categoryId: string; categoryName: string; versionN: number };
  citations: ResolvedCitation[];
};

export async function loadSentenceEvidence(
  db: Database,
  args: { programId: string; sentenceId: string },
): Promise<SentenceEvidence | null> {
  const sentence = await db.query.sentence.findFirst({
    where: eq(t.sentence.id, args.sentenceId),
  });
  if (!sentence) return null;

  // Scoped to the Program in the URL: a sentence reached through the wrong
  // one is not this Program's evidence, and rendering it anyway would let a
  // hand-edited URL cross a boundary the rest of the app keeps.
  const owner = await loadOwner(db, sentence, args.programId);
  if (!owner) return null;

  const rows = await db
    .select()
    .from(t.citation)
    .where(eq(t.citation.sentenceId, sentence.id))
    .orderBy(t.citation.id);

  const citations: ResolvedCitation[] = [];
  for (const row of rows) {
    citations.push(await resolveCitation(db, args.programId, row));
  }

  return {
    sentence: {
      id: sentence.id,
      section: sentence.section,
      ordinal: sentence.ordinal,
      text: sentence.text,
    },
    owner,
    citations,
  };
}

async function loadOwner(
  db: Database,
  sentence: typeof t.sentence.$inferSelect,
  programId: string,
): Promise<SentenceEvidence['owner'] | null> {
  if (sentence.assessmentVersionId) {
    const [row] = await db
      .select({
        supplierId: t.supplier.id,
        rosterName: t.supplier.rosterName,
        entityLabel: t.entity.label,
        versionN: t.assessmentVersion.n,
      })
      .from(t.assessmentVersion)
      .innerJoin(t.assessment, eq(t.assessment.id, t.assessmentVersion.assessmentId))
      .innerJoin(t.supplier, eq(t.supplier.id, t.assessment.supplierId))
      .leftJoin(t.match, eq(t.match.supplierId, t.supplier.id))
      .leftJoin(t.entity, eq(t.entity.id, t.match.entityId))
      .where(
        and(
          eq(t.assessmentVersion.id, sentence.assessmentVersionId),
          eq(t.supplier.programId, programId),
        ),
      );
    if (!row) return null;
    return {
      kind: 'assessment',
      supplierId: row.supplierId,
      // The roster name is what a buyer typed and what they will recognise;
      // the resolved legal name is the fallback for a discovered Supplier,
      // which has no roster name at all.
      supplierName: row.rosterName ?? row.entityLabel ?? 'Supplier',
      versionN: row.versionN,
    };
  }

  if (sentence.recommendationVersionId) {
    const [row] = await db
      .select({
        categoryId: t.category.id,
        categoryName: t.category.name,
        versionN: t.recommendationVersion.n,
      })
      .from(t.recommendationVersion)
      .innerJoin(
        t.recommendation,
        eq(t.recommendation.id, t.recommendationVersion.recommendationId),
      )
      .innerJoin(t.category, eq(t.category.id, t.recommendation.categoryId))
      .where(
        and(
          eq(t.recommendationVersion.id, sentence.recommendationVersionId),
          eq(t.category.programId, programId),
        ),
      );
    if (!row) return null;
    return {
      kind: 'recommendation',
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      versionN: row.versionN,
    };
  }

  // Unreachable under `sentence_one_owner`, and stated rather than assumed.
  return null;
}

async function resolveCitation(
  db: Database,
  programId: string,
  row: typeof t.citation.$inferSelect,
): Promise<ResolvedCitation> {
  const base = { id: row.id, dangling: false };

  if (row.entityId) return resolveEntityCitation(db, programId, row.entityId, base);
  if (row.recordId) return resolveRecordCitation(db, programId, row.recordId, base);
  if (row.enrichmentId) return resolveEnrichmentCitation(db, row.enrichmentId, base);
  if (row.criterionValueId) {
    return resolveCriterionValueCitation(db, programId, row.criterionValueId, base);
  }
  if (row.matchId) return resolveMatchCitation(db, programId, row.matchId, base);
  if (row.shortlistProgramId && row.shortlistCategoryId) {
    return resolveShortlistCitation(db, row.shortlistProgramId, row.shortlistCategoryId, base);
  }

  // The one-of CHECK makes this unreachable; it is here so that if the CHECK
  // is ever loosened the page says so instead of rendering an empty row.
  return {
    ...base,
    kind: 'entity',
    title: 'Unknown citation target',
    detail: null,
    href: null,
    dangling: true,
  };
}

async function resolveEntityCitation(
  db: Database,
  programId: string,
  entityId: string,
  base: { id: string; dangling: boolean },
): Promise<ResolvedCitation> {
  const entity = await db.query.entity.findFirst({ where: eq(t.entity.id, entityId) });
  return {
    ...base,
    kind: 'entity',
    title: entity?.label ?? entityId,
    detail: entity ? [entity.entityType, entity.country].filter(Boolean).join(' · ') || null : null,
    href: `/program/${programId}/entity/${entityId}`,
    dangling: !entity,
  };
}

async function resolveRecordCitation(
  db: Database,
  programId: string,
  recordId: string,
  base: { id: string; dangling: boolean },
): Promise<ResolvedCitation> {
  const record = await db.query.record.findFirst({ where: eq(t.record.id, recordId) });
  return {
    ...base,
    kind: 'record',
    title: record?.sourceLabel ?? record?.source ?? 'Source record',
    detail: recordId,
    // A record id is a path, so the route takes it as a catch-all segment —
    // see the record page for why encoding harder does not work.
    href: `/program/${programId}/record/${recordId.split('/').map(encodeURIComponent).join('/')}`,
    dangling: !record,
  };
}

async function resolveEnrichmentCitation(
  db: Database,
  enrichmentId: string,
  base: { id: string; dangling: boolean },
): Promise<ResolvedCitation> {
  const enrichment = await db.query.enrichment.findFirst({
    where: eq(t.enrichment.id, enrichmentId),
  });
  return {
    ...base,
    kind: 'enrichment',
    title: enrichment ? enrichment.source.replace(/_/g, ' ') : 'Enrichment',
    detail: enrichment
      ? `${enrichment.subjectKind} ${enrichment.subjectKey} · fetched ${enrichment.fetchedAt.toISOString().slice(0, 10)}`
      : null,
    // Enrichments are listed on the Supplier page rather than having a page
    // of their own; naming the row is the honest thing this can offer.
    href: null,
    dangling: !enrichment,
  };
}

async function resolveCriterionValueCitation(
  db: Database,
  programId: string,
  criterionValueId: string,
  base: { id: string; dangling: boolean },
): Promise<ResolvedCitation> {
  const [value] = await db
    .select({
      criterionKey: t.criterionValue.criterionKey,
      label: t.criterion.label,
      value: t.criterionValue.value,
      unknownReason: t.criterionValue.unknownReason,
      anchorLine: t.criterionValue.anchorLine,
      supplierId: t.criterionValue.supplierId,
    })
    .from(t.criterionValue)
    .leftJoin(t.criterion, eq(t.criterion.key, t.criterionValue.criterionKey))
    .where(eq(t.criterionValue.id, criterionValueId));
  return {
    ...base,
    kind: 'criterion_value',
    title: value?.label ?? value?.criterionKey ?? 'Criterion',
    // `anchor_line` is the criterion's own account of how the number was
    // arrived at, stored beside it and never recomputed at render.
    detail: value
      ? `${value.value ?? value.unknownReason ?? 'unknown'} — ${value.anchorLine}`
      : null,
    href: value ? `/program/${programId}/supplier/${value.supplierId}` : null,
    dangling: !value,
  };
}

async function resolveMatchCitation(
  db: Database,
  programId: string,
  matchId: string,
  base: { id: string; dangling: boolean },
): Promise<ResolvedCitation> {
  const [match] = await db
    .select({
      supplierId: t.match.supplierId,
      status: t.match.status,
      settledBy: t.match.settledBy,
      entityLabel: t.entity.label,
    })
    .from(t.match)
    .leftJoin(t.entity, eq(t.entity.id, t.match.entityId))
    .where(eq(t.match.id, matchId));
  return {
    ...base,
    kind: 'match',
    title: match?.entityLabel ?? 'Match',
    detail: match ? `${match.status.replace(/_/g, ' ')}, settled by ${match.settledBy}` : null,
    href: match ? `/program/${programId}/supplier/${match.supplierId}` : null,
    dangling: !match,
  };
}

async function resolveShortlistCitation(
  db: Database,
  shortlistProgramId: string,
  shortlistCategoryId: string,
  base: { id: string; dangling: boolean },
): Promise<ResolvedCitation> {
  const category = await db.query.category.findFirst({
    where: and(
      eq(t.category.id, shortlistCategoryId),
      eq(t.category.programId, shortlistProgramId),
    ),
  });
  return {
    ...base,
    kind: 'shortlist',
    title: category ? `${category.code} shortlist` : 'Shortlist',
    detail: category?.name ?? null,
    href: category ? `/program/${shortlistProgramId}/category/${shortlistCategoryId}` : null,
    dangling: !category,
  };
}
