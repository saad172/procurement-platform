import { describe, expect, it } from 'vitest';
import {
  deriveAssessedIds,
  deriveBiddersByCategory,
  deriveCategoryAttempts,
  deriveCategoryRecommendations,
  deriveMatchBySupplier,
  deriveSupplierPoints,
  deriveWaitingOnYou,
} from '@/domain/derive-program-page';

/**
 * The Program page reads `suppliers`, `matches` and `assessedRows` exactly
 * once (`readProgramRows`); everything here is the pure shaping over those
 * rows that used to live inline in `loadProgramPage`. What is worth proving
 * is the shaping, not the read — these take plain arrays and assert the maps
 * and lists the three page sections actually render.
 */

const supplier = (id: string, overrides: Partial<{ rosterName: string | null; rosterCountry: string | null }> = {}) => ({
  id,
  // `'rosterName' in overrides` rather than `??`: a caller passing `rosterName:
  // null` on purpose (the nameless-lead case) must not be overwritten by the
  // default just because null and undefined coerce the same way through `??`.
  rosterName: 'rosterName' in overrides ? overrides.rosterName! : `Supplier ${id}`,
  rosterCountry: overrides.rosterCountry ?? 'DEU',
});

describe('deriveMatchBySupplier', () => {
  it('keys the match rows by supplier id', () => {
    const matches = [
      { supplierId: 's1', status: 'accepted' as const, entityId: 'e1', settledBy: 'rules' as const },
    ];
    const map = deriveMatchBySupplier(matches);
    expect(map.get('s1')).toEqual(matches[0]);
    expect(map.get('nope')).toBeUndefined();
  });
});

describe('deriveAssessedIds', () => {
  it('collects supplier ids into a set', () => {
    const ids = deriveAssessedIds([{ supplierId: 'a' }, { supplierId: 'b' }, { supplierId: 'a' }]);
    expect(ids.size).toBe(2);
    expect(ids.has('a')).toBe(true);
    expect(ids.has('c')).toBe(false);
  });
});

describe('deriveWaitingOnYou', () => {
  it('names only the suppliers whose match needs review', () => {
    const suppliers = [supplier('s1', { rosterName: 'Yazaki' }), supplier('s2', { rosterName: 'Nemak' })];
    const matchBySupplier = deriveMatchBySupplier([
      { supplierId: 's1', status: 'needs_review', entityId: null, settledBy: 'agents' },
      { supplierId: 's2', status: 'accepted', entityId: 'e2', settledBy: 'rules' },
    ]);
    const waiting = deriveWaitingOnYou(suppliers as never, matchBySupplier);
    expect(waiting.count).toBe(1);
    expect(waiting.names).toEqual(['Yazaki']);
  });

  it('falls back to "a promoted lead" for a nameless roster row', () => {
    const suppliers = [supplier('s1', { rosterName: null })];
    const matchBySupplier = deriveMatchBySupplier([
      { supplierId: 's1', status: 'needs_review', entityId: null, settledBy: 'agents' },
    ]);
    const waiting = deriveWaitingOnYou(suppliers as never, matchBySupplier);
    expect(waiting.names).toEqual(['a promoted lead']);
  });
});

describe('deriveSupplierPoints', () => {
  const plants = [{ code: 'MX1', city: 'Saltillo', lat: 25.42, lon: -101.0 }];

  it('leaves out a supplier with neither a profile nor a geocode point, rather than placing it at a default', () => {
    const suppliers = [supplier('s1'), supplier('s2')];
    const matchBySupplier = deriveMatchBySupplier([]);
    const { supplierPoints, bandBySupplier } = deriveSupplierPoints({
      suppliers: suppliers as never,
      matchBySupplier,
      assessedIds: new Set(),
      profilePoints: [{ supplierId: 's1', lat: 25.4, lon: -101.1 }],
      geocodePoints: [],
      plants,
    });
    expect(supplierPoints).toHaveLength(1);
    expect(supplierPoints[0]!.id).toBe('s1');
    expect(bandBySupplier.get('s1')).toBe('near');
    expect(bandBySupplier.has('s2')).toBe(false);
  });

  it('prefers the Sayari profile coordinate over a geocoded one for the same supplier', () => {
    const suppliers = [supplier('s1')];
    const { supplierPoints } = deriveSupplierPoints({
      suppliers: suppliers as never,
      matchBySupplier: deriveMatchBySupplier([]),
      assessedIds: new Set(),
      profilePoints: [{ supplierId: 's1', lat: 25.4, lon: -101.1 }],
      geocodePoints: [{ supplierKey: 's1', lat: 0, lon: 0 }],
      plants,
    });
    expect(supplierPoints[0]).toMatchObject({ lat: 25.4, lon: -101.1 });
  });
});

describe('deriveBiddersByCategory', () => {
  it('counts one row per bidder, per category', () => {
    const counts = deriveBiddersByCategory([{ categoryId: 'c1' }, { categoryId: 'c1' }, { categoryId: 'c2' }]);
    expect(counts.get('c1')).toBe(2);
    expect(counts.get('c2')).toBe(1);
  });
});

describe('deriveCategoryRecommendations', () => {
  it('reads the award pick and the latest version only', () => {
    const map = deriveCategoryRecommendations([
      {
        categoryId: 'c1',
        versions: [
          {
            n: 2,
            evaluatorOutcome: 'passed',
            humanMark: null,
            picks: [
              { role: 'second_source', supplier: { rosterName: 'Nemak' } },
              { role: 'award', supplier: { rosterName: 'Yazaki' } },
            ],
          },
        ],
      },
    ]);
    expect(map.get('c1')).toEqual({ n: 2, evaluatorOutcome: 'passed', humanMark: null, awardedTo: 'Yazaki' });
  });

  it('counts a recommendation with no version as none', () => {
    const map = deriveCategoryRecommendations([{ categoryId: 'c1', versions: [] }]);
    expect(map.has('c1')).toBe(false);
  });
});

describe('deriveCategoryAttempts', () => {
  /**
   * A Recommend that ran and published nothing is not the same as one nobody
   * asked for — `terminated` reads as a refusal, `failed` as breakage, and an
   * in-flight job as neither.
   */
  it('classes each terminal state distinctly, and ignores a done job', () => {
    const attempts = deriveCategoryAttempts(
      [
        { subjectId: 'c1', state: 'terminated', jobId: 'j1', runId: 'r1' },
        { subjectId: 'c2', state: 'failed', jobId: 'j2', runId: 'r2' },
        { subjectId: 'c3', state: 'queued', jobId: 'j3', runId: 'r3' },
        { subjectId: 'c4', state: 'done', jobId: 'j4', runId: 'r4' },
      ],
      'p1',
    );
    expect(attempts.get('c1')?.outcome).toBe('refused');
    expect(attempts.get('c2')?.outcome).toBe('broke');
    expect(attempts.get('c3')?.outcome).toBe('in_flight');
    expect(attempts.has('c4')).toBe(false);
    expect(attempts.get('c1')?.href).toBe('/program/p1/runs/r1/job/j1');
  });

  it('keeps the last attempt when the same category was tried more than once', () => {
    const attempts = deriveCategoryAttempts(
      [
        { subjectId: 'c1', state: 'failed', jobId: 'j1', runId: 'r1' },
        { subjectId: 'c1', state: 'terminated', jobId: 'j2', runId: 'r2' },
      ],
      'p1',
    );
    expect(attempts.get('c1')?.outcome).toBe('refused');
  });
});
