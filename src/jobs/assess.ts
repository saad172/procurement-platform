import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { JOB_CAPS } from '@/config/constants';
import { DEFAULT_WEIGHTS, WEIGHTED_CRITERIA } from '@/domain/score';
import { loadShortlist, loadSupplierSnapshots, scoreSnapshot } from '@/db/queries/shortlist';
import type { FrozenInputs } from '@/domain/staleness';
import {
  checkAssessment,
  type Objection,
  type ResolvedEvidence,
  type SubmittedSentence,
} from '@/domain/validation/submit-checks';
import { runLoop } from '@/model';
import { toRunnableTools } from '@/model/tool-adapter';
import * as assessPrompts from '@/model/prompts/assess';
import { getRegistry, type ToolContext, type ToolDefinition } from '@/tools';
import { citationKey, publishVersion, resolveCitations } from './publish';
import { evaluateWithVerdict } from './evaluation';
import { roundCheckpoint } from './round-checkpoint';
import { readSubmission } from './submission';
import {
  UnpublishableDraftError,
  runProposerEvaluatorLoop,
  type EvaluationResult,
  type ProposalResult,
} from './rounds';
import { raiseIfStopped } from './stops';
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
  const stored = await loadCriterionWeights(db, args.programId);

  /**
   * **One vector, and it is the one the Scores were computed with.**
   *
   * This used to freeze the stored rows alone while `scores` was computed from
   * `{ ...DEFAULT_WEIGHTS, ...stored }` — so a Program that had saved five of
   * the six weights froze a vector that could not reproduce its own frozen
   * Scores, and the *inputs moved* banner compared a vector nothing had used.
   * A frozen input is what the argument was made from; anything else in this
   * object is a second answer to the same question.
   *
   * Key order is prompt bytes a fixture replays against, and it is stable:
   * `DEFAULT_WEIGHTS`' six keys in the constant's own order, then any stored
   * key outside them in the query's `ORDER BY criterion_key`.
   */
  const effectiveWeights = {
    ...DEFAULT_WEIGHTS,
    ...Object.fromEntries(stored.map((w) => [w.criterionKey, Number(w.weight)])),
  };

  const perSupplier = await loadPerSupplierFrozenFacts(db, args.supplierIds);
  const categoryIds = [...perSupplier.categoryIds].sort();
  const scores = await computeFrozenScores(
    db,
    args,
    effectiveWeights,
    perSupplier.categoriesBySupplier,
  );
  const shortlists = await freezeShortlists(db, {
    programId: args.programId,
    supplierIds: args.supplierIds,
    categoryIds,
    weights: effectiveWeights,
    categoriesBySupplier: perSupplier.categoriesBySupplier,
  });

  return {
    effectiveWeights,
    criterionValues: perSupplier.criterionValues,
    scores,
    shortlistOrder: shortlists.order,
    shortlistRanks: shortlists.ranks,
    supplierVerdicts: perSupplier.supplierVerdicts,
    rosterRows: perSupplier.rosterRows,
    tariffFlags: await tariffFlagsFor(db, categoryIds),
  };
}

/**
 * The Shortlist order, as a Shortlist actually orders it.
 *
 * `shortlistOrder` was `args.supplierIds` — which for a Recommendation is the
 * bidder list in `supplier_id` order, an order nothing on screen has ever been
 * in. Both the schema comment and `staleness.ts` call this field the Shortlist
 * order and compare it as one, so a re-rank moved no banner while a re-import
 * that renumbered nothing would have.
 *
 * **Per Category, because a Shortlist is per Category** (SPEC §13.1): the same
 * Supplier sits at a different rank in each one it bids on, so a single flat
 * list could only ever be one Category's answer.
 *
 * The ranks are frozen beside the order because a rank is a **figure a sentence
 * quotes** — *"second of nine"* — and an array of ids carries no number the
 * fidelity check can match it against.
 */
async function freezeShortlists(
  db: Database,
  args: {
    programId: string;
    supplierIds: string[];
    categoryIds: string[];
    weights: Record<string, number>;
    categoriesBySupplier: Map<string, string[]>;
  },
): Promise<{ order: FrozenInputs['shortlistOrder']; ranks: FrozenInputs['shortlistRanks'] }> {
  const order: FrozenInputs['shortlistOrder'] = {};
  const ranks: FrozenInputs['shortlistRanks'] = {};
  const rankOf = new Map<string, number | null>();

  for (const categoryId of args.categoryIds) {
    // The same `loadShortlist` the Category page calls, with the same vector
    // the Scores were computed with — a frozen order that disagreed with the
    // ranking on screen would be worse than no frozen order at all.
    const shortlist = await loadShortlist(db, {
      programId: args.programId,
      categoryId,
      weights: args.weights,
    });
    order[categoryId] = shortlist.ranked.map((row) => row.supplierId);
    for (const row of shortlist.ranked) rankOf.set(`${row.supplierId}:${categoryId}`, row.rank);
  }

  for (const supplierId of args.supplierIds) {
    for (const categoryId of args.categoriesBySupplier.get(supplierId) ?? []) {
      // Null where the Supplier bids on the Category and reaches no rank —
      // excluded is never ranked low (SPEC §13.3).
      ranks[`${supplierId}:${categoryId}`] = rankOf.get(`${supplierId}:${categoryId}`) ?? null;
    }
  }

  return { order, ranks };
}

async function loadCriterionWeights(db: Database, programId: string) {
  return (
    db
      .select()
      .from(t.programCriterionWeight)
      .where(eq(t.programCriterionWeight.programId, programId))
      /**
       * **Ordered, because these become the keys of a JSON object in a prompt.**
       *
       * `weights` and `criterionValues` are built by iterating these rows, and a
       * JavaScript object preserves insertion order — so an unordered query makes
       * a prompt whose *key order* differs between two databases holding
       * identical data. It is invisible to a person reading the JSON and fatal to
       * a replay.
       */
      .orderBy(asc(t.programCriterionWeight.criterionKey))
  );
}

type PerSupplierFrozenFacts = {
  criterionValues: Record<string, number | null>;
  supplierVerdicts: FrozenInputs['supplierVerdicts'];
  rosterRows: FrozenInputs['rosterRows'];
  categoryIds: Set<string>;
  /** Per Supplier and **in query order**, for the same reason the weights are ordered. */
  categoriesBySupplier: Map<string, string[]>;
};

async function loadPerSupplierFrozenFacts(
  db: Database,
  supplierIds: string[],
): Promise<PerSupplierFrozenFacts> {
  const criterionValues: Record<string, number | null> = {};
  const supplierVerdicts: FrozenInputs['supplierVerdicts'] = {};
  const rosterRows: FrozenInputs['rosterRows'] = {};
  const categoryIds = new Set<string>();
  const categoriesBySupplier = new Map<string, string[]>();

  for (const supplierId of supplierIds) {
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

  return { criterionValues, supplierVerdicts, rosterRows, categoryIds, categoriesBySupplier };
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
async function computeFrozenScores(
  db: Database,
  args: { programId: string; supplierIds: string[] },
  scoringWeights: Record<string, number>,
  categoriesBySupplier: Map<string, string[]>,
): Promise<Record<string, number | null>> {
  const scores: Record<string, number | null> = {};
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
      scores[`${supplierId}:${categoryId}`] = scoreSnapshot(
        snapshot,
        scoringWeights,
        categoryId,
      ).score;
    }
  }
  return scores;
}

/**
 * The tariff flags on a set of Categories, ordered so the frozen inputs are
 * byte-identical between two runs over the same data.
 */
async function tariffFlagsFor(
  db: Database,
  categoryIds: string[],
): Promise<FrozenInputs['tariffFlags']> {
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

/**
 * Assembles what the eight checks need to know, from rows rather than prose.
 *
 * **Through `loadSupplierSnapshots` and `scoreSnapshot`**, which are what the
 * Category page ranks with. The checks used to read their own rows and reach
 * their own conclusions from them, and both conclusions were narrower than the
 * page's: *disqualifying* was `entity.sanctioned` alone where `score.ts` lights
 * the badge on `isDisqualifying(factor) || sanctioned`, so check 7 and the pick
 * bar let through exactly the Suppliers the badge was raised about; and *has a
 * score* was "any Criterion value is non-null", which is a fact about the
 * Supplier where the objection it produces — *"has no score for this
 * category"* — is a fact about one Category.
 */
export async function buildEvidence(
  db: Database,
  args: {
    programId: string;
    supplierIds: string[];
    frozenInputs: FrozenInputs;
    citations: SubmittedSentence['citations'];
  },
): Promise<ResolvedEvidence> {
  const rowsByCitation = await resolveCitations(db, args.citations);

  const snapshots = await loadSupplierSnapshots(db, {
    programId: args.programId,
    supplierIds: args.supplierIds,
  });
  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.supplierId, snapshot]));

  const suppliers: ResolvedEvidence['suppliers'] = new Map();
  const unknownCriteria: string[] = [];

  for (const supplierId of args.supplierIds) {
    const snapshot = snapshotById.get(supplierId);
    if (!snapshot) continue;

    for (const value of snapshot.values) {
      if (value.value == null && WEIGHTED_CRITERIA.includes(value.criterionKey as never)) {
        unknownCriteria.push(value.criterionKey);
      }
    }

    const assessment = await db.query.assessment.findFirst({
      where: and(eq(t.assessment.supplierId, supplierId), eq(t.assessment.kind, 'standard')),
      with: { versions: { orderBy: (v, { desc }) => [desc(v.n)], limit: 1 } },
    });

    suppliers.set(supplierId, {
      name: snapshot.displayName,
      matchAccepted: snapshot.matchAccepted,
      categoryIds: snapshot.categoryIds,
      /**
       * **Per Category, computed the way the Shortlist computes it** — with the
       * effective weight vector this version froze, so a Score the checks can
       * see and a Score the document quotes are the same number.
       */
      categoriesWithScore: snapshot.categoryIds.filter(
        (categoryId) =>
          scoreSnapshot(snapshot, args.frozenInputs.effectiveWeights, categoryId).score != null,
      ),
      disqualifying: snapshot.disqualifyingFactors.length > 0,
      publishedWithObjections:
        assessment?.versions[0]?.evaluatorOutcome === 'published_with_objections',
      onShortlist: snapshot.matchAccepted && snapshot.categoryIds.length > 0,
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
  const ctx = await loadAssessContext(deps, args);

  const outcome = await runProposerEvaluatorLoop<AssessDraft>({
    propose: (roundArgs) => runAssessPropose(ctx, roundArgs),
    validate: (draft) => validateAssessDraft(ctx, draft),
    evaluate: (roundArgs) => runAssessEvaluate(ctx, roundArgs),
    // A Job resumes at its last Round boundary; a run of this function outside
    // one (the deterministic tests) has nowhere to checkpoint to and needs none.
    ...(deps.jobId ? { checkpoint: roundCheckpoint<AssessDraft>(db, deps.jobId) } : {}),
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
    frozenInputs: ctx.frozenInputs as unknown as Record<string, unknown>,
    evaluatorOutcome: outcome.evaluatorOutcome,
    jobId: deps.jobId,
  });

  return {
    ...published,
    evaluatorOutcome: outcome.evaluatorOutcome,
    roundsUsed: outcome.roundsUsed,
  };
}

/** Everything a Round of the proposer/evaluator loop reads, built once. */
type AssessRoundContext = {
  db: Database;
  deps: AssessDeps;
  args: { supplierId: string; programId: string };
  supplier: typeof t.supplier.$inferSelect;
  program: typeof t.program.$inferSelect | undefined;
  frozenInputs: FrozenInputs;
  brief: string;
  proposerTools: ToolDefinition[];
};

/**
 * The proposer and the evaluator each get a **derived** tool list — five for
 * assess, per SPEC §15.3 — so neither can reach a tool the loop was not given.
 */
async function loadAssessContext(
  deps: AssessDeps,
  args: { supplierId: string; programId: string },
): Promise<AssessRoundContext> {
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
  const brief = briefResult.ok
    ? JSON.stringify(briefResult.data, null, 2)
    : '(the brief could not be built)';

  /**
   * **Derived, not hand-written.** The list used to be five `byName.get()`
   * calls here and a `.filter()` in the evaluator turn removing the submit —
   * one list stated twice, in two files, with nothing checking they agreed.
   * `finalizeRegistry()` derives both roles from one read list and refuses to
   * boot if either names a tool that is not there.
   */
  const proposerTools = registry.forNarrativeRole('assess', 'proposer');

  return { db, deps, args, supplier, program, frozenInputs, brief, proposerTools };
}

async function runAssessPropose(
  ctx: AssessRoundContext,
  roundArgs: { roundN: number; objections: string[] },
): Promise<ProposalResult<AssessDraft>> {
  const { roundN, objections } = roundArgs;
  const registry = getRegistry();
  const result = await runLoop(
    {
      loop: 'assess',
      system: assessPrompts.proposerSystem,
      tools: toRunnableTools(ctx.proposerTools, ctx.deps.toolCtx),
      messages: [
        {
          role: 'user',
          content: assessPrompts.buildFirstUserMessage({
            supplierName: ctx.supplier.rosterName ?? ctx.args.supplierId,
            programName: ctx.program?.name ?? '(unnamed program)',
            roundN,
            brief: ctx.brief,
            frozenInputs: JSON.stringify(ctx.frozenInputs, null, 2),
            objections: objections.length > 0 ? objections : undefined,
          }),
        },
      ],
      caps: JOB_CAPS.assess,
      roundN,
      toolDigest: registry.digest(ctx.proposerTools),
    },
    ctx.deps.modelCtx,
  );

  if (result.status !== 'done') {
    /**
     * A ceiling or a budget pause leaves the loop here, and neither is a
     * failure of the draft: `raiseIfStopped` takes them out of the retry
     * budget entirely, because three more attempts against the same ceiling
     * spend the ceiling three more times.
     */
    raiseIfStopped(result);
    // The LOOP failed — transport, refusal, a truncated turn. Distinct from our
    // zod refinements rejecting a well-formed request's answer.
    return {
      kind: 'loop_failure',
      message:
        `the loop ended as ${result.status}` + ('error' in result ? `: ${result.error}` : ''),
    };
  }
  /**
   * Read the proposal out of the message rather than out of the tool's `run()`
   * — the agents propose, and our code settles — and read the **last** one,
   * parsed against the tool's own schema. A first submission the SDK's parse
   * refused never reaches `run()`, and the model's answer to that objection is
   * the submission after it.
   *
   * An Assessment exists only when `submit_assessment` runs, so a refused or
   * empty turn makes no record at all: the empty-Assessment failure is
   * structurally impossible rather than guarded against.
   */
  const submitted = readSubmission<AssessDraft>(result.toolUses, 'submit_assessment');
  if (!submitted.ok) return { kind: 'refinement_failure', message: submitted.message };
  return { kind: 'draft', draft: submitted.value, text: JSON.stringify(submitted.value) };
}

async function validateAssessDraft(
  ctx: AssessRoundContext,
  draft: AssessDraft,
): Promise<Objection[]> {
  const evidence = await buildEvidence(ctx.db, {
    programId: ctx.args.programId,
    supplierIds: [ctx.args.supplierId],
    frozenInputs: ctx.frozenInputs,
    citations: draft.sentences.flatMap((s) => s.citations),
  });
  return checkAssessment({
    verdict: draft.verdict,
    sentences: draft.sentences,
    supplierId: ctx.args.supplierId,
    evidence,
  });
}

/**
 * The evaluator turn.
 *
 * It is **stateless** and sees exactly what the proposer saw — never its own
 * earlier objections, and never the replies to them. What it returns is a
 * submitted verdict rather than prose: see `evaluation.ts` for why the parse
 * that used to read the six items out of a paragraph is gone.
 */
async function runAssessEvaluate(
  ctx: AssessRoundContext,
  roundArgs: { roundN: number; draft: AssessDraft },
): Promise<EvaluationResult> {
  const { roundN, draft } = roundArgs;
  const registry = getRegistry();
  const tools = registry.forNarrativeRole('assess', 'evaluator');

  return evaluateWithVerdict(async () => {
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
         * The one difference is the write: `submit_evaluation` in place of
         * `submit_assessment`. The proposer proposes, the evaluator judges,
         * and neither can do the other's job.
         */
        tools: toRunnableTools(tools, ctx.deps.toolCtx),
        messages: [
          {
            role: 'user',
            content: [
              assessPrompts.buildFirstUserMessage({
                supplierName: ctx.supplier.rosterName ?? ctx.args.supplierId,
                programName: ctx.program?.name ?? '(unnamed program)',
                roundN,
                brief: ctx.brief,
                frozenInputs: JSON.stringify(ctx.frozenInputs, null, 2),
              }),
              '',
              'THE DRAFT TO REVIEW',
              JSON.stringify(draft, null, 2),
              '',
              'Call submit_evaluation once, with a verdict for every rubric item.',
            ].join('\n'),
          },
        ],
        caps: JOB_CAPS.assess,
        roundN,
        /**
         * **The evaluator's turns carry a tool digest too** (SPEC §15.7).
         *
         * It had none, so half of every assess Job's Trace recorded no tool
         * names and no digest hash — and the fixture manifest, which reads the
         * digest off the turns, could only ever see the proposer's list. A
         * Round where the evaluator's tools changed would have replayed
         * without anything saying so.
         */
        toolDigest: registry.digest(tools),
      },
      ctx.deps.modelCtx,
    );

    /**
     * **The evaluator's stops are the Job's stops too.** A ceiling or a budget
     * pause is not a verdict the loop can score and not a turn worth retrying:
     * `raiseIfStopped` takes both out of the free retry below, because a second
     * attempt against the same ceiling spends the same ceiling again.
     */
    raiseIfStopped(result);
    return result;
  });
}

export { citationKey };
