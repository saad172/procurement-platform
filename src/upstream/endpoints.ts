import { z } from 'zod';
import { getSayariClient, rawFetch, viaSdkWithRawFallback } from './dispatchers/sayari';
import { requestOptions } from './dispatchers/sayari-client';
import {
  gleifManySchema,
  gleifOneSchema,
  nominatimSchema,
  usitcSchema,
  worldBankSchema,
} from './projections/external';
import {
  entitySchema,
  negativeNewsSchema,
  recordSchema,
  resolutionSchema,
  searchEntitySchema,
  tradeSearchSchema,
  traversalSchema,
  usageSchema,
} from './projections/sayari';
import type { DispatchDeps, EndpointDef } from './types';

/**
 * The declared endpoint table (SPEC §16.2) — five sources, one row each per
 * endpoint the app actually calls.
 *
 * Declaring endpoints as **data** is what lets `call()` be the only code that
 * touches the network. Adding a source is adding rows here; a row cannot forget
 * to write its cache entry or its usage row, because it does not do either —
 * `call()` does.
 *
 * ## Timeouts (SPEC §16.4)
 *
 *   30 s  fast Sayari
 *   60 s  the three slow ones — trade (3.6–13.4 s measured), negativeNews
 *         (7–15 s measured), traversal
 *   10 s  the four external sources
 *
 * ## Request parameters are explicit (SPEC §16.6)
 *
 * `getEntity` carries eleven independent limit params. All are set explicitly
 * at the server's own defaults, except three deliberately shrunk where nothing
 * reads them. Explicit-at-default is not a no-op: it makes the request
 * self-describing and puts the numbers **inside `params_hash`**, so a
 * server-side default change becomes a visible difference rather than a
 * silently different body under an unchanged key.
 */

const SAYARI_FAST_MS = 30_000;
const SAYARI_SLOW_MS = 60_000;
const EXTERNAL_MS = 10_000;

/** Small helper so each row reads as data rather than as a type puzzle. */
function defineEndpoint<TParams extends Record<string, unknown>, TProjected>(
  def: EndpointDef<TParams, TProjected>,
): EndpointDef<TParams, TProjected> {
  return def;
}

/** Most params are already flat; this keeps `undefined` out of the hash. */
const flat = (params: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));

// ─────────────────────────────────────────────────────────────────────────────
// Sayari
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The eleven `getEntity` limit params, at the server's own defaults except the
 * three shrunk because nothing in this app reads them.
 */
const GET_ENTITY_LIMITS = {
  attributesNameLimit: 100,
  attributesAddressLimit: 100,
  attributesCountryLimit: 100,
  attributesAdditionalInformationLimit: 5, // shrunk from 100 — unread
  attributesBusinessPurposeLimit: 100,
  attributesCompanyTypeLimit: 5, // shrunk from 100 — unread
  attributesIdentifierLimit: 100,
  attributesStatusLimit: 100,
  relationshipsLimit: 100,
  possiblySameAsLimit: 100,
  referencedByLimit: 20, // shrunk from 100 — unread
} as const;

export const sayariGetEntity = defineEndpoint({
  source: 'sayari',
  endpoint: 'entity.getEntity',
  bucket: 'entity',
  timeoutMs: SAYARI_FAST_MS,
  defaults: GET_ENTITY_LIMITS,
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps: DispatchDeps) => {
    const { id, ...rest } = params;
    const client = getSayariClient(deps.credentials);
    return viaSdkWithRawFallback(
      () => client.entity.getEntity(String(id), rest as never, requestOptions(deps)),
      () => ({ path: `/v1/entity/${encodeURIComponent(String(id))}` }),
      deps,
    );
  },
  projection: entitySchema,
} as EndpointDef<{ id: string } & Partial<typeof GET_ENTITY_LIMITS>, z.infer<typeof entitySchema>>);

export const sayariGetRecord = defineEndpoint({
  source: 'sayari',
  endpoint: 'record.getRecord',
  bucket: 'record',
  timeoutMs: SAYARI_FAST_MS,
  defaults: {},
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps) => {
    const client = getSayariClient(deps.credentials);
    return viaSdkWithRawFallback(
      () => client.record.getRecord(String(params.id), {}, requestOptions(deps)),
      () => ({ path: `/v1/record/${encodeURIComponent(String(params.id))}` }),
      deps,
    );
  },
  projection: recordSchema,
} as EndpointDef<{ id: string }, z.infer<typeof recordSchema>>);

/**
 * The batch resolution pre-pass (SPEC §6.5, rung R1).
 *
 * `enableLlmClean` is set **explicitly true** for this messy trade-name roster,
 * so it sits inside `params_hash` — and so the write-up can say plainly that
 * *Sayari runs a model over our query before matching*. Our resolver therefore
 * contains a model we did not choose and cannot inspect (SPEC §22.2 item 19).
 *
 * `profile` is deliberately **omitted**: `resolution` with
 * `profile: "suppliers"` is one of the two documented SDK deserialization bugs,
 * and omitting the parameter avoids it entirely.
 */
export const sayariResolve = defineEndpoint({
  source: 'sayari',
  endpoint: 'resolution.resolutionPost',
  bucket: 'resolution',
  timeoutMs: SAYARI_SLOW_MS,
  defaults: { enableLlmClean: true, limit: 10 },
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps) => {
    const client = getSayariClient(deps.credentials);
    // The roster arrays go in `body`; `limit` and `enableLlmClean` sit beside
    // it. One call carries every row — the pre-pass fans out, which is why it
    // is a Job step rather than a tool (SPEC §6.5, §15.6).
    const request = {
      limit: params.limit,
      enableLlmClean: params.enableLlmClean,
      body: params.body,
    };
    return viaSdkWithRawFallback(
      () => client.resolution.resolutionPost(request as never, requestOptions(deps)),
      () => ({
        path: '/v1/resolution',
        method: 'POST' as const,
        query: { limit: params.limit as number, enable_llm_clean: params.enableLlmClean as boolean },
        body: params.body,
      }),
      deps,
    );
  },
  projection: resolutionSchema,
} as EndpointDef<
  {
    body: { name: string[]; address?: string[]; country?: string[] };
    limit?: number;
    enableLlmClean?: boolean;
  },
  z.infer<typeof resolutionSchema>
>);

export const sayariSearchEntity = defineEndpoint({
  source: 'sayari',
  endpoint: 'search.searchEntity',
  bucket: 'search',
  timeoutMs: SAYARI_FAST_MS,
  defaults: { limit: 10 },
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps) => {
    const client = getSayariClient(deps.credentials);
    return viaSdkWithRawFallback(
      () => client.search.searchEntity(params as never, requestOptions(deps)),
      () => ({ path: '/v1/search/entity', method: 'POST' as const, body: params }),
      deps,
    );
  },
  projection: searchEntitySchema,
} as EndpointDef<Record<string, unknown>, z.infer<typeof searchEntitySchema>>);

/**
 * The Corporate family read (SPEC §8).
 *
 * One call at `limit: 50`, and it returns each path terminal as a **full entity
 * with its `risk` block inline** — which is the measurement that turned the
 * family from 25 calls into one, and put it on the standard enrichment path
 * rather than behind a button.
 *
 * Downward-only and psa-routed: on the measured company `traversal.ubo`
 * returned 0 and ownership-typed `traversal.traversal` at depth 2 returned 0,
 * while `traversal.ownership` reached all 17 members — every path running
 * through one or two `possibly_same_as` hops to *other* records of the same
 * company. Sayari splits a company across records and the ownership hangs off
 * the others.
 */
export const sayariTraversalOwnership = defineEndpoint({
  source: 'sayari',
  endpoint: 'traversal.ownership',
  bucket: 'traversal',
  timeoutMs: SAYARI_SLOW_MS,
  defaults: { limit: 50 },
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps) => {
    const { id, ...rest } = params;
    const client = getSayariClient(deps.credentials);
    return viaSdkWithRawFallback(
      () => client.traversal.ownership(String(id), rest as never, requestOptions(deps)),
      // `ownership` is `/v1/downstream/{id}` in the SDK — which is itself the
      // clearest statement that the Corporate family read is downward-only.
      () => ({ path: `/v1/downstream/${encodeURIComponent(String(id))}`, query: { limit: rest.limit as number } }),
      deps,
    );
  },
  projection: traversalSchema,
} as EndpointDef<{ id: string; limit?: number }, z.infer<typeof traversalSchema>>);

/**
 * The general traversal, used for Deep Traversal and for the type-filtered
 * `maxDepth: 1` read that recovers owner edges when the entity payload's
 * relationship window is swamped by trade edges (SPEC §16.6).
 */
export const sayariTraversal = defineEndpoint({
  source: 'sayari',
  endpoint: 'traversal.traversal',
  bucket: 'traversal',
  timeoutMs: SAYARI_SLOW_MS,
  defaults: {},
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps) => {
    const { id, ...rest } = params;
    const client = getSayariClient(deps.credentials);
    return viaSdkWithRawFallback(
      () => client.traversal.traversal(String(id), rest as never, requestOptions(deps)),
      () => ({ path: `/v1/traversal/${encodeURIComponent(String(id))}` }),
      deps,
    );
  },
  projection: traversalSchema,
} as EndpointDef<{ id: string } & Record<string, unknown>, z.infer<typeof traversalSchema>>);

/** Takes a bare name, so the input is always the **resolved legal name**. */
export const sayariNegativeNews = defineEndpoint({
  source: 'sayari',
  endpoint: 'negativeNews.negativeNews',
  // No bucket: `negativeNews` is not metered in `info.getUsage()` at all, which
  // the usage surface footnotes rather than papering over (SPEC §18.1).
  timeoutMs: SAYARI_SLOW_MS,
  defaults: {},
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps) => {
    const client = getSayariClient(deps.credentials);
    return viaSdkWithRawFallback(
      () => client.negativeNews.negativeNews(params as never, requestOptions(deps)),
      () => ({ path: '/v1/negative_news', query: params as Record<string, string> }),
      deps,
    );
  },
  projection: negativeNewsSchema,
} as EndpointDef<{ name: string } & Record<string, unknown>, z.infer<typeof negativeNewsSchema>>);

/** Discover's mechanism: who ships this HS line into these territories. */
export const sayariTradeSearchSuppliers = defineEndpoint({
  source: 'sayari',
  endpoint: 'trade.searchSuppliers',
  bucket: 'trade',
  timeoutMs: SAYARI_SLOW_MS,
  defaults: { limit: 100 },
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps) => {
    const client = getSayariClient(deps.credentials);
    /**
     * `filter` carries the HS lines and arrival countries; `q` is free text.
     *
     * The keys are **camelCase** — `hsCode`, `arrivalCountry`. Sent as
     * snake_case they are silently ignored rather than rejected, and the call
     * returns `size.count: 0` with an empty `data` array, which looks exactly
     * like "no company ships this line here". Naming them once, here, is the
     * endpoint table's whole purpose: a caller says what it wants, not how the
     * API spells it.
     */
    const request = {
      limit: params.limit,
      ...(params.q ? { q: params.q } : {}),
      filter: {
        ...(params.hsCodes ? { hsCode: params.hsCodes } : {}),
        ...(params.arrivalCountries ? { arrivalCountry: params.arrivalCountries } : {}),
      },
    };
    return viaSdkWithRawFallback(
      () => client.trade.searchSuppliers(request as never, requestOptions(deps)),
      () => ({ path: '/v1/trade/search/suppliers', method: 'POST' as const, body: request }),
      deps,
    );
  },
  projection: tradeSearchSchema,
} as EndpointDef<
  { hsCodes?: string[]; arrivalCountries?: string[]; q?: string; limit?: number },
  z.infer<typeof tradeSearchSchema>
>);

/** Account-wide, rolling-year, seven counters, no dollars (SPEC §18.1). */
export const sayariUsage = defineEndpoint({
  source: 'sayari',
  endpoint: 'info.getUsage',
  timeoutMs: SAYARI_FAST_MS,
  defaults: {},
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps) => {
    const client = getSayariClient(deps.credentials);
    return viaSdkWithRawFallback(
      () => client.info.getUsage(params as never, requestOptions(deps)),
      () => ({ path: '/v1/usage' }),
      deps,
    );
  },
  projection: usageSchema,
} as EndpointDef<Record<string, unknown>, unknown>);

/**
 * The boot call (SPEC §16.7).
 *
 * Runs raw on start, non-blocking, logs its classification, and **gates
 * nothing**. Credential *presence* stays the boot zod tier and still refuses to
 * boot; this exists so that one line of routing converts emergency-only code
 * into a path that runs every time — which matters because CI never exercises
 * it.
 */
export const sayariMetadataRaw = defineEndpoint({
  source: 'sayari',
  endpoint: 'metadata.raw',
  timeoutMs: SAYARI_FAST_MS,
  defaults: {},
  normalizeParams: () => ({}),
  dispatch: async (_params, deps) => ({
    body: await rawFetch({ path: '/v1/metadata' }, deps),
    via: 'raw' as const,
  }),
  projection: z.unknown(),
} as EndpointDef<Record<string, never>, unknown>);

// ─────────────────────────────────────────────────────────────────────────────
// GLEIF — the identity witness
// ─────────────────────────────────────────────────────────────────────────────

const GLEIF_BASE = 'https://api.gleif.org/api/v1';

/**
 * The exact-LEI join. **Decisive**, and the second witness the auto-accept gate
 * requires (SPEC §6.3).
 *
 * Its accepted consequence, stated rather than discovered: a company with **no
 * LEI can never be auto-accepted** — the real Robert Bosch GmbH included. That
 * is the safe direction of failure, and the resulting count is a result to
 * report rather than a defect to fix.
 */
export const gleifJoinLei = defineEndpoint({
  source: 'gleif',
  endpoint: 'lei-records.byId',
  timeoutMs: EXTERNAL_MS,
  defaults: {},
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps) => {
    const response = await fetch(
      `${GLEIF_BASE}/lei-records/${encodeURIComponent(String(params.lei))}`,
      { headers: { accept: 'application/vnd.api+json' }, signal: deps.signal },
    );
    if (!response.ok) {
      const error = new Error(`GLEIF ${response.status}`);
      Object.assign(error, { statusCode: response.status });
      throw error;
    }
    return { body: await response.json(), via: 'raw' as const };
  },
  projection: gleifOneSchema,
} as EndpointDef<{ lei: string }, z.infer<typeof gleifOneSchema>>);

/**
 * Name search, with its native-script limitation.
 *
 * Two things this endpoint gets wrong quietly, both handled here:
 * - the country filter is **ISO2**; an ISO3 code returns 200 with zero results,
 *   so the parameter is converted before it is sent *and before it is hashed*;
 * - the search hits only the **native-script primary name**, so Denso and
 *   Hyundai Mobis return zero in English. A zero here is therefore
 *   `unavailable`, never `fail`.
 */
export const gleifSearchByName = defineEndpoint({
  source: 'gleif',
  endpoint: 'lei-records.search',
  timeoutMs: EXTERNAL_MS,
  defaults: { pageSize: 10 },
  normalizeParams: (p) => flat({ ...p, country: iso3ToIso2(p.country as string | undefined) }),
  dispatch: async (params, deps) => {
    const url = new URL(`${GLEIF_BASE}/lei-records`);
    url.searchParams.set('filter[entity.legalName]', String(params.name));
    const iso2 = iso3ToIso2(params.country as string | undefined);
    if (iso2) url.searchParams.set('filter[entity.legalAddress.country]', iso2);
    url.searchParams.set('page[size]', String(params.pageSize ?? 10));
    const response = await fetch(url, {
      headers: { accept: 'application/vnd.api+json' },
      signal: deps.signal,
    });
    if (!response.ok) {
      const error = new Error(`GLEIF ${response.status}`);
      Object.assign(error, { statusCode: response.status });
      throw error;
    }
    return { body: await response.json(), via: 'raw' as const };
  },
  projection: gleifManySchema,
} as EndpointDef<{ name: string; country?: string; pageSize?: number }, z.infer<typeof gleifManySchema>>);

/**
 * The roster is ISO3 and GLEIF is ISO2. Only the roster's eleven origins are
 * mapped: a partial table that returns `undefined` for anything else is safer
 * than a full one nobody checks, because `undefined` drops the filter rather
 * than sending a code that silently matches nothing.
 */
const ISO3_TO_ISO2: Record<string, string> = {
  USA: 'US', DEU: 'DE', JPN: 'JP', KOR: 'KR', FRA: 'FR',
  ESP: 'ES', CAN: 'CA', CHN: 'CN', MEX: 'MX', IND: 'IN', GBR: 'GB',
};

export function iso3ToIso2(iso3: string | undefined): string | undefined {
  if (!iso3) return undefined;
  if (iso3.length === 2) return iso3.toUpperCase();
  return ISO3_TO_ISO2[iso3.toUpperCase()];
}

// ─────────────────────────────────────────────────────────────────────────────
// World Bank
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `mrnev=1` — most recent non-empty value — is the correct latest-value
 * operator. `mrv=1` returns nulls for late reporters, which reads as "no data"
 * for a country that has data.
 */
export const worldBankIndicator = defineEndpoint({
  source: 'worldbank',
  endpoint: 'v2.indicator',
  timeoutMs: EXTERNAL_MS,
  defaults: { format: 'json', mrnev: 1 },
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps) => {
    const url = new URL(
      `https://api.worldbank.org/v2/country/${encodeURIComponent(String(params.country))}/indicator/${encodeURIComponent(String(params.indicator))}`,
    );
    url.searchParams.set('format', 'json');
    url.searchParams.set('mrnev', String(params.mrnev ?? 1));
    const response = await fetch(url, { signal: deps.signal });
    if (!response.ok) {
      const error = new Error(`World Bank ${response.status}`);
      Object.assign(error, { statusCode: response.status });
      throw error;
    }
    return { body: await response.json(), via: 'raw' as const };
  },
  projection: worldBankSchema,
} as EndpointDef<{ country: string; indicator: string; mrnev?: number; format?: string }, z.infer<typeof worldBankSchema>>);

// ─────────────────────────────────────────────────────────────────────────────
// USITC HTS
// ─────────────────────────────────────────────────────────────────────────────

/** Keyless, and it agreed exactly with WITS on three live cross-checks. */
export const usitcTariff = defineEndpoint({
  source: 'usitc',
  endpoint: 'reststop.search',
  timeoutMs: EXTERNAL_MS,
  defaults: {},
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps) => {
    const url = new URL('https://hts.usitc.gov/reststop/search');
    url.searchParams.set('keyword', String(params.hsCode));
    const response = await fetch(url, { signal: deps.signal });
    if (!response.ok) {
      const error = new Error(`USITC ${response.status}`);
      Object.assign(error, { statusCode: response.status });
      throw error;
    }
    return { body: await response.json(), via: 'raw' as const };
  },
  projection: usitcSchema,
} as EndpointDef<{ hsCode: string }, z.infer<typeof usitcSchema>>);

// ─────────────────────────────────────────────────────────────────────────────
// Nominatim
// ─────────────────────────────────────────────────────────────────────────────

/**
 * For **Plants and unresolved rows only** — Sayari's own `x`/`y` supersedes
 * this for a resolved Profile.
 *
 * The rate gate (≤ 1 req/s) and the identifying User-Agent are both policy
 * requirements, and results are cached forever, so a repeat costs nothing.
 */
export const nominatimGeocode = defineEndpoint({
  source: 'nominatim',
  endpoint: 'search',
  timeoutMs: EXTERNAL_MS,
  defaults: { format: 'jsonv2', limit: 1, addressdetails: 1 },
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps) => {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', String(params.q));
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', String(params.limit ?? 1));
    url.searchParams.set('addressdetails', '1');
    const response = await fetch(url, {
      headers: { 'user-agent': deps.credentials.nominatimUserAgent },
      signal: deps.signal,
    });
    if (!response.ok) {
      const error = new Error(`Nominatim ${response.status}`);
      Object.assign(error, { statusCode: response.status });
      throw error;
    }
    return { body: await response.json(), via: 'raw' as const };
  },
  projection: nominatimSchema,
} as EndpointDef<{ q: string; limit?: number }, z.infer<typeof nominatimSchema>>);

/** Every endpoint, so a test can quantify over them (SPEC §16.2). */
export const ENDPOINTS = {
  sayariGetEntity,
  sayariGetRecord,
  sayariResolve,
  sayariSearchEntity,
  sayariTraversalOwnership,
  sayariTraversal,
  sayariNegativeNews,
  sayariTradeSearchSuppliers,
  sayariUsage,
  sayariMetadataRaw,
  gleifJoinLei,
  gleifSearchByName,
  worldBankIndicator,
  usitcTariff,
  nominatimGeocode,
} as const;
