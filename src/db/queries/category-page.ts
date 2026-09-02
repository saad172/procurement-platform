import { desc, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { loadShortlist } from '@/db/queries/shortlist';
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
    with: { versions: { orderBy: [desc(t.recommendationVersion.n)], limit: 1 } },
  });

  const scoredLine = category.hsLines.find((l) => l.isDefault);

  /**
   * The Lead rows, the company each one is, and — where Discover found one —
   * the **name** of the Supplier it may be related to. SPEC §11.2 words the
   * badge with the company in it (*possibly related to Yazaki*), which needs a
   * name rather than the `related_supplier_id` the row stores.
   */
  const leads = await db
    .select({ lead: t.lead, entity: t.entity, relatedSupplierName: t.supplier.rosterName })
    .from(t.lead)
    .innerJoin(t.entity, eq(t.entity.id, t.lead.entityId))
    .leftJoin(t.supplier, eq(t.supplier.id, t.lead.relatedSupplierId))
    .where(eq(t.lead.categoryId, categoryId));

  const version = recommendation?.versions[0];
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
      ? { versionN: version.n, evaluatorOutcome: version.evaluatorOutcome }
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
