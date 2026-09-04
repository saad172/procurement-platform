import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Every closed set in the model is a `pgEnum` (SPEC §3).
 *
 * The reason is not tidiness: several of these sets carry a decision, and a
 * `text` column would let a later writer add a value that the decision forbids.
 * `match.settled_by` having exactly four members is what makes a promoted Lead
 * expressible without a fourth Match *status*; `job_state` having exactly one
 * state that returns to `running` is a rule the type can hold.
 */

// ── Suppliers and Leads ──────────────────────────────────────────────────────

/**
 * An imported Supplier is one row of the roster; a discovered one was promoted
 * from a Lead and was never on any list (SPEC §11.3). The distinction is why
 * roster name / address / country are nullable on `supplier`.
 */
export const supplierOrigin = pgEnum('supplier_origin', ['imported', 'discovered']);

/**
 * Discover's classifier returns a closed enum and never prose, because *an enum
 * is not a claim* — which is what lets Discover add a table and no new Citation
 * target group (SPEC §11.1).
 */
export const leadClassification = pgEnum('lead_classification', [
  'manufacturer',
  'forwarder_or_logistics',
  'trader_or_distributor',
  'consumer_goods',
  'unclear',
]);

// ── Matching ─────────────────────────────────────────────────────────────────

/**
 * `needs_review` means a Candidate in-country was seen and the agents could not
 * settle; `not_found` means none ever was (SPEC §6.1). The difference is what a
 * person is being asked to do.
 */
export const matchStatus = pgEnum('match_status', ['accepted', 'needs_review', 'not_found']);

/**
 * `rules` — the auto-accept gate: exactly one Candidate passed all eight
 *           Discriminators AND a GLEIF exact-LEI join agreed. Zero tokens.
 * `agents` — resolver and evaluator independently named the same entity.
 * `human`  — a person settled it on the Needs Review page.
 * `discovered` — a promoted Lead, pre-settled with zero attempts, so that
 *           `match` stays total over Suppliers (SPEC §11.3).
 */
export const matchSettledBy = pgEnum('match_settled_by', [
  'rules',
  'agents',
  'human',
  'discovered',
]);

/**
 * Where the **country a Match is scored on** came from (SPEC §9.4).
 *
 * `gleif` — the settled Candidate has an LEI and GLEIF's own legal address
 *           names a country. An independent register, and the strongest of the
 *           three.
 * `matched_address` — the country of the one recorded address the Discriminators
 *           anchored on, which is the building the Match is *about*.
 * `profile` — the Profile's own country, which is Sayari's `countries[0]` and
 *           is a fact about the record rather than about the site. Sumitomo
 *           Electric's reads `SWE` against a Japanese roster address.
 *
 * An enum rather than text because the Supplier page renders the three
 * differently — "scored JPN (GLEIF)" is a stronger sentence than "scored JPN
 * (profile)", and a fourth value would be a claim nobody has argued for.
 */
export const matchCountrySource = pgEnum('match_country_source', [
  'gleif',
  'matched_address',
  'profile',
]);

/**
 * `unavailable` is a verdict distinct from `fail` (SPEC §6.2). The real Robert
 * Bosch GmbH has no LEI at all, so `lei_witness = unavailable` must not read as
 * evidence against it.
 */
export const discriminatorVerdict = pgEnum('discriminator_verdict', [
  'pass',
  'fail',
  'unavailable',
]);

/** The eight checks. No single one settles a Match (SPEC §6.2). */
export const discriminatorName = pgEnum('discriminator_name', [
  'country',
  'locality',
  'street',
  'name_cover',
  'alias_context',
  'lei_witness',
  'business_purpose',
  'liveness',
]);

// ── Upstream ─────────────────────────────────────────────────────────────────

/** The five upstream services. Not GDELT, which appears in no ticket. */
export const upstreamSource = pgEnum('upstream_source', [
  'sayari',
  'gleif',
  'worldbank',
  'usitc',
  'nominatim',
]);

/**
 * `sdk` is the normal path; `raw` is the deliberately-routed fallback for the
 * SDK's deserialization bugs. The fallback is insurance, not a path — but when
 * it fires it spends twice, and this column is what makes that visible rather
 * than hidden (SPEC §16.1, §22.2 item 18).
 */
export const upstreamVia = pgEnum('upstream_via', ['sdk', 'raw']);

/**
 * One closed union built by one `classify()` (SPEC §16.3).
 *
 * Of the ten, only `not_found` is an objection a model could act on; every
 * other kind throws, because it is something only we can fix. A parse bug must
 * never read as "not entitled".
 */
export const upstreamErrorKind = pgEnum('upstream_error_kind', [
  'parse',
  'entitlement',
  'auth',
  'rate_limit',
  'not_found',
  'bad_request',
  'timeout',
  'transport',
  'upstream_5xx',
  'projection',
]);

/** One `usage_event` per outbound attempt, with its outcome (SPEC §16.2). */
export const usageOutcome = pgEnum('usage_outcome', ['ok', 'error']);

// ── Enrichment ───────────────────────────────────────────────────────────────

/**
 * The six sources fetched per accepted Profile, per country, or per HS line.
 *
 * What makes an Enrichment is the dated call, not where the answer came from —
 * which is why Sayari's own `negativeNews` counts, and so does the Corporate
 * family, drawn from the entity graph itself (CONTEXT.md, *Enrichment*).
 */
/**
 * Where an Enrichment came from — **one value per dated call**, not per API.
 *
 * `sayari_deep_traversal` is separate from `sayari_ownership_family`, and the
 * separation is load-bearing rather than tidy. Three reasons, each on its own
 * sufficient:
 *
 * 1. **It is not the same read.** The family source is documented on
 *    `family_member` as *downward-only and psa-routed*, one call at `limit: 50`
 *    — and half a Deep Traversal is `traversal.ubo`, which walks **upward**.
 *    Labelling an upward walk with a source whose own definition says downward
 *    would put a false label on a citable row.
 * 2. **A person asked for it.** CONTEXT: a Deep Traversal is *"a Job a person or
 *    the chat triggers on demand"*, distinct from the family, which is
 *    *"fetched for every accepted Profile without anyone asking"*. The
 *    Enrichments panel answers *what did we fetch, and when*; collapsing the two
 *    would make a spend somebody consented to indistinguishable from one the
 *    pipeline made on its own.
 * 3. **The id is derived from the source.** `recordEnrichment` derives
 *    `enrichment.id` from `source:subjectKind:subjectKey` plus a counted
 *    generation, so a shared source would make a Deep Traversal of a Profile
 *    simply the *next generation* of its Corporate family — a re-read of
 *    something it is not a re-read of.
 */
export const enrichmentSource = pgEnum('enrichment_source', [
  'sayari_negative_news',
  'sayari_ownership_family',
  'sayari_deep_traversal',
  /**
   * The **type-filtered `traversal.traversal` at `maxDepth: 1`** that recovers
   * one-hop owner edges when `relationship_count` says they exist but the
   * entity payload's own relationship window was too swamped with trade edges
   * to include them (SPEC §16.6). Distinct from `sayari_deep_traversal` for
   * the same reason that one is distinct from `sayari_ownership_family`: it is
   * automatic — the enrich Job asks it whenever the gap shows up, nobody
   * requested it — so labelling it a Deep Traversal would make a spend the
   * pipeline made on its own indistinguishable from one a person asked for.
   */
  'sayari_owner_edges',
  /**
   * The watchlist read, the second automatic call per accepted Profile
   * (network spec §4.1, ticket 02): `traversal.watchlist`, `maxDepth: 4`,
   * `psa: true`, `limit: 50`, the endpoint's default 31 relationship types.
   * Automatic, like `sayari_ownership_family`, and kept apart from it for the
   * same three reasons that source's own doc comment gives: it is not the
   * same read (a different endpoint, a different filter), and the two write
   * Paths of different `kind`s (`family` versus `watchlist`) that a person
   * reading the Enrichments panel should be able to tell apart.
   */
  'sayari_watchlist',
  /**
   * The filtered ownership page, the third automatic call per accepted
   * Profile (network spec §4.1, ticket 03): `traversal.ownership` again,
   * `riskCategories: [sanctions, export_controls, forced_labor]`,
   * `excludeClosedEntities: true`, `limit: 50` — the owned entities that
   * carry exposure wherever they sit in the explored set, not the first
   * fifty in server order. Its Paths write into the **same** `graph_path`
   * rows as `sayari_ownership_family` (`kind: 'family'`, `filtered: true`
   * on the row per network spec §4.1 and §6, never a second `kind`), which
   * is exactly why it still needs its own source rather than sharing that
   * one: reasons 1 and 3 above, not reason 2 — both reads are automatic, so
   * *a person asked for it* does not distinguish them.
   *
   * 1. **It is not the same read**, even though it is the same endpoint and
   *    direction. `riskCategories`/`excludeClosedEntities` change the query
   *    and therefore the response — a risk-filtered subset, not the family
   *    at large — so `requestParams` genuinely differs, the way it does for
   *    `sayari_owner_edges` against a shared endpoint.
   * 3. **The id is derived from the source, decisively here.**
   *    `fanOutEnrichments` calls the unfiltered family read and this one
   *    back to back for the same Profile, so a shared source would make
   *    every enrich pass write generation *N* for the family read and
   *    *N + 1* for this one — an undocumented, order-dependent parity, not
   *    "the next generation of the same question" the way a re-enrich a
   *    day later would be. Any *latest generation of `sayari_ownership_
   *    family`* read (the pattern `latestEnrichmentId` in
   *    `src/db/queries/enrichments.ts` exists for) would then always
   *    resolve to this filtered read and could never see the plain
   *    family read's own latest fetch.
   */
  'sayari_ownership_exposure',
  /**
   * `traversal.shortestPath` between two entities (network spec §4.2, §7;
   * ticket 04). **Not automatic** — unlike the three sources above it, kept
   * apart from `sayari_deep_traversal` for the same reason that source is
   * kept apart from the automatic family: *a person, or a Job a person or
   * the chat triggered, asked for this specific pair.* CONTEXT's own
   * distinction for a Deep Traversal — *"a Job a person or the chat triggers
   * on demand"* — is exactly the distinction this read makes too: the
   * recommend Job runs it at submission time to check whether an award and
   * another Pick share a parent or one owns the other, and the pairs Job
   * runs it on demand for a chosen pair. Neither happens without a specific
   * trigger the way `sayari_ownership_family`/`sayari_watchlist`/
   * `sayari_ownership_exposure` happen for every accepted Profile.
   *
   * The same three reasons `sayari_deep_traversal`'s own doc comment gives
   * apply here too, not restated wholesale but each still true:
   *
   * 1. **It is not the same read.** `traversal.shortestPath` takes exactly
   *    two entity ids and no `id`/depth/filter params at all — a targeted
   *    walk between a named pair, not an expansion from one root outward.
   *    Its own envelope carries no `explored_count`/`partial_results` (see
   *    `SayariShortestPath`, `src/upstream/projections/sayari.ts`), which
   *    the four expansion reads all do.
   * 2. **A person, or something a person triggered, asked for it** — see
   *    above.
   * 3. **The id is derived from the source.** `recordEnrichment` derives
   *    `enrichment.id` from `source:subjectKind:subjectKey` plus a counted
   *    generation, keyed on the root entity alone (`subjectKey`) — sharing a
   *    source with any automatic read would make a shortest-path check
   *    against one Pick read as the next generation of that root's family or
   *    watchlist, a re-read of something it is not a re-read of.
   *
   * Writes a `graph_path` row of `kind: 'shortest_path'` (network spec §6):
   * a Path in its own right, not folded into `family` or `watchlist`, even
   * when the same two entities are already joined by one of those — the
   * unique key is (root, terminal, kind), and a shortest path found for a
   * pairwise check is a different fact from a Path an unrelated automatic
   * read already recorded between the same two ids.
   */
  'sayari_shortest_path',
  /**
   * The trade Job's three counterparty/shipment reads for one accepted
   * Profile (network spec §4.3, ticket 05): `trade.searchSuppliers`
   * (`filter.supplierId`, `limit: 1` — the HS facet and shipment count,
   * stored on `trade_footprint`), `trade.searchBuyers` (`filter.supplierId`,
   * `limit: 50` — the customer list with risk and country, `trade_buyer`)
   * and `trade.searchShipments` (`filter.supplierId`, `filter.arrivalDate`
   * over the trailing 24 months, `limit: 50` — dated, citable sample rows,
   * `trade_shipment`).
   *
   * **Three distinct SDK methods and three distinct dated calls, sharing one
   * source rather than each getting its own** — not a new pattern invented
   * for this ticket, but the same shape `sayari_deep_traversal` already has:
   * `absorbPage` (`src/jobs/traverse.ts`) records a fresh Enrichment **per
   * page, per direction** — `traversal.ownership` and `traversal.ubo`, two
   * SDK methods — under that one source, because both answer one concept
   * (*what does a person-triggered expansion of this Profile's ownership
   * find*). These three answer one concept the same way: *what this Profile
   * ships, to whom, from where, how recently, and who buys from it* — all
   * three keyed by the identical `filter.supplierId`.
   *
   * **Why `sayari_supply_chain_upstream` (below) is not folded in too**,
   * despite being a fourth trade Job read on the same Profile: it answers a
   * structurally different question (upstream tiers, not this Profile's own
   * shipments), carries a structurally different envelope (see that entry's
   * own comment) and writes into `graph_path` rather than any of the three
   * typed tables this source's calls populate. Sharing one source across
   * that boundary would reproduce BUILD-NOTES finding 158 — a second,
   * structurally different automatic read sharing one bucket with the first
   * silently moved a citation's `enrichment_id` off the row that actually
   * found it — for a fact this build has already paid once, live, to find
   * and fix (`graph_path.enrichment_id` reassigned on every conflict once
   * `enrichOwnership` shared `enrichFamily`'s rows).
   *
   * **A reader wanting specifically the footprint/count row**
   * (`trade_footprint`, written only by `searchSuppliers`) should not reach
   * for the bare *latest generation of this source* pattern
   * `latestEnrichmentId` (`src/db/queries/enrichments.ts`) uses for every
   * other source here: three calls share one counter, so the newest
   * generation is whichever of the three a Job's fan-out happened to run
   * last, not necessarily the `searchSuppliers` one. Scope by the Enrichment
   * that owns a `trade_footprint`/`trade_buyer`/`trade_shipment` child row
   * instead — the same way `withFamilyCoverage` (`src/jobs/publish.ts`)
   * already scopes by `enrichment_id` rather than by source alone, once two
   * reads could share a bucket.
   */
  'sayari_trade_footprint',
  /**
   * `supplyChain.upstreamTradeTraversal`, raw path (network spec §4.3, §5;
   * ticket 05): the trade Job's upstream-tier read, filtered by the
   * Category's six-digit HS `component`s and the forced-labour-origin/
   * sanctions `risk` stems, `maxDepth: 2`, `minDate` 24 months back. Writes
   * `graph_path` rows of `kind: 'supply_chain'`, `direction: 'upstream'` —
   * shown and cited, never deducted (network spec §5) — never the three
   * typed trade tables `sayari_trade_footprint` populates.
   *
   * Its own dedicated value for the same reason `sayari_shortest_path` got
   * one in ticket 04 rather than folding into an existing source: **it is
   * not the same read.** `upstreamTradeTraversal` takes `component`/`risk`/
   * `countries`/`maxDepth`/`minDate` and no `id`-rooted expansion params at
   * all; its envelope is `{filters, data: {paths, entities}, exploredCount,
   * partialResults}` (`UpstreamTradeTraversalResponse`,
   * `node_modules/@sayari/sdk/api/resources/supplyChain/types/
   * UpstreamTradeTraversalResponse.d.ts`) — structurally unlike
   * `traversalSchemaInner`'s `{data, next, offset, limit, min_depth,
   * max_depth, explored_count, partial_results}` the four
   * `TraversalWalkParams`-shaped sources share, and unlike
   * `tradeSearchSchemaInner`'s `{data, size, next, limit, offset}` this
   * enum's own `sayari_trade_footprint` calls share.
   *
   * It also carries its own SDK defect, confirmed independently of
   * `sayari_shortest_path`'s (which has none) and of the `risk_categories`
   * bug `sayari_ownership_exposure`/`downstreamQuery` document: verified
   * against `node_modules/@sayari/sdk/api/resources/supplyChain/client/
   * Client.js`, its request builder JSON-stringifies a populated
   * `component`/`risk`/`countries` array into the query string
   * (`toJson(...)`) — the identical defect class, on a different endpoint,
   * from the one `downstreamQuery`'s own doc comment documents for
   * `risk_categories`. `sayariSupplyChainUpstreamTradeTraversal`'s dispatch
   * (`src/upstream/endpoints.ts`) routes around it; this column only records
   * that the call is not interchangeable with any other row in this enum.
   *
   * The id is derived from the source too (`recordEnrichment`,
   * `source:subjectKind:subjectKey` plus a counted generation): sharing a
   * source with `sayari_trade_footprint` would make this Job's fourth call,
   * for the same root entity, read as the next generation of the footprint
   * read rather than a distinct fact — the same collision class
   * `sayari_trade_footprint`'s own comment reasons through above, and the one
   * BUILD-NOTES finding 158 found live.
   */
  'sayari_supply_chain_upstream',
  'world_bank',
  'gleif',
  'usitc',
  'nominatim',
]);

/** What an Enrichment is attached to. Country and tariff rows are shared. */
export const enrichmentSubjectKind = pgEnum('enrichment_subject_kind', [
  'entity',
  'country',
  'hs_line',
  'address',
]);

/**
 * How a stored MFN rate was matched to the HS line asked for (SPEC §7.1).
 *
 * The USITC answers with the lines *under* a code as often as with the code
 * itself, so a rate is always the result of a choice: `exact` where a returned
 * line carries the queried code digit for digit, `sub_line` where the rate was
 * read from a line beneath it — the ordinary case for a six-digit Category
 * line — and `none` where nothing matched and the rate is null.
 *
 * Recorded rather than assumed, because the seed's own note on `8708.99` is
 * that the lines under one heading run Free to 2.5%: which line answered is
 * part of what the rate means.
 */
export const tariffLineMatch = pgEnum('tariff_line_match', ['exact', 'sub_line', 'none']);

/**
 * Every geocode records its precision level, because 4 of 6 sampled addresses
 * missed at building precision (SPEC §7.1). A city centroid is not a factory,
 * and the UI must say so rather than imply a surveyed point.
 */
export const geocodePrecision = pgEnum('geocode_precision', [
  'building',
  'street',
  'locality',
  'city',
  'region',
  'country',
  'unknown',
]);

/** Sayari's own risk levels. We deduct on these, never on a scale of our own. */
export const riskLevel = pgEnum('risk_level', ['high', 'elevated', 'relevant']);

// ── Network ──────────────────────────────────────────────────────────────────

/**
 * One shape for every Path (network spec §6, ticket 02).
 *
 * `family` is the downward, ownership-only, psa-routed subset the Corporate
 * family read has always produced — `family_member` migrates into `graph_path`
 * rows of this kind. `watchlist` and `deep_traversal` come from the same
 * automatic and on-demand traversal reads (network spec §4.1, §4.4);
 * `shortest_path` is the recommend Job's pairwise check for whether an award
 * and another Pick share a parent or one owns the other (§4.2, §7);
 * `supply_chain` is the trade Job's upstream tiers (§4.3). A Path's `kind` is
 * part of its identity — `graph_path`'s unique key is (root, terminal, kind),
 * not (root, terminal) — because the same two entities can be joined by both
 * a family Path and a separate shortest path found for that pairwise check.
 */
export const graphPathKind = pgEnum('graph_path_kind', [
  'family',
  'watchlist',
  'shortest_path',
  'deep_traversal',
  'supply_chain',
]);

/**
 * Which way a Path was walked (network spec §6).
 *
 * `down`/`up` are ownership's two directions; `either` is the watchlist read,
 * which follows any relationship type outward without a fixed direction;
 * `upstream` is the trade Job's supply-chain tiers (§4.3), the one direction
 * that is never ownership at all. Not reused across kinds — `family` is
 * always `down`, `supply_chain` is always `upstream` — but each Path still
 * states its own, because a Path is what a diagram and a chain row render
 * from, and neither should have to infer direction from `kind`.
 */
export const graphPathDirection = pgEnum('graph_path_direction', [
  'down',
  'up',
  'either',
  'upstream',
]);

// ── Narrative ────────────────────────────────────────────────────────────────

/** A Dossier is an `assessment`, not a table of its own (SPEC §3.6). */
export const assessmentKind = pgEnum('assessment_kind', ['standard', 'dossier']);

/**
 * The verdict is a closed enum precisely so the Citation rule never has to bend
 * for it: an enum is not a claim and cannot dangle (SPEC §10.2).
 */
export const assessmentVerdict = pgEnum('assessment_verdict', [
  'recommend',
  'recommend_with_conditions',
  'do_not_shortlist',
  'escalate',
]);

/**
 * `published_with_objections` is what happens at MAX_ROUNDS without
 * convergence. The survivors become the dissent block. A run must complete.
 */
export const evaluatorOutcome = pgEnum('evaluator_outcome', [
  'passed',
  'published_with_objections',
]);

/** The human's mark on a Recommendation version. An Assessment has none. */
export const recommendationMark = pgEnum('recommendation_mark', [
  'accepted',
  'rejected',
  'needs_work',
]);

/** A Supplier with no accepted Match is never a Pick — it is excluded, in a sentence. */
export const pickRole = pgEnum('pick_role', ['award', 'second_source', 'develop', 'avoid']);

/**
 * One enum over both documents' sections (SPEC §10.1).
 *
 * The spec counts thirteen because it counts each document's list — eight for
 * an Assessment, five for a Recommendation — and `dissent` appears in both. As
 * a set of distinct values that is twelve. Which sections are *required* is
 * per-kind and lives in code, not in the type, because a Dossier's required
 * list differs from a standard Assessment's (SPEC §3.6).
 */
export const sentenceSection = pgEnum('sentence_section', [
  // Assessment
  'identity',
  'compliance',
  'network',
  'country',
  'tariff',
  'media',
  'limits',
  // Recommendation
  'headline',
  'rationale',
  'conditions',
  'open_questions',
  // Both
  'dissent',
]);

/**
 * A Round is one proposer → evaluator exchange. `role` says who spoke; `source`
 * says what produced the turn — and `source='code'` is how a validator failure
 * is recorded as the Round it costs (SPEC §10.5).
 */
export const roundRole = pgEnum('round_role', ['proposer', 'lead', 'evaluator', 'human']);
export const roundSource = pgEnum('round_source', ['model', 'code', 'human']);

/** The six rubric items the evaluator returns, one line each (SPEC §10.3). */
export const rubricItem = pgEnum('rubric_item', [
  'support',
  'strength',
  'number_fidelity',
  'caveats',
  'eligibility',
  'omission',
]);

// ── Runs and Jobs ────────────────────────────────────────────────────────────

export const jobKind = pgEnum('job_kind', [
  'resolve',
  'enrich',
  /**
   * Fetches one company's own record.
   *
   * Most entities are never fetched on their own — they arrive nested inside
   * somebody else's traversal or search result, so nothing has read their
   * relationships and no payload belongs to them. This Job gives one of them a
   * record of its own.
   *
   * It is **not** a Deep Traversal: `traverse` extends a Profile beyond one hop
   * within a hop and node cap, on demand and by a person's decision. This is one
   * call about one company, queued by the system the first time it sees it.
   */
  'fetch_entity',
  'traverse',
  'assess',
  'recommend',
  'discover',
  'dossier',
  /**
   * The *Check every pair* Job (network spec §7): runs `findAndWriteShortestPath`
   * for every accepted-Supplier pair on one Category, confirm-gated, with
   * estimate n(n−1)/2. Distinct from the recommend Job's own narrower
   * shortestPath check, which runs only the award against each other Pick at
   * submission (§4.2, the ninth submit check) — this Job is the wider,
   * on-demand sweep over the whole roster a Category is bidding.
   */
  'pairs',
  /**
   * The trade Job (network spec §4.3, §8; ticket 05): on demand, from the
   * Supplier page or chat through the confirm gate, for one accepted
   * Profile. Four calls — `trade.searchSuppliers` (the HS facet and
   * shipment count), `trade.searchBuyers` (the customer list, with risk and
   * country), `trade.searchShipments` (dated, citable sample rows over the
   * trailing 24 months) and `supplyChain.upstreamTradeTraversal` (upstream
   * tiers, filtered by the Category's HS `component`s and forced-labour/
   * sanctions `risk` stems) — stored as Enrichment `sayari_trade_footprint`
   * (the first three) and `sayari_supply_chain_upstream` (the fourth) plus
   * `graph_path` rows of `kind: 'supply_chain'`.
   *
   * Trade edges are **shown and never deducted** (network spec §5):
   * Compliance already scores the Profile's own `exports_to_*`/`*_origin_*`
   * factors, and deducting again on a Path would count one fact twice — the
   * one Job kind in this enum whose reads never move a Score.
   */
  'trade',
]);

/** What a Job is about: a Supplier, a Category, an entity, or the Program. */
export const jobSubjectType = pgEnum('job_subject_type', [
  'supplier',
  'category',
  'entity',
  'program',
]);

/**
 * `paused_on_budget` is the ONLY state that returns to `running` — raise the
 * run budget and it flips back to `queued` (SPEC §3.9, §18.2).
 *
 * `terminated` names a number you set; `failed` names something that broke. A
 * terminated Job is re-runnable, never resumable: a runaway loop is not
 * something a human should be able to wave through.
 */
export const jobState = pgEnum('job_state', [
  'queued',
  'running',
  'done',
  'failed',
  'paused_on_budget',
  'terminated',
  'cancelled',
]);

/** The same set minus `terminated`: a run is not stopped by a per-Job ceiling. */
export const runState = pgEnum('run_state', [
  'queued',
  'running',
  'done',
  'failed',
  'paused_on_budget',
  'cancelled',
]);

/**
 * `replayable` means the Trace can drive the replay suite. A Dossier is
 * `timeline`: Managed Agents rewrites context server-side, so the prompt a
 * replay would reconstruct is not the prompt that was recorded (SPEC §17.3).
 */
export const traceFidelity = pgEnum('trace_fidelity', ['replayable', 'timeline']);

// ── Chat ─────────────────────────────────────────────────────────────────────

/**
 * `tool` widens the transcript into the complete record, which is why chat has
 * no Trace: Trace is a Job artifact with replay semantics a conversation cannot
 * honour (SPEC §14.2).
 */
export const threadMessageRole = pgEnum('thread_message_role', ['user', 'assistant', 'tool']);

/**
 * A decline writes a message and the model is told, so it can offer a cheaper
 * alternative instead of silently re-proposing (SPEC §14.5).
 */
export const confirmState = pgEnum('confirm_state', ['proposed', 'accepted', 'declined']);
