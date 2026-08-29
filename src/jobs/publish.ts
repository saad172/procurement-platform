import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import type { RoundRecord } from './rounds';
import type { SubmittedPick, SubmittedSentence } from '@/domain/validation/submit-checks';

/**
 * Publishing a version (SPEC §10.6).
 *
 * **A version contains its Rounds; it is not created by one.** Intermediate
 * drafts live in `round.text`; `sentence` rows are written **once, when the
 * loop ends**, so the insert-time citation guarantee covers exactly what is
 * displayed and nothing else.
 *
 * Everything here happens in **one transaction**. If a citation turns out not
 * to resolve at insert time — despite having resolved during validation — the
 * whole version rolls back rather than landing half-written. The database CHECK
 * is the last line of that defence, and it is meant never to fire.
 */

export type CitationTarget = SubmittedSentence['citations'][number];

/** A stable key for a citation, so validation and insert agree on identity. */
export const citationKey = (c: CitationTarget): string => JSON.stringify(c, Object.keys(c).sort());

/**
 * Resolves every citation target to a **live local row**, before anything is
 * written.
 *
 * A target that does not resolve comes back `undefined`, and the caller turns
 * that into an objection. This is the step that makes "a citation points at
 * stored evidence" true rather than aspirational: the model can name any id it
 * likes, and only the ones that exist survive.
 */
export async function resolveCitations(
  db: Database,
  citations: readonly CitationTarget[],
): Promise<Map<string, Record<string, unknown> | undefined>> {
  const resolved = new Map<string, Record<string, unknown> | undefined>();

  for (const citation of citations) {
    const key = citationKey(citation);
    if (resolved.has(key)) continue;

    if (citation.entityId) {
      resolved.set(key, await first(db.select().from(t.entity).where(eq(t.entity.id, citation.entityId))));
    } else if (citation.recordId) {
      resolved.set(key, await first(db.select().from(t.record).where(eq(t.record.id, citation.recordId))));
    } else if (citation.enrichmentId) {
      resolved.set(key, await first(db.select().from(t.enrichment).where(eq(t.enrichment.id, citation.enrichmentId))));
    } else if (citation.criterionValueId) {
      resolved.set(
        key,
        await first(db.select().from(t.criterionValue).where(eq(t.criterionValue.id, citation.criterionValueId))),
      );
    } else if (citation.matchId) {
      resolved.set(key, await first(db.select().from(t.match).where(eq(t.match.id, citation.matchId))));
    } else if (citation.shortlist) {
      // The Shortlist reference is a PAIR, and both halves must exist. A
      // Shortlist is computed rather than stored, so what resolves here is the
      // (programme, category) it is a shortlist OF.
      const category = await first(
        db
          .select()
          .from(t.category)
          .where(
            and(eq(t.category.id, citation.shortlist.categoryId), eq(t.category.programId, citation.shortlist.programId)),
          ),
      );
      resolved.set(key, category);
    } else {
      // No target group at all. The database CHECK would refuse it; catching it
      // here means the model gets an objection rather than a constraint error.
      resolved.set(key, undefined);
    }
  }

  return resolved;
}

async function first<T>(query: Promise<T[]>): Promise<T | undefined> {
  return (await query)[0];
}

export type PublishAssessment = {
  kind: 'assessment';
  supplierId: string;
  programId: string;
  verdict: string | null;
  assessmentKind?: 'standard' | 'dossier';
};

export type PublishRecommendation = {
  kind: 'recommendation';
  programId: string;
  categoryId: string;
  picks: SubmittedPick[];
};

/**
 * Writes one version, its sentences, its citations, its picks and its Rounds.
 *
 * **A re-run always versions**, even when the text is identical, because *"the
 * weights changed and the argument didn't"* is the most interesting thing the
 * diff can say. So this always inserts `n + 1` rather than looking for a
 * matching version to reuse.
 */
export async function publishVersion(
  db: Database,
  args: {
    target: PublishAssessment | PublishRecommendation;
    sentences: SubmittedSentence[];
    rounds: RoundRecord[];
    dissent: { objection: string; reply: string | undefined }[];
    frozenInputs: Record<string, unknown>;
    evaluatorOutcome: 'passed' | 'published_with_objections';
    jobId?: string | undefined;
  },
): Promise<{ versionId: string; n: number }> {
  return db.transaction(async (tx) => {
    const versionId =
      args.target.kind === 'assessment'
        ? await insertAssessmentVersion(tx, args)
        : await insertRecommendationVersion(tx, args);

    const pickIdBySupplier = new Map<string, string>();
    if (args.target.kind === 'recommendation') {
      for (const pick of args.target.picks) {
        const [row] = await tx
          .insert(t.recommendationPick)
          .values({
            recommendationVersionId: versionId,
            supplierId: pick.supplierId,
            role: pick.role as never,
            rank: pick.rank,
          })
          .returning({ id: t.recommendationPick.id });
        pickIdBySupplier.set(pick.supplierId, row!.id);
      }
    }

    // Sentences are written ONCE, here, at the end of the loop.
    const bySection = new Map<string, number>();
    for (const sentence of args.sentences) {
      const ordinal = (bySection.get(sentence.section) ?? 0) + 1;
      bySection.set(sentence.section, ordinal);

      const [row] = await tx
        .insert(t.sentence)
        .values({
          assessmentVersionId: args.target.kind === 'assessment' ? versionId : null,
          recommendationVersionId: args.target.kind === 'recommendation' ? versionId : null,
          section: sentence.section as never,
          ordinal,
          text: sentence.text,
          pickId: sentence.pickSupplierId ? (pickIdBySupplier.get(sentence.pickSupplierId) ?? null) : null,
        })
        .returning({ id: t.sentence.id });

      for (const citation of sentence.citations) {
        await tx.insert(t.citation).values({
          sentenceId: row!.id,
          entityId: citation.entityId ?? null,
          recordId: citation.recordId ?? null,
          enrichmentId: citation.enrichmentId ?? null,
          criterionValueId: citation.criterionValueId ?? null,
          matchId: citation.matchId ?? null,
          shortlistProgramId: citation.shortlist?.programId ?? null,
          shortlistCategoryId: citation.shortlist?.categoryId ?? null,
        });
      }
    }

    // Dissent is assembled from the surviving objections, as `round` rows with
    // their replies. NOBODY WRITES IT — there is no dissent section to author.
    for (const round of args.rounds) {
      await tx.insert(t.round).values({
        assessmentVersionId: args.target.kind === 'assessment' ? versionId : null,
        recommendationVersionId: args.target.kind === 'recommendation' ? versionId : null,
        matchAttemptId: null,
        n: round.n,
        role: round.role,
        source: round.source,
        text: round.text ?? null,
        objection: round.objection ?? null,
        reply: round.reply ?? null,
        rubric: (round.rubric ?? null) as never,
      });
    }

    return { versionId, n: await currentN(tx, args.target, versionId) };
  });
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

async function insertAssessmentVersion(
  tx: Tx,
  args: Parameters<typeof publishVersion>[1],
): Promise<string> {
  const target = args.target as PublishAssessment;
  let assessment = await tx.query.assessment.findFirst({
    where: and(
      eq(t.assessment.supplierId, target.supplierId),
      eq(t.assessment.kind, target.assessmentKind ?? 'standard'),
    ),
  });
  if (!assessment) {
    const [row] = await tx
      .insert(t.assessment)
      .values({
        supplierId: target.supplierId,
        programId: target.programId,
        kind: target.assessmentKind ?? 'standard',
      })
      .returning();
    assessment = row!;
  }

  const [{ next }] = (await tx
    .select({ next: sql<number>`coalesce(max(${t.assessmentVersion.n}), 0) + 1` })
    .from(t.assessmentVersion)
    .where(eq(t.assessmentVersion.assessmentId, assessment.id))) as [{ next: number }];

  const [version] = await tx
    .insert(t.assessmentVersion)
    .values({
      assessmentId: assessment.id,
      // Nullable, because a Dossier has no verdict — the honest cost of a
      // Dossier being an `assessment` rather than a table of its own.
      verdict: (target.verdict ?? null) as never,
      n: next,
      frozenInputs: args.frozenInputs as never,
      evaluatorOutcome: args.evaluatorOutcome,
      jobId: args.jobId ?? null,
    })
    .returning({ id: t.assessmentVersion.id });
  return version!.id;
}

async function insertRecommendationVersion(
  tx: Tx,
  args: Parameters<typeof publishVersion>[1],
): Promise<string> {
  const target = args.target as PublishRecommendation;
  let recommendation = await tx.query.recommendation.findFirst({
    where: and(
      eq(t.recommendation.programId, target.programId),
      eq(t.recommendation.categoryId, target.categoryId),
    ),
  });
  if (!recommendation) {
    const [row] = await tx
      .insert(t.recommendation)
      .values({ programId: target.programId, categoryId: target.categoryId })
      .returning();
    recommendation = row!;
  }

  const [{ next }] = (await tx
    .select({ next: sql<number>`coalesce(max(${t.recommendationVersion.n}), 0) + 1` })
    .from(t.recommendationVersion)
    .where(eq(t.recommendationVersion.recommendationId, recommendation.id))) as [{ next: number }];

  const [version] = await tx
    .insert(t.recommendationVersion)
    .values({
      recommendationId: recommendation.id,
      n: next,
      frozenInputs: args.frozenInputs as never,
      evaluatorOutcome: args.evaluatorOutcome,
      jobId: args.jobId ?? null,
      // The human mark starts absent. A re-run NEVER clears an accepted mark,
      // which is why it lives on the version rather than on the header.
      humanMark: null,
    })
    .returning({ id: t.recommendationVersion.id });
  return version!.id;
}

async function currentN(tx: Tx, target: PublishAssessment | PublishRecommendation, versionId: string): Promise<number> {
  if (target.kind === 'assessment') {
    const row = await tx.query.assessmentVersion.findFirst({ where: eq(t.assessmentVersion.id, versionId) });
    return row?.n ?? 1;
  }
  const row = await tx.query.recommendationVersion.findFirst({ where: eq(t.recommendationVersion.id, versionId) });
  return row?.n ?? 1;
}

/**
 * The version a page shows (SPEC §12.5).
 *
 * **Acceptance never moves.** A Recommendation page shows the most recent
 * **accepted** version if one exists, otherwise the latest — with a strip
 * naming any newer version and linking its diff. A re-run never clears an
 * accepted mark, so a newer version does not silently replace a decision
 * somebody made.
 *
 * An Assessment has no human mark, so a Supplier page always shows the latest.
 */
export async function versionToShow(
  db: Database,
  recommendationId: string,
): Promise<{ shown: typeof t.recommendationVersion.$inferSelect | undefined; newer: number }> {
  const versions = await db
    .select()
    .from(t.recommendationVersion)
    .where(eq(t.recommendationVersion.recommendationId, recommendationId))
    .orderBy(desc(t.recommendationVersion.n));

  const accepted = versions.find((v) => v.humanMark === 'accepted');
  const shown = accepted ?? versions[0];
  const newer = shown ? versions.filter((v) => v.n > shown.n).length : 0;
  return { shown, newer };
}
