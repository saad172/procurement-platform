import { z } from 'zod/v4';
import * as t from '@/db/schema';
import { matchStrengthValue } from '@/upstream/projections/sayari';
import { toEntityView } from '@/domain/entity-view';
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
      basis: 'One Sayari call. Sayari publishes no per-class price, so this is a call count and not a dollar figure.',
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
export const findCandidatesByNameTown = defineTool({
  name: 'find_candidates_by_name_town',
  description:
    'Search Sayari for companies matching this roster row by name and town, including legal-form and rename variants. Say why you are trying a variant.',
  input: z.object({
    nameVariant: z.string().describe('The name to try — a rename or legal-form variant is allowed'),
    whyThisVariant: z.string().describe('Why this term rather than the roster name. Recorded in the trace.'),
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
export const findCandidatesByAddress = defineTool({
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
export const findLeiByName = defineTool({
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
        zeroMeans: rows.length === 0 ? 'could not tell — GLEIF name search only matches the native-script primary name' : null,
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
    payload: { source, cacheHit, cachedNote: cacheHit ? 'cached — no credits, no wait' : null, payload },
  },
});

export const sayariResolve = defineTool({
  name: 'sayari_resolve',
  description: 'Resolve one or more company names, with optional address and country, against the Sayari graph.',
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
    return { ok: true, data: sourceResult('Sayari search', r.cacheHit, r.data.data ?? []) };
  },
});

export const sayariGetEntity = defineTool({
  name: 'sayari_get_entity',
  description:
    'Fetch one company from Sayari by entity id: identity, every address, identifiers, risk factors with their traversal paths, and relationship counts by type. Relationship rows are not included — use get_supplier_family for ownership.',
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

    return { ok: true, data: sourceResult('Sayari record', r.cacheHit, r.data) };
  },
});

export const sayariTraversal = defineTool({
  name: 'sayari_traversal',
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
export const sayariTradeSearch = defineTool({
  name: 'sayari_trade_search',
  description: 'Find companies shipping a given HS line into given arrival countries, from Sayari trade data.',
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

export const gleifSearchName = defineTool({
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

export const worldbankIndicator = defineTool({
  name: 'worldbank_indicator',
  description: 'One World Bank indicator for one country, at its most recent non-empty value.',
  input: z.object({ country: z.string(), indicator: z.string() }),
  surfaces: ['chat', 'mcp'],
  effect: 'read',
  spends: ['external'],
  latency: 'fast',
  confirm: spendOneFreeCall('Fetch this World Bank indicator.', 'The World Bank API'),
  handler: async (input, ctx) => {
    const r = await ctx.upstream.worldbank.indicator({ country: input.country, indicator: input.indicator });
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
  sayariTraversal,
  sayariNegativeNews,
  sayariTradeSearch,
  gleifJoinLei,
  gleifSearchName,
  worldbankIndicator,
  usitcTariff,
  nominatimGeocode,
];
