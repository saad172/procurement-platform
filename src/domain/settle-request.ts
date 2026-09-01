/**
 * Reading a hand settlement off the form, before anything is written.
 *
 * `settleByHand` used to take whatever was in a free-text box and hand it to
 * `settleMatch` unread. A foreign key and a transaction stopped bad data
 * reaching the database — so the failure mode was never corruption — but it was
 * an **unhandled error with no message**: a 500 on a page carrying two forms,
 * which does not say which one threw or what was wrong with it.
 *
 * Two things changed. The candidates are radio choices, so the ordinary path
 * cannot name a record the page did not list. And the blank box no longer means
 * *not found*: settling a row as not found is a finding about the roster, and
 * *"I have not decided"* is not, so they are different submissions now.
 *
 * The typed path is kept, because a record found in Sayari's own UI and by no
 * rung is a real case. It is checked twice: shape here, existence by the
 * caller, which is the only thing that can read the entity store.
 */

/** 22 characters of base64url, which is what a Sayari entity id is. */
const ENTITY_ID = /^[A-Za-z0-9_-]{22}$/;

export type Settlement =
  | { ok: true; kind: 'listed'; entityId: string; note: string | undefined }
  | { ok: true; kind: 'typed'; entityId: string; note: string | undefined }
  | { ok: true; kind: 'not_found'; entityId: null; note: string | undefined }
  | { ok: false; error: string };

/**
 * `fields` is anything with `get` — a `FormData` or, in a test, a `Map`.
 *
 * `candidateIds` is every record this row's page actually offered. An id that
 * is not among them is not this page's to settle, whether it arrived from a
 * radio or from a hand-made POST.
 */
export function parseSettlement(
  fields: { get(name: string): unknown },
  context: { candidateIds: string[] },
): Settlement {
  const choice = str(fields.get('choice'));
  const note = str(fields.get('note')) || undefined;
  const listed = new Set(context.candidateIds);

  if (!choice) {
    return {
      ok: false,
      error:
        'Nothing was selected, so nothing was written. Pick a record, or mark the row not found.',
    };
  }

  if (choice === 'not_found') {
    // Deliberately ignores the escape hatch's box: two controls disagreeing is
    // the reader's ambiguity, and the radio is the one they clicked.
    return { ok: true, kind: 'not_found', entityId: null, note };
  }

  if (choice.startsWith('entity:')) {
    const entityId = choice.slice('entity:'.length);
    if (!listed.has(entityId)) {
      return {
        ok: false,
        error: `${entityId} is not one of the candidates for this row, so it was not written. Use “an id that is not listed” if you found this record elsewhere.`,
      };
    }
    return { ok: true, kind: 'listed', entityId, note };
  }

  if (choice === 'other') {
    const entityId = str(fields.get('entityId'));
    if (!entityId) {
      return {
        ok: false,
        error:
          'No id was typed, so nothing was written. Leaving the box empty is not the same as marking the row not found — there is a choice for that.',
      };
    }
    if (!ENTITY_ID.test(entityId)) {
      return {
        ok: false,
        error: `“${entityId}” is not a Sayari entity id: they are 22 characters of letters, digits, hyphens and underscores. Nothing was written.`,
      };
    }
    // A candidate typed by hand is a candidate. Saying so here means the caller
    // never runs a lookup it already has the answer to.
    if (listed.has(entityId)) return { ok: true, kind: 'listed', entityId, note };
    return { ok: true, kind: 'typed', entityId, note };
  }

  return {
    ok: false,
    error: `“${choice}” was not one of the choices on this page, so nothing was written.`,
  };
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
