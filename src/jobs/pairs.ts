import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import type { EnrichContext } from './enrich';
import { findAndWriteShortestPath } from './shortest-path';

/**
 * The **`pairs`** Job — *Check every pair* (network spec §7; ticket 04, unit
 * 04e).
 *
 * The Category page derives Concentration between accepted Suppliers **for
 * free** from Paths the automatic enrich Job already stored (`family`/
 * `watchlist` — `findConcentrations`, `src/db/queries/family-paths.ts`). That
 * derivation only ever sees a shared terminal two Networks happened to reach
 * on their own; two Suppliers under one parent that neither Network's
 * automatic read explored far enough to notice are invisible to it. This Job
 * is the case that derivation cannot see: it runs `findAndWriteShortestPath`
 * — the same shared helper the recommend Job's own narrower, three-call-per-
 * Recommendation check uses (§4.2) — for **every** unordered pair of accepted
 * Suppliers bidding one Category, on demand, confirm-gated, at an estimate of
 * `n(n-1)/2` (`enqueue_check_every_pair`, `src/tools/catalog/enqueues.ts`).
 *
 * **Deterministic, like `traverse`.** No model runs here, so this Job's Trace
 * is its `usage_event` rows and its `trace_fidelity` stays `replayable` — see
 * `NO_TURN_JOB_KINDS`, `src/fixtures/record.ts`.
 *
 * **Nothing here dedupes against Paths the recommend Job already found.**
 * `findAndWriteShortestPath` is idempotent — cached on `params_hash`, upserts
 * on `(root, terminal, kind)` (that function's own doc comment) — so a pair
 * this Job repeats is a free cache hit, not a wasted credit.
 */

/** One accepted Supplier bidding a Category, with the Profile it settled on. */
export type AcceptedBidder = { supplierId: string; entityId: string };

/**
 * Every **accepted** Supplier bidding one Category, entity id in hand.
 *
 * Read-only, and deliberately not a call into `src/db/queries/shortlist.ts`
 * (04d's file, not touched by this unit): that module answers a wider
 * question — a whole Shortlist row, scored and decorated — and this Job needs
 * only the two columns `findAndWriteShortestPath` takes an id from. A
 * Supplier with no settled Match, or an accepted Match with no entity id
 * (the schema does not forbid it, even though nothing today writes that
 * combination), has no Profile to run a shortestPath against and is dropped
 * here rather than downstream.
 *
 * **Exported** so `enqueue_check_every_pair`'s own estimator
 * (`src/tools/catalog/enqueues.ts`) can quote its `n(n-1)/2` from the exact
 * same *n* this Job will actually run over, rather than a second query that
 * could drift from this one.
 */
export async function loadAcceptedBidders(db: Database, categoryId: string): Promise<AcceptedBidder[]> {
  const bidders = await db
    .select({ supplierId: t.supplierCategory.supplierId })
    .from(t.supplierCategory)
    .where(eq(t.supplierCategory.categoryId, categoryId));
  if (bidders.length === 0) return [];

  const rows = await db
    .select({ supplierId: t.match.supplierId, entityId: t.match.entityId })
    .from(t.match)
    .where(
      and(
        inArray(
          t.match.supplierId,
          bidders.map((b) => b.supplierId),
        ),
        eq(t.match.status, 'accepted'),
      ),
    );

  return rows.filter(
    (row): row is { supplierId: string; entityId: string } => row.entityId != null,
  );
}

/**
 * Every unordered pair over a list, skipping a pair whose two sides carry the
 * same key.
 *
 * Two different Suppliers can settle on the same Profile (`match`'s own doc
 * comment: no unique constraint on `entity_id`, "a brand-name row and a
 * legal-entity row colliding is correct"). A pair drawn from two such rows
 * would ask `traversal.shortestPath` for an entity against itself, which is
 * not a Concentration question — there is no second Network to be joined to
 * — so it is dropped here rather than sent upstream.
 */
function unorderedPairs<T>(items: readonly T[], keyOf: (item: T) => string): [T, T][] {
  const pairs: [T, T][] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (keyOf(items[i]!) === keyOf(items[j]!)) continue;
      pairs.push([items[i]!, items[j]!]);
    }
  }
  return pairs;
}

export type PairsCheckResult = {
  categoryId: string;
  /** Accepted Suppliers bidding this Category — the *n* the estimate quoted. */
  suppliersConsidered: number;
  /** Pairs actually sent to `findAndWriteShortestPath` (same-Profile pairs excluded). */
  pairsChecked: number;
  /** Pairs `findAndWriteShortestPath` found — and wrote — a Path for. */
  pathsFound: number;
  /** Pairs skipped because both sides had settled on the same Profile. */
  skippedSamePair: number;
};

/**
 * Runs the sweep: every accepted-Supplier pair on one Category, through the
 * shared shortest-path helper.
 *
 * **No call budget kept here**, unlike `runDeepTraversal`'s own `callsLeft`.
 * That walk pages, so a cap mid-page would otherwise lose a page's members
 * that were already fetched but not yet written; here every pair is one
 * self-contained read-then-write through `findAndWriteShortestPath`; nothing
 * is lost. Exceeding `JOB_CAPS.pairs.toolCalls` throws
 * `UpstreamCapExceededError` out of the pair currently running, exactly as it
 * does for any other Job's upstream call — `runOneJob`'s catch (`src/worker/
 * poll.ts`) turns that into `terminated`, re-runnable, and every pair already
 * checked stays written because each one already committed before the next
 * began.
 */
export async function runPairsCheck(
  ctx: EnrichContext,
  args: { categoryId: string },
): Promise<PairsCheckResult> {
  const accepted = await loadAcceptedBidders(ctx.db, args.categoryId);
  const pairs = unorderedPairs(accepted, (bidder) => bidder.entityId);
  const totalUnordered = (accepted.length * (accepted.length - 1)) / 2;

  let pathsFound = 0;
  for (const [a, b] of pairs) {
    const found = await findAndWriteShortestPath(ctx, {
      rootEntityId: a.entityId,
      targetEntityId: b.entityId,
      discoveredByJob: ctx.jobId ?? null,
    });
    if (found) pathsFound += 1;
  }

  return {
    categoryId: args.categoryId,
    suppliersConsidered: accepted.length,
    pairsChecked: pairs.length,
    pathsFound,
    skippedSamePair: totalUnordered - pairs.length,
  };
}
