import { relations } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { entity } from './entities';
import { enrichmentSource, enrichmentSubjectKind, geocodePrecision } from './enums';
import { upstreamResponse } from './upstream';

/**
 * Enrichment (SPEC §3.4, §7).
 *
 * `enrichment` is both the **registry** — one row per dated call — and the
 * **Citation target**. Values live in six typed tables at their own grains,
 * because a country indicator, a tariff line and a news article have nothing in
 * common but the fact that something went and asked for them.
 *
 * Country and tariff Enrichments are **shared across Suppliers**, which is
 * exactly why data confidence cannot be a row count on the Supplier (SPEC §3.4).
 */

/**
 * A fetched, dated fact attached to a Profile, a country or an HS line.
 *
 * `fetchedAt` is displayed with an age badge and an aged Enrichment forces the
 * caveat line — it does not block anything and does not trigger a refresh. No
 * TTL and no background refresh: a background TTL would spend credits on page
 * views (SPEC §7.2).
 */
export const enrichment = pgTable(
  'enrichment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: enrichmentSource('source').notNull(),
    subjectKind: enrichmentSubjectKind('subject_kind').notNull(),
    /** An entity id, an ISO country code, an HS code, or an address string. */
    subjectKey: text('subject_key').notNull(),
    requestParams: jsonb('request_params').notNull(),
    /**
     * Which re-fetch of this subject this row is: 0 for the first, 1 for the
     * next, counted rather than timestamped so two runs an hour apart agree.
     *
     * `recordEnrichment` has always computed this number — it is what
     * `derivedId` keys the row's id on — and then dropped it, so the table
     * was append-only with **no readable order over its own generations**.
     * `fetched_at` cannot stand in: it comes from the upstream body, so a
     * replay against a warm cache writes two generations carrying the same
     * instant, and `seedUpstream` writes a whole fixture's rows in one
     * statement (the same tie `readCache` documents in `src/upstream/call.ts`).
     * Every latest-generation read in `src/db/queries/enrichments.ts` orders
     * on this column, with `id` as the tiebreak that makes the order total.
     */
    generation: integer('generation').notNull().default(0),
    /** The raw body this was projected from, so a Citation can reach the source. */
    upstreamResponseId: uuid('upstream_response_id')
      .notNull()
      .references(() => upstreamResponse.id),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    /** Not re-stamped on refresh — the *new evidence* chip is computed from it. */
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    jobId: uuid('job_id'),
  },
  (t) => [
    index('enrichment_subject_idx').on(t.source, t.subjectKind, t.subjectKey, t.fetchedAt),
    /** The index the latest-generation reads run on, in the order they read it. */
    index('enrichment_generation_idx').on(t.source, t.subjectKind, t.subjectKey, t.generation),
  ],
);

/**
 * ── The six typed value tables ───────────────────────────────────────────────
 *
 * **Every one of them is append-only per generation**, and that is deliberate:
 * a value row's `enrichment_id` is what a Citation resolves through, so a
 * re-fetch that overwrote the row in place would move a number underneath the
 * sentence that argued from it. `family_member` is the one exception, and it
 * is an exception for a stated reason (its own comment below).
 *
 * The rule that makes append-only safe is on the **read**: a reader takes the
 * latest generation and nothing else, in an explicit total order. Reading
 * every generation at once is how a second Enrichment came to double the
 * article count (`news_item`) and how the year that reached a Score came to
 * depend on Postgres row order (`country_indicator`). The readers that hold
 * that rule live in `src/db/queries/enrichments.ts`; a new one belongs there
 * rather than inline, so the rule has one place to be true in.
 */

/**
 * World Bank Indicators v2 — LPI overall plus five WGI dimensions (SPEC §7.1).
 *
 * `mrnev=1` is the correct latest-value operator; `mrv=1` returns nulls for
 * late reporters. The familiar `PV.EST`-style WGI codes are archived — the
 * `GOV_WGI_*` codes expose an absolute 0–100 `.SC` with confidence bounds,
 * which is what the Criterion uses and what makes the band renderable.
 */
export const countryIndicator = pgTable(
  'country_indicator',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    enrichmentId: uuid('enrichment_id')
      .notNull()
      .references(() => enrichment.id, { onDelete: 'cascade' }),
    country: text('country').notNull(),
    indicatorCode: text('indicator_code').notNull(),
    indicatorLabel: text('indicator_label').notNull(),
    year: integer('year'),
    value: doublePrecision('value'),
    /** `.SC_LB` / `.SC_UB`. Overlapping bands are not a real difference. */
    lowerBound: doublePrecision('lower_bound'),
    upperBound: doublePrecision('upper_bound'),
  },
  (t) => [index('country_indicator_country_idx').on(t.country, t.indicatorCode)],
);

/**
 * USITC HTS / WITS — the MFN rate for one HS line (SPEC §7.1).
 *
 * Trade-action surcharges are **flags, never folded into the rate**: they key
 * on facts the app does not have.
 */
export const tariffLine = pgTable(
  'tariff_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    enrichmentId: uuid('enrichment_id')
      .notNull()
      .references(() => enrichment.id, { onDelete: 'cascade' }),
    hsCode: text('hs_code').notNull(),
    /** The importer this rate is for. USA is scored; MEX is rendered beside it. */
    importerCountry: text('importer_country').notNull(),
    originCountry: text('origin_country'),
    description: text('description'),
    /** Percent. Null where the source returned no general rate. */
    mfnRate: numeric('mfn_rate', { precision: 6, scale: 3 }),
    rateText: text('rate_text'),
  },
  (t) => [index('tariff_line_key_idx').on(t.hsCode, t.importerCountry)],
);

/**
 * GLEIF — the exact-LEI join is decisive; name search is not (SPEC §7.1).
 *
 * Name search hits only the native-script primary name, so Denso and Hyundai
 * Mobis return zero in English. The country filter is **ISO2**: `DEU` returns
 * HTTP 200 with zero results, silently, which is a failure mode worth a column
 * comment because it looks exactly like a clean negative.
 */
export const leiRecord = pgTable(
  'lei_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    enrichmentId: uuid('enrichment_id')
      .notNull()
      .references(() => enrichment.id, { onDelete: 'cascade' }),
    lei: text('lei').notNull(),
    legalName: text('legal_name').notNull(),
    legalAddressLine: text('legal_address_line'),
    legalCity: text('legal_city'),
    legalPostcode: text('legal_postcode'),
    legalCountry: text('legal_country'),
    status: text('status'),
    registrationStatus: text('registration_status'),
  },
  (t) => [index('lei_record_lei_idx').on(t.lei)],
);

/**
 * Sayari `negativeNews` (SPEC §7.1).
 *
 * Takes a **bare name**, so disambiguation is ours: the input is the resolved
 * legal name, never the roster trade name. 7–15 s per call, so background only.
 * Zero articles is not a clean result — the coverage precondition is what stops
 * an empty set reading as spotless.
 */
export const newsItem = pgTable(
  'news_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    enrichmentId: uuid('enrichment_id')
      .notNull()
      .references(() => enrichment.id, { onDelete: 'cascade' }),
    entityId: text('entity_id').references(() => entity.id),
    title: text('title').notNull(),
    sourceName: text('source_name'),
    url: text('url'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** Sayari's own flags. Weighted ×3 serious / ×1 moderate / ×0.5 unflagged. */
    riskFlags: jsonb('risk_flags'),
  },
  (t) => [index('news_item_entity_idx').on(t.entityId)],
);

/**
 * Nominatim (with Photon as fallback) — for **Plants and unresolved rows only**.
 *
 * Sayari's own `x`/`y` supersedes this for a resolved Profile. Every geocode
 * records its precision, because 4 of 6 sampled addresses missed at building
 * precision (SPEC §7.1).
 */
export const geocode = pgTable('geocode', {
  id: uuid('id').primaryKey().defaultRandom(),
  enrichmentId: uuid('enrichment_id')
    .notNull()
    .references(() => enrichment.id, { onDelete: 'cascade' }),
  queryAddress: text('query_address').notNull(),
  lat: doublePrecision('lat'),
  lon: doublePrecision('lon'),
  precision: geocodePrecision('precision').notNull(),
  displayName: text('display_name'),
  provider: text('provider').notNull(),
});

/**
 * One company in a Supplier's Corporate family (SPEC §8).
 *
 * The family is **downward-only and psa-routed**: `traversal.ownership` reaches
 * members through one or two `possibly_same_as` hops to *other* records of the
 * same company, because Sayari splits a company across records and the
 * ownership hangs off the others. One call at `limit: 50`, so it is always
 * *n of m explored* and never a complete list.
 *
 * A family member's risk **badges and never deducts** (SPEC §8.2). Two seeded
 * shared-parent pairs mean a deduction would move two Suppliers' ranks off one
 * shared fact. Ranks do not move.
 */
export const familyMember = pgTable(
  'family_member',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    enrichmentId: uuid('enrichment_id')
      .notNull()
      .references(() => enrichment.id, { onDelete: 'cascade' }),
    /** The Profile (or Twin) the family hangs off. */
    rootEntityId: text('root_entity_id')
      .notNull()
      .references(() => entity.id),
    memberEntityId: text('member_entity_id')
      .notNull()
      .references(() => entity.id),
    /** The ownership path, including the `possibly_same_as` hops it ran through. */
    path: jsonb('path'),
    hopDepth: integer('hop_depth').notNull(),
    /** Set when a Deep Traversal, rather than the automatic read, found it. */
    discoveredByJob: uuid('discovered_by_job'),
    /**
     * True when the 50-node window was smaller than the reachable set. "17 of
     * 2 275 explored" is the honest phrasing, and an absent member proves nothing.
     */
    truncated: boolean('truncated').notNull().default(false),
    exploredCount: integer('explored_count'),
    reachableCount: integer('reachable_count'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('family_member_root_idx').on(t.rootEntityId),
    /**
     * **One row per (root, member).**
     *
     * The table had only its `id` primary key, so the `onConflictDoNothing` on
     * the insert had nothing to conflict on — a fresh uuid never collides — and
     * a second enrichment of the same Profile simply inserted the family again.
     * Bosch and Magna each held **100 rows for 50 distinct members**, which the
     * supplier page then counted, so the badge read *"28 of 100 explored"* where
     * the truth was 14 of 50. Both halves of that were doubled.
     *
     * A family member is a fact about the ownership graph, not about the read
     * that found it, so the row identity is the pair — and the constraint is what
     * makes re-enrichment idempotent rather than merely repeated.
     */
    uniqueIndex('family_member_root_member_key').on(t.rootEntityId, t.memberEntityId),
  ],
);

export const enrichmentRelations = relations(enrichment, ({ one, many }) => ({
  upstreamResponse: one(upstreamResponse, {
    fields: [enrichment.upstreamResponseId],
    references: [upstreamResponse.id],
  }),
  countryIndicators: many(countryIndicator),
  tariffLines: many(tariffLine),
  leiRecords: many(leiRecord),
  newsItems: many(newsItem),
  geocodes: many(geocode),
  familyMembers: many(familyMember),
}));
