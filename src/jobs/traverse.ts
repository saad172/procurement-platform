import {
  DEEP_TRAVERSAL_MAX_HOPS,
  DEEP_TRAVERSAL_MAX_NODES,
  DEEP_TRAVERSAL_PAGE_SIZE,
  JOB_CAPS,
} from '@/config/constants';
import { paginateTraversal, type TraversalStop, type TraversalWalk } from '@/upstream';
import type { UpstreamResult } from '@/upstream';
import type { SayariTraversal, SayariTraversalPath } from '@/upstream/projections/sayari';
import { recordEnrichment, type EnrichContext } from './enrich';
import {
  ownershipHopDepth,
  summarisePath,
  terminalEntityOf,
  writeFamilyMembers,
  type FamilyMemberWrite,
} from './family-members';

/**
 * The **Deep Traversal** Job (SPEC §5.2, §8.5).
 *
 * CONTEXT defines it as *"a Job a person or the chat triggers on demand that
 * extends a Profile beyond one hop of ownership, within a hop and node cap …
 * though a Deep Traversal that reaches a subsidiary records it as a Family
 * member like any other."* Both halves of that sentence are decisions this file
 * implements: it writes into `family_member` like the automatic read, and it is
 * bounded by numbers rather than by judgement.
 *
 * ## What it does that the automatic family read does not
 *
 * Measured against the recorded Yazaki body rather than assumed. The automatic
 * read sends **no depth at all** and the server answers at its own default of
 * `max_depth: 4` — so the difference has never been *how deep*. What the
 * envelope actually says is `limit: 50`, `next: true`, `explored_count: 5047`:
 * the family read stops at the **first page of fifty**, and there is more.
 *
 * So a Deep Traversal is two things the automatic read is not:
 *
 * 1. **It follows the cursor**, to `DEEP_TRAVERSAL_MAX_NODES` distinct members
 *    rather than to the API's first page.
 * 2. **It also walks upward**, through `traversal.ubo`. The Corporate family is
 *    downward-only by measurement (SPEC §8.1), and CONTEXT says so; the owners
 *    above a Profile are exactly what an on-demand expansion is asked for.
 *
 * It is **not deeper per path**, and it must never be shallower: the walk sends
 * `max_depth` explicitly at `DEEP_TRAVERSAL_MAX_HOPS`, which tracks the server
 * default the automatic read is answered at. A cap the request does not carry
 * is not a cap, and a cap below that default would make the on-demand expansion
 * lose members a page view gets for free. So depth is the one axis on which
 * these two reads agree, and the cursor, the node cap and the upward direction
 * are the whole of the difference.
 *
 * ## Deterministic
 *
 * No model runs here, exactly as `enrich` runs none: the Trace of this Job is
 * its `usage_event` rows. CONTEXT draws the line for us — a Dossier is *"an
 * agent that chooses what to look at"*, and a Deep Traversal *"expands the
 * ownership graph and involves no agent"*.
 */

export type DeepTraversalResult = {
  rootEntityId: string;
  /** Distinct Family members this walk holds when it stopped. */
  explored: number;
  /** How many the API says exist, or null when it did not finish looking. */
  reachable: number | null;
  /** True when a cap, rather than the end of the graph, ended the walk. */
  truncated: boolean;
  deepestHop: number;
  downward: TraversalWalk;
  upward: TraversalWalk;
  /** Upstream calls this walk asked for, cache hits included. */
  pagesRead: number;
  enrichmentIds: string[];
  /**
   * Which bound ended the walk. `call_budget` is the only one that is a
   * ceiling being hit in SPEC §18.4's sense — the node cap is what a Deep
   * Traversal *is*, so reaching it is the healthy outcome and not a stop.
   */
  stoppedBy: TraversalStop;
};

type Direction = 'downward' | 'upward';
type Page = UpstreamResult<SayariTraversal>;

/** Everything the two directions share: one node cap, one call budget, one set. */
type WalkState = {
  rootEntityId: string;
  found: Map<string, FamilyMemberWrite>;
  /** Members grouped by the Enrichment of the page that found them. */
  byEnrichment: { enrichmentId: string; members: FamilyMemberWrite[] }[];
  enrichmentIds: string[];
  /** The largest `explored_count` any page reported: the *m* in "n of m". */
  exploredCount: number | null;
  /** True the moment any page says the API itself stopped short. */
  apiPartial: boolean;
  callsLeft: number;
};

export async function runDeepTraversal(
  ctx: EnrichContext,
  args: { entityId: string },
): Promise<DeepTraversalResult> {
  const state: WalkState = {
    rootEntityId: args.entityId,
    found: new Map(),
    byEnrichment: [],
    enrichmentIds: [],
    exploredCount: null,
    apiPartial: false,
    /**
     * **The walk budgets its own calls.** The chokepoint's per-Job ceiling is
     * enforced too and throws `UpstreamCapExceededError` when it is crossed,
     * which would kill this Job in the middle of a page and leave the members
     * of that page unwritten. Counting here means the walk *stops* — with its
     * members recorded and `stoppedBy: 'call_budget'` to say why. Two bounds,
     * and only one of them can lose work.
     */
    callsLeft: JOB_CAPS.traverse.toolCalls,
  };

  const downward = await walk(ctx, state, 'downward');
  const upward = await walk(ctx, state, 'upward');

  const truncated =
    state.apiPartial || downward.stoppedBy !== 'exhausted' || upward.stoppedBy !== 'exhausted';
  const coverage = {
    truncated,
    exploredCount: state.found.size,
    /**
     * **`reachable` is the API's own `explored_count`, and only when it says it
     * finished** (`partial_results: false`). That is the number SPEC §8.2
     * phrases as *"17 of 2 275 explored"*: how many nodes the traversal
     * visited, against how many of them we kept. When the API returns partial
     * results it has not searched the subgraph, so the figure bounds nothing
     * and null — *unknown* — is the only honest value.
     */
    reachableCount: state.apiPartial ? null : state.exploredCount,
  };

  for (const page of state.byEnrichment) {
    await writeFamilyMembers(ctx.db, {
      rootEntityId: args.entityId,
      enrichmentId: page.enrichmentId,
      members: page.members,
      coverage,
      discoveredByJob: ctx.jobId ?? null,
    });
  }

  return {
    rootEntityId: args.entityId,
    explored: state.found.size,
    reachable: coverage.reachableCount,
    truncated,
    deepestHop: [...state.found.values()].reduce((deepest, m) => Math.max(deepest, m.hopDepth), 0),
    downward,
    upward,
    pagesRead: downward.pagesRead + upward.pagesRead,
    enrichmentIds: state.enrichmentIds,
    stoppedBy: worstStop(downward.stoppedBy, upward.stoppedBy),
  };
}

/**
 * One direction, paged to the shared node cap.
 *
 * `startingItems` is what makes the cap *shared*: the upward walk begins
 * already holding whatever the downward walk found, so a family of 200
 * subsidiaries spends nothing looking upward rather than returning 400 members
 * against a cap of 200.
 *
 * Both requests name `minDepth` and `maxDepth` explicitly even though `1` is
 * the server's own default for the first, because explicit-at-default puts the
 * number inside `params_hash` (SPEC §16.6) — a server-side default change
 * becomes a visible difference rather than a silently different body under an
 * unchanged key.
 */
async function walk(
  ctx: EnrichContext,
  state: WalkState,
  direction: Direction,
): Promise<TraversalWalk> {
  const read = direction === 'downward' ? ctx.upstream.sayari.ownership : ctx.upstream.sayari.ubo;
  return paginateTraversal(
    (window) =>
      read({
        id: state.rootEntityId,
        limit: window.limit,
        offset: window.offset,
        minDepth: 1,
        maxDepth: DEEP_TRAVERSAL_MAX_HOPS,
      }),
    {
      pageSize: DEEP_TRAVERSAL_PAGE_SIZE,
      maxItems: DEEP_TRAVERSAL_MAX_NODES,
      startingItems: state.found.size,
      // Asked exactly once per page, before it is fetched, so it is a take.
      canSpend: () => {
        if (state.callsLeft <= 0) return false;
        state.callsLeft -= 1;
        return true;
      },
      absorb: (page) => absorbPage(ctx, state, page, direction),
    },
  );
}

/**
 * Records one page as an Enrichment and collects the members it carries.
 *
 * **An Enrichment per page, not per walk.** An Enrichment points at the raw
 * body it was projected from, so that a Citation can reach the source — and a
 * single row pointing at page one of five would leave four fifths of this
 * walk's members citing a body they do not appear in. Each member therefore
 * carries the Enrichment of the page that found it, which is also the row whose
 * `fetched_at` dates it.
 *
 * The rows themselves are written later, once, by the caller: coverage is a
 * fact about the *whole* walk and is not known until it stops, and writing a
 * page's members with the coverage as it stood mid-walk would leave the first
 * page claiming a smaller family than the last.
 */
async function absorbPage(
  ctx: EnrichContext,
  state: WalkState,
  page: Page,
  direction: Direction,
): Promise<number> {
  const envelope = page.data;
  if (typeof envelope.explored_count === 'number') {
    state.exploredCount = Math.max(state.exploredCount ?? 0, envelope.explored_count);
  }
  if (envelope.partial_results === true) state.apiPartial = true;

  const enrichmentId = await recordEnrichment(ctx, {
    source: 'sayari_deep_traversal',
    subjectKind: 'entity',
    subjectKey: state.rootEntityId,
    requestParams: {
      entityId: state.rootEntityId,
      direction,
      offset: envelope.offset ?? 0,
      limit: envelope.limit ?? DEEP_TRAVERSAL_PAGE_SIZE,
      maxDepth: DEEP_TRAVERSAL_MAX_HOPS,
      maxNodes: DEEP_TRAVERSAL_MAX_NODES,
    },
    result: page,
  });
  state.enrichmentIds.push(enrichmentId);
  state.byEnrichment.push({
    enrichmentId,
    members: mergeMembers({
      rootEntityId: state.rootEntityId,
      held: state.found,
      paths: envelope.data ?? [],
      maxNodes: DEEP_TRAVERSAL_MAX_NODES,
      maxHops: DEEP_TRAVERSAL_MAX_HOPS,
    }),
  });
  return state.found.size;
}

/**
 * Merges one page of paths into what the walk already holds, and answers with
 * the members that page **added**.
 *
 * Exported and given its bounds as arguments rather than reading the constants,
 * because this is the whole of the walk's arithmetic — merge, dedupe, hop
 * accounting and the node cap — and it is worth being able to prove over
 * synthetic envelopes with no database, no credential and no cap of 200.
 *
 * **First find wins**, which is what makes the two directions compose: a
 * company reached downward at hop 1 and again upward at hop 2 is one Family
 * member at hop 1, and re-collecting it would spend the node cap on a row that
 * already exists. `held` is mutated on purpose — a merge that returned a new
 * map would leave the caller deciding when the two directions start sharing a
 * cap, which is the one thing they must never disagree about.
 *
 * A path deeper than the hop cap is dropped rather than trusted. The request
 * carries `max_depth`, so this should never fire; it is here because
 * `ownershipHopDepth` counts differently from the server — it does not count
 * `possibly_same_as` steps — and a cap the app states in CONTEXT should be true
 * of what the app stores, not only of what it asked for.
 */
export function mergeMembers(args: {
  rootEntityId: string;
  held: Map<string, FamilyMemberWrite>;
  paths: readonly SayariTraversalPath[];
  maxNodes: number;
  maxHops: number;
}): FamilyMemberWrite[] {
  const added: FamilyMemberWrite[] = [];
  for (const path of args.paths) {
    if (args.held.size >= args.maxNodes) break;
    const entity = terminalEntityOf(path, args.rootEntityId);
    if (!entity || args.held.has(entity.id)) continue;
    const hopDepth = ownershipHopDepth(path.path);
    if (hopDepth > args.maxHops) continue;
    const member = { entity, path: summarisePath(path.path), hopDepth };
    args.held.set(entity.id, member);
    added.push(member);
  }
  return added;
}

/**
 * The stop a reader should be told about, when the two directions stopped
 * differently.
 *
 * Ordered by how much it costs the answer: a spent call budget means members
 * were not looked for at all, the node cap means the walk was full, and
 * `exhausted` means nothing was left. A walk that filled its node cap going
 * down and then found the API's own end going up did not run out of anything,
 * so the pair reports the cap.
 */
function worstStop(a: TraversalStop, b: TraversalStop): TraversalStop {
  const order: TraversalStop[] = ['exhausted', 'item_cap', 'offset_ceiling', 'call_budget'];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}
