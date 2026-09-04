import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
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
 * **Citation target**. Values live in nine typed tables at their own grains,
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
 * ── The nine typed value tables ──────────────────────────────────────────────
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
 * `graph_path` replaces `family_member`: a Family member, the terminal of a
 * watchlist Path, a shortest path between two Picks, and a supply-chain
 * upstream tier are all Paths from a root to a terminal — only the first used
 * to get its own table. One shape now holds all five `kind`s,
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
     * A jsonb array of uuid strings, not a Postgres array column — and,
     * despite the resemblance, **not** an instance of an existing convention:
     * `entity.sourceCount` and `entity.relationshipCount` are jsonb too, but
     * they are objects keyed by source hash or relation type, not arrays of
     * ids. This is the first jsonb-array-of-ids column in this schema.
     *
     * Empty for a Path with no citable edge yet. In particular, every row
     * migrated from `family_member` (migration 0013) holds `edge_ids: []`
     * alongside a nonzero `hop_depth` — `family_member` never recorded which
     * `entity_relationship` rows its path ran through, only Sayari's raw
     * traversal JSON, so there is nothing to backfill. That combination — a
     * real hop depth with no edges — is the documented legacy-migration gap,
     * not a write bug; the next automatic enrich pass replaces the row with
     * real `edge_ids`.
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
     * True once this (root, terminal, kind) row has been confirmed by the
     * filtered, risk/sanctions/PEP-focused page of an automatic read (network
     * spec §4.1) rather than only by the unfiltered first page.
     *
     * **This is a flag on the one row the unique key below identifies, never
     * a second row.** The key is (root, terminal, kind) — it does not include
     * `filtered` — so a terminal reached by both the unfiltered and the
     * filtered page upserts into the same row, once. The write side (ticket
     * 02b) must therefore make `filtered` **sticky-true on conflict**:
     * `filtered = filtered OR excluded.filtered` (equivalently, only ever set
     * it `true`, never back to `false`) — so a Path the filtered read has ever
     * confirmed stays `filtered: true` even when a later unfiltered-only read
     * touches the same row.
     */
    filtered: boolean('filtered').notNull().default(false),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * Composite rather than a standalone `(root_entity_id)` index: every
     * real root-only query site (`supplier-page.ts`, `catalog/reads.ts`,
     * `discover.ts`, `publish.ts`) filters by root alone today, and every
     * documented future caller narrows by `kind` too once a root's rows mix
     * all five — so `(root, kind)` serves both, as a leftmost prefix, and a
     * separate root-only index would only duplicate it.
     */
    index('graph_path_root_kind_idx').on(t.rootEntityId, t.kind),
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
     * Paths of different kinds — a family Path and, separately, a shortest
     * path found for the recommend Job's award/Pick pairwise check — and
     * those are not duplicates of each other.
     */
    uniqueIndex('graph_path_root_terminal_kind_key').on(
      t.rootEntityId,
      t.terminalEntityId,
      t.kind,
    ),
    /**
     * `kind` and `direction` are not independent: `family` is always `down`
     * (the Corporate family read never walks up) and `supply_chain` is always
     * `upstream` (the trade Job's tiers, network spec §4.3) — facts the
     * `graphPathKind`/`graphPathDirection` doc comments already state, but
     * that nothing enforced until now. `watchlist` and `deep_traversal` are
     * left unconstrained: a watchlist Path is `either` by the read's own
     * design, and a Deep Traversal can walk either way depending on what was
     * asked for.
     */
    check(
      'graph_path_kind_direction_invariant',
      sql`(${t.kind} <> 'family' OR ${t.direction} = 'down')
        AND (${t.kind} <> 'supply_chain' OR ${t.direction} = 'upstream')`,
    ),
  ],
);

/**
 * `trade.searchSuppliers` filtered by `filter.supplierId`, `limit: 1`
 * (network spec §4.3, ticket 05) — one row per Enrichment of source
 * `sayari_trade_footprint`, the HS facet and shipment count the trade Job's
 * first call returns.
 *
 * `hsFacet` mirrors `tradeMetadataSchema.hs_codes`
 * (`src/upstream/projections/sayari.ts`) — `{key, value, docCount}` per HS
 * line — a small, shipment-scoped structure typed with `.$type()` rather than
 * left as bare `jsonb`, the same choice `graph_path.edge_ids` already makes
 * for a small structured array elsewhere in this file, and not the choice
 * `news_item.risk_flags` makes for a genuinely open, source-varying shape:
 * the facet's own shape is closed and named by the SDK (`HsCode.d.ts`), so
 * there is something real to type.
 */
export const tradeFootprint = pgTable(
  'trade_footprint',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    enrichmentId: uuid('enrichment_id')
      .notNull()
      .references(() => enrichment.id, { onDelete: 'cascade' }),
    shipmentCount: integer('shipment_count').notNull(),
    /** Free-form on the wire (Sayari dates other fields the same way, e.g.
     * `registration_date: "Registered 1965-07-20"`) — text, not a parsed date. */
    latestShipmentDate: text('latest_shipment_date'),
    hsFacet: jsonb('hs_facet')
      .$type<{ key: string | null; value: string | null; docCount: number | null }[]>()
      .notNull()
      .default([]),
  },
  (t) => [index('trade_footprint_enrichment_idx').on(t.enrichmentId)],
);

/**
 * `trade.searchBuyers` filtered by `filter.supplierId`, `limit: 50` (network
 * spec §4.3, ticket 05) — one row per buyer, source `sayari_trade_footprint`.
 *
 * `buyerEntityId` is **not** an `entity` FK. A buyer here is a counterparty
 * this Profile ships to, not necessarily an entity this app has separately
 * fetched — `fetch_entity`'s own doc comment (`enums.ts`, `jobKind`) is the
 * standing reason most entities never get a row of their own until something
 * asks for one by name, and a `trade_buyer` row asking for fifty is not that
 * ask. The id is stored as Sayari returns it, exactly as `graph_path` stores
 * `edge_ids` and `attributeValue.record` store ids of things this schema does
 * not otherwise hold rows for.
 *
 * `countries` is the buyer's own multi-valued `countries[]`, kept as an array
 * rather than collapsed to one value — `entity.country`'s own comment already
 * names why a naive first entry is wrong (SPEC §11.3: eight values seen on one
 * company), and nothing here picks one over the others.
 *
 * `rank` records the buyer's position in the `searchBuyers` response (already
 * Sayari's own relevance order) — the one field this row would otherwise have
 * no honest way to recover, since `id` is a random `uuid` and carries no
 * ordering.
 */
export const tradeBuyer = pgTable(
  'trade_buyer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    enrichmentId: uuid('enrichment_id')
      .notNull()
      .references(() => enrichment.id, { onDelete: 'cascade' }),
    rank: integer('rank').notNull(),
    buyerEntityId: text('buyer_entity_id').notNull(),
    buyerName: text('buyer_name').notNull(),
    countries: jsonb('countries').$type<string[]>().notNull().default([]),
    /** The same leveled per-factor shape `entitySchemaInner.risk` projects —
     * loose, like `news_item.risk_flags`, because the factor vocabulary is
     * Sayari's own and not ours to close. */
    risk: jsonb('risk'),
    sanctioned: boolean('sanctioned'),
    pep: boolean('pep'),
  },
  (t) => [index('trade_buyer_enrichment_idx').on(t.enrichmentId)],
);

/**
 * `trade.searchShipments` filtered by `filter.supplierId` and
 * `filter.arrivalDate` over the trailing 24 months, `limit: 50` (network spec
 * §4.3, ticket 05) — one row per shipment, source `sayari_trade_footprint`.
 * Dated, citable sample rows: `record` is the citation target (SPEC §10.2's
 * Citation rule resolves through it, the same way `attributeValue.record`
 * and `traversalRelationshipValueSchema.record` already do elsewhere in this
 * schema/projection pair) — not FK'd, because nothing in this app stores a
 * `record` row; `sayariGetRecord`/`record.getRecord` fetches one on demand.
 *
 * `arrivalDate`/`departureDate` are the SDK's own `string[]` — kept as arrays
 * rather than collapsed to one value, for the same reason `trade_buyer`
 * above keeps `countries` an array: Sayari sends more than one date on a
 * shipment carried by more than one source record, and picking one here would
 * be inventing an answer this table is not the place to invent.
 *
 * `buyer` and `hsCodes`/`monetaryValue`/`weight` are the SDK's own small,
 * per-shipment arrays (`Shipment.buyer: SourceOrDestinationEntity[]`,
 * `Shipment.hsCodes: HsCodeInfo[]`, `.monetaryValue: MonetaryValue[]`,
 * `.weight: Weight[]` — `node_modules/@sayari/sdk/api/resources/trade/types/
 * Shipment.d.ts`), each typed to its own closed, SDK-named shape rather than
 * left as bare `jsonb`, matching `trade_footprint.hs_facet`'s own reasoning
 * above. `buyer` is trimmed to `{id, name, countries}` per entry — the
 * fields this table's own `trade_buyer` above stores for the same kind of
 * counterparty — rather than the SDK's full `names[]`/`risks`/
 * `businessPurpose`/`address` bag, which nothing here reads.
 */
export const tradeShipment = pgTable(
  'trade_shipment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    enrichmentId: uuid('enrichment_id')
      .notNull()
      .references(() => enrichment.id, { onDelete: 'cascade' }),
    /** Sayari's own shipment `id` — distinct from `record`, the citation id. */
    shipmentId: text('shipment_id').notNull(),
    arrivalDate: jsonb('arrival_date').$type<string[]>(),
    departureDate: jsonb('departure_date').$type<string[]>(),
    buyer: jsonb('buyer')
      .$type<{ id: string; name: string | null; countries: string[] }[]>()
      .notNull()
      .default([]),
    productOrigin: jsonb('product_origin').$type<string[]>().notNull().default([]),
    hsCodes: jsonb('hs_codes')
      .$type<{ code: string; description: string | null }[]>()
      .notNull()
      .default([]),
    monetaryValue: jsonb('monetary_value')
      .$type<{ value: number; currency: string | null; context: string | null }[]>()
      .notNull()
      .default([]),
    weight: jsonb('weight')
      .$type<{ value: number; unit: string; type: string }[]>()
      .notNull()
      .default([]),
    /** The citation target (SPEC §10.2). */
    record: text('record').notNull(),
  },
  (t) => [index('trade_shipment_enrichment_idx').on(t.enrichmentId)],
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
  tradeFootprints: many(tradeFootprint),
  tradeBuyers: many(tradeBuyer),
  tradeShipments: many(tradeShipment),
}));
