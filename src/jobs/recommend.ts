import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '@/db/client';
import * as t from '@/db/schema';
import { JOB_CAPS } from '@/config/constants';
import {
  checkRecommendation,
  type SubmittedPick,
  type SubmittedSentence,
} from '@/domain/validation/submit-checks';
import { runLoop } from '@/model';
import { toRunnableTools } from '@/model/tool-adapter';
import * as recommendPrompts from '@/model/prompts/recommend';
import { getRegistry, type ToolContext } from '@/tools';
import type { ModelContext } from '@/model/types';
import { buildEvidence, buildFrozenInputs, parseObjections } from './assess';
import { publishVersion } from './publish';
import { UnpublishableDraftError } from './rounds';
import { runProposerEvaluatorLoop } from './rounds';

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

  const leadTools = [
    registry.byName.get('get_shortlist')!,
    registry.byName.get('get_supplier')!,
    registry.byName.get('get_supplier_family')!,
    registry.byName.get('get_recommendation_brief')!,
    registry.byName.get('get_category')!,
    registry.byName.get('submit_recommendation')!,
  ];

  const outcome = await runProposerEvaluatorLoop<RecommendDraft>({
    propose: async ({ roundN, objections }) => {
      const result = await runLoop(
        {
          loop: 'recommend',
          system: recommendPrompts.leadSystem,
          tools: toRunnableTools(leadTools, deps.toolCtx),
          messages: [
            {
              role: 'user',
              content: recommendPrompts.buildFirstUserMessage({
                programName: program?.name ?? '(unnamed programme)',
                categoryName: `${category.code} — ${category.name}`,
                roundN,
                brief,
                frozenInputs: JSON.stringify(frozenInputs, null, 2),
                objections: objections.length > 0 ? objections : undefined,
              }),
            },
          ],
          caps: JOB_CAPS.recommend,
          roundN,
          toolDigest: registry.digest(leadTools),
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

      const submitted = result.toolUses.find((u) => u.name === 'submit_recommendation')?.input as
        | RecommendDraft
        | undefined;
      if (!submitted?.sentences?.length) {
        return {
          kind: 'refinement_failure',
          message:
            `the loop ended without a usable submit_recommendation payload ` +
            `(tools called: ${result.toolUses.map((u) => u.name).join(', ') || 'none'})`,
        };
      }
      return {
        kind: 'draft',
        draft: { picks: submitted.picks ?? [], sentences: submitted.sentences },
        text: JSON.stringify(submitted),
      };
    },

    validate: async (draft) => {
      const evidence = await buildEvidence(db, {
        programId: args.programId,
        supplierIds,
        frozenInputs: frozenInputs as unknown as Record<string, unknown>,
        citations: draft.sentences.flatMap((s) => s.citations),
      });
      return checkRecommendation({
        picks: draft.picks,
        sentences: draft.sentences,
        categoryId: args.categoryId,
        evidence,
      });
    },

    evaluate: async ({ roundN, draft }) => {
      // Stateless, and sees EXACTLY what the lead saw — the analyst brief, the
      // frozen inputs, the draft and the rubric. Judging an argument against
      // evidence the arguer never had produces objections nobody can act on.
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
           * It still cannot **write**: no `submit_recommendation`. The
           * asymmetry that matters is that one proposes and the other judges,
           * not that one can see and the other cannot.
           */
          tools: toRunnableTools(
            leadTools.filter((tool) => tool.name !== 'submit_recommendation'),
            deps.toolCtx,
          ),
          messages: [
            {
              role: 'user',
              content: [
                recommendPrompts.buildFirstUserMessage({
                  programName: program?.name ?? '(unnamed programme)',
                  categoryName: `${category.code} — ${category.name}`,
                  roundN,
                  brief,
                  frozenInputs: JSON.stringify(frozenInputs, null, 2),
                }),
                '',
                'THE DRAFT TO REVIEW',
                JSON.stringify(draft, null, 2),
              ].join('\n'),
            },
          ],
          caps: JOB_CAPS.recommend,
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

/** Registers both agentic Job kinds with the worker. */
export function narrativeHandlers(deps: {
  makeToolCtx: (job: typeof t.job.$inferSelect) => ToolContext;
  makeModelCtx: (job: typeof t.job.$inferSelect) => ModelContext;
}) {
  return {
    recommend: async (job: typeof t.job.$inferSelect, db: Database) => {
      const category = await db.query.category.findFirst({ where: eq(t.category.id, job.subjectId) });
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
