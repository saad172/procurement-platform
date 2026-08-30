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

/** Sayari returns `x`/`y` (lon/lat) on a structured address. */
const addressProperties = z
  .object({
    x: z.number().nullish(),
    y: z.number().nullish(),
    city: z.string().nullish(),
    postcode: z.string().nullish(),
    state: z.string().nullish(),
    country: z.string().nullish(),
    house_number: z.string().nullish(),
    street: z.string().nullish(),
  })
  .partial();

const attributeValue = z
  .object({
    value: z.unknown().nullish(),
    /** Every attribute carries citable record ids — the Citation's record hop. */
    record: z.array(z.string()).nullish(),
    properties: addressProperties.nullish(),
    context: z.unknown().nullish(),
    type: z.string().nullish(),
  })
  .partial();

const attributeBlock = z
  .object({ data: z.array(attributeValue).nullish(), next: z.string().nullish() })
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
  })
  .partial({ type: true })
  .loose();



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
    size: z.object({ count: z.number().nullish(), qualifier: z.string().nullish() }).partial().nullish(),
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
            relationships: z.unknown().nullish(),
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

const traversalSchemaInner = z
  .object({
    data: z.array(traversalPathSchemaInner).nullish(),
    /** A boolean here, not a cursor string — measured against the live API. */
    next: z.union([z.boolean(), z.string()]).nullish(),
    offset: z.number().nullish(),
    limit: z.number().nullish(),
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
        entitySchemaInner.extend({
          metadata: tradeMetadataSchema,
          /**
           * Sayari's own forwarder flag. SPEC §11.1 measured 9 freight
           * forwarders in the top 25 by shipments; this is the field that
           * names them, and it is why the job can classify without guessing
           * from the label.
           */
          logistics_entity: z.boolean().nullish(),
        }),
      )
      .nullish(),
    size: z.object({ count: z.number().nullish(), qualifier: z.string().nullish() }).partial().loose().nullish(),
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
export const resolutionCandidateSchema = eitherCasing(resolutionCandidateSchemaInner);
export const resolutionSchema = eitherCasing(resolutionSchemaInner);
export const searchEntitySchema = eitherCasing(searchEntitySchemaInner);
export const recordSchema = eitherCasing(recordSchemaInner);
export const traversalPathSchema = eitherCasing(traversalPathSchemaInner);
export const traversalSchema = eitherCasing(traversalSchemaInner);
export const negativeNewsSchema = eitherCasing(negativeNewsSchemaInner);
export const tradeSearchSchema = eitherCasing(tradeSearchSchemaInner);

/** The projected entity shape, as every caller in the app sees it. */
export type SayariEntity = z.infer<typeof entitySchemaInner>;
export type SayariResolutionCandidate = z.infer<typeof resolutionCandidateSchemaInner>;
export type SayariTraversalPath = z.infer<typeof traversalPathSchemaInner>;

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

/**
 * `info.getUsage()` — **seven integer endpoint-class counters, account-wide,
 * over a rolling year, with no Program dimension and no dollars** (SPEC §18.1).
 *
 * `negativeNews` has no bucket here at all, which the UI footnotes. This is why
 * our own usage figure and Sayari's are shown separately scoped, with no delta
 * anywhere: reconciliation stays a human act.
 */
export const usageSchema = z.record(z.string(), z.unknown()).and(
  z.object({ from: z.string().nullish(), to: z.string().nullish() }).partial().loose(),
);

/** The boot call. Deliberately routed raw, and it gates nothing (SPEC §16.7). */
export const metadataSchema = z.unknown();
