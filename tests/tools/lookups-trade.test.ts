import { describe, expect, it, vi } from 'vitest';
import { getRegistry } from '@/tools';
import type { ToolContext } from '@/tools';

/**
 * The three trade/supply-chain lookup tools (network spec §4.3, §9; ticket
 * 05, unit 05c): `sayari_search_shipments`, `sayari_search_buyers`,
 * `sayari_upstream`. Job- and mcp-only, matching `sayari_ownership`/
 * `sayari_watchlist`/`sayari_shortest_path`'s own restricted `surfaces` —
 * confirmed against this ticket's own "job and mcp surfaces" wording, not
 * chat.
 *
 * Offline throughout: `ctx.upstream.sayari.*` is a hand-built stub on every
 * test here, never the real `createUpstream()` — these three sugar methods
 * (`tradeSearchBuyers`, `tradeSearchShipments`, `upstreamTradeTraversal`) do
 * not exist on `src/upstream/index.ts` on this branch's base yet (unit 05b's
 * file, not merged as of this writing), so a live wrapper would not type nor
 * run. What is under test is the CALL SHAPE each tool's handler makes and
 * the `sourceResult` passthrough of what comes back — not that a real
 * endpoint answered, which is 05a's/05b's own coverage.
 */

function stubCtx(sayariMethod: string, impl: (params: unknown) => unknown): ToolContext {
  return {
    db: {} as never,
    upstream: { sayari: { [sayariMethod]: vi.fn(impl) } } as never,
    meter: { addModelTokens: () => {} },
    runId: 'unused',
    surface: 'job',
  };
}

describe('sayari_search_buyers', () => {
  it('is job/mcp-only, reads, spends sayari, is slow, and carries no confirm', () => {
    const tool = getRegistry().byName.get('sayari_search_buyers');
    expect(tool).toBeTruthy();
    expect(tool!.surfaces).toEqual(['job', 'mcp']);
    expect(tool!.effect).toBe('read');
    expect(tool!.spends).toEqual(['sayari']);
    expect(tool!.latency).toBe('slow');
    expect(tool!.confirm).toBeUndefined();
  });

  it('requires supplierId; limit is optional and bounded 1–100', () => {
    const tool = getRegistry().byName.get('sayari_search_buyers')!;
    expect(tool.input.safeParse({}).success).toBe(false);
    expect(tool.input.safeParse({ supplierId: 'ent-1' }).success).toBe(true);
    expect(tool.input.safeParse({ supplierId: 'ent-1', limit: 50 }).success).toBe(true);
    expect(tool.input.safeParse({ supplierId: 'ent-1', limit: 0 }).success).toBe(false);
    expect(tool.input.safeParse({ supplierId: 'ent-1', limit: 101 }).success).toBe(false);
  });

  it('wraps tradeSearchBuyers with filter.supplierId as a one-element array, defaulting limit to 50', async () => {
    const tool = getRegistry().byName.get('sayari_search_buyers')!;
    const rows = [{ id: 'buyer-1', label: 'Buyer One' }];
    const call = vi.fn(async () => ({
      data: { data: rows },
      cacheHit: true,
      fetchedAt: new Date(),
    }));
    const ctx = stubCtx('tradeSearchBuyers', call as never);

    const result = await tool.handler({ supplierId: 'ent-1' }, ctx);

    expect(call).toHaveBeenCalledWith({ supplierId: ['ent-1'], limit: 50 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { data: unknown; widget: { type: string; payload: unknown } };
    expect(data.widget.type).toBe('source_result');
    expect(
      (data.widget.payload as { source: string; cacheHit: boolean; payload: unknown }).source,
    ).toBe('Sayari trade buyers');
    expect((data.widget.payload as { cacheHit: boolean }).cacheHit).toBe(true);
    expect(data.data).toEqual(rows);
  });

  it('passes an explicit limit through unchanged, and falls back to an empty array when data is absent', async () => {
    const tool = getRegistry().byName.get('sayari_search_buyers')!;
    const call = vi.fn(async () => ({ data: {}, cacheHit: false, fetchedAt: new Date() }));
    const ctx = stubCtx('tradeSearchBuyers', call as never);

    const result = await tool.handler({ supplierId: 'ent-2', limit: 10 }, ctx);

    expect(call).toHaveBeenCalledWith({ supplierId: ['ent-2'], limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { data: unknown };
    expect(data.data).toEqual([]);
  });
});

describe('sayari_search_shipments', () => {
  it('is job/mcp-only, reads, spends sayari, is slow, and carries no confirm', () => {
    const tool = getRegistry().byName.get('sayari_search_shipments');
    expect(tool).toBeTruthy();
    expect(tool!.surfaces).toEqual(['job', 'mcp']);
    expect(tool!.effect).toBe('read');
    expect(tool!.spends).toEqual(['sayari']);
    expect(tool!.latency).toBe('slow');
    expect(tool!.confirm).toBeUndefined();
  });

  it('requires supplierId; arrivalDate and limit are optional', () => {
    const tool = getRegistry().byName.get('sayari_search_shipments')!;
    expect(tool.input.safeParse({}).success).toBe(false);
    expect(tool.input.safeParse({ supplierId: 'ent-1' }).success).toBe(true);
    expect(
      tool.input.safeParse({ supplierId: 'ent-1', arrivalDate: '2024-09|2026-09', limit: 50 })
        .success,
    ).toBe(true);
  });

  it('wraps tradeSearchShipments with filter.supplierId, omitting arrivalDate when not given', async () => {
    const tool = getRegistry().byName.get('sayari_search_shipments')!;
    const rows = [{ id: 'shipment-1' }];
    const call = vi.fn(async () => ({
      data: { data: rows },
      cacheHit: false,
      fetchedAt: new Date(),
    }));
    const ctx = stubCtx('tradeSearchShipments', call as never);

    const result = await tool.handler({ supplierId: 'ent-1' }, ctx);

    expect(call).toHaveBeenCalledWith({ supplierId: ['ent-1'], limit: 50 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { data: unknown; widget: { payload: { source: string } } };
    expect(data.widget.payload.source).toBe('Sayari trade shipments');
    expect(data.data).toEqual(rows);
  });

  it('forwards arrivalDate verbatim — the wire’s own "<from>|<to>" range string, unparsed', async () => {
    const tool = getRegistry().byName.get('sayari_search_shipments')!;
    const call = vi.fn(async () => ({
      data: { data: [] },
      cacheHit: false,
      fetchedAt: new Date(),
    }));
    const ctx = stubCtx('tradeSearchShipments', call as never);

    await tool.handler({ supplierId: 'ent-1', arrivalDate: '2024-09|2026-09', limit: 25 }, ctx);

    expect(call).toHaveBeenCalledWith({
      supplierId: ['ent-1'],
      arrivalDate: '2024-09|2026-09',
      limit: 25,
    });
  });
});

describe('sayari_upstream', () => {
  it('is job/mcp-only, reads, spends sayari, is slow, and carries no confirm', () => {
    const tool = getRegistry().byName.get('sayari_upstream');
    expect(tool).toBeTruthy();
    expect(tool!.surfaces).toEqual(['job', 'mcp']);
    expect(tool!.effect).toBe('read');
    expect(tool!.spends).toEqual(['sayari']);
    expect(tool!.latency).toBe('slow');
    expect(tool!.confirm).toBeUndefined();
  });

  it('requires entityId; every filter is optional', () => {
    const tool = getRegistry().byName.get('sayari_upstream')!;
    expect(tool.input.safeParse({}).success).toBe(false);
    expect(tool.input.safeParse({ entityId: 'ent-1' }).success).toBe(true);
    expect(
      tool.input.safeParse({
        entityId: 'ent-1',
        component: ['854430'],
        risk: ['forced_labor_origin', 'sanctions'],
        countries: ['CN'],
        maxDepth: 2,
        minDate: '2024-09-03',
      }).success,
    ).toBe(true);
    expect(tool.input.safeParse({ entityId: 'ent-1', maxDepth: 0 }).success).toBe(false);
  });

  it('wraps upstreamTradeTraversal with `id`, omitting every unset filter', async () => {
    const tool = getRegistry().byName.get('sayari_upstream')!;
    const payload = { paths: [] };
    const call = vi.fn(async () => ({ data: payload, cacheHit: true, fetchedAt: new Date() }));
    const ctx = stubCtx('upstreamTradeTraversal', call as never);

    const result = await tool.handler({ entityId: 'ent-1' }, ctx);

    expect(call).toHaveBeenCalledWith({ id: 'ent-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as {
      data: unknown;
      widget: { payload: { source: string; cacheHit: boolean } };
    };
    expect(data.widget.payload.source).toBe('Sayari upstream supply chain');
    expect(data.widget.payload.cacheHit).toBe(true);
    expect(data.data).toEqual(payload);
  });

  it('forwards every populated filter — component, risk, countries, maxDepth, minDate — by name', async () => {
    const tool = getRegistry().byName.get('sayari_upstream')!;
    const call = vi.fn(async () => ({ data: {}, cacheHit: false, fetchedAt: new Date() }));
    const ctx = stubCtx('upstreamTradeTraversal', call as never);

    await tool.handler(
      {
        entityId: 'ent-1',
        component: ['854430'],
        risk: ['forced_labor_origin', 'sanctions'],
        countries: ['CN'],
        maxDepth: 2,
        minDate: '2024-09-03',
      },
      ctx,
    );

    expect(call).toHaveBeenCalledWith({
      id: 'ent-1',
      component: ['854430'],
      risk: ['forced_labor_origin', 'sanctions'],
      countries: ['CN'],
      maxDepth: 2,
      minDate: '2024-09-03',
    });
  });
});
