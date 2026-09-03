import { describe, expect, it, vi } from 'vitest';
import { DISCOVER_TRADE_PAGE_CAP } from '@/config/constants';
import { fetchTradeRows, type DiscoverDeps } from '@/jobs/discover';
import type { SayariTradeRow } from '@/upstream/projections/sayari';

/**
 * `fetchTradeRows` follows the trade search's own `next`/`offset` cursor
 * (ticket 01 item C follow-up; BUILD-NOTES finding 155), in the style of
 * `paginateTraversal` (`src/upstream/paginate.ts`). No live call and no
 * recording: each page is a hand-built body shaped like the SDK's own
 * documented `SupplierSearchResponse` example
 * (`node_modules/@sayari/sdk/dist/api/resources/trade/types/
 * SupplierSearchResponse.d.ts`) — `offset`, `limit`, `size`, `next`, `data`.
 */

const row = (id: string, label: string): SayariTradeRow =>
  ({
    id,
    label,
    metadata: { shipments: 1, hs_codes: [{ key: '854430', value: 'x', doc_count: 1 }] },
  }) as never;

/** A stub `upstream.sayari.tradeSearchSuppliers`, recording every call it saw. */
function stubUpstream(pages: (params: Record<string, unknown>) => { data: unknown }) {
  const calls: Record<string, unknown>[] = [];
  const upstream = {
    sayari: {
      tradeSearchSuppliers: async (params: Record<string, unknown>) => {
        calls.push(params);
        return pages(params);
      },
    },
  } as unknown as DiscoverDeps['upstream'];
  return { upstream, calls };
}

const QUERY = { hsCodes: ['854430'], arrivalCountries: ['USA'] };

describe('fetchTradeRows follows next/offset and merges the pages', () => {
  it('a two-page search is followed and merged, offset absent on page one', async () => {
    const { upstream, calls } = stubUpstream((params) => {
      if (params.offset === undefined) {
        return {
          data: {
            data: [row('a', 'A CO'), row('b', 'B CO')],
            size: { count: 3 },
            next: true,
            offset: 0,
            limit: 2,
          },
        };
      }
      return {
        data: { data: [row('c', 'C CO')], size: { count: 3 }, next: false, offset: 2, limit: 2 },
      };
    });

    const { rows, tradeTotalCount } = await fetchTradeRows({ upstream }, QUERY);

    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(tradeTotalCount).toBe(3);
    expect(calls).toHaveLength(2);
    // Page one carries no `offset` key at all — not even `0` — so the
    // endpoint's `params_hash` for every page-one call stays what it was
    // before this ticket (SPEC §16.6).
    expect(calls[0]).not.toHaveProperty('offset');
    expect(calls[1]!.offset).toBe(2);
  });

  it('dedupes a row that turns up on more than one page, by entity id', async () => {
    const { upstream } = stubUpstream((params) => {
      if (params.offset === undefined) {
        return {
          data: { data: [row('a', 'A CO')], size: { count: 2 }, next: true, offset: 0, limit: 1 },
        };
      }
      // The same id again — a real API should not do this, but the fetch
      // does not trust it not to.
      return {
        data: { data: [row('a', 'A CO')], size: { count: 2 }, next: false, offset: 1, limit: 1 },
      };
    });

    const { rows } = await fetchTradeRows({ upstream }, QUERY);
    expect(rows.map((r) => r.id)).toEqual(['a']);
  });

  it('a single page with next: false makes exactly one call', async () => {
    const { upstream, calls } = stubUpstream(() => ({
      data: { data: [row('a', 'A CO')], size: { count: 1 }, next: false, offset: 0, limit: 100 },
    }));

    const { rows, tradeTotalCount } = await fetchTradeRows({ upstream }, QUERY);
    expect(rows.map((r) => r.id)).toEqual(['a']);
    expect(tradeTotalCount).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('the cap stops an API that never stops saying next: true', async () => {
    const tradeSearchSuppliers = vi.fn(async (params: Record<string, unknown>) => ({
      data: {
        data: [row(`row-at-offset-${String(params.offset ?? 0)}`, 'X CO')],
        size: { count: 999_999 },
        next: true,
        offset: (params.offset as number | undefined) ?? 0,
        limit: 1,
      },
    }));
    const upstream = { sayari: { tradeSearchSuppliers } } as unknown as DiscoverDeps['upstream'];

    const { rows } = await fetchTradeRows({ upstream }, QUERY);

    expect(tradeSearchSuppliers).toHaveBeenCalledTimes(DISCOVER_TRADE_PAGE_CAP);
    expect(rows).toHaveLength(DISCOVER_TRADE_PAGE_CAP);
  });

  it('treats a cursor that does not advance as the end of the list, caught on the second page', async () => {
    // `next: true` forever, from a server that echoes the same window every
    // time — the shape that turns a paginator into an unbounded spend against
    // a metered, 3.6-13.4 s call. Caught on the SECOND page, because the
    // first is what reveals the window is not moving (the same guard
    // `paginateTraversal`'s own test pins down the same way).
    const tradeSearchSuppliers = vi.fn(async () => ({
      data: { data: [row('stuck', 'STUCK CO')], size: { count: 50 }, next: true, offset: 0, limit: 2 },
    }));
    const upstream = { sayari: { tradeSearchSuppliers } } as unknown as DiscoverDeps['upstream'];

    const { rows } = await fetchTradeRows({ upstream }, QUERY);

    expect(tradeSearchSuppliers).toHaveBeenCalledTimes(2);
    // The one row was deduped across the identical pages, not counted twice.
    expect(rows.map((r) => r.id)).toEqual(['stuck']);
  });

  it('reads tradeTotalCount off the first page only, even if a later page disagrees', async () => {
    const { upstream } = stubUpstream((params) => {
      if (params.offset === undefined) {
        return {
          data: { data: [row('a', 'A')], size: { count: 100 }, next: true, offset: 0, limit: 1 },
        };
      }
      // A different count on page two — should never overwrite the first.
      return {
        data: { data: [row('b', 'B')], size: { count: 5 }, next: false, offset: 1, limit: 1 },
      };
    });

    const { tradeTotalCount } = await fetchTradeRows({ upstream }, QUERY);
    expect(tradeTotalCount).toBe(100);
  });

  /**
   * C3: `size.qualifier` is `eq` (exact) or `gte` (a floor) — read alongside
   * the count so a `gte` total is never rendered as an exact one.
   */
  it('reads size.qualifier off the first page alongside the count', async () => {
    const { upstream } = stubUpstream(() => ({
      data: {
        data: [row('a', 'A')],
        size: { count: 10_000, qualifier: 'gte' },
        next: false,
        offset: 0,
        limit: 100,
      },
    }));

    const { tradeTotalCount, tradeTotalQualifier } = await fetchTradeRows({ upstream }, QUERY);
    expect(tradeTotalCount).toBe(10_000);
    expect(tradeTotalQualifier).toBe('gte');
  });
});
