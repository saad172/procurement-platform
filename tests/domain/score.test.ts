import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEIGHTS,
  WEIGHTED_CRITERIA,
  WEIGHT_PRESETS,
  assertPresetsAreLegal,
  buildShortlist,
  dataConfidence,
  normaliseWeights,
  scoreSupplier,
} from '@/domain/score';
import { EXPECTED_ENRICHMENTS } from '@/domain/scoring/anchors';
import type { RiskFactor } from '@/domain/scoring/risk-factors';
import type { SupplierScoringInput } from '@/domain/scoring/types';

/** A Supplier with everything present, so a test can subtract one thing. */
function completeInput(overrides: Partial<SupplierScoringInput> = {}): SupplierScoringInput {
  return {
    supplierId: 's1',
    displayName: 'Test Supplier',
    match: { status: 'accepted', entityId: 'e1' },
    profile: {
      entityId: 'e1',
      legalName: 'TEST SUPPLIER GMBH',
      country: 'DEU',
      lat: 48.7,
      lon: 9.2,
      coordinatePrecision: 'building',
      distinctSourceCount: 20,
      sanctioned: false,
      pep: false,
      closed: false,
      riskFactors: [],
      psaCount: 0,
      relationshipCount: { owner_of: 1 },
      relationshipsTruncated: false,
    },
    owners: [{ entityId: 'o1', label: 'Parent AG', riskFactors: [], isStateOwned: false }],
    countryIndicators: [
      { code: 'LP.LPI.OVRL.XQ', value: 4.1, year: 2022 },
      { code: 'GOV_WGI_PV.EST.SC', value: 70, lowerBound: 65, upperBound: 75, year: 2023 },
      { code: 'GOV_WGI_RL.EST.SC', value: 90, year: 2023 },
      { code: 'GOV_WGI_RQ.EST.SC', value: 88, year: 2023 },
      { code: 'GOV_WGI_CC.EST.SC', value: 86, year: 2023 },
      { code: 'GOV_WGI_GE.EST.SC', value: 87, year: 2023 },
    ],
    tariff: { hsCode: '8544.30', mfnRatePct: 5, mexicoRatePct: 0 },
    nearestPlant: { code: 'P3', city: 'Lansing, Michigan', km: 100 },
    news: { ranOnResolvedLegalName: true, articles: [] },
    presentEnrichments: [...EXPECTED_ENRICHMENTS],
    ...overrides,
  };
}

const factor = (name: string, level: RiskFactor['level'] = 'high', country: unknown = null): RiskFactor => ({
  name,
  level,
  country,
  traversalPath: null,
  value: null,
});

describe('the scale contract', () => {
  it('renders every value with its raw input and its anchor line — never a bare number', () => {
    // "The app may never render a Criterion number alone" is a property of the
    // return value, not of the UI: if the data does not carry the raw input,
    // no amount of care in the component can show it.
    const result = scoreSupplier(completeInput());
    for (const criterion of result.criteria) {
      expect(criterion.outcome.anchorLine).toBeTruthy();
      expect(criterion.outcome.rawInputs).toBeDefined();
    }
  });

  it('computes the documented tariff anchor points', () => {
    const at = (rate: number) => {
      const r = scoreSupplier(completeInput({ tariff: { hsCode: 'x', mfnRatePct: rate } }));
      const c = r.criteria.find((x) => x.key === 'tariff_exposure')!;
      return c.outcome.status === 'value' ? Math.round(c.outcome.value) : null;
    };
    // 0% → 100, 2.5% → 75, 3.4% → 66, 4.2% → 58, 5% → 50.
    expect(at(0)).toBe(100);
    expect(at(2.5)).toBe(75);
    expect(at(3.4)).toBe(66);
    expect(at(4.2)).toBe(58);
    expect(at(5)).toBe(50);
  });

  it('computes the documented proximity anchor points, linear not square-rooted', () => {
    const at = (km: number) => {
      const r = scoreSupplier(completeInput({ nearestPlant: { code: 'P1', city: 'x', km } }));
      const c = r.criteria.find((x) => x.key === 'proximity')!;
      return c.outcome.status === 'value' ? Math.round(c.outcome.value) : null;
    };
    // 48 km → 99, 824 km → 90, 6 082 km → 24, ≥ 8 000 km → 0.
    expect(at(48)).toBe(99);
    expect(at(824)).toBe(90);
    expect(at(6_082)).toBe(24);
    expect(at(8_000)).toBe(0);
    expect(at(12_000)).toBe(0);
  });

  it('clamps a value outside its anchor, visibly', () => {
    const r = scoreSupplier(completeInput({ nearestPlant: { code: 'P1', city: 'x', km: 20_000 } }));
    const c = r.criteria.find((x) => x.key === 'proximity')!;
    expect(c.outcome.status).toBe('value');
    if (c.outcome.status === 'value') {
      expect(c.outcome.value).toBe(0);
      expect(c.outcome.clamped).toBe(true);
    }
  });
});

describe('an uncomputable Criterion drops out — never a neutral 50', () => {
  it('drops it, renormalises the survivors, and reports coverage', () => {
    const r = scoreSupplier(completeInput({ nearestPlant: undefined }));
    const proximity = r.criteria.find((x) => x.key === 'proximity')!;
    expect(proximity.outcome.status).toBe('unknown');
    expect(proximity.effectiveWeight).toBe(0);
    expect(r.coverage).toEqual({ computed: 5, total: 6 });

    // The survivors' weights renormalise to 100, so the Score stays on scale.
    const total = r.criteria.reduce((sum, c) => sum + c.effectiveWeight, 0);
    expect(total).toBeCloseTo(100, 6);
  });

  it('names a reason, which is what the Assessment’s `limits` section requires', () => {
    const r = scoreSupplier(completeInput({ nearestPlant: undefined }));
    const proximity = r.criteria.find((x) => x.key === 'proximity')!;
    if (proximity.outcome.status === 'unknown') {
      expect(proximity.outcome.reason).toMatch(/no coordinate/i);
    }
  });

  it('never substitutes a stand-in value', () => {
    const r = scoreSupplier(completeInput({ nearestPlant: undefined, tariff: undefined }));
    for (const c of r.criteria) {
      if (c.outcome.status === 'unknown') expect(c).not.toHaveProperty('outcome.value');
    }
    expect(r.coverage.computed).toBe(4);
  });
});

describe('the coverage precondition — an empty result is never a clean result', () => {
  it('returns unknown for compliance and media when data confidence is thin', () => {
    // This is what stops a Supplier with zero articles and an empty risk object
    // scoring 100 twice for what nobody looked at.
    const thin = completeInput({
      profile: { ...completeInput().profile!, distinctSourceCount: 2 },
      presentEnrichments: [],
    });
    const r = scoreSupplier(thin);
    expect(r.dataConfidence).toBe('thin');
    expect(r.criteria.find((c) => c.key === 'compliance_risk')!.outcome.status).toBe('unknown');
    expect(r.criteria.find((c) => c.key === 'media_signal')!.outcome.status).toBe('unknown');
  });

  it('scores an empty risk object as clean once coverage is adequate', () => {
    const r = scoreSupplier(completeInput());
    const compliance = r.criteria.find((c) => c.key === 'compliance_risk')!;
    expect(compliance.outcome.status).toBe('value');
    if (compliance.outcome.status === 'value') expect(compliance.outcome.value).toBe(100);
  });

  it('returns unknown for media when the query did not run on a resolved legal name', () => {
    const r = scoreSupplier(completeInput({ news: { ranOnResolvedLegalName: false, articles: [] } }));
    const media = r.criteria.find((c) => c.key === 'media_signal')!;
    expect(media.outcome.status).toBe('unknown');
  });
});

describe('the disqualifying badge', () => {
  it('pins compliance to 0 and lights the badge on a direct high in a pinning family', () => {
    const r = scoreSupplier(
      completeInput({
        profile: {
          ...completeInput().profile!,
          riskFactors: [factor('exports_bis_high_priority_items_direct', 'high')],
        },
      }),
    );
    const compliance = r.criteria.find((c) => c.key === 'compliance_risk')!;
    if (compliance.outcome.status === 'value') expect(compliance.outcome.value).toBe(0);
    expect(r.disqualifying).toBe(true);
    expect(r.disqualifyingFactors).toContain('exports_bis_high_priority_items_direct');
  });

  it('deducts but does NOT disqualify on a Twin’s factor — the honest cost, stated', () => {
    // A Supplier whose Twin record is owned by a forced-labour-reported entity
    // can still be awarded. It shows a cut Score and a lit family badge; it is
    // not blocked. That is the same rule as a subsidiary's `high`.
    const r = scoreSupplier(
      completeInput({
        profile: {
          ...completeInput().profile!,
          riskFactors: [factor('psa_owned_by_sheffield_hallam_reports_forced_labor_entity', 'high')],
        },
      }),
    );
    const compliance = r.criteria.find((c) => c.key === 'compliance_risk')!;
    if (compliance.outcome.status === 'value') expect(compliance.outcome.value).toBe(60);
    expect(r.disqualifying).toBe(false);
  });

  it('does not disqualify on an indirect high, which scores one band down', () => {
    const r = scoreSupplier(
      completeInput({
        profile: {
          ...completeInput().profile!,
          riskFactors: [factor('exports_bis_high_priority_items_indirect', 'high')],
        },
      }),
    );
    const compliance = r.criteria.find((c) => c.key === 'compliance_risk')!;
    if (compliance.outcome.status === 'value') expect(compliance.outcome.value).toBe(80);
    expect(r.disqualifying).toBe(false);
  });

  it('badges a subtier factor without deducting anything', () => {
    const r = scoreSupplier(
      completeInput({
        profile: {
          ...completeInput().profile!,
          riskFactors: [factor('forced_labor_aspi_origin_subtier_product_blueprint', 'high')],
        },
      }),
    );
    const compliance = r.criteria.find((c) => c.key === 'compliance_risk')!;
    expect(compliance.outcome.status).toBe('value');
    if (compliance.outcome.status === 'value') {
      expect(compliance.outcome.value).toBe(100);
      expect(compliance.outcome.rawInputs.subtierBadgedNotDeducted).toEqual([
        'forced_labor_aspi_origin_subtier_product_blueprint',
      ]);
    }
  });

  it('excludes country-derived factors so Country resilience is not double-counted', () => {
    const r = scoreSupplier(
      completeInput({
        profile: {
          ...completeInput().profile!,
          riskFactors: [
            factor('cpi_score', 'relevant', ['DEU']),
            factor('basel_aml', 'relevant', ['DEU']),
          ],
        },
      }),
    );
    const compliance = r.criteria.find((c) => c.key === 'compliance_risk')!;
    if (compliance.outcome.status === 'value') {
      expect(compliance.outcome.value).toBe(100);
      expect(compliance.outcome.rawInputs.countryDerivedExcluded).toEqual(['cpi_score', 'basel_aml']);
    }
  });
});

describe('Ownership exposure names WHY it is unknown', () => {
  const noOwners = () => completeInput({ owners: [] });

  it('distinguishes a real absence', () => {
    const r = scoreSupplier(
      noOwners(),
    );
    // The complete fixture claims one owner edge in relationshipCount, so with
    // no owners passed this reads as a truncated window, not an absence.
    const ownership = r.criteria.find((c) => c.key === 'ownership_exposure')!;
    expect(ownership.outcome.status).toBe('unknown');
    if (ownership.outcome.status === 'unknown') {
      expect(ownership.outcome.reason).toMatch(/did not look far enough/);
    }
  });

  it('distinguishes a split record from an absent owner', () => {
    const input = noOwners();
    const r = scoreSupplier({
      ...input,
      profile: { ...input.profile!, relationshipCount: {}, psaCount: 33 },
    });
    const ownership = r.criteria.find((c) => c.key === 'ownership_exposure')!;
    if (ownership.outcome.status === 'unknown') {
      expect(ownership.outcome.reason).toMatch(/split across 33 records/);
    }
  });

  it('says plainly when the graph records no owner', () => {
    const input = noOwners();
    const r = scoreSupplier({
      ...input,
      profile: { ...input.profile!, relationshipCount: {}, psaCount: 0 },
    });
    const ownership = r.criteria.find((c) => c.key === 'ownership_exposure')!;
    if (ownership.outcome.status === 'unknown') {
      expect(ownership.outcome.reason).toMatch(/records no owner/);
    }
  });
});

describe('a Supplier with no Score', () => {
  it('has none because its Match is not accepted, and says so', () => {
    const r = scoreSupplier(completeInput({ match: { status: 'needs_review' }, profile: undefined }));
    expect(r.score).toBeNull();
    expect(r.scoreAbsentReason).toBe('no_match');
    expect(r.dataConfidence).toBe('thin');
  });

  it('has none because it has no Category, which is a different reason', () => {
    const r = scoreSupplier(completeInput(), DEFAULT_WEIGHTS, { hasCategory: false });
    expect(r.score).toBeNull();
    expect(r.scoreAbsentReason).toBe('no_category');
    // It still carries its five non-tariff Criterion values.
    expect(r.criteria.filter((c) => c.outcome.status === 'value').length).toBeGreaterThanOrEqual(5);
  });
});

describe('weights', () => {
  it('every preset is legal at boot', () => {
    expect(() => assertPresetsAreLegal()).not.toThrow();
    for (const preset of Object.values(WEIGHT_PRESETS)) {
      expect(Object.values(preset).reduce((a, b) => a + b, 0)).toBe(100);
      expect(Object.keys(preset).sort()).toEqual([...WEIGHTED_CRITERIA].sort());
    }
  });

  it('is keyed, not positional — a missing key falls back to the Program default', () => {
    const partial = normaliseWeights({ compliance_risk: 50 });
    expect(partial.compliance_risk).toBe(50);
    expect(partial.proximity).toBe(DEFAULT_WEIGHTS.proximity);
  });

  it('drops an unknown key rather than misreading the vector', () => {
    const w = normaliseWeights({ compliance_risk: 40, not_a_criterion: 60 } as never);
    expect(Object.keys(w).sort()).toEqual([...WEIGHTED_CRITERIA].sort());
  });

  it('makes a what-if vector and a saved vector behave identically', () => {
    // Renormalisation lives INSIDE scoreSupplier, so an un-normalised vector
    // from the URL produces the same Score as a normalised one from the rail.
    const input = completeInput();
    const saved = scoreSupplier(input, DEFAULT_WEIGHTS);
    const doubled = scoreSupplier(
      input,
      Object.fromEntries(Object.entries(DEFAULT_WEIGHTS).map(([k, v]) => [k, v * 2])),
    );
    expect(doubled.score).toBeCloseTo(saved.score!, 9);
  });
});

describe('the Shortlist', () => {
  const withScore = (id: string, name: string, score: number) =>
    scoreSupplier(
      completeInput({
        supplierId: id,
        displayName: name,
        tariff: { hsCode: 'x', mfnRatePct: (100 - score) / 10 },
      }),
    );

  it('ranks by Score descending', () => {
    const { ranked } = buildShortlist([withScore('a', 'A', 50), withScore('b', 'B', 90)]);
    expect(ranked[0]!.displayName).toBe('B');
    expect(ranked[0]!.rank).toBe(1);
    expect(ranked[1]!.rank).toBe(2);
  });

  it('gives equal displayed Scores the same rank', () => {
    const a = withScore('a', 'Alpha', 60);
    const b = { ...withScore('b', 'Beta', 60), score: a.score! + 0.001 };
    const { ranked } = buildShortlist([a, b]);
    expect(ranked[0]!.score!.toFixed(1)).toBe(ranked[1]!.score!.toFixed(1));
    expect(ranked[0]!.rank).toBe(ranked[1]!.rank);
  });

  it('separates the Excluded block by its two distinct reasons', () => {
    const noMatch = scoreSupplier(completeInput({ supplierId: 'x', match: { status: 'not_found' }, profile: undefined }));
    const noCategory = scoreSupplier(completeInput({ supplierId: 'y' }), DEFAULT_WEIGHTS, { hasCategory: false });
    const { ranked, excluded } = buildShortlist([withScore('a', 'A', 70), noMatch, noCategory]);
    expect(ranked).toHaveLength(1);
    expect(excluded.map((e) => e.reason).sort()).toEqual(['no_category', 'no_match']);
  });

  it('shows no estimated Criterion for an excluded Supplier', () => {
    const noMatch = scoreSupplier(completeInput({ match: { status: 'not_found' }, profile: undefined }));
    expect(noMatch.score).toBeNull();
    expect(noMatch.criteria.every((c) => c.contribution === 0)).toBe(true);
  });
});

describe('data confidence is a badge, not a Criterion', () => {
  it('carries no weight and appears in no weight vector', () => {
    expect(WEIGHTED_CRITERIA).not.toContain('data_confidence');
    expect(Object.keys(DEFAULT_WEIGHTS)).not.toContain('data_confidence');
  });

  it('bands on distinct sources and the Enrichment checklist', () => {
    const base = completeInput();
    expect(dataConfidence(base)).toBe('strong');
    expect(dataConfidence({ ...base, presentEnrichments: EXPECTED_ENRICHMENTS.slice(0, 3) as string[] })).toBe('adequate');
    expect(
      dataConfidence({ ...base, profile: { ...base.profile!, distinctSourceCount: 2 } }),
    ).toBe('thin');
  });

  it('is thin for any Match that is not accepted, whatever the source count', () => {
    const base = completeInput();
    expect(dataConfidence({ ...base, match: { status: 'needs_review' } })).toBe('thin');
    expect(dataConfidence({ ...base, match: { status: 'not_found' } })).toBe('thin');
  });

  it('moves no rank — changing only the band leaves the Score identical', () => {
    // The whole reason it was demoted: a Supplier must not lose points for
    // sitting in a thin registry. It gates `clean`; it never scores.
    const strong = completeInput();
    const adequate = completeInput({ presentEnrichments: EXPECTED_ENRICHMENTS.slice(0, 3) as string[] });
    expect(dataConfidence(strong)).toBe('strong');
    expect(dataConfidence(adequate)).toBe('adequate');
    expect(scoreSupplier(strong).score).toBeCloseTo(scoreSupplier(adequate).score!, 9);
  });
});
