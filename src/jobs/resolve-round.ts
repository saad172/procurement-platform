import { JOB_CAPS } from '@/config/constants';
import { runLoop } from '@/model';
import type { ModelContext } from '@/model/types';
import * as resolvePrompts from '@/model/prompts/resolve';
import { getRegistry } from '@/tools';
import { toRunnableTools } from '@/model/tool-adapter';
import type { ToolContext } from '@/tools/define';
import {
  runDiscriminators,
  type CandidateFacts,
  type RosterRow,
} from '@/domain/match/discriminators';
import type { ResolveDeps } from './resolve';

/**
 * One Match Round: a resolver, then a **blind** evaluator (SPEC §6).
 *
 * ## The two agents never meet
 *
 * The resolver proposes; the evaluator is shown the same candidates *shuffled*,
 * is never told what the resolver picked, and is never asked whether it agrees.
 * **Agreement is our code comparing two entity ids** — which is why the
 * comparison lives in `resolveSupplier` and not here, and why neither prompt
 * contains the word.
 *
 * That is the whole reason a second agent is worth its tokens. An evaluator
 * shown the resolver's answer and asked "do you agree?" measures agreeableness;
 * one shown only the evidence measures the evidence.
 *
 * ## The shuffle is seeded, and that is not a detail
 *
 * `shuffledForEvaluator` arrives already shuffled from a seed derived from the
 * attempt and the Round. Unseeded, the evaluator's *prompt* would differ
 * between a recording and its replay, so the stored response would be answering
 * a different question. The shuffle exists to remove positional bias, not to be
 * unpredictable.
 *
 * ## Rungs are derived, never passed
 *
 * `registry.forMatchRound(roundN)` decides which query tools exist this Round —
 * Round 1 offers R2 only, Rounds 2 and 3 offer R3. So *"the resolver called an
 * R3 tool before the R2 one"* is unrepresentable rather than tested for, and
 * neither prompt has to be trusted to obey a rung order.
 */

export type ResolveRoundDeps = {
  toolCtx: ToolContext;
  modelCtx: ModelContext;
};

/** What each agent submits. The two tools are separate so the Trace names who spoke. */
type Submission = {
  entityId: string | null;
  verdicts: { discriminator: string; verdict: 'pass' | 'fail' | 'unavailable'; reasoning: string }[];
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
};

/**
 * Builds the `runRound` that `resolveSupplier` takes as a dependency.
 *
 * It is a dependency rather than an import so the deterministic half of the Job
 * — the Discriminators, the auto-accept gate, the shuffle — stays testable with
 * no model at all, and so every model call in this Job goes through `runLoop()`
 * and nowhere else.
 */
export function makeRunRound(deps: ResolveRoundDeps): NonNullable<ResolveDeps['runRound']> {
  const registry = getRegistry();

  return async ({ roster, candidates, roundN, objection, shuffledForEvaluator }) => {
    const roundTools = registry.forMatchRound(roundN);

    /**
     * Each agent gets its own submit tool and not the other's.
     *
     * A resolver holding `submit_match_verdict` could file the evaluator's
     * verdict, and the Trace would record a Round that never happened.
     */
    const resolverTools = roundTools.filter((tool) => tool.name !== 'submit_match_verdict');
    const evaluatorTools = roundTools.filter((tool) => tool.name !== 'submit_match_proposal');

    const resolver = await runAgent({
      deps,
      loopTools: resolverTools,
      system: resolvePrompts.resolverSystem,
      submitToolName: 'submit_match_proposal',
      roundN,
      message: resolvePrompts.buildFirstUserMessage({
        rosterName: roster.name,
        rosterAddress: roster.address ?? null,
        rosterCountry: roster.country ?? null,
        roundN,
        objection,
        candidateSummaries: candidates.map(summarise),
      }),
    });

    const evaluator = await runAgent({
      deps,
      loopTools: evaluatorTools,
      system: resolvePrompts.evaluatorSystem,
      submitToolName: 'submit_match_verdict',
      roundN,
      // Shuffled, and carrying no trace of the resolver's answer.
      message: resolvePrompts.buildFirstUserMessage({
        rosterName: roster.name,
        rosterAddress: roster.address ?? null,
        rosterCountry: roster.country ?? null,
        roundN,
        objection,
        candidateSummaries: shuffledForEvaluator.map(summarise),
      }),
    });

    /**
     * The verdicts recorded are **our** Discriminator run over each agent's
     * pick, not the verdicts the agent reported.
     *
     * An agent's own verdict list is what it *says* it saw; running the
     * Discriminators over the entity it picked is what was actually there. The
     * Needs Review view shows both agents' per-Discriminator results, and both
     * columns have to mean the same thing for the comparison to be readable.
     */
    return {
      resolverPick: resolver?.entityId ?? null,
      evaluatorPick: evaluator?.entityId ?? null,
      resolverVerdicts: verdictsFor(roster, candidates, resolver?.entityId ?? null),
      evaluatorVerdicts: verdictsFor(roster, candidates, evaluator?.entityId ?? null),
      // Carried into the next Round's prompt, so a disagreement is argued rather
      // than merely repeated.
      objection: disagreementObjection(resolver, evaluator),
    };
  };
}

/** Runs one agent and reads its submission out of the message, not the tool. */
async function runAgent(args: {
  deps: ResolveRoundDeps;
  loopTools: ReturnType<ReturnType<typeof getRegistry>['forMatchRound']>;
  system: string;
  submitToolName: string;
  roundN: number;
  message: string;
}): Promise<Submission | null> {
  const registry = getRegistry();
  const result = await runLoop(
    {
      loop: 'resolve',
      system: args.system,
      tools: toRunnableTools(args.loopTools, args.deps.toolCtx),
      messages: [{ role: 'user', content: args.message }],
      caps: JOB_CAPS.resolve,
      roundN: args.roundN,
      toolDigest: registry.digest(args.loopTools),
    },
    args.deps.modelCtx,
  );

  /**
   * A **terminated** loop is still read for a submission.
   *
   * A ceiling firing one turn after the model submitted is common — the submit
   * turn is the expensive one, because its request carries everything the Round
   * gathered. Discarding the answer then reports "no pick" for a Round that
   * produced one, and the next Round re-does the work that hit the ceiling.
   *
   * It is logged, because a Round that only just fitted is worth knowing about
   * even when it worked.
   */
  if (result.status === 'terminated') {
    console.warn(`[resolve] round ${args.roundN} ${args.submitToolName}: ${result.reason}`);
  } else if (result.status !== 'done') {
    return null;
  }

  // The proposal is read from the MESSAGE, not from the tool's `run()`. A
  // terminal tool's handler is not guaranteed to have fired, and the agents
  // propose while our code settles.
  return (result.toolUses.find((use) => use.name === args.submitToolName)?.input as Submission | undefined) ?? null;
}

/**
 * One line per candidate — enough to choose between them, and no more.
 *
 * The agents have `sayari_get_entity` for anything deeper. Pasting whole
 * entities here would put five 40 KB records in front of a question that turns
 * on a name, a city and an identifier.
 */
function summarise(candidate: CandidateFacts): string {
  const cities = candidate.addresses
    .map((address) => address.city)
    .filter((city): city is string => Boolean(city));
  return [
    `${candidate.entityId}  ${candidate.label}`,
    `country=${candidate.country ?? '?'}`,
    `lei=${candidate.lei ?? 'none'}`,
    `addresses=${candidate.addresses.length}${cities.length > 0 ? ` (${cities.slice(0, 4).join(', ')})` : ''}`,
  ].join('  ');
}

/** Our Discriminators over the picked candidate, or an empty list for no pick. */
function verdictsFor(
  roster: RosterRow,
  candidates: CandidateFacts[],
  entityId: string | null,
): ReturnType<typeof runDiscriminators> {
  const picked = entityId ? candidates.find((candidate) => candidate.entityId === entityId) : undefined;
  return picked ? runDiscriminators(roster, picked) : [];
}

/**
 * The objection carried into the next Round.
 *
 * It states **what the disagreement is**, in the two agents' own words, and
 * proposes nothing. An objection that told the next Round which answer to
 * prefer would be the settlement arriving early, dressed as evidence.
 */
function disagreementObjection(
  resolver: Submission | null,
  evaluator: Submission | null,
): string | undefined {
  if (!resolver && !evaluator) return 'Neither agent submitted a pick.';
  if (resolver?.entityId === evaluator?.entityId) return undefined;

  return [
    `The two independent reads disagreed.`,
    `  One picked ${describe(resolver)}`,
    `  The other picked ${describe(evaluator)}`,
    'Say which piece of evidence separates them, and why it outweighs the other.',
  ].join('\n');
}

function describe(submission: Submission | null): string {
  if (!submission) return 'nothing (it did not submit).';
  if (!submission.entityId) return `no candidate: "${submission.reasoning}"`;
  return `${submission.entityId} (${submission.confidence} confidence): "${submission.reasoning}"`;
}
