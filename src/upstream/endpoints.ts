import { z } from 'zod';
import { alpha2ToAlpha3, alpha3ToAlpha2 } from '@/domain/iso3166';
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
  entitySummarySchema,
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
 *   90 s  the three slow ones — trade (3.6–13.4 s measured), negativeNews,
 *         traversal
 *   10 s  the four external sources
 *
 * **`negativeNews` was 60 s and is now 90 s, because the endpoint got slower
 * than the measurement this table was built on.** It was recorded here at
 * 7–15 s. Called directly on 2026-08-31 it returned `200` with real data in
 * **64.7 s** — past the 60 s ceiling, so `call()` aborted it, retried, and
 * aborted again: two full timeouts and a backoff, ~3 minutes, to fail a request
 * the server was answering correctly the whole time. The job reported *"Could
 * not reach sayari"*, which was true of us and not of Sayari.
 *
 * 90 s is ~25 s of headroom over that one measurement, and one measurement is
 * not a distribution — if it drifts again the number is wrong again. The cost
 * is paid by genuinely dead endpoints, which now take 2 × 90 s to give up
 * instead of 2 × 60 s. That is the right side to be wrong on: a slow answer is
 * still an answer, and a re-run of an enrichment that timed out spends its
 * Sayari calls a second time.
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
const SAYARI_SLOW_MS = 90_000;
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

/**
 * The `relationships*` filter params `getEntity` also accepts, beyond the
 * eleven limits above (ticket 01 item B, "Typed owner-edge read", SPEC
 * §16.6). `relationshipsType` and `relationshipsSort` are the two the ticket
 * names explicitly (`relationshipsSort: "-shares"`); the rest are every
 * sibling the SDK's own `GetEntity` request type declares
 * (`node_modules/@sayari/sdk/api/resources/entity/client/requests/
 * GetEntity.d.ts`), admitted so unit 01b's typed owner-edge read is not stuck
 * re-deriving them later.
 *
 * **`relationshipsType` is singular, not `string[]`.** The SDK's own type is
 * `relationshipsType?: Sayari.Relationships` — no array form, unlike
 * `relationshipsCountry`/`relationshipsArrivalCountry`/`relationshipsPartnerRisk`
 * below, which the SDK types as `T | T[]` and branches on `Array.isArray` at
 * the wire. That asymmetry is also why ticket 01's own text calls for "one
 * type per call" — the SDK genuinely cannot ask for more than one at once.
 *
 * No defaults for any of these, for the same reason the eleven limits above
 * are the only entries in `GET_ENTITY_LIMITS`: a new default would sit inside
 * `params_hash` for every existing `getEntity` call, including the recorded
 * ones, invalidating them all.
 */
type GetEntityRelationshipParams = {
  relationshipsType?: string;
  relationshipsSort?: string;
  relationshipsStartDate?: string;
  relationshipsEndDate?: string;
  relationshipsMinShares?: number;
  relationshipsCountry?: string | string[];
  relationshipsArrivalCountry?: string | string[];
  relationshipsArrivalState?: string;
  relationshipsArrivalCity?: string;
  relationshipsDepartureCountry?: string | string[];
  relationshipsDepartureState?: string;
  relationshipsDepartureCity?: string;
  relationshipsPartnerName?: string;
  relationshipsPartnerRisk?: string | string[];
  relationshipsHsCode?: string;
};

/**
 * The `getEntity` raw fallback's query string — every wire key copied from
 * the SDK's own `entity.getEntity` (`node_modules/@sayari/sdk/api/resources/
 * entity/client/Client.js`, the `_queryParams[...]` assignments in
 * `getEntity`). The dotted keys (`attributes.address.limit`,
 * `relationships.type`, `possibly_same_as.limit`, `referenced_by.limit`) are
 * the API's own, and their casing is **not consistent** — `attributes.*` and
 * `possibly_same_as`/`referenced_by` segments are snake_case, `relationships`
 * sub-keys past `.limit`/`.type`/`.sort` are camelCase
 * (`relationships.startDate`, `relationships.arrivalCountry`) — copied
 * exactly rather than normalised, because normalising it would be exactly
 * the silent-wrong-key failure this item exists to fix (BUILD-NOTES 31):
 * before this, the raw path sent none of them, so a caller falling back here
 * got the server's unfiltered default without complaint.
 */
export function getEntityQuery(rest: Record<string, unknown>) {
  return {
    'attributes.additional_information.limit': rest.attributesAdditionalInformationLimit as
      | number
      | undefined,
    'attributes.address.limit': rest.attributesAddressLimit as number | undefined,
    'attributes.business_purpose.limit': rest.attributesBusinessPurposeLimit as
      | number
      | undefined,
    'attributes.company_type.limit': rest.attributesCompanyTypeLimit as number | undefined,
    'attributes.country.limit': rest.attributesCountryLimit as number | undefined,
    'attributes.identifier.limit': rest.attributesIdentifierLimit as number | undefined,
    'attributes.name.limit': rest.attributesNameLimit as number | undefined,
    'attributes.status.limit': rest.attributesStatusLimit as number | undefined,
    'relationships.limit': rest.relationshipsLimit as number | undefined,
    'relationships.type': rest.relationshipsType as string | undefined,
    'relationships.sort': rest.relationshipsSort as string | undefined,
    'relationships.startDate': rest.relationshipsStartDate as string | undefined,
    'relationships.endDate': rest.relationshipsEndDate as string | undefined,
    'relationships.minShares': rest.relationshipsMinShares as number | undefined,
    'relationships.country': rest.relationshipsCountry as string | string[] | undefined,
    'relationships.arrivalCountry': rest.relationshipsArrivalCountry as
      | string
      | string[]
      | undefined,
    'relationships.arrivalState': rest.relationshipsArrivalState as string | undefined,
    'relationships.arrivalCity': rest.relationshipsArrivalCity as string | undefined,
    'relationships.departureCountry': rest.relationshipsDepartureCountry as
      | string
      | string[]
      | undefined,
    'relationships.departureState': rest.relationshipsDepartureState as string | undefined,
    'relationships.departureCity': rest.relationshipsDepartureCity as string | undefined,
    'relationships.partnerName': rest.relationshipsPartnerName as string | undefined,
    'relationships.partnerRisk': rest.relationshipsPartnerRisk as string | string[] | undefined,
    'relationships.hsCode': rest.relationshipsHsCode as string | undefined,
    'possibly_same_as.limit': rest.possiblySameAsLimit as number | undefined,
    'referenced_by.limit': rest.referencedByLimit as number | undefined,
  };
}

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
      () => ({
        path: `/v1/entity/${encodeURIComponent(String(id))}`,
        query: getEntityQuery(rest),
      }),
      deps,
    );
  },
  projection: entitySchema,
} as EndpointDef<
  { id: string } & Partial<typeof GET_ENTITY_LIMITS> & GetEntityRelationshipParams,
  z.infer<typeof entitySchema>
>);

/**
 * `entity.entitySummary` (SPEC §9 renames row 5; ticket 01 item A2) — cheaper
 * than `getEntity` for the resolve pre-pass's five Candidates. Verified
 * against the SDK: `client.entity.entitySummary(id, requestOptions)` at
 * `/v1/entity_summary/{id}` (`node_modules/@sayari/sdk/api/resources/entity/
 * client/Client.js`), GET, **no request params at all** — unlike `getEntity`
 * it takes none, so there is nothing to widen and nothing beyond `id` to hash.
 *
 * See `entitySummarySchemaInner`'s own doc comment (`projections/sayari.ts`)
 * for exactly what it carries and what it does not.
 *
 * **No `bucket`.** Sayari's own usage-counter type
 * (`node_modules/@sayari/sdk/api/resources/info/types/UsageInfo.d.ts`)
 * declares exactly six buckets — `entity`, `record`, `resolve`, `search`,
 * `tradeTraversal`, `traversal` — with no seventh `entitySummary` counter.
 * Reusing `entity` would be a guess this file has no way to check without a
 * live call, which the ticket forbids; leaving it unbucketed is the same
 * honest gap `negativeNews` already carries, footnoted the same way. See the
 * PR's Re-record list: confirm against a live `info.getUsage()` diff.
 */
export const sayariEntitySummary = defineEndpoint({
  source: 'sayari',
  endpoint: 'entity.entitySummary',
  timeoutMs: SAYARI_FAST_MS,
  defaults: {},
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps) => {
    const client = getSayariClient(deps.credentials);
    return viaSdkWithRawFallback(
      () => client.entity.entitySummary(String(params.id), requestOptions(deps)),
      () => ({ path: `/v1/entity_summary/${encodeURIComponent(String(params.id))}` }),
      deps,
    );
  },
  projection: entitySummarySchema,
} as EndpointDef<{ id: string }, z.infer<typeof entitySummarySchema>>);

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
        query: {
          limit: params.limit as number,
          enable_llm_clean: params.enableLlmClean as boolean,
        },
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
      () => ({
        path: `/v1/downstream/${encodeURIComponent(String(id))}`,
        query: downstreamQuery(rest),
      }),
      deps,
    );
  },
  projection: traversalSchema,
} as EndpointDef<TraversalWalkParams, z.infer<typeof traversalSchema>>);

/**
 * The depth-and-cursor parameters a **Deep Traversal** adds to the same two
 * endpoints the Corporate family already uses (SPEC §8.5), widened for the
 * filtered reads SPEC §4.1/§4.4 need (ticket 01 item A1): `relationships`,
 * `riskCategories`, `countries`, `minShares`, `excludeClosedEntities`,
 * `sanctioned`, `pep`, `psa`.
 *
 * `maxDepth`, `minDepth`, `offset` and the eight new fields are all on the
 * SDK's own `Ownership` and `Ubo` request types (verified against
 * `node_modules/@sayari/sdk/api/resources/traversal/client/requests/
 * Ownership.d.ts` and `.../Ubo.d.ts`, whose fields the two share verbatim),
 * so this is one endpoint row with more of its parameters named rather than a
 * second row aimed at the same URL — which would have given the same call two
 * cache keyspaces and two usage-row endpoint names. `riskCategories` is typed
 * `Sayari.RiskCategory[] | string` on the SDK's request interface (a bare
 * string names a custom, non-enum category); narrowed here to `string[]`
 * because nothing in this app sends the bare-string form.
 *
 * **They are optional and there is no default for them, deliberately.** The
 * defaults are applied before hashing (SPEC §16.6), so writing `maxDepth: 3`
 * into `defaults` would change `params_hash` for the automatic family read that
 * does not ask for a depth at all — invalidating its cache and every recorded
 * fixture that holds one. The same reasoning covers every field added here: a
 * caller that wants a filter says so; a caller that does not gets the
 * server's own default, unfiltered, exactly as today. `enqueue_deep_traversal`
 * is what exposes these to a person as optional inputs (SPEC §4.4); this
 * ticket only widens the type and the wire mapping (item B) that carries it.
 */
export type TraversalWalkParams = {
  id: string;
  limit?: number;
  offset?: number;
  minDepth?: number;
  maxDepth?: number;
  relationships?: string[];
  riskCategories?: string[];
  countries?: string[];
  minShares?: number;
  excludeClosedEntities?: boolean;
  sanctioned?: boolean;
  pep?: boolean;
  psa?: boolean;
};

/**
 * The raw fallback's query string for all three traversal rows (ticket 01
 * item B), named the way the SDK's own client names it — copied from
 * `node_modules/@sayari/sdk/api/resources/traversal/client/Client.js`, the
 * `_queryParams[...]` assignments shared by `ownership`, `ubo` and
 * `traversal`. `min_depth`/`max_depth`, snake_case, against the camelCase the
 * SDK takes: a fallback that sent `maxDepth` would be answered at the
 * server's default depth without complaint, which is the silent-wrong-key
 * failure mode `trade.searchSuppliers` already cost this build once
 * (BUILD-NOTES 31).
 *
 * Three different encodings for three different new fields, each copied
 * rather than guessed:
 * - `relationships`/`countries` go through as **arrays**, sent repeated —
 *   `qs.stringify(params, { arrayFormat: 'repeat' })`
 *   (`core/fetcher/createRequestUrl.js`), which `rawFetch` now knows how to
 *   send (`dispatchers/sayari.ts`).
 * - `risk_categories` is sent as **one JSON-stringified array** in a single
 *   param — `(0, json_1.toJson)(riskCategories)` in the SDK's own code —
 *   pre-stringified here so it stays a scalar rather than being repeated.
 * - `min_shares`/`exclude_closed_entities`/`sanctioned`/`pep`/`psa` are plain
 *   scalars, `.toString()`'d by the SDK the same way `rawFetch` stringifies
 *   any scalar.
 */
export function downstreamQuery(rest: Record<string, unknown>) {
  return {
    limit: rest.limit as number | undefined,
    offset: rest.offset as number | undefined,
    min_depth: rest.minDepth as number | undefined,
    max_depth: rest.maxDepth as number | undefined,
    relationships: rest.relationships as string[] | undefined,
    countries: rest.countries as string[] | undefined,
    min_shares: rest.minShares as number | undefined,
    exclude_closed_entities: rest.excludeClosedEntities as boolean | undefined,
    sanctioned: rest.sanctioned as boolean | undefined,
    pep: rest.pep as boolean | undefined,
    psa: rest.psa as boolean | undefined,
    risk_categories:
      rest.riskCategories !== undefined
        ? (JSON.stringify(rest.riskCategories) as string)
        : undefined,
  };
}

/**
 * The **upward** walk: who owns this company, rather than what it owns.
 *
 * `ubo` is `/v1/ubo/{id}` in the SDK and takes the same parameter set as
 * `ownership`, which is why it can share `downstreamQuery` and the same lenient
 * projection. It exists here for the Deep Traversal alone: the Corporate family
 * is downward-only by measurement (SPEC §8.1 — `traversal.ubo` returned 0 on
 * the measured company), and a Deep Traversal is the person-triggered
 * expansion that is allowed to ask the more expensive question anyway.
 *
 * A zero result is therefore an expected, honest outcome here rather than a
 * failure — the same coverage precondition the family badge applies (§8.2).
 */
export const sayariTraversalUbo = defineEndpoint({
  source: 'sayari',
  endpoint: 'traversal.ubo',
  bucket: 'traversal',
  timeoutMs: SAYARI_SLOW_MS,
  defaults: { limit: 50 },
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps) => {
    const { id, ...rest } = params;
    const client = getSayariClient(deps.credentials);
    return viaSdkWithRawFallback(
      () => client.traversal.ubo(String(id), rest as never, requestOptions(deps)),
      () => ({
        path: `/v1/ubo/${encodeURIComponent(String(id))}`,
        query: downstreamQuery(rest),
      }),
      deps,
    );
  },
  projection: traversalSchema,
} as EndpointDef<TraversalWalkParams, z.infer<typeof traversalSchema>>);

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
      () => ({
        path: `/v1/traversal/${encodeURIComponent(String(id))}`,
        query: downstreamQuery(rest),
      }),
      deps,
    );
  },
  projection: traversalSchema,
} as EndpointDef<TraversalWalkParams, z.infer<typeof traversalSchema>>);

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
} as EndpointDef<
  { name: string; country?: string; pageSize?: number },
  z.infer<typeof gleifManySchema>
>);

/**
 * The roster is ISO3 and GLEIF is ISO2.
 *
 * This used to be an eleven-entry table of the roster's own origins, argued for
 * on the grounds that a partial table returning `undefined` is safer than a full
 * one nobody checks — `undefined` drops the filter rather than sending a code
 * that silently matches nothing. That argument was about *this* call, and it
 * still holds for it. It stopped being enough once the LEI witness and
 * `name_cover` needed the same mapping to tell a subsidiary from its parent
 * (`src/domain/iso3166.ts`), and two copies of a country table is one more than
 * anything should have. The failure behaviour here is unchanged: an unreadable
 * value still returns `undefined` and still drops the filter.
 */
export function iso3ToIso2(iso3: string | undefined): string | undefined {
  if (!iso3) return undefined;
  if (iso3.length === 2) return alpha2ToAlpha3(iso3) ? iso3.toUpperCase() : undefined;
  return alpha3ToAlpha2(iso3);
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
} as EndpointDef<
  { country: string; indicator: string; mrnev?: number; format?: string },
  z.infer<typeof worldBankSchema>
>);

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
  sayariEntitySummary,
  sayariGetRecord,
  sayariResolve,
  sayariSearchEntity,
  sayariTraversalOwnership,
  sayariTraversalUbo,
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
