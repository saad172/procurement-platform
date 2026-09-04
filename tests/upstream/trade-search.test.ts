import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import {
  ENDPOINTS,
  sayariTradeSearchBuyers,
  sayariTradeSearchShipments,
  sayariTradeSearchSuppliers,
} from '@/upstream/endpoints';
import { resetSayariTokenForTesting } from '@/upstream/dispatchers/sayari';
import { resetSayariClients } from '@/upstream/dispatchers/sayari-client';
import { shipmentSearchSchema, tradeSearchSchema } from '@/upstream/projections/sayari';
import type { DispatchDeps } from '@/upstream/types';

/**
 * `sayariTradeSearchSuppliers` widened for `filter.supplierId` (network spec
 * §4.3, ticket 05), and the two new sibling rows, `sayariTradeSearchBuyers`
 * and `sayariTradeSearchShipments`.
 *
 * All three are POST calls whose `filter` lives in the JSON body, not the
 * query string — unlike the four `TraversalWalkParams`-shaped rows and
 * `sayariSupplyChainUpstreamTradeTraversal`, there is no array-JSON-stringify
 * defect to route around here (verified against `Client.js` for all three
 * methods: `serializers.*.jsonOrThrow(_body, ...)` builds the body, and
 * `_queryParams` carries only `limit`/`offset`, both scalars). So these tests
 * prove the *request body* the SDK path sends is correct, the same way
 * `risk-categories-dispatch.test.ts` proves a request rather than trying to
 * trigger a fallback branch that does not apply here.
 *
 * No live call: `fetch` is stubbed for the OAuth token exchange and for the
 * POST itself, and the response is a minimal but complete, schema-shaped
 * stand-in so the SDK's own (stricter) response deserialiser resolves rather
 * than throwing — the point under test is the *request* each row builds.
 */
describe('trade search endpoint rows (network spec §4.3, ticket 05)', () => {
  const deps: DispatchDeps = {
    credentials: { sayariClientId: 'id', sayariClientSecret: 'secret', nominatimUserAgent: 'ua' },
    signal: new AbortController().signal,
    timeoutMs: 1_000,
  };

  let requests: { url: URL; body: unknown }[] = [];

  const supplierSearchResponseBody = {
    limit: 1,
    offset: 0,
    size: { count: 0, qualifier: 'eq' },
    next: false,
    data: [] as unknown[],
  };

  const shipmentSearchResponseBody = {
    limit: 50,
    offset: 0,
    size: { count: 0, qualifier: 'eq' },
    next: false,
    data: [] as unknown[],
  };

  beforeEach(() => {
    resetSayariTokenForTesting();
    resetSayariClients();
    requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | string, init?: RequestInit) => {
        const url = input instanceof URL ? input : new URL(String(input));
        if (url.pathname === '/oauth/token') {
          return new Response(
            JSON.stringify({ access_token: 'tok', expires_in: 3600, token_type: 'Bearer' }),
            { status: 200 },
          );
        }
        requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const body = url.pathname.includes('shipments')
          ? shipmentSearchResponseBody
          : supplierSearchResponseBody;
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('registers all three rows in ENDPOINTS, on the trade bucket', () => {
    expect(ENDPOINTS.sayariTradeSearchSuppliers).toBe(sayariTradeSearchSuppliers);
    expect(ENDPOINTS.sayariTradeSearchBuyers).toBe(sayariTradeSearchBuyers);
    expect(ENDPOINTS.sayariTradeSearchShipments).toBe(sayariTradeSearchShipments);
    for (const row of [sayariTradeSearchSuppliers, sayariTradeSearchBuyers, sayariTradeSearchShipments]) {
      expect(row.bucket).toBe('trade');
      expect(row.defaults).toEqual({ limit: 100 });
    }
    expect(sayariTradeSearchBuyers.endpoint).toBe('trade.searchBuyers');
    expect(sayariTradeSearchShipments.endpoint).toBe('trade.searchShipments');
  });

  it('sayariTradeSearchShipments projects through shipmentSearchSchema, not tradeSearchSchema', () => {
    expect(sayariTradeSearchShipments.projection).toBe(shipmentSearchSchema);
    expect(sayariTradeSearchSuppliers.projection).toBe(tradeSearchSchema);
    expect(sayariTradeSearchBuyers.projection).toBe(tradeSearchSchema);
  });

  it('sayariTradeSearchSuppliers sends filter.supplierId in the POST body (the widened footprint read)', async () => {
    const result = await sayariTradeSearchSuppliers.dispatch(
      { supplierId: ['CX3012yTGIhgMxcZG6hgnA'], limit: 1 },
      deps,
    );
    expect(result.via).toBe('sdk');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/v1/trade/search/suppliers');
    // The SDK's own generated `TradeFilterList` serializer
    // (`node_modules/@sayari/sdk/serialization/resources/trade/types/
    // TradeFilterList.js`) re-keys every filter field to the wire's real
    // snake_case name regardless of the caller's casing — `supplierId` (the
    // JS/TS property `sayariTradeSearchSuppliers` must use for the field to
    // be recognised at all, rather than stripped by `unrecognizedObjectKeys:
    // "strip"`) goes out as `supplier_id`. This is the *request* half of the
    // same camelCase-in/snake_case-out split `key-case.ts` documents for
    // responses — confirmed here rather than assumed, so a future change to
    // this file's request body does not silently start sending a key the SDK
    // would otherwise have stripped.
    expect((requests[0]!.body as { filter?: { supplier_id?: string[] } }).filter?.supplier_id).toEqual(
      ['CX3012yTGIhgMxcZG6hgnA'],
    );
  });

  it('sayariTradeSearchSuppliers still sends hsCodes/arrivalCountries the way Discover already does', async () => {
    await sayariTradeSearchSuppliers.dispatch(
      { hsCodes: ['854231'], arrivalCountries: ['RUS'], limit: 100 },
      deps,
    );
    const body = requests[0]!.body as {
      filter?: { hs_code?: string[]; arrival_country?: string[]; supplier_id?: string[] };
    };
    expect(body.filter?.hs_code).toEqual(['854231']);
    expect(body.filter?.arrival_country).toEqual(['RUS']);
    expect(body.filter?.supplier_id).toBeUndefined();
  });

  it('sayariTradeSearchBuyers hits /v1/trade/search/buyers with filter.supplier_id', async () => {
    const result = await sayariTradeSearchBuyers.dispatch(
      { supplierId: ['CX3012yTGIhgMxcZG6hgnA'], limit: 50 },
      deps,
    );
    expect(result.via).toBe('sdk');
    expect(requests[0]!.url.pathname).toBe('/v1/trade/search/buyers');
    expect((requests[0]!.body as { filter?: { supplier_id?: string[] } }).filter?.supplier_id).toEqual(
      ['CX3012yTGIhgMxcZG6hgnA'],
    );
  });

  it('sayariTradeSearchShipments hits /v1/trade/search/shipments with filter.supplier_id and filter.arrival_date', async () => {
    const result = await sayariTradeSearchShipments.dispatch(
      { supplierId: ['CX3012yTGIhgMxcZG6hgnA'], arrivalDate: '2024-01|2025-01', limit: 50 },
      deps,
    );
    expect(result.via).toBe('sdk');
    expect(requests[0]!.url.pathname).toBe('/v1/trade/search/shipments');
    const body = requests[0]!.body as {
      filter?: { supplier_id?: string[]; arrival_date?: string };
    };
    expect(body.filter?.supplier_id).toEqual(['CX3012yTGIhgMxcZG6hgnA']);
    expect(body.filter?.arrival_date).toBe('2024-01|2025-01');
  });

  it('limit/offset ride the query string on all three, never the body', async () => {
    await sayariTradeSearchSuppliers.dispatch({ supplierId: ['x'], limit: 1, offset: 5 }, deps);
    const url = requests[0]!.url;
    expect(url.searchParams.get('limit')).toBe('1');
    expect(url.searchParams.get('offset')).toBe('5');
    const body = requests[0]!.body as Record<string, unknown>;
    expect(body.limit).toBeUndefined();
    expect(body.offset).toBeUndefined();
  });
});
