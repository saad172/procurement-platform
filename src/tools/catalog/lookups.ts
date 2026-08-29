import { z } from 'zod/v4';
import { matchStrengthValue } from '@/upstream/projections/sayari';
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
  description: 'Fetch one company from Sayari by entity id, with its attributes, risk factors and relationships.',
  input: z.object({ entityId: z.string() }),
  surfaces: ['chat', 'job', 'mcp'],
  effect: 'read',
  spends: ['sayari'],
  latency: 'fast',
  confirm: spendOneSayariCall('Fetch this company from Sayari.'),
  handler: async (input, ctx) => {
    const r = await ctx.upstream.sayari.getEntity({ id: input.entityId });
    return { ok: true, data: sourceResult('Sayari entity', r.cacheHit, r.data) };
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
    const r = await ctx.upstream.sayari.negativeNews({ q: input.resolvedLegalName });
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
      hs_codes: input.hsCodes,
      arrival_country: input.arrivalCountries,
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
