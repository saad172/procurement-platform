import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod/v4';
import * as t from '@/db/schema';
import { defineTool, type ReadWithWidget, type ToolContext, type WidgetType } from '../define';

/**
 * Families 1 and 2: page reads, and reads no page owns (SPEC §15.2).
 *
 * **Reads are page-shaped, not per-table and not generic.** A `query_db` tool
 * taking SQL was rejected because a SQL string can read anything, so
 * `surfaces` would stop gating — the field would still be there and would no
 * longer mean anything.
 *
 * Every chat-reachable read returns `{ data, widget }` **with no opt-out**: a
 * read that renders nothing is a number entering prose uncited.
 */

/**
 * Every chat-reachable read returns `{ data, widget }`, and the widget is named
 * after the **tool** rather than the shape — so the name cannot drift away from
 * what produced it.
 */
const widget = <T>(type: WidgetType, data: T, payload: unknown = data): ReadWithWidget<T> => ({
  data,
  widget: { type, payload },
});

// ── Family 1: page reads — thin wrappers over the query each page runs for SSR ─

export const getProgram = defineTool({
  name: 'get_program',
  description:
    'The sourcing programme: its plants, categories, weight vector, and how many suppliers are resolved, assessed or waiting on a person.',
  input: z.object({ programId: z.string() }),
  surfaces: ['chat', 'job', 'mcp'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => {
    const program = await ctx.db.query.program.findFirst({
      where: eq(t.program.id, input.programId),
      with: { plants: true, categories: true, weights: true },
    });
    if (!program) return { ok: false, objections: [`no programme with id ${input.programId}`] };

    // The eight suppliers that bid on no category are part of the programme's
    // shape, not a separate question — they walk the whole lifecycle and simply
    // reach no shortlist. Folding them in here keeps this read page-shaped
    // rather than adding a tool for one state.
    const uncategorised = await ctx.db
      .select({ id: t.supplier.id, rosterName: t.supplier.rosterName })
      .from(t.supplier)
      .leftJoin(t.supplierCategory, eq(t.supplierCategory.supplierId, t.supplier.id))
      .where(and(eq(t.supplier.programId, input.programId), isNull(t.supplierCategory.categoryId)));

    return { ok: true, data: widget('program_summary', { ...program, uncategorised }) };
  },
});

export const getCategory = defineTool({
  name: 'get_category',
  description: 'One category of a sourcing programme: its HS lines, its trade-action flags, and its bidders.',
  input: z.object({ categoryId: z.string() }),
  surfaces: ['chat', 'job', 'mcp'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => {
    const category = await ctx.db.query.category.findFirst({
      where: eq(t.category.id, input.categoryId),
      with: { hsLines: true, flags: true },
    });
    if (!category) return { ok: false, objections: [`no category with id ${input.categoryId}`] };
    return { ok: true, data: widget('category_summary', category) };
  },
});

export const getSupplier = defineTool({
  name: 'get_supplier',
  description:
    'One supplier: its roster row, its match and how it was settled, its resolved profile, its criterion values and its enrichments.',
  input: z.object({ supplierId: z.string() }),
  surfaces: ['chat', 'job', 'mcp'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => {
    const supplier = await ctx.db.query.supplier.findFirst({
      where: eq(t.supplier.id, input.supplierId),
      with: { categories: { with: { category: true } } },
    });
    if (!supplier) return { ok: false, objections: [`no supplier with id ${input.supplierId}`] };

    const match = await ctx.db.query.match.findFirst({
      where: eq(t.match.supplierId, supplier.id),
      with: { entity: true },
    });
    const criterionValues = await ctx.db
      .select()
      .from(t.criterionValue)
      .where(and(eq(t.criterionValue.supplierId, supplier.id), eq(t.criterionValue.isCurrent, true)));

    return { ok: true, data: widget('supplier_card', { supplier, match, criterionValues }) };
  },
});

/**
 * The Corporate family for one Supplier (SPEC §8.4).
 *
 * The badge has **three** states and the state names carry the decision:
 * *not covered* when the ownership graph returned nobody, *no exposure found*,
 * or *exposure found*. Collapsing the first into the second would report an
 * empty ownership graph in the same ink as a genuinely clean family.
 */
export const getSupplierFamily = defineTool({
  name: 'get_supplier_family',
  description:
    "A supplier's corporate family: the companies reachable downward through ownership, what risk they carry, and how much of the family was explored.",
  input: z.object({ supplierId: z.string() }),
  surfaces: ['chat', 'job', 'mcp'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => {
    const match = await ctx.db.query.match.findFirst({
      where: eq(t.match.supplierId, input.supplierId),
    });
    if (!match?.entityId) {
      return { ok: false, objections: ['this supplier has no accepted match, so it has no profile to hang a family off'] };
    }
    const members = await ctx.db
      .select({
        memberEntityId: t.familyMember.memberEntityId,
        hopDepth: t.familyMember.hopDepth,
        truncated: t.familyMember.truncated,
        exploredCount: t.familyMember.exploredCount,
        reachableCount: t.familyMember.reachableCount,
        discoveredByJob: t.familyMember.discoveredByJob,
        label: t.entity.label,
        country: t.entity.country,
        sanctioned: t.entity.sanctioned,
        risk: t.entity.risk,
      })
      .from(t.familyMember)
      .innerJoin(t.entity, eq(t.entity.id, t.familyMember.memberEntityId))
      .where(eq(t.familyMember.rootEntityId, match.entityId));

    /**
     * A **projection**, not the stored rows.
     *
     * SPEC §15.2 calls a page read a *thin wrapper over the query each page
     * already runs for SSR*, and a page renders a member's name, country and
     * risk badge — never the raw traversal path. Returning the rows wholesale
     * put ~870,000 tokens into one model turn and fired the assess Job's
     * token ceiling. The cap did its job; the read was the bug.
     */
    return {
      ok: true,
      data: widget('supplier_family', {
        entityId: match.entityId,
        explored: members.length,
        truncated: members.some((m) => m.truncated),
        members: members.map((m) => ({
          entityId: m.memberEntityId,
          label: m.label,
          country: m.country,
          hopDepth: m.hopDepth,
          sanctioned: m.sanctioned,
          // Factor NAMES and levels, which is what a badge needs. The full risk
          // object stays on the entity, one hop away.
          riskFactors: Object.entries((m.risk ?? {}) as Record<string, { level?: string }>).map(
            ([name, detail]) => ({ name, level: detail?.level ?? null }),
          ),
        })),
      }),
    };
  },
});

export const getEntity = defineTool({
  name: 'get_entity',
  description: 'One company as this application has stored it, from the Sayari entity graph.',
  input: z.object({ entityId: z.string() }),
  surfaces: ['chat', 'job', 'mcp'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => {
    const entity = await ctx.db.query.entity.findFirst({ where: eq(t.entity.id, input.entityId) });
    if (!entity) return { ok: false, objections: [`no stored entity ${input.entityId}`] };
    return { ok: true, data: widget('entity_card', entity) };
  },
});

export const getRecord = defineTool({
  name: 'get_record',
  description: 'One source record behind a company attribute — the bottom of a citation hop.',
  input: z.object({ recordId: z.string() }),
  surfaces: ['chat', 'job', 'mcp'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => {
    const record = await ctx.db.query.record.findFirst({ where: eq(t.record.id, input.recordId) });
    if (!record) return { ok: false, objections: [`no stored record ${input.recordId}`] };
    return { ok: true, data: widget('record_card', record) };
  },
});

// ── Family 2: reads no page owns ──────────────────────────────────────────────

/**
 * The Shortlist, computed by `score.ts` (SPEC §15.2).
 *
 * It carries **its weight vector as a rendered field**, which makes the freeze
 * legible rather than merely true: a person reading the widget can see which
 * ranking they are looking at.
 */
export const getShortlist = defineTool({
  name: 'get_shortlist',
  description:
    'The suppliers of one programme and category, ranked by score, with the weight vector that produced the ranking and the excluded block beneath it.',
  input: z.object({
    programId: z.string(),
    categoryId: z.string(),
    weights: z.record(z.string(), z.number()).optional().describe('A what-if vector; omit for the programme default'),
  }),
  surfaces: ['chat', 'job', 'mcp'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => {
    // The assembly lands with the pages in build-order step 11; the tool exists
    // now so the registry is complete and its invariants are real.
    const suppliers = await ctx.db
      .select()
      .from(t.supplierCategory)
      .where(eq(t.supplierCategory.categoryId, input.categoryId));
    return {
      ok: true,
      data: widget('shortlist_table', {
        programId: input.programId,
        categoryId: input.categoryId,
        weights: input.weights ?? null,
        bidderCount: suppliers.length,
      }),
    };
  },
});

/**
 * **The one question chat asks that no page asks** (SPEC §15.2).
 *
 * Comparing two Suppliers side by side has no page, so deriving the read
 * catalog from pages alone left the `criterion_compare` widget with no tool
 * that could return it. This is that tool.
 */
export const compareSuppliers = defineTool({
  name: 'compare_suppliers',
  description:
    'Two or more suppliers side by side on every criterion, with each raw input beside its value.',
  input: z.object({ supplierIds: z.array(z.string()).min(2).max(5), categoryId: z.string().optional() }),
  surfaces: ['chat', 'mcp'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => {
    const rows = await Promise.all(
      input.supplierIds.map(async (id) => ({
        supplier: await ctx.db.query.supplier.findFirst({ where: eq(t.supplier.id, id) }),
        values: await ctx.db
          .select()
          .from(t.criterionValue)
          .where(and(eq(t.criterionValue.supplierId, id), eq(t.criterionValue.isCurrent, true))),
      })),
    );
    return { ok: true, data: widget('criterion_compare', rows) };
  },
});

export const getTrace = defineTool({
  name: 'get_trace',
  description: "One job's trace: its turns, its tool calls, and why it stopped.",
  input: z.object({ jobId: z.string() }),
  surfaces: ['chat', 'mcp'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => {
    const turns = await ctx.db
      .select()
      .from(t.traceTurn)
      .where(eq(t.traceTurn.jobId, input.jobId))
      .orderBy(t.traceTurn.n);
    return { ok: true, data: widget('trace_timeline', turns) };
  },
});

export const listNeedsReview = defineTool({
  name: 'list_needs_review',
  description: 'The suppliers whose match the agents could not settle, and are waiting on a person.',
  input: z.object({ programId: z.string() }),
  surfaces: ['chat', 'mcp'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => {
    const rows = await ctx.db
      .select({ supplier: t.supplier, match: t.match })
      .from(t.supplier)
      .innerJoin(t.match, eq(t.match.supplierId, t.supplier.id))
      .where(and(eq(t.supplier.programId, input.programId), eq(t.match.status, 'needs_review')));
    return { ok: true, data: widget('needs_review_list', rows) };
  },
});

export const listLeads = defineTool({
  name: 'list_leads',
  description:
    'The companies Discover proposed for one category that are on no imported list, with their classification and shipment evidence.',
  input: z.object({ programId: z.string(), categoryId: z.string(), includeDismissed: z.boolean().optional() }),
  surfaces: ['chat', 'mcp'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => {
    const rows = await ctx.db
      .select()
      .from(t.lead)
      .where(
        input.includeDismissed
          ? and(eq(t.lead.programId, input.programId), eq(t.lead.categoryId, input.categoryId))
          : and(
              eq(t.lead.programId, input.programId),
              eq(t.lead.categoryId, input.categoryId),
              eq(t.lead.dismissed, false),
            ),
      );
    return { ok: true, data: widget('lead_table', rows) };
  },
});

/**
 * Usage (SPEC §18.1).
 *
 * **The two usage numbers are not the same kind of thing**, and this tool's
 * return value carries the scoping labels rather than the page render doing it
 * — because chat freezes the widget from the return, so a render-time label
 * would silently vanish when the same question is asked in chat.
 */
export const getUsage = defineTool({
  name: 'get_usage',
  description:
    "What this programme has spent, and separately what the Sayari account has used. The two are differently scoped and are never netted against each other.",
  input: z.object({ programId: z.string(), runId: z.string().optional() }),
  surfaces: ['chat', 'mcp'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => {
    const runs = await ctx.db.select().from(t.run).where(eq(t.run.programId, input.programId));
    return {
      ok: true,
      data: widget('usage_meter', {
        ours: { scope: 'This Programme', runs: runs.length },
        // The labels live here, not in the page, so asking in chat cannot lose
        // a caveat that navigating would have shown.
        sayari: {
          scope: 'Your Sayari account, rolling year',
          note: 'Account-wide and lagging. negativeNews has no bucket here at all.',
          dollars: null,
          dollarsNote: 'Sayari publishes no per-class price, so any credits-to-dollars figure would be one we invented.',
        },
        claudeNote: 'Computed from a committed price constant, not a bill.',
      }),
    };
  },
});

/** Job-only: the brief the assess loop argues from. */
export const getAssessmentBrief = defineTool({
  name: 'get_assessment_brief',
  description: "Everything one supplier's assessment is written from, as rows rather than prose.",
  input: z.object({ supplierId: z.string(), programId: z.string() }),
  surfaces: ['job'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => ({ ok: true, data: await briefFor(ctx, input.supplierId) }),
});

/**
 * Job-only: the brief the recommend loop argues from.
 *
 * **The analyst's brief carries row ids, not prose** (SPEC §10.2). A
 * Recommendation may not cite an Assessment, and citing agent prose would let
 * an unproven claim be inherited by reference.
 */
export const getRecommendationBrief = defineTool({
  name: 'get_recommendation_brief',
  description:
    'Everything one recommendation is written from: the shortlist, each supplier’s criterion values and verdict, as row ids rather than prose.',
  input: z.object({ programId: z.string(), categoryId: z.string() }),
  surfaces: ['job'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => {
    const bidders = await ctx.db
      .select({ supplierId: t.supplierCategory.supplierId })
      .from(t.supplierCategory)
      .where(eq(t.supplierCategory.categoryId, input.categoryId));
    const rows = await Promise.all(bidders.map((b) => briefFor(ctx, b.supplierId)));
    return { ok: true, data: { categoryId: input.categoryId, suppliers: rows } };
  },
});

async function briefFor(ctx: ToolContext, supplierId: string) {
  const supplier = await ctx.db.query.supplier.findFirst({ where: eq(t.supplier.id, supplierId) });
  const match = await ctx.db.query.match.findFirst({ where: eq(t.match.supplierId, supplierId) });
  const values = await ctx.db
    .select()
    .from(t.criterionValue)
    .where(and(eq(t.criterionValue.supplierId, supplierId), eq(t.criterionValue.isCurrent, true)));
  const latestAssessment = await ctx.db.query.assessment.findFirst({
    where: and(eq(t.assessment.supplierId, supplierId), eq(t.assessment.kind, 'standard')),
    with: { versions: { orderBy: [desc(t.assessmentVersion.n)], limit: 1 } },
  });
  return {
    supplierId,
    supplierName: supplier?.rosterName ?? '(promoted lead)',
    matchId: match?.id ?? null,
    matchStatus: match?.status ?? null,
    entityId: match?.entityId ?? null,
    // Row ids, so a sentence can cite them. Never the Assessment's prose.
    criterionValueIds: values.map((v) => ({ id: v.id, key: v.criterionKey, value: v.value })),
    latestAssessmentVersion: latestAssessment?.versions[0]
      ? {
          verdict: latestAssessment.versions[0].verdict,
          evaluatorOutcome: latestAssessment.versions[0].evaluatorOutcome,
        }
      : null,
  };
}

export const PAGE_READS = [getProgram, getCategory, getSupplier, getSupplierFamily, getEntity, getRecord];
export const OTHER_READS = [
  getShortlist,
  compareSuppliers,
  getTrace,
  listNeedsReview,
  listLeads,
  getUsage,
  getAssessmentBrief,
  getRecommendationBrief,
];
