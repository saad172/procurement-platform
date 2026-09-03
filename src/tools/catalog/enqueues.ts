import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod/v4';
import * as t from '@/db/schema';
import {
  DEEP_TRAVERSAL_MAX_HOPS,
  DEEP_TRAVERSAL_MAX_NODES,
  DEEP_TRAVERSAL_MAX_PAGES,
  DEEP_TRAVERSAL_PAGE_SIZE,
  DISCOVER_CLASSIFY_TOP_N,
  DOSSIER_BUDGET_USD,
} from '@/config/constants';
import { deepTraversalParamsSchema } from '@/domain/deep-traversal-params';
import { enqueueJob, openRun } from '@/jobs/runs';
import { isFullEntityFetch } from '@/upstream/params';
import { defineTool, type Estimate, type ToolContext } from '../define';

/**
 * Families 6 and 7: the job starts, and the one client tool (SPEC §15.2).
 *
 * **Seven `enqueue_*` tools, not one `enqueue_job(kind)`.** Each estimator is
 * materially different, `enqueue_dossier` must be flag-gated in a way a union
 * member cannot be, and a model picking `kind: 'dossier'` out of a union is a
 * worse-documented choice than picking a tool named for it.
 *
 * Every one of these is **chat-only and confirm-gated**. Chat proposes; the
 * page's own button and this tool enqueue the same Job.
 */

/**
 * Every estimator here **reads local rows only** — never a credit, never an
 * external call (SPEC §14.5).
 *
 * An estimator that spent to say what spending costs would also run *before*
 * the person consented, which is the one thing the gate exists to prevent.
 * Where it cannot know, `spends` carries a range or null **with a stated
 * reason**, never a fabricated point estimate.
 */
/**
 * Is **this entity's** `entity.getEntity` body already cached?
 *
 * **Keyed the way the call path keys it.** `call()` hashes
 * `{endpoint, params-after-defaults}` into `params_hash`, and `readCache()`
 * matches `(source, endpoint, params_hash)` (`src/upstream/call.ts`,
 * `src/upstream/hash.ts`). The `params` column holds exactly the canonical
 * params that hash was taken over (`src/db/schema/upstream.ts`), and for
 * `entity.getEntity` the only one that varies per entity is `id` — the other
 * eleven are `GET_ENTITY_LIMITS`, one fixed set applied to every call. So
 * `(source, endpoint, params->>'id')` selects the rows the hash selects.
 *
 * **Why the stored params and not `hashParams()` itself.** Re-deriving the key
 * needs `sayariGetEntity.defaults`, which lives in `src/upstream/endpoints.ts`
 * — a module that imports `@sayari/sdk`, the one import no file under
 * `src/tools/**` may make (chokepoint 1). Copying the eleven numbers down here
 * would manufacture precisely the estimator/caller disagreement that reusing
 * the helper exists to prevent, so this reads the params the caller stored
 * rather than re-deriving them.
 *
 * The gap that leaves, said rather than hidden: changing a default is a
 * *deliberate* cache miss (`src/upstream/hash.ts`), and until this entity is
 * re-fetched under the new key an old row still answers here. That over-reports
 * one entity as cached; it fabricates no figure, and it is still local rows
 * only.
 *
 * Before this, the `where` clause matched `endpoint` alone — so one stored
 * `getEntity` body anywhere in the database made **every** enrichment proposal
 * say *"cached — no credits, no wait"*, whichever entity it was about.
 *
 * **Full fetches only** (N2). A `getEntity` row can now be a relationship-
 * filtered read rather than the full body (SPEC §16.6's typed owner-edge
 * read widened the params it may carry); `isFullEntityFetch` is what tells
 * the two apart, so a filtered row cannot be mistaken for "the entity body
 * is cached" here. No live caller sends a filtered `getEntity` yet, so this
 * is latent rather than a behaviour change today.
 */
async function cachedUpstreamFor(ctx: ToolContext, entityId: string | null): Promise<boolean> {
  if (!entityId) return false;
  const rows = await ctx.db
    .select({ id: t.upstreamResponse.id, params: t.upstreamResponse.params })
    .from(t.upstreamResponse)
    .where(
      and(
        eq(t.upstreamResponse.source, 'sayari'),
        eq(t.upstreamResponse.endpoint, 'entity.getEntity'),
        sql`${t.upstreamResponse.params}->>'id' = ${entityId}`,
      ),
    );
  return rows.some((row) => isFullEntityFetch(row.params));
}

const VERSIONING_CAVEAT =
  'This always creates a new version, and the diff may be empty — "the weights changed and the argument did not" is itself a result.';
const FILTER_CAVEAT =
  'A recommendation is scoped by category and cannot be scoped by a filter, because a filtered set would exclude suppliers with no sentence saying why.';

const enqueueEnrichment = defineTool({
  name: 'enqueue_enrichment',
  enqueues: 'enrich',
  description:
    'Re-fetch the six enrichment sources for one supplier, and re-compute its criterion values.',
  input: z.object({ supplierId: z.string(), refresh: z.boolean().optional() }),
  surfaces: ['chat'],
  effect: 'write',
  spends: ['sayari', 'external'],
  latency: 'fast',
  confirm: async (input, ctx): Promise<Estimate> => {
    const match = await ctx.db.query.match.findFirst({
      where: eq(t.match.supplierId, input.supplierId),
    });
    const cached = !input.refresh && (await cachedUpstreamFor(ctx, match?.entityId ?? null));
    return {
      what: 'Fetch this supplier’s six enrichment sources and recompute its criterion values.',
      spends: { sayariCalls: cached ? 0 : { min: 3, max: 4 }, usd: 0 },
      basis: cached
        ? 'Every body this needs is already cached.'
        : 'Three Sayari calls (negative news, ownership family, watchlist) plus keyless external lookups. The exact count depends on which enrichments are already cached.',
      caveats: [],
      cached,
    };
  },
  handler: async (input, ctx) => {
    const supplier = await ctx.db.query.supplier.findFirst({
      where: eq(t.supplier.id, input.supplierId),
    });
    if (!supplier) return { ok: false, objections: [`no supplier with id ${input.supplierId}`] };
    // A new Run, so every amount spent is attributable — the knowingly-accepted
    // cost is a longer Runs list.
    const runId = await openRun(ctx.db, {
      programId: supplier.programId,
      trigger: 'reassess',
      subjectLabel: `enrich ${supplier.rosterName ?? supplier.id}`,
      supplierCount: 1,
    });
    const jobId = await enqueueJob(ctx.db, {
      runId,
      kind: 'enrich',
      subjectType: 'supplier',
      subjectId: supplier.id,
    });
    return { ok: true, data: { runId, jobId } };
  },
});

const enqueueReassess = defineTool({
  name: 'enqueue_reassess',
  enqueues: 'assess',
  description: 'Re-run the assessment for one supplier against the current numbers.',
  input: z.object({ supplierId: z.string() }),
  surfaces: ['chat'],
  effect: 'write',
  spends: ['model'],
  latency: 'fast',
  confirm: async (): Promise<Estimate> => ({
    what: 'Re-run this supplier’s assessment.',
    spends: { modelTokens: { min: 40_000, max: 450_000 }, usd: { min: 0.3, max: 3.0 } },
    basis:
      'Up to three proposer/evaluator rounds. The upper figure assumes it runs to the round ceiling; most do not.',
    caveats: [VERSIONING_CAVEAT],
  }),
  handler: async (input, ctx) => {
    const supplier = await ctx.db.query.supplier.findFirst({
      where: eq(t.supplier.id, input.supplierId),
    });
    if (!supplier) return { ok: false, objections: [`no supplier with id ${input.supplierId}`] };
    const runId = await openRun(ctx.db, {
      programId: supplier.programId,
      trigger: 'reassess',
      subjectLabel: `re-assess ${supplier.rosterName ?? supplier.id}`,
      supplierCount: 1,
    });
    const jobId = await enqueueJob(ctx.db, {
      runId,
      kind: 'assess',
      subjectType: 'supplier',
      subjectId: supplier.id,
    });
    return { ok: true, data: { runId, jobId } };
  },
});

const enqueueRerunRecommendation = defineTool({
  name: 'enqueue_rerun_recommendation',
  enqueues: 'recommend',
  description: 'Re-run the recommendation for one category against the current shortlist.',
  input: z.object({ programId: z.string(), categoryId: z.string() }),
  surfaces: ['chat'],
  effect: 'write',
  spends: ['model'],
  latency: 'fast',
  confirm: async (): Promise<Estimate> => ({
    what: 'Re-run this category’s recommendation.',
    spends: { modelTokens: { min: 60_000, max: 900_000 }, usd: { min: 0.5, max: 6.0 } },
    basis:
      'An analyst pass plus up to three lead/evaluator rounds. The upper figure assumes the round ceiling.',
    caveats: [VERSIONING_CAVEAT, FILTER_CAVEAT],
  }),
  handler: async (input, ctx) => {
    const runId = await openRun(ctx.db, {
      programId: input.programId,
      trigger: 'rerun_recommendation',
      subjectLabel: 'recommendation re-run',
      supplierCount: 1,
    });
    const jobId = await enqueueJob(ctx.db, {
      runId,
      kind: 'recommend',
      subjectType: 'category',
      subjectId: input.categoryId,
    });
    return { ok: true, data: { runId, jobId } };
  },
});

/**
 * A **Deep Traversal** — person-triggered, three hops, ~200 nodes.
 *
 * Distinct from the Corporate family, which is downward-only, psa-routed,
 * automatic and capped at 50. A Deep Traversal that reaches a subsidiary
 * downward writes a Path of the **same `kind: 'family'`** an automatic read
 * would, distinguished only by `discovered_by_job`; only an upward find is
 * `kind: 'deep_traversal'` (network spec §6, ticket 02).
 *
 * **Widened, optional inputs** (network spec §4.4): `relationships`,
 * `riskCategories`, `countries`, `minShares`, `sanctioned`, `pep`,
 * `excludeClosedEntities` — so a person can ask for *sanctioned owners within
 * three hops* rather than everything. All optional and defaultless, so
 * omitting them is the exact unfiltered walk this tool always ran; they are
 * carried into `job.params` at enqueue time and read back by
 * `traverse.ts`'s runner (`readDeepTraversalParams`).
 *
 * Its caveat is the one that matters most: it **changes no number**.
 */
const enqueueDeepTraversal = defineTool({
  name: 'enqueue_deep_traversal',
  enqueues: 'traverse',
  description: 'Expand one company’s ownership graph beyond the automatic single hop.',
  input: z
    .object({ entityId: z.string(), programId: z.string() })
    .extend(deepTraversalParamsSchema.shape),
  surfaces: ['chat'],
  effect: 'write',
  spends: ['sayari'],
  latency: 'fast',
  /**
   * **The estimate is arithmetic over the caps, not a guess.**
   *
   * It used to read *"one traversal call, plus a fetch for any node not already
   * stored"*, and both halves were wrong about what the Job does. There is no
   * per-node fetch at all — a traversal path terminal arrives as a full entity
   * with its `risk` block inline (SPEC §8.1), which is the measurement that made
   * the Corporate family cost one call rather than 25. And it is not one call:
   * the walk follows the cursor, 50 nodes to a page, in two directions.
   *
   * So the ceiling is `2 × ceil(maxNodes / pageSize)` — four pages down through
   * `traversal.ownership` and four up through `traversal.ubo` — and the floor is
   * two, one page each way, which is what a company with a small family and no
   * recorded owners costs. The two directions share the node cap, so the maximum
   * is a ceiling that a real walk rarely reaches rather than a forecast.
   *
   * Local rows only, and in fact no rows at all: the numbers are constants, so
   * this estimator cannot be the thing that spends before consent. The filter
   * fields change **which** nodes the walk finds, never how many calls the
   * caps allow, so they widen the `what` sentence and nothing in `spends`.
   */
  confirm: async (input): Promise<Estimate> => {
    const filters: string[] = [];
    if (input.relationships?.length) filters.push(`relationship types ${input.relationships.join(', ')}`);
    if (input.riskCategories?.length) filters.push(`risk categories ${input.riskCategories.join(', ')}`);
    if (input.countries?.length) filters.push(`countries ${input.countries.join(', ')}`);
    if (input.minShares != null) filters.push(`at least ${input.minShares}% shares`);
    if (input.sanctioned) filters.push('sanctioned entities only');
    if (input.pep) filters.push('PEP entities only');
    if (input.excludeClosedEntities) filters.push('excluding closed entities');

    return {
      what:
        `Expand this company’s ownership graph to ${DEEP_TRAVERSAL_MAX_HOPS} hops, up to ` +
        `${DEEP_TRAVERSAL_MAX_NODES} nodes, downward and upward` +
        (filters.length > 0 ? `, filtered to ${filters.join('; ')}.` : '.'),
      spends: { sayariCalls: { min: 2, max: DEEP_TRAVERSAL_MAX_PAGES * 2 } },
      basis:
        `Up to ${DEEP_TRAVERSAL_MAX_PAGES} downward pages and ${DEEP_TRAVERSAL_MAX_PAGES} upward pages ` +
        `of ${DEEP_TRAVERSAL_PAGE_SIZE} nodes each — the API's maximum page — stopping at the ` +
        `${DEEP_TRAVERSAL_MAX_NODES}-node cap the two directions share. Every node arrives as a full ` +
        'entity with its risk block, so no node costs a second call.',
      caveats: [
        'A deep traversal changes no score: ownership exposure is computed from current one-hop edges. What it can do is light the "new evidence" mark on a version that cites something it touches.',
        'It is capped, so it is never a complete family: what comes back is "n of m explored", and a company it does not reach is not a company it ruled out.',
        ...(filters.length > 0
          ? ['A filter changes which nodes the walk explores, not what a Path means once it finds one.']
          : []),
      ],
    };
  },
  handler: async (input, ctx) => {
    const { entityId, programId, ...params } = input;
    const runId = await openRun(ctx.db, {
      programId,
      trigger: 'traverse',
      subjectLabel: `traverse ${entityId}`,
      supplierCount: 1,
    });
    const jobId = await enqueueJob(ctx.db, {
      runId,
      kind: 'traverse',
      subjectType: 'entity',
      subjectId: entityId,
      params,
    });
    return { ok: true, data: { runId, jobId } };
  },
});

const enqueueDiscover = defineTool({
  name: 'enqueue_discover',
  enqueues: 'discover',
  description:
    'Search trade data for companies shipping this category’s HS lines that are on no imported list.',
  input: z.object({ programId: z.string(), categoryId: z.string() }),
  surfaces: ['chat'],
  effect: 'write',
  spends: ['sayari', 'model'],
  latency: 'fast',
  confirm: async (): Promise<Estimate> => ({
    what: `Search trade data for leads, and classify the top ${DISCOVER_CLASSIFY_TOP_N} by shipment count.`,
    spends: { sayariCalls: 1, modelTokens: { min: 20_000, max: 300_000 } },
    basis: `One trade call — the classifier costs no additional Sayari calls, because a trade result is already a full entity — plus ${DISCOVER_CLASSIFY_TOP_N} classifications.`,
    caveats: [
      'Trade data is noisy: on a measured category, nine of the top twenty-five counterparties were freight forwarders. The classifier is why, and it is not perfect.',
      'Discover proposes and never adds. Promoting a lead is a person’s act.',
    ],
  }),
  handler: async (input, ctx) => {
    const runId = await openRun(ctx.db, {
      programId: input.programId,
      trigger: 'discover',
      subjectLabel: 'discover leads',
      supplierCount: 1,
    });
    const jobId = await enqueueJob(ctx.db, {
      runId,
      kind: 'discover',
      subjectType: 'category',
      subjectId: input.categoryId,
    });
    return { ok: true, data: { runId, jobId } };
  },
});

/**
 * Flag-gated in a way a union member could not be (SPEC §15.2).
 *
 * `DOSSIER_ENABLED` is off in both environments, so this refuses rather than
 * silently enqueuing something the worker will not run.
 */
const enqueueDossier = defineTool({
  name: 'enqueue_dossier',
  enqueues: 'dossier',
  description:
    'Commission an in-depth research write-up on one supplier, cited like an assessment.',
  input: z.object({ supplierId: z.string() }),
  surfaces: ['chat'],
  effect: 'write',
  spends: ['model', 'sayari'],
  latency: 'fast',
  confirm: async (): Promise<Estimate> => ({
    what: 'Commission a dossier on this supplier.',
    spends: { usd: { min: 0.5, max: DOSSIER_BUDGET_USD } },
    basis: `Bounded by a $${DOSSIER_BUDGET_USD.toFixed(2)} session budget, with a tool-call backstop above it.`,
    caveats: [
      'A dossier’s trace is a timeline rather than a replayable record, because its context is rewritten server-side. It cannot drive the replay suite.',
    ],
  }),
  handler: async (input, ctx) => {
    if (process.env.DOSSIER_ENABLED !== 'true') {
      return {
        ok: false,
        objections: [
          'The dossier feature is switched off in this environment. Nothing was enqueued.',
        ],
      };
    }
    const supplier = await ctx.db.query.supplier.findFirst({
      where: eq(t.supplier.id, input.supplierId),
    });
    if (!supplier) return { ok: false, objections: [`no supplier with id ${input.supplierId}`] };
    const runId = await openRun(ctx.db, {
      programId: supplier.programId,
      trigger: 'dossier',
      subjectLabel: `dossier on ${supplier.rosterName ?? supplier.id}`,
      supplierCount: 1,
    });
    const jobId = await enqueueJob(ctx.db, {
      runId,
      kind: 'dossier',
      subjectType: 'supplier',
      subjectId: supplier.id,
    });
    return { ok: true, data: { runId, jobId } };
  },
});

/**
 * Settling a Match from chat (SPEC §6.8).
 *
 * Chat **may not start another resolver Round**, and it settles only by
 * enqueuing the same Job the page's button does. The settlement writes a **new**
 * `match_attempt`, so an override after an agent accept shows both settlements.
 */
const enqueueMatchSettlement = defineTool({
  name: 'enqueue_match_settlement',
  enqueues: 'resolve',
  description:
    'Settle a supplier’s match on a chosen company, or mark it not found. This enqueues the same job the Needs Review page’s button does.',
  input: z.object({
    supplierId: z.string(),
    entityId: z.string().nullable().describe('null marks the row not found'),
    note: z.string().optional(),
  }),
  surfaces: ['chat'],
  effect: 'write',
  spends: [],
  latency: 'fast',
  confirm: async (input, ctx): Promise<Estimate> => {
    const supplier = await ctx.db.query.supplier.findFirst({
      where: eq(t.supplier.id, input.supplierId),
    });
    return {
      what: input.entityId
        ? `Settle ${supplier?.rosterName ?? 'this supplier'} on entity ${input.entityId}.`
        : `Mark ${supplier?.rosterName ?? 'this supplier'} not found.`,
      spends: { sayariCalls: 0, modelTokens: 0 },
      basis:
        'Settling itself spends nothing. The enrichment and assessment it unblocks are separate jobs with their own estimates.',
      caveats: [
        'A settled match starts a new run, so the spend it unblocks is attributable to your decision.',
      ],
    };
  },
  handler: async (input, ctx) => {
    const supplier = await ctx.db.query.supplier.findFirst({
      where: eq(t.supplier.id, input.supplierId),
    });
    if (!supplier) return { ok: false, objections: [`no supplier with id ${input.supplierId}`] };
    const runId = await openRun(ctx.db, {
      programId: supplier.programId,
      trigger: 'settlement',
      subjectLabel: `settle ${supplier.rosterName ?? supplier.id}`,
      supplierCount: 1,
    });
    const jobId = await enqueueJob(ctx.db, {
      runId,
      kind: 'resolve',
      subjectType: 'supplier',
      subjectId: supplier.id,
    });
    return {
      ok: true,
      data: { runId, jobId, settlingTo: input.entityId, note: input.note ?? null },
    };
  },
});

// ── Family 7: the one client tool ────────────────────────────────────────────

/**
 * `navigate_to` renders a **clickable link**; the page never moves on its own
 * (SPEC §14.6).
 *
 * Because view state lives in the URL, *"set compliance to 40"* **is** a
 * navigation — which is why there is no `set_weights` tool. Adding one would
 * blur the single line between a what-if and the record.
 */
const navigateTo = defineTool({
  name: 'navigate_to',
  description:
    'Offer the person a link to a page and view state — including a different weight vector. It renders a link; it never moves the page.',
  input: z.object({
    pageRef: z.string().describe('A path, e.g. /program/{id}/category/{id}'),
    weights: z
      .record(z.string(), z.number())
      .optional()
      .describe('A what-if vector to put in the URL'),
    label: z.string().describe('What the link should say'),
  }),
  surfaces: ['chat'],
  effect: 'client',
  spends: [],
  latency: 'fast',
  handler: async (input) => {
    const query = input.weights
      ? `?${Object.entries(input.weights)
          .map(([k, v]) => `w.${k}=${v}`)
          .join('&')}`
      : '';
    return { ok: true, data: { href: `${input.pageRef}${query}`, label: input.label } };
  },
});

/** Chat's own supplier lookup by name, so a person need not paste an id. */
const findSupplierByName = defineTool({
  name: 'find_supplier_by_name',
  description: 'Find a supplier of this program by its roster name or part of it.',
  input: z.object({ programId: z.string(), nameContains: z.string() }),
  surfaces: ['chat', 'mcp'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => {
    const rows = await ctx.db
      .select()
      .from(t.supplier)
      .where(and(eq(t.supplier.programId, input.programId)));
    const needle = input.nameContains.toLowerCase();
    const matches = rows.filter((r) => (r.rosterName ?? '').toLowerCase().includes(needle));
    return {
      ok: true,
      data: {
        data: matches.map((m) => ({ id: m.id, name: m.rosterName, country: m.rosterCountry })),
        widget: { type: 'program_summary' as const, payload: matches.length },
      },
    };
  },
});

export const JOB_STARTS = [
  enqueueEnrichment,
  enqueueReassess,
  enqueueRerunRecommendation,
  enqueueDeepTraversal,
  enqueueDiscover,
  enqueueDossier,
  enqueueMatchSettlement,
];

export const CLIENT_TOOLS = [navigateTo];
export const EXTRA_READS = [findSupplierByName];
