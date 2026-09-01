import { describe, expect, it } from 'vitest';
import { parseSettlement } from '@/domain/settle-request';

/**
 * What `settleByHand` is allowed to write.
 *
 * The screen it replaces took a 22-character entity id from a free-text box and
 * passed it to `settleMatch` unread. A foreign key and a transaction stopped
 * bad data reaching the database, so a typo failed as an **unhandled error with
 * no message** — a 500, not a validation, and nothing said which of the two
 * forms on the page had thrown.
 *
 * The candidates are now radio choices, so the ordinary path cannot produce an
 * id that is not a candidate. The typed path still exists — a record found in
 * Sayari's own UI and not by any rung is a real case — so it is kept, and it is
 * the one path that has to be checked against the entity store before anything
 * is written.
 */

const candidateIds = ['M_bKIsKm8M7jv0xju_VcAw', 'kr79WmkleiLVroowJWrtgw'];

const parse = (fields: Record<string, string>) =>
  parseSettlement(new Map(Object.entries(fields)), { candidateIds });

describe('a choice among the candidates cannot produce an unknown id', () => {
  it('accepts a candidate the page listed', () => {
    const result = parse({ choice: 'entity:M_bKIsKm8M7jv0xju_VcAw' });
    expect(result).toEqual({
      ok: true,
      kind: 'listed',
      entityId: 'M_bKIsKm8M7jv0xju_VcAw',
      note: undefined,
    });
  });

  /**
   * The radios are `required`, so the browser stops an empty submission before
   * it is sent. This is the second line: a hand-made POST reaches the action
   * with no `choice` at all, and it gets a sentence rather than a stack trace.
   */
  it('refuses a submission that selected nothing', () => {
    expect(parse({})).toEqual({
      ok: false,
      error:
        'Nothing was selected, so nothing was written. Pick a record, or mark the row not found.',
    });
  });

  /** A well-formed id that is not on this page is not this page's to settle. */
  it('refuses an id that is not one of this row’s candidates', () => {
    const result = parse({ choice: 'entity:yAk5_IMxLmWW2YvS-aAAIg' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/not one of the candidates/);
  });

  it('keeps the note, which is stored as the human round on the record', () => {
    const result = parse({
      choice: 'entity:M_bKIsKm8M7jv0xju_VcAw',
      note: '  Two sources where every other record has one.  ',
    });
    expect(result.ok === true && result.note).toBe('Two sources where every other record has one.');
  });
});

describe('not found is a stated choice, not an empty field', () => {
  /**
   * The old form read *not found* off a blank text box, so "I have not decided"
   * and "no candidate is the roster company" submitted identically. One is a
   * finding and the other is an accident.
   */
  it('accepts it as its own choice', () => {
    expect(parse({ choice: 'not_found' })).toEqual({
      ok: true,
      kind: 'not_found',
      entityId: null,
      note: undefined,
    });
  });

  it('ignores anything typed in the escape hatch when not found is chosen', () => {
    const result = parse({ choice: 'not_found', entityId: 'M_bKIsKm8M7jv0xju_VcAw' });
    expect(result).toMatchObject({ ok: true, kind: 'not_found', entityId: null });
  });
});

describe('the typed id is checked before anything is written', () => {
  /** Shape first, so an obvious typo never reaches the database at all. */
  it('refuses an id that is not 22 characters of the right alphabet', () => {
    const result = parse({ choice: 'other', entityId: 'not-an-id' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/22 characters/);
  });

  it('refuses an empty box rather than reading it as not found', () => {
    const result = parse({ choice: 'other', entityId: '   ' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/No id was typed/);
  });

  /**
   * A well-formed id is returned as `typed`, which is the caller's instruction
   * to look it up: the shape is all this function can know, and the entity
   * store is the only thing that can say whether the record exists.
   */
  it('hands a well-formed id back for the entity store to confirm', () => {
    expect(parse({ choice: 'other', entityId: ' zO7VjRJoQSBiZT1cxY_abw ' })).toEqual({
      ok: true,
      kind: 'typed',
      entityId: 'zO7VjRJoQSBiZT1cxY_abw',
      note: undefined,
    });
  });

  /** A candidate typed by hand is still a candidate, and settles as one. */
  it('reads a typed id that is on the page as the listed choice it is', () => {
    expect(parse({ choice: 'other', entityId: 'kr79WmkleiLVroowJWrtgw' })).toMatchObject({
      ok: true,
      kind: 'listed',
      entityId: 'kr79WmkleiLVroowJWrtgw',
    });
  });
});

describe('a choice nobody offered is refused', () => {
  it('refuses a value the page never rendered', () => {
    const result = parse({ choice: 'delete_everything' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/was not one of the choices/);
  });
});
