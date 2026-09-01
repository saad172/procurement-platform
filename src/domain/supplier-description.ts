import { attributeText, type SayariEntity } from '@/upstream/projections/sayari';

/**
 * Who a company is, in a sentence, out of what the graph already holds.
 *
 * **Every fact here has been stored against the company since the first
 * enrichment ran, and none of it reached a page.** The projection typed an
 * attribute's `properties` as a closed object listing only the address fields,
 * so Zod stripped `value`, `code` and `standard` from every non-address
 * attribute — and the readers looked for a top-level `value` that no attribute
 * entry in the corpus has ever carried. `businessPurposes` came back `[]` every
 * time (BUILD-NOTES finding 90), so there was nothing to write a description
 * from and the page did not try.
 *
 * With that fixed, Bosch's record alone yields 32 business-purpose entries
 * filed in five countries under four national schemes and converted to one
 * standard. **The codes disagree on detail and agree on the main point**, which
 * is why this leads with the purposes and demotes the codes into the working:
 * a reader wants *makes parts for motor vehicles*, and the seventeen ISIC lines
 * behind it are the audit trail rather than the answer.
 */

export type SupplierDescription = {
  /** The leading sentence, or null when the record says nothing about itself. */
  headline: string | null;
  /** Plain figures a manager reads at a glance. Absent ones are simply absent. */
  figures: { value: string; label: string }[];
  /**
   * Every activity code the headline is built from, for the `.working` block.
   * `standard` is the scheme it was filed under, once converted.
   */
  codes: { code: string; label: string; standard: string | null }[];
  /** Countries the record places it in, for the line under the figures. */
  countries: string[];
  /** Sent and received shipments, when the record carries a trade count. */
  trade: { sent: number; received: number } | null;
};

/** How many activities the headline names before it starts saying nothing. */
const HEADLINE_PURPOSES = 4;

/**
 * The one standard everything is converted to.
 *
 * A record files the same activity once per country under its own national
 * scheme — Bosch's carry NAF2, CNAE2, NACE2, ATECO and NAF1993 alongside ISIC4,
 * in French, Portuguese and Italian. Ranking across all of them and taking the
 * top would put *Fabrication d'équipements électriques* at the head of an
 * English page. ISIC4 is what Sayari converts the rest **to**, so it is the one
 * language every national filing has been said in.
 *
 * The national entries are not discarded: their record counts are what rank the
 * ISIC lines, and all of them are listed in the working.
 */
const COMMON_STANDARD = 'ISIC4';

/** Says "classified nowhere else", which is not a description of anything. */
const CATCH_ALL = /\bn\.?e\.?c\.?\b|not elsewhere classified/i;

export function describeSupplier(entity: SayariEntity): SupplierDescription {
  const purposeEntries = entity.attributes?.business_purpose?.data ?? [];

  const all: { label: string; code: string | null; standard: string | null; records: number }[] =
    [];
  for (const entry of purposeEntries) {
    const label = attributeText(entry);
    if (!label) continue;
    all.push({
      label,
      code: typeof entry.properties?.code === 'string' ? entry.properties.code : null,
      standard: typeof entry.properties?.standard === 'string' ? entry.properties.standard : null,
      records: entry.record_count ?? 0,
    });
  }

  /**
   * **The codes disagree on detail and agree on the main point**, and the
   * agreement is the number of records behind each. Bosch files *parts and
   * accessories for motor vehicles* under four schemes across five countries,
   * 53 records between them; the activities named once are the tail.
   *
   * A catch-all sorts last however many records assert it. It is kept, because
   * dropping evidence is how the description came to be empty in the first
   * place — it is simply not the thing to lead with.
   */
  const ranked = [...groupByActivity(all).values()].sort(
    (a, b) =>
      Number(CATCH_ALL.test(a.label)) - Number(CATCH_ALL.test(b.label)) ||
      b.records - a.records ||
      a.label.localeCompare(b.label),
  );

  const headline =
    ranked.length === 0
      ? null
      : sentence(ranked.slice(0, HEADLINE_PURPOSES).map((p) => lowerFirst(p.label)));

  const figures: SupplierDescription['figures'] = [];
  if (entity.registration_date) {
    figures.push({ value: entity.registration_date.slice(0, 4), label: 'registered since' });
  }
  if (entity.company_type) figures.push({ value: entity.company_type, label: 'legal form' });
  if (entity.countries?.length) {
    figures.push({
      value: String(entity.countries.length),
      label: entity.countries.length === 1 ? 'country it operates in' : 'countries it operates in',
    });
  }
  // The `address` ATTRIBUTE, not the top-level list: Bosch carries 91 addresses
  // in the attribute against 3 in `addresses[]`, which is a summary rather than
  // the record.
  const addressCount = entity.attributes?.address?.data?.length ?? entity.addresses?.length ?? 0;
  if (addressCount > 0) {
    figures.push({
      value: String(addressCount),
      label: addressCount === 1 ? 'address on record' : 'addresses on record',
    });
  }

  const trade = readTrade(entity.trade_count);
  if (trade) figures.push({ value: compact(trade.sent), label: 'shipments sent' });

  return {
    headline,
    figures,
    // Every scheme, not just the common one — the working is where a reader
    // goes to see that four national filings said the same thing.
    codes: all
      .filter((p): p is typeof p & { code: string } => p.code != null)
      .sort((a, b) => b.records - a.records || a.code!.localeCompare(b.code!))
      .map((p) => ({ code: p.code, label: lowerFirst(p.label), standard: p.standard })),
    countries: entity.countries ?? [],
    trade,
  };
}

/**
 * `trade_count` is `{ sent, received }` and typed `unknown` in the projection,
 * because it is one of the fields whose shape was measured rather than assumed.
 * A maker sends far more than it receives, which is exactly the distinction a
 * buyer is checking for — so the two numbers are kept apart rather than summed.
 */
function readTrade(value: unknown): { sent: number; received: number } | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as { sent?: unknown; received?: unknown };
  if (typeof row.sent !== 'number' || typeof row.received !== 'number') return null;
  return { sent: row.sent, received: row.received };
}

/** "a, b and c." — an Oxford-comma-free list, because it is prose. */
function sentence(parts: string[]): string {
  const joined =
    parts.length === 1
      ? parts[0]!
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${capitalise(joined)}.`;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * One row per activity, in the common standard, carrying every record that
 * asserts it under any scheme.
 *
 * Grouped on the ISIC code where there is one, so the three separate ISIC4
 * `2930` entries a multi-country record carries become one activity with 53
 * records rather than three with 22, 19 and 12.
 */
function groupByActivity(
  rows: { label: string; code: string | null; standard: string | null; records: number }[],
): Map<string, { label: string; code: string | null; standard: string | null; records: number }> {
  const common = rows.filter((r) => r.standard === COMMON_STANDARD);
  // A record filed under no ISIC line at all still has to be describable, so
  // the national labels stand in when there is no converted one.
  const source = common.length > 0 ? common : rows;

  const out = new Map<
    string,
    { label: string; code: string | null; standard: string | null; records: number }
  >();
  for (const row of source) {
    const key = row.code ?? row.label.toLowerCase();
    const existing = out.get(key);
    if (existing) existing.records += row.records;
    else out.set(key, { ...row });
  }

  return out;
}

/**
 * Sayari's labels arrive capitalised as headings — "Manufacture of motor
 * vehicles" — and read wrong mid-sentence. An all-caps token is left alone,
 * because it is an initialism rather than a capitalised word.
 */
const lowerFirst = (s: string) => {
  const first = s.split(/\s+/)[0] ?? '';
  if (first.length > 1 && first === first.toUpperCase()) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
};

/** 1,141,941 → "1.14m". A figure a manager scans, not one they audit. */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}
