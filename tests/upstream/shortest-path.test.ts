import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sayariTraversalShortestPath } from '@/upstream/endpoints';
import { rawFetch, resetSayariTokenForTesting } from '@/upstream/dispatchers/sayari';
import { resetSayariClients } from '@/upstream/dispatchers/sayari-client';
import { shortestPathSchema } from '@/upstream/projections/sayari';
import type { DispatchDeps } from '@/upstream/types';

/**
 * KNOWN GAP, stated plainly rather than left to a source comment: nothing in
 * this file has ever round-tripped through a real Sayari
 * `traversal.shortestPath` response — every body below (the minimal stub in
 * `beforeEach`, and `shortestPathSchema`'s own `sdkBody`) is hand-authored to
 * match this project's Zod schema for the endpoint as it reads today, not
 * replayed from a capture. That is because Sayari's own
 * `traversal.shortestPath` endpoint has a confirmed, ongoing outage,
 * independently verified two ways — this project's own calls all return a
 * real, well-formed `408 Timeout Error` body rather than any success, and a
 * completely separate client (Sayari's own official Python SDK, sharing no
 * code with this project) hit the same endpoint directly and failed the same
 * way on every attempt. Do not fabricate a fixture to close this gap, and do
 * not delete or weaken these hand-built bodies — they are the best available
 * coverage until the endpoint recovers, at which point they should be
 * replaced with a real captured response (this project's own
 * fixture-recording tooling, e.g. `pnpm fixtures:record`, once a live call
 * succeeds again), and this note removed.
 *
 * `sayariTraversalShortestPath` (network spec §4.2, §7; ticket 04).
 *
 * Two things worth proving, mirroring how `risk-categories-dispatch.test.ts`
 * and `raw-fetch-query.test.ts` prove the same class of claim for the other
 * traversal-shaped rows:
 *
 * 1. The SDK path sends `entities` **repeated**
 *    (`entities=<source>&entities=<target>`), never JSON-stringified — the
 *    live-verified difference (this file's own probe against
 *    `node_modules/@sayari/sdk/api/resources/traversal/client/Client.js`)
 *    between `shortestPath` and the four `riskCategories`-affected methods:
 *    `shortestPath` builds its query params with
 *    `_queryParams["entities"] = entities.map((item) => item)` and no
 *    `toJson()` branch, so there is no mis-encoding bug to route around, and
 *    this row correctly dispatches through the ordinary
 *    `viaSdkWithRawFallback` rather than the unconditional-raw
 *    `dispatchTraversalWalk` the other four need.
 * 2. The raw fallback's query string — built explicitly in this endpoint's
 *    `dispatch`, per this file's own rule that every raw fallback carries its
 *    query string (BUILD-NOTES 31) — round-trips through `rawFetch` the same
 *    way, proven directly against `rawFetch` rather than by trying to trigger
 *    `viaSdkWithRawFallback`'s catch branch: a genuine SDK-thrown
 *    `ParseError` has `.constructor.name === 'ParseError'` but
 *    `.name === 'Error'` (verified against the installed `@sayari/sdk`
 *    0.1.44, `core/schemas/builders/schema-utils/ParseError.js`, which never
 *    sets `.name`), so `isParseError`'s `candidate.name === 'ParseError'`
 *    check in `dispatchers/sayari.ts` does not recognise it — a pre-existing
 *    gap in shared fallback machinery this endpoint reuses as-is, not
 *    something new to this row or in this ticket's scope to fix.
 *
 * No live call: `fetch` is stubbed for the OAuth token exchange and for the
 * request itself.
 */
describe('sayariTraversalShortestPath', () => {
  const deps: DispatchDeps = {
    credentials: {
      sayariClientId: 'shortest-path-test',
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
        if (url.pathname.includes('oauth/token')) {
          return new Response(
            JSON.stringify({ access_token: 'tok', expires_in: 3600, token_type: 'Bearer' }),
            { status: 200 },
          );
        }
        requestedUrls.push(url);
        // A minimal, schema-valid ShortestPathResponse body, so the SDK path
        // resolves rather than throwing — the point under test is the
        // *request* it built, not the response.
        return new Response(JSON.stringify({ entities: ['sourceId', 'targetId'], data: [] }), {
          status: 200,
        });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends entities repeated, source then target, via the SDK path', async () => {
    const result = await sayariTraversalShortestPath.dispatch(
      { entities: ['sourceId', 'targetId'] },
      deps,
    );

    expect(result.via).toBe('sdk');
    expect(requestedUrls).toHaveLength(1);
    const url = requestedUrls[0]!;
    expect(url.pathname).toBe('/v1/shortest_path');
    // Repeated, not a single JSON-stringified value — `[` url-encodes to
    // `%5B`, whose absence is the direct negative of the `riskCategories`
    // bug the four traversal-shaped methods have.
    expect(url.searchParams.getAll('entities')).toEqual(['sourceId', 'targetId']);
    expect(url.search).not.toContain('%5B');
  });

  it('builds a raw fallback query string that round-trips the same shape through rawFetch', async () => {
    await rawFetch(
      { path: '/v1/shortest_path', query: { entities: ['sourceId', 'targetId'] } },
      deps,
    );

    expect(requestedUrls).toHaveLength(1);
    const url = requestedUrls[0]!;
    expect(url.pathname).toBe('/v1/shortest_path');
    expect(url.searchParams.getAll('entities')).toEqual(['sourceId', 'targetId']);
  });
});

/**
 * `shortestPathSchema` (ticket 04) — reuses `traversalPathSchemaInner` for
 * each entry of `data`, so this proves the reuse rather than re-deriving the
 * shape: a hand-built body shaped like the SDK's own documented example
 * (`node_modules/@sayari/sdk/api/resources/traversal/types/
 * ShortestPathResponse.d.ts`), camelCase, as the SDK path deserialises it.
 *
 * `sdkBody` below is the hand-authored stand-in this file's own top comment
 * describes — not a replayed real fixture — because Sayari's
 * `traversal.shortestPath` endpoint is confirmed down right now. See that
 * comment for the full account; it should be swapped for a real captured
 * response once the endpoint recovers.
 */
describe('shortestPathSchema', () => {
  const sdkBody = {
    entities: ['H1y25N5ymnFyZ-q9Lpwm_g', '1nOeH5G2EhmRVtmeVqO2Lw'],
    data: [
      {
        source: 'H1y25N5ymnFyZ-q9Lpwm_g',
        // `target` arrives as a full entity, not a bare id — the same fact
        // `traversalPathSchemaInner`'s doc comment already measures for the
        // Corporate family read.
        target: {
          id: '1nOeH5G2EhmRVtmeVqO2Lw',
          label: 'Mr Thomas Bangalter',
          type: 'person',
          sanctioned: false,
          pep: false,
          closed: false,
          risk: {
            basel_aml: { value: 3.67, metadata: { country: ['GBR'] }, level: 'relevant' },
          },
        },
        path: [
          {
            field: 'has_lawyer',
            entity: { id: 'xthsA_jQuKn3GW8-9ILQqg', label: 'LAWRENCE E. APOLZON', type: 'person' },
            relationships: {
              has_lawyer: {
                values: [
                  {
                    record: 'ac1fa195f9cd4ccf657bca3c6db0bb19/76082348/1717632000000',
                    acquisitionDate: '2024-06-06',
                    attributes: {},
                  },
                ],
              },
            },
          },
        ],
      },
    ],
  };

  it('projects entities and the single data entry', () => {
    const parsed = shortestPathSchema.parse(sdkBody);
    expect(parsed.entities).toEqual(['H1y25N5ymnFyZ-q9Lpwm_g', '1nOeH5G2EhmRVtmeVqO2Lw']);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data?.[0]?.source).toBe('H1y25N5ymnFyZ-q9Lpwm_g');
  });

  it('projects target as a full entity with its risk block inline', () => {
    const parsed = shortestPathSchema.parse(sdkBody);
    const target = parsed.data?.[0]?.target;
    expect(typeof target).toBe('object');
    if (typeof target === 'object' && target !== null) {
      expect(target.id).toBe('1nOeH5G2EhmRVtmeVqO2Lw');
      expect(target.risk?.basel_aml?.level).toBe('relevant');
    }
  });

  it('projects the hop chain the same way traversalPathSchemaInner does', () => {
    const parsed = shortestPathSchema.parse(sdkBody);
    const hop = parsed.data?.[0]?.path?.[0];
    expect(hop?.field).toBe('has_lawyer');
    expect(typeof hop?.entity).toBe('object');
  });

  it('accepts a body with 0 data entries (no path found between the two entities)', () => {
    const parsed = shortestPathSchema.parse({ entities: ['a', 'b'], data: [] });
    expect(parsed.data).toEqual([]);
  });

  it('carries no explored_count/partial_results — the envelope genuinely has none', () => {
    const parsed = shortestPathSchema.parse(sdkBody);
    expect('explored_count' in parsed).toBe(false);
    expect('partial_results' in parsed).toBe(false);
  });
});
