import type { SayariTraversal } from './projections/sayari';

/**
 * Following a traversal cursor (SPEC §8.5, §16.2).
 *
 * **Nothing else in this app follows a cursor.** Every other list read is page
 * one and says so: the Corporate family takes `limit: 50` and records
 * truncation, Discover takes the first 100 shipments, resolution takes a ranked
 * window. That is the right shape for a read whose whole point is a bounded
 * cost — but a Deep Traversal is defined by its *node* cap rather than by its
 * page size (CONTEXT: *within a hop and node cap*), and the API's page is 50.
 * So the one place a cursor is followed is here, written once, so a second
 * caller never has to re-derive what `next` means.
 *
 * **What `next` is, measured:** a boolean, not a cursor string (BUILD-NOTES
 * finding 6). The client advances `offset` itself. The union below still
 * accepts a string, because a lenient projection that refused one would turn an
 * API addition into a failed Job rather than into a page we stopped at.
 *
 * **Why the page is fetched through a callback rather than by calling `call()`
 * here.** The chokepoint's argument list is an endpoint definition, a params
 * object and an `UpstreamContext`, and a paginator that assembled those would
 * be a second place that decides what a Sayari request looks like. It takes a
 * function that returns a page instead — so the caller keeps the endpoint and
 * this keeps the cursor, and a test can hand it two synthetic pages with no
 * database and no credentials.
 */

/** The API's documented ceiling: `offset` is capped at 1000 (`Ownership.offset`). */
const OFFSET_CEILING = 1000;

/**
 * Why a walk stopped, kept as a closed set because each one is a different
 * sentence to a reader and only one of them is a ceiling being hit.
 *
 * - `exhausted` — the API said there was no next page. The only complete walk.
 * - `item_cap` — the node cap. **Not a failure**: a Deep Traversal is *defined*
 *   as a capped walk, so reaching the cap is the healthy outcome and the walk
 *   records truncation rather than terminating.
 * - `call_budget` — the Job's own upstream-call ceiling. This one *is* a number
 *   somebody set, in the sense SPEC §18.4 means it.
 * - `offset_ceiling` — the API refuses an `offset` past 1000, so a node cap
 *   raised past 1 000 nodes would start being answered by the server rather
 *   than by us. Unreachable at today's 200, and named so that it cannot become
 *   a silent `400` if the cap moves.
 */
export type TraversalStop = 'exhausted' | 'item_cap' | 'call_budget' | 'offset_ceiling';

export type TraversalWalk = {
  pagesRead: number;
  /** Distinct items the caller holds when the walk stopped, as it counted them. */
  itemsHeld: number;
  stoppedBy: TraversalStop;
};

export type PaginateBounds<TPage> = {
  /** The API's maximum page, and what a page costs: one upstream call. */
  pageSize: number;
  /** The node cap, counted in **distinct** items — which only `absorb` knows. */
  maxItems: number;
  /** Items the caller already holds, so two directions share one node cap. */
  startingItems?: number;
  /**
   * Asked **before** each page, so a walk stops cleanly on its own budget
   * rather than being terminated mid-page by the chokepoint's ceiling. Both
   * bounds exist and they are not the same bound: this one is the walk saying
   * *I have spent enough*, and `UpstreamCapExceededError` is the Job's ceiling
   * saying *you did not stop*.
   */
  canSpend: () => boolean;
  /**
   * Takes one page and answers **how many distinct items are now held**.
   *
   * Deduplication lives with the caller because the node cap counts distinct
   * members across *both* directions of a walk, and a paginator that counted
   * rows would happily read four pages of the same company.
   */
  absorb: (page: TPage) => number | Promise<number>;
};

/**
 * Reads pages until the API runs out, the node cap fills, or the caller's call
 * budget is spent — whichever comes first — and says which it was.
 *
 * The order of the three guards is the order of their cost: the node cap and
 * the call budget are checked *before* a page is fetched, so neither is
 * discovered by spending the call that broke it.
 */
export async function paginateTraversal<TPage extends { data: SayariTraversal }>(
  fetchPage: (window: { offset: number; limit: number }) => Promise<TPage>,
  bounds: PaginateBounds<TPage>,
): Promise<TraversalWalk> {
  let offset = 0;
  let pagesRead = 0;
  let itemsHeld = bounds.startingItems ?? 0;

  const stop = (stoppedBy: TraversalStop): TraversalWalk => ({ pagesRead, itemsHeld, stoppedBy });

  for (;;) {
    if (itemsHeld >= bounds.maxItems) return stop('item_cap');
    if (offset > OFFSET_CEILING) return stop('offset_ceiling');
    if (!bounds.canSpend()) return stop('call_budget');

    // Never ask for more than the cap allows: it makes "up to N nodes" true of
    // the request, not only of what we keep afterwards.
    const limit = Math.min(bounds.pageSize, bounds.maxItems - itemsHeld);
    const page = await fetchPage({ offset, limit });
    pagesRead += 1;
    itemsHeld = await bounds.absorb(page);

    const envelope = page.data;
    const rows = envelope.data?.length ?? 0;
    if (rows === 0 || !hasNextPage(envelope)) return stop('exhausted');

    const next = nextOffset(envelope, offset, limit);
    // A cursor that does not advance is a loop, and a loop against a metered
    // API is the expensive kind. Treated as the end of the list, because that
    // is what a server which will not move the window is telling us.
    if (next <= offset) return stop('exhausted');
    offset = next;
  }
}

/**
 * `next` is a boolean on the live API. A string is accepted and read as *there
 * is more*, since the only thing this walk does with it is decide whether to
 * ask for another window by offset.
 */
function hasNextPage(envelope: SayariTraversal): boolean {
  const next = envelope.next;
  return typeof next === 'string' ? next.length > 0 : next === true;
}

/**
 * The server's own echoed `offset` and `limit` are preferred over the ones we
 * sent, because they are what it actually paged by — the request is a request
 * and the envelope is the answer.
 */
function nextOffset(envelope: SayariTraversal, offset: number, limit: number): number {
  const from = typeof envelope.offset === 'number' ? envelope.offset : offset;
  const step = typeof envelope.limit === 'number' && envelope.limit > 0 ? envelope.limit : limit;
  return from + step;
}
