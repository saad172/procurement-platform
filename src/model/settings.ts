/**
 * The model settings, in one table because they belong in one file (SPEC §17.3).
 *
 * The Tool Runner constrains none of this — `BetaToolRunnerParams` is
 * `Omit<BetaMessageCreateParams, 'tools'>` plus `max_iterations`, so `betas`,
 * `fallbacks`, `output_config.effort`, `thinking`, `context_management`,
 * top-level `cache_control`, `speed` and `stream` all pass straight through.
 * **No decision here was ever a decision about the runner.**
 */

export type LoopName = 'resolve' | 'assess' | 'recommend' | 'classifier' | 'chat' | 'dossier';

/**
 * **One model everywhere.** Caches are model-scoped, the price constant stays a
 * single pair, and the fixture manifest pins one model id.
 *
 * The alternative was measured rather than waved off: ~200 Discover
 * classifications cost **~$2.50 at Opus 5 against ~$0.50 at Haiku 4.5**, which
 * is about 2% of the ~$110 worst case. Haiku for the classifier is the one
 * defensible exception, to be taken deliberately if it is taken at all.
 */
export const MODEL = 'claude-opus-5';

/** A truncation guard, never a budget. The budget is the run budget. */
export const MAX_TOKENS = 16_000;

/**
 * `max_iterations` counts **requests** while our ceiling counts **tool calls**,
 * and parallel tool use puts several in one message — so the two do not
 * measure the same thing. Worse, `max_iterations` stops **silently**, leaving
 * `stop_reason: 'tool_use'` on a truncated run.
 *
 * So it stays set far above our own ceiling as a backstop, and **if it ever
 * fires that is a bug, logged loudly**.
 */
export const MAX_ITERATIONS_BACKSTOP = 200;

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type LoopSettings = {
  model: string;
  /**
   * **Pinned per loop and never varied per request**, because an effort change
   * invalidates the messages cache. `xhigh` on recommend is deferred to the
   * same post-first-run re-fit the cap table owes.
   */
  effort: EffortLevel;
  stream: boolean;
  /**
   * Context editing reaches **chat only**, and the reason is replay's: a
   * server-side edit rewrites context mid-loop, so the prompt a replay
   * reconstructs is not the prompt that was recorded.
   *
   * **Context editing and Trace replay are in tension**, and chat can afford
   * clearing *precisely because* it has no Trace. Jobs do not need it —
   * MAX_ROUNDS bounds the conversation before context does.
   */
  contextEditing: boolean;
};

export const LOOP_SETTINGS: Record<LoopName, LoopSettings> = {
  resolve: { model: MODEL, effort: 'high', stream: false, contextEditing: false },
  assess: { model: MODEL, effort: 'high', stream: false, contextEditing: false },
  recommend: { model: MODEL, effort: 'high', stream: false, contextEditing: false },
  classifier: { model: MODEL, effort: 'low', stream: false, contextEditing: false },
  chat: { model: MODEL, effort: 'medium', stream: true, contextEditing: true },
  dossier: { model: MODEL, effort: 'high', stream: false, contextEditing: false },
};

/**
 * `display: 'summarized'` is taken deliberately, because billing is identical
 * either way — so the default `omitted` is a **pure loss twice over**: a Job
 * fixture that cannot show *why* an evaluator objected, and, on chat, the
 * documented dead-air pause on the one latency-sensitive surface.
 *
 * The reasoning a Trace shows is still a **summary, never the chain of
 * thought**, and the write-up says so.
 */
export const THINKING = { type: 'adaptive', display: 'summarized' } as const;

/**
 * Betas carried on every request.
 *
 * `server-side-fallback-2026-07-01` + `fallbacks: 'default'` routes a refusal
 * by category with **no model list of ours to maintain**. Its consequence is
 * stated rather than discovered: a fallback turn can be served by another
 * model, which is why the price constant is keyed by model id though we only
 * ever ask for one.
 */
export const BASE_BETAS = ['server-side-fallback-2026-07-01'] as const;

/** Chat only. See `LoopSettings.contextEditing` for why it goes no further. */
export const CONTEXT_EDITING_BETA = 'context-management-2025-06-27';

export const CONTEXT_MANAGEMENT = {
  edits: [{ type: 'clear_tool_uses_20250919' as const }],
} as const;

/**
 * SDK-level request options (SPEC §17.7, divergence 1).
 *
 * **Retries stay with the SDK here**, unlike in `src/upstream`, and naming why
 * is the point: `src/upstream` took retries into its own chokepoint because a
 * retried Sayari call **spends a credit that must be counted**. A retried model
 * request that never returned a message **spends no tokens** — so there is
 * nothing to count and nothing a silent retry could hide.
 */
export const SDK_REQUEST_OPTIONS = {
  maxRetries: 2,
  timeout: 10 * 60 * 1_000,
} as const;
