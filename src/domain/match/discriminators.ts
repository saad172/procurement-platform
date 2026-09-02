import { countryName, isCountryWord, jurisdictionToAlpha3 } from '@/domain/iso3166';
import {
  compareAddresses,
  type AddressComparison,
  containsWholeWord,
  isUnreadableScript,
  normaliseAddress,
  normaliseCountryToIso3,
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
   *
   * `jurisdiction` is the field that does the work. It is where the LEI is
   * *registered* — `TH` for a Thai company, `US-DE` for a Delaware corporation
   * — and it is the only one of these a subsidiary cannot borrow from its
   * parent. `hqCity` is projected and was never read until the LEI witness
   * started needing it: GLEIF puts `AMERICAN AXLE & MANUFACTURING, INC.`'s
   * legal address in Wilmington and its headquarters in Detroit, and the
   * roster line says Detroit.
   */
  gleif?:
    | {
        legalName: string | null;
        jurisdiction: string | null;
        legalCity: string | null;
        legalCountry: string | null;
        hqCity: string | null;
      }
    | undefined;
  /**
   * The **current upward owners** named in this record's own payload — the
   * companies that own it, never the ones it owns (`ownersOf`,
   * `src/domain/parse-relationships.ts`).
   *
   * `name_cover` reads them. A Candidate whose legal name covers the roster
   * name and is owned by another company that *also* covers it is a member of
   * the family, and which member the roster meant is not something the name can
   * settle (SPEC §6.7 — the group parent is recorded through the ownership hop).
   */
  owners: { entityId: string; label: string | null }[];
  /**
   * Sayari returned fewer relationships than it counted for this record.
   *
   * An owner absent from a truncated window is not an absent owner, and
   * `name_cover` says so rather than passing silently on a window it knows was
   * cut short.
   */
  relationshipsTruncated: boolean;
};

/** Words a legal name carries that say nothing about which company it is. */
const LEGAL_FORMS = new Set([
  'gmbh',
  'ag',
  'kg',
  'kgaa',
  'se',
  'mbh',
  'co',
  'ltd',
  'limited',
  'plc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'llc',
  'lp',
  'sa',
  'sas',
  'sarl',
  'spa',
  'srl',
  'bv',
  'nv',
  'ab',
  'as',
  'oy',
  'kk',
  'kabushiki',
  'kaisha',
  'pte',
  'pty',
  'sdn',
  'bhd',
  'de',
  'cv',
  'sl',
  'the',
  'and',
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
  'venture',
  'ventures',
  'capital',
  'investment',
  'investments',
  'holding',
  'holdings',
  'beteiligung',
  'beteiligungen',
  'finance',
  'financing',
  'treasury',
  'insurance',
  'pension',
  'trust',
  'foundation',
  'stiftung',
  'real estate',
  'immobilien',
  'property',
  'properties',
  'leasing',
];

const OPERATING_MARKERS = [
  'manufactur',
  'produktion',
  'production',
  'works',
  'werk',
  'factory',
  'industri',
  'engineering',
  'technolog',
  'automotive',
  'systems',
  'components',
  'electronics',
  'machinery',
  'assembly',
  'plant',
];

/** Runs all eight against one Candidate. Order matches DISCRIMINATOR_NAMES. */
export function runDiscriminators(
  roster: RosterRow,
  candidate: CandidateFacts,
): DiscriminatorResult[] {
  const address = compareAddresses({
    rosterAddress: roster.address,
    rosterCountry: roster.country,
    addresses: candidate.addresses,
    // What `name_cover` itself reads, so the street rung and the name rung
    // cannot disagree about which words are the company's name. Row 1's street
    // is `Robert-Bosch-Platz`, and two of its three street-level tokens are the
    // company.
    nameTokens: nameTokensOf(roster, candidate),
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

/**
 * Every significant token of the roster name and of the Candidate's own label.
 *
 * Handed to the address ladder so its street rung can drop the company's name
 * from the roster's "street-level" tokens. Both sides are needed: the roster
 * name is what the street is named after, and the Candidate's label is what its
 * address line repeats.
 *
 * Exported because `settledEvidenceFor` (`src/jobs/resolve.ts`) re-runs the
 * ladder to find the anchored address, and it has to ask the same function the
 * same question or it can anchor on a different address than the Discriminators
 * did — which would score the Match on a country no rung ever agreed with.
 */
export function nameTokensOf(roster: RosterRow, candidate: CandidateFacts): string[] {
  return [...significantTokens(roster.name), ...significantTokens(candidate.label)];
}

function countryDiscriminator(
  address: AddressComparison,
  candidate: CandidateFacts,
): DiscriminatorResult {
  const {
    candidateCountry,
    rosterCountry,
    candidateCity,
    matchedAddressIndex,
    addressesConsidered,
  } = address.evidence;
  // Which address was read, since all three rungs now read the same one.
  const which =
    addressesConsidered > 1
      ? ` (the address this record files at ${candidateCity ?? 'an unnamed place'}, ${matchedAddressIndex! + 1} of ${addressesConsidered})`
      : '';
  return {
    discriminator: 'country',
    verdict: address.country,
    reasoning:
      address.country === 'pass'
        ? `The recorded address the roster line agrees with most is in ${candidateCountry}, which is the roster's country${which}.`
        : address.country === 'fail'
          ? `The recorded address the roster line agrees with most is in ${candidateCountry}, but the roster says ${rosterCountry}. ${candidate.label} is in a different country.`
          : 'No country to compare on one side or the other.',
  };
}

function localityDiscriminator(address: AddressComparison): DiscriminatorResult {
  const { candidateCity, candidatePostcode, postcodeMatched, addressesConsidered } =
    address.evidence;
  const across =
    addressesConsidered > 1
      ? ` — the one of ${addressesConsidered} recorded addresses that agrees with the roster line best, and the one every rung here reads`
      : '';
  return {
    discriminator: 'locality',
    verdict: address.locality,
    reasoning:
      address.locality === 'pass'
        ? postcodeMatched
          ? `The roster line contains the postcode ${candidatePostcode}, which is a strong signal on its own${across}.`
          : `The roster line contains "${candidateCity}" as a whole word${across}.`
        : address.locality === 'fail'
          ? `The roster line names neither "${candidateCity ?? '?'}" nor ${candidatePostcode ?? 'any postcode of this record'}${across}.`
          : 'This address carries no city or postcode this build can read against the roster line.',
  };
}

/**
 * **Street may never accept alone**, and the reasoning line says so every time
 * it passes — because the one place this check is dangerous is exactly where it
 * looks most convincing.
 *
 * It compares the roster line's own street-level tokens against **the anchored
 * address's** — the same address the country and locality rungs read. Until
 * this was written it compared nothing at all: it returned whatever the
 * locality returned and reported "street-level tokens agree", which was a
 * sentence about a comparison that had not happened.
 */
function streetDiscriminator(address: AddressComparison): DiscriminatorResult {
  const { streetTokensMatched, rosterStreetTokens, distinctiveStreetTokens, candidateLine } =
    address.evidence;
  return {
    discriminator: 'street',
    verdict: address.street,
    reasoning:
      address.street === 'pass'
        ? `The roster line and "${candidateLine}" share the street-level tokens ${streetTokensMatched
            .slice(0, 4)
            .map((t) => `"${t}"`)
            .join(
              ', ',
            )}. This is never sufficient alone: an investment arm often sits at its parent's exact address.`
        : address.street === 'fail'
          ? `"${candidateLine}" carries none of the roster line's street-level tokens (${distinctiveStreetTokens.slice(0, 4).join(', ')}), so this is a different building in the same place.`
          : streetTokensMatched.length > 0
            ? `"${candidateLine}" does share the roster line's street-level token${streetTokensMatched.length === 1 ? '' : 's'} ${streetTokensMatched
                .slice(0, 4)
                .map((t) => `"${t}"`)
                .join(
                  ', ',
                )}, but the locality does not agree on this address, so that is a coincidence rather than a building in common. Street may never accept alone.`
            : rosterStreetTokens.length === 0
              ? 'The roster line carries no street-level tokens beyond the city and the postcode.'
              : distinctiveStreetTokens.length === 0
                ? `The roster's street is named after the company itself (${rosterStreetTokens.slice(0, 4).join(', ')}), so its street-level tokens say nothing about which building this is.`
                : 'This address has no line to read a street from, so there is nothing to compare.',
  };
}

/**
 * Does the roster name's substance appear in the candidate's legal name — and
 * does the candidate's name add something that says *a different company*?
 *
 * ## Cover is one-sided, and the missing side is where subsidiaries live
 *
 * This check used to ask only whether the roster's words were all present.
 * Every member of a corporate family passes that question: `MAHLE BEHR GMBH &
 * CO. KG` contains `Mahle`, `SAMVARDHANA MOTHERSON ADSYS TECH LIMITED` contains
 * `Samvardhana Motherson`, and `American Axle & Manufacturing (Thailand) Co.,
 * Ltd.` contains every word of `American Axle & Manufacturing`. Three of the
 * four Matches this build settled by rules onto a subsidiary passed here.
 *
 * So the **surplus** — the candidate's words the roster does not have — is now
 * read too, and the verdict it produces is `unavailable` rather than `fail`:
 * extra words are a reason to look, not proof of the wrong company. `Robert
 * Bosch GmbH` has a surplus of `robert` against a roster reading `Bosch`, and
 * it is the right answer.
 *
 * Two things separate a family member from a fuller legal name:
 *
 * 1. **A marker** — a number, a parenthesised aside, or a country, nationality
 *    or region word. `(Thailand)`, `2020`, `de Mexico`. These are how a group
 *    names its subsidiaries, and they are almost never part of a parent's own
 *    legal name.
 * 2. **A current upward owner that answers to the roster name as well.** If
 *    this record is owned by another company whose own label covers the roster
 *    name, the roster names at least two candidates and the name cannot say
 *    which. The owner has to be an operating company for this to bite —
 *    `Robert Bosch GmbH` is owned by `Robert Bosch Stiftung`, and a foundation
 *    holding a manufacturer is the ownership hop working, not an ambiguity
 *    (SPEC §6.7).
 */
function nameCover(roster: RosterRow, candidate: CandidateFacts): DiscriminatorResult {
  const verdict = (verdict: LadderVerdict, reasoning: string): DiscriminatorResult => ({
    discriminator: 'name_cover',
    verdict,
    reasoning,
  });

  const rosterSignificant = significantTokens(roster.name);
  if (rosterSignificant.length === 0) {
    return verdict(
      'unavailable',
      'The roster name is only legal-form words, so there is nothing to cover.',
    );
  }

  const candidateSignificant = significantTokens(candidate.label);
  if (candidateSignificant.length === 0) {
    // A label written in a script this build strips to nothing is not a label
    // that disagrees. Measured: the Sayari record carrying MAHLE GmbH's own LEI
    // is labelled 马勒有限公司, and reading that as "shares almost nothing with
    // Mahle" rejected the right company for being written in Chinese.
    return verdict(
      'unavailable',
      `"${candidate.label}" is not in a script this comparison can read, so its name neither covers nor contradicts "${roster.name}".`,
    );
  }

  const covered = rosterSignificant.filter((token) => candidateSignificant.includes(token));
  const ratio = covered.length / rosterSignificant.length;
  if (ratio < 1) {
    return ratio >= 0.5
      ? verdict(
          'unavailable',
          `"${candidate.label}" contains ${covered.length} of ${rosterSignificant.length} substantive words of "${roster.name}" — partial cover, which settles nothing either way.`,
        )
      : verdict(
          'fail',
          `"${candidate.label}" shares almost nothing with "${roster.name}" (${covered.length} of ${rosterSignificant.length} substantive words).`,
        );
  }

  const surplus = candidateSignificant.filter((token) => !rosterSignificant.includes(token));
  if (surplus.length === 0) {
    return verdict(
      'pass',
      `"${candidate.label}" is "${roster.name}" and nothing else — every substantive word on each side is on the other.`,
    );
  }

  const marker = firstMarker(candidate.label, surplus);
  if (marker) {
    return verdict(
      'unavailable',
      `"${candidate.label}" covers "${roster.name}" and adds ${marker.quoted}, which is ${marker.why}. That is how a group names a member of its family, so the name alone cannot say this is the company the roster meant.`,
    );
  }

  const owner = ownerAnsweringToRosterName(candidate, rosterSignificant);
  if (owner) {
    return verdict(
      'unavailable',
      `"${candidate.label}" covers "${roster.name}", and so does its current owner ${owner}. The roster name fits both, so it cannot choose between them — the group parent belongs on the ownership hop, not in the Match.`,
    );
  }

  const surplusList = surplus.map((token) => `"${token}"`).join(', ');
  return candidate.relationshipsTruncated
    ? verdict(
        'pass',
        `"${candidate.label}" contains every substantive word of "${roster.name}", adding only ${surplusList}. No current owner of this record answers to the roster name either — though Sayari returned fewer relationships than it counted, so that window is not complete.`,
      )
    : verdict(
        'pass',
        `"${candidate.label}" contains every substantive word of "${roster.name}", adding only ${surplusList}, and no current owner of this record answers to the roster name.`,
      );
}

/**
 * The first surplus token that marks this as a member of a family rather than
 * the company itself, with the words to say why.
 */
function firstMarker(
  label: string,
  surplus: readonly string[],
): { quoted: string; why: string } | undefined {
  const parenthesised = new Map<string, string>();
  for (const group of label.matchAll(/\(([^)]*)\)/g)) {
    for (const token of tokens(group[1] ?? '')) parenthesised.set(token, `"(${group[1]!.trim()})"`);
  }

  for (const token of surplus) {
    if (parenthesised.has(token)) {
      return { quoted: parenthesised.get(token)!, why: 'a parenthesised aside' };
    }
    if (/^\d+$/.test(token)) {
      return { quoted: `"${token}"`, why: 'a bare number' };
    }
    if (isCountryWord(token)) {
      return { quoted: `"${token}"`, why: 'a country, nationality or region' };
    }
  }
  return undefined;
}

/**
 * A current upward owner of this record whose own label also covers the roster
 * name, excluding the non-operating ones.
 *
 * The exclusion is what keeps `Robert Bosch GmbH` passing: a `Stiftung` owning
 * a manufacturer is a foundation holding shares, not a second company competing
 * for the same roster row. The list is `business_purpose`'s, reused rather than
 * copied, because "this is not an operating company" is one judgement and it
 * should not be able to differ between two checks.
 */
function ownerAnsweringToRosterName(
  candidate: CandidateFacts,
  rosterSignificant: readonly string[],
): string | undefined {
  for (const owner of candidate.owners) {
    if (!owner.label) continue;
    const ownerTokens = significantTokens(owner.label);
    if (ownerTokens.length === 0) continue;
    if (!rosterSignificant.every((token) => ownerTokens.includes(token))) continue;
    const ownerName = normaliseAddress(owner.label);
    if (NON_OPERATING_MARKERS.some((marker) => ownerName.includes(normaliseAddress(marker)))) {
      continue;
    }
    return `"${owner.label}"`;
  }
  return undefined;
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
      reasoning:
        'The roster name is only legal-form words, so there is no name to place in context.',
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
  // A record whose legal name and every alias are written in a script this
  // build strips to nothing has not contradicted the roster name; it has said
  // nothing this comparison can hear. `fail` there is the same mistake
  // `name_cover` was making on the Chinese-labelled MAHLE GmbH record.
  if (
    significantTokens(candidate.label).length === 0 &&
    candidate.aliases.every((alias) => significantTokens(alias).length === 0)
  ) {
    return {
      discriminator: 'alias_context',
      verdict: 'unavailable',
      reasoning: `Neither the legal name "${candidate.label}" nor any of its ${candidate.aliases.length} aliases is in a script this comparison can read, so where the roster name sits on this record cannot be told.`,
    };
  }
  return {
    discriminator: 'alias_context',
    verdict: 'fail',
    reasoning: `Neither the legal name "${candidate.label}" nor any of its ${candidate.aliases.length} aliases carries the roster name.`,
  };
}

/**
 * The GLEIF exact-LEI join — **the independent second witness on the ROSTER's
 * claim**, and on nothing else.
 *
 * **`unavailable` is not a failure.** Large private companies frequently have
 * no LEI at all, and refusing them on that basis would reject the right company
 * for a reason that has nothing to do with identity.
 *
 * ## What it corroborates, and the fallback that was quietly cancelling it
 *
 * Finding 13 established the direction: GLEIF has to corroborate the **roster**,
 * not Sayari's arbitrary first address — measured on row 1, where the roster
 * says Gerlingen, GLEIF says Gerlingen, and Sayari's first address says
 * Abstatt. Comparing the two witnesses against each other rejected the correct
 * company on the strength of two sources both telling the truth.
 *
 * The fix carried a second clause: pass when GLEIF's city matches *any address
 * on the Sayari record*. That clause proves the LEI belongs to the record — a
 * thing the exact-LEI join has already established — and proves nothing about
 * the roster. It is gone. What is left is two questions the roster can answer:
 *
 * 1. **Jurisdiction.** Where the LEI is registered, against the roster's
 *    country. This is the field a subsidiary cannot borrow: GLEIF lists
 *    `American Axle & Manufacturing (Thailand) Co., Ltd.`'s headquarters as
 *    **Detroit** — the parent's — while its jurisdiction reads `TH`. A
 *    subdivision code is its country, so `US-DE` is the United States (SPEC
 *    §6.2, `src/domain/iso3166.ts`).
 * 2. **City.** GLEIF's legal-address city **or** its headquarters city, in the
 *    roster line. Either will do, and the headquarters one is not optional
 *    politeness: `AMERICAN AXLE & MANUFACTURING, INC.` is a Delaware
 *    corporation whose GLEIF legal address is Wilmington, and Detroit — the
 *    roster's own city — is only in the headquarters field.
 */
function leiWitness(roster: RosterRow, candidate: CandidateFacts): DiscriminatorResult {
  const verdict = (verdict: LadderVerdict, reasoning: string): DiscriminatorResult => ({
    discriminator: 'lei_witness',
    verdict,
    reasoning,
  });

  if (!candidate.lei) {
    return verdict(
      'unavailable',
      'This record carries no LEI. That is common for large private companies and is not evidence against it.',
    );
  }
  if (!candidate.gleif) {
    return verdict(
      'unavailable',
      `This record carries LEI ${candidate.lei}, but the GLEIF join has not been run against it.`,
    );
  }

  const gleif = candidate.gleif;
  const named = `LEI ${candidate.lei} ("${gleif.legalName}")`;
  const jurisdiction = jurisdictionToAlpha3(gleif.jurisdiction);
  const rosterCountry = roster.country ? normaliseCountryToIso3(roster.country) : null;

  if (!jurisdiction) {
    return verdict(
      'unavailable',
      `GLEIF records no jurisdiction this build can place for ${named}${gleif.jurisdiction ? ` (it reads "${gleif.jurisdiction}")` : ''}, so there is no second witness on where this company is registered.`,
    );
  }
  if (!rosterCountry) {
    return verdict(
      'unavailable',
      `GLEIF registers ${named} in ${countryName(jurisdiction) ?? jurisdiction}, but the roster row names no country to corroborate.`,
    );
  }
  if (jurisdiction !== rosterCountry) {
    return verdict(
      'fail',
      `GLEIF registers ${named} in ${countryName(jurisdiction) ?? jurisdiction} (jurisdiction "${gleif.jurisdiction}"), and the roster row is in ${countryName(rosterCountry) ?? rosterCountry}. Whatever addresses this record files, its LEI belongs to another country's register.`,
    );
  }

  // The roster line and GLEIF's cities, keeping only what this build can read.
  // A city in a script that normalises to nothing is an unread field, not a
  // contradicted one — the same rule the locality rung follows.
  const cities = [
    { where: 'legal address', city: gleif.legalCity },
    { where: 'headquarters', city: gleif.hqCity },
  ].filter(
    (c): c is { where: string; city: string } => Boolean(c.city) && !isUnreadableScript(c.city),
  );

  if (!roster.address || cities.length === 0) {
    return verdict(
      'unavailable',
      `GLEIF registers ${named} in ${countryName(jurisdiction) ?? jurisdiction}, which is the roster's country — but ${!roster.address ? 'the roster row carries no address line' : `it records no city this comparison can read (${[gleif.legalCity, gleif.hqCity].filter(Boolean).join(', ') || 'none at all'})`}, so it can corroborate no further.`,
    );
  }

  const hit = cities.find((c) => containsWholeWord(roster.address!, c.city));
  if (hit) {
    return verdict(
      'pass',
      `GLEIF independently registers ${named} in ${countryName(jurisdiction) ?? jurisdiction} and places its ${hit.where} in ${hit.city}, which is the roster's own locality.`,
    );
  }
  return verdict(
    'fail',
    `GLEIF registers ${named} in ${countryName(jurisdiction) ?? jurisdiction}, but places it in ${cities.map((c) => `${c.city} (${c.where})`).join(' and ')} — and the roster line names neither.`,
  );
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

  const nonOperatingInName = NON_OPERATING_MARKERS.filter((m) =>
    name.includes(normaliseAddress(m)),
  );
  const nonOperatingInPurpose = NON_OPERATING_MARKERS.filter((m) =>
    purpose.includes(normaliseAddress(m)),
  );
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
  const dead = /dissolv|liquidat|struck off|deregist|cancelled|terminated|inactive/i.test(
    candidate.latestStatus,
  );
  return {
    discriminator: 'liveness',
    verdict: dead ? 'fail' : 'pass',
    reasoning: dead
      ? `Its latest recorded status is "${candidate.latestStatus}".`
      : `Its latest recorded status is "${candidate.latestStatus}".`,
  };
}
