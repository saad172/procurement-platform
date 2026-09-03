import { sql } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import type { EntitySource, FamilyMemberRisk } from '@/domain/family';
import type { ParsedEdge } from '@/domain/parse-relationships';
import { isPossiblySameAs } from '@/domain/relationships';
import { parseRiskObject } from '@/domain/scoring/risk-factors';
import type { SayariEntity, SayariTraversalPath } from '@/upstream/projections/sayari';
import { upsertEntity } from './resolve';

/**
 * Writing `graph_path` rows, for every read that produces a Path (network spec
 * §6, ticket 02).
 *
 * **One writer, every kind.** The automatic Corporate family and watchlist
 * reads, the person-triggered Deep Traversal, the recommend Job's shortest-path
 * check and the trade Job's upstream tiers all find Paths through different
 * endpoints, at different depths, in different directions — and then have
 * exactly the same thing to say about each one: upsert the terminal entity, and
 * record the pair *(root, terminal, kind)* with the route that reached it.
 * `graph_path`'s unique key is on all three, so a family Path and a shortest
 * path between the same two entities are not duplicates of each other — they
 * are two different facts that happen to share two endpoints.
 *
 * What stays with each caller is what genuinely differs: which endpoint to
 * call, how to page it, how to read coverage off its envelope, and which `kind`
 * and `direction` its own Paths carry. What lives here is the row, and the one
 * hop-depth rule (`ownershipHopDepth`) every caller now shares.
 */

export type GraphPathKind = (typeof t.graphPathKind.enumValues)[number];
export type GraphPathDirection = (typeof t.graphPathDirection.enumValues)[number];

/** One member, ready to write: the entity as it arrived, its depth, and its edges. */
export type GraphPathWrite = {
  entity: SayariEntity;
  /** Ownership hops from the root, `possibly_same_as` steps excluded. */
  hopDepth: number;
  /**
   * Ordered `entity_relationship.id`s, one per resolvable hop — see
   * `summarisePath`. Empty when no hop of this Path could be resolved to a
   * citable edge (the payload named a hop with no readable entity or type).
   */
  edgeIds: readonly string[];
};

/**
 * Upserts every terminal entity and its Path, and returns them in the shape
 * the Family exposure badge reads.
 *
 * `discoveredByJob` is the caller's answer to *which read found this*: null
 * for an automatic read, the Job id for a Deep Traversal. It is deliberately
 * **not** in the conflict `set` below — the row's provenance is who found it
 * FIRST, not who found it most recently.
 *
 * `kind`/`direction` are the caller's answer to *what shape of Path is this*
 * (network spec §6). **Design note, not a bug to fix further:** a downward
 * Deep Traversal find is `kind: 'family'` — Corporate family is defined as the
 * downward subset of the Network, with no mention of which read reached a
 * member — and only an upward Deep Traversal find is `kind: 'deep_traversal'`.
 * That split is the caller's decision (`traverse.ts`), not this function's; it
 * only needs `kind`/`direction` to be told, once, per batch of members.
 *
 * `filtered` is **sticky-true on conflict** (the schema's own comment on
 * `graph_path.filtered`, network spec §4.1): a Path a filtered, risk-focused
 * page has ever confirmed stays `filtered: true` even when a later unfiltered
 * read touches the same row. `filtered = filtered OR excluded.filtered` in
 * `conflictSet` below is what makes that true without a second row — the
 * unique key is (root, terminal, kind), not (root, terminal, kind, filtered).
 *
 * `source` names the endpoint this batch of members arrived from, for the risk
 * union `upsertEntity` merges on every write (SPEC §8.2 D5). Every caller now
 * names it explicitly — `enrichFamily`/`enrichWatchlist` (`src/jobs/enrich.ts`)
 * always with the endpoint they called, and `traverse.ts`'s Deep Traversal with
 * `'ownership'` for its downward walk and `'ubo'` for its upward one — so the
 * default below is a fallback only, never load-bearing.
 */
export async function writeGraphPaths(
  db: Database,
  args: {
    rootEntityId: string;
    enrichmentId: string;
    kind: GraphPathKind;
    direction: GraphPathDirection;
    members: readonly GraphPathWrite[];
    /** Read off the read's own envelope, never inferred from path count (network spec §6). */
    coverage: { truncated: boolean; exploredCount: number | null; partialResults: boolean };
    discoveredByJob: string | null;
    filtered?: boolean | undefined;
    source?: EntitySource | undefined;
  },
): Promise<FamilyMemberRisk[]> {
  const written: FamilyMemberRisk[] = [];
  const source: EntitySource = args.source ?? 'ownership';
  const filtered = args.filtered ?? false;

  for (const member of args.members) {
    // The merged, persisted `risk` — the union of this sighting and whatever
    // this id already held, with per-factor provenance — rather than the
    // fresh incoming payload alone. One terminal entity can be BOTH a
    // Supplier's Profile (fetched by `getEntity` elsewhere) and a Path
    // terminal (fetched by this traversal), and the badge should see
    // everything either read has ever found.
    const { risk: storedRisk } = await upsertEntity(db, member.entity, undefined, source);
    await db
      .insert(t.graphPath)
      .values({
        enrichmentId: args.enrichmentId,
        rootEntityId: args.rootEntityId,
        terminalEntityId: member.entity.id,
        kind: args.kind,
        direction: args.direction,
        hopDepth: member.hopDepth,
        edgeIds: [...member.edgeIds],
        discoveredByJob: args.discoveredByJob,
        truncated: args.coverage.truncated,
        exploredCount: args.coverage.exploredCount,
        partialResults: args.coverage.partialResults,
        filtered,
      })
      .onConflictDoUpdate({
        target: [t.graphPath.rootEntityId, t.graphPath.terminalEntityId, t.graphPath.kind],
        set: conflictSet(args),
      });

    written.push({
      entityId: member.entity.id,
      label: member.entity.label,
      country: member.entity.countries?.[0] ?? null,
      factors: parseRiskObject(storedRisk ?? member.entity.risk),
      hopDepth: member.hopDepth,
      fromDeepTraversal: args.discoveredByJob != null,
    });
  }

  return written;
}

/**
 * What a second read of the same (root, terminal, kind) updates, and what it
 * leaves standing.
 *
 * **`firstSeenAt`, `discoveredByJob` and `enrichmentId` are absent on
 * purpose.** They are the row's provenance — *when this Path first appeared,
 * and which read found it* — and a later read is not new provenance for a
 * fact it did not discover. The *new evidence* chip is computed from
 * `firstSeenAt` (SPEC §12.1), so re-stamping it would light the chip on every
 * re-read; and a Deep Traversal that re-reaches a member the automatic family
 * already held must not claim to have found it.
 *
 * `enrichmentId` belongs in that same group, not with the coverage columns
 * below, even though it once lived in this function's `set` clause: it is
 * what a citation resolves through (`withFamilyCoverage`, `src/jobs/
 * publish.ts`), and reassigning it to whichever read most recently confirmed
 * a terminal silently moves that citation's target out from under it.
 * Measured live in this build's ticket 02+03 recording session — Yazaki's
 * family carried 58 members, but `enrichFamily`'s own Enrichment could only
 * be cited through 44 of them, because `enrichOwnership`'s filtered page
 * (run second, in the same fan-out) had re-touched the other 14 and, under
 * the old unconditional overwrite, quietly relabelled them as its own. A
 * `graph_path` row's `enrichment_id` names *the read that first found the
 * Path* (`src/db/queries/family-paths.ts`'s own doc comment) — past tense,
 * not "most recently confirmed."
 *
 * **`hopDepth` and `edgeIds` move together, and only downwards.** A row
 * records the *shortest* route known to that terminal: an entity reachable in
 * one hop is reachable in one hop whichever read noticed, and a Deep Traversal
 * arriving at it through a longer path has learned nothing that makes it
 * further away. `edgeIds` is the evidence for the depth, so overwriting one
 * without the other would leave a row whose chain and whose number disagree.
 *
 * **`filtered` only ever moves to `true`.** `filtered OR excluded.filtered`
 * is what makes a Path confirmed by a filtered page stay confirmed, whichever
 * order the two pages of one read arrive in.
 *
 * The remaining coverage columns (`truncated`, `exploredCount`,
 * `partialResults`) *are* overwritten unconditionally, because they describe
 * the read rather than the terminal, and the newest read is the one the page
 * should be quoting.
 */
function conflictSet(args: {
  coverage: { truncated: boolean; exploredCount: number | null; partialResults: boolean };
}) {
  return {
    hopDepth: sql`least(${t.graphPath.hopDepth}, excluded.hop_depth)`,
    edgeIds: sql`case when excluded.hop_depth <= ${t.graphPath.hopDepth}
                   then excluded.edge_ids else ${t.graphPath.edgeIds} end`,
    truncated: args.coverage.truncated,
    exploredCount: args.coverage.exploredCount,
    partialResults: args.coverage.partialResults,
    filtered: sql`${t.graphPath.filtered} OR excluded.filtered`,
  };
}

/** One occurrence inside a traversal path hop's own relationships group. */
type PathHopValue = {
  record?: string | null;
  from_date?: string | null;
  to_date?: string | null;
  former?: boolean | null;
  attributes?: unknown;
};

/** One hop of a traversal path, reduced to what a citable edge needs. */
export type PathHop = {
  field: string | null;
  entityId: string | null;
  /**
   * The edge this hop names, ready for `storeRelationships` — null when the
   * hop's own entity or relationship type could not be read from the payload.
   * Once a hop is unresolvable every hop after it is too: the chain's subject
   * is the previous hop's own entity, and there is nothing to chain from.
   */
  edge: ParsedEdge | null;
  /** Ownership hops through and including this one, `possibly_same_as` excluded. */
  hopDepth: number;
};

/**
 * Reduces a traversal path to its citable edges, one per hop, in order —
 * `edge_ids: ordered entity_relationship.ids — a Path is a list of citable
 * edges` (network spec §6).
 *
 * Each hop becomes a `ParsedEdge` ready for `storeRelationships`: subject
 * chained from the previous hop's own entity (the root, for the first hop),
 * target the hop's own entity, type the hop's `field`, record/shares/dates
 * from the **first** occurrence of that hop's own relationship group — the
 * primary citation for that hop, not every sighting of it (a hop can carry a
 * dozen; `storeRelationships` still stores whichever one is asked for, and a
 * caller that wants every occurrence stored calls it directly, the way
 * `readOwnerEdges` does for owner edges).
 *
 * `hopDepth` is carried per hop too, via the one hop-depth rule
 * (`ownershipHopDepth`): the same figure a caller would get computing it over
 * `path.slice(0, i + 1)` itself, so `entity_relationship.hop_depth` and
 * `graph_path.hop_depth` never disagree about what "N hops" means.
 *
 * The entities themselves are upserted by `storeRelationships`/
 * `writeGraphPaths`, not stored here — storing them again in this function's
 * own return value would duplicate megabytes per Supplier, measured at
 * **886 KB across 17 rows**, one path alone at 605 KB, because a Sayari
 * traversal payload carries a complete entity at every hop. Returning them
 * wholesale from a read tool is what fired the assess Job's 450,000-token
 * ceiling (BUILD-NOTES finding 23).
 */
export function summarisePath(path: unknown, rootEntityId: string): PathHop[] {
  const hops = (Array.isArray(path) ? path : []) as NonNullable<SayariTraversalPath['path']>;
  const out: PathHop[] = [];
  let subjectId = rootEntityId;
  let broken = false;

  hops.forEach((raw, index) => {
    const step = (raw ?? {}) as { field?: unknown; entity?: unknown; relationships?: unknown };
    const field = typeof step.field === 'string' ? step.field : null;
    const entityRaw = step.entity;
    const targetObject =
      entityRaw && typeof entityRaw === 'object' && 'id' in entityRaw
        ? (entityRaw as SayariEntity)
        : null;
    const entityId = targetObject
      ? String(targetObject.id)
      : typeof entityRaw === 'string'
        ? entityRaw
        : null;
    const hopDepth = ownershipHopDepth(hops.slice(0, index + 1));

    if (broken || !field || !entityId) {
      broken = true;
      out.push({ field, entityId, edge: null, hopDepth });
      return;
    }

    const bag = step.relationships;
    const group =
      bag && typeof bag === 'object' && !Array.isArray(bag)
        ? (bag as Record<string, { values?: readonly PathHopValue[] | null } | null>)[field]
        : undefined;
    const value = group?.values?.[0];

    out.push({
      field,
      entityId,
      hopDepth,
      edge: {
        subjectId,
        targetId: entityId,
        targetLabel: targetObject?.label ?? null,
        targetType: targetObject?.type ?? null,
        relationshipType: field,
        former: value?.former === true,
        startDate: value?.from_date ?? null,
        endDate: value?.to_date ?? null,
        sourceRecordId: value?.record ?? null,
        attributes:
          value?.attributes && typeof value.attributes === 'object'
            ? (value.attributes as Record<string, unknown>)
            : null,
        targetEntity: targetObject as unknown as Record<string, unknown> | null,
      },
    });
    subjectId = entityId;
  });

  return out;
}

/**
 * A path's depth in **ownership** hops, which is not its length.
 *
 * SPEC §8.1 measured the family as *psa-routed*: every path runs through one or
 * two `possibly_same_as` hops to other records of the same company, because
 * Sayari splits a company across records and the ownership hangs off the
 * others. A `possibly_same_as` step is therefore a move sideways between two
 * records of one company — not a step down the ownership chain — and counting
 * it would report a direct subsidiary reached through two psa hops as three
 * hops away. In the recorded Yazaki family, `possibly_same_as` appears as a
 * path `field` three times, so this is a real difference and not a hypothetical
 * one.
 *
 * **One rule for every kind and every caller** — the automatic reads
 * (`enrich.ts`) and Deep Traversal (`traverse.ts`) both route through this
 * function now, rather than one of them counting raw path length. The psa
 * check itself is `isPossiblySameAs` (`src/domain/relationships.ts`), shared
 * with `viaOwnership` (`src/db/queries/family-paths.ts`) so the two callers
 * that both need "is this hop sideways, not down" can never drift apart on
 * what a psa hop is.
 *
 * Floored at 1, because a member is never zero hops from the root: the root is
 * not its own family member, and a path we cannot read at all is at least one
 * step away.
 */
export function ownershipHopDepth(path: SayariTraversalPath['path']): number {
  if (!Array.isArray(path)) return 1;
  const owned = path.filter((hop) => !isPossiblySameAs(hop?.field ?? '')).length;
  return Math.max(1, owned);
}

/**
 * The terminal a path ends at, or nothing where the payload does not carry one.
 *
 * The `target` arrives **complete, with its `risk` block inline** — the
 * measurement that made the family cost one call rather than 25 (SPEC §8.1).
 * Falling back to the last path element covers the shape where `target` is an
 * id rather than an entity; a root that appears as its own target is dropped,
 * since an entity is not a member of its own family.
 */
export function terminalEntityOf(
  path: SayariTraversalPath,
  rootEntityId: string,
): SayariEntity | undefined {
  const terminal = path.target ?? path.path?.[path.path.length - 1]?.entity;
  if (!terminal || typeof terminal !== 'object' || !('id' in terminal)) return undefined;
  const entity = terminal as SayariEntity;
  return entity.id === rootEntityId ? undefined : entity;
}
