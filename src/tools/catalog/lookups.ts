import { z } from 'zod/v4';
import * as t from '@/db/schema';
import { matchStrengthValue } from '@/upstream/projections/sayari';
import { toEntityView } from '@/domain/entity-view';
import { toRecordView } from '@/domain/record-view';
import { defineTool, type Estimate, type ToolContext } from '../define';

/**
 * Families 3 and 4: the Match rung tools, and the raw lookups (SPEC §15.2).
 *
 * **Two lookup families, not one.** The Match loop gets **named rung tools with
 * the query baked in**, so a Trace records *which rung ran* rather than that a
 * search happened. Chat and MCP get the **raw source-prefixed tools**, because
 * "search Sayari for X" is the stdio user's whole reason for existing.
 *
 * One wrapper underneath both — `src/upstream/call()` — so neither family can
 * spend without caching.
 */

/**
 * Every chat-reachable spender is confirm-gated, and the estimator **reads
 * local rows only** (SPEC §14.5).
 *
 * It checks `upstream_response` first: on a `params_hash` hit the gate reads
 * *"cached — no credits, no wait"*, which is the difference between a gate
 * people read and a gate people click through.
 */
const spendOneSayariCall = (what: string) =>
  async function confirm(_input: unknown, _ctx: ToolContext): Promise<Estimate> {
    return {
      what,
      spends: { sayariCalls: 1 },
      basis:
        'One Sayari call. Sayari publishes no per-class price, so this is a call count and not a dollar figure.',
      caveats: [],
    };
  };

const spendOneFreeCall = (what: string, source: string) =>
  async function confirm(): Promise<Estimate> {
    return {
      what,
      spends: { sayariCalls: 0, usd: 0 },
      basis: `${source} is keyless and free; this costs a round trip and nothing else.`,
      caveats: [],
    };
  };

// ── Family 3: the four Match rung tools — job-only, query baked in ────────────

/**
 * Rung R2 (SPEC §6.5). Round 1 offers this and nothing else, so calling an R3
 * rung first is unrepresentable rather than tested for.
 */
const findCandidatesByNameTown = defineTool({
  name: 'find_candidates_by_name_town',
  description:
    'Search Sayari for companies matching this roster row by name and town, including legal-form and rename variants. Say why you are trying a variant.',
  input: z.object({
    nameVariant: z.string().describe('The name to try — a rename or legal-form variant is allowed'),
    whyThisVariant: z
      .string()
      .describe('Why this term rather than the roster name. Recorded in the trace.'),
  }),
  surfaces: ['job'],
  effect: 'read',
  spends: ['sayari'],
  latency: 'fast',
  handler: async (input, ctx) => {
    const result = await ctx.upstream.sayari.searchEntity({ q: input.nameVariant, limit: 10 });
    return {
      ok: true,
      data: (result.data.data ?? []).map((e) => ({
        entityId: e.id,
        label: e.label,
        countries: e.countries ?? [],
        addresses: e.addresses ?? [],
      })),
    };
  },
});

/**
 * Rung R3a — **address-only search**: who is really registered at the building.
 *
 * It exists because street agreement may never accept alone: an investment arm
 * sits at the exact roster address of its parent, and matching on the building
 * picks the wrong company.
 */
const findCandidatesByAddress = defineTool({
  name: 'find_candidates_by_address',
  description:
    'Search Sayari by address alone, to see which companies are registered at this building. Never sufficient on its own.',
  input: z.object({ address: z.string() }),
  surfaces: ['job'],
  effect: 'read',
  spends: ['sayari'],
  latency: 'fast',
  handler: async (input, ctx) => {
    const result = await ctx.upstream.sayari.searchEntity({ q: input.address, limit: 10 });
    return {
      ok: true,
      data: (result.data.data ?? []).map((e) => ({
        entityId: e.id,
        label: e.label,
        addresses: e.addresses ?? [],
      })),
    };
  },
});

/**
 * Rung R3b — GLEIF name search, **with its native-script limitation**.
 *
 * It hits only the native-script primary name, so several roster companies
 * return zero on an English search. A zero here is `unavailable`, never `fail`.
 */
const findLeiByName = defineTool({
  name: 'find_lei_by_name',
  description:
    'Search GLEIF by legal name. It matches only the native-script primary name, so a zero result means "could not tell", never "no such company".',
  input: z.object({ name: z.string(), country: z.string().optional() }),
  surfaces: ['job'],
  effect: 'read',
  spends: ['external'],
  latency: 'fast',
  handler: async (input, ctx) => {
    const result = await ctx.upstream.gleif.searchByName({
      name: input.name,
      ...(input.country ? { country: input.country } : {}),
    });
    const rows = result.data.data ?? [];
    return {
      ok: true,
      data: {
        found: rows.length,
        // Stated in the return value, so the model cannot read a zero as a
        // clean negative.
        zeroMeans:
          rows.length === 0
            ? 'could not tell — GLEIF name search only matches the native-script primary name'
            : null,
        records: rows.map((r) => ({
          lei: r.id,
          legalName: r.attributes?.entity?.legalName?.name ?? null,
          city: r.attributes?.entity?.legalAddress?.city ?? null,
          country: r.attributes?.entity?.legalAddress?.country ?? null,
        })),
      },
    };
  },
});

/**
 * Rung R3c — the **exact LEI join**, and the auto-accept gate's second witness.
 *
 * Its accepted consequence: a company with no LEI can never be auto-accepted.
 * That is the safe direction of failure, and the resulting count is a result to
 * report rather than a defect to fix.
 */
export const joinLei = defineTool({
  name: 'join_lei',
  description:
    'Look up one exact LEI in GLEIF and return its legal name and registered address. This join is decisive where it is available.',
  input: z.object({ lei: z.string() }),
  surfaces: ['job'],
  effect: 'read',
  spends: ['external'],
  latency: 'fast',
  handler: async (input, ctx) => {
    const result = await ctx.upstream.gleif.joinLei({ lei: input.lei });
    const entity = result.data.data?.attributes?.entity;
    return {
      ok: true,
      data: {
        lei: input.lei,
        legalName: entity?.legalName?.name ?? null,
        city: entity?.legalAddress?.city ?? null,
        country: entity?.legalAddress?.country ?? null,
        status: entity?.status ?? null,
      },
    };
  },
});

// ── Family 4: raw lookups — source-prefixed, for chat and MCP ─────────────────

/**
 * All nine raw lookups share **one `source_result` widget type** (SPEC §14.4).
 *
 * Deliberately: that family's content is *which upstream did we just pay for*,
 * and a single widget type makes the cache-hit line impossible to omit.
 */
/** A date Sayari may or may not have supplied, and may have supplied unparseably. */
const parseDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const sourceResult = (source: string, cacheHit: boolean, payload: unknown) => ({
  data: payload,
  widget: {
    type: 'source_result' as const,
    payload: {
      source,
      cacheHit,
      cachedNote: cacheHit ? 'cached — no credits, no wait' : null,
      payload,
    },
  },
});

export const sayariResolve = defineTool({
  name: 'sayari_resolve',
  description:
    'Resolve one or more company names, with optional address and country, against the Sayari graph.',
  input: z.object({
    names: z.array(z.string()).min(1),
    addresses: z.array(z.string()).optional(),
    countries: z.array(z.string()).optional(),
  }),
  surfaces: ['chat', 'mcp'],
  effect: 'read',
  spends: ['sayari'],
  latency: 'fast',
  confirm: spendOneSayariCall('Resolve these names against the Sayari entity graph.'),
  handler: async (input, ctx) => {
    const r = await ctx.upstream.sayari.resolve({
      body: {
        name: input.names,
        ...(input.addresses ? { address: input.addresses } : {}),
        ...(input.countries ? { country: input.countries } : {}),
      },
    });
    return {
      ok: true,
      data: sourceResult(
        'Sayari resolution',
        r.cacheHit,
        (r.data.data ?? []).map((c) => ({
          entityId: c.entity_id,
          label: c.label,
          score: c.score,
          // Uniform across every candidate in one query: it grades the query,
          // not the candidates.
          matchStrength: matchStrengthValue(c.match_strength),
        })),
      ),
    };
  },
});

export const sayariSearchEntity = defineTool({
  name: 'sayari_search_entity',
  description: 'Free-text search of the Sayari entity graph.',
  input: z.object({ q: z.string(), limit: z.number().int().min(1).max(50).optional() }),
  surfaces: ['chat', 'mcp'],
  effect: 'read',
  spends: ['sayari'],
  latency: 'fast',
  confirm: spendOneSayariCall('Search the Sayari entity graph.'),
  handler: async (input, ctx) => {
    const r = await ctx.upstream.sayari.searchEntity({ q: input.q, limit: input.limit ?? 10 });
    // Projected per result, same as `sayari_get_entity` below — a pick-list
    // has no use for a full entity's worth of attributes and relationships
    // per row, only enough to tell candidates apart.
    return {
      ok: true,
      data: sourceResult('Sayari search', r.cacheHit, (r.data.data ?? []).map(toEntityView)),
    };
  },
});

export const sayariGetEntity = defineTool({
  name: 'sayari_get_entity',
  description:
    'Fetch one company from Sayari by entity id: identity, every address, identifiers, risk factors with their traversal paths, and relationship counts by type. Relationship rows are not included — use get_supplier_network for its Network.',
  input: z.object({ entityId: z.string() }),
  surfaces: ['chat', 'job', 'mcp'],
  effect: 'read',
  spends: ['sayari'],
  latency: 'fast',
  confirm: spendOneSayariCall('Fetch this company from Sayari.'),
  handler: async (input, ctx) => {
    const r = await ctx.upstream.sayari.getEntity({ id: input.entityId });
    // Projected, not raw. A whole entity is a graph node with every edge
    // attached — see `toEntityView` for the 703,956-token turn that earned this.
    return { ok: true, data: sourceResult('Sayari entity', r.cacheHit, toEntityView(r.data)) };
  },
});

export const sayariGetRecord = defineTool({
  name: 'sayari_get_record',
  description:
    'Fetch one source record from Sayari by record id. Needed before a citation can point at a record, because a record id seen inside an entity has no local row until something fetches it.',
  input: z.object({ recordId: z.string() }),
  surfaces: ['chat', 'job', 'mcp'],
  effect: 'read',
  spends: ['sayari'],
  latency: 'fast',
  confirm: spendOneSayariCall('Fetch this source record from Sayari.'),
  handler: async (input, ctx) => {
    const r = await ctx.upstream.sayari.getRecord({ id: input.recordId });

    /**
     * **Stored, because this tool's whole reason for existing is that it
     * stores.**
     *
     * Its description says a record id *"has no local row until something
     * fetches it"* — and nothing wrote to `record`, anywhere in the codebase.
     * So a Citation carrying `recordId` could never resolve: `resolveCitations`
     * looks the row up, finds nothing, and objects. The one tool that exists to
     * make a record citable did not make it citable.
     *
     * Upserted rather than inserted, and `first_seen_at` is left alone on
     * conflict — the staleness rule attaches evidence **by subject**, so
     * re-fetching the same record is a refresh and not new evidence
     * (SPEC §12.1).
     */
    const row = r.data;

    /**
     * **Keyed by the id we asked for, not the one echoed back.**
     *
     * The same record has two spellings. Inside an entity's attributes it is a
     * plain path — `66dfe…/{93635462-…}/1672531200000` — and that is the one a
     * model can see and therefore the one a Citation will carry. `getRecord`
     * returns it **percent-encoded**: `66dfe…%2F%7B93635462-…%7D%2F1672531200000`.
     *
     * Storing the echoed form would key the row by a string no Citation ever
     * mentions, so `resolveCitations` would find nothing and object — the tool
     * would fetch the record and still leave it uncitable, which is the exact
     * failure it exists to prevent.
     */
    await ctx.db
      .insert(t.record)
      .values({
        id: input.recordId,
        source: row.source ?? null,
        sourceLabel: row.label ?? null,
        publishedAt: parseDate(row.publication_date),
        collectedAt: parseDate(row.acquisition_date),
        fields: row as never,
        fetchedAt: r.fetchedAt,
      })
      .onConflictDoUpdate({
        target: t.record.id,
        set: {
          source: row.source ?? null,
          sourceLabel: row.label ?? null,
          publishedAt: parseDate(row.publication_date),
          collectedAt: parseDate(row.acquisition_date),
          fields: row as never,
          fetchedAt: r.fetchedAt,
        },
      });

    // Projected, not raw — a record's own `references` block embeds every
    // entity it mentions in full, and nothing downstream reads it. This
    // tool's actual job is making the record id locally citable, which the
    // upsert above already did; the value returned to the model only needs
    // enough to describe and cite the record, so it gets `toRecordView`
    // instead of the raw body. The full row, references included, is what
    // got stored above.
    return { ok: true, data: sourceResult('Sayari record', r.cacheHit, toRecordView(r.data)) };
  },
});

/**
 * Named for what it calls (network spec §9 renames row 4) — `sayari_traversal`
 * called `ctx.upstream.sayari.ownership`, a raw source-prefixed tool naming
 * the raw-fallback endpoint rather than the SDK method it wraps was the one
 * mismatch left after ticket 02 added `sayari.watchlist` beside it.
 */
export const sayariOwnership = defineTool({
  name: 'sayari_ownership',
  description: 'Walk the ownership graph downward from one company.',
  input: z.object({ entityId: z.string(), limit: z.number().int().min(1).max(200).optional() }),
  surfaces: ['job', 'mcp'],
  effect: 'read',
  spends: ['sayari'],
  latency: 'slow',
  handler: async (input, ctx) => {
    const r = await ctx.upstream.sayari.ownership({ id: input.entityId, limit: input.limit ?? 50 });
    return { ok: true, data: sourceResult('Sayari ownership traversal', r.cacheHit, r.data) };
  },
});

/**
 * Paths to Listed entities, in either direction (network spec §4.1, §9).
 *
 * Modelled closely on `sayariOwnership` beside it: same shape, same slow-tool
 * placement (job/mcp only, confirm-gated implicitly by being barred from
 * chat), same raw `sourceResult` passthrough — `ctx.upstream.sayari.watchlist`
 * already carries its own envelope and caching through `call()`, so this tool
 * is a thin wrapper exactly like its neighbour.
 */
export const sayariWatchlist = defineTool({
  name: 'sayari_watchlist',
  description: 'Walk the watchlist graph from one company, either direction, to Listed entities.',
  input: z.object({ entityId: z.string(), limit: z.number().int().min(1).max(200).optional() }),
  surfaces: ['job', 'mcp'],
  effect: 'read',
  spends: ['sayari'],
  latency: 'slow',
  handler: async (input, ctx) => {
    const r = await ctx.upstream.sayari.watchlist({ id: input.entityId, limit: input.limit ?? 50 });
    return { ok: true, data: sourceResult('Sayari watchlist traversal', r.cacheHit, r.data) };
  },
});

/**
 * The two-entity walk Concentration runs at submission (network spec §4.2,
 * §7; ticket 04) — `entities: [source, target]`, exposed here on demand for a
 * job or the MCP surface. Named for what it calls, same as `sayariOwnership`/
 * `sayariWatchlist` beside it (network spec §9 renames row 4).
 *
 * Job and mcp surfaces only, same restricted set as `sayariOwnership`/
 * `sayariWatchlist` — this is not a chat tool (ticket 04's own "job and mcp
 * surfaces" wording).
 *
 * `entityIdA`/`entityIdB` rather than `source`/`target`: no existing
 * two-entity-shaped tool in this file to match, and `source`/`target` already
 * name specific columns on `graph_path` (`root_entity_id`/`terminal_entity_id`
 * there, `Path`-rooted-at-a-Profile), which a generic two-entity lookup does
 * not presuppose. Order is preserved into `entities` — `entityIdA` first, as
 * the source `ctx.upstream.sayari.shortestPath` sends.
 */
export const sayariShortestPath = defineTool({
  name: 'sayari_shortest_path',
  description: 'Find the shortest path between two entities in the Sayari graph.',
  input: z.object({ entityIdA: z.string(), entityIdB: z.string() }),
  surfaces: ['job', 'mcp'],
  effect: 'read',
  spends: ['sayari'],
  latency: 'slow',
  handler: async (input, ctx) => {
    const r = await ctx.upstream.sayari.shortestPath({
      entities: [input.entityIdA, input.entityIdB],
    });
    return { ok: true, data: sourceResult('Sayari shortest path', r.cacheHit, r.data) };
  },
});

/**
 * `trade.searchBuyers` by `filter.supplierId` (network spec §4.3, §9;
 * ticket 05) — the customer list, with each buyer's risk and country. The
 * trade Job's own second automatic call runs this unconditionally at
 * `limit: 50`; this tool exposes the identical read on demand for a job or
 * the MCP surface, `limit` left an optional knob the same way `sayari_
 * ownership`/`sayari_watchlist` leave theirs open beside their own baked-in
 * read.
 *
 * `sayari_trade_search` beside this wraps the same underlying
 * `trade.searchSuppliers` **endpoint** keyed by HS line and arrival country,
 * for Discover — genuinely a different call (`searchSuppliers`, not
 * `searchBuyers`) answering a different question (*who ships this line
 * anywhere* vs. *who buys from this one supplier*), so this is a new tool
 * rather than a second name for the same wrapper.
 *
 * Modelled closely on `sayariOwnership`/`sayariShortestPath` above: same
 * restricted `surfaces`, no `confirm` (job/mcp-only, so boot invariant 9
 * would refuse a tool nobody in chat ever sees one), same thin
 * `sourceResult` passthrough. **`ctx.upstream.sayari.tradeSearchBuyers` does
 * not exist on this branch's base yet** — unit 05b's `upstream/index.ts`
 * wiring has not landed as of this writing. Written against the sugar name
 * every other lookup tool in this file uses regardless, on the same
 * reasoning `sayariShortestPath`'s own doc comment gives for ticket 04's
 * identical situation (it also depended on another unit's endpoint landing
 * first, and was written against `ctx.upstream.sayari.shortestPath`
 * directly rather than `ENDPOINTS.*`) — this resolves once both units' PRs
 * land into `wave5-integration`, in either order.
 */
export const sayariSearchBuyers = defineTool({
  name: 'sayari_search_buyers',
  description:
    'Sayari trade buyers for one supplier: the customer list with each buyer’s risk and country.',
  input: z.object({
    supplierId: z.string(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  surfaces: ['job', 'mcp'],
  effect: 'read',
  spends: ['sayari'],
  latency: 'slow',
  handler: async (input, ctx) => {
    const r = await ctx.upstream.sayari.tradeSearchBuyers({
      supplierId: [input.supplierId],
      limit: input.limit ?? 50,
    });
    return { ok: true, data: sourceResult('Sayari trade buyers', r.cacheHit, r.data.data ?? []) };
  },
});

/**
 * `trade.searchShipments` by `filter.supplierId` (network spec §4.3, §9;
 * ticket 05) — dated, citable shipment rows: buyer, product origin, value,
 * weight, `record`. The trade Job's own third automatic call runs this
 * unconditionally at `limit: 50`, filtered to the trailing 24 months via
 * `filter.arrivalDate`; this tool exposes the same read on demand, the date
 * window left an optional knob rather than baked in — a job or MCP caller
 * may want a different window than the automatic one, the same way `sayari_
 * ownership`/`sayari_watchlist` leave `limit` open beside their own
 * baked-in read.
 *
 * `arrivalDate` is the wire shape verbatim (`sayariTradeSearchShipments`'s
 * own doc comment in `src/upstream/endpoints.ts`): a single `"<from>|<to>"`
 * range string, or one date — built by the caller, not parsed here, the same
 * division `sayariTradeSearchShipments` itself keeps.
 *
 * Same dependency note as `sayariSearchBuyers` above: written against
 * `ctx.upstream.sayari.tradeSearchShipments`, which does not exist on this
 * branch's base yet.
 */
export const sayariSearchShipments = defineTool({
  name: 'sayari_search_shipments',
  description:
    'Sayari trade shipments for one supplier: dated rows with buyer, product origin, value, weight and record.',
  input: z.object({
    supplierId: z.string(),
    arrivalDate: z
      .string()
      .optional()
      .describe(
        'A "<from>|<to>" range, or a single date — Sayari’s own TradeFilterList.arrivalDate shape.',
      ),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  surfaces: ['job', 'mcp'],
  effect: 'read',
  spends: ['sayari'],
  latency: 'slow',
  handler: async (input, ctx) => {
    const r = await ctx.upstream.sayari.tradeSearchShipments({
      supplierId: [input.supplierId],
      ...(input.arrivalDate ? { arrivalDate: input.arrivalDate } : {}),
      limit: input.limit ?? 50,
    });
    return {
      ok: true,
      data: sourceResult('Sayari trade shipments', r.cacheHit, r.data.data ?? []),
    };
  },
});

/**
 * `supplyChain.upstreamTradeTraversal` (network spec §4.3, §5, §9; ticket
 * 05) — upstream tiers, filtered by HS `component` and `risk` stems. The
 * trade Job's own fourth automatic call always populates `component` (the
 * Category's six-digit HS codes) and `risk` (forced-labour-origin and
 * sanctions stems), per spec §4.3; this tool exposes the same endpoint
 * on demand with every filter optional, matching the endpoint's own
 * `SupplyChainUpstreamTradeTraversalParams` shape (`src/upstream/
 * endpoints.ts`) rather than the trade Job's narrower always-populated call
 * — a job or MCP caller may reasonably want an unfiltered walk, and the
 * endpoint itself accepts one.
 *
 * `entityId` names the field the way `sayariOwnership`/`sayariWatchlist`/
 * `sayariShortestPath` above name theirs, rather than the endpoint's own
 * `id` — this file's own established convention for a raw lookup wrapping a
 * traversal endpoint keyed on one entity.
 *
 * Same dependency note as the two tools above: written against
 * `ctx.upstream.sayari.upstreamTradeTraversal`, the sugar name this file's
 * naming convention implies (`supplyChain.upstreamTradeTraversal` losing its
 * namespace prefix, the same way `traversal.ownership`/`traversal.watchlist`
 * lose theirs to become `ownership`/`watchlist` above) — it does not exist
 * on this branch's base yet, and this is the best-guess, documented name
 * this ticket's own brief asked for in that case; it resolves, possibly
 * under a different name if 05b chose one, once both units' PRs land into
 * `wave5-integration`.
 */
export const sayariUpstream = defineTool({
  name: 'sayari_upstream',
  description:
    'Walk Sayari’s upstream supply chain from one company, filtered by HS component and risk stem.',
  input: z.object({
    entityId: z.string(),
    component: z
      .array(z.string())
      .optional()
      .describe('Six-digit HS headings — a Category’s HS lines, widened.'),
    risk: z
      .array(z.string())
      .optional()
      .describe('Risk stems, e.g. the forced-labour-origin and sanctions stems.'),
    countries: z.array(z.string()).optional(),
    maxDepth: z.number().int().min(1).optional(),
    minDate: z.string().optional(),
  }),
  surfaces: ['job', 'mcp'],
  effect: 'read',
  spends: ['sayari'],
  latency: 'slow',
  handler: async (input, ctx) => {
    const r = await ctx.upstream.sayari.upstreamTradeTraversal({
      id: input.entityId,
      ...(input.component ? { component: input.component } : {}),
      ...(input.risk ? { risk: input.risk } : {}),
      ...(input.countries ? { countries: input.countries } : {}),
      ...(input.maxDepth != null ? { maxDepth: input.maxDepth } : {}),
      ...(input.minDate ? { minDate: input.minDate } : {}),
    });
    return {
      ok: true,
      data: sourceResult('Sayari upstream supply chain', r.cacheHit, r.data),
    };
  },
});

/** 7–15 s measured, so `slow`, so barred from chat by boot invariant 5. */
export const sayariNegativeNews = defineTool({
  name: 'sayari_negative_news',
  description:
    'Sayari negative news for one company name. It takes a BARE NAME, so it must be called with a resolved legal name — disambiguation is ours.',
  input: z.object({ resolvedLegalName: z.string() }),
  surfaces: ['job', 'mcp'],
  effect: 'read',
  spends: ['sayari'],
  latency: 'slow',
  handler: async (input, ctx) => {
    const r = await ctx.upstream.sayari.negativeNews({ name: input.resolvedLegalName });
    return { ok: true, data: sourceResult('Sayari negative news', r.cacheHit, r.data.data ?? []) };
  },
});

/** 3.6–13.4 s measured. Slow WITHOUT fanning out — the case one enum missed. */
const sayariTradeSearch = defineTool({
  name: 'sayari_trade_search',
  description:
    'Find companies shipping a given HS line into given arrival countries, from Sayari trade data.',
  input: z.object({
    hsCodes: z.array(z.string()).min(1),
    arrivalCountries: z.array(z.string()).min(1),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  surfaces: ['job', 'mcp'],
  effect: 'read',
  spends: ['sayari'],
  latency: 'slow',
  handler: async (input, ctx) => {
    const r = await ctx.upstream.sayari.tradeSearchSuppliers({
      hsCodes: input.hsCodes,
      arrivalCountries: input.arrivalCountries,
      limit: input.limit ?? 100,
    });
    return { ok: true, data: sourceResult('Sayari trade', r.cacheHit, r.data.data ?? []) };
  },
});

export const gleifJoinLei = defineTool({
  name: 'gleif_join_lei',
  description: 'Look up one exact LEI in GLEIF.',
  input: z.object({ lei: z.string() }),
  surfaces: ['chat', 'mcp'],
  effect: 'read',
  spends: ['external'],
  latency: 'fast',
  confirm: spendOneFreeCall('Look up this LEI in GLEIF.', 'GLEIF'),
  handler: async (input, ctx) => {
    const r = await ctx.upstream.gleif.joinLei({ lei: input.lei });
    return { ok: true, data: sourceResult('GLEIF', r.cacheHit, r.data.data) };
  },
});

const gleifSearchName = defineTool({
  name: 'gleif_search_name',
  description:
    'Search GLEIF by legal name. Matches only the native-script primary name, so a zero result means "could not tell".',
  input: z.object({ name: z.string(), country: z.string().optional() }),
  surfaces: ['chat', 'mcp'],
  effect: 'read',
  spends: ['external'],
  latency: 'fast',
  confirm: spendOneFreeCall('Search GLEIF by name.', 'GLEIF'),
  handler: async (input, ctx) => {
    const r = await ctx.upstream.gleif.searchByName({
      name: input.name,
      ...(input.country ? { country: input.country } : {}),
    });
    return { ok: true, data: sourceResult('GLEIF', r.cacheHit, r.data.data ?? []) };
  },
});

const worldbankIndicator = defineTool({
  name: 'worldbank_indicator',
  description: 'One World Bank indicator for one country, at its most recent non-empty value.',
  input: z.object({ country: z.string(), indicator: z.string() }),
  surfaces: ['chat', 'mcp'],
  effect: 'read',
  spends: ['external'],
  latency: 'fast',
  confirm: spendOneFreeCall('Fetch this World Bank indicator.', 'The World Bank API'),
  handler: async (input, ctx) => {
    const r = await ctx.upstream.worldbank.indicator({
      country: input.country,
      indicator: input.indicator,
    });
    return { ok: true, data: sourceResult('World Bank', r.cacheHit, r.data) };
  },
});

export const usitcTariff = defineTool({
  name: 'usitc_tariff',
  description:
    'The US general (MFN) duty rate for one HS line. Ask at 8 or 10 digits: a 6-digit heading can span Free to several percent.',
  input: z.object({ hsCode: z.string() }),
  surfaces: ['chat', 'mcp'],
  effect: 'read',
  spends: ['external'],
  latency: 'fast',
  confirm: spendOneFreeCall('Look up this HS line at USITC.', 'The USITC HTS API'),
  handler: async (input, ctx) => {
    const r = await ctx.upstream.usitc.tariff({ hsCode: input.hsCode });
    return { ok: true, data: sourceResult('USITC HTS', r.cacheHit, r.data) };
  },
});

export const nominatimGeocode = defineTool({
  name: 'nominatim_geocode',
  description:
    'Geocode one address, recording the precision level reached. A city centroid is not a factory, and the level says which you got.',
  input: z.object({ address: z.string() }),
  surfaces: ['chat', 'mcp'],
  effect: 'read',
  spends: ['external'],
  latency: 'fast',
  confirm: spendOneFreeCall('Geocode this address.', 'Nominatim'),
  handler: async (input, ctx) => {
    const r = await ctx.upstream.nominatim.geocode({ q: input.address });
    return { ok: true, data: sourceResult('Nominatim', r.cacheHit, r.data) };
  },
});

export const MATCH_RUNG_TOOLS = [
  findCandidatesByNameTown,
  findCandidatesByAddress,
  findLeiByName,
  joinLei,
];

export const RAW_LOOKUPS = [
  sayariResolve,
  sayariSearchEntity,
  sayariGetEntity,
  sayariGetRecord,
  sayariOwnership,
  sayariWatchlist,
  sayariShortestPath,
  sayariNegativeNews,
  sayariTradeSearch,
  sayariSearchBuyers,
  sayariSearchShipments,
  sayariUpstream,
  gleifJoinLei,
  gleifSearchName,
  worldbankIndicator,
  usitcTariff,
  nominatimGeocode,
];
