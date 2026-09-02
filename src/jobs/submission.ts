import type { z } from 'zod/v4';
import type { EmittedToolUse } from '@/model/types';
import { getRegistry } from '@/tools';

/**
 * Reading a `submit_*` payload out of the turn that carried it (SPEC §15.4).
 *
 * > **The agents propose and our code settles.**
 *
 * The payload comes from the message rather than from the tool's `run()`,
 * because whether the runner executes a *terminal* tool — one the model calls
 * last, with nothing left to say — depends on how the iteration ends. That much
 * was already true. Two things about how it was read were not:
 *
 * **1. It took the FIRST submission, and a corrected one comes second.** The
 * SDK parses a tool's input with the tool's own `parse` before running it, and
 * a zod failure there is caught into an `is_error` tool result — so the model is
 * told, and the sensible model then submits again with the field fixed. Reading
 * `.find()` handed the Job the payload that had already been rejected and
 * ignored the answer to the objection. `findLast` is the model's final word.
 *
 * **2. Nothing validated it app-side.** The rejected first submission never
 * reached `run()`, so our own zod refinements ran on nothing and the Job read
 * whatever shape the message happened to carry. Parsing here puts the schema
 * back in the path the payload actually takes, and a failure is a **refinement
 * failure** — the model mis-shaping its output, which it can fix on being told,
 * so it retries free and does not cost a Round (SPEC §10.5).
 */

export type Submission<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      /** One sentence, in the register the Round loop prints it in. */
      message: string;
    };

export function readSubmission<T>(
  toolUses: readonly EmittedToolUse[],
  toolName: string,
): Submission<T> {
  const called = toolUses.map((use) => use.name);
  const submitted = toolUses.findLast((use) => use.name === toolName);
  if (!submitted) {
    return {
      ok: false,
      message:
        `the loop ended without calling ${toolName} ` +
        `(tools called: ${called.join(', ') || 'none'})`,
    };
  }

  const schema = getRegistry().byName.get(toolName)?.input as z.ZodType | undefined;
  if (!schema) {
    // A submit tool the registry does not know cannot have been offered to the
    // model, so this is our bug rather than the model's. It is still reported
    // as a refinement failure, because there is no answer the loop can give.
    return { ok: false, message: `${toolName} is not a tool in this registry` };
  }

  const parsed = schema.safeParse(submitted.input);
  if (!parsed.success) {
    return {
      ok: false,
      message: `${toolName} was called with a payload our schema rejects: ${describeIssues(parsed.error)}`,
    };
  }

  /**
   * **The payload as the model wrote it, not zod's copy of it.**
   *
   * `parse` rebuilds the object in the schema's declaration order, and a draft's
   * key order is prompt bytes: the evaluator is shown
   * `JSON.stringify(draft, null, 2)`, so handing on the reordered copy changes
   * the question the evaluator is asked and misses every fixture recorded
   * against the old one. It is the same fault that made `trace_turn.response`
   * `text` rather than `jsonb` (finding 34's sibling), and the same remedy:
   * validate the thing, then pass the thing.
   */
  return { ok: true, value: submitted.input as T };
}

/**
 * The issue list, in the model's own field names.
 *
 * A path plus a reason, because *"sentences.0.citations: expected at least 1
 * element"* is something a model can act on and *"invalid input"* is not.
 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'} — ${issue.message}`)
    .join('; ');
}
