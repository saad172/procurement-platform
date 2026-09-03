import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { sharePercentageOf } from '@/domain/parse-relationships';
import { isOwnership } from '@/domain/relationships';

/**
 * One hop of a Path, hydrated from `entity_relationship` (network spec §6).
 *
 * `graph_path.edge_ids` is an **ordered list of `entity_relationship.id`s** —
 * a Path is a list of citable edges, not a list of entities — and
 * `sourceRecordId` is what a citation to this hop resolves through
 * (`citation.recordId`, `src/jobs/publish.ts`), never `graph_path.enrichment_id`
 * (which names the *read* that found the Path, not the record that asserts
 * any one edge in it).
 */
export type FamilyPathEdge = {
  id: string;
  relationshipType: string;
  fromEntityId: string;
  toEntityId: string;
  former: boolean;
  sharePercentage: number | null;
  startDate: string | null;
  endDate: string | null;
  sourceRecordId: string | null;
};

/** One Path of kind `family`, rooted at a Supplier's Profile, hydrated with its chain of edges. */
export type FamilyPath = {
  terminalEntityId: string;
  label: string;
  country: string | null;
  sanctioned: boolean;
  risk: unknown;
  hopDepth: number;
  truncated: boolean;
  /**
   * The read's own envelope figure (`graph_path.explored_count`) — how many
   * nodes THAT walk visited, sometimes in the thousands. Not a row count:
   * `family_member.explored_count`, the app's own capped-at-50 tally of
   * distinct members held, has no successor column on `graph_path` — see
   * `derive-supplier-page.ts`'s `widestCoverage` for what replaces it.
   */
  reachableCount: number | null;
  /** The read (registry row) that found this Path — cite it for the coverage figures, never for the edge itself. */
  enrichmentId: string;
  /** Null when the automatic family read found it; a Job id for a Deep Traversal. */
  discoveredByJob: string | null;
  /**
   * Root → terminal, in `edge_ids` order — never re-sorted, because this IS
   * the chain a person or an Assessment reads. Empty for a Path whose
   * `edge_ids` have not been backfilled yet (migration 0013's documented
   * legacy-migration gap: a migrated row carries a real `hop_depth` with no
   * edges rather than a guessed one).
   */
  edges: FamilyPathEdge[];
};

/** A `graph_path.kind` value, narrowed to the two this file reads. */
type PathKind = 'family' | 'watchlist';

/**
 * The join every Path reader needs — one Path row plus the `entity_relationship`
 * chain its `edge_ids` cite — filtered to whichever `kind`(s) the caller asks
 * for. `loadFamilyPaths` and `loadNetworkExposurePaths` below are both thin
 * callers of this, **the one join built once** (this function's own former
 * doc comment, kept on `loadFamilyPaths`): building it twice would be two
 * chances for the edge-resolution logic to drift apart.
 *
 * Ordered by hop depth then terminal id — the order a person reads a family
 * in, and the total order a prompt can rely on (mirrors `family_member`'s
 * former ordering, per its own now-removed comment in `reads.ts`/`supplier-page.ts`).
 */
async function loadPathRows(
  db: Database,
  rootEntityId: string,
  kinds: readonly PathKind[],
): Promise<(FamilyPath & { kind: PathKind })[]> {
  const paths = await db
    .select({
      terminalEntityId: t.graphPath.terminalEntityId,
      kind: t.graphPath.kind,
      hopDepth: t.graphPath.hopDepth,
      truncated: t.graphPath.truncated,
      reachableCount: t.graphPath.exploredCount,
      enrichmentId: t.graphPath.enrichmentId,
      discoveredByJob: t.graphPath.discoveredByJob,
      edgeIds: t.graphPath.edgeIds,
      label: t.entity.label,
      country: t.entity.country,
      sanctioned: t.entity.sanctioned,
      risk: t.entity.risk,
    })
    .from(t.graphPath)
    .innerJoin(t.entity, eq(t.entity.id, t.graphPath.terminalEntityId))
    .where(
      and(eq(t.graphPath.rootEntityId, rootEntityId), inArray(t.graphPath.kind, [...kinds])),
    )
    .orderBy(asc(t.graphPath.hopDepth), asc(t.graphPath.terminalEntityId));

  // One batched fetch for every edge every Path cites, rather than one query
  // per Path — the family is capped at fifty members, but a member can share
  // an ancestor edge with another, and de-duplicating the id set is what
  // keeps a shared intermediate hop from being fetched twice.
  const allEdgeIds = [...new Set(paths.flatMap((p) => p.edgeIds))];
  const edgeRows = allEdgeIds.length
    ? await db.select().from(t.entityRelationship).where(inArray(t.entityRelationship.id, allEdgeIds))
    : [];
  const edgeById = new Map(edgeRows.map((e) => [e.id, e] as const));

  return paths.map((p) => ({
    terminalEntityId: p.terminalEntityId,
    kind: p.kind as PathKind,
    label: p.label,
    country: p.country,
    sanctioned: p.sanctioned,
    risk: p.risk,
    hopDepth: p.hopDepth,
    truncated: p.truncated,
    reachableCount: p.reachableCount,
    enrichmentId: p.enrichmentId,
    discoveredByJob: p.discoveredByJob,
    edges: p.edgeIds
      .map((id) => edgeById.get(id))
      .filter((e): e is NonNullable<typeof e> => e != null)
      .map((e) => ({
        id: e.id,
        relationshipType: e.relationshipType,
        fromEntityId: e.fromEntityId,
        toEntityId: e.toEntityId,
        former: e.former,
        sharePercentage: sharePercentageOf(e.attributes),
        startDate: e.startDate,
        endDate: e.endDate,
        sourceRecordId: e.sourceRecordId,
      })),
  }));
}

/**
 * Every Path of kind `family` rooted at one Profile, each hydrated with the
 * `entity_relationship` rows its `edge_ids` cite (network spec §6, ticket 02
 * "Done when": *"a Family member … is cited to the record asserting its
 * edge, not to the read that found it"*).
 *
 * **Unchanged signature, on purpose** (network spec §5 unit 03b): this is
 * read by `get_supplier_family` (`src/tools/catalog/reads.ts`) for its
 * per-member citation and envelope, and by the Supplier page's chain rows
 * (network spec §6, §8) for the full ordered chain — two callers this ticket
 * does not own, and a signature change is a risk to both for no gain either
 * needs. `loadNetworkExposurePaths` below is a **sibling**, not a widened
 * version of this: it shares the join (`loadPathRows`) rather than this
 * function's own call surface.
 */
export async function loadFamilyPaths(db: Database, rootEntityId: string): Promise<FamilyPath[]> {
  return loadPathRows(db, rootEntityId, ['family']);
}

/** One Path feeding Network exposure — `FamilyPath`'s shape, plus which read found it and whether it qualifies as ownership/control (network spec §5). */
export type NetworkExposurePath = FamilyPath & {
  /**
   * `'family'` — downward, ownership-only by construction: `traversal.ownership`
   * narrows to five ownership relationship types, so `viaOwnership` is always
   * `true` for one of these once its edges are hydrated. Includes the
   * filtered, risk-focused second page of the same kind once it exists
   * (`graph_path.filtered`, network spec §4.1) — not written yet (a later
   * unit's job), so today every `family` row here is unfiltered, and a root
   * with none at all is simply an empty array, never an error.
   *
   * `'watchlist'` — either direction, terminates at a Listed entity. The
   * endpoint's own default 31 relationship types span ownership, control and
   * trade, so `viaOwnership` genuinely varies per Path here.
   */
  kind: PathKind;
  /**
   * True when every hop of this Path's own edge chain is a **current**
   * ownership/control edge — `isOwnership(e.relationshipType) && !e.former`
   * for every hop — by `isOwnership` (`src/domain/relationships.ts`), **the
   * same classification the rest of this codebase already uses, not a second
   * one**. A `former` hop breaks the chain exactly like a trade hop does: the
   * entity is no longer CURRENTLY reached by ownership through that route
   * (`entity_relationship.former`'s own schema comment — "only current edges
   * are scored"). `false` for a Path with zero hydrated edges too (the
   * migration-0013 gap): an unresolved chain proves nothing about what kind
   * of chain it was, so it gets the same safe treatment as a trade hop —
   * shown, never deducted.
   */
  viaOwnership: boolean;
};

/** One kind's coverage — the read's own envelope, read off the WIDEST row it wrote (mirrors `derive-supplier-page.ts`'s `widestCoverage`, for the same reason: a kind can hold rows from more than one read, e.g. the automatic family read and a downward Deep Traversal). */
export type NetworkPathCoverage = { exploredCount: number | null; truncated: boolean };

/**
 * Every Path of kind `family` **or** `watchlist` rooted at one Profile —
 * Network exposure's multi-hop input (network spec §5): the downward
 * Corporate family plus the either-direction walk to Listed entities, each
 * hop hydrated with its `relationshipType` so a caller can classify
 * ownership/control against trade itself, rather than this function guessing
 * on the caller's behalf what "ownership or control" means for its purpose.
 *
 * A **sibling** to `loadFamilyPaths`, not a widened version of it (see that
 * function's own comment) — built over the same `loadPathRows` join so the
 * two can never resolve an edge differently.
 *
 * Coverage is returned **per kind**, because the family read and the
 * watchlist read are two different calls with two different envelopes
 * (network spec §4.1) — collapsing them into one figure would report, say, a
 * watchlist walk that hit its own cap as if the family read had too.
 */
export async function loadNetworkExposurePaths(
  db: Database,
  rootEntityId: string,
): Promise<{
  paths: NetworkExposurePath[];
  coverage: { family: NetworkPathCoverage; watchlist: NetworkPathCoverage };
}> {
  const rows = await loadPathRows(db, rootEntityId, ['family', 'watchlist']);

  const paths: NetworkExposurePath[] = rows.map((row) => ({
    ...row,
    viaOwnership:
      row.edges.length > 0 && row.edges.every((e) => isOwnership(e.relationshipType) && !e.former),
  }));

  const coverageFor = (kind: PathKind): NetworkPathCoverage => {
    const ofKind = rows.filter((r) => r.kind === kind);
    const widest = ofKind.reduce<(typeof ofKind)[number] | undefined>(
      (best, r) =>
        best == null || (r.reachableCount ?? 0) > (best.reachableCount ?? 0) ? r : best,
      undefined,
    );
    return { exploredCount: widest?.reachableCount ?? null, truncated: widest?.truncated ?? false };
  };

  return { paths, coverage: { family: coverageFor('family'), watchlist: coverageFor('watchlist') } };
}

/**
 * The record asserting one Path's own inclusion of its terminal entity —
 * the **last** hop in `edge_ids` order, the edge most proximate to the
 * member itself (ticket 02 "Done when").
 *
 * Null for a Path with no hydrated edges: a migrated `family_member` row
 * (migration 0013) or a Path whose write raced ahead of the edge upsert. Both
 * are documented gaps, not wrong answers — a member with no citable edge yet
 * cites nothing rather than the read that found it.
 */
export function terminalEdgeOf(path: Pick<FamilyPath, 'edges'>): FamilyPathEdge | null {
  return path.edges.length ? path.edges[path.edges.length - 1]! : null;
}
