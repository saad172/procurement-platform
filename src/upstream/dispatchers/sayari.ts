import { getSayariClient, requestOptions, SAYARI_BASE_URL } from './sayari-client';
import type { DispatchDeps, UpstreamVia } from '../types';

/**
 * Sayari dispatch, with the raw-fetch fallback (SPEC §16.1).
 *
 * **The fallback is insurance, not a path.** Nothing this design calls is a
 * confirmed parse-bug endpoint: the two documented deserialization bugs are
 * `resolution` with `profile: "suppliers"` (avoided by omitting `profile`) and
 * `supplyChain.upstreamTradeTraversal` (which lost to `trade.searchSuppliers`),
 * and a third, `ontology.getRiskFactors`, is called by no tool here.
 *
 * That is why the insurance is bought with a **deliberately-routed live
 * endpoint** — `metadata` runs raw on every boot (§16.7) — rather than with a
 * catch-all alone. A catch-all that CI never exercises is code that will not
 * work the first time it is needed.
 *
 * **Honest cost:** when the fallback fires, the call spends twice. The
 * `usage_event` rows make that visible rather than hiding it.
 */

type SdkCall<T> = () => Promise<T>;

/**
 * The raw request the fallback re-issues. Paths and query-parameter names are
 * taken from the SDK's own client, so the fallback hits the same endpoint the
 * SDK would have — a fallback aimed somewhere else is not a fallback.
 *
 * An array value is sent **repeated**, one `key=value` pair per entry —
 * `qs.stringify(params, { arrayFormat: 'repeat' })` is what the SDK's own
 * fetcher uses (`node_modules/@sayari/sdk/core/fetcher/createRequestUrl.js`),
 * not `key[]=value` and not a comma-joined single value. A caller that wants
 * the SDK's other array encoding — the single JSON-stringified value it uses
 * for `risk_categories` (`(0, json_1.toJson)(riskCategories)` in
 * `.../traversal/client/Client.js`) — pre-stringifies it and passes a plain
 * string here instead.
 */
export type RawRequest = {
  path: string;
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | boolean | readonly (string | number)[] | undefined>;
  body?: unknown;
};

/**
 * Recognises the SDK's `ParseError` without deep-importing it (see classify.ts).
 *
 * **`ParseError` only.** The SDK also throws `JsonError`, and the two are
 * opposite diagnoses: `ParseError` means it could not read *their response* —
 * the documented bug the fallback exists for — while `JsonError` means it could
 * not serialise *our request*, which is our own malformed input. Re-issuing a
 * malformed request raw would spend a second credit to fail the same way.
 */
function isParseError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; errors?: unknown };
  return candidate.name === 'ParseError' && Array.isArray(candidate.errors);
}

/**
 * Runs the SDK call; on a *parse* failure only, re-issues the same request as a
 * raw fetch against the same path. Any other failure propagates — a 403 is not
 * something a second request will fix, and retrying it would spend twice for
 * nothing.
 */
export async function viaSdkWithRawFallback<T>(
  sdkCall: SdkCall<T>,
  rawRequest: () => RawRequest,
  deps: DispatchDeps,
): Promise<{ body: unknown; via: UpstreamVia }> {
  try {
    return { body: await sdkCall(), via: 'sdk' };
  } catch (error) {
    if (!isParseError(error)) throw error;
    return { body: await rawFetch(rawRequest(), deps), via: 'raw' };
  }
}

/** The raw path. Authenticates by minting its own bearer token. */
export async function rawFetch(request: RawRequest, deps: DispatchDeps): Promise<unknown> {
  const token = await getBearerToken(deps);
  const url = new URL(request.path, SAYARI_BASE_URL);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, String(item));
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  const method = request.method ?? 'GET';
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(request.body ?? {}) } : {}),
    signal: deps.signal,
  });
  if (!response.ok) {
    const error = new Error(`Sayari raw fetch failed: ${response.status} ${response.statusText}`);
    Object.assign(error, { statusCode: response.status });
    throw error;
  }
  return response.json();
}

/**
 * Sayari's OAuth2 client-credentials grant.
 *
 * The SDK holds a token internally but does not expose it, so the raw path
 * mints its own and caches it. Two tokens for one process is a small cost for
 * not depending on the SDK's private surface.
 */
let cachedToken: { value: string; expiresAt: number } | undefined;

async function getBearerToken(deps: DispatchDeps): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const response = await fetch(new URL('/oauth/token', SAYARI_BASE_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: deps.credentials.sayariClientId,
      client_secret: deps.credentials.sayariClientSecret,
      audience: 'sayari.com',
      grant_type: 'client_credentials',
    }),
    signal: deps.signal,
  });
  if (!response.ok) {
    const error = new Error(`Sayari token request failed: ${response.status}`);
    Object.assign(error, { statusCode: response.status });
    throw error;
  }
  const payload = (await response.json()) as { access_token: string; expires_in?: number };
  cachedToken = {
    value: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1_000,
  };
  return cachedToken.value;
}

export function resetSayariTokenForTesting(): void {
  cachedToken = undefined;
}

export { getSayariClient, requestOptions };
