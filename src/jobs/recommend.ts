import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { JOB_CAPS } from '@/config/constants';
import type { FrozenInputs } from '@/domain/staleness';
import {
  checkRecommendation,
  type Objection,
  type SubmittedPick,
  type SubmittedSentence,
} from '@/domain/validation/submit-checks';
import { runLoop } from '@/model';
import { toRunnableTools } from '@/model/tool-adapter';
import * as recommendPrompts from '@/model/prompts/recommend';
import { getRegistry, type ToolContext, type ToolDefinition } from '@/tools';
import type { ModelContext } from '@/model/types';
import { buildEvidence, buildFrozenInputs } from './assess';
import { evaluateWithVerdict } from './evaluation';
import { publishVersion } from './publish';
import { roundCheckpoint } from './round-checkpoint';
import { readSubmission } from './submission';
import { UnpublishableDraftError, type EvaluationResult, type ProposalResult } from './rounds';
import { runProposerEvaluatorLoop } from './rounds';
import { raiseIfStopped } from './stops';

/**
 * The recommend Job (SPEC §10).
 *
 * One Recommendation per Program × Category — eight per full run.
 *
 * Its shape differs from Assess in exactly one structural way, and that
 * difference is the reason it is a separate file rather than a parameter:
 *
 * > **The analyst runs at Round 1 only.**
 *
 * Its brief is built from inputs that do not move between Rounds, so re-running
 * it each Round would cost 72 calls across the eight Recommendations instead of
 * 8 + 48. The analyst gathers and does not conclude — and the lead may not cite
 * its prose, because a Citation points at evidence and letting an unproven
 * claim be inherited by reference is exactly what that rule stops. **So the
 * brief carries row ids, not conclusions.**
 */

export type RecommendDraft = { picks: SubmittedPick[]; sentences: SubmittedSentence[] };

export type RecommendDeps = {
  db: Database;
  toolCtx: ToolContext;
  modelCtx: ModelContext;
  jobId?: string | undefined;
};

export async function recommendCategory(
  deps: RecommendDeps,
  args: { programId: string; categoryId: string },
): Promise<{ versionId: string; n: number; evaluatorOutcome: string; roundsUsed: number }> {
  const { db } = deps;
  const ctx = await loadRecommendContext(deps, args);

  const outcome = await runProposerEvaluatorLoop<RecommendDraft>({
    propose: (roundArgs) => runRecommendPropose(ctx, roundArgs),
    validate: (draft) => validateRecommendDraft(ctx, draft),
    evaluate: (roundArgs) => runRecommendEvaluate(ctx, roundArgs),
    // Eight Categories at up to three Rounds each is where a restart costs
    // most, so a paused recommend continues from the Round it reached.
    ...(deps.jobId ? { checkpoint: roundCheckpoint<RecommendDraft>(db, deps.jobId) } : {}),
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
      'recommendation',
      outcome.dissent.map((d) => d.objection),
    );
  }

  const published = await publishVersion(db, {
    target: {
      kind: 'recommendation',
      programId: args.programId,
      categoryId: args.categoryId,
      picks: outcome.draft.picks,
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

/** Everything a Round of the lead/evaluator loop reads, built once. */
type RecommendRoundContext = {
  db: Database;
  deps: RecommendDeps;
  args: { programId: string; categoryId: string };
  program: typeof t.program.$inferSelect | undefined;
  category: typeof t.category.$inferSelect;
  brief: string;
  leadTools: ToolDefinition[];
  frozenInputs: FrozenInputs;
  supplierIds: string[];
};

async function loadRecommendContext(
  deps: RecommendDeps,
  args: { programId: string; categoryId: string },
): Promise<RecommendRoundContext> {
  const { db } = deps;
  const registry = getRegistry();

  const program = await db.query.program.findFirst({ where: eq(t.program.id, args.programId) });
  const category = await db.query.category.findFirst({ where: eq(t.category.id, args.categoryId) });
  if (!category) throw new Error(`no category ${args.categoryId}`);

  const bidders = await db
    .select({ supplierId: t.supplierCategory.supplierId })
    .from(t.supplierCategory)
    .where(eq(t.supplierCategory.categoryId, args.categoryId))
    // Ordered, because the shortlist order reaches the prompt.
    .orderBy(asc(t.supplierCategory.supplierId));
  const supplierIds = bidders.map((b) => b.supplierId);

  const frozenInputs = await buildFrozenInputs(db, { programId: args.programId, supplierIds });

  /**
   * The analyst pass — **Round 1 only**.
   *
   * Run once, before the loop, and its output threaded into every Round. That
   * is the whole of the 8 + 48 rather than 72 arithmetic.
   */
  const briefTool = registry.byName.get('get_recommendation_brief')!;
  const briefResult = await briefTool.handler(
    { programId: args.programId, categoryId: args.categoryId },
    deps.toolCtx,
  );
  const brief = briefResult.ok
    ? JSON.stringify(briefResult.data, null, 2)
    : '(the brief could not be built)';

  // Derived per role, so the lead's list and the evaluator's cannot drift apart
  // — the evaluator reads what the lead read, and writes a verdict instead.
  const leadTools = registry.forNarrativeRole('recommend', 'proposer');

  return { db, deps, args, program, category, brief, leadTools, frozenInputs, supplierIds };
}

async function runRecommendPropose(
  ctx: RecommendRoundContext,
  roundArgs: { roundN: number; objections: string[] },
): Promise<ProposalResult<RecommendDraft>> {
  const { roundN, objections } = roundArgs;
  const registry = getRegistry();
  const result = await runLoop(
    {
      loop: 'recommend',
      system: recommendPrompts.leadSystem,
      tools: toRunnableTools(ctx.leadTools, ctx.deps.toolCtx),
      messages: [
        {
          role: 'user',
          content: recommendPrompts.buildFirstUserMessage({
            programName: ctx.program?.name ?? '(unnamed program)',
            categoryName: `${ctx.category.code} — ${ctx.category.name}`,
            roundN,
            brief: ctx.brief,
            frozenInputs: JSON.stringify(ctx.frozenInputs, null, 2),
            objections: objections.length > 0 ? objections : undefined,
          }),
        },
      ],
      caps: JOB_CAPS.recommend,
      roundN,
      toolDigest: registry.digest(ctx.leadTools),
    },
    ctx.deps.modelCtx,
  );

  if (result.status !== 'done') {
    // A ceiling or a budget pause is not the draft's fault, and retrying it
    // three times only spends the ceiling three more times.
    raiseIfStopped(result);
    // The LOOP failed — transport, refusal, a truncated turn. Distinct from our
    // zod refinements rejecting a well-formed request's answer.
    return {
      kind: 'loop_failure',
      message:
        `the loop ended as ${result.status}` + ('error' in result ? `: ${result.error}` : ''),
    };
  }

  // The LAST submission, parsed against the tool's own schema: a first one the
  // SDK's parse refused never reached `run()`, and what follows it is the
  // model's answer to that objection.
  const submitted = readSubmission<RecommendDraft>(result.toolUses, 'submit_recommendation');
  if (!submitted.ok) return { kind: 'refinement_failure', message: submitted.message };
  return {
    kind: 'draft',
    draft: { picks: submitted.value.picks ?? [], sentences: submitted.value.sentences },
    text: JSON.stringify(submitted.value),
  };
}

async function validateRecommendDraft(
  ctx: RecommendRoundContext,
  draft: RecommendDraft,
): Promise<Objection[]> {
  const evidence = await buildEvidence(ctx.db, {
    programId: ctx.args.programId,
    supplierIds: ctx.supplierIds,
    frozenInputs: ctx.frozenInputs as unknown as Record<string, unknown>,
    citations: draft.sentences.flatMap((s) => s.citations),
  });
  return checkRecommendation({
    picks: draft.picks,
    sentences: draft.sentences,
    categoryId: ctx.args.categoryId,
    evidence,
  });
}

/**
 * The evaluator turn.
 *
 * Stateless, and it sees EXACTLY what the lead saw — the analyst brief, the
 * frozen inputs, the draft and the rubric. Judging an argument against evidence
 * the arguer never had produces objections nobody can act on.
 */
async function runRecommendEvaluate(
  ctx: RecommendRoundContext,
  roundArgs: { roundN: number; draft: RecommendDraft },
): Promise<EvaluationResult> {
  const { roundN, draft } = roundArgs;
  const registry = getRegistry();
  const tools = registry.forNarrativeRole('recommend', 'evaluator');

  return evaluateWithVerdict(async () => {
    const result = await runLoop(
      {
        loop: 'recommend',
        system: recommendPrompts.evaluatorSystem,
        /**
         * **The evaluator reads what the lead read.**
         *
         * It had no tools at all — asked to judge whether a Recommendation's
         * claims are supported, with no way to look at a single row. The
         * assess evaluator had the same fault in milder form and said so
         * across three Rounds; see `assess.ts` for the objection it raised.
         *
         * The one difference from the lead's list is the write:
         * `submit_evaluation` in place of `submit_recommendation`. One
         * proposes and the other judges; it is not that one can see and the
         * other cannot.
         */
        tools: toRunnableTools(tools, ctx.deps.toolCtx),
        messages: [
          {
            role: 'user',
            content: [
              recommendPrompts.buildFirstUserMessage({
                programName: ctx.program?.name ?? '(unnamed program)',
                categoryName: `${ctx.category.code} — ${ctx.category.name}`,
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
        caps: JOB_CAPS.recommend,
        roundN,
        // The evaluator's turns carry their tool digest too (SPEC §15.7) — see
        // the assess loop for what a Trace without one could not have shown.
        toolDigest: registry.digest(tools),
      },
      ctx.deps.modelCtx,
    );

    // The evaluator's stops are the Job's stops too — a ceiling or a budget
    // pause is raised rather than retried. See the assess loop.
    raiseIfStopped(result);
    return result;
  });
}

/** Registers both agentic Job kinds with the worker. */
export function narrativeHandlers(deps: {
  makeToolCtx: (job: typeof t.job.$inferSelect) => ToolContext;
  makeModelCtx: (job: typeof t.job.$inferSelect) => ModelContext;
}) {
  return {
    recommend: async (job: typeof t.job.$inferSelect, db: Database) => {
      const category = await db.query.category.findFirst({
        where: eq(t.category.id, job.subjectId),
      });
      if (!category) return { state: 'failed' as const, error: `no category ${job.subjectId}` };
      await recommendCategory(
        { db, toolCtx: deps.makeToolCtx(job), modelCtx: deps.makeModelCtx(job), jobId: job.id },
        { programId: category.programId, categoryId: category.id },
      );
      return { state: 'done' as const };
    },
  };
}

export { and };
