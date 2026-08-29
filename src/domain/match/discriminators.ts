import {
  compareAddresses,
  type AddressComparison,
  containsWholeWord,
  normaliseAddress,
  tokens,
  type CandidateAddress,
  type LadderVerdict,
} from './address-ladder';

/**
 * The eight Discriminators (SPEC §6.2).
 *
 * Each stores a verdict of **`pass` / `fail` / `unavailable`** plus one line of
 * reasoning. **No single Discriminator settles a Match**, and three of them are
 * load-bearing *negatively* — they exist to reject, not to accept:
 *
 * - **`street` may never accept alone.** An investment arm sits at the *exact*
 *   roster address of its parent, so the building is not the company.
 * - **`lei_witness = unavailable` is not a failure.** Large private companies
 *   frequently have no LEI, and GLEIF name search only matches the
 *   native-script primary name.
 * - **`business_purpose` is the only check that rejects a correctly-addressed
 *   investment arm.** For a Supplier with no Category it degrades explicitly to
 *   *"is this an operating company at all"* rather than passing silently.
 *
 * `unavailable` is a verdict distinct from `fail` throughout. The distinction
 * is what stops absent evidence reading as contrary evidence.
 */

export const DISCRIMINATOR_NAMES = [
  'country',
  'locality',
  'street',
  'name_cover',
  'alias_context',
  'lei_witness',
  'business_purpose',
  'liveness',
] as const;

export type DiscriminatorName = (typeof DISCRIMINATOR_NAMES)[number];

export type DiscriminatorResult = {
  discriminator: DiscriminatorName;
  verdict: LadderVerdict;
  reasoning: string;
};

export type RosterRow = {
  name: string;
  address: string | null;
  country: string | null;
  /** False for the eight Suppliers the seed keeps deliberately uncategorised. */
  hasCategory: boolean;
};

export type CandidateFacts = {
  entityId: string;
  label: string;
  /** The registered country, from the primary address. */
  country: string | null;
  /**
   * **Every** address the record carries, not just the first. A large company
   * has many — Bosch's record has nineteen — and the roster's city is often not
   * the first one listed.
   */
  addresses: CandidateAddress[];
  /** Every name Sayari lists for this record, including former ones. */
  aliases: string[];
  /** Sayari's own `business_purpose` attribute values. */
  businessPurposes: string[];
  companyType: string | null;
  /** `closed` on the entity, or a `latest_status` saying so. */
  closed: boolean;
  latestStatus: string | null;
  lei: string | null;
  /**
   * The GLEIF record an exact-LEI join returned for this candidate's LEI, if it
   * has one. Absent means the join was not run or found nothing.
   */
  gleif?: { legalName: string | null; city: string | null; country: string | null } | undefined;
};

/** Words a legal name carries that say nothing about which company it is. */
const LEGAL_FORMS = new Set([
  'gmbh', 'ag', 'kg', 'kgaa', 'se', 'mbh', 'co', 'ltd', 'limited', 'plc',
  'inc', 'incorporated', 'corp', 'corporation', 'llc', 'lp', 'sa', 'sas',
  'sarl', 'spa', 'srl', 'bv', 'nv', 'ab', 'as', 'oy', 'kk', 'kabushiki',
  'kaisha', 'pte', 'pty', 'sdn', 'bhd', 'de', 'cv', 'sl', 'the', 'and',
]);

const significantTokens = (name: string): string[] =>
  tokens(name).filter((token) => !LEGAL_FORMS.has(token) && token.length > 1);

/**
 * Words that mark a company as something other than an operating manufacturer.
 *
 * This list is the mechanism behind `business_purpose`, and it is the only
 * thing standing between the app and a confident, sourced, wrong answer on a
 * correctly-addressed investment arm.
 */
const NON_OPERATING_MARKERS = [
  'venture', 'ventures', 'capital', 'investment', 'investments', 'holding',
  'holdings', 'beteiligung', 'beteiligungen', 'finance', 'financing',
  'treasury', 'insurance', 'pension', 'trust', 'foundation', 'stiftung',
  'real estate', 'immobilien', 'property', 'properties', 'leasing',
];

const OPERATING_MARKERS = [
  'manufactur', 'produktion', 'production', 'works', 'werk', 'factory',
  'industri', 'engineering', 'technolog', 'automotive', 'systems', 'components',
  'electronics', 'machinery', 'assembly', 'plant',
];

/** Runs all eight against one Candidate. Order matches DISCRIMINATOR_NAMES. */
export function runDiscriminators(roster: RosterRow, candidate: CandidateFacts): DiscriminatorResult[] {
  const address = compareAddresses({
    rosterAddress: roster.address,
    rosterCountry: roster.country,
    addresses: candidate.addresses,
  });

  return [
    countryDiscriminator(address, candidate),
    localityDiscriminator(address),
    streetDiscriminator(address),
    nameCover(roster, candidate),
    aliasContext(roster, candidate),
    leiWitness(roster, candidate),
    businessPurpose(roster, candidate),
    liveness(candidate),
  ];
}

function countryDiscriminator(address: AddressComparison, candidate: CandidateFacts): DiscriminatorResult {
  const { candidateCountry, rosterCountry } = address.evidence;
  return {
    discriminator: 'country',
    verdict: address.country,
    reasoning:
      address.country === 'pass'
        ? `Registered in ${candidateCountry}, which is the roster's country.`
        : address.country === 'fail'
          ? `Registered in ${candidateCountry}, but the roster says ${rosterCountry}. ${candidate.label} is in a different country.`
          : 'No country to compare on one side or the other.',
  };
}

function localityDiscriminator(address: AddressComparison): DiscriminatorResult {
  const { candidateCity, candidatePostcode, postcodeMatched, addressesConsidered } = address.evidence;
  const across = addressesConsidered > 1 ? ` (across ${addressesConsidered} recorded addresses)` : '';
  return {
    discriminator: 'locality',
    verdict: address.locality,
    reasoning:
      address.locality === 'pass'
        ? postcodeMatched
          ? `The roster line contains the postcode ${candidatePostcode}, which is a strong signal on its own${across}.`
          : `The roster line contains "${candidateCity}" as a whole word${across}.`
        : address.locality === 'fail'
          ? `No recorded address agrees with the roster line${across}; the closest was "${candidateCity ?? '?'}".`
          : 'This record carries no structured city or postcode to compare.',
  };
}

/**
 * **Street may never accept alone**, and the reasoning line says so every time
 * it passes — because the one place this check is dangerous is exactly where it
 * looks most convincing.
 */
function streetDiscriminator(address: AddressComparison): DiscriminatorResult {
  return {
    discriminator: 'street',
    verdict: address.street,
    reasoning:
      address.street === 'pass'
        ? `Street-level tokens agree (${address.evidence.streetTokensMatched.slice(0, 4).join(', ')}). This is never sufficient alone: an investment arm often sits at its parent's exact address.`
        : address.street === 'fail'
          ? 'The locality does not agree, so street-level agreement cannot be claimed.'
          : 'The roster line carries no street-level tokens beyond the city and postcode.',
  };
}

/** Does the roster name's substance appear in the candidate's legal name? */
function nameCover(roster: RosterRow, candidate: CandidateFacts): DiscriminatorResult {
  const rosterSignificant = significantTokens(roster.name);
  if (rosterSignificant.length === 0) {
    return {
      discriminator: 'name_cover',
      verdict: 'unavailable',
      reasoning: 'The roster name is only legal-form words, so there is nothing to cover.',
    };
  }
  const candidateNormalised = normaliseAddress(candidate.label);
  const covered = rosterSignificant.filter((token) => containsWholeWord(candidateNormalised, token));
  const ratio = covered.length / rosterSignificant.length;

  return {
    discriminator: 'name_cover',
    verdict: ratio === 1 ? 'pass' : ratio >= 0.5 ? 'unavailable' : 'fail',
    reasoning:
      ratio === 1
        ? `"${candidate.label}" contains every substantive word of "${roster.name}".`
        : ratio >= 0.5
          ? `"${candidate.label}" contains ${covered.length} of ${rosterSignificant.length} substantive words — partial cover, which settles nothing either way.`
          : `"${candidate.label}" shares almost nothing with "${roster.name}".`,
  };
}

/**
 * Does the roster name appear among the candidate's aliases — and is that
 * alias *current*?
 *
 * **An alias outlives a divestiture.** A company sold years ago keeps the old
 * group's name in alias data, which is precisely how a top-hit acceptor picks
 * the wrong company. So an alias hit alone is `unavailable`, never `pass`: it
 * is a reason to look, not a reason to conclude.
 */
function aliasContext(roster: RosterRow, candidate: CandidateFacts): DiscriminatorResult {
  const rosterTokens = significantTokens(roster.name);
  if (rosterTokens.length === 0) {
    return {
      discriminator: 'alias_context',
      verdict: 'unavailable',
      reasoning: 'The roster name is only legal-form words, so there is no name to place in context.',
    };
  }

  // The question this check asks is not "does the name appear" — `name_cover`
  // already asks that. It asks WHERE it appears, because the answer changes
  // what the appearance is worth.
  const inPrimaryLabel = rosterTokens.every((token) =>
    significantTokens(candidate.label).includes(token),
  );
  if (inPrimaryLabel) {
    return {
      discriminator: 'alias_context',
      verdict: 'pass',
      reasoning: `The roster name is in this record's own legal name, "${candidate.label}", so no alias is doing the work.`,
    };
  }

  const hit = candidate.aliases.find((alias) => {
    const aliasTokens = significantTokens(alias);
    return rosterTokens.every((token) => aliasTokens.includes(token));
  });
  if (hit) {
    return {
      discriminator: 'alias_context',
      verdict: 'unavailable',
      reasoning: `The roster name appears only as the alias "${hit}", not in the legal name "${candidate.label}". An alias outlives a divestiture, so this is a reason to look rather than a reason to conclude.`,
    };
  }
  return {
    discriminator: 'alias_context',
    verdict: 'fail',
    reasoning: `Neither the legal name "${candidate.label}" nor any of its ${candidate.aliases.length} aliases carries the roster name.`,
  };
}

/**
 * The GLEIF exact-LEI join.
 *
 * **`unavailable` is not a failure.** Large private companies frequently have
 * no LEI at all, and refusing them on that basis would reject the right company
 * for a reason that has nothing to do with identity.
 */
function leiWitness(roster: RosterRow, candidate: CandidateFacts): DiscriminatorResult {
  if (!candidate.lei) {
    return {
      discriminator: 'lei_witness',
      verdict: 'unavailable',
      reasoning: 'This record carries no LEI. That is common for large private companies and is not evidence against it.',
    };
  }
  if (!candidate.gleif) {
    return {
      discriminator: 'lei_witness',
      verdict: 'unavailable',
      reasoning: `This record carries LEI ${candidate.lei}, but the GLEIF join has not been run against it.`,
    };
  }
  // GLEIF is the INDEPENDENT SECOND WITNESS on the roster's claim, so what it
  // has to corroborate is the ROSTER — not Sayari's arbitrary first address.
  //
  // This is worth stating because the first version of this check got it
  // backwards, and the failure was instructive: for the roster's own Bosch row,
  // GLEIF returned Gerlingen — the roster's city, exactly right — while Sayari
  // listed the record's first address as Abstatt. Comparing the two witnesses
  // against each other rejected the correct company on the strength of two
  // sources that were both telling the truth.
  const gleifCity = candidate.gleif.city;
  const agreesWithRoster = gleifCity && roster.address ? containsWholeWord(roster.address, gleifCity) : null;
  const agreesWithSayari = gleifCity
    ? candidate.addresses.some((a) => a.city && normaliseAddress(a.city).includes(normaliseAddress(gleifCity)))
    : null;

  if (agreesWithRoster) {
    return {
      discriminator: 'lei_witness',
      verdict: 'pass',
      reasoning: `GLEIF independently places LEI ${candidate.lei} ("${candidate.gleif.legalName}") in ${gleifCity}, which is the roster's own locality.`,
    };
  }
  if (agreesWithSayari) {
    return {
      discriminator: 'lei_witness',
      verdict: 'pass',
      reasoning: `GLEIF places LEI ${candidate.lei} ("${candidate.gleif.legalName}") in ${gleifCity}, which is one of this record's own addresses.`,
    };
  }
  if (gleifCity) {
    return {
      discriminator: 'lei_witness',
      verdict: 'fail',
      reasoning: `GLEIF places LEI ${candidate.lei} ("${candidate.gleif.legalName}") in ${gleifCity}, which matches neither the roster line nor any address on this record.`,
    };
  }
  return {
    discriminator: 'lei_witness',
    verdict: 'pass',
    reasoning: `GLEIF confirms LEI ${candidate.lei} as "${candidate.gleif.legalName}", though it records no city to place it in.`,
  };
}

/**
 * **The only check that rejects a correctly-addressed investment arm.**
 *
 * For a Supplier with no Category it degrades explicitly to *"is this an
 * operating company at all"* rather than passing silently — the degradation is
 * stated in the reasoning line, so a reader can see which question was asked.
 */
function businessPurpose(roster: RosterRow, candidate: CandidateFacts): DiscriminatorResult {
  const name = normaliseAddress(`${candidate.label} ${candidate.companyType ?? ''}`);
  const purpose = normaliseAddress(candidate.businessPurposes.join(' '));

  const nonOperatingInName = NON_OPERATING_MARKERS.filter((m) => name.includes(normaliseAddress(m)));
  const nonOperatingInPurpose = NON_OPERATING_MARKERS.filter((m) => purpose.includes(normaliseAddress(m)));
  const operating = OPERATING_MARKERS.filter((m) => `${name} ${purpose}`.includes(m));

  // The LEGAL NAME is decisive on its own. A company called "X Venture Capital
  // GmbH" is one, whatever else its purpose text mentions — and this is where
  // an earlier version of this check went wrong: an investment arm whose stated
  // purpose was "venture capital investment in TECHNOLOGY companies" was read
  // as operating, because "technolog" appeared. What it invests in is not what
  // it does.
  if (nonOperatingInName.length > 0) {
    return {
      discriminator: 'business_purpose',
      verdict: 'fail',
      reasoning: `Its own legal name reads as a non-operating entity (${nonOperatingInName.join(', ')}). The right building can hold the wrong company: a supplier of parts is not an investment or holding arm.`,
    };
  }
  if (nonOperatingInPurpose.length > 0 && operating.length === 0) {
    return {
      discriminator: 'business_purpose',
      verdict: 'fail',
      reasoning: `Its stated purpose reads as non-operating (${nonOperatingInPurpose.join(', ')}).`,
    };
  }
  if (candidate.businessPurposes.length === 0 && !candidate.companyType) {
    return {
      discriminator: 'business_purpose',
      verdict: 'unavailable',
      reasoning: roster.hasCategory
        ? 'This record states no business purpose or company type, so what it does cannot be checked against the category.'
        : 'This supplier bids on no category, so the question degrades to "is this an operating company at all" — and this record says nothing either way.',
    };
  }
  return {
    discriminator: 'business_purpose',
    verdict: 'pass',
    reasoning: roster.hasCategory
      ? `Reads as an operating company${operating.length > 0 ? ` (${operating.join(', ')})` : ''}, consistent with a parts supplier.`
      : `This supplier bids on no category, so the question is only whether this is an operating company at all — and it reads as one${operating.length > 0 ? ` (${operating.join(', ')})` : ''}.`,
  };
}

/** Is this record a live company, or a closed one still in the graph? */
function liveness(candidate: CandidateFacts): DiscriminatorResult {
  if (candidate.closed) {
    return {
      discriminator: 'liveness',
      verdict: 'fail',
      reasoning: `Sayari records this company as closed${candidate.latestStatus ? ` (${candidate.latestStatus})` : ''}.`,
    };
  }
  if (!candidate.latestStatus) {
    return {
      discriminator: 'liveness',
      verdict: 'unavailable',
      reasoning: 'This record carries no status, so whether it is still trading cannot be checked.',
    };
  }
  const dead = /dissolv|liquidat|struck off|deregist|cancelled|terminated|inactive/i.test(candidate.latestStatus);
  return {
    discriminator: 'liveness',
    verdict: dead ? 'fail' : 'pass',
    reasoning: dead
      ? `Its latest recorded status is "${candidate.latestStatus}".`
      : `Its latest recorded status is "${candidate.latestStatus}".`,
  };
}
