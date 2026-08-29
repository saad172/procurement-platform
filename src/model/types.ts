import type { BetaMessageParam, BetaToolUnion } from '@anthropic-ai/sdk/resources/beta';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import type { Database } from '@/db/client';
import type { LoopName } from './settings';

/**
 * The inputs and outputs of `runLoop()` (SPEC §17.2).
 */

export type ModelCredentials = { apiKey: string };

/**
 * Built by the adapter, like `UpstreamContext`. Handlers never import their
 * dependencies (SPEC §15.1).
 */
export type ModelContext = {
  db: Database;
  /** Every amount spent belongs to exactly one Run, with no orphan path. */
  runId: string;
  /** Null only for chat, which spends inside a Run but outside any Job. */
  jobId?: string | undefined;
  credentials: ModelCredentials;
};

/**
 * The per-Job ceilings (SPEC §18.2).
 *
 * **We count; the runner does not.** A Job at its ceiling is `terminated` —
 * re-runnable, never resumable — because a runaway loop is not something a
 * human should be able to wave through. These are not raisable from the UI,
 * unlike the run budget.
 */
export type LoopCaps = {
  toolCalls: number;
  tokens: number;
};

/**
 * Checked at the **Round boundary** only (SPEC §18.2).
 *
 * The run budget **pauses**; a per-Job ceiling **terminates**. Checking finer
 * than a Round boundary would only discard spend already made, because a Round
 * is the smallest resumable unit.
 */
export type BudgetCheck = () => Promise<{ withinBudget: boolean; spentUsd: number }>;

export type RunLoopParams = {
  loop: LoopName;
  /** Frozen per loop, never interpolated. Per-run content goes in the first user message. */
  system: string;
  /** Sorted by name in `finalizeRegistry()`'s per-Round digest order. */
  tools: (BetaRunnableTool<never> | BetaToolUnion)[];
  messages: BetaMessageParam[];
  caps: LoopCaps;
  /** Absent for chat, which has no Round boundaries to check at. */
  budgetCheck?: BudgetCheck | undefined;
  /** The Round this call belongs to, for the Trace and the resume checkpoint. */
  roundN?: number | undefined;
  /** The per-Round tool digest, recorded on every turn (SPEC §15.7). */
  toolDigest?: { names: string[]; hash: string } | undefined;
};

export type RunLoopOutcome =
  | { status: 'done'; finalMessage: unknown; turns: number; toolCalls: number; tokens: number }
  /** A cap fired: a number you set. Amber, and re-runnable. */
  | { status: 'terminated'; reason: string; turns: number; toolCalls: number; tokens: number }
  /** The run budget was reached at a Round boundary. The ONLY resumable stop. */
  | { status: 'paused_on_budget'; spentUsd: number; turns: number; toolCalls: number; tokens: number }
  /** Something broke, including a whole-chain refusal. Red, and retryable. */
  | { status: 'failed'; error: string; refusal?: { category: string | null; explanation: string | null } };
