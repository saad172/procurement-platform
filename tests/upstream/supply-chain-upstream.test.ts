import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ENDPOINTS,
  sayariSupplyChainUpstreamTradeTraversal,
  upstreamTradeTraversalQuery,
} from '@/upstream/endpoints';
import { rawFetch, resetSayariTokenForTesting } from '@/upstream/dispatchers/sayari';
import { resetSayariClients } from '@/upstream/dispatchers/sayari-client';
import { upstreamTradeTraversalSchema } from '@/upstream/projections/sayari';
import type { DispatchDeps } from '@/upstream/types';

/**
 * `sayariSupplyChainUpstreamTradeTraversal` (network spec §4.3, §5, §6;
 * ticket 05).
 *
 * The live bug, verified against `node_modules/@sayari/sdk/api/resources/
 * supplyChain/client/Client.js`: a populated `component`/`risk`/`countries`
 * array is JSON-stringified into one query value (`toJson(...)`) — the
 * identical defect class `risk-categories-dispatch.test.ts` proves for
 * `traversal.ownership`/`ubo`/`watchlist`/`traversal`'s `riskCategories`,
 * on a different endpoint. `component` and `risk` are always populated for
 * this ticket's own call (network spec §4.3), so this row must dispatch raw
 * **unconditionally** whenever either is populated — proven here the same
 * way `risk-categories-dispatch.test.ts` proves its own claim: by
 * intercepting `fetch` and reading the URL the raw path actually built,
 * never by trying to trigger `viaSdkWithRawFallback`'s `ParseError` catch
 * (which would not fire here — a `422` is a clean response, not a parse
 * failure).
 *
 * No live call: `fetch` is stubbed for the OAuth token exchange and for the
 * request itself.
 */
describe('sayariSupplyChainUpstreamTradeTraversal', () => {
  const deps: DispatchDeps = {
    credentials: {
      sayariClientId: 'supply-chain-test',
      sayariClientSecret: 'secret',
      nominatimUserAgent: 'ua',
    },
    signal: new AbortController().signal,
    timeoutMs: 1_000,
  };

  let requestedUrls: URL[] = [];

  beforeEach(() => {
    resetSayariTokenForTesting();
    resetSayariClients();
    requestedUrls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | string) => {
        const url = input instanceof URL ? input : new URL(String(input));
        if (url.pathname === '/oauth/token') {
          return new Response(
            JSON.stringify({ access_token: 'tok', expires_in: 3600, token_type: 'Bearer' }),
            { status: 200 },
          );
        }
        requestedUrls.push(url);
        // Wire-level (snake_case) shape — the SDK's own response
        // deserialiser wants `explored_count`/`partial_results` on the wire
        // and converts them to `exploredCount`/`partialResults` for the JS
        // caller; this stub plays the server, not the SDK.
        return new Response(
          JSON.stringify({
            filters: {},
            data: { paths: [], entities: {} },
            explored_count: 0,
            partial_results: false,
          }),
          { status: 200 },
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is registered in ENDPOINTS, on the tradeTraversal bucket', () => {
    expect(ENDPOINTS.sayariSupplyChainUpstreamTradeTraversal).toBe(
      sayariSupplyChainUpstreamTradeTraversal,
    );
    expect(sayariSupplyChainUpstreamTradeTraversal.endpoint).toBe(
      'supplyChain.upstreamTradeTraversal',
    );
    expect(sayariSupplyChainUpstreamTradeTraversal.bucket).toBe('tradeTraversal');
    expect(sayariSupplyChainUpstreamTradeTraversal.defaults).toEqual({});
  });

  it('sends component/risk repeated, never JSON-stringified, and skips the SDK entirely', async () => {
    const component = ['870899', '854231'];
    const risk = ['forced_labor_xinjiang_origin_subtier', 'sanctions_ofac_sdn'];

    const result = await sayariSupplyChainUpstreamTradeTraversal.dispatch(
      { id: 'DZjFMEwRYOXYl0_wBTO8ew', component, risk, maxDepth: 2, minDate: '2024-09-03' },
      deps,
    );

    // Exactly one non-token request — never called-then-discarded: the SDK's
    // own `client.supplyChain.upstreamTradeTraversal` is never invoked when
    // component/risk is populated, so there is nothing for it to have spent a
    // second, malformed request on.
    expect(requestedUrls).toHaveLength(1);
    expect(result.via).toBe('raw');

    const url = requestedUrls[0]!;
    expect(url.pathname).toBe('/v1/supply_chain/upstream/DZjFMEwRYOXYl0_wBTO8ew');
    expect(url.searchParams.getAll('component')).toEqual(component);
    expect(url.searchParams.getAll('risk')).toEqual(risk);
    expect(url.searchParams.get('max_depth')).toBe('2');
    expect(url.searchParams.get('min_date')).toBe('2024-09-03');

    // The old, broken shape: one query value holding a JSON array literal.
    expect(url.search).not.toContain('%5B');
    expect(url.search).not.toContain(JSON.stringify(component));
    expect(url.search).not.toContain(JSON.stringify(risk));
  });

  it('dispatches through the ordinary SDK-first path when component/risk/countries are all empty', async () => {
    const result = await sayariSupplyChainUpstreamTradeTraversal.dispatch(
      { id: 'DZjFMEwRYOXYl0_wBTO8ew', maxDepth: 2 },
      deps,
    );
    // Not the exact-once assertion above: the SDK path is allowed to run,
    // proving this row does not force raw when nothing needs it to.
    expect(requestedUrls.some((u) => u.pathname === '/v1/supply_chain/upstream/DZjFMEwRYOXYl0_wBTO8ew')).toBe(
      true,
    );
    expect(result.via).toBe('sdk');
  });

  it('an empty (but present) component/risk array does not force raw — same rule as hasPopulatedRiskCategories', async () => {
    const result = await sayariSupplyChainUpstreamTradeTraversal.dispatch(
      { id: 'DZjFMEwRYOXYl0_wBTO8ew', component: [], risk: [], maxDepth: 2 },
      deps,
    );
    expect(result.via).toBe('sdk');
  });

  it('builds a raw fallback query string that round-trips the same shape through rawFetch', async () => {
    const query = upstreamTradeTraversalQuery({
      component: ['870899'],
      risk: ['sanctions_ofac_sdn'],
      maxDepth: 2,
      minDate: '2024-09-03',
    });
    await rawFetch({ path: '/v1/supply_chain/upstream/x', query }, deps);

    expect(requestedUrls).toHaveLength(1);
    const url = requestedUrls[0]!;
    expect(url.pathname).toBe('/v1/supply_chain/upstream/x');
    expect(url.searchParams.getAll('component')).toEqual(['870899']);
    expect(url.searchParams.getAll('risk')).toEqual(['sanctions_ofac_sdn']);
    expect(url.searchParams.get('max_depth')).toBe('2');
    expect(url.searchParams.get('min_date')).toBe('2024-09-03');
  });
});

/**
 * `upstreamTradeTraversalSchema` — a hand-built body shaped like the SDK's
 * own documented example
 * (`node_modules/@sayari/sdk/api/resources/supplyChain/types/
 * UpstreamTradeTraversalResponse.d.ts`), camelCase, as the SDK path
 * deserialises it.
 */
describe('upstreamTradeTraversalSchema', () => {
  const sdkBody = {
    filters: { product: ['7616'] },
    data: {
      paths: [
        {
          sourceEntityId: 'aGhVqFtVmSjbXqH6oBX6IA',
          path: [
            {
              tier: 2,
              entityId: 'Tdge30S7idW8cJHRaTABtg',
              components: [
                {
                  hsCode: '2818',
                  arrivalCountries: ['VNM'],
                  departureCountries: ['TWN'],
                  maxDate: '2023-03-01',
                },
              ],
            },
          ],
        },
      ],
      entities: {
        Tdge30S7idW8cJHRaTABtg: {
          id: 'Tdge30S7idW8cJHRaTABtg',
          type: 'company',
          label: 'TIEN YEOU TRADING CO LTD',
          riskFactors: [],
          countries: ['ITA', 'TWN'],
        },
        aGhVqFtVmSjbXqH6oBX6IA: {
          id: 'aGhVqFtVmSjbXqH6oBX6IA',
          type: 'company',
          label: 'Công ty TNHH KRICO',
          riskFactors: ['exports_ilab_forced_labor', 'psa_imports_ilab_forced_labor'],
          countries: ['VNM'],
        },
      },
    },
    exploredCount: 98,
    partialResults: false,
  };

  it('projects the top-level coverage fields', () => {
    const parsed = upstreamTradeTraversalSchema.parse(sdkBody);
    expect(parsed.explored_count).toBe(98);
    expect(parsed.partial_results).toBe(false);
  });

  it('projects data.paths[].path[].components with HS components per tier', () => {
    const parsed = upstreamTradeTraversalSchema.parse(sdkBody);
    const path = parsed.data!.paths![0]!;
    expect(path.source_entity_id).toBe('aGhVqFtVmSjbXqH6oBX6IA');
    const segment = path.path![0]!;
    expect(segment.tier).toBe(2);
    expect(segment.entity_id).toBe('Tdge30S7idW8cJHRaTABtg');
    expect(segment.components?.[0]?.hs_code).toBe('2818');
    expect(segment.components?.[0]?.arrival_countries).toEqual(['VNM']);
  });

  it('projects data.entities as a map keyed by entity id, with a flat risk_factors array', () => {
    const parsed = upstreamTradeTraversalSchema.parse(sdkBody);
    const entity = parsed.data?.entities?.['aGhVqFtVmSjbXqH6oBX6IA'];
    expect(entity?.label).toBe('Công ty TNHH KRICO');
    expect(entity?.risk_factors).toEqual([
      'exports_ilab_forced_labor',
      'psa_imports_ilab_forced_labor',
    ]);
    // Flat strings, never the leveled {value, metadata, level} shape
    // SayariEntity.risk carries.
    expect(Array.isArray(entity?.risk_factors)).toBe(true);
  });

  /**
   * The confirmed, independent response-parse bug
   * (`docs/research/sayari-node-sdk.md` §5): `filters.max_depth`/
   * `filters.limit` echoed back as strings. `filters` is left fully open so
   * this never fails the whole projection.
   */
  it('tolerates filters.max_depth/limit echoed back as strings', () => {
    const body = { ...sdkBody, filters: { max_depth: '1', limit: '5' } };
    const parsed = upstreamTradeTraversalSchema.parse(body);
    expect(parsed.filters).toEqual({ max_depth: '1', limit: '5' });
  });

  it('accepts a body with zero paths (no upstream tiers found)', () => {
    const parsed = upstreamTradeTraversalSchema.parse({
      filters: {},
      data: { paths: [], entities: {} },
      exploredCount: 0,
      partialResults: false,
    });
    expect(parsed.data?.paths).toEqual([]);
    expect(parsed.data?.entities).toEqual({});
  });
});
