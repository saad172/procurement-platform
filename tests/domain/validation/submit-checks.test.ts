import { describe, expect, it } from 'vitest';
import {
  checkAssessment,
  checkRecommendation,
  type ResolvedEvidence,
  type SubmittedSentence,
} from '@/domain/validation/submit-checks';

/**
 * SPEC §10.4 — the eight code checks.
 *
 * Each test is a way the record could have acquired an unproven claim. The
 * checks run **before the insert**, so passing them is what "there is no window
 * in which the record contains an unproven claim" actually means.
 */

const CITED_ROW = { value: 92, criterionKey: 'compliance_risk' };
const CITED_KEY = JSON.stringify({ criterionValueId: 'cv-1' });

function evidence(overrides: Partial<ResolvedEvidence> = {}): ResolvedEvidence {
  return {
    rowsByCitation: new Map([[CITED_KEY, CITED_ROW]]),
    frozenInputs: { scores: { 'supplier-a': 84.2 } },
    suppliers: new Map([
      [
        'supplier-a',
        {
          name: 'Alpha',
          matchAccepted: true,
          categoryIds: ['cat-1'],
          hasScore: true,
          disqualifying: false,
          publishedWithObjections: false,
          onShortlist: true,
        },
      ],
    ]),
    unknownCriteria: [],
    mandatoryCaveats: [],
    ...overrides,
  };
}

const cited = (section: string, text: string): SubmittedSentence => ({
  section,
  text,
  citations: [{ criterionValueId: 'cv-1' }],
});

const legalAssessment = (): SubmittedSentence[] => [
  cited('identity', 'Alpha is the company at the roster address.'),
  cited('limits', 'Every criterion returned a value.'),
];

describe('check 1 — every sentence carries a citation resolving to a live row', () => {
  it('rejects a sentence with no citation at all', () => {
    const objections = checkAssessment({
      verdict: 'recommend',
      supplierId: 'supplier-a',
      sentences: [
        ...legalAssessment(),
        { section: 'compliance', text: 'It is clean.', citations: [] },
      ],
      evidence: evidence(),
    });
    expect(objections.some((o) => o.check === 'citations')).toBe(true);
    expect(objections.find((o) => o.check === 'citations')!.message).toMatch(/carries no citation/);
  });

  it('rejects a citation pointing at a row that does not exist', () => {
    const objections = checkAssessment({
      verdict: 'recommend',
      supplierId: 'supplier-a',
      sentences: [
        ...legalAssessment(),
        { section: 'compliance', text: 'It is clean.', citations: [{ criterionValueId: 'nope' }] },
      ],
      evidence: evidence(),
    });
    expect(objections.some((o) => /does not exist/.test(o.message))).toBe(true);
  });

  it('accepts a fully cited assessment', () => {
    expect(
      checkAssessment({
        verdict: 'recommend',
        supplierId: 'supplier-a',
        sentences: legalAssessment(),
        evidence: evidence(),
      }),
    ).toEqual([]);
  });
});

describe('check 3 — mandatory caveats', () => {
  it('rejects a tariff section with no caveat', () => {
    const objections = checkAssessment({
      verdict: 'recommend',
      supplierId: 'supplier-a',
      sentences: [...legalAssessment(), cited('tariff', 'The rate is high.')],
      evidence: evidence({
        mandatoryCaveats: [
          {
            section: 'tariff',
            mustMention: /trade[- ]action|flag|not folded/i,
            describedAs: 'trade-action flags are not folded into the rate',
          },
        ],
      }),
    });
    expect(objections.some((o) => o.check === 'caveats')).toBe(true);
  });

  it('accepts it once the caveat is there', () => {
    const objections = checkAssessment({
      verdict: 'recommend',
      supplierId: 'supplier-a',
      sentences: [
        ...legalAssessment(),
        cited('tariff', 'The rate is high; trade-action flags are not folded into it.'),
      ],
      evidence: evidence({
        mandatoryCaveats: [
          { section: 'tariff', mustMention: /trade[- ]action/i, describedAs: 'trade-action flags' },
        ],
      }),
    });
    expect(objections).toEqual([]);
  });
});

describe('check 5 — required sections, and what `limits` is for', () => {
  it('rejects an assessment with no identity section', () => {
    const objections = checkAssessment({
      verdict: 'recommend',
      supplierId: 'supplier-a',
      sentences: [cited('limits', 'Nothing is unknown.')],
      evidence: evidence(),
    });
    expect(objections.some((o) => /"identity"/.test(o.message))).toBe(true);
  });

  it('rejects an EMPTY limits section — the one section that may never be empty', () => {
    const objections = checkAssessment({
      verdict: 'recommend',
      supplierId: 'supplier-a',
      sentences: [
        cited('identity', 'Alpha is the company.'),
        { section: 'limits', text: '   ', citations: [{ criterionValueId: 'cv-1' }] },
      ],
      evidence: evidence(),
    });
    expect(objections.some((o) => /"limits"/.test(o.message))).toBe(true);
  });

  it('requires limits to NAME every unknown criterion', () => {
    // This is what stops the rest of the document reading as more certain than
    // it is.
    const objections = checkAssessment({
      verdict: 'recommend',
      supplierId: 'supplier-a',
      sentences: legalAssessment(),
      evidence: evidence({ unknownCriteria: ['ownership_exposure'] }),
    });
    expect(objections.some((o) => /Missing: ownership_exposure/.test(o.message))).toBe(true);
  });

  it('accepts limits that names them', () => {
    const objections = checkAssessment({
      verdict: 'recommend',
      supplierId: 'supplier-a',
      sentences: [
        cited('identity', 'Alpha is the company.'),
        cited('limits', 'Ownership exposure is unknown: the company is split across records.'),
      ],
      evidence: evidence({ unknownCriteria: ['ownership_exposure'] }),
    });
    expect(objections).toEqual([]);
  });

  it('refuses an AUTHORED dissent section — nobody writes dissent', () => {
    const objections = checkAssessment({
      verdict: 'recommend',
      supplierId: 'supplier-a',
      sentences: [...legalAssessment(), cited('dissent', 'Some disagreed.')],
      evidence: evidence(),
    });
    expect(objections.some((o) => /Nobody writes dissent/.test(o.message))).toBe(true);
  });

  it('refuses a tariff section for a supplier with no category', () => {
    // Which is what keeps the eight uncategorised suppliers legal.
    const noCategory = evidence();
    noCategory.suppliers.get('supplier-a')!.categoryIds = [];
    const objections = checkAssessment({
      verdict: 'recommend',
      supplierId: 'supplier-a',
      sentences: [...legalAssessment(), cited('tariff', 'The rate is 5%.')],
      evidence: noCategory,
    });
    expect(objections.some((o) => /bids on no category/.test(o.message))).toBe(true);
  });
});

describe('check 7 — the disqualifying badge forces the verdict', () => {
  const disqualified = () => {
    const e = evidence();
    e.suppliers.get('supplier-a')!.disqualifying = true;
    return e;
  };

  it('rejects "recommend" for a disqualified supplier', () => {
    const objections = checkAssessment({
      verdict: 'recommend',
      supplierId: 'supplier-a',
      sentences: legalAssessment(),
      evidence: disqualified(),
    });
    expect(objections.some((o) => o.check === 'disqualifying_badge')).toBe(true);
  });

  it('accepts either do_not_shortlist OR escalate, because CODE DOES NOT CHOOSE', () => {
    // Which of the two is a judgement, and the message says so.
    for (const verdict of ['do_not_shortlist', 'escalate']) {
      expect(
        checkAssessment({
          verdict,
          supplierId: 'supplier-a',
          sentences: legalAssessment(),
          evidence: disqualified(),
        }),
      ).toEqual([]);
    }
  });
});

describe('checks 4 and 6 — eligibility and pick legality', () => {
  const legalRecommendation = () => [cited('headline', 'Award Alpha.')];

  it('accepts a legal recommendation', () => {
    expect(
      checkRecommendation({
        picks: [{ supplierId: 'supplier-a', role: 'award', rank: 1 }],
        sentences: legalRecommendation(),
        categoryId: 'cat-1',
        evidence: evidence(),
      }),
    ).toEqual([]);
  });

  it('rejects a pick with no accepted match', () => {
    const e = evidence();
    e.suppliers.get('supplier-a')!.matchAccepted = false;
    const objections = checkRecommendation({
      picks: [{ supplierId: 'supplier-a', role: 'award', rank: 1 }],
      sentences: legalRecommendation(),
      categoryId: 'cat-1',
      evidence: e,
    });
    expect(objections.some((o) => /no accepted match/.test(o.message))).toBe(true);
    expect(objections.find((o) => /no accepted match/.test(o.message))!.message).toMatch(
      /say why in a sentence/,
    );
  });

  it('rejects a pick on a category the supplier does not bid on', () => {
    const objections = checkRecommendation({
      picks: [{ supplierId: 'supplier-a', role: 'award', rank: 1 }],
      sentences: legalRecommendation(),
      categoryId: 'cat-other',
      evidence: evidence(),
    });
    expect(objections.some((o) => /does not bid on this category/.test(o.message))).toBe(true);
  });

  it('rejects more than three picks, and more than one award', () => {
    const e = evidence();
    for (const id of ['b', 'c', 'd']) {
      e.suppliers.set(id, { ...e.suppliers.get('supplier-a')!, name: id.toUpperCase() });
    }
    const objections = checkRecommendation({
      picks: [
        { supplierId: 'supplier-a', role: 'award', rank: 1 },
        { supplierId: 'b', role: 'award', rank: 2 },
        { supplierId: 'c', role: 'develop', rank: 3 },
        { supplierId: 'd', role: 'avoid', rank: 4 },
      ],
      sentences: legalRecommendation(),
      categoryId: 'cat-1',
      evidence: e,
    });
    expect(objections.some((o) => /At most three picks/.test(o.message))).toBe(true);
    expect(objections.some((o) => /At most one award/.test(o.message))).toBe(true);
  });

  it('bars a disqualified supplier from award or second source — but not from develop or avoid', () => {
    // `develop` and `avoid` are judgements about a company you are NOT buying
    // from yet, so the badge does not bar them.
    const e = evidence();
    e.suppliers.get('supplier-a')!.disqualifying = true;
    const barred = checkRecommendation({
      picks: [{ supplierId: 'supplier-a', role: 'second_source', rank: 1 }],
      sentences: legalRecommendation(),
      categoryId: 'cat-1',
      evidence: e,
    });
    expect(barred.some((o) => o.check === 'disqualifying_badge')).toBe(true);

    const allowed = checkRecommendation({
      picks: [{ supplierId: 'supplier-a', role: 'avoid', rank: 1 }],
      sentences: legalRecommendation(),
      categoryId: 'cat-1',
      evidence: e,
    });
    expect(allowed.some((o) => o.check === 'disqualifying_badge')).toBe(false);
  });

  it('permits departing from rank order, but ONLY when it is argued for', () => {
    // Because tariff moves no rank and country barely discriminates, a score
    // that MUST be obeyed would make the app's own honesty unusable.
    const unargued = checkRecommendation({
      picks: [{ supplierId: 'supplier-a', role: 'award', rank: 3 }],
      sentences: legalRecommendation(),
      categoryId: 'cat-1',
      evidence: evidence(),
    });
    expect(unargued.some((o) => /must be argued for/.test(o.message))).toBe(true);

    const argued = checkRecommendation({
      picks: [{ supplierId: 'supplier-a', role: 'award', rank: 3 }],
      sentences: [...legalRecommendation(), cited('rationale', 'Alpha scores 92 on compliance.')],
      categoryId: 'cat-1',
      evidence: evidence(),
    });
    expect(argued.some((o) => /must be argued for/.test(o.message))).toBe(false);
  });

  it('requires exactly one headline', () => {
    const objections = checkRecommendation({
      picks: [],
      sentences: [cited('headline', 'One.'), cited('headline', 'Two.')],
      categoryId: 'cat-1',
      evidence: evidence(),
    });
    expect(objections.some((o) => /exactly one headline/.test(o.message))).toBe(true);
  });

  it('confines a pick-attached sentence to the conditions section', () => {
    const objections = checkRecommendation({
      picks: [{ supplierId: 'supplier-a', role: 'award', rank: 1 }],
      sentences: [
        ...legalRecommendation(),
        { ...cited('rationale', 'Conditional on audit.'), pickSupplierId: 'supplier-a' },
      ],
      categoryId: 'cat-1',
      evidence: evidence(),
    });
    expect(objections.some((o) => /only in the conditions section/.test(o.message))).toBe(true);
  });
});

describe('check 8 — upstream disclosure', () => {
  it('requires a shortlisted supplier whose assessment published with objections to be named', () => {
    // A recommendation may not cite an assessment, so without this rule the
    // unresolved objection simply vanishes at the boundary.
    const e = evidence();
    e.suppliers.get('supplier-a')!.publishedWithObjections = true;
    const objections = checkRecommendation({
      picks: [],
      sentences: [cited('headline', 'Award nobody yet.')],
      categoryId: 'cat-1',
      evidence: e,
    });
    expect(objections.some((o) => o.check === 'upstream_disclosure')).toBe(true);
    expect(objections.find((o) => o.check === 'upstream_disclosure')!.message).toMatch(
      /must not vanish at the boundary/,
    );
  });

  it('accepts it once an open question names them', () => {
    const e = evidence();
    e.suppliers.get('supplier-a')!.publishedWithObjections = true;
    const objections = checkRecommendation({
      picks: [],
      sentences: [
        cited('headline', 'Award nobody yet.'),
        cited('open_questions', 'Alpha’s assessment published with unresolved objections.'),
      ],
      categoryId: 'cat-1',
      evidence: e,
    });
    expect(objections.some((o) => o.check === 'upstream_disclosure')).toBe(false);
  });
});

describe('every objection is returned, not just the first', () => {
  it('reports all of them, because each rejection costs a Round', () => {
    const objections = checkAssessment({
      verdict: 'recommend',
      supplierId: 'supplier-a',
      sentences: [{ section: 'compliance', text: 'It scores 99.', citations: [] }],
      evidence: evidence({ unknownCriteria: ['proximity'] }),
    });
    const checks = new Set(objections.map((o) => o.check));
    // Missing citation, missing identity, missing limits, unnamed unknown.
    expect(checks.size).toBeGreaterThanOrEqual(3);
  });
});
