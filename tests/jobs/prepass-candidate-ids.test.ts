import { describe, expect, it } from 'vitest';
import { prepassCandidateIds } from '@/jobs/resolve';

/**
 * `prepassCandidateIds` reads the batch pre-pass's resolution rows into
 * `PrepassCandidateInfo[]` (ticket 01 item A; Reuse 1). Bodies below are
 * shaped in the PROJECTED shape — `entity_id`/`match_strength` snake_case,
 * as `resolutionCandidateSchemaInner` produces them — per the hard rule
 * against building a test body from the SDK's own camelCase examples.
 */
describe('prepassCandidateIds', () => {
  it('reads entity id and all four evidence fields off each row', () => {
    const rows = prepassCandidateIds({
      data: [
        {
          entity_id: 'e1',
          score: 12.5,
          match_strength: 'strong',
          explanation: { name: [{ match_quality: 'high' }] },
          highlight: { name: ['<em>x</em>'] },
        },
      ],
    });
    expect(rows).toEqual([
      {
        entityId: 'e1',
        score: 12.5,
        matchStrength: 'strong',
        explanation: { name: [{ match_quality: 'high' }] },
        highlight: { name: ['<em>x</em>'] },
      },
    ]);
  });

  it('drops a row with no entity_id — nothing is invented', () => {
    // The projected type requires `entity_id`, so this defends runtime data
    // the type itself would refuse — hence the cast.
    const rows = prepassCandidateIds({ data: [{ score: 1 } as never] });
    expect(rows).toEqual([]);
  });

  it('is empty when the resolution response carries no data at all', () => {
    expect(prepassCandidateIds({})).toEqual([]);
    expect(prepassCandidateIds({ data: null })).toEqual([]);
    expect(prepassCandidateIds({ data: undefined })).toEqual([]);
  });

  /**
   * **C6.** A duplicate `entity_id` across two resolution rows used to make
   * the caller's `Map` keep the LAST (lower-ranked) row's evidence, while the
   * ladder still listed the Candidate twice and `settleMatch`'s
   * `onConflictDoUpdate` — keyed on `(match_attempt_id, entity_id)` — dropped
   * the second insert. Deduped here, on first occurrence, so the array itself
   * never carries the duplicate past this point.
   */
  it('dedupes a repeated entity_id, keeping the first (higher-ranked) row', () => {
    const rows = prepassCandidateIds({
      data: [
        { entity_id: 'e1', score: 900, match_strength: 'strong' },
        { entity_id: 'e2', score: 500, match_strength: 'medium' },
        // A lower-ranked repeat of e1, further down the resolution response.
        { entity_id: 'e1', score: 1, match_strength: 'weak' },
      ],
    });
    expect(rows.map((r) => r.entityId)).toEqual(['e1', 'e2']);
    const e1 = rows.find((r) => r.entityId === 'e1')!;
    expect(e1.score).toBe(900);
    expect(e1.matchStrength).toBe('strong');
  });

  it('reads match_strength off either the bare-string or the {value} shape', () => {
    const bare = prepassCandidateIds({ data: [{ entity_id: 'e1', match_strength: 'strong' }] });
    expect(bare[0]!.matchStrength).toBe('strong');

    const wrapped = prepassCandidateIds({
      data: [{ entity_id: 'e1', match_strength: { value: 'weak' } }],
    });
    expect(wrapped[0]!.matchStrength).toBe('weak');
  });
});
