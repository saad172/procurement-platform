import { and, asc, desc, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';

/**
 * Everything this page renders, in one read (SPEC §13.1).
 *
 * A page reads through `db/queries`, never through the schema — see
 * `supplier-page.ts` for why.
 */
export async function loadRecommendationPage(
  db: Database,
  args: { programId: string, categoryId: string },
) {
  const { programId, categoryId } = args;

  const category = await db.query.category.findFirst({
    where: and(eq(t.category.id, categoryId), eq(t.category.programId, programId)),
  });
  if (!category) return undefined;

  const program = await db.query.program.findFirst({ where: eq(t.program.id, programId) });

  const recommendation = await db.query.recommendation.findFirst({
    where: and(eq(t.recommendation.categoryId, categoryId), eq(t.recommendation.programId, programId)),
    with: { versions: { orderBy: [desc(t.recommendationVersion.n)], limit: 1 } },
  });
  const version = recommendation?.versions[0];

  const picks = version
    ? await db
        .select({
          role: t.recommendationPick.role,
          rank: t.recommendationPick.rank,
          supplierId: t.supplier.id,
          rosterName: t.supplier.rosterName,
          entityLabel: t.entity.label,
        })
        .from(t.recommendationPick)
        .innerJoin(t.supplier, eq(t.supplier.id, t.recommendationPick.supplierId))
        .leftJoin(t.match, eq(t.match.supplierId, t.supplier.id))
        .leftJoin(t.entity, eq(t.entity.id, t.match.entityId))
        .where(eq(t.recommendationPick.recommendationVersionId, version.id))
        .orderBy(asc(t.recommendationPick.rank))
    : [];

  const sentences = version
    ? await db
        .select()
        .from(t.sentence)
        .where(eq(t.sentence.recommendationVersionId, version.id))
        .orderBy(t.sentence.section, t.sentence.ordinal)
    : [];

  const dissent = version
    ? await db.select().from(t.round).where(eq(t.round.recommendationVersionId, version.id))
    : [];

  return {
    category,
    program,
    version,
    picks,
    sentences,
    dissent,
  };
}
