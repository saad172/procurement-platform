import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  sayariTraversal,
  sayariTraversalOwnership,
  sayariTraversalUbo,
  sayariTraversalWatchlist,
} from '@/upstream/endpoints';
import { resetSayariTokenForTesting } from '@/upstream/dispatchers/sayari';
import type { DispatchDeps } from '@/upstream/types';

/**
 * The live bug (03f): `enrichOwnership` sent `riskCategories: ['sanctions',
 * 'export_controls', 'forced_labor']` and Sayari answered `422 "Invalid risk
 * category '[\"sanctions\",\"export_controls\",\"forced_labor\"]'"`. Root
 * cause, live-verified against `/v1/downstream/{id}` with a real entity: the
 * installed `@sayari/sdk` (0.1.44) JSON-stringifies a populated
 * `riskCategories` array into one `risk_categories=` query value on every one
 * of its four traversal-shaped methods — `ownership`, `ubo`, `watchlist` and
 * plain `traversal` — rather than sending it repeated the way it sends
 * `relationships`/`countries`. Sayari's API rejects that single-JSON-string
 * form outright, for one element or many; it wants `risk_categories`
 * repeated, one key per value. That is an SDK defect with no
 * `RequestOptions` escape hatch (`Client.d.ts` has none), so `endpoints.ts`'s
 * `dispatchTraversalWalk` now routes a populated `riskCategories` around the
 * SDK entirely rather than trying to catch the failure after the fact.
 *
 * **Why this cannot be a test of the exception-based fallback catching a
 * 422**: it never would have. `viaSdkWithRawFallback` only retries on the
 * SDK's own `ParseError` (`isParseError`, `dispatchers/sayari.ts`) — a
 * response it could not read. A `422` with a clean `messages` array is a
 * response the SDK reads just fine; it is not a `ParseError`, so the old
 * exception-based fallback would have let the malformed request through
 * every time. This suite instead proves the *request that goes out* is
 * correct, by intercepting `fetch` and reading the URL `rawFetch` built —
 * the same way `raw-fetch-query.test.ts` proves `rawFetch`'s own encoding.
 *
 * No live call: `fetch` is stubbed for the OAuth token exchange and for the
 * GET itself.
 */
describe('a populated riskCategories skips the SDK and hits the raw path correctly', () => {
  const deps: DispatchDeps = {
    credentials: { sayariClientId: 'id', sayariClientSecret: 'secret', nominatimUserAgent: 'ua' },
    signal: new AbortController().signal,
    timeoutMs: 1_000,
  };

  let requestedUrls: URL[] = [];

  beforeEach(() => {
    resetSayariTokenForTesting();
    requestedUrls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | string) => {
        const url = input instanceof URL ? input : new URL(String(input));
        if (url.pathname === '/oauth/token') {
          return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
            status: 200,
          });
        }
        requestedUrls.push(url);
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const riskCategories = ['sanctions', 'export_controls', 'forced_labor'];

  it.each([
    ['sayariTraversalOwnership', sayariTraversalOwnership, '/v1/downstream/CX3012yTGIhgMxcZG6hgnA'],
    ['sayariTraversalUbo', sayariTraversalUbo, '/v1/ubo/CX3012yTGIhgMxcZG6hgnA'],
    ['sayariTraversalWatchlist', sayariTraversalWatchlist, '/v1/watchlist/CX3012yTGIhgMxcZG6hgnA'],
    ['sayariTraversal', sayariTraversal, '/v1/traversal/CX3012yTGIhgMxcZG6hgnA'],
  ] as const)('%s sends riskCategories repeated, never JSON-stringified', async (_name, endpoint, path) => {
    const result = await endpoint.dispatch(
      {
        id: 'CX3012yTGIhgMxcZG6hgnA',
        riskCategories,
        excludeClosedEntities: true,
        limit: 50,
      } as never,
      deps,
    );

    // Exactly one non-token request — the SDK's own `client.traversal.*` call
    // is never invoked at all (not called-then-ignored: `dispatchTraversalWalk`
    // never builds the SDK request in the first place), so there is nothing
    // for it to have spent a second, malformed request on.
    expect(requestedUrls).toHaveLength(1);
    expect(result.via).toBe('raw');

    const url = requestedUrls[0]!;
    expect(url.pathname).toBe(path);
    expect(url.searchParams.getAll('risk_categories')).toEqual(riskCategories);

    // The old, broken shape: one query value holding a JSON array literal.
    // `[` url-encodes to `%5B` — its absence is the direct negative of the
    // bug this app shipped live.
    expect(url.search).not.toContain('%5B');
    expect(url.search).not.toContain(JSON.stringify(riskCategories));
  });
});
