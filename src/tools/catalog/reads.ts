import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod/v4';
import * as t from '@/db/schema';
import { isDatabaseId, notAnIdObjection } from '../ids';
import { defineTool, type ReadWithWidget, type ToolContext, type WidgetType } from '../define';
import { loadShortlist } from '@/db/queries/shortlist';
import { DEFAULT_WEIGHTS, normaliseWeights } from '@/domain/score';
import { parseRiskObject } from '@/domain/scoring/risk-factors';
import { isWhatIf, parseViewState } from '@/lib/view-state';

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

const getProgram = defineTool({
  name: 'get_program',
  description:
    'The sourcing program: its plants, categories, weight vector, and how many suppliers are resolved, assessed or waiting on a person.',
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
    if (!program) return { ok: false, objections: [`no program with id ${input.programId}`] };

    // The eight suppliers that bid on no category are part of the program's
    // shape, not a separate question — they walk the whole lifecycle and simply
    // reach no shortlist. Folding them in here keeps this read page-shaped
    // rather than adding a tool for one state.
    const uncategorised = await ctx.db
      .select({ id: t.supplier.id, rosterName: t.supplier.rosterName })
      .from(t.supplier)
      .leftJoin(t.supplierCategory, eq(t.supplierCategory.supplierId, t.supplier.id))
      .where(and(eq(t.supplier.programId, input.programId), isNull(t.supplierCategory.categoryId)))
      .orderBy(asc(t.supplier.rosterIndex));

    return { ok: true, data: widget('program_summary', { ...program, uncategorised }) };
  },
});

const getCategory = defineTool({
  name: 'get_category',
  description:
    'One category of a sourcing program: its HS lines, its trade-action flags, and its bidders.',
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

const getSupplier = defineTool({
  name: 'get_supplier',
  description:
    'One supplier: its roster row, its match and how it was settled, its resolved profile, its criterion values and its enrichments.',
  input: z.object({ supplierId: z.string() }),
  surfaces: ['chat', 'job', 'mcp'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => {
    // Checked before the query, because Postgres answers a non-uuid with a
    // thrown type error rather than an empty result.
    if (!isDatabaseId(input.supplierId)) {
      return {
        ok: false,
        objections: [notAnIdObjection('supplier id', input.supplierId, 'find_supplier_by_name')],
      };
    }

    const loaded = await loadSupplierCard(ctx, input.supplierId);
    if (!loaded) return { ok: false, objections: [`no supplier with id ${input.supplierId}`] };

    const forModel = projectSupplierCard(loaded);

    // `widget(type, data, payload)` — `data` is what the MODEL reads, `payload`
    // is what the widget renders for a person. They are not the same thing here.
    return { ok: true, data: widget('supplier_card', forModel, loaded) };
  },
});

/** The rows `get_supplier`'s widget and model projection are both built from. */
async function loadSupplierCard(ctx: ToolContext, supplierId: string) {
  const supplier = await ctx.db.query.supplier.findFirst({
    where: eq(t.supplier.id, supplierId),
    with: { categories: { with: { category: true } } },
  });
  if (!supplier) return undefined;

  const match = await ctx.db.query.match.findFirst({
    where: eq(t.match.supplierId, supplier.id),
    with: { entity: true },
  });
  const criterionValues = await ctx.db
    .select()
    .from(t.criterionValue)
    .where(and(eq(t.criterionValue.supplierId, supplier.id), eq(t.criterionValue.isCurrent, true)))
    .orderBy(asc(t.criterionValue.criterionKey));

  return { supplier, match, criterionValues };
}

/**
 * **Projected, not the raw rows** (SPEC §15.2; the same lesson as
 * `sayari_get_entity`, finding 44).
 *
 * A `criterion_value` row carries `rawInputs` — a whole scoring input blob —
 * plus `supersedesId`, `isCurrent` and `jobId`. Handed over whole, the
 * model receives the app's *bookkeeping* alongside the figure, and the
 * bookkeeping is both the larger half and the part no sentence should ever
 * quote: `settledAt` and `jobId` are facts about when we ran, not about the
 * Supplier.
 *
 * What stays is everything a sentence can honestly cite — the value, the
 * anchor line the UI renders beside it, the reason a criterion is unknown,
 * and the `rawInputs` the Assessment argues from. What goes is the row's
 * own history.
 *
 * The widget keeps the full rows: it renders for a person, who is entitled
 * to see when a Match was settled.
 */
function projectSupplierCard(loaded: NonNullable<Awaited<ReturnType<typeof loadSupplierCard>>>) {
  const { supplier, match, criterionValues } = loaded;
  return {
    supplier: {
      id: supplier.id,
      rosterIndex: supplier.rosterIndex,
      rosterName: supplier.rosterName,
      rosterAddress: supplier.rosterAddress,
      rosterCountry: supplier.rosterCountry,
      origin: supplier.origin,
      /**
       * **Still the Category's code and name, not its id.**
       *
       * A Shortlist citation is the pair `{programId, categoryId}` and neither
       * half is here — which is the gap that let a Recommendation cite
       * `programId: "MY2029-CROSSOVER-BEV-NA"`, a readable slug in no table
       * (finding 73). Both halves now reach both narrative loops through their
       * briefs, which are job-only.
       *
       * They are deliberately **not** added here as well. `get_supplier` is on
       * every surface and is one of the five tools every Match Round holds, so
       * a field added to this payload changes the request body of the resolve
       * loop and of chat — two fixtures re-recorded for a reason that has
       * nothing to do with either. Worth doing, and worth doing where the
       * recording cost is understood rather than as a side effect of an
       * Assessment needing an id.
       */
      categories: supplier.categories.map((link) => ({
        code: link.category.code,
        name: link.category.name,
      })),
    },
    match: match
      ? {
          id: match.id,
          status: match.status,
          settledBy: match.settledBy,
          matchStrength: match.matchStrength,
          entityId: match.entityId,
          /**
           * The **local** entity row, projected by its own shape.
           *
           * This called `toEntityView`, which reads a *Sayari* projection —
           * `countries`, `addresses`, `identifiers`, `source_count` as an
           * object. The local table stores `country`, `address_line`, `lei`
           * and a separate `distinct_source_count`, so every field read
           * `undefined` and the model was handed a company with no country,
           * no address and no identifiers.
           *
           * It said so, in the published Assessment: *"the entity snapshot
           * carried on the match itself is thin … no country, no addresses,
           * no identifiers and a source count of 0"*, and then went and found
           * the real row through another tool. The prose was accurate about
           * what it had been shown, and what it had been shown was wrong.
           *
           * The same casing-and-shape confusion as finding 5, one layer in:
           * two representations of one company, and a projection pointed at
           * the wrong one. `as never` is what let it compile.
           */
          entity: match.entity
            ? {
                id: match.entity.id,
                label: match.entity.label,
                entityType: match.entity.entityType,
                country: match.entity.country,
                addressLine: match.entity.addressLine,
                city: match.entity.city,
                postcode: match.entity.postcode,
                lei: match.entity.lei,
                distinctSourceCount: match.entity.distinctSourceCount,
                sanctioned: match.entity.sanctioned,
                pep: match.entity.pep,
                closed: match.entity.closed,
                psaCount: match.entity.psaCount,
                risk: match.entity.risk,
                relationshipCount: match.entity.relationshipCount,
                relationshipsTruncated: match.entity.relationshipsTruncated,
              }
            : null,
        }
      : null,
    criterionValues: criterionValues.map((row) => ({
      id: row.id,
      criterionKey: row.criterionKey,
      value: row.value,
      unknownReason: row.unknownReason,
      anchorLine: row.anchorLine,
      rawInputs: row.rawInputs,
    })),
  };
}

/**
 * The Corporate family for one Supplier (SPEC §8.4).
 *
 * The badge has **three** states and the state names carry the decision:
 * *not covered* when the ownership graph returned nobody, *no exposure found*,
 * or *exposure found*. Collapsing the first into the second would report an
 * empty ownership graph in the same ink as a genuinely clean family.
 */
const getSupplierFamily = defineTool({
  name: 'get_supplier_family',
  description:
    "A supplier's corporate family: the companies reachable downward through ownership, what risk they carry, and how much of the family was explored. Cite the enrichmentId for the explored and truncated figures, and a member's own entityId for what that member carries.",
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
      return {
        ok: false,
        objections: [
          'this supplier has no accepted match, so it has no profile to hang a family off',
        ],
      };
    }

    const members = await loadFamilyMembers(ctx, match.entityId);
    const { widgetMembers, modelMembers } = projectFamilyMembers(members);
    const envelope = {
      entityId: match.entityId,
      /**
       * **The id the coverage figures can be cited through** (finding 106).
       *
       * The family walk is an Enrichment — a dated call — and `explored` and
       * `truncated` are facts about *it*, carried on its `family_member` rows.
       * The tool told the model *"explored: 45"* and handed it no id that fact
       * could resolve to, so the one citation on offer was the member's
       * `entityId`, and an `entity` row carries no explored count to answer to
       * it. The number check refused the sentence, correctly, for a figure the
       * model had read off this very payload.
       */
      enrichmentId: members[0]?.enrichmentId ?? null,
      // What the traversal reported it covered, not how many rows we hold.
      // Counting rows answers a different question, and it was the wrong
      // answer whenever a Profile had been enriched twice: Bosch's family
      // was stored 100 times for 50 members, so this reported 100 to the
      // model.
      explored: members[0]?.exploredCount ?? members.length,
      reachable: members[0]?.reachableCount ?? null,
      truncated: members.some((m) => m.truncated),
    };

    return {
      ok: true,
      data: widget(
        'supplier_family',
        { ...envelope, members: modelMembers },
        { ...envelope, members: widgetMembers },
      ),
    };
  },
});

/** The stored family, in the one order a prompt can rely on. */
async function loadFamilyMembers(ctx: ToolContext, rootEntityId: string) {
  return ctx.db
    .select({
      memberEntityId: t.familyMember.memberEntityId,
      // Per member as well as on the envelope: a re-enrichment updates the
      // rows it re-read, so two members can belong to two different walks.
      enrichmentId: t.familyMember.enrichmentId,
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
    .where(eq(t.familyMember.rootEntityId, rootEntityId))
    /**
     * **A query that feeds a prompt needs a total order.**
     *
     * Without this the fifty family members came back in whatever order
     * Postgres found them — stable within one database, different in another,
     * and the family list is truncated at fifty so a different order is a
     * different *set*. It surfaced as an assess replay missing on turn 3, and
     * the diff showed two entirely different Chinese subsidiaries at the top.
     *
     * By hop depth first, because that is the order a person reads a family
     * in: the immediate subsidiaries, then what sits behind them. `entityId`
     * breaks the tie, since it is the only field guaranteed unique.
     */
    .orderBy(asc(t.familyMember.hopDepth), asc(t.familyMember.memberEntityId));
}

/**
 * A **projection**, not the stored rows.
 *
 * SPEC §15.2 calls a page read a *thin wrapper over the query each page
 * already runs for SSR*, and a page renders a member's name, country and
 * risk badge — never the raw traversal path. Returning the rows wholesale
 * put ~870,000 tokens into one model turn and fired the assess Job's
 * token ceiling. The cap did its job; the read was the bug.
 */
function projectFamilyMembers(members: Awaited<ReturnType<typeof loadFamilyMembers>>) {
  /**
   * Factor names, levels **and the `country` marker**, which is what the
   * widget needs to exclude a country-derived factor the way the page does.
   * `parseRiskObject` (`@/domain/scoring/risk-factors`) is the one reader
   * of the raw `risk` JSONB column — the same function `entity-page.ts`
   * and `score.ts` use — so `country` here means exactly what
   * `isCountryDerived()` checks it against on the page. A widget that
   * named the three country-derived factors by string instead (`cpi_score`,
   * `basel_aml`, `eu_high_risk_third`) would be a second, driftable copy of
   * the identification `scoring/risk-factors.ts` already rejected in
   * favour of this marker.
   */
  const widgetMembers = members.map((m) => ({
    entityId: m.memberEntityId,
    // The member's own walk, so a sentence about one member cites the
    // Enrichment that reached it rather than the envelope's.
    enrichmentId: m.enrichmentId,
    label: m.label,
    country: m.country,
    hopDepth: m.hopDepth,
    sanctioned: m.sanctioned,
    riskFactors: parseRiskObject(m.risk).map((f) => ({
      name: f.name,
      level: f.level ?? null,
      country: f.country,
    })),
  }));
  /**
   * **The model reads no `country` per FACTOR** — the member's own
   * `country` (its registered address) is unaffected and stays. Adding the
   * factor-level marker to the model's copy would change every later
   * turn's request hash for any replay recorded before this field existed,
   * the same class of drift finding 100 describes, at a tool result
   * instead of a prompt. `isCountryDerived` is for the widget's own
   * rendering; the model already gets a Compliance risk figure with the
   * country-derived factors already excluded (`domain/scoring/
   * criteria.ts`), so it never needed this marker.
   */
  const modelMembers = widgetMembers.map(({ riskFactors, ...member }) => ({
    ...member,
    riskFactors: riskFactors.map(({ name, level }) => ({ name, level })),
  }));

  return { widgetMembers, modelMembers };
}

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
const getShortlist = defineTool({
  name: 'get_shortlist',
  description:
    'The suppliers of one program and category, ranked by score, with the weight vector that produced the ranking and the excluded block beneath it.',
  input: z.object({
    programId: z.string(),
    categoryId: z.string(),
    weights: z
      .record(z.string(), z.number())
      .optional()
      .describe('A what-if vector; omit for the program default'),
  }),
  surfaces: ['chat', 'job', 'mcp'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => {
    const program = await ctx.db.query.program.findFirst({
      where: eq(t.program.id, input.programId),
      with: { weights: true },
    });
    if (!program) return { ok: false, objections: [`no program with id ${input.programId}`] };

    const category = await ctx.db.query.category.findFirst({
      where: eq(t.category.id, input.categoryId),
    });
    if (!category) return { ok: false, objections: [`no category with id ${input.categoryId}`] };

    // The **Program's own** default, never the `DEFAULT_WEIGHTS` constant: a
    // missing `w.` key fills from what this Program saved, and a URL carries
    // only what differs from it.
    const programDefault = {
      ...DEFAULT_WEIGHTS,
      ...Object.fromEntries(program.weights.map((w) => [w.criterionKey, Number(w.weight)])),
    };

    /**
     * Precedence: a what-if the model asked for explicitly, then **the rail the
     * person is actually looking at**, then the Program default.
     *
     * The middle rung is the point. §14.3 tells the model to answer about the
     * ranking on screen, but an instruction can be forgotten and this one was —
     * a turn that omits `weights` used to silently answer about the Program
     * default while a what-if was on screen, in the one surface with no
     * Citation check. Defaulting it here makes that unrepresentable.
     */
    const view = ctx.viewState ? parseViewState(ctx.viewState, programDefault) : undefined;
    const whatIf = input.weights != null || (view != null && isWhatIf(view, programDefault));

    /**
     * Resolved **unconditionally**, never left undefined.
     *
     * Two reasons, and the second is the quieter one. It is what lets the
     * widget carry its vector as a rendered field on every path, including the
     * common one — §14.4's *legible rather than merely true*. And an absent
     * vector does not mean "the Program's default": `scoreFromStoredValues`
     * falls back to the `DEFAULT_WEIGHTS` constant, while the Category page
     * always passes the Program's saved weights. A Program that had saved its
     * own would have been ranked one way on the page and another way here.
     */
    const weights = normaliseWeights(input.weights ?? view?.weights, programDefault);

    const shortlist = await loadShortlist(ctx.db, {
      programId: input.programId,
      categoryId: input.categoryId,
      weights,
      facets: view?.facets,
    });

    return {
      ok: true,
      data: widget(
        'shortlist_table',
        /**
         * What the **model** reads: enough to name a winner, say where it
         * ranks, and know when not to recommend it. Deliberately not the
         * `criteria[]` arrays — eight categories of every contribution is a
         * cost paid on every turn for a breakdown most turns never ask for.
         *
         * `ranked` is the **unfiltered** ranking, always. A filter hides rows
         * from a page without changing a rank, so a model reading the crop as
         * the set would be reading a different question's answer (SPEC §13.6).
         */
        {
          category: category.name,
          weights: whatIf ? weights : 'program default',
          ranked: shortlist.ranked.map((row) => ({
            rank: row.rank,
            supplierId: row.supplierId,
            name: row.displayName,
            score: row.score,
            coverage: `${row.coverage.computed} of ${row.coverage.total}`,
            dataConfidence: row.dataConfidence,
            // A `high` factor in a pinning family forces the verdict — a model
            // naming a winner has to know this row cannot be one.
            disqualifying: row.disqualifying,
          })),
          // Excluded is never ranked low: no Score, no estimated Criterion, and
          // the two reasons are different problems (SPEC §13.3).
          excluded: shortlist.excluded.map((entry) => ({
            supplierId: entry.row.supplierId,
            name: entry.row.displayName,
            reason: entry.reason,
          })),
          visibleCount: shortlist.visibleCount,
          totalCount: shortlist.totalCount,
        },
        // What the **widget** renders: every contribution a breakdown could
        // want, plus the vector that produced the ranking as a rendered field —
        // which is what makes the freeze legible rather than merely true.
        { category: category.name, weights, whatIf, ...shortlist },
      ),
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
const compareSuppliers = defineTool({
  name: 'compare_suppliers',
  description:
    'Two or more suppliers side by side on every criterion, with each raw input beside its value.',
  input: z.object({
    supplierIds: z.array(z.string()).min(2).max(5),
    categoryId: z.string().optional(),
  }),
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
          .where(and(eq(t.criterionValue.supplierId, id), eq(t.criterionValue.isCurrent, true)))
          .orderBy(asc(t.criterionValue.criterionKey)),
      })),
    );
    return { ok: true, data: widget('criterion_compare', rows) };
  },
});

const getTrace = defineTool({
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

const listNeedsReview = defineTool({
  name: 'list_needs_review',
  description:
    'The suppliers whose match the agents could not settle, and are waiting on a person.',
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
      .where(and(eq(t.supplier.programId, input.programId), eq(t.match.status, 'needs_review')))
      .orderBy(asc(t.supplier.rosterIndex));
    return { ok: true, data: widget('needs_review_list', rows) };
  },
});

const listLeads = defineTool({
  name: 'list_leads',
  description:
    'The companies Discover proposed for one category that are on no imported list, with their classification and shipment evidence.',
  input: z.object({
    programId: z.string(),
    categoryId: z.string(),
    includeDismissed: z.boolean().optional(),
  }),
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
    'What this program has spent, and separately what the Sayari account has used. The two are differently scoped and are never netted against each other.',
  input: z.object({ programId: z.string(), runId: z.string().optional() }),
  surfaces: ['chat', 'mcp'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => {
    const runs = await ctx.db
      .select()
      .from(t.run)
      .where(eq(t.run.programId, input.programId))
      .orderBy(desc(t.run.createdAt));
    return {
      ok: true,
      data: widget('usage_meter', {
        ours: { scope: 'This Program', runs: runs.length },
        // The labels live here, not in the page, so asking in chat cannot lose
        // a caveat that navigating would have shown.
        sayari: {
          scope: 'Your Sayari account, rolling year',
          note: 'Account-wide and lagging. negativeNews has no bucket here at all.',
          dollars: null,
          dollarsNote:
            'Sayari publishes no per-class price, so any credits-to-dollars figure would be one we invented.',
        },
        claudeNote: 'Computed from a committed price constant, not a bill.',
      }),
    };
  },
});

/** Job-only: the brief the assess loop argues from. */
const getAssessmentBrief = defineTool({
  name: 'get_assessment_brief',
  description:
    "Everything one supplier's assessment is written from, as rows rather than prose. Every id here is a citation target: the match id, each criterion value id, and the program and category ids that together cite a shortlist.",
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
const getRecommendationBrief = defineTool({
  name: 'get_recommendation_brief',
  description:
    'Everything one recommendation is written from: the shortlist, each supplier’s criterion values and verdict, as row ids rather than prose. Every id here is a citation target, including the program and category ids that together cite a shortlist.',
  input: z.object({ programId: z.string(), categoryId: z.string() }),
  surfaces: ['job'],
  effect: 'read',
  spends: [],
  latency: 'fast',
  handler: async (input, ctx) => {
    const bidders = await ctx.db
      .select({ supplierId: t.supplierCategory.supplierId })
      .from(t.supplierCategory)
      .where(eq(t.supplierCategory.categoryId, input.categoryId))
      .orderBy(asc(t.supplierCategory.supplierId));
    const rows = await Promise.all(bidders.map((b) => briefFor(ctx, b.supplierId)));
    return { ok: true, data: { categoryId: input.categoryId, suppliers: rows } };
  },
});

async function briefFor(ctx: ToolContext, supplierId: string) {
  const supplier = await ctx.db.query.supplier.findFirst({ where: eq(t.supplier.id, supplierId) });
  const match = await ctx.db.query.match.findFirst({ where: eq(t.match.supplierId, supplierId) });
  const categories = await ctx.db
    .select({ categoryId: t.supplierCategory.categoryId })
    .from(t.supplierCategory)
    .where(eq(t.supplierCategory.supplierId, supplierId))
    // Ordered, because the brief is prompt bytes a fixture replays against.
    .orderBy(asc(t.supplierCategory.categoryId));
  const values = await ctx.db
    .select()
    .from(t.criterionValue)
    .where(and(eq(t.criterionValue.supplierId, supplierId), eq(t.criterionValue.isCurrent, true)))
    .orderBy(asc(t.criterionValue.criterionKey));
  const latestAssessment = await ctx.db.query.assessment.findFirst({
    where: and(eq(t.assessment.supplierId, supplierId), eq(t.assessment.kind, 'standard')),
    with: { versions: { orderBy: [desc(t.assessmentVersion.n)], limit: 1 } },
  });
  return {
    supplierId,
    supplierName: supplier?.rosterName ?? '(promoted lead)',
    /**
     * **The two ids a Shortlist citation is made of.**
     *
     * A Citation to a Shortlist is the pair `{programId, categoryId}`, and this
     * brief carried neither — so an Assessment arguing about where its Supplier
     * ranks had no way to cite the ranking, and the one attempt at it named the
     * Program by a slug the model invented (finding 73). The Categories are the
     * ones this Supplier bids on, which is also what says whether a `tariff`
     * section is legal at all.
     */
    programId: supplier?.programId ?? null,
    categoryIds: categories.map((c) => c.categoryId),
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

export const PAGE_READS = [
  getProgram,
  getCategory,
  getSupplier,
  getSupplierFamily,
  getEntity,
  getRecord,
];
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
