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
    /**
     * Those of them that are not also the company's own name — what the street
     * rung actually compares. See `compareAddress`.
     */
    distinctiveStreetTokens: string[];
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
  /**
   * The roster name's and the Candidate label's own significant tokens, so the
   * street rung can tell a street name from a company name. Already stripped of
   * legal forms by the caller — `discriminators.ts` passes what `name_cover`
   * itself reads, so the two cannot disagree about what a company is called.
   *
   * Omitted, nothing is dropped, which is what a caller comparing a bare
   * address with no company attached wants.
   */
  nameTokens?: readonly string[];
}): AddressComparison {
  if (args.addresses.length === 0) {
    return compareAddress({
      rosterAddress: args.rosterAddress,
      rosterCountry: args.rosterCountry,
      candidateCountry: null,
      candidateCity: null,
      candidatePostcode: null,
      candidateLine: null,
      nameTokens: args.nameTokens ?? [],
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
      nameTokens: args.nameTokens ?? [],
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

/**
 * Rung 3 — the street, extracted so `compareAddress` stays readable.
 *
 * Everything the rung needs and nothing else: the roster's tokens, the anchored
 * address's own city, postcode and line, the locality verdict it is subordinate
 * to, and the company's name tokens.
 */
function streetRung(args: {
  rosterTokens: readonly string[];
  city: string | null;
  postcode: string | null;
  line: string | null;
  locality: LadderVerdict;
  nameTokens?: readonly string[] | undefined;
}): {
  verdict: LadderVerdict;
  rosterStreetTokens: string[];
  distinctiveStreetTokens: string[];
  streetTokensMatched: string[];
} {
  /**
   * **Real tokens on both sides**, which this rung did not have until the
   * address line was carried alongside the city and the postcode. It used to
   * return whatever the locality returned, and say "street-level tokens agree"
   * when it passed — a sentence about a comparison that never happened.
   *
   * Both sides are the same subtraction: everything that is not the anchored
   * address's own city, its postcode, or a generic street word. What is left is
   * the house number and the street name, which is the only thing this rung was
   * ever meant to be about.
   */
  const cityTokens = new Set(tokens(args.city ?? ''));
  const postcodeTokens = new Set(tokens(args.postcode ?? ''));
  const streetward = (token: string) =>
    !cityTokens.has(token) && !postcodeTokens.has(token) && !STREET_STOPWORDS.has(token);

  const rosterStreetTokens = args.rosterTokens.filter(streetward);
  const addressStreetTokens = tokens(args.line ?? '').filter(streetward);

  /**
   * **A street named after the company is not evidence about the company.**
   *
   * Roster row 1 is `Robert-Bosch-Platz 1 70839 Gerlingen`. Subtract the city,
   * the postcode and the stopword `platz` and the "street-level tokens" are
   * `robert`, `bosch`, `1` — two thirds of which are the company's own name,
   * because the street is named after it. Any record whose address line
   * mentions Bosch then matched on the street rung, and one did.
   *
   * So a token that also appears in the roster name or in the Candidate's own
   * label is dropped before comparing — **unless it is a number**, because a
   * house number is a real street token whatever the company is called, and
   * `Gestamp 2020 SL` should not be able to spend the roster's house number.
   */
  const nameTokenSet = new Set(args.nameTokens ?? []);
  const distinctive = (token: string) => /^\d+$/.test(token) || !nameTokenSet.has(token);
  const distinctiveStreetTokens = rosterStreetTokens.filter(distinctive);

  const streetTokensMatched = distinctiveStreetTokens.filter((token) =>
    addressStreetTokens.includes(token),
  );

  // `unavailable` where either side offers nothing to compare — absent evidence
  // is not contrary evidence. Three ways that happens, and the third is new:
  // a roster line whose every street-level token is the company's own name has
  // not described a building, so no address can agree or disagree with it.
  const compared: LadderVerdict =
    rosterStreetTokens.length === 0 ||
    distinctiveStreetTokens.length === 0 ||
    addressStreetTokens.length === 0
      ? 'unavailable'
      : streetTokensMatched.length > 0
        ? 'pass'
        : 'fail';

  /**
   * **Street may never accept alone**, and this is where that stops being a
   * sentence in a reasoning line and becomes a rule.
   *
   * A street agrees only inside a town that agrees: `pass` requires `locality`
   * to be `pass` **on this same address**. A token match under a locality that
   * could not be read is not a building in common, it is a coincidence — and
   * because the anchor is chosen over the *whole* address set, it is a
   * coincidence with as many chances to fire as the record has addresses.
   *
   * Measured on row 1. Once the company's own name is dropped,
   * `Robert-Bosch-Platz 1` has exactly one distinctive token left — the bare
   * digit `1` — and an Indonesian trade record with **sixty-three** addresses
   * had one reading `JL. TMN. TEKNO V SEKTOR XI BLOK.A/1`, which tokenises to
   * include it. Locality was `unavailable` on that address and street was
   * `pass`: precisely a street claiming agreement on its own, and it cost the
   * right company a settlement it had earned on its own Gerlingen line.
   *
   * A computed `fail` is left alone. "This is a different building" is a claim
   * about the street and is not weakened by the town being unreadable, and
   * suppressing it would turn a Candidate that had been rejected into one that
   * had merely not been placed. The ceiling is on *agreement*, which is the
   * half that was dangerous.
   */
  const verdict: LadderVerdict =
    compared === 'pass' && args.locality !== 'pass' ? 'unavailable' : compared;

  return { verdict, rosterStreetTokens, distinctiveStreetTokens, streetTokensMatched };
}

/** Compares ONE address, whole. `compareAddresses` is what callers should use. */
export function compareAddress(args: {
  rosterAddress: string | null;
  rosterCountry: string | null;
  candidateCountry: string | null;
  candidateCity: string | null;
  candidatePostcode: string | null;
  candidateLine?: string | null;
  /** See `compareAddresses`. Omitted, no token is dropped as a company name. */
  nameTokens?: readonly string[];
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
  const {
    verdict: street,
    rosterStreetTokens,
    distinctiveStreetTokens,
    streetTokensMatched,
  } = streetRung({ rosterTokens, city, postcode, line, locality, nameTokens: args.nameTokens });

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
      distinctiveStreetTokens,
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
