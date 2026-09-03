import { z } from 'zod';
import { snakeKeys } from './key-case';

/**
 * Our own **lenient** projections of Sayari's payloads (SPEC §16.2).
 *
 * Lenient on purpose, in two directions:
 *
 * - Almost every field is optional, because the projection runs *after* the
 *   cache write. A field we did not anticipate does not fail the call; it is
 *   simply not projected, and widening the schema later re-derives it from the
 *   cached body with no re-spend.
 * - `.catchall`/passthrough is avoided in favour of naming what we read. The
 *   value of this layer is that a caller sees *our* shape, not Sayari's, so the
 *   rest of the app does not silently depend on an SDK field name.
 *
 * The same projection runs on both the SDK and the raw-fetch paths, which is
 * what makes the fallback invisible to every caller — and is why every exported
 * schema here is wrapped in `snakeKeys` first. The SDK deserialises into
 * camelCase and the raw path returns the API's snake_case; see `key-case.ts`
 * for why that difference is dangerous rather than merely annoying.
 */

/** Wraps a schema so it sees one key casing whichever path produced the body. */
const eitherCasing = <T extends z.ZodType>(schema: T) => z.preprocess(snakeKeys, schema);

/**
 * The `properties` bag on an attribute entry — **for every attribute type, not
 * just `address`**, and **open**, because its key space is not ours to close.
 *
 * `value` is the one key that is effectively universal: measured over the local
 * corpus it is present on 1857/1857 `name` entries, 1827/1827 `address`,
 * 3224/3224 `identifier`, 3112/3112 `country`, 779/779 `companyType` and
 * 1943/2078 `businessPurpose`. Everything else is source-specific and often
 * free-form — `additionalInformation` alone contributes keys like
 * `Awarding Sub Agency Name` and `Ausländische Behörde`. An earlier version of
 * this schema was a **closed** object listing only the address fields, so Zod
 * stripped `value`, `code` and `standard` from every non-address attribute and
 * projected `{}`. The named fields below are the ones we actually read; `.loose()`
 * is what keeps the rest from being thrown away.
 *
 * `x`/`y` are lon/lat on a structured address.
 */
const attributeProperties = z
  .object({
    /** Where an attribute's text actually lives. See `attributeText()`. */
    value: z.unknown().nullish(),
    type: z.unknown().nullish(),
    context: z.unknown().nullish(),
    /** `business_purpose` carries an industry code and the standard it is in. */
    code: z.unknown().nullish(),
    standard: z.unknown().nullish(),
    x: z.number().nullish(),
    y: z.number().nullish(),
    city: z.string().nullish(),
    postcode: z.string().nullish(),
    state: z.string().nullish(),
    country: z.string().nullish(),
    house_number: z.string().nullish(),
    street: z.string().nullish(),
  })
  .partial()
  .loose();

/**
 * One attribute entry.
 *
 * **There is no top-level `value` here, and there never was.** Across all 313
 * cached `entity.getEntity` bodies, every entry of every attribute type carries
 * exactly `record`, `sources`, `editable`, `recordCount` and `properties` —
 * 2078 `businessPurpose` entries, 3224 `identifier`, 1857 `name`, and not one
 * `value` among them. The field used to be declared here anyway, and because
 * the projection is lenient it read `undefined` on every entry without ever
 * failing: `businessPurposes` and `aliases` were silently always `[]`.
 *
 * It is deliberately **not** declared any more. Read the text with
 * `attributeText()`; a reader reaching for `.value` should not typecheck.
 */
const attributeValue = z
  .object({
    /** Every attribute carries citable record ids — the Citation's record hop. */
    record: z.array(z.string()).nullish(),
    /** The source hashes behind those records. */
    sources: z.array(z.string()).nullish(),
    /** How many records assert this entry — a weak confidence signal. */
    record_count: z.number().nullish(),
    properties: attributeProperties.nullish(),
  })
  .partial();

/**
 * `next` is a cursor string on most attribute blocks and a bare `false` on
 * the SDK's own documented `entitySummary` example (C2) — the same
 * boolean-cursor shape `traversalSchemaInner.next` already accepts. Without
 * the union, a live `entitySummary` body fails the whole projection in
 * `call()`, and `projection` is not retryable.
 */
const attributeBlock = z
  .object({ data: z.array(attributeValue).nullish(), next: z.union([z.string(), z.boolean()]).nullish() })
  .partial();

/**
 * A risk factor as Sayari reports it.
 *
 * `metadata.country` is how a **country-derived** factor is identified, and
 * that identification is load-bearing: `cpi_score`, `eu_high_risk_third` and
 * `basel_aml` are excluded from Compliance risk because scoring them there
 * would double-count Country resilience (SPEC §9.2).
 *
 * `metadata.traversal_path` is the evidence a compliance sentence cites.
 */
export const riskFactorSchema = z
  .object({
    level: z.string().nullish(),
    value: z.unknown().nullish(),
    metadata: z
      .object({
        country: z.unknown().nullish(),
        traversal_path: z.unknown().nullish(),
      })
      .partial()
      .nullish(),
  })
  .partial();

const entitySchemaInner = z
  .object({
    id: z.string(),
    label: z.string(),
    type: z.string().nullish(),
    entity_url: z.string().nullish(),
    countries: z.array(z.string()).nullish(),
    addresses: z.array(z.string()).nullish(),
    identifiers: z.array(z.unknown()).nullish(),
    sanctioned: z.boolean().nullish(),
    pep: z.boolean().nullish(),
    closed: z.boolean().nullish(),
    company_type: z.string().nullish(),
    registration_date: z.string().nullish(),
    latest_status: z.unknown().nullish(),
    /** An OBJECT keyed by source hash, not a scalar (SPEC §9.2). */
    source_count: z.record(z.string(), z.unknown()).nullish(),
    /** An OBJECT keyed by relation type, not a scalar (SPEC §16.6). */
    relationship_count: z.record(z.string(), z.number()).nullish(),
    psa_count: z.number().nullish(),
    psa_id: z.string().nullish(),
    risk: z.record(z.string(), riskFactorSchema).nullish(),
    attributes: z.record(z.string(), attributeBlock).nullish(),
    relationships: z
      .object({ data: z.array(z.unknown()).nullish(), next: z.string().nullish() })
      .partial()
      .nullish(),
    possibly_same_as: z
      .object({ data: z.array(z.unknown()).nullish() })
      .partial()
      .nullish(),
    trade_count: z.unknown().nullish(),
    degree: z.number().nullish(),
    // Added once here rather than restated on `entitySummarySchemaInner`
    // (Reuse 4): `referenced_by`/`reference_id` are on `entitySummary`'s own
    // documented example body, and `logistics_entity` was declared a third
    // time on `tradeSearchSchemaInner`'s own `.extend()` before this.
    referenced_by: z.unknown().nullish(),
    reference_id: z.string().nullish(),
    logistics_entity: z.boolean().nullish(),
  })
  .partial({ type: true })
  .loose();

/**
 * `entity.entitySummary` — **the same `EntityDetails` shape `getEntity`
 * returns, minus `relationships`** (SPEC §9 renames row 5; ticket 01 item
 * A2; Reuse 4). Derived from `entitySchemaInner` by `.omit()` — the same
 * precedent `tradeSearchSchemaInner = entitySchemaInner.extend(...)` already
 * sets — rather than a second hand-copy of every field.
 *
 * **What it does not carry, in the SDK's own words, stated twice**:
 * "entity_summary returns the same payload minus relationships" (on
 * `getEntity`'s own doc comment) and "The Entity Summary endpoint returns a
 * similar payload, minus relationships" (on `entitySummary`'s own doc
 * comment) — both in `.../entity/client/Client.d.ts`
 * (`node_modules/@sayari/sdk/api/resources/entity/types/
 * EntitySummaryResponse.d.ts`: `interface EntitySummaryResponse extends
 * Sayari.EntityDetails {}`). Nothing else is named as missing, and the SDK's
 * own documented example response for `entitySummary` shows the full
 * `attributes` block present — **including `attributes.address` with the
 * same parsed `properties.city/postcode/country/houseNumber/road/x/y`
 * `getEntity` returns** — plus `possibly_same_as` and `referenced_by`.
 * `toCandidateFacts` (`src/jobs/resolve.ts`) reads exactly the fields
 * `entitySchemaInner` names off `getEntity` today; every one of them
 * survives the swap to `entitySummary` except `relationships`, which is why
 * owner edges are read separately (ticket 01 item B: the typed `getEntity` +
 * `relationshipsType` read, or `traversal.traversal`).
 */
const entitySummarySchemaInner = entitySchemaInner.omit({ relationships: true });

/**
 * One resolution candidate.
 *
 * `match_strength` is the field that proves top-hit acceptance is wrong: row 1
 * of the roster resolves to the divested Syntegon at `weak`. `score` is
 * Sayari's own and is **not comparable between queries**, which is why the
 * auto-accept gate has no ratio margin over the runner-up (SPEC §6.3).
 */
const resolutionCandidateSchemaInner = z
  .object({
    entity_id: z.string(),
    label: z.string().nullish(),
    /**
     * Sayari's own score. **Not comparable between queries** — which is why the
     * auto-accept gate has no ratio margin over the runner-up (SPEC §6.3).
     */
    score: z.number().nullish(),
    /**
     * Arrives as a bare string on the batch endpoint and as `{ value }` on
     * others, so both are accepted and `matchStrengthValue()` reads either.
     * This is the field that proves top-hit acceptance is wrong: row 1 of the
     * roster resolves to the divested Syntegon at `weak`.
     */
    match_strength: z
      .union([z.string(), z.object({ value: z.string().nullish() }).partial().loose()])
      .nullish(),
    match_strength_v2: z.unknown().nullish(),
    matched_queries: z.unknown().nullish(),
    highlight: z.unknown().nullish(),
    explanation: z.record(z.string(), z.unknown()).nullish(),
    profile: z.string().nullish(),
    type: z.string().nullish(),
    countries: z.array(z.string()).nullish(),
    addresses: z.array(z.string()).nullish(),
    identifiers: z.array(z.unknown()).nullish(),
    sources: z.array(z.string()).nullish(),
  })
  .loose();

const resolutionSchemaInner = z
  .object({
    fields: z.unknown().nullish(),
    data: z.array(resolutionCandidateSchemaInner).nullish(),
  })
  .loose();

const searchEntitySchemaInner = z
  .object({
    limit: z.number().nullish(),
    offset: z.number().nullish(),
    size: z
      .object({ count: z.number().nullish(), qualifier: z.string().nullish() })
      .partial()
      .nullish(),
    data: z.array(entitySchemaInner.loose()).nullish(),
  })
  .loose();

const recordSchemaInner = z
  .object({
    id: z.string(),
    source: z.string().nullish(),
    label: z.string().nullish(),
    publication_date: z.string().nullish(),
    acquisition_date: z.string().nullish(),
    document_url: z.string().nullish(),
    references_count: z.number().nullish(),
  })
  .loose();

/**
 * One entry of `attributes.shares` on a traversal-path relationship record —
 * measured off `tests/fixtures/traverse/yazaki.json` and `tests/fixtures/
 * enrich/yazaki.json`: an **open bag**, like `attributeProperties` above.
 * `currency`/`percentage`/`monetary_value`/`num_shares`/`type`/`from_date`/
 * `to_date`/`date` are the named fields ticket 01 item C's `ownersOf` and the
 * Entity page read; the rest — `Denominator`, `Numerator`, `"Share Type"`,
 * `"Share Value"`, `"Summary Text"`, `liSubConAm` among them, all measured on
 * the same two fixtures — are source-specific and kept only because
 * `.loose()` keeps them, never read by name.
 */
const traversalShareSchema = z
  .object({
    currency: z.string().nullish(),
    percentage: z.number().nullish(),
    monetary_value: z.number().nullish(),
    num_shares: z.number().nullish(),
    type: z.string().nullish(),
    from_date: z.string().nullish(),
    to_date: z.string().nullish(),
    date: z.string().nullish(),
  })
  .partial()
  .loose();

/**
 * One edge record inside a `path[].relationships[type].values[]` entry — one
 * per Sayari `entity_relationship` record between the same two path nodes.
 * **`record` is a single id, always** — measured 2,578/2,578 values across
 * both fixtures, never an array — unlike `attributeValue.record` above, which
 * is Sayari's *other*, array-valued sense of the word, for an attribute
 * entry rather than a relationship edge.
 */
const traversalRelationshipValueSchema = z
  .object({
    former: z.boolean().nullish(),
    record: z.string().nullish(),
    from_date: z.string().nullish(),
    to_date: z.string().nullish(),
    acquisition_date: z.string().nullish(),
    publication_date: z.string().nullish(),
    relationship_status: z.string().nullish(),
    attributes: z
      .object({ shares: z.array(traversalShareSchema).nullish() })
      .partial()
      .loose()
      .nullish(),
  })
  .loose();

/**
 * One `path[].relationships` value: everything Sayari knows about every edge
 * of **one relationship type** between the same two path nodes — a rollup
 * (`former`, `start_date`, `end_date`, `relationship_status`, the
 * `most_recent_*` fields) alongside `values`, one entry per record. The outer
 * object this hangs off is keyed by relationship type, which is why the type
 * name is not a field here — see `traversalPathRelationshipsSchema` below.
 */
const traversalRelationshipGroupSchema = z
  .object({
    former: z.boolean().nullish(),
    start_date: z.string().nullish(),
    end_date: z.string().nullish(),
    last_observed: z.string().nullish(),
    relationship_status: z.string().nullish(),
    most_recent_percentage: z.number().nullish(),
    most_recent_monetary_value: z.number().nullish(),
    most_recent_num_shares: z.number().nullish(),
    values: z.array(traversalRelationshipValueSchema).nullish(),
  })
  .loose();

/**
 * `path[].relationships` itself (SPEC §4; ticket 01 item E). **Keyed by
 * relationship type, not an array** — measured on `tests/fixtures/traverse/
 * yazaki.json` and `tests/fixtures/enrich/yazaki.json`, where the same
 * per-type shape appears under `shareholder_of`, `has_shareholder`,
 * `has_subsidiary`, `has_branch`, `beneficial_owner_of`, `linked_to` and
 * `possibly_same_as`. Named and lenient rather than `z.unknown()`, so ticket
 * 02 can read the relationship type (the key), `attributes.shares`,
 * `start_date`/`end_date`, `former` and every edge's `record` id off a
 * stored Path without a second trip to the raw body.
 *
 * **Lenient beyond the record shape itself** (N1). The SDK's own
 * `TraversalPath` serializer types this as `record(Relationships,
 * TraversalRelationshipData.optional())` — the group value is optional, and
 * only one company's two fixtures had ever proven the record shape at all —
 * so `relationships: []`, `null`, or `{ shareholder_of: null }` all failed
 * this projection with `invalid_type` before this fix. A projection failure
 * fires on a cache HIT too (`call.ts`) and `projection` is not retryable, so
 * this is the one shape in the whole traversal schema most worth being
 * generous about.
 */
const traversalPathRelationshipsSchema = z
  .union([z.record(z.string(), traversalRelationshipGroupSchema.nullish()), z.array(z.unknown())])
  .nullish();

/**
 * A traversal path. The **terminal entity carries its full `risk` block
 * inline**, which is the measurement that made the Corporate family cost one
 * call rather than 25 (SPEC §8.1).
 */
const traversalPathSchemaInner = z
  .object({
    path: z
      .array(
        z
          .object({
            field: z.string().nullish(),
            entity: z.union([z.string(), entitySchemaInner.loose()]).nullish(),
            relationships: traversalPathRelationshipsSchema,
          })
          .loose(),
      )
      .nullish(),
    source: z.union([z.string(), entitySchemaInner.loose()]).nullish(),
    /**
     * **Measured, not assumed:** `target` is a full entity with its `risk`
     * block inline, not an id. That is the fact that made the Corporate family
     * cost one call rather than 25 — every path terminal arrives complete, so
     * the family read never has to fan out into 50 `getEntity` calls.
     */
    target: z.union([z.string(), entitySchemaInner.loose()]).nullish(),
  })
  .loose();

/**
 * The traversal envelope — **the coverage half of a traversal, and it is not
 * decoration** (SPEC §8.2, §8.5).
 *
 * `explored_count` is the size of the graph subset the API searched, and
 * `partial_results` is the API saying whether it finished searching it. Those
 * two are what let the app write *"50 of 5 047 explored"* rather than *"50
 * members"*, which is the difference between a coverage claim and a row count
 * — and an absent member proves nothing under either.
 *
 * `next`, `offset` and `limit` are the cursor. `next` is a **boolean** on the
 * live API rather than a cursor string (BUILD-NOTES finding 6), so a caller
 * pages by advancing `offset` itself; the union keeps a string form readable
 * if the API ever grows one. `min_depth` and `max_depth` come back echoed, so a
 * stored body says how deep the walk it recorded actually went rather than
 * leaving that to the request params alone — the Corporate family read sends
 * no depth at all and the server answers at its own default of 4.
 */
const traversalSchemaInner = z
  .object({
    data: z.array(traversalPathSchemaInner).nullish(),
    /** A boolean here, not a cursor string — measured against the live API. */
    next: z.union([z.boolean(), z.string()]).nullish(),
    offset: z.number().nullish(),
    limit: z.number().nullish(),
    min_depth: z.number().nullish(),
    max_depth: z.number().nullish(),
    /** How many nodes the API visited — the *m* in "n of m explored". */
    explored_count: z.number().nullish(),
    /**
     * True when the API itself stopped short of searching the whole subgraph,
     * in which case `explored_count` bounds nothing and the reachable set is
     * unknown rather than large.
     */
    partial_results: z.boolean().nullish(),
  })
  .loose();

/**
 * `traversal.shortestPath` (network spec §4.2, §7; ticket 04) — the two-entity
 * walk Concentration runs at submission and `sayari_shortest_path` exposes on
 * demand.
 *
 * `data` holds **0 or 1** entries, never more, since `entities` is always
 * exactly two ids. Each entry is structurally identical to a traversal Path —
 * `ShortestPathData` in `node_modules/@sayari/sdk/api/resources/traversal/
 * types/ShortestPathData.d.ts` types it `{ source: string; target:
 * EntityDetails; path: TraversalPath[] }`, the same `{path, source, target}`
 * shape `traversalPathSchemaInner` already projects — so this reuses that
 * inner schema rather than inventing a fourth one; `target` arriving as a full
 * entity rather than a bare id is exactly what `traversalPathSchemaInner`'s
 * `z.union([z.string(), entitySchemaInner.loose()])` on `target` already
 * accepts.
 *
 * **No `explored_count`/`partial_results`/`next`/`offset`/`limit`** here,
 * unlike `traversalSchemaInner` above — verified against
 * `ShortestPathResponse.d.ts`, which types the envelope as just `{ entities:
 * string[]; data: ShortestPathData[] }`. A targeted two-entity query has no
 * "subgraph explored" concept to report. The caller that writes a `graph_path`
 * row for a Path of kind `shortest_path` hardcodes its coverage fields rather
 * than reading them off this envelope.
 */
const shortestPathSchemaInner = z
  .object({
    entities: z.array(z.string()).nullish(),
    data: z.array(traversalPathSchemaInner).nullish(),
  })
  .loose();

/**
 * `negativeNews` takes a **bare name**, so disambiguation is ours — the input
 * is always the resolved legal name (SPEC §7.1).
 */
const negativeNewsArticle = z
  .object({
    title: z.string().nullish(),
    source: z.string().nullish(),
    url: z.string().nullish(),
    snippet: z.string().nullish(),
    published: z.string().nullish(),
    /**
     * Sayari's own flags, e.g. "Human Rights", "Labor Dispute", "Law
     * Enforcement or Regulatory Action". These are what the Media signal
     * Criterion weights — a raw article count would let nine unflagged mentions
     * of a common trade name outweigh one flagged report.
     */
    risk_flags: z.union([z.array(z.string()), z.record(z.string(), z.unknown())]).nullish(),
    search_term: z.unknown().nullish(),
  })
  .loose();

/**
 * **Measured: the endpoint returns a BARE ARRAY**, not `{ data: [...] }` as
 * every other Sayari endpoint does. Both shapes are accepted and normalised, so
 * callers see one thing.
 */
const negativeNewsSchemaInner = z
  .union([
    z.array(negativeNewsArticle),
    z.object({ data: z.array(negativeNewsArticle).nullish() }).loose(),
  ])
  .transform((value) => (Array.isArray(value) ? { data: value } : value));

/** Trade counterparties — Discover's mechanism (SPEC §11). */
/**
 * `trade.searchSuppliers` — **each `data` row is a full entity**, not a
 * `{ entity, shipments }` wrapper.
 *
 * The trade-specific figures hang off `metadata`, and the entity fields
 * (`risk`, `psa_count`, `addresses`) sit at the top level exactly as
 * `entitySchemaInner` describes them. Extending that schema rather than
 * restating it is what keeps a lead and a roster row the same shape.
 *
 * This was measured after a projection written for the wrapper shape "passed"
 * on every row and produced nothing: every field in it was `nullish()`, so a
 * shape mismatch reads as a page of `undefined` rather than as an error — the
 * same failure mode key-casing has (see `key-case.ts`), one level up. The
 * three fields below are therefore **required**, so the next shape change is a
 * loud projection error instead of a silently empty result set.
 */
const tradeMetadataSchema = z
  .object({
    shipments: z.number(),
    /** Absent on some rows: a displayed column, never a filter. */
    latest_shipment_date: z.string().nullish(),
    /** `key` is the six-digit line, `doc_count` its shipment count. */
    hs_codes: z
      .array(
        z
          .object({
            key: z.string().nullish(),
            value: z.string().nullish(),
            doc_count: z.number().nullish(),
          })
          .loose(),
      )
      .nullish(),
  })
  .loose();

const tradeSearchSchemaInner = z
  .object({
    data: z
      .array(
        // `logistics_entity` — Sayari's own forwarder flag (SPEC §11.1
        // measured 9 in the top 25 by shipments; it is why the job can
        // classify without guessing from the label) — is on
        // `entitySchemaInner` itself now (Reuse 4), not restated here.
        entitySchemaInner.extend({ metadata: tradeMetadataSchema }),
      )
      .nullish(),
    size: z
      .object({ count: z.number().nullish(), qualifier: z.string().nullish() })
      .partial()
      .loose()
      .nullish(),
    /** A boolean here, like `traversal`. Measured, not assumed. */
    next: z.union([z.boolean(), z.string()]).nullish(),
    limit: z.number().nullish(),
    offset: z.number().nullish(),
  })
  .loose();

export type SayariTradeRow = z.infer<typeof tradeSearchSchemaInner>['data'] extends
  | (infer R)[]
  | null
  | undefined
  ? R
  : never;

// ── Exported projections ─────────────────────────────────────────────────────
// Each is wrapped so it accepts either key casing (see `key-case.ts`).

export const entitySchema = eitherCasing(entitySchemaInner);
export const entitySummarySchema = eitherCasing(entitySummarySchemaInner);
export const resolutionCandidateSchema = eitherCasing(resolutionCandidateSchemaInner);
export const resolutionSchema = eitherCasing(resolutionSchemaInner);
export const searchEntitySchema = eitherCasing(searchEntitySchemaInner);
export const recordSchema = eitherCasing(recordSchemaInner);
export const traversalPathSchema = eitherCasing(traversalPathSchemaInner);
export const traversalSchema = eitherCasing(traversalSchemaInner);
export const shortestPathSchema = eitherCasing(shortestPathSchemaInner);
export const negativeNewsSchema = eitherCasing(negativeNewsSchemaInner);
export const tradeSearchSchema = eitherCasing(tradeSearchSchemaInner);

/** The projected entity shape, as every caller in the app sees it. */
export type SayariEntity = z.infer<typeof entitySchemaInner>;
/** The projected `entitySummary` shape — see `entitySummarySchemaInner`'s doc comment for what it lacks. */
export type SayariEntitySummary = z.infer<typeof entitySummarySchemaInner>;
export type SayariResolutionCandidate = z.infer<typeof resolutionCandidateSchemaInner>;
export type SayariTraversalPath = z.infer<typeof traversalPathSchemaInner>;
export type SayariTraversal = z.infer<typeof traversalSchemaInner>;
export type SayariShortestPath = z.infer<typeof shortestPathSchemaInner>;

/** One entry of one attribute block, as the projection produces it. */
export type SayariAttributeValue = NonNullable<
  NonNullable<SayariEntity['attributes']>[string]['data']
>[number];

/**
 * The text of one attribute entry.
 *
 * It lives at `properties.value` — never at the top level, on any attribute
 * type, in any of the 313 measured bodies. This function exists so that fact is
 * written down once instead of being re-learned at each call site, which is how
 * `businessPurposes` and `aliases` came to be silently empty everywhere.
 */
export function attributeText(entry: SayariAttributeValue | undefined | null): string | null {
  const value = entry?.properties?.value;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Every attribute entry that has text, in order, with the empties dropped. */
export function attributeTexts(
  entries: readonly (SayariAttributeValue | undefined | null)[] | undefined | null,
): string[] {
  return (entries ?? []).map(attributeText).filter((text): text is string => text != null);
}

/** Reads `match_strength` whichever of its two shapes an endpoint returned. */
export function matchStrengthValue(
  value: SayariResolutionCandidate['match_strength'],
): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'value' in value) {
    return typeof value.value === 'string' ? value.value : undefined;
  }
  return undefined;
}

/** The boot call. Deliberately routed raw, and it gates nothing (SPEC §16.7). */
export const metadataSchema = z.unknown();
