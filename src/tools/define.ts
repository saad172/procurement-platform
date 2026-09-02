import type { z } from 'zod/v4';
import type { JobKind } from '@/config/constants';
import type { Database } from '@/db/client';
import type { Upstream } from '@/upstream';

/**
 * `defineTool` (SPEC §15.1).
 *
 * **Three fields, not one `scope`.** The original single enum conflated axes
 * the invariants quantify over separately, and it could not express:
 *
 * - a Sayari lookup, which is a **read** that **spends**;
 * - a side effect that touches no row (`navigate_to`, which renders a link);
 * - a call that is **slow without fanning out** — trade at 3.6–13.4 s and
 *   `negativeNews` at 7–15 s are both legitimately `slow`, and both barred from
 *   chat for that reason alone. (`negativeNews` measured 64.7 s on 2026-08-31,
 *   which only makes the case harder; `endpoints.ts` carries that measurement
 *   and the timeout it forced.)
 *
 * So `effect`, `spends` and `latency` are separate, and every boot invariant is
 * a statement over one or two of them.
 */

export type ToolSurface = 'chat' | 'job' | 'mcp';
export type ToolEffect = 'read' | 'write' | 'client';
export type ToolSpend = 'sayari' | 'external' | 'model';
export type ToolLatency = 'fast' | 'slow';

/**
 * What the confirm gate renders and freezes onto the message (SPEC §14.5).
 *
 * **An estimator reads local rows only — never a credit, never an external
 * call.** An estimator that spent to say what spending costs would also run
 * *before* the person consented, which is the one thing the gate exists to
 * prevent.
 *
 * Where it cannot know, `spends` carries a **range, or null with a stated
 * reason** in `basis` — never a fabricated point estimate.
 */
export type Estimate = {
  /** One sentence: what this will do. */
  what: string;
  spends: {
    sayariCalls?: number | { min: number; max: number } | null;
    modelTokens?: number | { min: number; max: number } | null;
    usd?: number | { min: number; max: number } | null;
  };
  /** How the figure was arrived at, including "we cannot know, because…". */
  basis: string;
  /**
   * Where *this always creates a version and the diff may be empty* and *a
   * filter cannot scope a Recommendation* get said — at the moment they cost
   * money.
   */
  caveats: string[];
  /**
   * Set when `upstream_response` already holds every body this would need.
   * "cached — no credits, no wait" is the difference between a gate people read
   * and a gate people click through.
   */
  cached?: boolean;
};

/**
 * Built by the adapter — pooled `db` on the web process, direct in the worker.
 *
 * **Handlers never import their dependencies** (SPEC §15.1): import-time env
 * reading breaks outright, since the worker is one process that would need
 * both connections.
 */
export type ToolContext = {
  db: Database;
  upstream: Upstream;
  /** Counts **model tokens only** — counting Sayari calls is the wrapper's job. */
  meter: { addModelTokens: (n: number) => void };
  runId: string;
  jobId?: string | undefined;
  surface: ToolSurface;
  /**
   * The raw query string of the page the person is on, on the **chat** surface
   * only (SPEC §14.3).
   *
   * It is here rather than in the prompt because §14.3's instruction — *answer
   * about the ranking they are actually looking at* — is an instruction, and a
   * model that forgets it answers about the program default while the person
   * reads a what-if. A read that defaults its weight vector from this cannot
   * forget. **Raw, not parsed**: renormalising needs the Program's own stored
   * default, which only the handler knows how to load.
   */
  viewState?: Record<string, string | string[] | undefined> | undefined;
};

/**
 * A handler returns `Ok` or objections — never a thrown error for something the
 * model could act on (SPEC §16.3).
 *
 *   > **An objection is something the model could act on; a throw is something
 *   > only we can fix.**
 */
export type ToolResult<T> = { ok: true; data: T } | { ok: false; objections: string[] };

export type ToolDefinition<TInput extends z.ZodType = z.ZodType, TOutput = unknown> = {
  /** Unique; source-prefixed for raw lookups, effect-prefixed everywhere else. */
  name: string;
  description: string;
  /** Shape only, never rules. Rules live in the handler, where they can explain themselves. */
  input: TInput;
  surfaces: ToolSurface[];
  effect: ToolEffect;
  spends: ToolSpend[];
  latency: ToolLatency;
  /** **Presence IS the gate.** A tool with a `confirm` is confirm-gated. */
  confirm?: (input: z.infer<TInput>, ctx: ToolContext) => Promise<Estimate>;
  /**
   * The Job kind an `enqueue_*` tool queues, **declared rather than inferred**.
   *
   * The kind used to live only inside the handler, where nothing could check
   * it — so `enqueue_deep_traversal` queued `traverse` and `enqueue_dossier`
   * queued `dossier`, neither of which the worker has a handler for, and an
   * accepted proposal became a Job that failed on being dequeued. Declaring it
   * is what lets `finalizeRegistry()` compare it against `RUNNABLE_JOB_KINDS`
   * at boot, before a person is ever offered the button.
   */
  enqueues?: JobKind;
  handler: (input: z.infer<TInput>, ctx: ToolContext) => Promise<ToolResult<TOutput>>;
};

/** Identity function; exists so every tool reads as a declaration. */
export function defineTool<TInput extends z.ZodType, TOutput>(
  definition: ToolDefinition<TInput, TOutput>,
): ToolDefinition<TInput, TOutput> {
  return definition;
}

/**
 * Every chat-reachable read returns `{ data, widget }` **with no opt-out**
 * (SPEC §14.4).
 *
 * A read that renders nothing is a number entering prose uncited. **Widgets are
 * not tools**: a widget is part of a read tool's return schema and freezes onto
 * `thread_message.widget`. A `render_table` tool would let the model draw a
 * table of numbers it typed itself.
 *
 * Thirteen types, **named after the tool and never after the shape**, so the
 * name cannot drift away from what produced it.
 */
export type WidgetType =
  | 'program_summary'
  | 'category_summary'
  | 'supplier_card'
  | 'supplier_family'
  | 'entity_card'
  | 'record_card'
  | 'shortlist_table'
  | 'criterion_compare'
  | 'trace_timeline'
  | 'needs_review_list'
  | 'lead_table'
  | 'usage_meter'
  /** One shared type across all nine raw lookups — see below. */
  | 'source_result';

export type Widget = { type: WidgetType; payload: unknown };

/** A chat-reachable read's return shape. */
export type ReadWithWidget<T> = { data: T; widget: Widget };
