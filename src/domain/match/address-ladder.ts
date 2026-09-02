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
    postcodeMatched: boolean;
    streetTokensMatched: string[];
    /** How many addresses were considered, and which one agreed. */
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
 * Compares one Candidate's structured address against the roster's free text.
 *
 * `unavailable` where the Candidate has nothing to compare — which is a
 * distinct verdict from `fail`, and matters because a Sayari record with no
 * structured city is not evidence that the city is wrong.
 */
/**
 * Compares the roster line against **every** address the candidate carries, and
 * reports the best agreement found.
 *
 * The ladder is per address; the verdict is over the set. A company registered
 * in nineteen places is in all nineteen, so finding the roster's city among
 * them is agreement — and *not* finding it in the arbitrary first one is not
 * disagreement.
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
    });
  }

  const rank = (c: AddressComparison) =>
    (c.country === 'pass' ? 4 : c.country === 'unavailable' ? 1 : 0) +
    (c.locality === 'pass' ? 2 : 0) +
    (c.street === 'pass' ? 1 : 0);

  let best: AddressComparison | undefined;
  let bestIndex = 0;
  args.addresses.forEach((address, index) => {
    const comparison = compareAddress({
      rosterAddress: args.rosterAddress,
      rosterCountry: args.rosterCountry,
      candidateCountry: address.country,
      candidateCity: address.city,
      candidatePostcode: address.postcode,
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
      matchedAddressIndex: best!.locality === 'pass' ? bestIndex : null,
    },
  };
}

/** Compares one address. `compareAddresses` is what callers should use. */
export function compareAddress(args: {
  rosterAddress: string | null;
  rosterCountry: string | null;
  candidateCountry: string | null;
  candidateCity: string | null;
  candidatePostcode: string | null;
}): AddressComparison {
  const roster = args.rosterAddress ?? '';
  const rosterTokens = tokens(roster);

  // ── Rung 1: country ──────────────────────────────────────────────────────
  const country: LadderVerdict =
    !args.rosterCountry || !args.candidateCountry
      ? 'unavailable'
      : sameCountry(args.rosterCountry, args.candidateCountry)
        ? 'pass'
        : 'fail';

  // ── Rung 2: locality — the city name, or the postcode as its own signal ──
  const cityMatched = args.candidateCity ? containsWholeWord(roster, args.candidateCity) : false;
  const postcodeMatched = args.candidatePostcode
    ? containsWholeWord(roster, args.candidatePostcode)
    : false;
  const locality: LadderVerdict =
    !args.candidateCity && !args.candidatePostcode
      ? 'unavailable'
      : cityMatched || postcodeMatched
        ? 'pass'
        : 'fail';

  // ── Rung 3: street ───────────────────────────────────────────────────────
  // Everything in the roster line that is neither the city, the postcode, nor a
  // generic street word. A shared house number and street name is a strong
  // signal — and, on its own, a misleading one.
  const cityTokens = new Set(args.candidateCity ? tokens(args.candidateCity) : []);
  const postcodeTokens = new Set(args.candidatePostcode ? tokens(args.candidatePostcode) : []);
  const streetTokens = rosterTokens.filter(
    (token) => !cityTokens.has(token) && !postcodeTokens.has(token) && !STREET_STOPWORDS.has(token),
  );
  // Street inherits `unavailable` from the rung below it. Absent evidence is
  // not contrary evidence: with no structured city or postcode there is nothing
  // for street agreement to be true OR false against, and reporting `fail`
  // would let a missing field read as a mismatch.
  const street: LadderVerdict =
    streetTokens.length === 0 || locality === 'unavailable'
      ? 'unavailable'
      : locality === 'pass'
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
      postcodeMatched,
      streetTokensMatched: streetTokens,
      addressesConsidered: 1,
      matchedAddressIndex: locality === 'pass' ? 0 : null,
    },
  };
}

/** The roster is ISO3; Sayari returns ISO3 too, but a name sometimes arrives. */
const COUNTRY_ALIASES: Record<string, string> = {
  germany: 'DEU',
  deutschland: 'DEU',
  japan: 'JPN',
  'united states': 'USA',
  usa: 'USA',
  us: 'USA',
  france: 'FRA',
  spain: 'ESP',
  canada: 'CAN',
  china: 'CHN',
  mexico: 'MEX',
  india: 'IND',
  'united kingdom': 'GBR',
  'korea republic of': 'KOR',
  'south korea': 'KOR',
  'republic of korea': 'KOR',
};

/**
 * ISO3 where the value already is one, or is a known alias; `null` where it
 * cannot be told apart from an arbitrary string.
 *
 * The single normaliser both `sameCountry()` (below) and the site-country
 * derivation (`src/jobs/enrich-supplier.ts`, finding 107) reuse, so a roster
 * spelling either both agree is ISO3 or neither does.
 */
export function normaliseCountryToIso3(value: string): string | null {
  const trimmed = value.trim();
  if (/^[A-Za-z]{3}$/.test(trimmed)) return trimmed.toUpperCase();
  return COUNTRY_ALIASES[normaliseAddress(trimmed)] ?? null;
}

export function sameCountry(a: string, b: string): boolean {
  const canon = (value: string) => normaliseCountryToIso3(value) ?? value.trim().toUpperCase();
  return canon(a) === canon(b);
}
