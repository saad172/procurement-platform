import { describe, expect, it } from 'vitest';
import { canonicalJson, hashBody, hashParams } from '@/upstream/hash';

/**
 * The cache key (SPEC §16.2). Two properties matter, and both are here because
 * getting either wrong produces a *silent* wrong answer rather than an error.
 */
describe('the cache key', () => {
  it('is insensitive to key order, so two equal requests share one cache row', () => {
    expect(hashParams('e', { a: 1, b: 2 })).toBe(hashParams('e', { b: 2, a: 1 }));
    expect(canonicalJson({ b: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"b":{"c":2,"d":1}}');
  });

  it('is sensitive to the endpoint, so two endpoints never collide', () => {
    expect(hashParams('entity.getEntity', { id: 'x' })).not.toBe(
      hashParams('record.getRecord', { id: 'x' }),
    );
  });

  it('drops undefined rather than hashing it, so an omitted option is one key', () => {
    expect(hashParams('e', { a: 1, b: undefined })).toBe(hashParams('e', { a: 1 }));
  });

  it('changes when a default changes — a deliberate cache miss, not an invisible one', () => {
    // Defaults are applied by call() BEFORE hashing, so the hash is taken over
    // exactly what the server will be sent. If they were applied after, two
    // requests that differ in what the server received would collide on one key
    // and the cached body would answer a question the new request did not ask.
    const before = hashParams('entity.getEntity', { id: 'x', referencedByLimit: 100 });
    const after = hashParams('entity.getEntity', { id: 'x', referencedByLimit: 20 });
    expect(before).not.toBe(after);
  });

  it('hashes bodies stably, so an unchanged body is recognisable', () => {
    expect(hashBody({ a: [1, 2], b: 'x' })).toBe(hashBody({ b: 'x', a: [1, 2] }));
    expect(hashBody({ a: 1 })).not.toBe(hashBody({ a: 2 }));
  });
});
