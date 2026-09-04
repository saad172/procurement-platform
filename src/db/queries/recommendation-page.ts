import { and, asc, desc, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { versionToShowFrom } from '@/jobs/publish';
import { loadShortestPathPaths, type FamilyPath } from './family-paths';

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
          // The Profile's own entity id — added for the Concentration Paths
          // match below (network spec §8, ticket 05 unit 05g). Free: `match`
          // and `entity` were already left-joined here for `entityLabel`.
          entityId: t.match.entityId,
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

  const concentrationPaths = await loadConcentrationPaths(db, picks);

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
    concentrationPaths,
  };
}

/**
 * One `second_source` Pick, joined to the `shortest_path` Path the recommend
 * Job's ninth check found (or none) between it and the award (network spec
 * §4.2, §7, §8).
 *
 * Carries the award's own entity id/label alongside the Path — a
 * `shortest_path` Path's `graph_path.root_entity_id` is always the AWARD's
 * entity (`findConcentrations`'s own `rootEntityId: awardEntityId`,
 * `src/jobs/recommend.ts`), never the `second_source` Pick's, so a caller
 * feeding `NetworkMap`'s `roots` prop needs the award's id/label to name the
 * diagram's own hub correctly — `path.terminalEntityId`/`path.label` describe
 * the SECOND SOURCE end, not the award.
 */
export type ConcentrationPickPath = {
  award: { entityId: string; label: string | null };
  pick: { supplierId: string; rosterName: string | null; entityLabel: string | null };
  path: FamilyPath;
};

/**
 * The Picks' Concentration Paths — "the Picks' Paths beside the conditions
 * that name them" (network spec §8's own Recommendation row) — matched from
 * `graph_path` rows of kind `shortest_path` (ticket 04's `findConcentrations`,
 * `src/jobs/recommend.ts`: at submission, `shortestPath` for the award
 * against each `second_source` Pick, `rootEntityId` always the AWARD's own
 * entity id).
 *
 * **The match, exactly**: load every `shortest_path` Path rooted at the
 * award's entity id (`loadShortestPathPaths`, `src/db/queries/family-paths.ts`
 * — at most two rows in practice, `findConcentrations`'s own doc comment: at
 * most three picks, exactly one award), then for each `second_source` Pick
 * with its own entity id, keep the Path whose `terminalEntityId` equals that
 * Pick's entity id. No fuzzy name matching: `graph_path`'s own
 * `(root_entity_id, terminal_entity_id, kind)` pair IS the join key
 * `findAndWriteShortestPath` wrote (`src/jobs/shortest-path.ts`).
 *
 * A Recommendation with no award, an award with no accepted Profile, or no
 * second source whose shortest-path walk ever found a Path (the common case
 * — `findAndWriteShortestPath` writes nothing at all when Sayari returns no
 * path, network spec §4.2's "No Path, no further cost") returns an empty
 * array, not an error: the page's own section renders nothing in that case,
 * exactly like `Dissent` renders nothing when no round objected.
 */
async function loadConcentrationPaths(
  db: Database,
  picks: readonly {
    role: string;
    supplierId: string;
    rosterName: string | null;
    entityLabel: string | null;
    entityId: string | null;
  }[],
): Promise<ConcentrationPickPath[]> {
  const award = picks.find((p) => p.role === 'award');
  if (!award?.entityId) return [];

  const shortestPaths = await loadShortestPathPaths(db, award.entityId);
  if (shortestPaths.length === 0) return [];

  const results: ConcentrationPickPath[] = [];
  for (const pick of picks) {
    if (pick.role !== 'second_source' || !pick.entityId) continue;
    const path = shortestPaths.find((p) => p.terminalEntityId === pick.entityId);
    if (!path) continue;
    results.push({
      award: { entityId: award.entityId, label: award.entityLabel },
      pick: { supplierId: pick.supplierId, rosterName: pick.rosterName, entityLabel: pick.entityLabel },
      path,
    });
  }
  return results;
}
