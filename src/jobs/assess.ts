import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { JOB_CAPS } from '@/config/constants';
import { DEFAULT_WEIGHTS, WEIGHTED_CRITERIA } from '@/domain/score';
import { loadSupplierSnapshots, scoreSnapshot } from '@/db/queries/shortlist';
import type { FrozenInputs } from '@/domain/staleness';
import {
  checkAssessment,
  type ResolvedEvidence,
  type SubmittedSentence,
} from '@/domain/validation/submit-checks';
import { runLoop } from '@/model';
import { toRunnableTools } from '@/model/tool-adapter';
import * as assessPrompts from '@/model/prompts/assess';
import { getRegistry, type ToolContext } from '@/tools';
import { citationKey, publishVersion, resolveCitations } from './publish';
import { UnpublishableDraftError, runProposerEvaluatorLoop } from './rounds';
import type { ModelContext } from '@/model/types';

/**
 * The assess Job (SPEC §10).
 *
 * One Assessment per Supplier × Program — **never per Category**, though it
 * carries a Score for each Category that Supplier bids on.
 *
 * The shape is: build the brief → run proposer/evaluator Rounds → run the eight
 * code checks over the submitted payload → publish. Nothing is written until
 * the checks pass, so the record never contains an unproven claim even briefly.
 */

export type AssessDraft = { verdict: string; sentences: SubmittedSentence[] };

/**
 * `frozen_inputs` is what makes the *inputs moved* banner computable.
 *
 * It carries the weight vector, the Criterion values, the Scores, the Shortlist
 * order **and each Shortlist Supplier's verdict and evaluator outcome** — the
 * last of which is here because a Supplier re-assessed into `do_not_shortlist`
 * was otherwise invisible to both staleness signals.
 */
export async function buildFrozenInputs(
  db: Database,
  args: { programId: string; supplierIds: string[] },
): Promise<FrozenInputs> {
  const weights = await db
    .select()
    .from(t.programCriterionWeight)
    .where(eq(t.programCriterionWeight.programId, args.programId))
    /**
     * **Ordered, because these become the keys of a JSON object in a prompt.**
     *
     * `weights` and `criterionValues` are built by iterating these rows, and a
     * JavaScript object preserves insertion order — so an unordered query makes
     * a prompt whose *key order* differs between two databases holding
     * identical data. It is invisible to a person reading the JSON and fatal to
     * a replay.
     */
    .orderBy(asc(t.programCriterionWeight.criterionKey));

  const criterionValues: Record<string, number | null> = {};
  const scores: Record<string, number | null> = {};
  const supplierVerdicts: FrozenInputs['supplierVerdicts'] = {};
  const rosterRows: FrozenInputs['rosterRows'] = {};
  const categoryIds = new Set<string>();
  /** Per Supplier and **in query order**, for the same reason the weights are ordered. */
  const categoriesBySupplier = new Map<string, string[]>();

  for (const supplierId of args.supplierIds) {
    const supplier = await db.query.supplier.findFirst({ where: eq(t.supplier.id, supplierId) });
    if (supplier) {
      rosterRows[supplierId] = {
        index: supplier.rosterIndex,
        name: supplier.rosterName,
        address: supplier.rosterAddress,
        country: supplier.rosterCountry,
      };
    }

    const values = await db
      .select()
      .from(t.criterionValue)
      .where(and(eq(t.criterionValue.supplierId, supplierId), eq(t.criterionValue.isCurrent, true)))
      .orderBy(asc(t.criterionValue.criterionKey));
    for (const value of values) {
      criterionValues[`${supplierId}:${value.criterionKey}`] = value.value;
    }

    const supplierCategories = await db
      .select({ categoryId: t.supplierCategory.categoryId })
      .from(t.supplierCategory)
      .where(eq(t.supplierCategory.supplierId, supplierId))
      .orderBy(asc(t.supplierCategory.categoryId));
    categoriesBySupplier.set(
      supplierId,
      supplierCategories.map((row) => row.categoryId),
    );
    for (const row of supplierCategories) {
      categoryIds.add(row.categoryId);
    }

    const assessment = await db.query.assessment.findFirst({
      where: and(eq(t.assessment.supplierId, supplierId), eq(t.assessment.kind, 'standard')),
      with: { versions: { orderBy: (v, { desc }) => [desc(v.n)], limit: 1 } },
    });
    const latest = assessment?.versions[0];
    if (latest) {
      supplierVerdicts[supplierId] = {
        verdict: latest.verdict,
        evaluatorOutcome: latest.evaluatorOutcome,
      };
    }
  }

  /**
   * The Scores the narrative is allowed to quote.
   *
   * `scores` was declared, typed, threaded into every prompt and stored on
   * every version — and **never written to**. It stayed invisible only because
   * no tool handed an agent a Score to quote: `get_shortlist` returned a
   * `bidderCount`. Pointing that tool at `loadShortlist()` woke this up on the
   * first live run, where the lead agent wrote *"the stored score of
   * 67.259…"* and our own number check rejected it in all three Rounds —
   * correctly, since the figure appeared in no frozen input and on no cited
   * row. There is no `score` table for a sentence to cite instead
   * (`db/schema/scoring.ts`), so the frozen inputs are the only place a Score
   * can become checkable.
   *
   * **Keyed per Category, because a Score is Category-scoped** — tariff
   * exposure is stored per Category and the other five at `category = null`,
   * so one Supplier bidding in three Categories has three Scores. The
   * Category-less key is kept beside them for a sentence about the Supplier
   * itself, which is what the Supplier page shows.
   *
   * Computed through `scoreSnapshot`, the same function the pages call, rather
   * than a second arithmetic here: a frozen Score that disagreed with the
   * ranking on screen would be worse than no frozen Score at all.
   */
  const scoringWeights = {
    ...DEFAULT_WEIGHTS,
    ...Object.fromEntries(weights.map((w) => [w.criterionKey, Number(w.weight)])),
  };
  const snapshots = await loadSupplierSnapshots(db, {
    programId: args.programId,
    supplierIds: args.supplierIds,
  });
  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.supplierId, snapshot]));
  for (const supplierId of args.supplierIds) {
    const snapshot = snapshotById.get(supplierId);
    if (!snapshot) continue;
    scores[supplierId] = scoreSnapshot(snapshot, scoringWeights, null).score;
    for (const categoryId of categoriesBySupplier.get(supplierId) ?? []) {
      scores[`${supplierId}:${categoryId}`] = scoreSnapshot(snapshot, scoringWeights, categoryId).score;
    }
  }

  return {
    /**
     * Left as the **stored rows alone**, not `scoringWeights`. Filling absent
     * keys from the constant here would reorder this object, and its key order
     * is prompt bytes a fixture replays against.
     */
    weights: Object.fromEntries(weights.map((w) => [w.criterionKey, Number(w.weight)])),
    criterionValues,
    scores,
    shortlistOrder: args.supplierIds,
    supplierVerdicts,
    rosterRows,
    tariffFlags: await tariffFlagsFor(db, [...categoryIds].sort()),
  };
}

/**
 * The tariff flags on a set of Categories, ordered so the frozen inputs are
 * byte-identical between two runs over the same data.
 */
async function tariffFlagsFor(db: Database, categoryIds: string[]): Promise<FrozenInputs['tariffFlags']> {
  if (categoryIds.length === 0) return [];
  return db
    .select({
      categoryId: t.categoryFlag.categoryId,
      key: t.tariffFlag.key,
      label: t.tariffFlag.label,
      whyNotARate: t.tariffFlag.whyNotARate,
    })
    .from(t.categoryFlag)
    .innerJoin(t.tariffFlag, eq(t.tariffFlag.key, t.categoryFlag.flagKey))
    .where(inArray(t.categoryFlag.categoryId, categoryIds))
    .orderBy(asc(t.categoryFlag.categoryId), asc(t.tariffFlag.key));
}

/** Assembles what the eight checks need to know, from rows rather than prose. */
export async function buildEvidence(
  db: Database,
  args: {
    programId: string;
    supplierIds: string[];
    frozenInputs: Record<string, unknown>;
    citations: SubmittedSentence['citations'];
  },
): Promise<ResolvedEvidence> {
  const rowsByCitation = await resolveCitations(db, args.citations);

  const suppliers: ResolvedEvidence['suppliers'] = new Map();
  const unknownCriteria: string[] = [];

  for (const supplierId of args.supplierIds) {
    const supplier = await db.query.supplier.findFirst({ where: eq(t.supplier.id, supplierId) });
    if (!supplier) continue;
    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplierId) });
    const categories = await db
      .select({ categoryId: t.supplierCategory.categoryId })
      .from(t.supplierCategory)
      .where(eq(t.supplierCategory.supplierId, supplierId))
      .orderBy(asc(t.supplierCategory.categoryId));
    const values = await db
      .select()
      .from(t.criterionValue)
      .where(and(eq(t.criterionValue.supplierId, supplierId), eq(t.criterionValue.isCurrent, true)));

    for (const value of values) {
      if (value.value == null && WEIGHTED_CRITERIA.includes(value.criterionKey as never)) {
        unknownCriteria.push(value.criterionKey);
      }
    }

    const profile = match?.entityId
      ? await db.query.entity.findFirst({ where: eq(t.entity.id, match.entityId) })
      : undefined;

    const assessment = await db.query.assessment.findFirst({
      where: and(eq(t.assessment.supplierId, supplierId), eq(t.assessment.kind, 'standard')),
      with: { versions: { orderBy: (v, { desc }) => [desc(v.n)], limit: 1 } },
    });

    suppliers.set(supplierId, {
      name: supplier.rosterName ?? profile?.label ?? supplierId,
      matchAccepted: match?.status === 'accepted',
      categoryIds: categories.map((c) => c.categoryId),
      hasScore: values.some((v) => v.value != null),
      disqualifying: profile?.sanctioned === true,
      publishedWithObjections: assessment?.versions[0]?.evaluatorOutcome === 'published_with_objections',
      onShortlist: match?.status === 'accepted' && categories.length > 0,
    });
  }

  return {
    rowsByCitation,
    frozenInputs: args.frozenInputs,
    suppliers,
    unknownCriteria: [...new Set(unknownCriteria)],
    /**
     * The tariff caveat is mandatory wherever a rate is stated: it is an MFN
     * figure for one importer, trade-action flags are not folded into it, and
     * the Mexican duty rides beside it unscored. Rendering the number without
     * the caveat is how a proxy becomes a fact.
     */
    mandatoryCaveats: [
      {
        section: 'tariff',
        mustMention: /trade[- ]action|not folded|MFN|proxy|flag/i,
        describedAs:
          'the rate is an MFN figure for one importer, and trade-action flags are not folded into it',
      },
    ],
  };
}

export type AssessDeps = {
  db: Database;
  toolCtx: ToolContext;
  modelCtx: ModelContext;
  jobId?: string | undefined;
};

/**
 * Runs the loop and publishes.
 *
 * The proposer and the evaluator each get a **derived** tool list — five for
 * assess, per SPEC §15.3 — so neither can reach a tool the loop was not given.
 */
export async function assessSupplier(
  deps: AssessDeps,
  args: { supplierId: string; programId: string },
): Promise<{ versionId: string; n: number; evaluatorOutcome: string; roundsUsed: number }> {
  const { db } = deps;
  const registry = getRegistry();

  const supplier = await db.query.supplier.findFirst({ where: eq(t.supplier.id, args.supplierId) });
  if (!supplier) throw new Error(`no supplier ${args.supplierId}`);
  const program = await db.query.program.findFirst({ where: eq(t.program.id, args.programId) });

  const frozenInputs = await buildFrozenInputs(db, {
    programId: args.programId,
    supplierIds: [args.supplierId],
  });

  const briefTool = registry.byName.get('get_assessment_brief')!;
  const briefResult = await briefTool.handler(
    { supplierId: args.supplierId, programId: args.programId },
    deps.toolCtx,
  );
  const brief = briefResult.ok ? JSON.stringify(briefResult.data, null, 2) : '(the brief could not be built)';

  const proposerTools = [
    registry.byName.get('get_supplier')!,
    registry.byName.get('get_supplier_family')!,
    registry.byName.get('get_assessment_brief')!,
    registry.byName.get('get_entity')!,
    registry.byName.get('submit_assessment')!,
  ];

  const outcome = await runProposerEvaluatorLoop<AssessDraft>({
    propose: async ({ roundN, objections }) => {
      const result = await runLoop(
        {
          loop: 'assess',
          system: assessPrompts.proposerSystem,
          tools: toRunnableTools(proposerTools, deps.toolCtx),
          messages: [
            {
              role: 'user',
              content: assessPrompts.buildFirstUserMessage({
                supplierName: supplier.rosterName ?? args.supplierId,
                programName: program?.name ?? '(unnamed programme)',
                roundN,
                brief,
                frozenInputs: JSON.stringify(frozenInputs, null, 2),
                objections: objections.length > 0 ? objections : undefined,
              }),
            },
          ],
          caps: JOB_CAPS.assess,
          roundN,
          toolDigest: registry.digest(proposerTools),
        },
        deps.modelCtx,
      );

      if (result.status !== 'done') {
        // The LOOP failed — transport, refusal, a cap. Distinct from our zod
        // refinements rejecting a well-formed request's answer.
        return {
          kind: 'loop_failure',
          message:
            `the loop ended as ${result.status}` +
            ('error' in result ? `: ${result.error}` : '') +
            ('reason' in result ? `: ${result.reason}` : ''),
        };
      }
      // Read the proposal out of the message rather than out of the tool's
      // run(): the agents propose, and our code settles.
      const submitted = result.toolUses.find((u) => u.name === 'submit_assessment')?.input as
        | AssessDraft
        | undefined;
      if (!submitted?.sentences?.length) {
        // An Assessment exists only when submit_assessment runs, so a refused
        // or empty turn makes no record at all — the empty-Assessment failure
        // is structurally impossible rather than guarded against.
        return {
          kind: 'refinement_failure',
          message:
            `the loop ended without a usable submit_assessment payload ` +
            `(tools called: ${result.toolUses.map((u) => u.name).join(', ') || 'none'}; ` +
            `sentences: ${(submitted as { sentences?: unknown[] } | undefined)?.sentences?.length ?? 'none'})`,
        };
      }
      return { kind: 'draft', draft: submitted, text: JSON.stringify(submitted) };
    },

    validate: async (draft) => {
      const evidence = await buildEvidence(db, {
        programId: args.programId,
        supplierIds: [args.supplierId],
        frozenInputs: frozenInputs as unknown as Record<string, unknown>,
        citations: draft.sentences.flatMap((s) => s.citations),
      });
      return checkAssessment({
        verdict: draft.verdict,
        sentences: draft.sentences,
        supplierId: args.supplierId,
        evidence,
      });
    },

    evaluate: async ({ roundN, draft }) => {
      // The evaluator is STATELESS and sees exactly what the proposer saw —
      // never its own earlier objections, and never the replies to them.
      const result = await runLoop(
        {
          loop: 'assess',
          system: assessPrompts.evaluatorSystem,
          /**
           * **The evaluator reads what the proposer read.**
           *
           * It used to hold `get_assessment_brief` alone, while the proposer
           * had four read tools — so it was asked to verify claims against
           * evidence it could not see, and it said so: *"the cited rows are
           * real and resolvable, but they carry only a key and a value.
           * Nothing in the row supports the sub-structure the draft attributes
           * to it."* That objection was **correct**, it survived three Rounds,
           * and no draft could ever have answered it.
           *
           * A verifier weaker than the thing it verifies does not measure
           * accuracy, it measures what fits through its own window.
           *
           * It still cannot **write** — no `submit_assessment` — so the
           * asymmetry that matters is preserved: the proposer proposes, the
           * evaluator judges, and neither can do the other's job.
           */
          tools: toRunnableTools(
            proposerTools.filter((tool) => tool.name !== 'submit_assessment'),
            deps.toolCtx,
          ),
          messages: [
            {
              role: 'user',
              content: [
                assessPrompts.buildFirstUserMessage({
                  supplierName: supplier.rosterName ?? args.supplierId,
                  programName: program?.name ?? '(unnamed programme)',
                  roundN,
                  brief,
                  frozenInputs: JSON.stringify(frozenInputs, null, 2),
                }),
                '',
                'THE DRAFT TO REVIEW',
                JSON.stringify(draft, null, 2),
                '',
                'Return your six rubric verdicts. If every item passes, say so plainly.',
              ].join('\n'),
            },
          ],
          caps: JOB_CAPS.assess,
          roundN,
        },
        deps.modelCtx,
      );

      const text = textOf(result);
      const objections = parseObjections(text);
      return objections.length === 0
        ? { kind: 'pass', rubric: { raw: text }, text }
        : { kind: 'objections', objections, rubric: { raw: text }, text };
    },
  });

  /**
   * A draft the code checks rejected is not published, and the Job says why.
   *
   * `UnpublishableDraftError` rather than a bare throw, so the worker can tell
   * *"three Rounds could not produce a document that passes our own checks"*
   * from a genuine crash. The surviving objections are the whole message —
   * they are what a person would have to fix.
   */
  if (outcome.evaluatorOutcome === 'rejected_by_code' || !outcome.draft) {
    throw new UnpublishableDraftError(
      'assessment',
      outcome.dissent.map((d) => d.objection),
    );
  }

  const published = await publishVersion(db, {
    target: {
      kind: 'assessment',
      supplierId: args.supplierId,
      programId: args.programId,
      verdict: outcome.draft.verdict,
    },
    sentences: outcome.draft.sentences,
    rounds: outcome.rounds,
    dissent: outcome.dissent,
    frozenInputs: frozenInputs as unknown as Record<string, unknown>,
    evaluatorOutcome: outcome.evaluatorOutcome,
    jobId: deps.jobId,
  });

  return { ...published, evaluatorOutcome: outcome.evaluatorOutcome, roundsUsed: outcome.roundsUsed };
}

function textOf(result: Awaited<ReturnType<typeof runLoop>>): string {
  if (result.status !== 'done') return `the evaluator loop ended as ${result.status}`;
  const message = result.finalMessage as { content?: { type: string; text?: string }[] } | undefined;
  return (message?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
    .trim();
}

/** The six rubric items, which are also what the parse anchors on. */
export const RUBRIC_ITEMS = [
  'support',
  'strength',
  'number fidelity',
  'caveats',
  'eligibility',
  'omission',
] as const;

/**
 * Reads the evaluator's rubric into objections.
 *
 * **Anchored on the six item names, not on the word "fail".** The first version
 * searched every line for `/fail/` and objected on any hit — which fires on
 * *"caveats: pass — no mandatory line is missing, so this does not fail"*. A
 * validator that objects to a passing verdict costs a Round for nothing, and
 * three of those is a version published with objections nobody raised.
 *
 * So a line counts only when it names one of the six items **and** marks it
 * failed. The rubric text is stored verbatim on the Round either way, so
 * nothing is lost to this parse — it decides whether a Round is spent, not what
 * is recorded.
 *
 * `output_config.format` would make this structural rather than parsed, and is
 * deliberately not used: SPEC §17.8 keeps the *tool* as the only write path, so
 * a schema-constrained final message would be a second way to produce a record.
 * The rubric is a Round annotation rather than a record, but the rule is worth
 * more than the convenience.
 */
export function parseObjections(text: string): string[] {
  const objections: string[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;

    // Strip markdown emphasis and list markers so `**support** — fail` matches.
    const plain = line.replace(/[*_`]/g, '').replace(/^[-•\d.)\s]+/, '');
    const item = RUBRIC_ITEMS.find((name) => new RegExp(`^${name}\\b`, 'i').test(plain));
    if (!item) continue;

    // The verdict is what follows the item name, up to the first sentence end —
    // so a later "does not fail" in the explanation cannot flip a pass.
    const verdict = plain.slice(item.length).replace(/^[\s:—–-]+/, '').split(/[.;]/)[0] ?? '';
    if (/^\s*fail(ed|s)?\b/i.test(verdict)) objections.push(plain);
  }

  return objections;
}

export { citationKey };
