/**
 * The constants SPEC's appendix lists as shared across loops.
 *
 * Numbers whose home the spec names elsewhere are NOT here — the scoring
 * anchors and deduction tables live in `src/domain/score.ts` beside the
 * Criterion list they quantify over, and the weight presets live with them for
 * the same reason. "One number, one home" is what stops two copies drifting.
 *
 * Anything marked PROVISIONAL is to be re-fit after the first full roster run
 * (SPEC §9.2, §18.3). They are the only numbers in this build not derived from
 * a source, and saying so is part of the deliverable.
 */

/**
 * One proposer → evaluator exchange is a Round. Three is the ceiling for the
 * Match loop, the Assess loop and the Recommend loop alike — one constant, so
 * "how many chances does an agent get" has a single answer (SPEC §10.5).
 *
 * At MAX_ROUNDS without convergence a version publishes carrying its
 * unresolved objections. A run must complete.
 */
export const MAX_ROUNDS = 3;

/**
 * A schema or refinement failure is the model mis-shaping its output, which it
 * can fix on being told. Those retries are free and do not advance the Round
 * counter. A *validator* failure — a dangling Citation, a number that matches
 * nothing — is a substantive disagreement and costs a Round (SPEC §10.5).
 */
export const MAX_FREE_RETRIES_PER_ROUND = 2;

/**
 * The Sayari trade window Discover reads: shipments arriving in the Program's
 * territories. Kept beside the caps because it bounds the same call.
 */
export const DISCOVER_TRADE_LIMIT = 100;
export const DISCOVER_CLASSIFY_TOP_N = 25;

/** One call per accepted Profile; truncation is recorded (SPEC §8.2). */
export const FAMILY_TRAVERSAL_LIMIT = 50;

/**
 * How many pre-pass candidates rung R1 carries into the ladder.
 *
 * The pre-pass returns a ranked list, and every candidate past the cut costs a
 * `getEntity` call plus a full set of Discriminator verdicts. Five is where the
 * measured examples stop changing their answer — the Bosch decoy is settled by
 * rank 2 against rank 1 — so a wider list buys candidates the ladder has
 * already decided against.
 */
export const PREPASS_CANDIDATES = 5;

/** A person-triggered expansion beyond the automatic one hop (SPEC §8.5). */
export const DEEP_TRAVERSAL_MAX_HOPS = 3;
export const DEEP_TRAVERSAL_MAX_NODES = 200;

/**
 * Per-Job ceilings. A cap that fires on a healthy run is a bug, so these are
 * sized at ~2× worst-case-expected tool calls and ~3× tokens (SPEC §18.3).
 *
 * A Job at its ceiling is `terminated` — re-runnable, never resumable. A
 * runaway loop is not something a human should be able to wave through, so
 * these are not raisable from the UI, unlike the run budget.
 *
 * PROVISIONAL.
 */
export const JOB_CAPS = {
  resolve: { toolCalls: 60, tokens: 400_000 },
  enrich: { toolCalls: 25, tokens: 0 },
  traverse: { toolCalls: 20, tokens: 0 },
  assess: { toolCalls: 40, tokens: 450_000 },
  recommend: { toolCalls: 60, tokens: 900_000 },
  discover: { toolCalls: 40, tokens: 300_000 },
  dossier: { toolCalls: 100, tokens: 0 },
} as const;

export type JobKind = keyof typeof JOB_CAPS;

/**
 * The run budget is a spending decision a person may revise; a per-Job ceiling
 * is a correctness backstop they may not (SPEC §18.2).
 *
 * $3.00 × N Suppliers, against a worst-case full-50 arithmetic of ~$110. It is
 * a soft ceiling with bounded overshoot: worker concurrency IS the overshoot
 * (4 × a ~$0.60 recommend Round ≈ $2.40 on the smallest budget), and checking
 * more finely would only discard spend already made, because a Round is the
 * smallest resumable unit.
 */
/**
 * Chat's own tool-call ceiling, which is deliberately **not** a `JOB_CAPS`
 * entry.
 *
 * Chat is not a Job: it has no Round boundary, no resume checkpoint and no
 * Trace, so the per-Job machinery does not describe it. This is a runaway
 * backstop, not the bound that matters — the confirm gate is, and it is the
 * stronger one, because it stops a write before it happens rather than counting
 * reads after the fact.
 */
export const CHAT_TOOL_CALL_CAP = 20;

export const RUN_BUDGET_USD_PER_SUPPLIER = 3.0;

/** The Dossier's own dollar budget, enforced by Managed Agents (SPEC §18.3). */
export const DOSSIER_BUDGET_USD = 2.0;

/**
 * Model prices, in dollars per million tokens, keyed by model id.
 *
 * Keyed rather than scalar because server-side refusal fallback can serve a
 * turn from a model we did not choose (SPEC §17.5, §22.2 item 20). Every dollar
 * figure the app renders is computed from this constant and is labelled in the
 * UI as *a committed price constant, not a bill*.
 */
export const MODEL_PRICE_USD_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-opus-4-8': { input: 5.0, output: 25.0 },
  'claude-sonnet-5': { input: 2.0, output: 10.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
};

/**
 * The one sentence defining which company is the right one, quoted verbatim
 * into the resolver prompt, the evaluator prompt and the Needs Review UI so
 * that all three are arguing about the same thing (SPEC §6.7).
 *
 * For a promoted Lead it is unsatisfiable and unneeded — there is no roster
 * address for the company to be the counterparty at.
 */
export const IDENTITY_STANDARD =
  'The right company is the legal entity registered at the roster address: the contract ' +
  'counterparty, not the brand and not a division. The group parent is recorded through the ' +
  'ownership hop instead, never by matching to it.';

/**
 * Three traps the roster is known to contain, stated compactly because each one
 * has already produced a confident wrong answer in research (SPEC §6.7).
 */
export const IDENTITY_TRAPS = [
  'An alias outlives a divestiture: a name Sayari still lists may belong to a company that was sold.',
  'The right building can hold the wrong company: an investment arm often shares its parent’s address.',
  'Absence of an LEI is not evidence: large private companies frequently have none.',
] as const;
