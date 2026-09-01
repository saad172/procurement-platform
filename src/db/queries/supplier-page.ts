import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { computeFamilyExposure, unionRiskFactors } from '@/domain/family';
import { DEFAULT_WEIGHTS } from '@/domain/score';
import { supplierAnswer } from '@/domain/supplier-answer';
import { describeSupplier } from '@/domain/supplier-description';
import { entitySchema, type SayariEntity } from '@/upstream/projections/sayari';
import { parseViewState } from '@/lib/view-state';
import { loadEnrichments } from './enrichments';
import { loadShortlist, loadSupplierSnapshots, rankSentence, scoreSnapshot } from './shortlist';

/**
 * Everything the Supplier page renders, in one read (SPEC §13.1).
 *
 * ## Why the page does not do this itself
 *
 * It used to. `page.tsx` was 699 lines, of which 175 were eight drizzle queries
 * and the derivations over them, and the remaining 460 were the answer-first
 * layout those 175 exist to feed. Two different jobs in one function, and the
 * only way to see which was which was to scroll.
 *
 * The rule that came out of it is worth more than the split: **a page reads
 * through `db/queries`, never through the schema.** Before, eleven of thirteen
 * pages queried inline while `db/queries` already held nineteen `loadX()`
 * functions, and nothing said which a new page should use — so the answer was
 * whichever the last person had copied. That is not a style question: it is the
 * difference between a page you can change and a page you have to re-derive.
 *
 * ## Why one bag rather than eleven calls
 *
 * The page needs twenty named things and every one of them is downstream of the
 * same two rows. Handing back eleven promises would move the orchestration into
 * the page, which is the thing being removed. What the page keeps is the part
 * that is genuinely its own: which of these to show, in what order, and what to
 * say when one is absent.
 *
 * `notFound()` is not called here. It is a Next.js control-flow throw and this
 * module knows nothing about routing, so a missing Program or Supplier comes
 * back as `undefined` and the page decides.
 */
export type SupplierPageData = Awaited<ReturnType<typeof loadSupplierPage>>;

export async function loadSupplierPage(
  db: Database,
  args: {
    programId: string;
    supplierId: string;
    /** The raw query string. The weight rail is view state, so it is read here. */
    query: Record<string, string | string[] | undefined>;
  },
) {
  const { programId, supplierId, query } = args;

  const program = await db.query.program.findFirst({
    where: eq(t.program.id, programId),
    with: { weights: true },
  });
  const supplier = await db.query.supplier.findFirst({
    where: eq(t.supplier.id, supplierId),
    with: { categories: { with: { category: true } } },
  });
  if (!program || !supplier) return undefined;

  const programDefault = {
    ...DEFAULT_WEIGHTS,
    ...Object.fromEntries(program.weights.map((w) => [w.criterionKey, Number(w.weight)])),
  };
  const view = parseViewState(query, programDefault);

  const match = await db.query.match.findFirst({
    where: eq(t.match.supplierId, supplierId),
    with: { entity: true, attempts: { orderBy: [desc(t.matchAttempt.attemptN)] } },
  });

  // Read the STORED criterion values, so the page renders what a Citation
  // points at rather than a recomputation that could differ from it.
  const [snapshot] = await loadSupplierSnapshots(db, { programId, supplierIds: [supplierId] });
  const scored = snapshot ? scoreSnapshot(snapshot, view.weights, null) : undefined;

  const familyRows = match?.entityId
    ? await db
        .select({
          member: t.entity,
          hopDepth: t.familyMember.hopDepth,
          exploredCount: t.familyMember.exploredCount,
          reachableCount: t.familyMember.reachableCount,
        })
        .from(t.familyMember)
        .innerJoin(t.entity, eq(t.entity.id, t.familyMember.memberEntityId))
        .where(eq(t.familyMember.rootEntityId, match.entityId))
    : [];

  /**
   * **The coverage figures are read, not counted.**
   *
   * `explored_count` is what the traversal itself reported, and counting rows
   * instead answers a different question — how many rows we hold — which is
   * only ever accidentally the same number. It was not: with the family stored
   * twice for Bosch and Magna, the badge read *"28 of 100 explored"* against a
   * truth of 14 of 50. The unique index added alongside this stops the rows
   * doubling; reading the stored figure is what stops a future divergence from
   * being invisible.
   */
  const coverage = {
    explored: familyRows[0]?.exploredCount ?? familyRows.length,
    reachable: familyRows[0]?.reachableCount ?? null,
  };

  const exposure = computeFamilyExposure(
    familyRows.map((row) => ({
      entityId: row.member.id,
      label: row.member.label,
      country: row.member.country,
      factors: unionRiskFactors([{ source: 'getEntity', risk: row.member.risk }]).map((u) => u.factor),
      fromDeepTraversal: false,
    })),
    coverage,
  );

  // Ages are computed in the query, not during render: reading a clock while
  // rendering is not idempotent, and one read per request is the right number.
  const enrichments = await loadEnrichments(db, match?.entityId ?? supplierId);

  const assessment = await db.query.assessment.findFirst({
    where: and(eq(t.assessment.supplierId, supplierId), eq(t.assessment.kind, 'standard')),
    with: { versions: { orderBy: [desc(t.assessmentVersion.n)], limit: 1 } },
  });
  const version = assessment?.versions[0];
  const sentences = version
    ? await db
        .select()
        .from(t.sentence)
        .where(eq(t.sentence.assessmentVersionId, version.id))
        .orderBy(t.sentence.section, t.sentence.ordinal)
    : [];
  const dissent = version
    ? await db.select().from(t.round).where(eq(t.round.assessmentVersionId, version.id))
    : [];

  /**
   * **Who this company is**, out of its own stored payload.
   *
   * Every fact in the description has been on disk since the first enrichment
   * ran and none of it reached a page: the attribute projection dropped it
   * (BUILD-NOTES finding 90). It is projected here rather than stored flat
   * because it is a *reading* of the payload — the ranking rule that decides
   * which activity leads is one we may change, and re-deriving it from the
   * cached body costs nothing and spends no credits.
   */
  const ownPayload = match?.entity?.upstreamResponseId
    ? await db.query.upstreamResponse.findFirst({
        where: eq(t.upstreamResponse.id, match.entity.upstreamResponseId),
      })
    : undefined;
  let profile: SayariEntity | undefined;
  if (ownPayload) {
    const parsed = entitySchema.safeParse(ownPayload.body);
    // A body that no longer parses is a projection change, not a page error:
    // the rest of the page is unaffected and the description simply says less.
    if (parsed.success) profile = parsed.data as SayariEntity;
  }
  const described = profile ? describeSupplier(profile) : undefined;

  /**
   * The rank, against the **unfiltered** Shortlist of the first category this
   * Supplier bids on — a Supplier page always states it, whatever a filter is
   * doing above it, because "6th of 9" is the figure that gives a score a scale.
   */
  const firstCategory = supplier.categories[0]?.category;
  const shortlist = firstCategory
    ? await loadShortlist(db, { programId, categoryId: firstCategory.id, weights: view.weights })
    : undefined;
  const rank = shortlist
    ? rankSentence(
        shortlist.ranked.find((row) => row.supplierId === supplierId),
        shortlist.totalCount,
      )
    : 'not ranked';

  /** Risk factors on the company itself, as against on its family. */
  const ownRiskFactors = unionRiskFactors([
    { source: 'getEntity', risk: match?.entity?.risk ?? null },
  ]).length;

  const freshest = enrichments.reduce<number | null>(
    (best, e) => (best == null || e.ageDays < best ? e.ageDays : best),
    null,
  );

  const answer = supplierAnswer({
    name: supplier.rosterName ?? match?.entity?.label ?? 'This supplier',
    match: match
      ? {
          status: match.status,
          settledBy: match.settledBy,
          entityLabel: match.entity?.label ?? null,
        }
      : undefined,
    assessment: version
      ? {
          verdict: version.verdict,
          evaluatorOutcome: version.evaluatorOutcome,
          objections: dissent.map((round) => round.objection).filter((o): o is string => o != null),
        }
      : undefined,
    score: scored?.score ?? null,
    scoreAbsentReason: scored?.scoreAbsentReason,
    disqualifying: scored?.disqualifying ?? false,
    needsReviewHref: `/program/${programId}/needs-review`,
    assessmentHref: '#assessment',
    compareHref: firstCategory ? `/program/${programId}/category/${firstCategory.id}` : null,
    categoryName: firstCategory?.name ?? null,
  });

  return {
    program,
    supplier,
    programDefault,
    match,
    scored,
    coverage,
    exposure,
    enrichments,
    version,
    sentences,
    dissent,
    described,
    firstCategory,
    rank,
    ownRiskFactors,
    freshest,
    answer,
  };
}
