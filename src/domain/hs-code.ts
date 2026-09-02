/**
 * HS codes at the two widths this app uses (SPEC §7.1, §11).
 *
 * A Category carries **HS lines** — the full codes a person authored and
 * verified against a live USITC pull, eight or ten digits where the rate
 * depends on them (`8507.60.00.10`, `8419.50.10.00`) and six where it does not
 * (`8544.30`). Two consumers then want something narrower or wider than what
 * is stored, and both used to do it inline with a `slice` and a `startsWith`:
 *
 * - **Discover** must ask trade data for a **heading**, because trade data
 *   indexes HS at six digits. That widening is the source of the noise the Job
 *   exists to handle — `8507.60` is any lithium-ion battery, not a traction
 *   pack — so it is worth a named function rather than a slice in the middle
 *   of a query builder.
 * - **The tariff Enrichment** must find the queried code among the lines the
 *   USITC returns, which are the lines *under* it as often as the code itself.
 *
 * Six digits is the internationally harmonised width, which the WCO calls a
 * subheading and this build's seed notes call the **heading** ("8708.99 is a
 * trap above 8 digits — its lines run Free to 2.5%. Never cache the 6-digit
 * heading."). The seed's word is kept here so the code and the notes that
 * explain it use one vocabulary.
 */

/** The code with its dots and spaces dropped — the form every comparison uses. */
export function hsDigits(code: string): string {
  return code.replace(/\D/g, '');
}

/**
 * The six-digit heading of an HS line.
 *
 * A code with fewer than six digits is returned as it is rather than padded:
 * padding would invent a heading, and every line in the seed carries at least
 * six. The caller that widens to a heading is asking a **wider** question and
 * the honest failure is to ask the narrow one, not to guess.
 */
export function hsHeading(code: string): string {
  return hsDigits(code).slice(0, 6);
}

/**
 * How the rate this row carries was matched to the HS line asked for.
 *
 * `sub_line` is the ordinary case for a six-digit Category line: the USITC
 * publishes rates on the lines beneath a heading, so `8544.30` is answered by
 * `8544.30.00.00`. It is recorded rather than assumed because the same shape
 * is how a rate about a *different* product could arrive — the seed's own note
 * on `8708.99` says its lines run Free to 2.5%.
 */
export type HsLineMatch = 'exact' | 'sub_line' | 'none';

/**
 * Picks the HTS line a rate should be read from, and says how it was found.
 *
 * This was `rows.find((r) => digits(r.htsno).startsWith(digits(hsCode)))` — the
 * **first** line under the code, in whatever order the API returned them, with
 * no record that a widening had happened at all. Two things were wrong with
 * that and only one of them is the order: a line that carries the code exactly
 * is a better answer than one beneath it and was not preferred, and a row
 * reading `8544.30 · 5%` said the same thing whether the source had answered
 * about `8544.30` or about some ten-digit line under it.
 *
 * So: the exact line first; failing that the **most general** line beneath the
 * code — fewest digits, then lexicographic, which is a total order over what
 * the API returns and not a property of how it sorted them.
 */
export function chooseHtsLine<T extends { htsno?: string | null }>(
  lines: readonly T[],
  hsCode: string,
): { line: T | undefined; matchedBy: HsLineMatch } {
  const wanted = hsDigits(hsCode);
  if (wanted === '') return { line: undefined, matchedBy: 'none' };

  const exact = lines.find((line) => hsDigits(line.htsno ?? '') === wanted);
  if (exact) return { line: exact, matchedBy: 'exact' };

  const beneath = lines
    .filter((line) => {
      const digits = hsDigits(line.htsno ?? '');
      return digits !== '' && digits.startsWith(wanted);
    })
    .sort((a, b) => {
      const left = hsDigits(a.htsno ?? '');
      const right = hsDigits(b.htsno ?? '');
      return left.length - right.length || left.localeCompare(right);
    });

  return beneath[0]
    ? { line: beneath[0], matchedBy: 'sub_line' }
    : { line: undefined, matchedBy: 'none' };
}
