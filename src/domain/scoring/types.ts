import type { RiskFactor } from './risk-factors';

/**
 * The scoring inputs and outputs (SPEC §9).
 *
 * `score.ts` is a **pure function called by server and browser alike**, so its
 * input is a plain value rather than a database handle: a weight drag re-ranks
 * in the browser with no round trip and no Job re-run.
 */

export type CriterionKey =
  | 'compliance_risk'
  | 'ownership_exposure'
  | 'country_resilience'
  | 'tariff_exposure'
  | 'proximity'
  | 'media_signal';

export type DataConfidenceBand = 'strong' | 'adequate' | 'thin';

/**
 * A Criterion that could not be computed returns `unknown` with a **reason**.
 *
 * It drops out and the remaining weights renormalise. A neutral 50 was rejected
 * as **a fabricated fact a Citation could point at**, which is the worst
 * failure this app has — and the reason is what the Assessment's mandatory
 * `limits` section names.
 */
export type CriterionOutcome =
  | {
      status: 'value';
      /** 0–100, higher is better. */
      value: number;
      /** True when the input fell outside its anchor and was clamped. */
      clamped: boolean;
      /** Shown beside the number, always. Never a bare figure. */
      rawInputs: Record<string, unknown>;
      anchorLine: string;
    }
  | {
      status: 'unknown';
      reason: string;
      rawInputs: Record<string, unknown>;
      anchorLine: string;
    };

/** Everything one Supplier's Criteria are computed from. */
export type SupplierScoringInput = {
  supplierId: string;
  displayName: string;

  /** Only an accepted Match yields a Profile, and only a Profile is scored. */
  match: { status: 'accepted' | 'needs_review' | 'not_found'; entityId?: string | undefined };

  /** The resolved Profile. Absent unless the Match is accepted. */
  profile?:
    | {
        entityId: string;
        legalName: string;
        /** **The Profile's country is what is scored**, never the roster's. */
        country?: string | undefined;
        lat?: number | undefined;
        lon?: number | undefined;
        coordinatePrecision?: string | undefined;
        distinctSourceCount?: number | undefined;
        sanctioned: boolean;
        pep: boolean;
        closed: boolean;
        riskFactors: RiskFactor[];
        /** `possibly_same_as` count — a split record, not an absent one. */
        psaCount?: number | undefined;
        /** Keyed by relation type; distinguishes "no owner" from "did not look". */
        relationshipCount?: Record<string, number> | undefined;
        relationshipsTruncated: boolean;
      }
    | undefined;

  /** Current (`former = false`) one-hop owner edges, with the owner's own risk. */
  owners: {
    entityId: string;
    label: string;
    riskFactors: RiskFactor[];
    isStateOwned: boolean;
  }[];

  /** World Bank rows for the Profile's country. */
  countryIndicators: {
    code: string;
    value: number | null;
    lowerBound?: number | null;
    upperBound?: number | null;
    year?: number | null;
  }[];

  /** The scored line is the Category's default; the Mexican duty rides beside it. */
  tariff?:
    | {
        hsCode: string;
        mfnRatePct: number | null;
        /** Fetched and rendered, **never scored** (SPEC §9.2). */
        mexicoRatePct?: number | null;
        candidateLines?: { hsCode: string; ratePct: number }[];
      }
    | undefined;

  /** Great-circle distance to the nearest Plant, precomputed by the caller. */
  nearestPlant?: { code: string; city: string; km: number } | undefined;

  /** `negativeNews` on the resolved legal name. */
  news?:
    | {
        ranOnResolvedLegalName: boolean;
        articles: { seriousFlags: number; moderateFlags: number }[];
      }
    | undefined;

  /** Which expected Enrichments this Supplier actually has. */
  presentEnrichments: string[];
};

/** The weight vector, keyed rather than positional (SPEC §13.5). */
export type WeightVector = Partial<Record<CriterionKey, number>>;

export type ScoredCriterion = {
  key: CriterionKey;
  outcome: CriterionOutcome;
  /** The weight after renormalisation; 0 for a Criterion that dropped out. */
  effectiveWeight: number;
  /** value × effectiveWeight / 100 — what the contribution table sorts by. */
  contribution: number;
};

export type SupplierScore = {
  supplierId: string;
  displayName: string;
  /** Null when there is no Category, or no accepted Match. */
  score: number | null;
  /** Why there is no Score, when there is none. */
  scoreAbsentReason?: 'no_match' | 'no_category';
  criteria: ScoredCriterion[];
  /** "5 of 6" — shown wherever the Score is. */
  coverage: { computed: number; total: number };
  dataConfidence: DataConfidenceBand;
  /** True when a `high` factor in a pinning family fired. Forces the verdict. */
  disqualifying: boolean;
  disqualifyingFactors: string[];
  /** The renormalised vector that produced this Score, for the breakdown. */
  renormalisedWeights: Record<string, number>;
};
