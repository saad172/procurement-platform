import { describe, expect, it } from 'vitest';
import {
  DEDUCTION_BY_LEVEL,
  attachRiskSources,
  baseNameOf,
  dedupePsaAgainstBase,
  effectiveLevel,
  isCountryDerived,
  isDisqualifying,
  isPinningFamily,
  isTwinFactor,
  parseRiskObject,
  provenanceOf,
  variantOf,
  type RiskFactor,
} from '@/domain/scoring/risk-factors';

/**
 * SPEC §9.3 and §25 D15.
 *
 * Every factor name below is a **real one**, taken from live Sayari payloads
 * cached during the build. That matters: the two wrong implementations this
 * file guards against both look correct against invented names and fail
 * against these.
 */

const REAL_NAMES = [
  'basel_aml',
  'cpi_score',
  'esg_score_high',
  'eu_high_risk_third',
  'export_controls_adjacent',
  'exports_bis_high_priority_items_critical_components_indirect',
  'exports_bis_high_priority_items_direct',
  'exports_bis_high_priority_items_indirect',
  'forced_labor_aspi_origin_subtier_product_blueprint',
  'forced_labor_sheffield_hallam_university_reports_origin_subtier_product_blueprint',
  'forced_labor_xinjiang_origin_subtier_product_blueprint',
  'owner_of_regulatory_action_entity',
  'psa_exports_bis_high_priority_items_direct',
  'psa_exports_bis_high_priority_items_indirect',
  'psa_owner_of_regulatory_action_entity',
  'sanctioned_adjacent',
  'soe_adjacent',
] as const;

const factor = (
  name: string,
  level: RiskFactor['level'] = 'high',
  country: unknown = null,
): RiskFactor => ({
  name,
  level,
  country,
  traversalPath: null,
  value: null,
});

describe('variantOf — the six-valued taxonomy', () => {
  it('reads a variant word that sits in the MIDDLE of the name', () => {
    // A split on the trailing token reads this as bare and deducts high at
    // full weight. Measured: that pins six of eight sampled Suppliers to zero.
    expect(variantOf('forced_labor_aspi_origin_subtier_product_blueprint')).toBe('subtier');
    expect(variantOf('forced_labor_xinjiang_origin_subtier_product_blueprint')).toBe('subtier');
  });

  it('does not read `_indirect` as `_direct`, though one contains the other', () => {
    // A substring search fails here, quietly, scoring a band too harshly.
    expect(variantOf('exports_bis_high_priority_items_indirect')).toBe('indirect');
    expect(variantOf('exports_bis_high_priority_items_critical_components_indirect')).toBe(
      'indirect',
    );
    expect(variantOf('exports_bis_high_priority_items_direct')).toBe('direct');
  });

  it('recognises adjacent, psa and bare', () => {
    expect(variantOf('export_controls_adjacent')).toBe('adjacent');
    expect(variantOf('sanctioned_adjacent')).toBe('adjacent');
    expect(variantOf('soe_adjacent')).toBe('adjacent');
    expect(variantOf('psa_owner_of_regulatory_action_entity')).toBe('bare');
    expect(isTwinFactor('psa_owner_of_regulatory_action_entity')).toBe(true);
    expect(variantOf('owner_of_regulatory_action_entity')).toBe('bare');
    expect(variantOf('cpi_score')).toBe('bare');
  });

  it('treats provenance and distance as two axes, because psa_..._indirect exists', () => {
    // SPEC §9.2 lists a six-valued taxonomy that reads as one axis. The live
    // data has both of these names, so a factor can be a Twin's AND carry a
    // distance word — and collapsing them loses the second half.
    expect(variantOf('psa_exports_bis_high_priority_items_indirect')).toBe('indirect');
    expect(isTwinFactor('psa_exports_bis_high_priority_items_indirect')).toBe(true);
    expect(variantOf('psa_exports_bis_high_priority_items_direct')).toBe('direct');
    expect(isTwinFactor('psa_exports_bis_high_priority_items_direct')).toBe(true);
    expect(provenanceOf('exports_bis_high_priority_items_direct')).toBe('own');
  });

  it('classifies every real factor name without throwing', () => {
    for (const name of REAL_NAMES) expect(variantOf(name)).toBeTruthy();
  });
});

describe('effectiveLevel — the variant adjustment', () => {
  it('scores direct, bare and a Twin factor at its own variant’s band', () => {
    expect(effectiveLevel(factor('exports_bis_high_priority_items_direct', 'high'))).toBe('high');
    expect(effectiveLevel(factor('owner_of_regulatory_action_entity', 'elevated'))).toBe(
      'elevated',
    );
    expect(effectiveLevel(factor('psa_owner_of_regulatory_action_entity', 'high'))).toBe('high');
  });

  it('scores indirect and adjacent one band down', () => {
    expect(effectiveLevel(factor('exports_bis_high_priority_items_indirect', 'high'))).toBe(
      'elevated',
    );
    expect(effectiveLevel(factor('export_controls_adjacent', 'elevated'))).toBe('relevant');
  });

  it('drops a `relevant` one band down off the bottom of the scale', () => {
    expect(effectiveLevel(factor('sanctioned_adjacent', 'relevant'))).toBeUndefined();
  });

  it('never scores a subtier factor — it badges instead', () => {
    expect(
      effectiveLevel(factor('forced_labor_aspi_origin_subtier_product_blueprint', 'high')),
    ).toBeUndefined();
  });
});

describe('isPinningFamily — where a `high` disqualifies', () => {
  it('recognises the four families', () => {
    expect(isPinningFamily('sanctioned_adjacent')).toBe(true);
    expect(isPinningFamily('export_controls_adjacent')).toBe(true);
    expect(isPinningFamily('exports_bis_high_priority_items_direct')).toBe(true);
    expect(isPinningFamily('forced_labor_xinjiang_origin_subtier_product_blueprint')).toBe(true);
  });

  it('leaves everything else alone', () => {
    expect(isPinningFamily('cpi_score')).toBe(false);
    expect(isPinningFamily('esg_score_high')).toBe(false);
    expect(isPinningFamily('owner_of_regulatory_action_entity')).toBe(false);
    expect(isPinningFamily('soe_adjacent')).toBe(false);
  });
});

describe('isDisqualifying — a graph-reached fact may not move the award gate', () => {
  it('disqualifies a direct high in a pinning family', () => {
    expect(isDisqualifying(factor('exports_bis_high_priority_items_direct', 'high'))).toBe(true);
  });

  it('does NOT disqualify a psa_ factor, even a high one in a pinning family', () => {
    // Measured on Gestamp: `psa_owned_by_sheffield_hallam_university_reports_
    // forced_labor_entity` at `high`, as an orphan. It deducts at full weight
    // and lights a badge; it does not bar an award.
    expect(
      isDisqualifying(factor('psa_owned_by_sheffield_hallam_reports_forced_labor_entity', 'high')),
    ).toBe(false);
  });

  it('does NOT disqualify an indirect high, because one band down is no longer high', () => {
    expect(isDisqualifying(factor('exports_bis_high_priority_items_indirect', 'high'))).toBe(false);
  });

  it('does NOT disqualify a subtier factor, which never deducts at all', () => {
    expect(
      isDisqualifying(factor('forced_labor_aspi_origin_subtier_product_blueprint', 'high')),
    ).toBe(false);
  });

  it('does not disqualify a high outside a pinning family', () => {
    expect(isDisqualifying(factor('esg_score_high', 'high'))).toBe(false);
  });
});

describe('country-derived factors are excluded, to avoid double-counting Country resilience', () => {
  it('identifies them by metadata.country rather than by a name list', () => {
    expect(isCountryDerived(factor('cpi_score', 'relevant', ['MEX']))).toBe(true);
    expect(isCountryDerived(factor('basel_aml', 'relevant', ['MEX']))).toBe(true);
    expect(isCountryDerived(factor('eu_high_risk_third', 'relevant', ['CHN']))).toBe(true);
    // A country-derived factor we have not seen before is excluded too.
    expect(isCountryDerived(factor('some_new_country_index', 'high', ['DEU']))).toBe(true);
    expect(isCountryDerived(factor('exports_bis_high_priority_items_direct', 'high', null))).toBe(
      false,
    );
  });
});

describe('psa_X dedupes against base X', () => {
  it('drops the psa_ copy when the base is present', () => {
    const kept = dedupePsaAgainstBase([
      factor('exports_bis_high_priority_items_direct'),
      factor('psa_exports_bis_high_priority_items_direct'),
    ]);
    expect(kept.map((f) => f.name)).toEqual(['exports_bis_high_priority_items_direct']);
  });

  it('keeps a psa_ factor with no base — the orphan case', () => {
    const kept = dedupePsaAgainstBase([factor('psa_owner_of_regulatory_action_entity')]);
    expect(kept).toHaveLength(1);
  });

  it('strips only the psa_ prefix', () => {
    expect(baseNameOf('psa_exports_bis_high_priority_items_direct')).toBe(
      'exports_bis_high_priority_items_direct',
    );
    expect(baseNameOf('exports_bis_high_priority_items_direct')).toBe(
      'exports_bis_high_priority_items_direct',
    );
  });
});

describe('parseRiskObject', () => {
  it('reads a real Sayari risk block', () => {
    const parsed = parseRiskObject({
      cpi_score: { level: 'relevant', value: 27, metadata: { country: ['MEX'] } },
      exports_bis_high_priority_items_direct: {
        level: 'high',
        metadata: { traversal_path: ['a', 'b'] },
      },
      not_a_level: { level: 'nonsense' },
    });
    expect(parsed).toHaveLength(3);
    expect(parsed.find((f) => f.name === 'cpi_score')?.country).toEqual(['MEX']);
    expect(
      parsed.find((f) => f.name === 'exports_bis_high_priority_items_direct')?.traversalPath,
    ).toEqual(['a', 'b']);
    // An unrecognised level is dropped rather than guessed at.
    expect(parsed.find((f) => f.name === 'not_a_level')?.level).toBeUndefined();
  });

  it('treats an empty or absent risk object as no factors, not as an error', () => {
    expect(parseRiskObject(null)).toEqual([]);
    expect(parseRiskObject({})).toEqual([]);
  });

  /**
   * `entity.risk` never carries a `sources` key, on purpose (SPEC §8.2 D5) —
   * `src/tools/catalog/reads.ts` hands this column to a model turn verbatim,
   * and an extra key here would be an extra key in a live prompt.
   */
  it('never reads a sources key, even if one were present on the row', () => {
    const parsed = parseRiskObject({ cpi_score: { level: 'relevant', sources: ['getEntity'] } });
    expect(parsed[0]).not.toHaveProperty('sources');
  });
});

/**
 * `attachRiskSources` joins `parseRiskObject`'s factors back up with the
 * sibling `risk_sources` column, for a caller that wants to say who reported
 * a factor — a page render, never anything a model turn could echo verbatim
 * (item A).
 */
describe('attachRiskSources', () => {
  it('adds sources to the factor it names, and leaves the rest alone', () => {
    const factors = parseRiskObject({
      cpi_score: { level: 'relevant' },
      basel_aml: { level: 'relevant' },
    });
    const decorated = attachRiskSources(factors, { cpi_score: ['getEntity', 'traversal'] });
    expect(decorated.find((f) => f.name === 'cpi_score')?.sources).toEqual([
      'getEntity',
      'traversal',
    ]);
    expect(decorated.find((f) => f.name === 'basel_aml')?.sources).toBeUndefined();
  });

  it('is a no-op when risk_sources is null — a row from before this ticket', () => {
    const factors = parseRiskObject({ cpi_score: { level: 'relevant' } });
    expect(attachRiskSources(factors, null)).toEqual(factors);
  });
});

describe('the deduction table', () => {
  it('is the documented, provisional one', () => {
    expect(DEDUCTION_BY_LEVEL).toEqual({ high: 40, elevated: 20, relevant: 8 });
  });
});
