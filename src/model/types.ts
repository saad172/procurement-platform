import type { BetaMessageParam, BetaToolUnion } from '@anthropic-ai/sdk/resources/beta';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import type { Database } from '@/db/client';
import type { LoopName } from './settings';

/**
 * The inputs and outputs of `runLoop()` (SPEC §17.2).
 */

export type ModelCredentials = {
  apiKey: string;
  /**
   * The replay seam (SPEC §19.1). Present only in tests, where it serves
   * recorded turns and the key is a placeholder.
   */
  fetch?: typeof fetch | undefined;
};

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
  /**
   * Called with each text delta, on the loops whose settings enable streaming.
   *
   * It is a callback rather than a returned stream because `runLoop` owns the
   * turn boundary: the caller sees text as it arrives *and* still gets one
   * settled outcome at the end, rather than having to reconstruct the loop's
   * state from the events.
   */
  onTextDelta?: ((text: string) => void) | undefined;
};

/** One `tool_use` block the model emitted, whether or not the runner ran it. */
export type EmittedToolUse = { name: string; input: unknown };

export type RunLoopOutcome =
  | {
      status: 'done';
      finalMessage: unknown;
      /**
       * Every `tool_use` block the model emitted across the loop.
       *
       * The agents **propose** and our code settles, so the load-bearing read
       * of a `submit_*` payload is taken from HERE rather than from the tool's
       * own `run()`. A terminal tool — one the model calls last, with nothing
       * left to say afterwards — may or may not be executed by the runner
       * depending on how the loop terminates, and that is a detail of the SDK
       * rather than of this design. Reading the proposal out of the message
       * makes the write path independent of it, and it is a truer statement of
       * the architecture besides.
       */
      toolUses: EmittedToolUse[];
      turns: number;
      toolCalls: number;
      tokens: number;
    }
  /**
   * A cap fired: a number you set. Amber, and re-runnable.
   *
   * It carries `toolUses` for the same reason `done` does. A ceiling firing one
   * turn after the model submitted its answer used to discard that answer — the
   * Round reported "neither agent submitted a pick" when both had. What a
   * ceiling stops is *more spending*, not the work already done, and whether
   * the caller can use a submission from a terminated loop is the caller's
   * judgement to make.
   */
  | {
      status: 'terminated';
      reason: string;
      turns: number;
      toolCalls: number;
      tokens: number;
      toolUses: { name: string; input: unknown }[];
    }
  /** The run budget was reached at a Round boundary. The ONLY resumable stop. */
  | {
      status: 'paused_on_budget';
      spentUsd: number;
      turns: number;
      toolCalls: number;
      tokens: number;
    }
  /** Something broke, including a whole-chain refusal. Red, and retryable. */
  | {
      status: 'failed';
      error: string;
      refusal?: { category: string | null; explanation: string | null };
    };
