import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { DEFAULT_WEIGHTS } from '@/domain/score';
import { supplierAnswer } from '@/domain/supplier-answer';
import { describeSupplier } from '@/domain/supplier-description';
import {
  deriveFamilyCoverage,
  deriveFreshestAge,
  deriveOwnRiskFactorCount,
  deriveSupplierRank,
} from '@/domain/derive-supplier-page';
import { entitySchema, type SayariEntity } from '@/upstream/projections/sayari';
import { parseViewState } from '@/lib/view-state';
import { loadEnrichmentHistory } from './enrichments';
import { loadNetworkPaths, type NetworkPath } from './family-paths';
import { loadShortlist, loadSupplierSnapshots, scoreSnapshot } from './shortlist';

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
 *
 * ## Read, then derive
 *
 * `readSupplierRows` below is only drizzle calls — no shaping. Everything a
 * `derive*` function in `@/domain/derive-supplier-page` (or `supplier-answer.ts`,
 * where that vocabulary already lives) can do without a database call lives
 * there instead, so it can be unit-tested apart from Postgres.
 */
export type SupplierPageData = Awaited<ReturnType<typeof loadSupplierPage>>;

async function readSupplierRows(db: Database, programId: string, supplierId: string) {
  const program = await db.query.program.findFirst({
    where: eq(t.program.id, programId),
    with: { weights: true },
  });
  const supplier = await db.query.supplier.findFirst({
    where: eq(t.supplier.id, supplierId),
    with: { categories: { with: { category: true } } },
  });
  if (!program || !supplier) return undefined;

  const match = await db.query.match.findFirst({
    where: eq(t.match.supplierId, supplierId),
    with: { entity: true, attempts: { orderBy: [desc(t.matchAttempt.attemptN)] } },
  });

  // Read the STORED criterion values, so the page renders what a Citation
  // points at rather than a recomputation that could differ from it.
  const [snapshot] = await loadSupplierSnapshots(db, { programId, supplierIds: [supplierId] });

  /**
   * Every `graph_path` this Profile holds, of ANY kind (network spec §6, §8,
   * §9), joined out to its `entity_relationship` chain — `loadNetworkPaths`,
   * the same widened-past-`family` read `get_supplier_network`
   * (`src/tools/catalog/reads.ts`) groups by kind. Ticket 05 unit 05e widened
   * this from `loadFamilyPaths` (kind `family` only): the diagram and the
   * chain rows below now feed off the SAME list, grouped by kind, so neither
   * can disagree with the other about what the Network holds — and neither
   * can disagree with the chat widget's own `get_supplier_network` grouping,
   * since both read through `loadPathRows`. `discoveredByJob` still
   * distinguishes a Deep Traversal find from an automatic read's own (SPEC
   * §8.5) — a Deep Traversal that walked **down** stays `kind = 'family'`
   * (migration 0013's own comment), so this column, not the row's presence
   * here, is what the page reads to say which walk found a given member.
   */
  const networkPaths: NetworkPath[] = match?.entityId
    ? await loadNetworkPaths(db, match.entityId)
    : [];

  // Ages are computed in the query, not during render: reading a clock while
  // rendering is not idempotent, and one read per request is the right number.
  //
  // Every generation, deliberately: the panel this feeds is headed "what we
  // fetched, and when", so a second fetch of the same source is a second row
  // with its own age badge rather than a replacement (SPEC §7.2).
  const enrichments = await loadEnrichmentHistory(db, match?.entityId ?? supplierId);

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
   * **Who this company is**, out of its own stored payload. Every fact in the
   * description has been on disk since the first enrichment ran and none of it
   * reached a page: the attribute projection dropped it (BUILD-NOTES finding
   * 90). Read here rather than stored flat because it is a *reading* of the
   * payload — the ranking rule that decides which activity leads is one we
   * may change, and re-deriving it from the cached body costs nothing and
   * spends no credits.
   */
  const ownPayload = match?.entity?.upstreamResponseId
    ? await db.query.upstreamResponse.findFirst({
        where: eq(t.upstreamResponse.id, match.entity.upstreamResponseId),
      })
    : undefined;

  const firstCategory = supplier.categories[0]?.category;

  return {
    program,
    supplier,
    match,
    snapshot,
    networkPaths,
    enrichments,
    assessment,
    version,
    sentences,
    dissent,
    ownPayload,
    firstCategory,
  };
}

/** The program's own weight vector, before any URL what-if is applied over it. */
function parseSupplierWeights(program: { weights: { criterionKey: string; weight: string }[] }) {
  return {
    ...DEFAULT_WEIGHTS,
    ...Object.fromEntries(program.weights.map((w) => [w.criterionKey, Number(w.weight)])),
  };
}

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

  const rows = await readSupplierRows(db, programId, supplierId);
  if (!rows) return undefined;
  const { program, supplier, match, snapshot, networkPaths, enrichments } = rows;
  const { version, sentences, dissent, ownPayload, firstCategory } = rows;

  const programDefault = parseSupplierWeights(program);
  const view = parseViewState(query, programDefault);
  const scored = snapshot ? scoreSnapshot(snapshot, view.weights, null) : undefined;

  /**
   * Fetched here rather than inside `readSupplierRows`, because it genuinely
   * depends on `view` — the live weight rail — not only on the Supplier and
   * Program rows. A Shortlist read that used the program's stored default
   * instead would leave the rank frozen while the weight rail above it moved.
   */
  const shortlist = firstCategory
    ? await loadShortlist(db, { programId, categoryId: firstCategory.id, weights: view.weights })
    : undefined;

  // `deriveFamilyCoverage`'s own doc: "The Corporate family's coverage" — kind
  // `family` only, same scope as before `loadNetworkPaths` widened the read
  // past it. Filtered here rather than by a narrower query, since the SAME
  // rows now also feed the diagram and the widened chain rows below.
  const coverage = deriveFamilyCoverage(
    networkPaths
      .filter((p) => p.kind === 'family')
      .map((p) => ({
        member: { id: p.terminalEntityId, label: p.label, country: p.country, risk: p.risk },
        hopDepth: p.hopDepth,
        truncated: p.truncated,
        reachableCount: p.reachableCount,
        discoveredByJob: p.discoveredByJob,
      })),
  );

  let profile: SayariEntity | undefined;
  if (ownPayload) {
    const parsed = entitySchema.safeParse(ownPayload.body);
    // A body that no longer parses is a projection change, not a page error:
    // the rest of the page is unaffected and the description simply says less.
    if (parsed.success) profile = parsed.data as SayariEntity;
  }
  const described = profile ? describeSupplier(profile) : undefined;

  const rank = deriveSupplierRank(shortlist, supplierId);
  const ownRiskFactors = deriveOwnRiskFactorCount(match?.entity?.risk ?? null);
  const freshest = deriveFreshestAge(enrichments);

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
    // The citable chain rows sit beneath Network exposure's raw inputs and
    // the diagram (network spec §5, §6, §8) — every Path this Profile holds,
    // of every kind, each with its own ordered `entity_relationship` chain.
    // Field name kept as `familyChain` (ticket 05 unit 05e widened its
    // CONTENT past `kind = 'family'`, not this name — `FamilyChainRows` and
    // the tests that read this field both already use it): the diagram and
    // the widened `FamilyChainRows` render the exact same list, grouped by
    // kind, so neither can disagree with the other about what the Network
    // holds. The Corporate-family-only exposure badge that used to sit here
    // is gone; a member's own risk is scored once, in `networkExposure`
    // (`src/domain/scoring/criteria.ts`) — the Network section 03e builds on
    // this data replaces the old Corporate family section that read
    // `coverage`/`exposure` together.
    familyChain: networkPaths,
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
