import { and, asc, desc, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { versionToShowFrom } from '@/jobs/publish';

/**
 * Everything this page renders, in one read (SPEC §13.1).
 *
 * A page reads through `db/queries`, never through the schema — see
 * `supplier-page.ts` for why.
 *
 * ## Which version this returns (SPEC §12.5)
 *
 * **The most recent accepted one if a person accepted one, otherwise the
 * latest** — `versionToShowFrom` owns that rule, and this file only feeds it.
 * Taking `versions[0]` by `desc(n)` here, which is what it used to do, meant a
 * re-run silently replaced a decision somebody had made: the accepted version
 * was still in the table, still accepted, and no longer on the page. The count
 * of newer siblings comes back with it so the page can say one exists rather
 * than quietly hiding the newest argument.
 */
export async function loadRecommendationPage(
  db: Database,
  args: { programId: string; categoryId: string; versionN?: number | undefined },
) {
  const { programId, categoryId, versionN } = args;

  const category = await db.query.category.findFirst({
    where: and(eq(t.category.id, categoryId), eq(t.category.programId, programId)),
  });
  if (!category) return undefined;

  const program = await db.query.program.findFirst({ where: eq(t.program.id, programId) });

  const recommendation = await db.query.recommendation.findFirst({
    where: and(
      eq(t.recommendation.categoryId, categoryId),
      eq(t.recommendation.programId, programId),
    ),
    // Every version, newest first: the page lists them with their marks, and
    // the rule below reads the same rows rather than asking for them twice.
    with: { versions: { orderBy: [desc(t.recommendationVersion.n)] } },
  });
  const versions = recommendation?.versions ?? [];
  const { shown } = versionToShowFrom(versions);

  /**
   * A version asked for by number wins over the rule.
   *
   * The strip naming a newer sibling has to lead somewhere, or *acceptance
   * never moves* becomes a trap: the newer argument would be unreadable in the
   * app that wrote it, and the only way to accept it would be to un-accept the
   * old one first. An unknown number falls back to the rule rather than 404s —
   * it is a URL a person edited, not a missing page.
   */
  const pinned = versionN != null ? versions.find((v) => v.n === versionN) : undefined;
  const version = pinned ?? shown;
  const newer = version ? versions.filter((v) => v.n > version.n).length : 0;

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
    /** Newest first, each with its own mark: a version list is a list of decisions. */
    versions,
    /** How many versions were written after the one being shown. */
    newer,
    /** The latest version, which the newer-sibling strip names and links. */
    latest: versions[0],
    /** True when the reader asked for a version the rule would not have shown. */
    pinned: pinned != null && shown != null && pinned.n !== shown.n,
    picks,
    sentences,
    dissent,
  };
}
