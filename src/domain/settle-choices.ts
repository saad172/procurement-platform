import type { LadderVerdict } from './match/address-ladder';

/**
 * What the Needs Review screen offers a person to choose between.
 *
 * The screen it replaces asked for a **22-character opaque entity id, typed
 * into a free-text box**, under a table that repeated the same eight verdicts
 * once per candidate. For NSK's nine records that was seventy-two chips, of
 * which sixty-eight said the same thing, above a control that could only be
 * driven by copying an id out of another page's address bar.
 *
 * Three things this computes, and one it deliberately does not.
 *
 * **It hoists what every candidate agrees on.** A discriminator whose verdict
 * reads the same on every row cannot be telling the rows apart, so it is stated
 * once above the list. The hoist is not a summary and hides nothing: a
 * discriminator only leaves the rows when *all* of them agree, and it takes its
 * verdict with it.
 *
 * **It groups what the checks cannot separate.** Records sharing a name and an
 * address, differing only in punctuation, are one company written twice by two
 * registries. Sayari links them by no `possibly_same_as`, so the app cannot
 * call them Twins (CONTEXT.md, *Twin*) — it can only say it cannot separate
 * them, which is what the group says.
 *
 * **It marks what cannot be the counterparty.** A depositary receipt is an
 * instrument that trades against a company, not a company that signs a
 * contract, and the Identity Standard excludes it by the same reasoning that
 * excludes the brand and the division. The eight Discriminators do not: NSK's
 * `/ADR/` record passes all six that are available to it, carries the only LEI
 * on the page, and has thirteen times the sources of the next row. When the
 * Discriminators tie, the screen has to carry the tiebreaker itself — so this
 * is a screen-level caution and not a ninth check, because changing the eight
 * would restate every verdict already recorded against every judged Candidate.
 *
 * **It does not preselect.** Nothing here is a reason to prefer one of NSK's
 * remaining records over another, and offering a default would manufacture one.
 */

export type VerdictReport = {
  discriminator: string;
  verdict: LadderVerdict;
  reasoning: string;
  /** `rules` when code ran the check, or the agent role that reported it. */
  reportedBy: string;
};

export type CandidateForChoice = {
  entityId: string;
  label: string;
  city: string | null;
  country: string | null;
  addressLine: string | null;
  lei: string | null;
  /**
   * Distinct sources, never the summed `sourceCount` object — independent
   * registries saying the same thing is the only corroboration on offer here.
   */
  distinctSourceCount: number | null;
  foundByRung: string;
  queryProvenance: string | null;
  verdicts: VerdictReport[];
};

/** One discriminator's verdict on one candidate, with its reporters folded in. */
export type ChoiceVerdict = {
  discriminator: string;
  verdict: LadderVerdict;
  reasoning: string;
  reportedBy: string[];
  /** Two reporters read it differently — the second read earning its keep. */
  disputed: boolean;
  /** Every verdict reported, when they disagree. Empty when they do not. */
  reports: { verdict: LadderVerdict; reportedBy: string; reasoning: string }[];
};

export type Choice = {
  entityId: string;
  label: string;
  city: string | null;
  country: string | null;
  addressLine: string | null;
  lei: string | null;
  distinctSourceCount: number | null;
  foundByRung: string;
  queryProvenance: string | null;
  /** Only the discriminators that were not hoisted. */
  verdicts: ChoiceVerdict[];
  /** Why this record cannot be the contract counterparty, if it cannot. */
  caution?: string;
  /**
   * The record is filed under a name the roster row does not use.
   *
   * Never set alongside a caution: *"a security, not the counterparty"* and
   * *"filed under another name"* on one row is two badges where the second
   * explains nothing the first did not, and the caution is the one that decides.
   */
  otherName: boolean;
};

export type ChoiceGroup = {
  kind: 'listed' | 'indistinguishable';
  /** What the group is, said in the words the reader needs before opening it. */
  summary: string;
  choices: Choice[];
};

export type SharedVerdict = {
  discriminator: string;
  verdict: LadderVerdict;
  /** One candidate's wording, since they all reached the same verdict. */
  reasoning: string;
};

export type SettleChoices = {
  shared: SharedVerdict[];
  groups: ChoiceGroup[];
  /**
   * How many candidates carry an identical vector once the shared verdicts are
   * taken out — the size of the tie the screen cannot break.
   */
  tiedCount: number;
};

/**
 * Tokens that mark a record as a traded instrument rather than the company.
 *
 * Matched as **tokens, never substrings**: `adr` is inside Madrid, Cuadra and
 * Padrón, and a caution that fires on a Spanish city name would be worse than
 * no caution at all.
 */
const SECURITY_TOKENS = new Set(['adr', 'adrs', 'gdr', 'gdrs', 'depositary', 'depository']);

const CAUTION_SECURITY = 'a security, not the counterparty';

/** Lowercased alphanumeric runs. Keeps CJK intact as one token. */
const tokens = (value: string): string[] =>
  value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Two address strings that differ only in punctuation and spacing are one
 * address. `NISSEI BLDG. 1-6-3 OHSAKI…` and `NISSEI BLDG. 1-6-3, OHSAKI…` are
 * the same building written by two registries; `6-3, Osaki 1-chome…` is the
 * same building in the *other* Japanese convention and is deliberately **not**
 * folded together with them, because the app cannot prove that and saying so
 * would be a claim it has not earned.
 */
const normalise = (value: string | null): string => (value ? tokens(value).join(' ') : '');

/** Words a legal name carries that say nothing about which company it is. */
const LEGAL_FORMS = new Set([
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
  'sab',
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
  'gmbh',
  'ag',
  'kg',
  'kgaa',
  'se',
  'mbh',
  'co',
  'cv',
  'sl',
  'de',
  'the',
  'and',
  'pte',
  'pty',
  'sdn',
  'bhd',
]);

const significant = (name: string): string[] =>
  tokens(name).filter((token) => !LEGAL_FORMS.has(token) && token.length > 1);

export function settleChoices(input: {
  rosterName: string;
  candidates: CandidateForChoice[];
}): SettleChoices {
  const { rosterName, candidates } = input;

  const folded = candidates.map((candidate) => ({
    candidate,
    verdicts: foldReporters(candidate.verdicts),
  }));

  // A discriminator hoists only when every candidate reports it, every
  // candidate agrees, and no candidate's reporters disagree with each other.
  const shared: SharedVerdict[] = [];
  if (folded.length > 1) {
    const first = folded[0]!;
    for (const verdict of first.verdicts) {
      if (verdict.disputed) continue;
      const everywhere = folded.every(({ verdicts }) =>
        verdicts.some(
          (other) =>
            other.discriminator === verdict.discriminator &&
            other.verdict === verdict.verdict &&
            !other.disputed,
        ),
      );
      if (everywhere) {
        shared.push({
          discriminator: verdict.discriminator,
          verdict: verdict.verdict,
          reasoning: verdict.reasoning,
        });
      }
    }
  }
  const hoisted = new Set(shared.map((s) => s.discriminator));

  const rosterTokens = new Set(significant(rosterName));

  const choices: Choice[] = folded.map(({ candidate, verdicts }) => {
    const labelTokens = significant(candidate.label);
    const security = tokens(candidate.label).some((token) => SECURITY_TOKENS.has(token));
    const sameName =
      labelTokens.length === rosterTokens.size &&
      labelTokens.every((token) => rosterTokens.has(token));

    return {
      entityId: candidate.entityId,
      label: candidate.label,
      city: candidate.city,
      country: candidate.country,
      addressLine: candidate.addressLine,
      lei: candidate.lei,
      distinctSourceCount: candidate.distinctSourceCount,
      foundByRung: candidate.foundByRung,
      queryProvenance: candidate.queryProvenance,
      verdicts: verdicts.filter((v) => !hoisted.has(v.discriminator)),
      ...(security ? { caution: CAUTION_SECURITY } : {}),
      otherName: !sameName && !security,
    };
  });

  /**
   * How large the tie is: candidates whose remaining verdicts read identically.
   * Reported before grouping, because the reader is owed the size of the tie
   * whether or not the screen managed to collapse any of it.
   */
  const vectors = new Map<string, number>();
  for (const choice of choices) {
    const key = choice.verdicts
      .map((v) => `${v.discriminator}=${v.verdict}`)
      .sort()
      .join(' ');
    vectors.set(key, (vectors.get(key) ?? 0) + 1);
  }
  const tiedCount = Math.max(0, ...vectors.values());

  // Records sharing a name and an address, two or more of them, and none of
  // them cautioned — a caution is always shown flat, because an exclusion
  // folded into a `<details>` is an exclusion nobody reads.
  const byIdentity = new Map<string, Choice[]>();
  for (const choice of choices) {
    if (choice.caution) continue;
    const key = `${normalise(choice.label)} ${normalise(choice.addressLine)}`;
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), choice]);
  }
  const grouped = new Set<string>();
  const groups: ChoiceGroup[] = [];
  for (const members of byIdentity.values()) {
    if (members.length < 2) continue;
    for (const member of members) grouped.add(member.entityId);
    groups.push({
      kind: 'indistinguishable',
      summary: `${count(members.length, 'record')} the checks cannot separate — same name, same address, differing only in punctuation`,
      choices: members.slice().sort(byCorroboration),
    });
  }

  const listed = choices.filter((c) => !grouped.has(c.entityId)).sort(byCorroboration);

  return {
    shared,
    groups: [
      { kind: 'listed', summary: 'Which record settles it', choices: listed },
      ...groups.sort((a, b) => b.choices.length - a.choices.length),
    ],
    tiedCount,
  };
}

/**
 * Cautioned records sort last whatever their corroboration.
 *
 * NSK's depositary receipt has twenty-seven distinct sources against the next
 * row's two — securities feeds are numerous — so ordering on corroboration
 * alone would put the one record that must not be picked at the top of the
 * page.
 */
function byCorroboration(a: Choice, b: Choice): number {
  if (Boolean(a.caution) !== Boolean(b.caution)) return a.caution ? 1 : -1;
  return (b.distinctSourceCount ?? 0) - (a.distinctSourceCount ?? 0);
}

/**
 * Both agents' verdicts are stored per candidate, and they may differ — the
 * blind evaluator naming a different company is what the second read exists to
 * catch. Folding keeps the disagreement rather than picking a winner.
 */
function foldReporters(reports: VerdictReport[]): ChoiceVerdict[] {
  const byDiscriminator = new Map<string, VerdictReport[]>();
  for (const report of reports) {
    byDiscriminator.set(report.discriminator, [
      ...(byDiscriminator.get(report.discriminator) ?? []),
      report,
    ]);
  }

  return [...byDiscriminator.entries()].map(([discriminator, all]) => {
    const distinct = [...new Set(all.map((r) => r.verdict))];
    const disputed = distinct.length > 1;
    const lead = all[0]!;
    return {
      discriminator,
      verdict: lead.verdict,
      reasoning: lead.reasoning,
      reportedBy: [...new Set(all.map((r) => r.reportedBy))],
      disputed,
      reports: disputed
        ? all.map((r) => ({ verdict: r.verdict, reportedBy: r.reportedBy, reasoning: r.reasoning }))
        : [],
    };
  });
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * What the settle page says before any of the apparatus.
 *
 * The page opened on the Identity Standard and then a table — neither of which
 * says what is being asked of the reader. What is being asked is unflattering
 * and has to be said anyway: for NSK, nine records of which six read
 * identically once the shared verdicts come out, and the most corroborated of
 * the nine is an instrument rather than a company.
 *
 * The tone is always `you`. Nothing on this page resolves without a person —
 * that is the definition of the page — so a green *ok* would be a lie and a red
 * *stop* would suggest something is broken. Something is undecided.
 */
export function settleAnswer(input: { rosterName: string; candidates: CandidateForChoice[] }): {
  tone: 'you';
  said: string;
  because: string;
} {
  const n = input.candidates.length;

  if (n === 0) {
    return {
      tone: 'you',
      said: 'No candidate in this country was ever seen.',
      because:
        'Every rung ran and none of them returned a company registered in the roster row’s country, so there is nothing here to choose between. Searching by hand may still find one — a record Sayari holds that no query term reached. Marking the row not found is also an answer, and it is recorded as a finding rather than as an absence.',
    };
  }

  const { shared, groups, tiedCount } = settleChoices(input);
  const cautioned = groups.flatMap((g) => g.choices).filter((c) => c.caution);

  const said =
    n === 1
      ? 'One candidate, and it did not reach the bar for an automatic accept.'
      : tiedCount === n
        ? `${word(n)} candidates, and the eight checks separate none of them.`
        : tiedCount === 1
          ? `${word(n)} candidates, and the eight checks tell ${n === 2 ? 'both' : `all ${word(n).toLowerCase()}`} apart.`
          : `${word(n)} candidates, and the eight checks read identically on ${word(tiedCount).toLowerCase()} of them.`;

  const parts: string[] = [];

  if (shared.length > 0) {
    parts.push(
      `${word(shared.length)} of the eight reach the same verdict on every record, so ${shared.length === 1 ? 'it is' : 'they are'} stated once below rather than repeated on each row. What is left on the rows is what actually differs.`,
    );
  }

  if (cautioned.length > 0) {
    parts.push(
      `The most corroborated record on this page is a security rather than the company: it carries the only LEI here and many times the sources of anything else, because securities feeds are numerous. It is kept on the list, marked, and sorted last — an exclusion folded away is an exclusion nobody reads.`,
    );
  }

  parts.push(
    'Nothing is preselected. Two independent reads already declined to choose, and offering a default here would manufacture a preference the evidence does not support.',
  );

  return { tone: 'you', said, because: parts.join(' ') };
}

const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/** Small counts read as words in a sentence; anything larger stays a numeral. */
const word = (n: number): string => WORDS[n] ?? String(n);
