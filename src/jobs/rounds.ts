import { MAX_FREE_RETRIES_PER_ROUND, MAX_ROUNDS } from '@/config/constants';
import type { Objection } from '@/domain/validation/submit-checks';

/**
 * The proposer → evaluator loop, shared by Assess and Recommend (SPEC §10.5).
 *
 * **The three failure tiers, stated once so nothing re-decides them:**
 *
 * | Tier | What it is | Cost |
 * |---|---|---|
 * | JSON Schema violation | `strict: true` is on every model-facing tool | **impossible** |
 * | Refinement failure | our zod refinements | **free retry**, ≤ 2 per Round, counter does not advance |
 * | Validator failure | citation, number fidelity, caveats, pick legality | **costs a Round** |
 *
 * The distinction is not bookkeeping. A refinement failure is the model
 * mis-shaping its output, which it can fix on being told — charging a Round for
 * that would spend the budget on punctuation. A validator failure is a
 * substantive disagreement about evidence, and that is exactly what a Round is
 * for.
 *
 * **At `MAX_ROUNDS` without convergence the version publishes** as
 * `published_with_objections`, and the survivors become the dissent block.
 * **Nobody writes dissent** — it is what the disagreement left behind. A run
 * must complete.
 */

export type RoundRecord = {
  n: number;
  role: 'proposer' | 'lead' | 'evaluator' | 'human';
  source: 'model' | 'code' | 'human';
  text?: string | undefined;
  objection?: string | undefined;
  reply?: string | undefined;
  rubric?: unknown;
};

export type ProposalResult<TDraft> =
  /** The model produced a well-shaped draft. */
  | { kind: 'draft'; draft: TDraft; text: string }
  /** Our zod refinements rejected it. Free retry; the counter does not advance. */
  | { kind: 'refinement_failure'; message: string };

export type EvaluationResult =
  | { kind: 'pass'; rubric: unknown; text: string }
  | { kind: 'objections'; objections: string[]; rubric: unknown; text: string };

export type LoopOutcome<TDraft> = {
  /** The draft to publish. Present unless the loop never produced one at all. */
  draft: TDraft | undefined;
  evaluatorOutcome: 'passed' | 'published_with_objections';
  rounds: RoundRecord[];
  /** The objections that survived, each with the reply it drew. This IS dissent. */
  dissent: { objection: string; reply: string | undefined }[];
  roundsUsed: number;
};

export type LoopDeps<TDraft> = {
  /** One proposer (or lead) turn. */
  propose: (args: { roundN: number; objections: string[] }) => Promise<ProposalResult<TDraft>>;
  /**
   * Our code checks, run before the insert. A non-empty return **costs a
   * Round** and is stored as `round(role='evaluator', source='code')`.
   */
  validate: (draft: TDraft) => Promise<Objection[]>;
  /**
   * The stateless evaluator. It sees exactly what the lead saw — never its own
   * earlier objections, and never the replies to them.
   */
  evaluate: (args: { roundN: number; draft: TDraft }) => Promise<EvaluationResult>;
  maxRounds?: number | undefined;
};

export async function runProposerEvaluatorLoop<TDraft>(
  deps: LoopDeps<TDraft>,
): Promise<LoopOutcome<TDraft>> {
  const maxRounds = deps.maxRounds ?? MAX_ROUNDS;
  const rounds: RoundRecord[] = [];
  let carriedObjections: string[] = [];
  let lastDraft: TDraft | undefined;

  for (let roundN = 1; roundN <= maxRounds; roundN += 1) {
    // ── Propose, with free retries for a mis-shaped output ─────────────────
    let proposal: ProposalResult<TDraft> | undefined;
    for (let retry = 0; retry <= MAX_FREE_RETRIES_PER_ROUND; retry += 1) {
      proposal = await deps.propose({ roundN, objections: carriedObjections });
      if (proposal.kind === 'draft') break;
      // A refinement failure is the model mis-shaping its output. It retries
      // free and THE ROUND COUNTER DOES NOT ADVANCE — charging a Round for
      // punctuation would spend the budget in the wrong place.
      rounds.push({
        n: roundN,
        role: 'proposer',
        source: 'code',
        objection: `Output shape rejected (free retry ${retry + 1} of ${MAX_FREE_RETRIES_PER_ROUND}): ${proposal.message}`,
      });
    }

    if (!proposal || proposal.kind !== 'draft') {
      // Out of free retries. This is a broken loop, not a disagreement.
      return {
        draft: lastDraft,
        evaluatorOutcome: 'published_with_objections',
        rounds,
        dissent: [
          {
            objection: `The proposer could not produce a well-shaped draft in ${MAX_FREE_RETRIES_PER_ROUND + 1} attempts.`,
            reply: undefined,
          },
        ],
        roundsUsed: roundN,
      };
    }

    lastDraft = proposal.draft;
    rounds.push({ n: roundN, role: 'proposer', source: 'model', text: proposal.text });

    // ── Our code checks, BEFORE the evaluator and before any insert ────────
    const codeObjections = await deps.validate(proposal.draft);
    if (codeObjections.length > 0) {
      // A validator failure COSTS A ROUND and is recorded as one, with
      // source='code' — so the Runs page can report "62 rounds · 14 spent on
      // code rejections", which makes Round consumption a quality number.
      rounds.push({
        n: roundN,
        role: 'evaluator',
        source: 'code',
        objection: codeObjections.map((o) => `[${o.check}] ${o.message}`).join('\n'),
      });
      carriedObjections = codeObjections.map((o) => o.message);
      continue;
    }

    // ── The stateless evaluator ────────────────────────────────────────────
    const evaluation = await deps.evaluate({ roundN, draft: proposal.draft });
    rounds.push({
      n: roundN,
      role: 'evaluator',
      source: 'model',
      text: evaluation.text,
      rubric: evaluation.rubric,
      objection: evaluation.kind === 'objections' ? evaluation.objections.join('\n') : undefined,
    });

    if (evaluation.kind === 'pass') {
      return { draft: proposal.draft, evaluatorOutcome: 'passed', rounds, dissent: [], roundsUsed: roundN };
    }
    carriedObjections = evaluation.objections;
  }

  // ── MAX_ROUNDS without convergence: PUBLISH, carrying the dissent ────────
  // A run must complete. The survivors are what the disagreement left behind,
  // each paired with the reply it drew — nobody writes dissent.
  return {
    draft: lastDraft,
    evaluatorOutcome: 'published_with_objections',
    rounds,
    dissent: carriedObjections.map((objection) => ({
      objection,
      reply: replyTo(objection, rounds),
    })),
    roundsUsed: maxRounds,
  };
}

/** The proposer turn that followed an objection is the reply it drew. */
function replyTo(objection: string, rounds: readonly RoundRecord[]): string | undefined {
  const raised = rounds.findIndex((r) => r.objection?.includes(objection));
  if (raised === -1) return undefined;
  return rounds.slice(raised + 1).find((r) => r.role === 'proposer' && r.source === 'model')?.text;
}
