import { toAlpha3 } from '@/domain/iso3166';

/**
 * Address agreement, as a **three-rung ladder** (SPEC §6.2).
 *
 * country → locality → street, by **whole-word containment** of Sayari's
 * structured `city` / `postcode` inside the roster's normalised free-text line,
 * with postcode as its own strong signal.
 *
 * **There is deliberately no address parser.** libpostal needs a ~2 GB download
 * in the container, and the lightweight JS parsers are US-only against a roster
 * that is 42/50 non-US. The false positive a parser would buy out —
 * `Stuttgarter Straße` containing `Stuttgart` — is a town-level error that
 * whole-word matching already kills, which is the whole argument: the parser
 * would cost two orders of magnitude more than the problem it solves.
 *
 * The ladder's rungs are **not equal**. Street agreement may never accept a
 * Match alone, because an investment arm sits at the exact roster address of
 * its parent. That rule lives in the Discriminators; this module only reports
 * what agrees.
 */

/**
 * Lower-cases, strips punctuation, folds diacritics, and collapses whitespace.
 *
 * Diacritic folding matters on this roster: `Löwentaler Straße` must match
 * `Lowentaler Strasse`, and `Việt Nam` must match `Viet Nam`.
 */
export function normaliseAddress(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      // ß folds to ss rather than to s, which NFD does not do.
      .replace(/ß/g, 'ss')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Tokens, for whole-word containment. */
export function tokens(text: string): string[] {
  return normaliseAddress(text).split(' ').filter(Boolean);
}

/**
 * **Whole-word containment**, not substring containment.
 *
 * This one function is what makes the parser unnecessary: `Stuttgart` is not a
 * token of `stuttgarter strasse 12`, so the town-level false positive that
 * motivates a parser never fires.
 */
export function containsWholeWord(haystack: string, needle: string): boolean {
  const needleTokens = tokens(needle);
  if (needleTokens.length === 0) return false;
  const haystackTokens = tokens(haystack);
  // A multi-word needle must appear as a contiguous run, so "new york" does not
  // match an address containing "new" and "york" separately.
  for (let i = 0; i <= haystackTokens.length - needleTokens.length; i += 1) {
    if (needleTokens.every((token, j) => haystackTokens[i + j] === token)) return true;
  }
  return false;
}

export type LadderVerdict = 'pass' | 'fail' | 'unavailable';

/**
 * One of a candidate's addresses.
 *
 * **A company has many.** Bosch's Sayari record carries nineteen, and Gerlingen
 * — the roster's city — is the twelfth. Comparing only the first is how a
 * correct company gets rejected for being registered somewhere it also is.
 */
export type CandidateAddress = {
  city: string | null;
  postcode: string | null;
  country: string | null;
  /**
   * The whole address as one line, where the record carries one — Sayari's
   * `properties.value`, present on all 1,843 address entries measured in the
   * local corpus.
   *
   * The street rung needs it. `city` and `postcode` say *which town*; only the
   * line says *which building*, and without it the street rung had nothing of
   * its own to compare and mirrored the locality instead.
   */
  line?: string | null;
};

export type AddressComparison = {
  country: LadderVerdict;
  locality: LadderVerdict;
  street: LadderVerdict;
  /** What each rung actually compared, so the reasoning line can quote it. */
  evidence: {
    rosterLine: string | null;
    rosterCountry: string | null;
    candidateCountry: string | null;
    candidateCity: string | null;
    candidatePostcode: string | null;
    /** The anchored address's own line, which the street rung read. */
    candidateLine: string | null;
    postcodeMatched: boolean;
    /** The roster's street-level tokens the anchored address also carries. */
    streetTokensMatched: string[];
    /** Every street-level token the roster line offered, matched or not. */
    rosterStreetTokens: string[];
    /** How many addresses were considered, and which one all three rungs read. */
    addressesConsidered: number;
    matchedAddressIndex: number | null;
  };
};

/** A number-and-name token, e.g. `platz`, `strasse`, `1`. Street-level signal. */
const STREET_STOPWORDS = new Set([
  'strasse',
  'str',
  'street',
  'st',
  'road',
  'rd',
  'avenue',
  'ave',
  'platz',
  'place',
  'way',
  'lane',
  'drive',
  'dr',
  'chome',
  'cho',
  'ku',
  'shi',
  'gu',
  'dong',
  'ro',
  'gil',
  'calle',
  'avenida',
  'rue',
  'via',
  'no',
  'building',
]);

/**
 * Whether text was written and nothing survived normalisation.
 *
 * `normaliseAddress` deletes every character outside `[a-z0-9]`, so a CJK,
 * Cyrillic, Arabic or Thai string reduces to the empty string — indistinguishable,
 * to every check downstream, from a field the record never filled in. The two
 * are **not** the same thing, and the difference decides a verdict: a comparison
 * against a script this build cannot read is `unavailable`, because absent
 * evidence is not contrary evidence. It is `fail` only when both sides are
 * legible and disagree.
 */
export function isUnreadableScript(text: string | null | undefined): boolean {
  return Boolean(text && text.trim().length > 0 && tokens(text).length === 0);
}

/**
 * Strips a leading country prefix from a postcode: `D-70376` → `70376`,
 * `PIN-110044` → `110044`, `D 7000` → `7000`.
 *
 * Measured on the roster's own rows: the real MAHLE GmbH records file
 * `D-70376` where the Mahle roster line reads `70376`, so the postcode signal
 * — the one the ladder calls strong in its own right — was thrown away on the
 * correct company and kept on a subsidiary that happened to file a bare number.
 *
 * Only a run of one to three letters followed by a separator is stripped, and
 * only when digits remain, so `SW1A 1AA`, `AL7 1TW` and `NA70469` are left
 * exactly as they arrived.
 */
export function normalisePostcode(value: string): string {
  const match = /^\s*[A-Za-z]{1,3}[-\s]\s*(.+)$/.exec(value.trim());
  const remainder = match?.[1]?.trim();
  return remainder && /\d/.test(remainder) ? remainder : value.trim();
}

/**
 * Strips a trailing postal-district number from a city: `Stuttgart 50` →
 * `Stuttgart`.
 *
 * The old German postal districts are still in the register data, and
 * `containsWholeWord` needs its needle contiguous — so `Stuttgart 50` did not
 * match a roster line reading `Stuttgart`, and the locality rung failed the
 * right company for carrying more precision than the roster did.
 */
export function normaliseCityName(value: string): string {
  const match = /^(.*[A-Za-z].*?)\s+\d{1,3}$/.exec(value.trim());
  return match?.[1]?.trim() ?? value.trim();
}

/**
 * Compares the roster line against every address the candidate carries and
 * **anchors on one of them** — the best-matching — reporting all three rungs
 * from that single address.
 *
 * ## Why one address rather than the best of each rung
 *
 * This function used to score every rung over the whole set and keep the
 * maximum of each independently. That is what a subsidiary needs to pass: it
 * files its parent's headquarters alongside its own works, so the country rung
 * agreed on one address, the locality rung on another, and nothing ever asked
 * whether they were the same place. Measured on the roster: `American Axle &
 * Manufacturing (Thailand) Co., Ltd.` passed country, locality *and* street
 * against a Detroit roster row, because one of its three recorded addresses is
 * `1 DAUCH DRIVE, DETROIT` — the parent's.
 *
 * Finding 12 is untouched by this. A company registered in nineteen places is
 * in all nineteen, and the roster's city being the twelfth is still agreement.
 * What changed is that the *whole verdict* now comes from the twelfth, so what
 * the three rungs describe is one building rather than a company-shaped union
 * of buildings.
 */
export function compareAddresses(args: {
  rosterAddress: string | null;
  rosterCountry: string | null;
  addresses: readonly CandidateAddress[];
}): AddressComparison {
  if (args.addresses.length === 0) {
    return compareAddress({
      rosterAddress: args.rosterAddress,
      rosterCountry: args.rosterCountry,
      candidateCountry: null,
      candidateCity: null,
      candidatePostcode: null,
      candidateLine: null,
    });
  }

  // Country first and heaviest: an address in the wrong country is the wrong
  // building whatever else agrees. `unavailable` outranks `fail` for the same
  // reason it does everywhere else here.
  const rank = (c: AddressComparison) =>
    (c.country === 'pass' ? 8 : c.country === 'unavailable' ? 2 : 0) +
    (c.locality === 'pass' ? 4 : c.locality === 'unavailable' ? 1 : 0) +
    (c.street === 'pass' ? 2 : 0);

  let best: AddressComparison | undefined;
  let bestIndex = 0;
  args.addresses.forEach((address, index) => {
    const comparison = compareAddress({
      rosterAddress: args.rosterAddress,
      rosterCountry: args.rosterCountry,
      candidateCountry: address.country,
      candidateCity: address.city,
      candidatePostcode: address.postcode,
      candidateLine: address.line ?? null,
    });
    if (!best || rank(comparison) > rank(best)) {
      best = comparison;
      bestIndex = index;
    }
  });

  return {
    ...best!,
    evidence: {
      ...best!.evidence,
      addressesConsidered: args.addresses.length,
      // The address every rung above read, agreeing or not — so a reader can
      // ask which building was compared rather than inferring it.
      matchedAddressIndex: bestIndex,
    },
  };
}

/** Compares ONE address, whole. `compareAddresses` is what callers should use. */
export function compareAddress(args: {
  rosterAddress: string | null;
  rosterCountry: string | null;
  candidateCountry: string | null;
  candidateCity: string | null;
  candidatePostcode: string | null;
  candidateLine?: string | null;
}): AddressComparison {
  const roster = args.rosterAddress ?? '';
  const rosterTokens = tokens(roster);

  const city = args.candidateCity ? normaliseCityName(args.candidateCity) : null;
  const postcode = args.candidatePostcode ? normalisePostcode(args.candidatePostcode) : null;
  const line = args.candidateLine ?? null;

  // ── Rung 1: country ──────────────────────────────────────────────────────
  const country: LadderVerdict =
    !args.rosterCountry || !args.candidateCountry
      ? 'unavailable'
      : sameCountry(args.rosterCountry, args.candidateCountry)
        ? 'pass'
        : 'fail';

  // ── Rung 2: locality — the city name, or the postcode as its own signal ──
  const cityMatched = city ? containsWholeWord(roster, city) : false;
  const postcodeMatched = postcode ? containsWholeWord(roster, postcode) : false;
  // Nothing on one side to compare, or nothing legible on it: a record whose
  // city is written in a script this build strips to nothing is not a record
  // asserting a different city.
  const nothingComparable =
    (!city && !postcode) ||
    rosterTokens.length === 0 ||
    (tokens(city ?? '').length === 0 && tokens(postcode ?? '').length === 0);
  const locality: LadderVerdict = nothingComparable
    ? 'unavailable'
    : cityMatched || postcodeMatched
      ? 'pass'
      : 'fail';

  // ── Rung 3: street ───────────────────────────────────────────────────────
  //
  // **Real tokens on both sides**, which this rung did not have until the
  // address line was carried alongside the city and the postcode. It used to
  // return whatever the locality returned, and say "street-level tokens agree"
  // when it passed — a sentence about a comparison that never happened.
  //
  // Both sides are the same subtraction: everything that is not the anchored
  // address's own city, its postcode, or a generic street word. What is left is
  // the house number and the street name, which is the only thing this rung was
  // ever meant to be about.
  const cityTokens = new Set(tokens(city ?? ''));
  const postcodeTokens = new Set(tokens(postcode ?? ''));
  const streetward = (token: string) =>
    !cityTokens.has(token) && !postcodeTokens.has(token) && !STREET_STOPWORDS.has(token);

  const rosterStreetTokens = rosterTokens.filter(streetward);
  const addressStreetTokens = tokens(line ?? '').filter(streetward);
  const streetTokensMatched = rosterStreetTokens.filter((token) =>
    addressStreetTokens.includes(token),
  );

  // `unavailable` where either side offers no street-level token at all —
  // absent evidence is not contrary evidence, and a record with no address line
  // is not a record claiming a different street.
  const street: LadderVerdict =
    rosterStreetTokens.length === 0 || addressStreetTokens.length === 0
      ? 'unavailable'
      : streetTokensMatched.length > 0
        ? 'pass'
        : 'fail';

  return {
    country,
    locality,
    street,
    evidence: {
      rosterLine: args.rosterAddress,
      rosterCountry: args.rosterCountry,
      candidateCountry: args.candidateCountry,
      candidateCity: args.candidateCity,
      candidatePostcode: args.candidatePostcode,
      candidateLine: line,
      postcodeMatched,
      streetTokensMatched,
      rosterStreetTokens,
      addressesConsidered: 1,
      matchedAddressIndex: 0,
    },
  };
}

/**
 * ISO3 where the value is a current country code or a name the ISO table
 * places; `null` where it cannot be told apart from an arbitrary string.
 *
 * The single normaliser `sameCountry()` (below), the settled-country derivation
 * (`src/domain/match/settle-match.ts`) and the LEI witness all reuse, so a
 * roster spelling either they all agree is ISO3 or none of them does. It used
 * to carry a seventeen-entry alias table of its own; that table is now
 * `src/domain/iso3166.ts`, complete, because the LEI witness needs GLEIF's
 * jurisdiction placed and `name_cover` needs country words recognised, and
 * three private copies of the same knowledge is how they drift.
 */
export function normaliseCountryToIso3(value: string): string | null {
  return toAlpha3(value) ?? null;
}

export function sameCountry(a: string, b: string): boolean {
  const canon = (value: string) => normaliseCountryToIso3(value) ?? value.trim().toUpperCase();
  return canon(a) === canon(b);
}
