/**
 * What actually went wrong, in a sentence a person can act on (SPEC §18.4).
 *
 * `failed` names something that broke, and the Run page prints that name next
 * to a retry. So the string stored has to be the *cause*, not the machinery
 * that surfaced it — and for the two libraries this app leans on, the top-level
 * `message` is the machinery.
 *
 * A Drizzle query error's `message` is the SQL it tried, several hundred
 * characters of it, with the Postgres error hidden on `cause`. What reached the
 * page was:
 *
 * > `Failed query: insert into "enrichment" ("id", "source", "subject_kind", …`
 *
 * which names the statement and not one thing about why it did not run. The
 * useful sentence — *duplicate key value violates unique constraint
 * "enrichment_pkey"* — was one `cause` hop away and never displayed.
 *
 * So: walk to the deepest cause, take its message, and keep the outer one only
 * where it adds something the inner one does not.
 */

/** Postgres and other drivers hang the interesting fields off the error. */
type CausedError = Error & {
  cause?: unknown;
  detail?: string;
  constraint_name?: string;
  code?: string;
};

const MAX_DEPTH = 8;

function chain(error: unknown): CausedError[] {
  const seen: CausedError[] = [];
  let current = error;
  while (current instanceof Error && seen.length < MAX_DEPTH) {
    const node = current as CausedError;
    if (seen.includes(node)) break;
    seen.push(node);
    current = node.cause;
  }
  return seen;
}

/**
 * One line, cause-first.
 *
 * Truncated because a job that failed on a 40-kilobyte SQL statement should
 * still leave the row readable — the Trace is where the whole thing lives.
 *
 * **The cap is generous rather than tidy.** At 400 characters a validator
 * rejection lost half its objections: an assessment refused for four
 * unresolvable entity ids reported two and a `…`, so the page named some of
 * what to fix and hid the rest. For that class of error the list *is* the
 * message, and a reader who cannot see all of it cannot act on any of it.
 */
export function describeError(error: unknown, maxLength = 2000): string {
  if (!(error instanceof Error)) return String(error).slice(0, maxLength);

  const links = chain(error);
  const deepest = links[links.length - 1] ?? (error as CausedError);

  const parts: string[] = [];
  if (deepest.message) parts.push(deepest.message.trim());
  // `detail` is where Postgres puts the row that collided, which is the single
  // most useful thing about a constraint violation.
  if (deepest.detail) parts.push(deepest.detail.trim());

  /**
   * The outer message earns its place only when it is not the SQL dump — a
   * driver's "Failed query: …" repeats the statement and says nothing the
   * cause has not already said better.
   */
  const outer = links[0];
  if (outer && outer !== deepest && !/^Failed query:/i.test(outer.message)) {
    parts.unshift(outer.message.trim());
  }

  /**
   * A wrapper that already quotes its cause says it once, not twice.
   *
   * `Could not reach sayari … The user aborted a request` wraps a cause whose
   * whole message is `The user aborted a request`, and joining both produced
   * the sentence followed by its own tail. Keep the part that subsumes the
   * other; where neither does, keep both.
   */
  const kept = parts.filter(
    (part, i) =>
      part.length > 0 &&
      !parts.some(
        (other, j) => j !== i && other.includes(part) && (other.length > part.length || j < i),
      ),
  );

  const line = kept.join(' — ') || 'something broke, and it carried no message';
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}
