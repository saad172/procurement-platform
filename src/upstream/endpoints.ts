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
  shipmentSearchSchema,
  shortestPathSchema,
  tradeSearchSchema,
  traversalSchema,
  upstreamTradeTraversalSchema,
} from './projections/sayari';
import type { DispatchDeps, EndpointDef, UpstreamVia } from './types';

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

/**
 * `flat`, plus what an array-valued param needs for `params_hash` to be a
 * fact about the WIRE REQUEST rather than about how a caller happened to
 * build it (N5). Two calls that ask for the identical set of relationship
 * types — `['a','b']` and `['b','a']` — are the identical request, and an
 * omitted param and an explicit empty array both ask for nothing filtered;
 * neither distinction should split one cache entry into two. Applied only
 * to `getEntity` and the three traversal rows, the endpoints whose params
 * can carry an array at all — every OTHER endpoint's `flat(p)` is untouched,
 * and so is every `params_hash` already recorded, since none of today's
 * calls sends an array to begin with.
 */
const flatSorted = (params: Record<string, unknown>): Record<string, unknown> => {
  const withoutEmptyArrays = Object.entries(params).filter(
    ([, v]) => !(Array.isArray(v) && v.length === 0),
  );
  const sorted = withoutEmptyArrays.map(
    ([k, v]) => [k, Array.isArray(v) ? [...v].sort() : v] as const,
  );
  return flat(Object.fromEntries(sorted));
};

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
 *
 * **Not every sibling of `GetEntity`'s own request type is named here** (N7):
 * the SDK also declares a `*Next`/`*Prev` cursor pair per attribute
 * (`attributesAddressNext`, `attributesNamePrev`, …), plus
 * `relationshipsNext`/`Prev`, `possiblySameAsNext`/`Prev` and
 * `referencedByNext`/`Prev` — pagination through a single attribute or
 * relationship block past its own limit, which nothing in this app asks for
 * yet. Left out rather than guessed at; add them here, the same way, the day
 * something does.
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
export function getEntityQuery(
  rest: Omit<{ id: string } & Partial<typeof GET_ENTITY_LIMITS> & GetEntityRelationshipParams, 'id'>,
) {
  return {
    'attributes.additional_information.limit': rest.attributesAdditionalInformationLimit,
    'attributes.address.limit': rest.attributesAddressLimit,
    'attributes.business_purpose.limit': rest.attributesBusinessPurposeLimit,
    'attributes.company_type.limit': rest.attributesCompanyTypeLimit,
    'attributes.country.limit': rest.attributesCountryLimit,
    'attributes.identifier.limit': rest.attributesIdentifierLimit,
    'attributes.name.limit': rest.attributesNameLimit,
    'attributes.status.limit': rest.attributesStatusLimit,
    'relationships.limit': rest.relationshipsLimit,
    'relationships.type': rest.relationshipsType,
    'relationships.sort': rest.relationshipsSort,
    'relationships.startDate': rest.relationshipsStartDate,
    'relationships.endDate': rest.relationshipsEndDate,
    'relationships.minShares': rest.relationshipsMinShares,
    'relationships.country': rest.relationshipsCountry,
    'relationships.arrivalCountry': rest.relationshipsArrivalCountry,
    'relationships.arrivalState': rest.relationshipsArrivalState,
    'relationships.arrivalCity': rest.relationshipsArrivalCity,
    'relationships.departureCountry': rest.relationshipsDepartureCountry,
    'relationships.departureState': rest.relationshipsDepartureState,
    'relationships.departureCity': rest.relationshipsDepartureCity,
    'relationships.partnerName': rest.relationshipsPartnerName,
    'relationships.partnerRisk': rest.relationshipsPartnerRisk,
    'relationships.hsCode': rest.relationshipsHsCode,
    'possibly_same_as.limit': rest.possiblySameAsLimit,
    'referenced_by.limit': rest.referencedByLimit,
  };
}

export const sayariGetEntity = defineEndpoint({
  source: 'sayari',
  endpoint: 'entity.getEntity',
  bucket: 'entity',
  timeoutMs: SAYARI_FAST_MS,
  defaults: GET_ENTITY_LIMITS,
  normalizeParams: (p) => flatSorted(p),
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
 * **`bucket: 'entity_summary'`** (N6). The SDK's own `UsageInfo` TS type
 * names only six buckets, but the repo's recorded LIVE `info.getUsage()`
 * response (`docs/research/sayari-node-sdk.md` §6, `docs/research/news.md`)
 * shows a real seventh counter — `"entity_summary":3`, moving independently
 * of `entity` — and its own doc comment there says so too: *"a cheaper
 * variant, metered separately (`entity_summary`)"*.
 */
export const sayariEntitySummary = defineEndpoint({
  source: 'sayari',
  endpoint: 'entity.entitySummary',
  bucket: 'entity_summary',
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

/**
 * `limit`/`offset` are QUERY parameters on every POST search endpoint this
 * table calls raw, never body fields — `trade.searchSuppliers` and
 * `search.searchEntity` both destructure `{ limit, offset }` out of the
 * request before building `_queryParams`, sending everything else as the
 * JSON body (`node_modules/@sayari/sdk/dist/api/resources/trade/client/
 * Client.js` ~205-225, `.../search/client/Client.js` ~92-108). The raw
 * fallback used to put both in `body`, where the server silently ignores
 * them and answers with its own default window instead — the same class of
 * bug BUILD-NOTES 31 already named for `getEntity`'s raw path, and the one
 * that would have swallowed the trade search's own new `offset` (finding
 * 155's follow-up).
 */
export function limitOffsetQuery(params: {
  limit?: number | undefined;
  offset?: number | undefined;
}): { limit: number | undefined; offset: number | undefined } {
  return { limit: params.limit, offset: params.offset };
}

export const sayariSearchEntity = defineEndpoint({
  source: 'sayari',
  endpoint: 'search.searchEntity',
  bucket: 'search',
  timeoutMs: SAYARI_FAST_MS,
  defaults: { limit: 10 },
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps) => {
    const client = getSayariClient(deps.credentials);
    // `limit`/`offset` split out for the raw fallback's query string; the SDK
    // call still gets the whole `params` object, because the SDK does this
    // same split internally.
    const { limit, offset, ...body } = params;
    return viaSdkWithRawFallback(
      () => client.search.searchEntity(params as never, requestOptions(deps)),
      () => ({
        path: '/v1/search/entity',
        method: 'POST' as const,
        query: limitOffsetQuery({ limit: limit as number | undefined, offset: offset as number | undefined }),
        body,
      }),
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
  normalizeParams: (p) => flatSorted(p),
  dispatch: async (params, deps) => {
    const { id, ...rest } = params;
    const client = getSayariClient(deps.credentials);
    // `ownership` is `/v1/downstream/{id}` in the SDK — which is itself the
    // clearest statement that the Corporate family read is downward-only.
    return dispatchTraversalWalk(
      `/v1/downstream/${encodeURIComponent(String(id))}`,
      () => client.traversal.ownership(String(id), rest as never, requestOptions(deps)),
      rest,
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
 *
 * **`types`/`excludeFormerRelationships` added (N7); `includeUnknownShares`
 * and the dozen `reputationalRisk*`/single-flag risk fields
 * (`euHighRiskThird`, `stateOwned`, `formerlySanctioned`,
 * `regulatoryAction`, `lawEnforcementAction`, `xinjiangGeospatial`, …) are
 * left out** — nothing in this app filters on them yet, and `riskCategories`
 * already covers the general case. Add one here, the same way, the day
 * something needs it.
 */
export type TraversalWalkParams = {
  id: string;
  limit?: number;
  offset?: number;
  minDepth?: number;
  maxDepth?: number;
  relationships?: string[];
  /** Filters paths to those ending at an entity of one of these types. */
  types?: string[];
  riskCategories?: string[];
  countries?: string[];
  minShares?: number;
  excludeClosedEntities?: boolean;
  /** Excludes relationships valid in the past but not at present. */
  excludeFormerRelationships?: boolean;
  sanctioned?: boolean;
  pep?: boolean;
  psa?: boolean;
};

/**
 * The raw fallback's query string for all four traversal rows (ticket 01
 * item B, corrected 03f), named the way the SDK's own client names it —
 * copied from `node_modules/@sayari/sdk/api/resources/traversal/client/
 * Client.js`, the `_queryParams[...]` assignments shared by `ownership`,
 * `ubo`, `watchlist` and `traversal`. `min_depth`/`max_depth`, snake_case,
 * against the camelCase the SDK takes: a fallback that sent `maxDepth` would
 * be answered at the server's default depth without complaint, which is the
 * silent-wrong-key failure mode `trade.searchSuppliers` already cost this
 * build once (BUILD-NOTES 31).
 *
 * Three different encodings for three different new fields:
 * - `relationships`/`countries` go through as **arrays**, sent repeated —
 *   `qs.stringify(params, { arrayFormat: 'repeat' })`
 *   (`core/fetcher/createRequestUrl.js`), which `rawFetch` now knows how to
 *   send (`dispatchers/sayari.ts`).
 * - `risk_categories` **used to** mirror the SDK's own branch (C5) —
 *   `typeof mapped === "string" ? mapped : toJson(mapped)`, one
 *   JSON-stringified param for an array — on the stated reasoning that
 *   copying the SDK's own encoding byte-for-byte was the safe default. That
 *   reasoning was wrong, not because the copy was inaccurate, but because the
 *   thing it copied is itself broken: live-verified 2026-09-03 against
 *   `/v1/downstream/{id}` with a real entity, `risk_categories=` set to a
 *   JSON-stringified array — one element or three, no difference —
 *   comes back `422 "Invalid risk category '[\"sanctions\"]'. Expected one
 *   of forced_labor, export_controls, …"`; the same values sent as *repeated*
 *   `risk_categories=` keys come back `200`. Sayari's API wants
 *   `risk_categories` encoded exactly like `relationships`/`countries` — one
 *   key per value — and every one of the SDK's four traversal-shaped methods
 *   (`ownership`, `ubo`, `watchlist`, plain `traversal`) instead collapses a
 *   populated array into that single JSON string before it ever reaches
 *   `qs.stringify`, defeating the repeat-array encoding `qs` would otherwise
 *   have produced. That is a genuine SDK defect, not a usage mistake on this
 *   app's side, and there is no `RequestOptions` escape hatch on the SDK's
 *   `Traversal` client to override just this one query param (checked
 *   `Client.d.ts`) — so `dispatchTraversalWalk`, below, now sends a populated
 *   `riskCategories` through this raw path *unconditionally*, never through
 *   the SDK at all, rather than trying to talk the SDK into the right wire
 *   format. Accordingly this branch passes the array straight through
 *   (`encodeQuery` in `dispatchers/sayari.ts` already repeats an array
 *   value) instead of JSON-stringifying it. The bare-string branch stays: a
 *   single custom, non-enum category as a plain string is the one shape the
 *   SDK's own branch gets right (it never re-encodes a value that was
 *   already a string), and `TraversalWalkParams.riskCategories` being
 *   `string[]`-only means nothing in this app sends it today — defensive
 *   rather than reachable, same as before.
 * - `min_shares`/`exclude_closed_entities`/`sanctioned`/`pep`/`psa` are plain
 *   scalars, `.toString()`'d by the SDK the same way `rawFetch` stringifies
 *   any scalar.
 */
export function downstreamQuery(rest: Omit<TraversalWalkParams, 'id'>) {
  return {
    limit: rest.limit,
    offset: rest.offset,
    min_depth: rest.minDepth,
    max_depth: rest.maxDepth,
    relationships: rest.relationships,
    types: rest.types,
    countries: rest.countries,
    min_shares: rest.minShares,
    exclude_closed_entities: rest.excludeClosedEntities,
    exclude_former_relationships: rest.excludeFormerRelationships,
    sanctioned: rest.sanctioned,
    pep: rest.pep,
    psa: rest.psa,
    // `TraversalWalkParams.riskCategories` is `string[]` only, but the runtime
    // check stays: `downstreamQuery` is exported and this is the one place
    // that would notice a caller widening the type later without updating
    // this branch (C5). An array passes through untouched — `encodeQuery`
    // sends it as repeated `risk_categories=` keys, which is what the live
    // API actually wants (03f); it is no longer JSON-stringified.
    risk_categories:
      rest.riskCategories === undefined
        ? undefined
        : typeof (rest.riskCategories as unknown) === 'string'
          ? (rest.riskCategories as unknown as string)
          : rest.riskCategories,
  };
}

/**
 * Whether `rest.riskCategories` is a populated array — the one shape the SDK
 * cannot encode correctly on any of the four traversal-shaped methods
 * (`downstreamQuery`'s doc comment above has the live-verified detail).
 *
 * An **empty** array is not "populated": it asks for nothing filtered, same
 * as an omitted `riskCategories`, and the SDK's own `toJson([])` — while
 * still technically the wrong shape — happens to serialize to a value
 * (`risk_categories=%5B%5D`) Sayari has never been observed to reject,
 * because nothing upstream of here sends an empty array in the first place
 * (`flatSorted` drops it before it reaches `params_hash`, and no caller
 * builds `riskCategories: []` on purpose). Restricting the check to a
 * populated array keeps every call that does not touch this field on the
 * SDK's normal path, unchanged.
 */
function hasPopulatedRiskCategories(rest: Omit<TraversalWalkParams, 'id'>): boolean {
  return Array.isArray(rest.riskCategories) && rest.riskCategories.length > 0;
}

/**
 * Shared dispatch for the four traversal-shaped reads (`ownership`, `ubo`,
 * `watchlist`, `traversal`): SDK-first with a raw-fetch fallback on a parse
 * failure — **except** when `riskCategories` is populated, in which case the
 * raw request runs unconditionally and the SDK is never called at all.
 *
 * Why the existing exception-based fallback (`viaSdkWithRawFallback`) cannot
 * be trusted to catch this on its own: it only fires on the SDK's own
 * `ParseError` (`isParseError`, `dispatchers/sayari.ts`) — a response it
 * could not read. This bug is the opposite shape. The SDK builds a genuinely
 * malformed *request* and sends it; Sayari reads it fine and answers with a
 * clean `422` and a `messages` array explaining exactly what was wrong. That
 * is not a `ParseError` — it is a well-formed API response describing our
 * mistake — so `viaSdkWithRawFallback` would let it through, and the
 * malformed request would go out, and fail the same way, on *every* call
 * that ever populates `riskCategories`, forever. A `dispatch` that "adds a
 * fallback" without addressing this would look fixed in review and stay
 * broken live — the fallback has to run *instead of* the SDK for this field,
 * not *after* it.
 */
async function dispatchTraversalWalk(
  path: string,
  sdkCall: () => Promise<unknown>,
  rest: Omit<TraversalWalkParams, 'id'>,
  deps: DispatchDeps,
): Promise<{ body: unknown; via: UpstreamVia }> {
  const query = downstreamQuery(rest);
  if (hasPopulatedRiskCategories(rest)) {
    return { body: await rawFetch({ path, query }, deps), via: 'raw' };
  }
  return viaSdkWithRawFallback(sdkCall, () => ({ path, query }), deps);
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
  normalizeParams: (p) => flatSorted(p),
  dispatch: async (params, deps) => {
    const { id, ...rest } = params;
    const client = getSayariClient(deps.credentials);
    return dispatchTraversalWalk(
      `/v1/ubo/${encodeURIComponent(String(id))}`,
      () => client.traversal.ubo(String(id), rest as never, requestOptions(deps)),
      rest,
      deps,
    );
  },
  projection: traversalSchema,
} as EndpointDef<TraversalWalkParams, z.infer<typeof traversalSchema>>);

/**
 * Paths to Listed entities, in either direction (network spec §4.1).
 *
 * `watchlist` is `/v1/watchlist/{id}` in the SDK and takes the same
 * parameter set as `ownership`/`ubo` — `Watchlist.d.ts`'s fields are the same
 * superset `TraversalWalkParams` already names (verified against
 * `node_modules/@sayari/sdk/api/resources/traversal/client/requests/
 * Watchlist.d.ts`) — so this shares `downstreamQuery` and the same lenient
 * `traversalSchema` projection with the other two traversal rows rather than
 * inventing a fourth shape.
 *
 * The automatic read (network spec §4.1) sends `maxDepth: 4`, `psa: true`,
 * `limit: 50` and no `relationships` at all, so it walks the endpoint's own
 * default 31 relationship types spanning ownership, control and trade — unlike
 * the Corporate family read, which narrows `ownership` to five ownership types
 * explicitly. A terminal here carries its `risk` block inline, exactly like an
 * ownership/ubo terminal, which is what lets a Listed entity's risk be read off
 * the stored Path without a second call.
 */
export const sayariTraversalWatchlist = defineEndpoint({
  source: 'sayari',
  endpoint: 'traversal.watchlist',
  bucket: 'traversal',
  timeoutMs: SAYARI_SLOW_MS,
  defaults: { limit: 50 },
  normalizeParams: (p) => flatSorted(p),
  dispatch: async (params, deps) => {
    const { id, ...rest } = params;
    const client = getSayariClient(deps.credentials);
    return dispatchTraversalWalk(
      `/v1/watchlist/${encodeURIComponent(String(id))}`,
      () => client.traversal.watchlist(String(id), rest as never, requestOptions(deps)),
      rest,
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
  normalizeParams: (p) => flatSorted(p),
  dispatch: async (params, deps) => {
    const { id, ...rest } = params;
    const client = getSayariClient(deps.credentials);
    return dispatchTraversalWalk(
      `/v1/traversal/${encodeURIComponent(String(id))}`,
      () => client.traversal.traversal(String(id), rest as never, requestOptions(deps)),
      rest,
      deps,
    );
  },
  projection: traversalSchema,
} as EndpointDef<TraversalWalkParams, z.infer<typeof traversalSchema>>);

/**
 * `entities: [source, target]` — the two-entity walk Concentration runs at
 * submission (network spec §4.2, §7; ticket 04) and `sayari_shortest_path`
 * exposes on demand: at most three calls per Recommendation, the award
 * against each other Pick.
 *
 * **Deliberately not routed through `dispatchTraversalWalk`/`downstreamQuery`
 * above.** That machinery exists specifically for the `riskCategories`
 * JSON-stringify defect the other four traversal-shaped methods share
 * (`ownership`, `ubo`, `watchlist`, `traversal` — BUILD-NOTES 31,
 * `downstreamQuery`'s doc comment above), and `shortestPath` shares neither
 * the defect nor `TraversalWalkParams`'s wider parameter set: it takes exactly
 * one param, `entities`, and no `id`.
 *
 * Verified against the SDK source
 * (`node_modules/@sayari/sdk/api/resources/traversal/client/Client.js`,
 * `shortestPath`): unlike the four methods above, a populated `entities`
 * array is kept as a genuine array all the way to
 * `qs.stringify(_queryParams, { arrayFormat: 'repeat' })` — there is no
 * `toJson()`/JSON-stringify branch on this method at all — so there is no
 * mis-encoding bug to route around here. That is why this dispatches through
 * the ordinary `viaSdkWithRawFallback` (parse-error-triggered fallback only),
 * the same pattern `sayariNegativeNews`/`sayariSearchEntity` below use,
 * rather than the unconditional-raw branch `dispatchTraversalWalk` needs.
 *
 * GET `/v1/shortest_path`, one query param, `entities`, sent **repeated**
 * (`entities=<source>&entities=<target>`) on both the SDK and the raw-fallback
 * paths — the raw fallback's query string is built explicitly here, per this
 * file's own rule that every raw fallback carries its query string (network
 * spec §4, BUILD-NOTES 31).
 *
 * `normalizeParams` does **not** sort `entities` the way `flatSorted` sorts
 * `relationships`/`countries` on the four traversal rows above: order here is
 * meaningful — `entities[0]` is the source, `entities[1]` the target — not
 * incidental to how a caller happened to build the array, so two calls with
 * the pair in different orders are correctly two different `params_hash`
 * entries, not one.
 */
export type ShortestPathParams = { entities: string[] };

export const sayariTraversalShortestPath = defineEndpoint({
  source: 'sayari',
  endpoint: 'traversal.shortestPath',
  bucket: 'traversal',
  timeoutMs: SAYARI_SLOW_MS,
  defaults: {},
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps) => {
    const client = getSayariClient(deps.credentials);
    return viaSdkWithRawFallback(
      () => client.traversal.shortestPath({ entities: params.entities }, requestOptions(deps)),
      () => ({ path: '/v1/shortest_path', query: { entities: params.entities } }),
      deps,
    );
  },
  projection: shortestPathSchema,
} as EndpointDef<ShortestPathParams, z.infer<typeof shortestPathSchema>>);

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

/**
 * Discover's mechanism: who ships this HS line into these territories
 * (`hsCodes`/`arrivalCountries`) — **and, widened here for network spec
 * §4.3's per-Profile footprint read (ticket 05), `filter.supplierId`**: the
 * trade Job's first call, `filter.supplierId: [id]`, `limit: 1`, for the HS
 * facet and shipment count stored on `trade_footprint`.
 *
 * One endpoint row with more of its parameters named, not a second row aimed
 * at the same URL — this file's own established rule, stated on
 * `sayariTraversalOwnership`'s widened-params comment above and repeated on
 * `TraversalWalkParams`'s own doc comment: a second row for the identical
 * call would give it two cache keyspaces and two usage-row endpoint names for
 * what is, on the wire, the same `POST /v1/trade/search/suppliers`.
 * `supplierId` sits in `filter` beside `hsCode`/`arrivalCountry` exactly the
 * way the SDK's own `TradeFilterList` declares it (verified against
 * `node_modules/@sayari/sdk/api/resources/trade/types/TradeFilterList.d.ts`:
 * `supplierId?: string[]` — "Exact match against the entity_id of the
 * supplier").
 */
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
     * `filter` carries the HS lines, arrival countries and supplier id;
     * `q` is free text.
     *
     * The keys are **camelCase** — `hsCode`, `arrivalCountry`, `supplierId`.
     * Sent as snake_case they are silently ignored rather than rejected, and
     * the call returns `size.count: 0` with an empty `data` array, which
     * looks exactly like "no company ships this line here". Naming them
     * once, here, is the endpoint table's whole purpose: a caller says what
     * it wants, not how the API spells it.
     */
    // `body`, exactly what the raw fallback also sends — `limit`/`offset`
    // live in the query string on both paths, never in the JSON body.
    const body = {
      ...(params.q ? { q: params.q } : {}),
      filter: {
        ...(params.hsCodes ? { hsCode: params.hsCodes } : {}),
        ...(params.arrivalCountries ? { arrivalCountry: params.arrivalCountries } : {}),
        ...(params.supplierId ? { supplierId: params.supplierId } : {}),
      },
    };
    // The SDK call gets the whole request, `limit`/`offset` included — the
    // SDK does its own identical split before it builds the wire request.
    // `offset` is optional and carries no default, deliberately: a default
    // applied before hashing would change `params_hash` for every existing
    // call that never asks for a page past the first (the same reasoning
    // `sayariTraversalOwnership`'s widened params carry above).
    const request = {
      limit: params.limit,
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
      ...body,
    };
    return viaSdkWithRawFallback(
      () => client.trade.searchSuppliers(request as never, requestOptions(deps)),
      () => ({
        path: '/v1/trade/search/suppliers',
        method: 'POST' as const,
        query: limitOffsetQuery(params),
        body,
      }),
      deps,
    );
  },
  projection: tradeSearchSchema,
} as EndpointDef<
  {
    hsCodes?: string[];
    arrivalCountries?: string[];
    /** network spec §4.3, ticket 05 — the trade Job's per-Profile footprint read. */
    supplierId?: string[];
    q?: string;
    limit?: number;
    /** The SDK's own `SearchSuppliers.offset` — how many rows to skip before
     * this page (BUILD-NOTES finding 155). */
    offset?: number;
  },
  z.infer<typeof tradeSearchSchema>
>);

/**
 * `trade.searchBuyers` (network spec §4.3, ticket 05) — the trade Job's
 * second call: `filter.supplierId: [id]`, `limit: 50`, the customer list
 * with each buyer's risk and country.
 *
 * **Structurally identical to `sayariTradeSearchSuppliers` above** — verified
 * against the SDK: `client.trade.searchBuyers` (`node_modules/@sayari/sdk/
 * api/resources/trade/client/Client.js`) does the same `{limit, offset} =
 * request; _body = rest` split, the same `POST` with `limit`/`offset` in the
 * query string and everything else in the JSON body, against
 * `SearchBuyers.d.ts`'s own `{limit?, offset?, q?, filter?: TradeFilterList,
 * facets?}` — the identical shape `SearchSuppliers.d.ts` declares, both
 * built off the same `TradeFilterList`. No `toJson()`/array-encoding branch
 * on either method (`SearchSuppliers`/`SearchBuyers`'s bodies go through
 * `serializers.*.jsonOrThrow`, not through a query-string encoder at all —
 * `filter.supplierId` is JSON body, not a query param, so the
 * `component`/`risk_categories`-class defect this file routes around
 * elsewhere does not apply here). The response reuses the **same**
 * `tradeSearchSchema` projection `sayariTradeSearchSuppliers` uses: `Sayari.
 * SupplierOrBuyer` (`BuyerSearchResponse.data`) is `EntityDetails & {metadata:
 * SupplierMetadata}`, byte-for-byte the shape `SupplierSearchResponse.data`
 * already is (`SupplierOrBuyer.d.ts` — both response types alias the one
 * interface), so `tradeSearchSchemaInner`'s `entitySchemaInner.extend({
 * metadata: tradeMetadataSchema })` already projects a buyer row correctly
 * without a second schema.
 */
export const sayariTradeSearchBuyers = defineEndpoint({
  source: 'sayari',
  endpoint: 'trade.searchBuyers',
  bucket: 'trade',
  timeoutMs: SAYARI_SLOW_MS,
  defaults: { limit: 100 },
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps) => {
    const client = getSayariClient(deps.credentials);
    const body = {
      ...(params.q ? { q: params.q } : {}),
      filter: {
        ...(params.hsCodes ? { hsCode: params.hsCodes } : {}),
        ...(params.arrivalCountries ? { arrivalCountry: params.arrivalCountries } : {}),
        ...(params.supplierId ? { supplierId: params.supplierId } : {}),
      },
    };
    const request = {
      limit: params.limit,
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
      ...body,
    };
    return viaSdkWithRawFallback(
      () => client.trade.searchBuyers(request as never, requestOptions(deps)),
      () => ({
        path: '/v1/trade/search/buyers',
        method: 'POST' as const,
        query: limitOffsetQuery(params),
        body,
      }),
      deps,
    );
  },
  projection: tradeSearchSchema,
} as EndpointDef<
  {
    hsCodes?: string[];
    arrivalCountries?: string[];
    supplierId?: string[];
    q?: string;
    limit?: number;
    offset?: number;
  },
  z.infer<typeof tradeSearchSchema>
>);

/**
 * `trade.searchShipments` (network spec §4.3, ticket 05) — the trade Job's
 * third call: `filter.supplierId: [id]`, `filter.arrivalDate: <24 months
 * back>|<today>`, `limit: 50`, dated, citable sample rows with buyer,
 * product origin, value, weight and `record`.
 *
 * Same request shape as `searchSuppliers`/`searchBuyers` (verified against
 * `SearchShipments.d.ts`/`Client.js`: the identical `{limit, offset}` /
 * body split, the identical `TradeFilterList`, no array-encoding defect on
 * a JSON body) — but a genuinely **new** response projection,
 * `shipmentSearchSchema` (`projections/sayari.ts`): `Sayari.Shipment`
 * shares nothing with the entity-shaped rows `tradeSearchSchema` projects,
 * so this cannot reuse it the way `sayariTradeSearchBuyers` reuses it above.
 *
 * `arrivalDate` is a single `"<from>|<to>"` range string on the wire
 * (`TradeFilterList.arrivalDate?: string`, e.g. `"2024-01|2024-10"`), not an
 * array — built by the caller (05b), not parsed here.
 */
export const sayariTradeSearchShipments = defineEndpoint({
  source: 'sayari',
  endpoint: 'trade.searchShipments',
  bucket: 'trade',
  timeoutMs: SAYARI_SLOW_MS,
  defaults: { limit: 100 },
  normalizeParams: (p) => flat(p),
  dispatch: async (params, deps) => {
    const client = getSayariClient(deps.credentials);
    const body = {
      ...(params.q ? { q: params.q } : {}),
      filter: {
        ...(params.hsCodes ? { hsCode: params.hsCodes } : {}),
        ...(params.arrivalCountries ? { arrivalCountry: params.arrivalCountries } : {}),
        ...(params.supplierId ? { supplierId: params.supplierId } : {}),
        ...(params.arrivalDate ? { arrivalDate: params.arrivalDate } : {}),
      },
    };
    const request = {
      limit: params.limit,
      ...(params.offset !== undefined ? { offset: params.offset } : {}),
      ...body,
    };
    return viaSdkWithRawFallback(
      () => client.trade.searchShipments(request as never, requestOptions(deps)),
      () => ({
        path: '/v1/trade/search/shipments',
        method: 'POST' as const,
        query: limitOffsetQuery(params),
        body,
      }),
      deps,
    );
  },
  projection: shipmentSearchSchema,
} as EndpointDef<
  {
    hsCodes?: string[];
    arrivalCountries?: string[];
    supplierId?: string[];
    /** `"<from>|<to>"` or a single `"<date>"` — `TradeFilterList.arrivalDate`. */
    arrivalDate?: string;
    q?: string;
    limit?: number;
    offset?: number;
  },
  z.infer<typeof shipmentSearchSchema>
>);

/**
 * `supplyChain.upstreamTradeTraversal` (network spec §4.3, §5, §6; ticket
 * 05) — the trade Job's fourth call, on the raw path unconditionally.
 *
 * **A real, confirmed SDK request-encoding bug, the identical defect class
 * `dispatchTraversalWalk`/`downstreamQuery` already document and route
 * around for `traversal.ownership`/`ubo`/`watchlist`/`traversal`'s
 * `riskCategories`.** Verified against `node_modules/@sayari/sdk/api/
 * resources/supplyChain/client/Client.js`: its request builder does
 * `_queryParams["component"] = toJson(component)`, the same for `risk` and
 * `countries` — JSON.stringify on every array-shaped filter param, sent as a
 * `GET` query string. A JSON-stringified array gets a `422` the same way a
 * JSON-stringified `risk_categories` does; the same values as repeated query
 * keys get a `200`.
 *
 * `component` (the Category's six-digit HS codes) and `risk`
 * (forced-labour-origin and sanctions stems) are **always populated** for
 * this ticket's call — never optional, per spec §4.3 — so this row dispatches
 * **unconditionally raw**, the same shape `dispatchTraversalWalk`'s own
 * `hasPopulatedRiskCategories`-forces-raw branch takes when it fires, rather
 * than the exception-based `viaSdkWithRawFallback` every other row in this
 * file defaults to: a `422` with a clean `messages` array is not a
 * `ParseError` (`isParseError`, `dispatchers/sayari.ts`), so the SDK path
 * would "succeed" at building and sending a malformed request every time,
 * never triggering the catch-based fallback at all.
 *
 * This is a genuinely different situation from ticket 04's `shortestPath`,
 * which turned out to have **no** such bug (`sayariTraversalShortestPath`'s
 * own doc comment above, live-verified) — the SDK source here confirms this
 * endpoint is not equally safe. It is also a **second, independent** Fern
 * defect from the one already documented for this exact endpoint in
 * `docs/research/sayari-node-sdk.md` (§5, §7 item 2): a client-side
 * `ParseError` on the *response*, `filters.max_depth`/`filters.limit`
 * echoed back as strings against the SDK's own `number` typing. That one
 * *would* have been caught by `viaSdkWithRawFallback`'s ordinary
 * `ParseError` catch — this row bypasses the SDK far enough upstream (before
 * the request is even built) that it never gets the chance to be caught
 * either way, which is correct: routing raw here fixes both problems in one
 * move rather than patching the response-parse one and leaving the
 * request-encoding one live.
 *
 * GET `/v1/supply_chain/upstream/{id}`, query params named the way the SDK's
 * own client names them (verified against the same `Client.js`):
 * `component`, `risk`, `countries`, `min_date`, `max_date`, `max_depth`,
 * `limit` — `component`/`risk`/`countries` sent **repeated**, one key per
 * value (`encodeQuery` in `dispatchers/sayari.ts` already does this for an
 * array), never JSON-stringified. This ticket's own call sends `component`,
 * `risk`, `maxDepth: 2` and `minDate`; `countries` is carried on the param
 * type and the query builder for completeness with the SDK's real surface
 * (the same reasoning `TraversalWalkParams` widens ahead of every field a
 * caller might eventually want, per that type's own doc comment) — nothing
 * in this ticket's own call populates it, and `hasPopulatedTradeTraversalFilter`
 * below still catches it if a future caller does.
 */
export type SupplyChainUpstreamTradeTraversalParams = {
  id: string;
  component?: string[];
  risk?: string[];
  countries?: string[];
  maxDepth?: number;
  minDate?: string;
};

/**
 * The raw fallback's query string, named the way the SDK's own client names
 * it (`min_date`/`max_depth`, snake_case, against the camelCase the SDK
 * takes) — the same silent-wrong-key failure mode `downstreamQuery`'s own
 * doc comment warns about (BUILD-NOTES finding 31) if this ever drifted from
 * `Client.js`'s own `_queryParams[...]` assignments.
 */
export function upstreamTradeTraversalQuery(rest: Omit<SupplyChainUpstreamTradeTraversalParams, 'id'>) {
  return {
    component: rest.component,
    risk: rest.risk,
    countries: rest.countries,
    min_date: rest.minDate,
    max_depth: rest.maxDepth,
  };
}

/**
 * Whether `component`/`risk`/`countries` carries a populated array — the
 * shape the SDK's request builder cannot encode correctly (this endpoint's
 * own doc comment above has the verified detail). Mirrors
 * `hasPopulatedRiskCategories`'s own reasoning: an **empty** array asks for
 * nothing filtered, same as an omitted one, so only a populated array forces
 * the raw path.
 */
function hasPopulatedTradeTraversalFilter(
  rest: Omit<SupplyChainUpstreamTradeTraversalParams, 'id'>,
): boolean {
  return (
    (Array.isArray(rest.component) && rest.component.length > 0) ||
    (Array.isArray(rest.risk) && rest.risk.length > 0) ||
    (Array.isArray(rest.countries) && rest.countries.length > 0)
  );
}

export const sayariSupplyChainUpstreamTradeTraversal = defineEndpoint({
  source: 'sayari',
  // Sayari's own `info.getUsage()` bucket for this endpoint (N6 — see
  // `sayariEntitySummary`'s own `bucket: 'entity_summary'` comment for the
  // precedent): `docs/research/sayari-node-sdk.md` §6 records a live
  // `tradeTraversal` counter, distinct from `traversal` and from this file's
  // own `trade` bucket for the three `trade.search*` rows above.
  bucket: 'tradeTraversal',
  endpoint: 'supplyChain.upstreamTradeTraversal',
  timeoutMs: SAYARI_SLOW_MS,
  defaults: {},
  normalizeParams: (p) => flatSorted(p),
  dispatch: async (params, deps) => {
    const { id, ...rest } = params;
    const path = `/v1/supply_chain/upstream/${encodeURIComponent(String(id))}`;
    const query = upstreamTradeTraversalQuery(rest);
    if (hasPopulatedTradeTraversalFilter(rest)) {
      return { body: await rawFetch({ path, query }, deps), via: 'raw' as const };
    }
    const client = getSayariClient(deps.credentials);
    return viaSdkWithRawFallback(
      () =>
        client.supplyChain.upstreamTradeTraversal(String(id), rest as never, requestOptions(deps)),
      () => ({ path, query }),
      deps,
    );
  },
  projection: upstreamTradeTraversalSchema,
} as EndpointDef<
  SupplyChainUpstreamTradeTraversalParams,
  z.infer<typeof upstreamTradeTraversalSchema>
>);

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
  sayariTraversalWatchlist,
  sayariTraversal,
  sayariTraversalShortestPath,
  sayariNegativeNews,
  sayariTradeSearchSuppliers,
  sayariTradeSearchBuyers,
  sayariTradeSearchShipments,
  sayariSupplyChainUpstreamTradeTraversal,
  sayariMetadataRaw,
  gleifJoinLei,
  gleifSearchByName,
  worldBankIndicator,
  usitcTariff,
  nominatimGeocode,
} as const;
