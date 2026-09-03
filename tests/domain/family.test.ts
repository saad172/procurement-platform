import { describe, expect, it } from 'vitest';
import { mergeRiskForUpsert, unionRiskFactors } from '@/domain/family';

/**
 * SPEC §8. What used to be proven here about a standalone Family exposure
 * badge — `computeFamilyExposure`/`describeFamilyExposure`'s three states —
 * moved to `tests/domain/score.test.ts`'s Network exposure coverage: that
 * badge is gone (network spec §5, ticket 03 unit 03b), folded into
 * `networkExposure`, which scores a family member's own risk exactly once
 * alongside the watchlist walk and the Supplier's owners rather than in a
 * separate ink. What remains here is what `family.ts` still owns: the risk
 * union between endpoints, and the merge `upsertEntity` calls on every write.
 */

describe('unioning risk when two endpoints disagree', () => {
  it('keeps a factor that only one endpoint reported', () => {
    // Measured: one company carried 10 factors in the traversal payload and 6
    // from getEntity, and the four missing included an elevated forced-labour
    // factor. Taking either as authoritative would have dropped it.
    const merged = unionRiskFactors([
      { source: 'traversal', risk: { a: { level: 'high' }, b: { level: 'relevant' } } },
      { source: 'getEntity', risk: { a: { level: 'high' } } },
    ]);
    expect(merged.map((m) => m.factor.name).sort()).toEqual(['a', 'b']);
  });

  it('records which endpoints reported each factor', () => {
    const merged = unionRiskFactors([
      { source: 'traversal', risk: { a: { level: 'high' } } },
      { source: 'getEntity', risk: { a: { level: 'high' } } },
    ]);
    expect(merged[0]!.sources.sort()).toEqual(['getEntity', 'traversal']);
  });

  it('keeps the WORSE level where two endpoints disagree', () => {
    // Understating a risk factor is the more dangerous error.
    const merged = unionRiskFactors([
      { source: 'getEntity', risk: { a: { level: 'elevated' } } },
      { source: 'traversal', risk: { a: { level: 'high' } } },
    ]);
    expect(merged[0]!.factor.level).toBe('high');
  });

  it('keeps a traversal path from whichever endpoint carried one', () => {
    const merged = unionRiskFactors([
      { source: 'getEntity', risk: { a: { level: 'high' } } },
      {
        source: 'traversal',
        risk: { a: { level: 'high', metadata: { traversal_path: ['x', 'y'] } } },
      },
    ]);
    expect(merged[0]!.factor.traversalPath).toEqual(['x', 'y']);
  });
});

/**
 * `mergeRiskForUpsert` is what `upsertEntity` calls on every write (SPEC §8.2
 * D5, item A). Unlike `unionRiskFactors` above, the "existing" side here is
 * not a fresh payload with one uniform source — it is a row that may already
 * carry a *different* source list per factor, the residue of every merge
 * before this one, so the two functions cannot share an implementation.
 *
 * **Two return values, for two columns.** `risk` stays exactly Sayari's own
 * shape (`level`/`value`/`metadata`) because `src/tools/catalog/reads.ts`
 * hands it to a model turn verbatim with no projection; `sources` is the flat
 * `{ [factorName]: string[] }` map for the sibling `risk_sources` column. Two
 * assess/recommend replays went red the first time this ticket tried an
 * inline `sources` key on `risk` itself — see the schema comment on
 * `entity.risk` — so the split is asserted here, not only decided in prose.
 */
describe('mergeRiskForUpsert: what upsertEntity persists on every write', () => {
  it('says nothing moved when the incoming sighting is silent about risk', () => {
    expect(
      mergeRiskForUpsert({ a: { level: 'high' } }, undefined, undefined, 'getEntity'),
    ).toBeUndefined();
  });

  it('never adds a key to risk beyond level, value and metadata', () => {
    const merged = mergeRiskForUpsert(undefined, undefined, { a: { level: 'high' } }, 'getEntity');
    expect(Object.keys(merged!.risk.a as object).sort()).toEqual(['level', 'metadata', 'value']);
  });

  it('keeps a factor the existing row already held and the new sighting does not mention', () => {
    const merged = mergeRiskForUpsert(
      { a: { level: 'high' } },
      { a: ['getEntity'] },
      { b: { level: 'relevant' } },
      'traversal',
    );
    expect(Object.keys(merged!.risk).sort()).toEqual(['a', 'b']);
  });

  it('appends a new source rather than replacing the ones already on file', () => {
    const afterFirst = mergeRiskForUpsert(
      undefined,
      undefined,
      { a: { level: 'high' } },
      'traversal',
    );
    const afterSecond = mergeRiskForUpsert(
      afterFirst!.risk,
      afterFirst!.sources,
      { a: { level: 'high' } },
      'getEntity',
    );
    expect(afterSecond!.sources.a).toEqual(['traversal', 'getEntity']);
  });

  it('does not repeat a source the row already credits', () => {
    const afterFirst = mergeRiskForUpsert(
      undefined,
      undefined,
      { a: { level: 'high' } },
      'getEntity',
    );
    const afterSecond = mergeRiskForUpsert(
      afterFirst!.risk,
      afterFirst!.sources,
      { a: { level: 'high' } },
      'getEntity',
    );
    expect(afterSecond!.sources.a).toEqual(['getEntity']);
  });

  it('keeps the worse level when a later sighting disagrees, either direction', () => {
    const worseFirst = mergeRiskForUpsert(
      { a: { level: 'high' } },
      undefined,
      { a: { level: 'relevant' } },
      'getEntity',
    );
    expect((worseFirst!.risk.a as { level: string }).level).toBe('high');

    const worseSecond = mergeRiskForUpsert(
      { a: { level: 'relevant' } },
      undefined,
      { a: { level: 'high' } },
      'getEntity',
    );
    expect((worseSecond!.risk.a as { level: string }).level).toBe('high');
  });

  it('is the fix for the measured regression: ten factors do not become six', () => {
    // YAZAKI ROMANIA (ticket 01, item A): a traversal payload carried ten
    // factors, a later getEntity carried six, and overwriting dropped the
    // four missing — including an elevated exports_ilab_forced_labor.
    const traversalRisk = {
      basel_aml: { level: 'relevant' },
      cpi_score: { level: 'relevant' },
      exports_ilab_forced_labor: { level: 'elevated' },
      exports_ilab_child_labor: { level: 'elevated' },
      psa_exports_ilab_forced_labor: { level: 'elevated' },
      psa_exports_ilab_child_labor: { level: 'elevated' },
      imports_bis_high_priority_items: { level: 'elevated' },
      psa_imports_bis_high_priority_items: { level: 'elevated' },
      exports_bis_high_priority_items_indirect: { level: 'elevated' },
      psa_exports_bis_high_priority_items_indirect: { level: 'elevated' },
    };
    const getEntityRisk = {
      basel_aml: { level: 'relevant' },
      cpi_score: { level: 'relevant' },
      imports_bis_high_priority_items: { level: 'elevated' },
      psa_imports_bis_high_priority_items: { level: 'elevated' },
      exports_bis_high_priority_items_indirect: { level: 'elevated' },
      psa_exports_bis_high_priority_items_indirect: { level: 'elevated' },
    };

    const afterTraversal = mergeRiskForUpsert(undefined, undefined, traversalRisk, 'traversal');
    const afterGetEntity = mergeRiskForUpsert(
      afterTraversal!.risk,
      afterTraversal!.sources,
      getEntityRisk,
      'getEntity',
    );

    expect(Object.keys(afterGetEntity!.risk)).toHaveLength(10);
    expect(afterGetEntity!.risk.exports_ilab_forced_labor).toMatchObject({ level: 'elevated' });
    expect(afterGetEntity!.sources.exports_ilab_forced_labor).toEqual(['traversal']);
  });
});
