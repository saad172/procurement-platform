import { desc, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { loadShortlist } from '@/db/queries/shortlist';
import { versionToShowFrom } from '@/jobs/publish';
import { categoryAnswer } from '@/domain/category-answer';
import { parseViewState } from '@/lib/view-state';
import { DEFAULT_WEIGHTS } from '@/domain/score';

/**
 * Everything the Category page renders, in one read (SPEC §13.1).
 *
 * A page reads through `db/queries`, never through the schema — see
 * `supplier-page.ts` for why.
 */
export async function loadCategoryPage(
  db: Database,
  args: {
    programId: string;
    categoryId: string;
    query: Record<string, string | string[] | undefined>;
  },
) {
  const { programId, categoryId, query } = args;

  const program = await db.query.program.findFirst({
    where: eq(t.program.id, programId),
    with: { weights: true },
  });
  const category = await db.query.category.findFirst({
    where: eq(t.category.id, categoryId),
    with: { hsLines: true, flags: { with: { flag: true } } },
  });
  if (!program || !category) return undefined;

  const programDefault = {
    ...DEFAULT_WEIGHTS,
    ...Object.fromEntries(program.weights.map((w) => [w.criterionKey, Number(w.weight)])),
  };
  const view = parseViewState(query, programDefault);

  const shortlist = await loadShortlist(db, {
    programId,
    categoryId,
    weights: view.weights,
    facets: view.facets,
  });

  const recommendation = await db.query.recommendation.findFirst({
    where: eq(t.recommendation.categoryId, categoryId),
    with: { versions: { orderBy: [desc(t.recommendationVersion.n)] } },
  });

  const scoredLine = category.hsLines.find((l) => l.isDefault);

  const leads = await db
    .select({ lead: t.lead, entity: t.entity })
    .from(t.lead)
    .innerJoin(t.entity, eq(t.entity.id, t.lead.entityId))
    .where(eq(t.lead.categoryId, categoryId));

  /**
   * **The same version the Recommendation page shows** (SPEC §12.5), through
   * the same rule: the most recent accepted one if a person accepted one,
   * otherwise the latest. This card is a summary of a page one click away, and
   * a summary naming a different version from the page it links to is two
   * answers to one question.
   */
  const { shown: version } = versionToShowFrom(recommendation?.versions ?? []);

  const answers = categoryAnswer({
    categoryName: category.name,
    // The UNFILTERED shortlist, always: a filtered set would let the crop
    // decide what the page says leads.
    ranked: shortlist.ranked.map((row) => ({
      supplierId: row.supplierId,
      displayName: row.displayName,
      score: row.score,
      coverage: row.coverage,
      disqualifying: row.disqualifying,
    })),
    excluded: shortlist.excluded.map((e) => ({ reason: e.reason })),
    recommendation: version
      ? {
          versionN: version.n,
          evaluatorOutcome: version.evaluatorOutcome,
          // The human's mark leads the answer when there is one: what a person
          // decided is newer news than what the reviewer thought.
          humanMark: version.humanMark,
        }
      : undefined,
    recommendationHref: `/program/${programId}/category/${categoryId}/recommendation`,
    compareHref: null,
    supplierHref: (supplierId) => `/program/${programId}/supplier/${supplierId}`,
  });

  return {
    program,
    category,
    programDefault,
    shortlist,
    scoredLine,
    leads,
    version,
    answers,
  };
}
