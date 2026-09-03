import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { sharePercentageOf } from '@/domain/parse-relationships';

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

/**
 * Every Path of kind `family` rooted at one Profile, each hydrated with the
 * `entity_relationship` rows its `edge_ids` cite (network spec §6, ticket 02
 * "Done when": *"a Family member … is cited to the record asserting its
 * edge, not to the read that found it"*).
 *
 * **The one join the Supplier page's own presentation needs, built once.** The
 * Supplier page's chain rows (network spec §6, §8) read this for the full
 * ordered chain. `get_supplier_network` (`src/tools/catalog/reads.ts`, network
 * spec §9) reads `loadNetworkPaths` below instead — the same join, widened
 * past `kind = 'family'` for its per-kind grouping — rather than this
 * function, so a change to one caller's shape never ripples into the other's.
 *
 * Ordered by hop depth then terminal id — the order a person reads a family
 * in, and the total order a prompt can rely on (mirrors `family_member`'s
 * former ordering, per its own now-removed comment in `reads.ts`/`supplier-page.ts`).
 */
export async function loadFamilyPaths(db: Database, rootEntityId: string): Promise<FamilyPath[]> {
  const paths = await db
    .select({
      terminalEntityId: t.graphPath.terminalEntityId,
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
    .where(and(eq(t.graphPath.rootEntityId, rootEntityId), eq(t.graphPath.kind, 'family')))
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

/** `graph_path.kind` (network spec §6, §9): what found this Path. */
export type NetworkPathKind =
  | 'family'
  | 'watchlist'
  | 'shortest_path'
  | 'deep_traversal'
  | 'supply_chain';

/** A `FamilyPath` widened with the `kind` that grouped it (network spec §9). */
export type NetworkPath = FamilyPath & { kind: NetworkPathKind };

/**
 * Every Path rooted at one Profile, of ANY kind, each hydrated with the
 * `entity_relationship` rows its `edge_ids` cite — the same join
 * `loadFamilyPaths` builds, widened past `kind = 'family'` for
 * `get_supplier_network`'s per-kind grouping (network spec §9: *"Paths grouped
 * by kind"*).
 *
 * A **separate function rather than a `kind` parameter on `loadFamilyPaths`**,
 * so a caller of one shape is never rippled by a change to the other's —
 * `loadFamilyPaths` stays exactly what `supplier-page.ts` and the family-only
 * tests already depend on. Some duplication of the query/hydration shape
 * against `loadFamilyPaths` is deliberate for the same reason: two small
 * functions that can drift independently, rather than one shared internal
 * that a future edit to either caller has to reason about for both.
 *
 * Ordered by `kind` first, then hop depth, then terminal id — a caller groups
 * by the leading key with nothing to re-sort.
 */
export async function loadNetworkPaths(db: Database, rootEntityId: string): Promise<NetworkPath[]> {
  const paths = await db
    .select({
      kind: t.graphPath.kind,
      terminalEntityId: t.graphPath.terminalEntityId,
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
    .where(eq(t.graphPath.rootEntityId, rootEntityId))
    .orderBy(asc(t.graphPath.kind), asc(t.graphPath.hopDepth), asc(t.graphPath.terminalEntityId));

  // One batched fetch for every edge every Path cites, across every kind —
  // the same de-duplication `loadFamilyPaths` does, for the same reason: a
  // shared intermediate hop should be fetched once, not once per kind.
  const allEdgeIds = [...new Set(paths.flatMap((p) => p.edgeIds))];
  const edgeRows = allEdgeIds.length
    ? await db.select().from(t.entityRelationship).where(inArray(t.entityRelationship.id, allEdgeIds))
    : [];
  const edgeById = new Map(edgeRows.map((e) => [e.id, e] as const));

  return paths.map((p) => ({
    kind: p.kind as NetworkPathKind,
    terminalEntityId: p.terminalEntityId,
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
