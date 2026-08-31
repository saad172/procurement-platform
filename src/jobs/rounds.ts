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
  | { kind: 'refinement_failure'; message: string }
  /**
   * The **loop** failed — a transport error, a refusal, a cap. Not the model
   * mis-shaping its output.
   *
   * It retries on the same budget, because a connection error is worth another
   * go, but it is reported separately: three `Connection error`s once exhausted
   * the retries and the Job announced *"the proposer could not produce a
   * well-shaped draft in 3 attempts"* — blaming the model for a network fault,
   * in the one sentence a person would read to find out what happened.
   */
  | { kind: 'loop_failure'; message: string };

export type EvaluationResult =
  | { kind: 'pass'; rubric: unknown; text: string }
  | { kind: 'objections'; objections: string[]; rubric: unknown; text: string };

/**
 * Three Rounds could not produce a document that passes our own checks.
 *
 * Named, rather than a bare throw, so a worker can tell this from a crash: the
 * Job did everything it was asked and the answer is that there is nothing
 * publishable — which is a result, not a malfunction.
 */
export class UnpublishableDraftError extends Error {
  constructor(
    readonly kind: string,
    readonly objections: readonly string[],
  ) {
    super(
      [
        `The ${kind} was rejected by our own checks in every round, so nothing was published.`,
        ...objections.map((objection) => `  - ${objection}`),
      ].join('\n'),
    );
    this.name = 'UnpublishableDraftError';
  }
}

export type LoopOutcome<TDraft> = {
  /** The draft to publish. Present unless the loop never produced one at all. */
  draft: TDraft | undefined;
  /**
   * `rejected_by_code` is **not publishable**, and that is the distinction the
   * other two do not carry.
   *
   * Dissent is *the evaluator's* unanswered objections — matters of judgement,
   * which a reader can weigh. A **code** objection is not a matter of
   * judgement: a Citation pointing at a row that does not exist cannot be
   * inserted at all, and a number matching nothing must not be published
   * whatever anyone thinks of it.
   *
   * The loop used to fall through to `published_with_objections` after
   * `MAX_ROUNDS` regardless — publishing a draft its own validator had just
   * rejected. It surfaced as a Job crashing on a foreign key, three Rounds
   * after the check that should have stopped it.
   */
  evaluatorOutcome: 'passed' | 'published_with_objections' | 'rejected_by_code';
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
  /** Empty unless the most recent draft failed the code checks. */
  let lastCodeObjections: Objection[] = [];

  for (let roundN = 1; roundN <= maxRounds; roundN += 1) {
    // ── Propose, with free retries for a mis-shaped output ─────────────────
    let proposal: ProposalResult<TDraft> | undefined;
    for (let retry = 0; retry <= MAX_FREE_RETRIES_PER_ROUND; retry += 1) {
      proposal = await deps.propose({ roundN, objections: carriedObjections });
      if (proposal.kind === 'draft') break;
      // A refinement failure is the model mis-shaping its output. It retries
      // free and THE ROUND COUNTER DOES NOT ADVANCE — charging a Round for
      // punctuation would spend the budget in the wrong place.
      //
      // Logged as well as recorded: when every retry fails the Job produces no
      // draft at all, and the `round` rows that would have explained why are
      // never persisted, because persisting them is `publishVersion`'s job and
      // there is nothing to publish.
      // `attempt N of M`, not `retry N of M`: the first try is not a retry, and
      // a log line reading "free retry 3/2" makes a reader doubt the counter
      // rather than read the message.
      const attempt = `attempt ${retry + 1} of ${MAX_FREE_RETRIES_PER_ROUND + 1}`;
      const what = proposal.kind === 'loop_failure' ? 'the loop failed' : 'output shape rejected';
      console.error(`[loop] round ${roundN}, ${attempt}, ${what}: ${proposal.message}`);
      rounds.push({
        n: roundN,
        role: 'proposer',
        source: 'code',
        objection: `${what} (${attempt}): ${proposal.message}`,
      });
    }

    if (!proposal || proposal.kind !== 'draft') {
      /**
       * Out of attempts. A broken loop, not a disagreement — and **which** kind
       * of broken is the whole value of the message.
       */
      const attempts = MAX_FREE_RETRIES_PER_ROUND + 1;
      const objection =
        proposal?.kind === 'loop_failure'
          ? `The model loop failed on all ${attempts} attempts. The last failure was: ${proposal.message}`
          : `The proposer could not produce a well-shaped draft in ${attempts} attempts.`;

      return {
        draft: lastDraft,
        evaluatorOutcome: 'published_with_objections',
        rounds,
        dissent: [{ objection, reply: undefined }],
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
      lastCodeObjections = codeObjections;
      continue;
    }
    lastCodeObjections = [];

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

  /**
   * A draft that never passed the code checks is **not published**.
   *
   * A run must complete, and for a disagreement of judgement that means
   * publishing with the dissent attached. It cannot mean publishing something
   * that fails a check no reader can overrule — the insert would refuse it, and
   * a Job that crashes on a constraint three Rounds later has spent the whole
   * budget to arrive at an error it could have named in Round 1.
   */
  if (lastCodeObjections.length > 0) {
    return {
      draft: undefined,
      evaluatorOutcome: 'rejected_by_code',
      rounds,
      dissent: lastCodeObjections.map((o) => ({ objection: `[${o.check}] ${o.message}`, reply: undefined })),
      roundsUsed: maxRounds,
    };
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
