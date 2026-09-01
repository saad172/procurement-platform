/**
 * The model layer (SPEC §17). Sibling to `src/upstream`.
 *
 * The **two places it deliberately diverges** from that sibling are the
 * section's real content, and both are documented where they occur:
 *
 * 1. **Retries stay with the SDK** (`settings.ts`). `src/upstream` took retries
 *    into its own chokepoint because a retried Sayari call spends a credit that
 *    must be counted; a retried model request that never returned a message
 *    spends no tokens, so there is nothing to count and nothing a silent retry
 *    could hide.
 * 2. **Boot validates and never calls** (`manifest.ts`). `src/upstream` fires a
 *    live call on boot because its fallback is our code that CI never
 *    exercises; the model's fallback is server-side, so there is no cold path
 *    of ours to keep warm.
 */
export { runLoop, priceOf } from './run-loop';
export { getAnthropicClient, resetAnthropicClients } from './client';
export { describeModelError } from './describe-model-error';
export {
  CACHE_CONTROL,
  isSystemRoleUnsupported,
  markRoundBoundary,
  pageBlock,
  pageBlockAsUserTurn,
  sortToolsByName,
} from './caching';
export { assertModelConfigIsLegal, buildManifest, LOOP_SYSTEMS } from './manifest';
export {
  BASE_BETAS,
  LOOP_SETTINGS,
  MAX_ITERATIONS_BACKSTOP,
  MAX_TOKENS,
  MODEL,
  THINKING,
} from './settings';
export type { EffortLevel, LoopName, LoopSettings } from './settings';
export type { LoopCaps, ModelContext, RunLoopOutcome, RunLoopParams } from './types';
