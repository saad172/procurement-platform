import { describe, expect, it } from 'vitest';
import { paginateTraversal } from '@/upstream/paginate';
import type { SayariTraversal } from '@/upstream/projections/sayari';

/**
 * Following a cursor, over synthetic envelopes (SPEC §8.5).
 *
 * **Nothing else in this app follows one.** Every other list read is page one:
 * the Corporate family takes `limit: 50` and records truncation, Discover takes
 * the first 100 shipments. So this loop has no sibling to be checked against,
 * and the three ways it can be wrong are all silent — it can stop early and
 * report a small family, it can loop forever against a metered API, or it can
 * page past a cap somebody set.
 *
 * Synthetic rather than recorded, deliberately. The recorded Yazaki body has
 * `next: true` on its first page, which is a real second page and is asserted
 * in the replay test; what it cannot show is a **third** page, a cursor that
 * refuses to advance, or a budget running out mid-walk. Those are shapes, and a
 * shape is cheaper to write than to find in the world.
 */

/** One page, in the projection's own snake_case shape. */
function page(args: {
  ids: string[];
  next: boolean;
  offset?: number;
  limit?: number;
}): { data: SayariTraversal } {
  return {
    data: {
      data: args.ids.map((id) => ({ target: { id, label: id.toUpperCase() }, path: [] })),
      next: args.next,
      offset: args.offset ?? 0,
      limit: args.limit ?? 2,
    } as SayariTraversal,
  };
}

/** A cap-free budget, so a test that is not about the budget is not about it. */
const unbounded = () => true;

describe('following the cursor', () => {
  it('reads a second page and stops when the API says there is no third', async () => {
    const asked: { offset: number; limit: number }[] = [];
    const held: string[] = [];

    const walk = await paginateTraversal(
      async (window) => {
        asked.push(window);
        return window.offset === 0
          ? page({ ids: ['a', 'b'], next: true, offset: 0, limit: 2 })
          : page({ ids: ['c'], next: false, offset: 2, limit: 2 });
      },
      {
        pageSize: 2,
        maxItems: 10,
        canSpend: unbounded,
        absorb: (p) => {
          for (const row of p.data.data ?? []) held.push(String((row.target as { id: string }).id));
          return held.length;
        },
      },
    );

    // The offset advances by the window the SERVER reported, not by a count of
    // rows: a page that returns fewer rows than its limit is still one window.
    expect(asked).toEqual([
      { offset: 0, limit: 2 },
      { offset: 2, limit: 2 },
    ]);
    expect(held).toEqual(['a', 'b', 'c']);
    expect(walk).toMatchObject({ pagesRead: 2, itemsHeld: 3, stoppedBy: 'exhausted' });
  });

  it('stops at the node cap without asking for a page it could not keep', async () => {
    let pagesFetched = 0;
    const walk = await paginateTraversal(
      async () => {
        pagesFetched += 1;
        return page({ ids: ['a', 'b'], next: true });
      },
      { pageSize: 2, maxItems: 2, canSpend: unbounded, absorb: () => 2 },
    );

    // The cap is checked BEFORE the next page is fetched, so a full walk costs
    // exactly the calls its cap allows and not one more.
    expect(pagesFetched).toBe(1);
    expect(walk).toMatchObject({ pagesRead: 1, itemsHeld: 2, stoppedBy: 'item_cap' });
  });

  it('never asks for more rows than the cap has room for', async () => {
    const asked: number[] = [];
    await paginateTraversal(
      async (window) => {
        asked.push(window.limit);
        return page({ ids: ['a', 'b'], next: true, offset: asked.length * 2 - 2, limit: 2 });
      },
      {
        pageSize: 50,
        maxItems: 3,
        canSpend: unbounded,
        // Two on the first page, one more would fill it.
        absorb: () => (asked.length === 1 ? 2 : 3),
      },
    );
    // "Up to 3 nodes" is then true of the REQUEST, not only of what is kept:
    // the first window is clamped to the whole cap, the second to what is left.
    expect(asked).toEqual([3, 1]);
  });

  it('stops on the caller’s call budget rather than being cut off mid-page', async () => {
    let left = 2;
    let served = 0;
    const walk = await paginateTraversal(
      async (window) => {
        served += 1;
        return page({ ids: [`row-${served}`], next: true, offset: window.offset, limit: 1 });
      },
      {
        pageSize: 1,
        maxItems: 100,
        canSpend: () => {
          if (left <= 0) return false;
          left -= 1;
          return true;
        },
        absorb: () => served,
      },
    );

    // Two pages fetched, and the third refused before it was asked for — which
    // is the whole point of budgeting here rather than letting the per-Job
    // ceiling throw part-way through a page whose members are not yet written.
    expect(walk).toMatchObject({ pagesRead: 2, stoppedBy: 'call_budget' });
  });

  it('treats a cursor that does not advance as the end of the list', async () => {
    let pagesFetched = 0;
    const walk = await paginateTraversal(
      async () => {
        pagesFetched += 1;
        // `next: true` for ever, from a server that echoes the same window
        // every time: the shape that turns a paginator into an unbounded spend
        // against a metered API. It is caught on the second page, because the
        // first is what reveals the window is not moving.
        return page({ ids: ['a'], next: true, offset: 0, limit: 2 });
      },
      { pageSize: 2, maxItems: 100, canSpend: unbounded, absorb: () => 1 },
    );
    expect(pagesFetched).toBe(2);
    expect(walk.stoppedBy).toBe('exhausted');
  });

  it('stops on an empty page even when the API still claims a next one', async () => {
    const walk = await paginateTraversal(async () => page({ ids: [], next: true }), {
      pageSize: 2,
      maxItems: 10,
      canSpend: unbounded,
      absorb: () => 0,
    });
    expect(walk).toMatchObject({ pagesRead: 1, itemsHeld: 0, stoppedBy: 'exhausted' });
  });

  it('starts from what a previous direction already held, so one cap covers both', async () => {
    let pagesFetched = 0;
    const walk = await paginateTraversal(
      async () => {
        pagesFetched += 1;
        return page({ ids: ['a'], next: true });
      },
      {
        pageSize: 50,
        maxItems: 200,
        startingItems: 200,
        canSpend: unbounded,
        absorb: () => 200,
      },
    );
    // The upward walk of a company whose downward family already filled the cap
    // costs nothing at all, rather than returning 400 members against a cap of
    // 200.
    expect(pagesFetched).toBe(0);
    expect(walk).toMatchObject({ pagesRead: 0, stoppedBy: 'item_cap' });
  });
});
