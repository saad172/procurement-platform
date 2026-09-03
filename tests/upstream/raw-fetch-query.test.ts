import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rawFetch, resetSayariTokenForTesting } from '@/upstream/dispatchers/sayari';
import type { DispatchDeps } from '@/upstream/types';

/**
 * `rawFetch`'s query-string encoding (ticket 01 items B): an array value is
 * sent **repeated** (`key=a&key=b`), matching the SDK's own
 * `qs.stringify(params, { arrayFormat: 'repeat' })`
 * (`node_modules/@sayari/sdk/core/fetcher/createRequestUrl.js`) — never
 * `key[]=a` and never a comma-joined single value, which a real Sayari
 * traversal endpoint would read as one (wrong) relationship type.
 *
 * No live call: `fetch` is stubbed for both the OAuth token exchange and the
 * request itself, and only the request URL is asserted.
 */
describe('rawFetch query encoding', () => {
  const deps: DispatchDeps = {
    credentials: { sayariClientId: 'id', sayariClientSecret: 'secret', nominatimUserAgent: 'ua' },
    signal: new AbortController().signal,
    timeoutMs: 1_000,
  };

  let requestedUrl: URL | undefined;

  beforeEach(() => {
    resetSayariTokenForTesting();
    requestedUrl = undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: URL | string) => {
        const url = input instanceof URL ? input : new URL(String(input));
        if (url.pathname === '/oauth/token') {
          return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), {
            status: 200,
          });
        }
        requestedUrl = url;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('repeats an array-valued query param, one pair per entry', async () => {
    await rawFetch(
      { path: '/v1/downstream/x', query: { relationships: ['shareholder_of', 'has_officer'] } },
      deps,
    );
    expect(requestedUrl?.searchParams.getAll('relationships')).toEqual([
      'shareholder_of',
      'has_officer',
    ]);
  });

  it('sends a scalar query param once, and omits undefined entries', async () => {
    await rawFetch(
      { path: '/v1/downstream/x', query: { max_depth: 3, min_depth: undefined } },
      deps,
    );
    expect(requestedUrl?.searchParams.get('max_depth')).toBe('3');
    expect(requestedUrl?.searchParams.has('min_depth')).toBe(false);
  });

  /** N3: every SDK client tests `!= null`, so a `null` value never reaches
   * the wire — `URLSearchParams` has no such test and would have sent the
   * literal string `"null"`. */
  it('skips a null query value, the same as undefined', async () => {
    await rawFetch({ path: '/v1/downstream/x', query: { max_depth: 3, min_depth: null } }, deps);
    expect(requestedUrl?.searchParams.get('max_depth')).toBe('3');
    expect(requestedUrl?.searchParams.has('min_depth')).toBe(false);
  });

  /** N4: `URLSearchParams` follows `application/x-www-form-urlencoded` and
   * emits `+` for a space; the SDK's own fetcher uses `qs.stringify`, which
   * emits `%20`. Asserted on the raw string — `.searchParams.get()` would
   * decode either encoding back to the same space and hide the difference. */
  it('encodes a space as %20, not +', async () => {
    await rawFetch({ path: '/v1/search/entity', query: { q: 'american axle' } }, deps);
    expect(requestedUrl?.search).toContain('q=american%20axle');
    expect(requestedUrl?.search).not.toContain('+');
  });
});
