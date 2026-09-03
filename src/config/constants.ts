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

/**
 * How many pages `searchTradeCandidates` follows the trade search's own
 * `next`/`offset` cursor before it stops (ticket 01 item C; BUILD-NOTES
 * finding 155). A handful, not the whole reachable set: the trade call alone
 * measures 3.6–13.4 s (SPEC §11.1), so every extra page multiplies a
 * Discover Job's wall-clock cost directly, and `DISCOVER_CLASSIFY_TOP_N`
 * still only classifies the top 25 by score however many rows were pooled
 * first — more pages widen the pool the prefilter reorders, not the number
 * of model calls it costs. Four pages at `DISCOVER_TRADE_LIMIT` pool up to
 * 400 rows, which is enough for a real supplier bunched behind a wall of
 * freight forwarders (SPEC §11.1's measured 3,385-counterparty line) to
 * surface without turning one Discover run into dozens of slow calls.
 */
export const DISCOVER_TRADE_PAGE_CAP = 4;

/** One call per accepted Profile; truncation is recorded (SPEC §8.2). */
export const FAMILY_TRAVERSAL_LIMIT = 50;

/**
 * The watchlist read, the second automatic call per accepted Profile (network
 * spec §4.1): `maxDepth: 4`, `psa: true`, `limit: 50`, the endpoint's default
 * 31 relationship types. One page, like the family read — truncation is
 * recorded rather than paged through.
 */
export const WATCHLIST_TRAVERSAL_LIMIT = 50;
export const WATCHLIST_TRAVERSAL_MAX_DEPTH = 4;

/**
 * The filtered ownership page, the third automatic call per accepted Profile
 * (network spec §4.1): `traversal.ownership` again, `riskCategories`,
 * `excludeClosedEntities: true`, `limit: 50` — the owned entities that carry
 * exposure wherever they sit in the explored set, not the first fifty in
 * server order. One page, like the unfiltered family and watchlist reads.
 *
 * Kept as its own constant array rather than inlined, so the three categories
 * that answer the Network exposure Criterion (SPEC §5) are named in one place
 * a scoring change can find without touching the call site.
 */
export const OWNERSHIP_EXPOSURE_TRAVERSAL_LIMIT = 50;
export const OWNERSHIP_EXPOSURE_RISK_CATEGORIES = [
  'sanctions',
  'export_controls',
  'forced_labor',
] as const;

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

/**
 * A person-triggered expansion of the ownership graph (SPEC §8.5).
 *
 * **The rule: a Deep Traversal must never be shallower than the automatic
 * read.** It exists to extend the Corporate family, and a cap that stops short
 * of what the family read already returns would make the on-demand expansion
 * *lose* members a page view gets for free — an expansion that contracts.
 *
 * The automatic read sends no depth at all, so it is answered at the server's
 * own default of `max_depth: 4` (measured on the recorded Yazaki body:
 * `maxDepth: 4`, `limit: 50`, `next: true`, `explored_count: 5047`). The cap
 * therefore **tracks that default** at 4 rather than sitting at a number of our
 * own choosing. It was 3, which is where the rule came from: at 3 the deep walk
 * was shallower per path than the read it extends.
 *
 * So depth is not what makes a Deep Traversal deep, and the vocabulary that
 * says it is — *"beyond one hop of ownership"* — is describing something the
 * family read never was. The family is *"subsidiaries, their subsidiaries, and
 * branches"*, which is already multi-hop; what it stops at is its **first page
 * of fifty**. What a Deep Traversal buys is the three things below it: the
 * cursor, the node cap, and the upward direction.
 *
 * If Sayari's default moves, this number is wrong again, and the fix is to
 * follow it rather than to argue with it.
 */
export const DEEP_TRAVERSAL_MAX_HOPS = 4;
export const DEEP_TRAVERSAL_MAX_NODES = 200;

/**
 * The API's maximum page, and therefore what one upstream call buys.
 *
 * `Ownership.limit` and `Ubo.limit` are documented *"Defaults to 10. Max of
 * 50"*, so 50 is not a number this app chose — asking for more is answered with
 * 50 anyway. It sits beside the caps because it is what converts the node cap
 * into a **call** count: the walk pages by 50 in each direction, so the honest
 * estimate the confirm gate shows is derived from these three numbers rather
 * than guessed.
 */
export const DEEP_TRAVERSAL_PAGE_SIZE = 50;

/**
 * Pages per direction, and therefore the call ceiling the estimate quotes.
 *
 * Downward (`traversal.ownership`) and upward (`traversal.ubo`) share the node
 * cap, so this is a worst case for one direction rather than a per-direction
 * allowance: a walk that fills all 200 nodes going down makes no upward call at
 * all. Four each way is eight, comfortably under `JOB_CAPS.traverse.toolCalls`
 * — which is the shape §18.3 asks for, a ceiling that does not fire on a
 * healthy run.
 */
export const DEEP_TRAVERSAL_MAX_PAGES = Math.ceil(
  DEEP_TRAVERSAL_MAX_NODES / DEEP_TRAVERSAL_PAGE_SIZE,
);

/**
 * Per-Job ceilings. A cap that fires on a healthy run is a bug, so these are
 * sized at ~2× worst-case-expected tool calls and ~3× tokens (SPEC §18.3).
 *
 * A Job at its ceiling is `terminated` — re-runnable, never resumable. A
 * runaway loop is not something a human should be able to wave through, so
 * these are not raisable from the UI, unlike the run budget.
 *
 * ## Re-fit on 2026-09-02, from measurement rather than from argument
 *
 * The first table was provisional and every number in it was too small. What it
 * was measured against: the development database (71 resolve, 65 enrich, 60
 * assess, 4 recommend Jobs) and the committed fixtures.
 *
 * | Job kind | worst tool calls | worst tokens | worst billed events | old cap | new cap |
 * |---|---|---|---|---|---|
 * | resolve | **90** (`resolve/not-found`, 2026-08-31) · 72 (re-recorded) · 57 on dev | 354,917 | **113** (Gestamp) | 60 · 400,000 | 180 · 1,100,000 |
 * | assess | **66** on dev · 24 on the fixture | 770,047 | 33 | 40 · 450,000 | 130 · 2,300,000 |
 * | recommend | **79** on dev · 16 on the fixture | 1,148,502 | 41 | 60 · 900,000 | 160 · 3,500,000 |
 * | enrich | runs no model | — | 11 | 25 | 25, unchanged |
 * | fetch_entity | runs no model | — | 1 | 2 | 2, unchanged |
 * | traverse | runs no model | — | 8 (`DEEP_TRAVERSAL_MAX_PAGES` × 2) | 20 | 20, unchanged |
 * | discover | never run | never run | never run | 40 · 300,000 | unchanged, still PROVISIONAL |
 *
 * Tokens are the ceiling's own definition — input + cache_creation + output,
 * Job-wide, cache reads excluded (`tokensOf` in `run-loop.ts`) — summed per
 * `job_id` over `usage_event`; tool calls are `trace_tool_call` rows per Job.
 *
 * **Four of the numbers were below what a healthy Job had already spent.**
 * assess ran to 66 tool calls against a ceiling of 40 and recommend to 79
 * against 60, and neither fired only because the ceiling used to bound one
 * `runLoop()` call rather than the Job (finding 117). The Job-wide count landed
 * afterwards, which turned provisional numbers into latent bugs — and the
 * twelve-row re-run of 2026-09-02 proved it on a live Job: **Gestamp spent 113
 * billed upstream events**, so under the old 60 it would have been `terminated`
 * part-way through the Round that settled it.
 *
 * **One ceiling, two counters.** `tool_call_cap` bounds model `tool_use` blocks
 * in `run-loop.ts` *and* upstream dispatches in `upstream/call.ts` — and the
 * upstream one counts every `usage_event` row with `cache_hit = false`, which
 * includes the model's own turns. So Gestamp's 113 is 85 live Sayari calls plus
 * 28 model turns, and a resolve Job that made 34 model turns had 26 upstream
 * calls left of 60. Both readings are covered here: 180 is 2× the 90 model tool
 * calls of `resolve/not-found` and comfortably over 113.
 *
 * **The token figures are conservative on purpose.** They are the pre-caching
 * runs, where every repeated prefix was billed as fresh input. With prompt
 * caching on (finding 124), the same work counts far fewer capped tokens —
 * today's worst resolve Job spent 108,063 against the 354,917 that fits this
 * table — because a cache read is excluded from the count by design. Fitting to
 * the cached figures would leave no room for a Job whose cache misses.
 *
 * `discover` is the one row still provisional: no `discover` Job has ever run,
 * so there is nothing to fit it to and inventing a number would be the thing
 * this re-fit exists to stop.
 *
 * **Re-measured by:** finding 150's queries, over `usage_event` and
 * `trace_tool_call` grouped by `job.kind`.
 */
export const JOB_CAPS = {
  resolve: { toolCalls: 180, tokens: 1_100_000 },
  enrich: { toolCalls: 25, tokens: 0 },
  /**
   * One company, one `getEntity`. The ceiling is 2 rather than 1 only because a
   * retried attempt after a transport error is the same Job doing the same work.
   */
  fetch_entity: { toolCalls: 2, tokens: 0 },
  traverse: { toolCalls: 20, tokens: 0 },
  assess: { toolCalls: 130, tokens: 2_300_000 },
  recommend: { toolCalls: 160, tokens: 3_500_000 },
  /** PROVISIONAL — no `discover` Job has run, so there is nothing to fit to. */
  discover: { toolCalls: 40, tokens: 300_000 },
  dossier: { toolCalls: 100, tokens: 0 },
  /**
   * PROVISIONAL, like `discover` — no `pairs` Job has run, so there is
   * nothing measured to fit to. Runs no model, so a cost/call cap only,
   * shaped like `traverse`'s and `fetch_entity`'s.
   *
   * Sized off the roster rather than off a measurement: the estimator
   * (`enqueue_check_every_pair`) quotes `n(n-1)/2` over the accepted
   * Suppliers actually bidding in a Category, and today's widest Category
   * on the seed roster carries 13 bidders — `C(13,2) = 78` pairs, each at
   * most one live `traversal.shortestPath` call (`findAndWriteShortestPath`
   * is idempotent, so a re-run's already-found pairs are free cache hits
   * that do not count against this cap). 100 leaves headroom over that
   * worst case without inventing a number a wider roster would immediately
   * outgrow silently — re-fit once a real `pairs` Job has run, the same way
   * the rest of this table was re-fit on 2026-09-02.
   */
  pairs: { toolCalls: 100, tokens: 0 },
} as const;

export type JobKind = keyof typeof JOB_CAPS;

/**
 * The Job kinds a worker can actually run (SPEC §2.2).
 *
 * `JOB_CAPS` names nine kinds because it sizes a ceiling for each; the worker
 * registers a handler for eight. The one that is not here — `dossier` — has an
 * `enqueue_*` tool that chat can propose, so an accepted proposal produced a
 * Job that dequeued and failed with *"no handler registered for job kind"*: a
 * red row in a Run, from a button a person deliberately pressed, for work the
 * app never had.
 *
 * One list, read by two places that had no idea they were describing the same
 * set: `buildJobHandlers` types its dispatch table against it, so a kind added
 * here without a handler is a compile error, and `finalizeRegistry()` checks
 * every `enqueue_*` tool's declared kind against it at boot.
 *
 * **`traverse` has joined it**, which is what the Deep Traversal handler
 * landing means in this file. `dossier` is flag-gated and deliberately outside
 * it, so the boot warning is now about one tool rather than two.
 *
 * **`pairs` joins it too** (network spec §7, ticket 04) — the *Check every
 * pair* Job `enqueue_check_every_pair` proposes.
 */
export const RUNNABLE_JOB_KINDS = [
  'enrich',
  'fetch_entity',
  'discover',
  'resolve',
  'assess',
  'recommend',
  'traverse',
  'pairs',
] as const satisfies readonly JobKind[];

export type RunnableJobKind = (typeof RUNNABLE_JOB_KINDS)[number];

/**
 * The run budget is a spending decision a person may revise; a per-Job ceiling
 * is a correctness backstop they may not (SPEC §18.2).
 *
 * **$8.00 × N Suppliers, re-fit from the first real run.** The spec published
 * $3.00 against a worst-case full-50 arithmetic of ~$110 and said in the same
 * breath that the numbers were *provisional, to be re-fit after the first real
 * run* (SPEC §18.3). That run has now happened, and it measured:
 *
 *     resolve   $0.65 per Job   (51 done)
 *     enrich    $0.00           — no model runs in it at all
 *     assess    $4.92           for the one Job that converged and published
 *     ────────────────────────────────────────────────────
 *     pipeline  ~$5.57 per Supplier, so ~$280 for a full fifty
 *
 * $8.00 leaves about 40% over the measured figure, which is the room a Supplier
 * needs when it uses all three Rounds rather than converging early. A budget
 * sized at the mean would pause on any Supplier costlier than average, and a
 * bound that fires on healthy work teaches a reader to raise it without reading
 * it.
 *
 * It stays a soft ceiling with bounded overshoot: worker concurrency IS the
 * overshoot, and checking more finely would only discard spend already made,
 * because a Round is the smallest resumable unit.
 *
 * **It bounds Anthropic dollars and nothing else.** `runSpendUsd` prices model
 * rows only — Sayari publishes no per-call price, so upstream calls contribute
 * zero to it and `checkRunBudget` cannot see them. Upstream spend is bounded by
 * the per-Job call ceilings instead, which is why those had to start being
 * enforced.
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

export const RUN_BUDGET_USD_PER_SUPPLIER = 8.0;

/**
 * When a `running` Job is taken to have lost its worker (SPEC §2.2, §5.3).
 *
 * A worker killed mid-Job leaves the row `running` for ever: there is no
 * heartbeat and no lock expiry, so recovery was a person noticing and pressing
 * Retry. The Job is not stuck in any way it can recover from — the process that
 * held it is gone — but nothing said so, and the Run sat at *running* with a
 * spinner over it.
 *
 * **Two conditions, because either alone is wrong.** A lock older than the
 * ceiling is not evidence on its own: the measured recommend Job ran 62 minutes
 * legitimately, and a sweep that only read `locked_at` would have taken it away
 * from a worker that was still spending on it. So silence is required as well —
 * no `trace_turn` and no `usage_event` in the last fifteen minutes — and the
 * longest gap between turns a real Job has shown is a fraction of that.
 *
 * A swept Job **keeps its checkpoint**: it lost its worker, it did not run away,
 * so it resumes at the Round boundary it reached rather than starting again.
 */
export const STALE_LOCK_MINUTES = 30;
export const STALE_SILENCE_MINUTES = 15;

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
 * What a cached input token costs, as a multiple of the input price.
 *
 * Beside the price table because they are the same kind of number and carry the
 * same caveat: **a committed price constant, not a bill.** A cache read is
 * billed at a tenth of an input token and a cache write at a quarter more than
 * one, so pricing all three at the plain input rate — which every copy of this
 * arithmetic did — over-charges a Job that caches well and under-charges one
 * that writes a large prefix. `src/lib/price.ts` is the only reader.
 *
 * Output tokens have no multiplier: they are priced by the table's own `output`
 * figure, and a cached output token does not exist.
 */
export const CACHE_READ_PRICE_MULTIPLIER = 0.1;
export const CACHE_WRITE_PRICE_MULTIPLIER = 1.25;

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
