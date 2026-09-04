'use server';

import { getPooledDb } from '@/db/client';
import { getRegistry, type Estimate, type ToolContext, type ToolDefinition } from '@/tools';
import type { Upstream } from '@/upstream';

/**
 * **The page-native confirm gate** (network spec §8: *"Expand enqueues a Deep
 * Traversal through the existing confirm gate with its estimate"*) — ticket
 * 05, unit 05g.
 *
 * Until this file, the app's only confirm gate was chat's own
 * (`src/app/api/chat/confirm/route.ts`): a model proposes a tool call, the
 * estimate freezes onto a `thread_message` row, and a second POST answers it
 * once. A page has no thread message to freeze a proposal onto — there is no
 * conversation, only a person looking at a diagram — so this is the same
 * two-step SHAPE (an estimate, read, before an explicit second act) built
 * directly on the same tool registry chat's own gate reads, rather than a
 * second implementation of what a confirm gate is.
 *
 * **Generic on purpose, not Deep-Traversal-specific.** `toolName` and `input`
 * are exactly what a chat proposal already carries
 * (`thread_message.confirm: { toolName, input, estimate }`), so any other
 * confirm-gated **job-start** tool (`ToolDefinition.enqueues` set — Family 6,
 * `src/tools/catalog/enqueues.ts`: `enqueue_enrichment`,
 * `enqueue_reassess`, `enqueue_rerun_recommendation`, `enqueue_deep_traversal`,
 * `enqueue_discover`, `enqueue_check_every_pair`, `enqueue_dossier`,
 * `enqueue_match_settlement`) can be wired to a page button through these
 * same two functions — this file does not import or special-case
 * `enqueue_deep_traversal` anywhere. `ExpandNodePanel`
 * (`src/components/widgets/expand-node-button.tsx`) is the one caller that
 * happens to pass that tool's name today; a future page wiring
 * `enqueue_check_every_pair` to its own button calls `estimateJobStart`/
 * `runConfirmedJobStart` the same way, with no change here.
 *
 * **Scoped to job-start tools only, checked at runtime.** A read tool or an
 * agent-write tool's `handler` does something other than "open a Run and
 * enqueue a Job" — `ToolResult.data`'s shape is per-tool, and a generic
 * caller cannot know what to do with it. `tool.enqueues` (declared, per
 * `ToolDefinition`'s own doc comment, "rather than inferred") is exactly the
 * marker that says a tool's `handler` returns `{ runId, jobId }`-shaped data,
 * so this file refuses anything else rather than guessing.
 *
 * ## Why neither function needs a live Sayari client
 *
 * Every job-start tool's `confirm()` reads **local rows only** (`Estimate`'s
 * own doc comment: "never a credit, never an external call") and every one's
 * `handler()` does nothing but open a Run and enqueue a Job — read every
 * handler in `src/tools/catalog/enqueues.ts`: each mints its OWN `runId` via
 * `openRun` and never reads `ctx.upstream` or the `ctx.runId` this file
 * supplies. The upstream calls a Job actually spends happen later, inside the
 * worker, never synchronously in the call that queues it. That is also
 * network spec §8's own constraint — *"No live Sayari call from the
 * browser"* — so `unusedUpstream()` below is not a shortcut taken to avoid
 * wiring real credentials through a Server Action; it is the correct
 * dependency for this call shape, and it throws loudly rather than silently
 * if some future job-start tool's `confirm`/`handler` starts reading
 * `ctx.upstream`, which would be the moment this file needs a genuine
 * `createUpstream(...)` the way `/api/chat/confirm/route.ts` already builds
 * one for its own (reachable only after a real chat proposal, never directly
 * from a page) accept step.
 *
 * ## What this does NOT reproduce from the chat gate
 *
 * The chat gate is provably answered once: a `thread_message` row freezes
 * the proposal's `input`/`estimate` with `confirmState: 'proposed'`, and a
 * second POST against the same row is refused with 409
 * (`tests/app/confirm-route.test.ts`). This file is stateless — there is no
 * row recording that an estimate was ever shown — so nothing here stops a
 * hand-crafted duplicate POST to `runConfirmedJobStart` from enqueuing twice.
 * `ExpandNodePanel`'s own UI disables its Confirm button once clicked and
 * tracks pending/answered state, which covers the ordinary case (a person
 * double-clicking), but that is a UI-layer mitigation, not the same
 * replay-proof guarantee the chat gate's frozen row gives. A stated scope
 * cut for this ticket's "minimal" page-native gate, not an oversight —
 * see the PR description for the tradeoff.
 */

/** Every job-start tool's `input` is validated against its own Zod schema before either function below reads it — a Server Action is an untrusted entry point (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`'s own "treat every action as an untrusted entry point"), whichever page renders the button that calls it. */
function parseInput(
  tool: ToolDefinition,
  input: Record<string, unknown>,
): { ok: true; data: unknown } | { ok: false; error: string } {
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') };
  }
  return { ok: true, data: parsed.data };
}

/** A job-start tool by name, or the reason this file refuses it — never a thrown error for a page a person could still read (SPEC §16.3's own "an objection is something the model could act on"; the same courtesy extends to a person reading a page). */
function jobStartTool(toolName: string): { ok: true; tool: ToolDefinition } | { ok: false; error: string } {
  const tool = getRegistry().byName.get(toolName);
  if (!tool) return { ok: false, error: `No such tool: ${toolName}.` };
  if (!tool.enqueues) {
    return {
      ok: false,
      error: `${toolName} does not start a Job — this gate wires job-start tools (Family 6) only.`,
    };
  }
  if (!tool.confirm) {
    return { ok: false, error: `${toolName} has no confirm estimator — it is not confirm-gated.` };
  }
  return { ok: true, tool };
}

/**
 * Every job-start tool's `handler`/`confirm` never reads `ctx.upstream` (see
 * this file's own doc comment) — this stub exists so a call that ever DOES
 * fails loudly, naming the property that was read, instead of silently
 * returning `undefined` into a real Sayari call's shape.
 */
function unusedUpstream(): Upstream {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `confirm-gate-actions: a job-start tool read ctx.upstream.${String(prop)}, which no ` +
            'job-start tool is supposed to do synchronously (see this file\'s own doc comment). ' +
            'Replace this stub with a genuine createUpstream(...) call, the way ' +
            '/api/chat/confirm/route.ts already does for the chat surface, before this tool can ' +
            'be wired to a page button again.',
        );
      },
    },
  ) as unknown as Upstream;
}

function buildContext(): ToolContext {
  return {
    db: getPooledDb(),
    upstream: unusedUpstream(),
    meter: { addModelTokens: () => {} },
    // No Run exists yet at confirm time, and every job-start handler mints
    // its own via `openRun` rather than reading this (see this file's own
    // doc comment) — the literal says why, in case that ever stops being
    // true.
    runId: '(unconfirmed — every job-start handler opens its own Run)',
    // None of the three `ToolSurface` values name "a page's own Server
    // Action" — `'chat'` would misrepresent a conversation that never
    // happened, and `'mcp'` is the stdio surface. `'job'` is the closer of
    // the two real alternatives: like a worker running a Job, this is an
    // operational caller rather than a live conversation, and (like the
    // worker's own use of `'job'`, `src/worker/main.ts`) nothing here reads
    // `ctx.surface` today — see this file's own doc comment on `ctx.runId`
    // for the same caveat.
    surface: 'job',
  };
}

export type JobStartEstimateResult = { ok: true; estimate: Estimate } | { ok: false; error: string };

/**
 * Step one of the gate: an `Estimate`, read from local rows only, for one
 * job-start tool and its input — never an enqueue.
 */
export async function estimateJobStart(
  toolName: string,
  input: Record<string, unknown>,
): Promise<JobStartEstimateResult> {
  const found = jobStartTool(toolName);
  if (!found.ok) return { ok: false, error: found.error };

  const parsed = parseInput(found.tool, input);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const estimate = await found.tool.confirm!(parsed.data as never, buildContext());
  return { ok: true, estimate };
}

export type JobStartConfirmedResult =
  | { ok: true; runId: string; jobId: string | null }
  | { ok: false; objections: string[] };

/**
 * Step two: the explicit second act. Runs the tool's real `handler` — opens
 * a Run, enqueues a Job — which only happens once a person has read the
 * `Estimate` `estimateJobStart` returned and clicked Confirm.
 *
 * Re-validates `input` independently of `estimateJobStart` (this file keeps
 * no state between the two calls — see this file's own doc comment on what
 * it does not reproduce from the chat gate), so a caller cannot skip
 * straight to this function with unvalidated input.
 */
export async function runConfirmedJobStart(
  toolName: string,
  input: Record<string, unknown>,
): Promise<JobStartConfirmedResult> {
  const found = jobStartTool(toolName);
  if (!found.ok) return { ok: false, objections: [found.error] };

  const parsed = parseInput(found.tool, input);
  if (!parsed.ok) return { ok: false, objections: [parsed.error] };

  const result = await found.tool.handler(parsed.data as never, buildContext());
  if (!result.ok) return { ok: false, objections: result.objections };

  const data = result.data as { runId?: string; jobId?: string | null };
  if (!data.runId) {
    return {
      ok: false,
      objections: [`${toolName} enqueued but its handler returned no runId — this is a bug in it.`],
    };
  }
  return { ok: true, runId: data.runId, jobId: data.jobId ?? null };
}
