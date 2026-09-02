import type { RunLoopOutcome } from '@/model';
import { RUBRIC_ITEMS, type EvaluationPayload } from '@/tools';
import type { EvaluationResult } from './rounds';
import { readSubmission } from './submission';

/**
 * Reading the evaluator's verdict (SPEC §10.3), shared by Assess and Recommend.
 *
 * **The verdict is submitted, not written.** It used to be prose that
 * `parseObjections` scanned for the six item names and a leading "fail" — a
 * parse that decided whether a Round was spent, so every phrasing it had not
 * anticipated cost or saved a Round by accident. `submit_evaluation` makes the
 * shape impossible to get wrong (`strict: true`, tier 1 of SPEC §10.5) and
 * leaves this module with one job: turn six typed verdicts into the objections
 * the next Round carries.
 *
 * The payload is read from the **message**, through the same `readSubmission`
 * the two documents go through: a terminal tool may or may not be executed by
 * the runner depending on how the loop ends (finding 21), the model's **last**
 * submission is its answer to any objection the SDK's own parse raised, and the
 * tool's schema is what validates it. A verdict is a submission like the others
 * and there is no reason for it to be read by a second set of rules.
 */

/** One free retry, then the turn is recorded as unreviewed. */
const FREE_RETRIES = 1;

type VerdictRead =
  | { ok: true; verdict: EvaluationPayload }
  | { ok: false; problem: string };

/**
 * Runs the evaluator turn, once, and reads its verdict — retrying **free** if
 * no usable verdict came back.
 *
 * A missing verdict is the evaluator mis-shaping its output, which is a
 * refinement failure in SPEC §10.5's terms and therefore costs no Round. It
 * gets one retry rather than two because the retry the proposer gets exists to
 * recover a *document*, and there is nothing here to recover: a second silent
 * turn buys another full read of the brief for the same answer.
 */
export async function evaluateWithVerdict(
  call: () => Promise<RunLoopOutcome>,
): Promise<EvaluationResult> {
  let lastProblem = 'the evaluator turn was never run';

  for (let attempt = 0; attempt <= FREE_RETRIES; attempt += 1) {
    const read = readVerdict(await call());
    if (read.ok) return resultFrom(read.verdict);
    lastProblem = read.problem;
    console.error(
      `[loop] the evaluator returned no verdict (attempt ${attempt + 1} of ${FREE_RETRIES + 1}): ${lastProblem}`,
    );
  }

  return unreviewed(lastProblem);
}

/**
 * The verdict the evaluator ended on, read like any other submission.
 *
 * `readSubmission` takes the **last** `submit_evaluation` and parses it with
 * the tool's own schema: an evaluator that submits twice has changed its mind,
 * and the turn it ended on is the one it stands behind. What is left for this
 * function is the one rule a JSON Schema cannot state.
 */
export function readVerdict(result: RunLoopOutcome): VerdictRead {
  if (result.status !== 'done') {
    return {
      ok: false,
      problem:
        `the loop ended as ${result.status}` +
        ('error' in result ? `: ${result.error}` : '') +
        ('reason' in result ? `: ${result.reason}` : ''),
    };
  }

  const submitted = readSubmission<EvaluationPayload>(result.toolUses, 'submit_evaluation');
  if (!submitted.ok) return { ok: false, problem: submitted.message };

  // Six of the six, each once. `strict: true` guarantees the array's length and
  // every member's shape; it cannot say that the six are the six.
  const named = new Set(submitted.value.items.map((item) => item.item));
  const missing = RUBRIC_ITEMS.filter((item) => !named.has(item));
  if (missing.length > 0) {
    return {
      ok: false,
      problem: `the verdict names no ${missing.join(', ')} — every rubric item takes a verdict, including the ones that pass`,
    };
  }

  return { ok: true, verdict: submitted.value };
}

/**
 * A `fail` is an objection; a `pass` and an `unavailable` are not.
 *
 * *Unavailable* is a verdict distinct from *failed* throughout this build — the
 * evaluator saying it could not check something is not the evaluator saying the
 * draft is wrong, and charging a Round for it would spend the budget on our own
 * blind spots.
 */
export function resultFrom(verdict: EvaluationPayload): EvaluationResult {
  const objections = verdict.items
    .filter((item) => item.verdict === 'fail')
    .map((item) => `${item.item} — ${item.reasoning}`);
  const text = renderVerdict(verdict);

  return objections.length === 0
    ? { kind: 'pass', rubric: verdict, text }
    : { kind: 'objections', objections, rubric: verdict, text };
}

/**
 * The Round's text, so a person reading the Trace sees what a reader of the
 * old prose rubric saw. The structured verdict is stored beside it on
 * `round.rubric`; this is the same facts rendered for reading.
 */
function renderVerdict(verdict: EvaluationPayload): string {
  return [
    ...verdict.items.map((item) => `${item.item} — ${item.verdict}: ${item.reasoning}`),
    '',
    verdict.summary,
  ].join('\n');
}

/**
 * The evaluator produced no verdict, twice.
 *
 * Recorded as `unavailable` on every item, with one objection saying so. It
 * cannot be a pass: a draft nothing reviewed is not a draft that survived
 * review, and the difference is the whole reason the loop has two agents. It
 * survives as dissent if the following Rounds do not settle it, which is the
 * honest place for *"the second agent never answered"* to end up.
 */
export function unreviewed(problem: string): EvaluationResult {
  const line = `The evaluator produced no verdict on this draft (${problem}), so no rubric item was checked.`;
  const verdict: EvaluationPayload = {
    items: RUBRIC_ITEMS.map((item) => ({
      item,
      verdict: 'unavailable' as const,
      reasoning: 'the evaluator returned no verdict for this item',
    })),
    summary: line,
  };
  return { kind: 'objections', objections: [line], rubric: verdict, text: line };
}
