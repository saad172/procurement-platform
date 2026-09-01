/**
 * Number fidelity (SPEC §10.4, check 2).
 *
 * **Every numeric token in a sentence must match some candidate** drawn from
 * `frozen_inputs` or from a row the sentence cites — after unit normalisation,
 * and **rounded to the decimals the sentence itself used**.
 *
 * The rounding rule is what makes this usable rather than pedantic: a sentence
 * saying *"48 km"* is a true statement about a stored 47.6, and rejecting it
 * would push the model into writing 47.6 km everywhere, which is worse prose
 * and no more honest. But *"roughly 800 km"* has **no candidate at all** — 800
 * is not 824 at any precision — so **paraphrase fails**, which is the point.
 *
 * An unmatched token is **named**, because "a number does not check out" is not
 * something a model can act on and "824 does not appear in your evidence" is.
 */

export type NumberCandidate = {
  /** The value as stored. */
  value: number;
  /** Where it came from, so a rejection can say which row would have carried it. */
  source: string;
};

export type StringCandidate = { value: string; source: string };

export type FidelityCandidates = {
  numbers: NumberCandidate[];
  /** HS codes, LEIs and entity ids match as **strings**, never as numbers. */
  strings: StringCandidate[];
  /** `fetched_at` and collected dates, matched **exact to the day**. */
  dates: { iso: string; source: string }[];
};

export type FidelityFailure = {
  token: string;
  kind: 'number' | 'date' | 'identifier';
  message: string;
};

/**
 * Tokens that look numeric but are not claims about evidence.
 *
 * Ordinals and small counts inside prose ("one of three", "the second source")
 * are language, not figures, and demanding a stored candidate for them would
 * make the validator fire on grammar.
 */
const PROSE_NUMBERS = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);

/** ISO dates, and the long forms a sentence is likely to use. */
const DATE_PATTERN = /\b(\d{4}-\d{2}-\d{2})\b/g;

/**
 * An identifier, matched as a string: an HS code (`8544.30`, `8507.60.00.10`),
 * a 20-character LEI, or a 22-character Sayari entity id.
 *
 * Recognised *before* numbers, so `8544.30` is never decomposed into the
 * numbers 8544 and 30.
 *
 * **The entity-id shape needs more than a length.** A bare
 * `[A-Za-z0-9_-]{22}` matches ordinary hyphenated English of exactly that
 * length — measured, it rejected the phrase *"state-owned-enterprise"* as an
 * unresolvable entity id, which is a validator objecting to a word. Real Sayari
 * ids are base64url-ish and mix cases with digits (`LAtrDml3ulKGjNIIFGSNAg`,
 * `bryNuZ2GwwXGB74Rm75-Zw`), so all three character classes are required.
 */
const HS_CODE = String.raw`\d{4}\.\d{2}(?:\.\d{2}){0,2}`;
const LEI = String.raw`[A-Z0-9]{20}`;
const ENTITY_ID = String.raw`(?=[A-Za-z0-9_-]{22}\b)(?=[^\s]*[a-z])(?=[^\s]*[A-Z])(?=[^\s]*\d)[A-Za-z0-9_-]{22}`;
const IDENTIFIER_PATTERN = new RegExp(String.raw`\b(?:${HS_CODE}|${LEI}|${ENTITY_ID})\b`, 'g');

/**
 * A number, with optional thousands separators, decimals and a trailing %.
 *
 * **Both sides are guarded.** The lookbehind was there from the start and the
 * lookahead was not, so a hyphenated token was read from the left and then
 * abandoned: in the Japanese postcode `108-8333`, `108` matched as a free
 * number (nothing precedes it) while `8333` was correctly skipped (a hyphen
 * does). The checker then demanded that *108* appear in the frozen inputs, and
 * an otherwise correct Assessment was rejected in all three Rounds.
 *
 * `(?!-\d)` treats a digit-run followed by `-<digit>` as part of a larger
 * token and skips it entirely — neither a number to verify nor an identifier to
 * resolve. That is the right answer for a postcode or a street number
 * (`1-8-15`): **a postcode is not a figure**, and this check exists to catch
 * invented figures.
 *
 * ASCII hyphen only, deliberately. The anchor lines this app writes use an en
 * dash for ranges (`0–8,000 km`) and a true minus for deductions (`high −40`),
 * so a genuine range is still read as the two numbers it contains.
 */
const NUMBER_PATTERN = /(?<![\w.\-])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?!-\d)\s*(%)?/g;

/** How many decimal places the sentence itself wrote. */
function decimalsOf(fraction: string | undefined): number {
  return fraction ? fraction.length : 0;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Checks one sentence's figures against the evidence available to it.
 *
 * Returns every failure rather than the first, so a Round spent on a rejection
 * fixes everything it can rather than uncovering one problem at a time.
 */
export function checkNumberFidelity(
  text: string,
  candidates: FidelityCandidates,
): FidelityFailure[] {
  const failures: FidelityFailure[] = [];
  const consumed: [number, number][] = [];

  // ── Dates first, exact to the day ────────────────────────────────────────
  for (const match of text.matchAll(DATE_PATTERN)) {
    consumed.push([match.index, match.index + match[0].length]);
    const iso = match[1]!;
    if (!candidates.dates.some((d) => d.iso.slice(0, 10) === iso)) {
      failures.push({
        token: iso,
        kind: 'date',
        message: `the date ${iso} matches no fetched_at or collected date on any row this sentence cites`,
      });
    }
  }

  // ── Identifiers next, as strings ─────────────────────────────────────────
  for (const match of text.matchAll(IDENTIFIER_PATTERN)) {
    if (overlaps(consumed, match.index, match.index + match[0].length)) continue;
    consumed.push([match.index, match.index + match[0].length]);
    const token = match[0];
    if (!candidates.strings.some((s) => s.value === token)) {
      failures.push({
        token,
        kind: 'identifier',
        message: `${token} looks like an HS code, LEI or entity id, and it appears on no row this sentence cites`,
      });
    }
  }

  // ── Then numbers ─────────────────────────────────────────────────────────
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    if (overlaps(consumed, match.index, match.index + match[0].length)) continue;

    const whole = match[1]!.replace(/,/g, '');
    const fraction = match[2];
    const isPercent = Boolean(match[3]);
    const written = `${whole}${fraction ? `.${fraction}` : ''}`;
    const value = Number(written);
    if (Number.isNaN(value)) continue;

    // Small bare integers inside prose are language, not claims.
    if (!fraction && !isPercent && PROSE_NUMBERS.has(written)) continue;

    const decimals = decimalsOf(fraction);
    const matched = candidates.numbers.some((candidate) => {
      // Rounded to the decimals the SENTENCE used: 48 matches 47.6, and
      // 71.3 matches 71.28.
      if (roundTo(candidate.value, decimals) === value) return true;
      // A percentage matches either the percent figure or its decimal fraction:
      // "2.5%" matches a stored 2.5 or a stored 0.025.
      if (isPercent && roundTo(candidate.value * 100, decimals) === value) return true;
      return false;
    });

    if (!matched) {
      failures.push({
        token: match[0].trim(),
        kind: 'number',
        message:
          `${match[0].trim()} matches no value in the frozen inputs or on any row this sentence cites. ` +
          `Write the figure as it is stored, or cite the row that carries it.`,
      });
    }
  }

  return failures;
}

function overlaps(ranges: readonly [number, number][], start: number, end: number): boolean {
  return ranges.some(([s, e]) => start < e && end > s);
}

/**
 * Builds the candidate set for one sentence: the frozen inputs, plus the rows
 * it actually cites.
 *
 * Scoping candidates **per sentence** rather than per document is what stops a
 * sentence borrowing a number from evidence it never pointed at.
 */
export function candidatesFrom(
  frozenInputs: Record<string, unknown>,
  citedRows: readonly Record<string, unknown>[],
): FidelityCandidates {
  const numbers: NumberCandidate[] = [];
  const strings: StringCandidate[] = [];
  const dates: { iso: string; source: string }[] = [];

  const walk = (value: unknown, source: string, depth = 0): void => {
    if (depth > 6 || value == null) return;
    if (typeof value === 'number' && Number.isFinite(value)) {
      numbers.push({ value, source });
      return;
    }
    if (typeof value === 'string') {
      strings.push({ value, source });
      // A numeric string is also a number candidate: `numeric` columns
      // round-trip as strings through postgres.js, so a stored rate of "5.000"
      // must still match a sentence saying 5%.
      const asNumber = Number(value);
      if (value.trim() !== '' && Number.isFinite(asNumber))
        numbers.push({ value: asNumber, source });
      if (/^\d{4}-\d{2}-\d{2}/.test(value)) dates.push({ iso: value, source });

      /**
       * **Numbers inside a PROSE field are stored numbers too.**
       *
       * The case that forced this: every `criterion_value` carries an
       * `anchorLine` — *"starts at 100; high −40, elevated −20, relevant −8"* —
       * which the app itself writes and which the UI renders beside every
       * value. A sentence explaining a score by quoting its own scale is
       * quoting the evidence it cites, and rejecting that taught the model to
       * describe a scale without naming it, which is worse prose and no more
       * honest. A cited address is the same story: "108-0075" is in the row.
       *
       * Restricted to strings containing whitespace, so an identifier is never
       * decomposed: an LEI or an HS code contributes no loose digits. That
       * keeps "roughly 800 km" failing against a stored 824, which is the case
       * the whole check exists for.
       */
      if (/\s/.test(value)) {
        /**
         * **The same pattern the sentence side uses**, and it has to be.
         *
         * It was `/(?<![\w.])(\d+)(?:\.(\d+))?/g` — no thousands separators.
         * So a stored anchor reading `0–8,000 km` contributed the candidates
         * `0`, `8` and `000`, and a sentence quoting that anchor as **8,000**
         * was rejected for inventing a figure the app itself had written.
         *
         * Two extractors that disagree about what a number is will always
         * disagree at the edges, and every disagreement reads as the model
         * making something up.
         */
        for (const match of value.matchAll(new RegExp(NUMBER_PATTERN.source, 'g'))) {
          // `match[1]` may carry thousands separators now that the pattern is
          // shared; they are notation, not value.
          const inner = Number(`${match[1]!.replace(/,/g, '')}${match[2] ? `.${match[2]}` : ''}`);
          if (Number.isFinite(inner)) numbers.push({ value: inner, source: `${source} (in text)` });
        }
      }
      return;
    }
    if (value instanceof Date) {
      dates.push({ iso: value.toISOString(), source });
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, source, depth + 1);
      return;
    }
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        walk(item, `${source}.${key}`, depth + 1);
      }
    }
  };

  walk(frozenInputs, 'frozen_inputs');
  citedRows.forEach((row, index) => walk(row, `cited[${index}]`));

  return { numbers, strings, dates };
}
