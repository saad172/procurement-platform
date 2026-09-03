import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { sharePercentageOf } from '@/domain/parse-relationships';
import { isOwnership, isPossiblySameAs } from '@/domain/relationships';

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
 * A third sibling, `loadNetworkPaths` further down (`get_supplier_network`'s
 * per-kind grouping, network spec §9), deliberately does NOT call this — see
 * that function's own comment for why duplicating the query there was the
 * right call rather than widening this one.
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
   * `'family'` — downward, `traversal.ownership` narrows to five ownership
   * relationship types **plus whatever `possibly_same_as` hops Sayari routes
   * the walk through to reach them** (record-linking, not a sixth
   * relationship type the endpoint returns on purpose). So a `family` row is
   * NOT "ownership-only, `viaOwnership` always true once hydrated" the way
   * this comment used to claim — `viaOwnership` still has real work to do on
   * a `family` row, skipping the psa hops and checking what's left, exactly
   * as it does for `watchlist` (see `viaOwnership`'s own comment below; a
   * live Yazaki family Path shaped
   * `has_subsidiary → possibly_same_as → possibly_same_as → shareholder_of`
   * is what disproved the old claim). Includes the filtered, risk-focused
   * second page of the same kind once it exists (`graph_path.filtered`,
   * network spec §4.1) — not written yet (a later unit's job), so today every
   * `family` row here is unfiltered, and a root with none at all is simply an
   * empty array, never an error.
   *
   * `'watchlist'` — either direction, terminates at a Listed entity. The
   * endpoint's own default 31 relationship types span ownership, control and
   * trade, so `viaOwnership` genuinely varies per Path here.
   */
  kind: PathKind;
  /**
   * True when every **non-`possibly_same_as`** hop of this Path's own edge
   * chain is a **current** ownership/control edge —
   * `isOwnership(e.relationshipType) && !e.former` for every such hop — AND
   * at least one non-psa hop exists.
   *
   * `possibly_same_as` is Sayari's own record-linking between two records of
   * the *same* company (`isPossiblySameAs`, `src/domain/relationships.ts`),
   * not an ownership or trade assertion about two different ones, and Sayari
   * splitting a larger company across records makes routing through one or
   * two psa hops the ORDINARY way to reach a real subsidiary or owner, not a
   * rare exception (`src/upstream/endpoints.ts`'s doc comment on
   * `sayariTraversalOwnership` measured every path in one family running
   * through one or two of them). Requiring every hop, psa included, to
   * individually pass `isOwnership` — the bug this comment used to describe
   * as the design — meant a completely current, real ownership chain lost its
   * `viaOwnership` the moment Sayari happened to split a record along the
   * way, which per that measurement is the common case, not the rare one.
   * `ownershipHopDepth` (`src/jobs/family-members.ts`) already skips psa hops
   * for the same reason when counting hop depth; this is the same rule
   * applied to the ownership-or-not judgment, via the same shared predicate.
   *
   * A psa hop is therefore transparent here: skipped, never required to be
   * `isOwnership`, and never itself enough to break the chain. What DOES
   * break it is unchanged — a `former` hop or a genuinely lateral/trade hop
   * among the non-psa ones, exactly like before
   * (`entity_relationship.former`'s own schema comment — "only current edges
   * are scored").
   *
   * A Path that is entirely psa hops (zero non-psa edges) is `false`, not
   * vacuously `true`: record-linking between records of the SAME company
   * asserts nothing about ownership of any OTHER company, so there is no
   * ownership claim in that chain to honor. This is the same "zero
   * qualifying edges is not evidence of ownership" reasoning the old comment
   * already applied to a Path with zero hydrated edges at all (the
   * migration-0013 gap) — both get the same safe treatment as a trade hop:
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

  const paths: NetworkExposurePath[] = rows.map((row) => {
    // `possibly_same_as` hops are record-linking, not ownership steps —
    // skipped here for the same reason `ownershipHopDepth`
    // (`src/jobs/family-members.ts`) skips them when counting hop depth. See
    // `viaOwnership`'s own doc comment above for the full reasoning.
    const nonPsaEdges = row.edges.filter((e) => !isPossiblySameAs(e.relationshipType));
    return {
      ...row,
      viaOwnership:
        nonPsaEdges.length > 0 && nonPsaEdges.every((e) => isOwnership(e.relationshipType) && !e.former),
    };
  });

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
