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
import {
  enrichmentSource,
  enrichmentSubjectKind,
  geocodePrecision,
  graphPathDirection,
  graphPathKind,
  tariffLineMatch,
} from './enums';
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
 * sentence that argued from it. `graph_path` (formerly `family_member`) is the
 * one exception, and it is an exception for a stated reason (its own comment
 * below).
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
    /** The code that was asked for — the Category's `category_hs_line`. */
    hsCode: text('hs_code').notNull(),
    /** The importer this rate is for. USA is scored; MEX is rendered beside it. */
    importerCountry: text('importer_country').notNull(),
    originCountry: text('origin_country'),
    description: text('description'),
    /** Percent. Null where the source returned no general rate. */
    mfnRate: numeric('mfn_rate', { precision: 6, scale: 3 }),
    rateText: text('rate_text'),
    /**
     * The HTS line the rate was actually read from, and how it was chosen.
     *
     * These two are the raw input behind the stored rate. The match used to be
     * a bare `startsWith` on the dotted-stripped code with the **first** hit
     * winning in whatever order the API returned its lines, and nothing
     * recorded that a widening had happened: the row said `8544.30 · 5%`
     * whether the source had answered about `8544.30` or about a ten-digit
     * line beneath it. `chooseHtsLine` (`src/domain/hs-code.ts`) now prefers
     * the exact line and orders the rest; these columns are what it decided.
     *
     * Null on rows written before the choice was recorded — there is nothing
     * honest to backfill, because the choice was not made explicitly.
     */
    matchedHtsno: text('matched_htsno'),
    matchedBy: tariffLineMatch('matched_by'),
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
 * One route from a Profile to one entity — an ordered list of cited edges
 * (CONTEXT.md, *Path*; network spec §6, ticket 02).
 *
 * `graph_path` replaces `family_member`: a Family member, a Listed entity
 * reached over the watchlist read, a shortest path between two Picks, and a
 * supply-chain upstream tier are all Paths from a root to a terminal — only
 * the first used to get its own table. One shape now holds all five `kind`s,
 * and `SupplierFamilyWidget`, `computeFamilyExposure`, `get_supplier_family`
 * and the Supplier page's Corporate family section read Paths of kind
 * `family` rather than rows of a family-only table.
 *
 * A Path's own risk **badges and never deducts on its own kind's terms**
 * (Family exposure, CONTEXT.md) — Network exposure (ticket 03) folds that in
 * for ownership/control kinds; trade-derived kinds are shown and never
 * deducted (network spec §5).
 */
export const graphPath = pgTable(
  'graph_path',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The Profile (or Twin) the read started from. */
    rootEntityId: text('root_entity_id')
      .notNull()
      .references(() => entity.id),
    /** The entity this Path ends at. */
    terminalEntityId: text('terminal_entity_id')
      .notNull()
      .references(() => entity.id),
    kind: graphPathKind('kind').notNull(),
    direction: graphPathDirection('direction').notNull(),
    /**
     * Ownership hops, `possibly_same_as` steps excluded — one rule
     * (`ownershipHopDepth`, `src/jobs/family-members.ts`) for every kind, so
     * the automatic read and Deep Traversal stop disagreeing about it.
     */
    hopDepth: integer('hop_depth').notNull(),
    /**
     * The ordered `entity_relationship.id`s this Path cites, one per hop.
     *
     * A jsonb array of uuid strings rather than a Postgres array column,
     * matching this schema's existing convention for id lists carried
     * alongside a row (`entity.sourceCount`, `entity.relationshipCount`):
     * jsonb everywhere an array of ids or a keyed count needs to travel with
     * a row that is not itself keyed on it. Empty for a Path with no
     * citable edge yet — see the migration note on `family_member` rows.
     */
    edgeIds: jsonb('edge_ids').$type<string[]>().notNull().default([]),
    /** How much of the reachable set this read actually walked. */
    exploredCount: integer('explored_count'),
    /**
     * True when the read's own envelope said its result was incomplete —
     * read off the envelope, never inferred from how many Paths came back:
     * zero Paths from an exhaustive read and zero Paths from a truncated one
     * are different facts, and only the envelope knows which happened.
     */
    partialResults: boolean('partial_results').notNull().default(false),
    /**
     * True when the window (`limit`, hop cap, node cap) was smaller than the
     * reachable set. "17 of 2 275 explored" is the honest phrasing, and an
     * absent Path proves nothing.
     */
    truncated: boolean('truncated').notNull().default(false),
    enrichmentId: uuid('enrichment_id')
      .notNull()
      .references(() => enrichment.id, { onDelete: 'cascade' }),
    /** Set when a Deep Traversal, rather than the automatic read, found it. */
    discoveredByJob: uuid('discovered_by_job'),
    /**
     * True on the filtered page of an automatic read — the second page of
     * the same `kind`, over the same root, carrying only Paths that matched
     * the read's risk/sanctions/PEP filters (network spec §4.1). Distinct
     * rows from the unfiltered first page, not a flag flipped on them: the
     * unique key is (root, terminal, kind), so a terminal reached by both
     * pages is two Paths, one `filtered: false` and one `filtered: true`.
     */
    filtered: boolean('filtered').notNull().default(false),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('graph_path_root_idx').on(t.rootEntityId),
    index('graph_path_terminal_idx').on(t.terminalEntityId),
    /**
     * **One row per (root, terminal, kind).**
     *
     * Generalizes `family_member_root_member_key`: a family member is a fact
     * about the ownership graph rather than about the read that found it, and
     * the same is true of every other Path kind. `family_member`'s own
     * comment names the failure this prevents — Bosch and Magna each held 100
     * rows for 50 distinct members before that constraint existed, doubling
     * both the count and the "n of m explored" badge. `kind` joins the key
     * here because the same (root, terminal) pair can legitimately carry two
     * Paths of different kinds — a family Path and, separately, a
     * shortest-path Concentration — and those are not duplicates of each
     * other.
     */
    uniqueIndex('graph_path_root_terminal_kind_key').on(
      t.rootEntityId,
      t.terminalEntityId,
      t.kind,
    ),
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
  graphPaths: many(graphPath),
}));
