import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import {
  SUPPLY_CHAIN_UPSTREAM_MAX_DEPTH,
  SUPPLY_CHAIN_UPSTREAM_RISK_STEMS,
  TRADE_BUYERS_LIMIT,
  TRADE_FOOTPRINT_LIMIT,
  TRADE_SHIPMENTS_LIMIT,
  TRADE_WINDOW_MONTHS,
} from '@/config/constants';
import { hsHeading } from '@/domain/hs-code';
import type { ParsedEdge } from '@/domain/parse-relationships';
import { recordEnrichment, storeHopEdges, type EnrichContext } from './enrich';
import { writeGraphPaths, type GraphPathWrite, type PathHop } from './family-members';
import type {
  SayariEntity,
  SayariTradeRow,
  SayariTradeTraversalEntity,
  SayariTradeTraversalPath,
  SayariUpstreamTradeTraversal,
} from '@/upstream/projections/sayari';

/**
 * The **trade** Job (network spec §4.3, §5; ticket 05, unit 05b).
 *
 * On demand, confirm-gated, for one accepted Profile: four upstream calls —
 * `trade.searchSuppliers` (the HS facet and shipment count), `trade.
 * searchBuyers` (the customer list, risk and country), `trade.
 * searchShipments` (dated, citable sample rows over the trailing 24 months)
 * and `supplyChain.upstreamTradeTraversal` (upstream tiers, filtered by the
 * Category's six-digit HS codes and the forced-labour-origin/sanctions risk
 * stems). The first three write typed rows under one shared `sayari_trade_
 * footprint` Enrichment lineage (one fresh Enrichment per call — see
 * `runTradeFootprint`'s own doc comment for why three, not one); the fourth
 * writes its own `sayari_supply_chain_upstream` Enrichment plus `graph_path`
 * rows of `kind: 'supply_chain'`, `direction: 'upstream'`.
 *
 * **Trade edges are shown and never deducted** (spec §5): this Job writes
 * Enrichments and Paths only — no `criterion_value`, no Score, no deduction
 * table. Compliance already scores the Profile's own `exports_to_*`/
 * `*_origin_*` factors off `entity.risk`; a deduction here would count the
 * same fact twice.
 *
 * Deterministic, like `pairs`/`traverse`/`fetch_entity` (ticket 04's own
 * structural template for a confirm-gated, on-demand Job): no model runs
 * here, so this Job's Trace is its `usage_event` rows, its `trace_fidelity`
 * stays `replayable`, and its call budget is the fixed `JOB_CAPS.trade` — 4
 * calls, exactly, plus headroom for one retry — never the open-ended
 * `n(n-1)/2` `pairs` sizes its own (still-provisional) cap against.
 */

// ── Constructing readable HS/date wire values ───────────────────────────────

/** `YYYY-MM`, the granularity `TradeFilterList.arrivalDate` takes on the wire
 * (`sayariTradeSearchShipments`'s own doc comment: `"2024-01|2024-10"`). */
function yearMonth(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** `YYYY-MM-DD`, the granularity `UpstreamTradeTraversalRequest.minDate`
 * takes on the wire (its own SDK doc comment: `"<YYYY-MM-DD>"`). */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthsBefore(date: Date, months: number): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

/** `"<from>|<to>"` — the trailing `TRADE_WINDOW_MONTHS`, month granularity. */
function arrivalDateRange(now: Date): string {
  return `${yearMonth(monthsBefore(now, TRADE_WINDOW_MONTHS))}|${yearMonth(now)}`;
}

/** `YYYY-MM-DD`, `TRADE_WINDOW_MONTHS` back from now — `upstreamTradeTraversal`'s `minDate`. */
function supplyChainMinDate(now: Date): string {
  return isoDate(monthsBefore(now, TRADE_WINDOW_MONTHS));
}

// ── 1–3. The footprint, buyers and shipments — one row per call, no entity
//         graph involved (trade_buyer/trade_shipment are deliberately not
//         entity-FK'd — see their own schema comments) ────────────────────

export type TradeFootprintResult = {
  footprintEnrichmentId: string;
  buyersEnrichmentId: string;
  shipmentsEnrichmentId: string;
  footprintWritten: boolean;
  buyerCount: number;
  shipmentCount: number;
};

function toHsFacet(
  row: SayariTradeRow,
): { key: string | null; value: string | null; docCount: number | null }[] {
  return (row.metadata.hs_codes ?? []).map((c) => ({
    key: c.key ?? null,
    value: c.value ?? null,
    docCount: c.doc_count ?? null,
  }));
}

/** Call 1: `trade.searchSuppliers`, `filter.supplierId`, `limit: 1` — the
 * HS facet and shipment count, its own Enrichment. */
async function writeTradeFootprint(
  ctx: EnrichContext,
  entityId: string,
): Promise<{ enrichmentId: string; written: boolean }> {
  const supplierResult = await ctx.upstream.sayari.tradeSearchSuppliers({
    supplierId: [entityId],
    limit: TRADE_FOOTPRINT_LIMIT,
  });
  const enrichmentId = await recordEnrichment(ctx, {
    source: 'sayari_trade_footprint',
    subjectKind: 'entity',
    subjectKey: entityId,
    requestParams: {
      entityId,
      endpoint: 'trade.searchSuppliers',
      supplierId: [entityId],
      limit: TRADE_FOOTPRINT_LIMIT,
    },
    result: supplierResult,
  });
  const footprintRow = supplierResult.data.data?.[0] ?? null;
  if (footprintRow) {
    await ctx.db.insert(t.tradeFootprint).values({
      enrichmentId,
      shipmentCount: footprintRow.metadata.shipments,
      latestShipmentDate: footprintRow.metadata.latest_shipment_date ?? null,
      hsFacet: toHsFacet(footprintRow),
    });
  }
  return { enrichmentId, written: footprintRow != null };
}

/** Call 2: `trade.searchBuyers`, `filter.supplierId`, `limit: 50` — the
 * customer list, risk and country, its own Enrichment. */
async function writeTradeBuyers(
  ctx: EnrichContext,
  entityId: string,
): Promise<{ enrichmentId: string; count: number }> {
  const buyersResult = await ctx.upstream.sayari.tradeSearchBuyers({
    supplierId: [entityId],
    limit: TRADE_BUYERS_LIMIT,
  });
  const enrichmentId = await recordEnrichment(ctx, {
    source: 'sayari_trade_footprint',
    subjectKind: 'entity',
    subjectKey: entityId,
    requestParams: {
      entityId,
      endpoint: 'trade.searchBuyers',
      supplierId: [entityId],
      limit: TRADE_BUYERS_LIMIT,
    },
    result: buyersResult,
  });
  const buyerRows = (buyersResult.data.data ?? []).filter((row) => row.id != null);
  if (buyerRows.length > 0) {
    await ctx.db.insert(t.tradeBuyer).values(
      buyerRows.map((row, index) => ({
        enrichmentId,
        rank: index,
        buyerEntityId: row.id,
        buyerName: row.label,
        countries: row.countries ?? [],
        risk: row.risk ?? null,
        sanctioned: row.sanctioned ?? null,
        pep: row.pep ?? null,
      })),
    );
  }
  return { enrichmentId, count: buyerRows.length };
}

/** Call 3: `trade.searchShipments`, `filter.supplierId`,
 * `filter.arrivalDate` over the trailing `TRADE_WINDOW_MONTHS`,
 * `limit: 50` — dated, citable sample rows, its own Enrichment. */
async function writeTradeShipments(
  ctx: EnrichContext,
  entityId: string,
  now: Date,
): Promise<{ enrichmentId: string; count: number }> {
  const arrivalDate = arrivalDateRange(now);
  const shipmentsResult = await ctx.upstream.sayari.tradeSearchShipments({
    supplierId: [entityId],
    arrivalDate,
    limit: TRADE_SHIPMENTS_LIMIT,
  });
  const enrichmentId = await recordEnrichment(ctx, {
    source: 'sayari_trade_footprint',
    subjectKind: 'entity',
    subjectKey: entityId,
    requestParams: {
      entityId,
      endpoint: 'trade.searchShipments',
      supplierId: [entityId],
      arrivalDate,
      limit: TRADE_SHIPMENTS_LIMIT,
    },
    result: shipmentsResult,
  });
  // `id`/`record` are required on the projection itself (`shipmentSchemaInner`'s
  // own doc comment: a row with neither is not a citable shipment), so no
  // extra filter is needed for those two; every other field is optional and
  // dropped rather than coerced when the payload is silent about it.
  const shipmentRows = shipmentsResult.data.data ?? [];
  if (shipmentRows.length > 0) {
    await ctx.db.insert(t.tradeShipment).values(
      shipmentRows.map((row) => ({
        enrichmentId,
        shipmentId: row.id,
        arrivalDate: row.arrival_date ?? null,
        departureDate: row.departure_date ?? null,
        buyer: (row.buyer ?? [])
          .filter((b) => b.id != null)
          .map((b) => ({ id: b.id!, name: b.names?.[0] ?? null, countries: b.countries ?? [] })),
        productOrigin: row.product_origin ?? [],
        hsCodes: (row.hs_codes ?? [])
          .filter((c) => c.code != null)
          .map((c) => ({ code: c.code!, description: c.description ?? null })),
        monetaryValue: (row.monetary_value ?? [])
          .filter((v) => typeof v.value === 'number')
          .map((v) => ({ value: v.value!, currency: v.currency ?? null, context: v.context ?? null })),
        weight: (row.weight ?? [])
          .filter(
            (w): w is { value: number; unit: string; type: string } =>
              typeof w.value === 'number' && typeof w.unit === 'string' && typeof w.type === 'string',
          )
          .map((w) => ({ value: w.value, unit: w.unit, type: w.type })),
        record: row.record,
      })),
    );
  }
  return { enrichmentId, count: shipmentRows.length };
}

/**
 * Calls 1–3 of the trade Job: `trade.searchSuppliers`, `trade.searchBuyers`,
 * `trade.searchShipments`, all filtered to `filter.supplierId: [entityId]`.
 *
 * **Three `recordEnrichment` calls, not one, all under `sayari_trade_
 * footprint`.** The brief for this unit flagged this as an open question and
 * asked to mirror whatever the existing multi-call-one-source precedent
 * actually does — `absorbPage` (`src/jobs/traverse.ts`) records **a fresh
 * Enrichment per page, per direction** under the shared `sayari_deep_
 * traversal` source, not one Enrichment reused across calls. `sayari_trade_
 * footprint`'s own doc comment (`src/db/schema/enums.ts`) confirms the same
 * shape is intended here: *"three calls share one COUNTER"* and *"scope by
 * the Enrichment that OWNS a trade_footprint/trade_buyer/trade_shipment
 * child row"* — both statements are only true if each call gets its own
 * Enrichment row (three rows, one shared source, one shared, sequentially
 * counted generation), not one Enrichment id reused three times. So: one
 * `recordEnrichment` per SDK method (`writeTradeFootprint`/`writeTradeBuyers`/
 * `writeTradeShipments` above, split out for `max-lines-per-function` rather
 * than for any behavioural reason), and each call's own typed rows are FK'd
 * to the Enrichment that call itself produced.
 *
 * No entity/`entity_relationship` writes anywhere in this trio —
 * deliberately. `trade_buyer.buyerEntityId` and `trade_shipment.buyer[].id`
 * are stored as Sayari returns them, **not** `entity` FKs (both tables' own
 * schema comments: "not necessarily an entity this app has separately
 * fetched"), so there is nothing here to upsert against `entity`/
 * `entity_relationship` — unlike the fourth call, `supplyChain.
 * upstreamTradeTraversal`, whose upstream *tiers* are genuinely new Network
 * members with their own Paths.
 */
export async function runTradeFootprint(
  ctx: EnrichContext,
  args: { entityId: string; now?: Date },
): Promise<TradeFootprintResult> {
  const now = args.now ?? new Date();
  const footprint = await writeTradeFootprint(ctx, args.entityId);
  const buyers = await writeTradeBuyers(ctx, args.entityId);
  const shipments = await writeTradeShipments(ctx, args.entityId, now);

  return {
    footprintEnrichmentId: footprint.enrichmentId,
    buyersEnrichmentId: buyers.enrichmentId,
    shipmentsEnrichmentId: shipments.enrichmentId,
    footprintWritten: footprint.written,
    buyerCount: buyers.count,
    shipmentCount: shipments.count,
  };
}

// ── 4. Supply-chain upstream tiers ──────────────────────────────────────────

/** The `entity_relationship.relationship_type` this Job's own edges carry.
 *
 * Not from `RELATIONSHIP_TYPES` (`src/domain/relationships.ts`, out of this
 * unit's scope) — an unclassified type is a normal, supported, safe path in
 * this codebase (`readOwnerEdges`'s own doc comment: stored and shown, only
 * excluded from ownership scoring), and trade edges are excluded from
 * ownership scoring by design anyway (spec §5). Named for the direction it
 * actually states — see `summariseTradeTraversalPath`'s own doc comment. */
const SUPPLY_CHAIN_RELATIONSHIP_TYPE = 'supplied_by';

/**
 * A deterministic, stable id for a supply-chain edge that Sayari's own
 * response carries **no `record` for at all** — unlike every other
 * Path-producing read in this codebase, whose hops all cite a real Sayari
 * `record` id (`TradeTraversalComponent` has no such field: verified against
 * `upstreamTradeTraversalSchemaInner`/`tradeTraversalComponentSchema`,
 * `src/upstream/projections/sayari.ts`).
 *
 * **Why this matters**: `entity_relationship`'s own unique key is `(from,
 * to, relationship_type, source_record_id)`, and Postgres treats NULL as
 * unequal to NULL in a unique index — so a null `source_record_id` on every
 * supply-chain edge would mean `ON CONFLICT DO UPDATE` never fires between
 * two writes of what should be the same row, and a second run of this Job
 * would insert a fresh duplicate every time, silently growing the table and
 * breaking the `least(hop_depth, ...)` merge `storeRelationships` relies on
 * for idempotency everywhere else.
 *
 * **The scheme**: `sha256(rootEntityId | fromEntityId | toEntityId | tier |
 * sorted hsCodes)`, hex, prefixed `synthetic:supply_chain:` so it can never
 * collide with a real Sayari record id (measured shape:
 * `<32-hex>/<filename-or-doc-id>/<epoch-ms>`, no colon, no such prefix —
 * `tests/fixtures/resolve/rules-r0.json`'s own `record` values).
 *
 * **Why `rootEntityId` is in the hash, not left out.** `entity_relationship`
 * is otherwise a GLOBAL, root-independent table — the same `has_shareholder`
 * edge found via two different roots' ownership walks already resolves to
 * one shared row, by design. That precedent would argue for leaving
 * `rootEntityId` out here too, so two Profiles whose upstream tiers happen
 * to intersect at the identical (from, to, tier, HS-code) fact would share
 * one row. But this call's own `component`/`risk` filters are themselves
 * per-root (each Profile's own Category HS codes) — so "the edge as sighted
 * by THIS exploration" is legitimately query-scoped, not a universal graph
 * fact independent of who asked and with what filter, the way an
 * unconditional `traversal.ownership` walk is. Including `rootEntityId`
 * keeps a coincidental HS/tier collision between two unrelated Profiles'
 * filtered explorations from silently merging into one row; the cost is
 * that the identical real-world edge, re-discovered by a second Profile's
 * own trade Job, gets its own row rather than sharing the first Profile's —
 * an acceptable, documented trade toward safety over a `graph_path`-style
 * cross-root sharing that this call's own filtered nature does not actually
 * guarantee is correct.
 *
 * **Why `tier` and `hsCodes` are in the hash.** `tier` is the segment's own
 * distance-from-root (see `summariseTradeTraversalPath`) — two edges between
 * the same (from, to) pair at two different tiers are two different facts
 * about the graph, not a repeat sighting. `hsCodes` (sorted, for
 * order-independence) is what actually varies call to call for an
 * otherwise-identical (from, to, tier): a re-run with a widened Category HS
 * list can surface a genuinely different component set for the same pair of
 * companies, and that is new information, not a duplicate.
 *
 * **Why it is stable across re-runs.** Every input is either caller-supplied
 * and constant for one Job invocation (`rootEntityId`) or read verbatim off
 * the payload's own `entityId`/`tier`/`components[].hsCode` fields — nothing
 * here is randomly generated, timestamped, or order-dependent (the sort on
 * `hsCodes` removes the one remaining order-dependency, since a payload's
 * `components` array order is not documented as stable). Proven by
 * `tests/jobs/trade.test.ts`'s own double-run test: two calls of
 * `runSupplyChainUpstreamTradeTraversal` against an identical stubbed
 * response write the identical `entity_relationship` row count, not double.
 */
function syntheticSupplyChainRecordId(args: {
  rootEntityId: string;
  fromEntityId: string;
  toEntityId: string;
  tier: number;
  hsCodes: readonly string[];
}): string {
  const key = [
    args.rootEntityId,
    args.fromEntityId,
    args.toEntityId,
    String(args.tier),
    [...args.hsCodes].sort().join(','),
  ].join('|');
  return `synthetic:supply_chain:${createHash('sha256').update(key).digest('hex')}`;
}

/** One `path[]` segment — `{tier, entityId, components}` per `SayariTradeTraversalPath`. */
type TradeTraversalSegment = NonNullable<SayariTradeTraversalPath['path']>[number];
/** One entry of a segment's own `components` — `{hsCode, arrivalCountries, departureCountries, minDate, maxDate}`. */
type TradeTraversalComponent = NonNullable<TradeTraversalSegment['components']>[number];

function hsCodesOf(components: readonly TradeTraversalComponent[]): string[] {
  return [...new Set(components.map((c) => c.hs_code).filter((code): code is string => !!code))].sort();
}

/** Earliest `min_date` / latest `max_date` across one hop's components. */
function dateRangeOf(components: readonly TradeTraversalComponent[]): {
  min: string | null;
  max: string | null;
} {
  let min: string | null = null;
  let max: string | null = null;
  for (const c of components) {
    if (c.min_date && (!min || c.min_date < min)) min = c.min_date;
    if (c.max_date && (!max || c.max_date > max)) max = c.max_date;
  }
  return { min, max };
}

function toSyntheticEntity(id: string, info: SayariTradeTraversalEntity | undefined): SayariEntity {
  return {
    id,
    label: info?.label ?? id,
    type: info?.type ?? null,
    countries: info?.countries ?? null,
    // `risk` is deliberately ABSENT, not `null` — see this module's own
    // top-level doc comment on the `riskFactors`-vs-`risk` gap. `upsertEntity`
    // (`src/jobs/resolve.ts`) reads `entity.risk === undefined` as "this
    // sighting states nothing about risk" and takes its no-read-no-lock fast
    // path, leaving any risk this id already carries untouched rather than
    // fabricating a leveled block from `riskFactors`' flat, level-less names.
  } as SayariEntity;
}

/**
 * Reduces one `data.paths[]` entry to its citable edges, in order — the
 * `supplyChain.upstreamTradeTraversal` analogue of `summarisePath`
 * (`src/jobs/family-members.ts`), which that function's own precondition
 * cannot be reused for: `SayariUpstreamTradeTraversal`'s shape
 * (`{sourceEntityId, path: [{tier, entityId, components}]}` per path, plus a
 * sibling `entities` map keyed by id) shares nothing with the `field`/
 * `entity`/`relationships[field].values[0]` shape `summarisePath` reads.
 *
 * **What one `path` entry actually contains.** Verified against the SDK's
 * own documented examples (`UpstreamTradeTraversalResponse.d.ts`): a `path`
 * array can hold a single segment whose `tier` is 2 (no tier-1 entry at all)
 * or a run of consecutive tiers 2→3→4→5 — `component` is documented as a
 * **leaf/edge filter** ("only return supply chains that CONTAIN AT LEAST ONE
 * EDGE with 1+ of the specified HS codes"), so `path` is the SPARSE set of
 * tiers where the filtered HS component actually appears along one root-to-
 * leaf route, not necessarily every intermediate hop Sayari's own full
 * (unfiltered) walk passed through. This function does not invent the
 * missing intermediate tiers it has no data for — it cites exactly the
 * segments the payload gives, in the order given, the same "cite what can be
 * resolved, drop what can't, never invent" rule `summarisePath` follows for
 * its own payload's gaps.
 *
 * **Direction: `subjectId` is the entity closer to root, `targetId` the
 * segment's own (farther, more-upstream) entity** — the SAME root-outward
 * walk order `summarisePath` uses for every other Path kind (subject chained
 * from the previous hop, target is this hop's own entity), and deliberately
 * so: `storeRelationships` (`src/jobs/enrich.ts`) auto-upserts only
 * `edge.targetEntity`, on the assumption `edge.subjectId`'s row already
 * exists — true here only if `targetId` is always the NEW entity a hop
 * introduces, exactly as every other Path writer relies on. The
 * relationship type is chosen to read correctly under that storage order
 * despite goods physically flowing the other way (the upstream tier SHIPS
 * to the root-ward entity, not the reverse): `'supplied_by'` — "subject
 * supplied_by target" reads as "the closer-to-root entity IS supplied by
 * the farther-upstream one," which is true for every edge this function
 * writes, in the direction it is actually stored.
 */
export function summariseTradeTraversalPath(
  path: SayariTradeTraversalPath,
  rootEntityId: string,
  entities: Readonly<Record<string, SayariTradeTraversalEntity>>,
): PathHop[] {
  const segments = path.path ?? [];
  const out: PathHop[] = [];
  let subjectId = rootEntityId;
  let broken = false;

  segments.forEach((segment, index) => {
    const targetId = segment.entity_id ?? null;
    const hopDepth = Math.max(1, segment.tier ?? index + 1);

    if (broken || !targetId) {
      broken = true;
      out.push({ field: SUPPLY_CHAIN_RELATIONSHIP_TYPE, entityId: targetId, edge: null, hopDepth });
      return;
    }

    const info = entities[targetId];
    // Without at least a label this cannot be honestly upserted, and — the
    // same rule `summarisePath` applies — once one hop is unresolvable every
    // hop after it is too: the chain's own subject is the previous hop's
    // entity, and there is nothing further to chain from.
    if (!info?.label) {
      broken = true;
      out.push({ field: SUPPLY_CHAIN_RELATIONSHIP_TYPE, entityId: targetId, edge: null, hopDepth });
      return;
    }

    const components = segment.components ?? [];
    const hsCodes = hsCodesOf(components);
    const { min, max } = dateRangeOf(components);

    const edge: ParsedEdge = {
      subjectId,
      targetId,
      targetLabel: info.label,
      targetType: info.type ?? null,
      relationshipType: SUPPLY_CHAIN_RELATIONSHIP_TYPE,
      former: false,
      startDate: min,
      endDate: max,
      sourceRecordId: syntheticSupplyChainRecordId({
        rootEntityId,
        fromEntityId: subjectId,
        toEntityId: targetId,
        tier: hopDepth,
        hsCodes,
      }),
      // The HS components this edge cites — spec §4.3: "HS components on
      // each edge" (plural), which is why every component of this hop is
      // kept here rather than collapsing to one representative HS code.
      attributes: { components } as unknown as Record<string, unknown>,
      targetEntity: {
        id: targetId,
        label: info.label,
        type: info.type ?? null,
        countries: info.countries ?? null,
      },
    };

    out.push({ field: SUPPLY_CHAIN_RELATIONSHIP_TYPE, entityId: targetId, edge, hopDepth });
    subjectId = targetId;
  });

  return out;
}

export type SupplyChainUpstreamResult = {
  enrichmentId: string;
  members: Awaited<ReturnType<typeof writeGraphPaths>>;
  truncated: boolean;
  reachable: number | null;
  pathsConsidered: number;
};

/**
 * Call 4 of the trade Job: `supplyChain.upstreamTradeTraversal`, raw path,
 * on the Category's six-digit HS `component`s and the forced-labour-origin/
 * sanctions `risk` stems, `maxDepth: 2`, `minDate` `TRADE_WINDOW_MONTHS`
 * back. Its own `sayari_supply_chain_upstream` Enrichment (never shared with
 * `sayari_trade_footprint` — see that enum value's own doc comment) plus
 * `graph_path` rows of `kind: 'supply_chain'`, `direction: 'upstream'`.
 *
 * One `graph_path` row per `data.paths[]` entry's own terminal (its last
 * resolvable segment), deduped by terminal entity id — the same `byId`
 * pattern `enrichFamily`/`enrichWatchlist` use for their own `paths` arrays
 * (`src/jobs/enrich.ts`): the first `path` entry to reach a given terminal
 * wins, and a second entry reaching the same terminal by a different route
 * is not written a second time.
 */
export async function runSupplyChainUpstreamTradeTraversal(
  ctx: EnrichContext,
  args: { entityId: string; component: readonly string[]; now?: Date },
): Promise<SupplyChainUpstreamResult> {
  const now = args.now ?? new Date();
  const minDate = supplyChainMinDate(now);
  const component = [...new Set(args.component)];
  const risk = [...SUPPLY_CHAIN_UPSTREAM_RISK_STEMS];

  const result = await ctx.upstream.sayari.upstreamTradeTraversal({
    id: args.entityId,
    component,
    risk,
    maxDepth: SUPPLY_CHAIN_UPSTREAM_MAX_DEPTH,
    minDate,
  });

  const enrichmentId = await recordEnrichment(ctx, {
    source: 'sayari_supply_chain_upstream',
    subjectKind: 'entity',
    subjectKey: args.entityId,
    requestParams: {
      entityId: args.entityId,
      component,
      risk,
      maxDepth: SUPPLY_CHAIN_UPSTREAM_MAX_DEPTH,
      minDate,
    },
    result,
  });

  const envelope = result.data as SayariUpstreamTradeTraversal;
  const paths = envelope.data?.paths ?? [];
  const entities = envelope.data?.entities ?? {};

  const byId = new Map<string, GraphPathWrite>();
  for (const path of paths) {
    const hops = summariseTradeTraversalPath(path, args.entityId, entities);
    const resolvable = hops.filter((hop) => hop.edge != null);
    if (resolvable.length === 0) continue;

    const last = resolvable[resolvable.length - 1]!;
    const terminalId = last.edge!.targetId;
    if (byId.has(terminalId)) continue;

    const edgeIds = await storeHopEdges(ctx, hops, { source: 'supplyChainUpstream' });
    byId.set(terminalId, {
      entity: toSyntheticEntity(terminalId, entities[terminalId]),
      hopDepth: last.hopDepth,
      edgeIds,
    });
  }

  /**
   * Coverage read straight off the envelope's own top-level `explored_count`/
   * `partial_results` (`UpstreamTradeTraversalResponse`'s own shape — unlike
   * `traversalSchemaInner`, these sit at the top, not nested under `data`).
   * No `next`/page-fill signal exists for this endpoint (no `limit`
   * param either), so — the same reasoning `findAndWriteShortestPath` gives
   * for its own coverage-free envelope — `truncated` tracks `partial_results`
   * alone rather than inferring anything from how many paths came back.
   */
  const apiPartial = envelope.partial_results === true;
  const truncated = apiPartial;
  const exploredCount = apiPartial ? null : (envelope.explored_count ?? null);

  const members = await writeGraphPaths(ctx.db, {
    rootEntityId: args.entityId,
    enrichmentId,
    kind: 'supply_chain',
    direction: 'upstream',
    members: [...byId.values()],
    coverage: { truncated, exploredCount, partialResults: apiPartial },
    discoveredByJob: ctx.jobId ?? null,
    source: 'supplyChainUpstream',
  });

  return { enrichmentId, members, truncated, reachable: exploredCount, pathsConsidered: paths.length };
}

// ── The Category's six-digit HS codes for one accepted Profile ─────────────

/**
 * Every distinct six-digit HS heading across every Category any accepted
 * Supplier settled on this entity id bids on — the `component` filter for
 * call 4.
 *
 * **Why every accepted match, not one.** `match.supplier_id` is unique but
 * `match.entity_id` is not (`pairs.ts`'s own doc comment: "a brand-name row
 * and a legal-entity row colliding is correct") — the same Profile can be
 * the settled answer for more than one Supplier row, each possibly bidding
 * a different Category. The trade Job is keyed on the entity id alone
 * (`subjectType: 'entity'`, matching `traverse`'s own convention — "one
 * company's own record"), so there is no single Category to prefer over
 * another; the union of every bid Category's HS lines is the complete,
 * honest answer to "what does this Profile's own supply chain need to be
 * checked against," and dropping a second Category's lines because only the
 * first was picked would silently narrow the filter for no reason a person
 * asked for.
 *
 * Six digits via `hsHeading` (`src/domain/hs-code.ts`) — the same widening
 * Discover already does to ask trade data a heading-level question, because
 * trade data (and this endpoint's own `component` filter) indexes HS at six
 * digits, not at a Category's authored eight/ten-digit line.
 *
 * Empty when no accepted match names this entity id, or no bid Category
 * carries an HS line yet — `runSupplyChainUpstreamTradeTraversal` still
 * runs in that case, filtered by `risk` alone (`hasPopulatedTradeTraversalFilter`,
 * `src/upstream/endpoints.ts`, still forces the raw path off `risk`), rather
 * than failing the whole Job over one Category's incomplete authoring.
 */
export async function loadCategoryHsHeadings(db: Database, entityId: string): Promise<string[]> {
  const matches = await db
    .select({ supplierId: t.match.supplierId })
    .from(t.match)
    .where(and(eq(t.match.entityId, entityId), eq(t.match.status, 'accepted')));
  if (matches.length === 0) return [];

  const supplierIds = matches.map((m) => m.supplierId);
  const categoryRows = await db
    .select({ categoryId: t.supplierCategory.categoryId })
    .from(t.supplierCategory)
    .where(inArray(t.supplierCategory.supplierId, supplierIds));
  if (categoryRows.length === 0) return [];

  const categoryIds = [...new Set(categoryRows.map((r) => r.categoryId))];
  const hsLineRows = await db
    .select({ hsCode: t.categoryHsLine.hsCode })
    .from(t.categoryHsLine)
    .where(inArray(t.categoryHsLine.categoryId, categoryIds));

  return [...new Set(hsLineRows.map((r) => hsHeading(r.hsCode)))];
}

// ── The whole Job ────────────────────────────────────────────────────────────

export type TradeJobResult = {
  footprintEnrichmentId: string;
  buyersEnrichmentId: string;
  shipmentsEnrichmentId: string;
  supplyChainEnrichmentId: string;
  footprintWritten: boolean;
  buyerCount: number;
  shipmentCount: number;
  supplyChainPathCount: number;
  supplyChainTruncated: boolean;
  componentHsCodes: string[];
};

/**
 * Runs the trade Job end to end: the four calls, in order, for one accepted
 * Profile's entity id.
 *
 * **No call budget kept here**, the same as `pairs`/`traverse`: exceeding
 * `JOB_CAPS.trade.toolCalls` throws `UpstreamCapExceededError` out of
 * whichever call is running, `runOneJob`'s catch (`src/worker/poll.ts`)
 * turns that into `terminated`, and every write already committed (a warm
 * `call()` cache makes a re-run of the completed calls free) stays written.
 */
export async function runTradeJob(
  ctx: EnrichContext,
  args: { entityId: string; now?: Date },
): Promise<TradeJobResult> {
  const footprint = await runTradeFootprint(ctx, { entityId: args.entityId, now: args.now });
  const componentHsCodes = await loadCategoryHsHeadings(ctx.db, args.entityId);
  const supplyChain = await runSupplyChainUpstreamTradeTraversal(ctx, {
    entityId: args.entityId,
    component: componentHsCodes,
    now: args.now,
  });

  return {
    footprintEnrichmentId: footprint.footprintEnrichmentId,
    buyersEnrichmentId: footprint.buyersEnrichmentId,
    shipmentsEnrichmentId: footprint.shipmentsEnrichmentId,
    supplyChainEnrichmentId: supplyChain.enrichmentId,
    footprintWritten: footprint.footprintWritten,
    buyerCount: footprint.buyerCount,
    shipmentCount: footprint.shipmentCount,
    supplyChainPathCount: supplyChain.members.length,
    supplyChainTruncated: supplyChain.truncated,
    componentHsCodes,
  };
}
