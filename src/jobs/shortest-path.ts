import { recordEnrichment, storeHopEdges, type EnrichContext } from './enrich';
import {
  ownershipHopDepth,
  summarisePath,
  terminalEntityOf,
  writeGraphPaths,
} from './family-members';

/**
 * The shared shortest-path check (network spec §4.2, §7; ticket 04).
 *
 * **One function, two callers.** The recommend Job runs this at submission —
 * the award against each other Pick, at most three calls per Recommendation
 * (§4.2) — and the *Check every pair* `pairs` Job runs it for every accepted
 * pair on a Category, on demand (§7). Both are asking the exact same
 * question — *are these two entities joined by a Path at all* — through the
 * exact same endpoint, so the call, the Enrichment and the `graph_path` write
 * live here once rather than twice.
 *
 * ## What it does
 *
 * 1. Calls `traversal.shortestPath({ entities: [rootEntityId, targetEntityId] })`.
 * 2. **No Path, no further cost** (spec §4.2). `data` holds 0 or 1 entries
 *    (`SayariShortestPath`, `src/upstream/projections/sayari.ts`); when it is
 *    empty this writes nothing at all — not even an Enrichment — and returns
 *    `undefined`. A caller reads `undefined` as *no Concentration between
 *    this pair*.
 * 3. When a Path is found, records the call as an Enrichment under
 *    `sayari_shortest_path` (see that value's own doc comment on
 *    `enrichmentSource`, `src/db/schema/enums.ts`, for why it is not shared
 *    with any automatic source), then writes exactly one `graph_path` row of
 *    `kind: 'shortest_path'`, reusing `terminalEntityOf`/`summarisePath`/
 *    `writeGraphPaths` unchanged from `src/jobs/family-members.ts` — the one
 *    writer every Path-producing read shares.
 *
 * ## `direction: 'either'`
 *
 * A shortest path between two arbitrary Picks is not one of ownership's two
 * fixed directions: it can run *up* from one Pick to a shared parent and back
 * *down* to the other, so no single `down`/`up` value describes it. This is
 * the same reasoning the watchlist read's own Paths already carry `either`
 * for (`enrichWatchlist`, `src/jobs/enrich.ts`) — a Path that does not commit
 * to one direction gets the value that says so — and it is why `shortest_path`
 * is one of the two `graph_path_kind`s the schema's own
 * `graph_path_kind_direction_invariant` CHECK leaves unconstrained (alongside
 * `deep_traversal`), rather than pinning it to `down`/`up`/`upstream` the way
 * `family`/`supply_chain` are pinned.
 *
 * ## Coverage is hardcoded, not read off the envelope
 *
 * `traversal.shortestPath`'s envelope carries no `explored_count`/
 * `partial_results`/`next` — verified against the SDK's own
 * `ShortestPathResponse` type and recorded on `shortestPathSchemaInner`'s own
 * doc comment (`src/upstream/projections/sayari.ts`): a targeted two-entity
 * query has no "subgraph explored" concept to report. `{ truncated: false,
 * exploredCount: null, partialResults: false }` is therefore not a stand-in
 * for a real reading — it is the only honest value an envelope with no
 * coverage fields can produce, and every caller of this function gets the
 * same one rather than each inventing its own placeholder.
 *
 * ## Idempotent and free to repeat
 *
 * A second call with the same `(rootEntityId, targetEntityId)` pair costs
 * nothing extra: `call()`'s cache lookup (`src/upstream/call.ts`) keys on
 * `(source, endpoint, params_hash)` with no TTL, and this endpoint's own
 * `normalizeParams` does not reorder `entities` — order is meaningful here,
 * `entities[0]` is the source and `entities[1]` the target (`endpoints.ts`'s
 * own doc comment on `sayariTraversalShortestPath`) — so an identical repeat
 * call is a cache hit, and `writeGraphPaths`'s upsert on
 * `(root, terminal, kind)` makes the write side idempotent too. Neither
 * caller needs to build its own de-duplication in front of this function.
 */
export async function findAndWriteShortestPath(
  ctx: EnrichContext,
  args: { rootEntityId: string; targetEntityId: string; discoveredByJob: string | null },
): Promise<{ terminalEntityId: string } | undefined> {
  const result = await ctx.upstream.sayari.shortestPath({
    entities: [args.rootEntityId, args.targetEntityId],
  });

  const path = result.data.data?.[0];
  if (!path) return undefined;

  const enrichmentId = await recordEnrichment(ctx, {
    source: 'sayari_shortest_path',
    subjectKind: 'entity',
    subjectKey: args.rootEntityId,
    requestParams: { entities: [args.rootEntityId, args.targetEntityId] },
    result,
  });

  // A path with no readable terminal (the payload named a hop with no
  // resolvable entity, or the terminal is the root itself) writes an
  // Enrichment — the call was still made and is still citable — but no
  // `graph_path` row, the same "nothing to write" outcome
  // `enrichFamily`/`enrichWatchlist` give a member `terminalEntityOf` cannot
  // resolve.
  const entity = terminalEntityOf(path, args.rootEntityId);
  if (!entity) return undefined;

  const hops = summarisePath(path.path, args.rootEntityId);
  const edgeIds = await storeHopEdges(ctx, hops, { source: 'shortestPath' });

  await writeGraphPaths(ctx.db, {
    rootEntityId: args.rootEntityId,
    enrichmentId,
    kind: 'shortest_path',
    direction: 'either',
    members: [{ entity, hopDepth: ownershipHopDepth(path.path), edgeIds }],
    coverage: { truncated: false, exploredCount: null, partialResults: false },
    discoveredByJob: args.discoveredByJob,
    source: 'shortestPath',
  });

  return { terminalEntityId: entity.id };
}
