import { describe, expect, it } from 'vitest';
import { classify } from '@/upstream/classify';
import { OBJECTIONABLE_KINDS, UpstreamError } from '@/upstream/errors';

const ctx = { source: 'sayari', endpoint: 'entity.getEntity' };

/**
 * The closed error union (SPEC §16.3). The tests that matter are the two the
 * spec argues for by name.
 */
describe('classify', () => {
  it('reads a bare 403 as entitlement — there is no 403 error class in the SDK', () => {
    const error = classify(Object.assign(new Error('forbidden'), { statusCode: 403 }), ctx);
    expect(error.kind).toBe('entitlement');
  });

  it('recognises a ParseError by shape rather than by deep import', () => {
    const parseError = Object.assign(new Error('bad shape'), {
      name: 'ParseError',
      errors: [{ path: ['data'], message: 'expected array' }],
    });
    expect(classify(parseError, ctx).kind).toBe('parse');
  });

  it('never describes a parse bug in the same words as an entitlement refusal', () => {
    // They are opposite diagnoses — one means our client could not read a
    // response the API successfully returned, the other means the API refused
    // us — and confusing them sends someone to the wrong team.
    const parse = classify(Object.assign(new Error('x'), { name: 'ParseError', errors: [] }), ctx);
    const entitlement = classify(Object.assign(new Error('x'), { statusCode: 403 }), ctx);
    expect(parse.message).toMatch(/the call itself succeeded/);
    expect(parse.message).not.toMatch(/not entitled/);
    expect(entitlement.message).toMatch(/not entitled/);
    expect(entitlement.message).not.toMatch(/parse bug/);
  });

  it('maps the status codes each to its own kind', () => {
    const kindFor = (status: number) =>
      classify(Object.assign(new Error('e'), { statusCode: status }), ctx).kind;
    expect(kindFor(401)).toBe('auth');
    expect(kindFor(404)).toBe('not_found');
    expect(kindFor(429)).toBe('rate_limit');
    expect(kindFor(400)).toBe('bad_request');
    expect(kindFor(500)).toBe('upstream_5xx');
    expect(kindFor(503)).toBe('upstream_5xx');
  });

  it('reads an abort as a timeout rather than as transport', () => {
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classify(aborted, ctx).kind).toBe('timeout');
  });

  it('falls back to transport when there is no status and no known shape', () => {
    expect(classify(new Error('ECONNREFUSED'), ctx).kind).toBe('transport');
  });

  it('passes an UpstreamError through unchanged rather than re-wrapping it', () => {
    const original = new UpstreamError({
      kind: 'not_found',
      source: 'gleif',
      endpoint: 'x',
      message: 'm',
    });
    expect(classify(original, ctx)).toBe(original);
  });

  describe('an objection is something the model could act on; a throw is something only we can fix', () => {
    it('makes exactly one kind objectionable', () => {
      expect([...OBJECTIONABLE_KINDS]).toEqual(['not_found']);
    });

    it('marks not_found as an objection and every other kind as a throw', () => {
      const notFound = classify(Object.assign(new Error('e'), { statusCode: 404 }), ctx);
      const rateLimited = classify(Object.assign(new Error('e'), { statusCode: 429 }), ctx);
      expect(notFound.isObjection).toBe(true);
      expect(rateLimited.isObjection).toBe(false);
    });
  });
});
