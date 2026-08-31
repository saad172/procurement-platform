import { describe, expect, it } from 'vitest';
import { settleAnswer, settleChoices, type CandidateForChoice } from '@/domain/settle-choices';

/**
 * The Needs Review screen asked a person to type a 22-character opaque id into
 * a free-text box, under a table that repeated the same eight verdicts once per
 * candidate — seventy-two chips for NSK's nine records, of which sixty-eight
 * said the same thing.
 *
 * What is tested here is the three claims that let the screen become a choice:
 *
 * 1. **A verdict every candidate shares is stated once**, above the list. Nothing
 *    is hidden by that — a discriminator only hoists when *all* of them agree.
 * 2. **Records the checks cannot separate are grouped**, and the group says so,
 *    because settling on one of four identical records is arbitrary and the
 *    screen must not pretend otherwise.
 * 3. **A record that cannot be the counterparty is shown flat and marked**, never
 *    collapsed and never first — the exclusion has to be where the decision is.
 *
 * The fixtures are the real parked rows: NSK's nine and Nemak's eight, verdict
 * vectors copied from the development database rather than invented.
 */

const V = (spec: string, reportedBy = 'rules') =>
  spec.split(' ').map((pair) => {
    const [discriminator, verdict] = pair.split('=');
    return {
      discriminator: discriminator!,
      verdict: verdict! as 'pass' | 'fail' | 'unavailable',
      reasoning: `${discriminator} ${verdict}`,
      reportedBy,
    };
  });

/** All eight passing except the two that need a witness nobody supplied. */
const CLEAN = 'alias_context=pass business_purpose=pass country=pass lei_witness=unavailable liveness=unavailable locality=pass name_cover=pass street=pass';

const nsk = (): CandidateForChoice[] => [
  {
    entityId: 'kr79WmkleiLVroowJWrtgw',
    label: 'NSK LTD /ADR/',
    city: 'Fukuoka',
    country: 'JPN',
    addressLine: 'NISSEI BLDG 6-3 OSAKI 1-CHOME SHINAGAWA TOKYO 141 0 0',
    lei: '353800FVQK6SULSPBC69',
    distinctSourceCount: 27,
    foundByRung: 'R2',
    queryProvenance: null,
    verdicts: V(CLEAN, 'resolver'),
  },
  {
    entityId: 'yAk5_IMxLmWW2YvS-aAAIg',
    label: '日本精工株式会社',
    city: 'Fujisawa City',
    country: 'JPN',
    addressLine: 'NISSEI BLDG 6-3 TOKYO 141-8560',
    lei: null,
    distinctSourceCount: 4,
    foundByRung: 'R2',
    queryProvenance: null,
    verdicts: V(
      'alias_context=fail business_purpose=pass country=unavailable lei_witness=unavailable liveness=unavailable locality=pass name_cover=fail street=pass',
      'evaluator',
    ),
  },
  {
    entityId: 'M_bKIsKm8M7jv0xju_VcAw',
    label: 'NSK LTD.',
    city: 'Shinagawa-ku Tokyo',
    country: 'JPN',
    addressLine: '6-3, Osaki 1-chome, Shinagawa-ku, Tokyo, 141-8560, JP',
    lei: null,
    distinctSourceCount: 2,
    foundByRung: 'R1',
    queryProvenance: 'batch pre-pass',
    verdicts: V(CLEAN),
  },
  // The four that differ only in punctuation.
  ...['zO7VjRJoQSBiZT1cxY_abw', 'Tw9ioE_BGVeTf4zLSVpnCA', 'AxEEE-hYROLSdDPfphgQFg'].map((id) => ({
    entityId: id,
    label: 'NSK LTD.',
    city: 'Tokyo',
    country: 'JPN',
    addressLine: 'NISSEI BLDG. 1-6-3 OHSAKI SHINAGAWA-KU, TOKYO 141-8560 JP',
    lei: null,
    distinctSourceCount: 1,
    foundByRung: 'R1',
    queryProvenance: null,
    verdicts: V(CLEAN),
  })),
  {
    entityId: 'HmlmBPU_ee6NZxOXxXyHWQ',
    label: 'NSK LTD.',
    city: 'Tokyo',
    country: 'JPN',
    // One comma different from the three above, and nothing else.
    addressLine: 'NISSEI BLDG. 1-6-3, OHSAKI SHINAGAWA-KU, TOKYO 141-8560 JP',
    lei: null,
    distinctSourceCount: 1,
    foundByRung: 'R1',
    queryProvenance: null,
    verdicts: V(CLEAN),
  },
  {
    entityId: '6U6F-Oelplz-IA4mF_zn0Q',
    label: 'NSK Ltd. (Nippon Seikö Kabushiki-Kaisha)',
    city: 'Tokio Shinagawa-ku',
    country: 'JPN',
    addressLine: '1-chome 6-3, Ohsaki, Tokio Shinagawa-ku, JP, 141-8560',
    lei: null,
    distinctSourceCount: 1,
    foundByRung: 'R2',
    queryProvenance: null,
    verdicts: V(
      'alias_context=pass business_purpose=unavailable country=pass lei_witness=unavailable liveness=unavailable locality=pass name_cover=pass street=pass',
    ),
  },
  {
    entityId: '8xXQ9bAKzg8-ps_wIvTm4Q',
    label: 'Nippon Seiko Kabushiki Kaisha',
    city: 'Shinagawa-ku, Tokyo',
    country: 'JPN',
    addressLine: '1-6-3, Osaki, Shinagawa-ku, Tokyo, JP',
    lei: null,
    distinctSourceCount: 1,
    foundByRung: 'R2',
    queryProvenance: null,
    verdicts: V(
      'alias_context=fail business_purpose=unavailable country=pass lei_witness=unavailable liveness=unavailable locality=pass name_cover=fail street=pass',
    ),
  },
];

const choices = (candidates = nsk(), rosterName = 'NSK') =>
  settleChoices({ rosterName, candidates });

describe('a verdict every candidate shares is stated once', () => {
  /**
   * Four of the eight are identical across all nine NSK records. Stating them
   * once removes thirty-six chips and loses nothing, because a chip that reads
   * the same on every row cannot be telling the rows apart.
   */
  it('hoists the discriminators every candidate agrees on', () => {
    const { shared } = choices();
    expect(shared.map((s) => s.discriminator).sort()).toEqual([
      'lei_witness',
      'liveness',
      'locality',
      'street',
    ]);
  });

  it('carries the shared verdict with it, so the hoist is not a summary', () => {
    const { shared } = choices();
    expect(shared.find((s) => s.discriminator === 'street')!.verdict).toBe('pass');
    expect(shared.find((s) => s.discriminator === 'liveness')!.verdict).toBe('unavailable');
  });

  /** A discriminator that separates anything stays on the rows it separates. */
  it('leaves the discriminators that differ on the rows', () => {
    const { shared, groups } = choices();
    const hoisted = new Set(shared.map((s) => s.discriminator));
    expect(hoisted.has('name_cover')).toBe(false);
    const first = groups.flatMap((g) => g.choices)[0]!;
    expect(first.verdicts.map((v) => v.discriminator).sort()).toEqual([
      'alias_context',
      'business_purpose',
      'country',
      'name_cover',
    ]);
  });

  /** With one candidate there is nothing to compare, so nothing hoists. */
  it('hoists nothing when there is only one candidate', () => {
    const { shared } = choices([nsk()[2]!]);
    expect(shared).toEqual([]);
  });
});

describe('records the checks cannot separate are grouped, and say so', () => {
  /**
   * Four records carry the roster's own address string and differ only in
   * punctuation. Sayari links none of them by `possibly_same_as`, so the app
   * cannot call them Twins; it can only say it cannot separate them.
   */
  it('collapses the four records that share a name and an address', () => {
    const group = choices().groups.find((g) => g.kind === 'indistinguishable');
    expect(group).toBeDefined();
    expect(group!.choices).toHaveLength(4);
    expect(group!.choices.map((c) => c.entityId).sort()).toEqual([
      'AxEEE-hYROLSdDPfphgQFg',
      'HmlmBPU_ee6NZxOXxXyHWQ',
      'Tw9ioE_BGVeTf4zLSVpnCA',
      'zO7VjRJoQSBiZT1cxY_abw',
    ]);
  });

  it('does not group the record whose address is the same building written differently', () => {
    const group = choices().groups.find((g) => g.kind === 'indistinguishable')!;
    expect(group.choices.map((c) => c.entityId)).not.toContain('M_bKIsKm8M7jv0xju_VcAw');
  });

  /** A group of one is not a group — it is a record, and it stays visible. */
  it('never collapses a lone record', () => {
    const { groups } = choices(nsk().filter((c) => c.distinctSourceCount !== 1));
    expect(groups.every((g) => g.kind !== 'indistinguishable')).toBe(true);
  });
});

describe('a record that cannot be the counterparty is marked, not hidden', () => {
  /**
   * `/ADR/` is an American Depositary Receipt — an instrument that trades
   * against the company, not the company that would sign a contract. It is the
   * strongest record on every visible signal: the only LEI on the page and
   * thirteen times the sources of the next row. The eight checks pass it.
   */
  it('cautions the depositary receipt the discriminators pass', () => {
    const flat = choices().groups.flatMap((g) => g.choices);
    const adr = flat.find((c) => c.entityId === 'kr79WmkleiLVroowJWrtgw')!;
    expect(adr.caution).toBe('a security, not the counterparty');
  });

  it('sorts it below every record that is not cautioned, despite its 27 sources', () => {
    const listed = choices().groups.find((g) => g.kind === 'listed')!;
    expect(listed.choices.at(-1)!.entityId).toBe('kr79WmkleiLVroowJWrtgw');
  });

  it('shows it flat rather than inside a group, because the exclusion is the point', () => {
    const { groups } = choices();
    const collapsed = groups.filter((g) => g.kind !== 'listed').flatMap((g) => g.choices);
    expect(collapsed.map((c) => c.entityId)).not.toContain('kr79WmkleiLVroowJWrtgw');
  });

  /** `adr` is a token, never a substring: Madrid is a city, not an instrument. */
  it('does not caution a company whose name merely contains the letters', () => {
    const [first] = choices([
      { ...nsk()[2]!, entityId: 'x', label: 'MADRID CUADRA PADRON SA' },
    ]).groups.flatMap((g) => g.choices);
    expect(first!.caution).toBeUndefined();
  });
});

describe('the order is corroboration, not search rank', () => {
  /**
   * Sayari's score is not comparable between queries (SPEC §6.3), so rank is
   * why these records are here and not evidence about which is right. Distinct
   * sources are evidence: they are independent registries saying the same thing.
   */
  it('orders the uncautioned records by distinct sources, most first', () => {
    const listed = choices().groups.find((g) => g.kind === 'listed')!;
    expect(listed.choices.map((c) => c.distinctSourceCount)).toEqual([4, 2, 1, 1, 27]);
  });

  it('reports how many records the remaining checks still cannot separate', () => {
    // Six of the nine carry an identical vector; four of those are grouped.
    expect(choices().tiedCount).toBe(6);
  });
});

describe('Nemak — eight records the shared-verdict hoist still helps', () => {
  /**
   * All eight, because four of them told a different story: on the top half of
   * the roster `country` and `business_purpose` pass everywhere and hoist, and
   * it is the two records whose label *is* their address — Sayari rows with no
   * country and no city — that keep both on the rows where they belong.
   */
  const nemak = (): CandidateForChoice[] =>
    [
      ['l5pSi--fXqgm5N8s4bxv8g', 'NEMAK MEXICO SA', 21, 'alias_context=pass business_purpose=pass country=pass lei_witness=unavailable liveness=unavailable locality=fail name_cover=pass street=fail'],
      ['D8GMaegMcydep5QWv6TXAw', 'NEMAK S A B DE C V', 16, 'alias_context=pass business_purpose=pass country=pass lei_witness=unavailable liveness=unavailable locality=pass name_cover=pass street=pass'],
      ['cor4FogEfrau8vamZfNdKQ', 'NEMAK AUTOMOTIVE SA DE CV', 4, 'alias_context=pass business_purpose=pass country=pass lei_witness=unavailable liveness=unavailable locality=unavailable name_cover=pass street=unavailable'],
      ['_uqICvrXPDzUmVmshlMVEQ', 'NEMAK MEXICO, S.A.', 1, 'alias_context=pass business_purpose=pass country=pass lei_witness=unavailable liveness=unavailable locality=fail name_cover=pass street=fail'],
      ['xEYHOxCUcVl9Zfeg0EFzLw', 'NEMAK, S.A.B. DE C.V.', 1, 'alias_context=pass business_purpose=pass country=pass lei_witness=unavailable liveness=unavailable locality=fail name_cover=pass street=fail'],
      ['rvEB1jlEZctwGy050XxP1w', 'NEMAK, S.A.B. DE C.V.', 1, 'alias_context=pass business_purpose=unavailable country=pass lei_witness=unavailable liveness=unavailable locality=pass name_cover=pass street=pass'],
      ['8CfTfGdnbgY3ElsLXGkroA', 'Nemak S A De C V Libramiento Arco Vial Km 3 8 Garcia Nuevo Leon 66000 Mexico', 1, 'alias_context=pass business_purpose=unavailable country=unavailable lei_witness=unavailable liveness=unavailable locality=unavailable name_cover=pass street=unavailable'],
      ['fdPQsF4QelrW9kot65QcyA', 'Nemak, S.A. De C.V. Libramiento Arco Vial Km. 3.8 Garcia Nuevo Leon 66000 Mexico', 1, 'alias_context=pass business_purpose=unavailable country=unavailable lei_witness=unavailable liveness=unavailable locality=unavailable name_cover=pass street=unavailable'],
    ].map(([entityId, label, src, spec]) => ({
      entityId: entityId as string,
      label: label as string,
      city: null,
      country: 'MEX',
      addressLine: `${label as string} address`,
      lei: null,
      distinctSourceCount: src as number,
      foundByRung: 'R2',
      queryProvenance: null,
      verdicts: V(spec as string),
    }));

  it('hoists the four the roster could never have separated', () => {
    const { shared } = settleChoices({ rosterName: 'Nemak', candidates: nemak() });
    expect(shared.map((s) => s.discriminator).sort()).toEqual([
      'alias_context',
      'lei_witness',
      'liveness',
      'name_cover',
    ]);
  });

  it('leaves country, locality, street and business purpose to argue on the rows', () => {
    const { groups } = settleChoices({ rosterName: 'Nemak', candidates: nemak() });
    const top = groups.flatMap((g) => g.choices)[0]!;
    expect(top.verdicts.map((v) => v.discriminator).sort()).toEqual([
      'business_purpose',
      'country',
      'locality',
      'street',
    ]);
  });

  it('cautions nothing, because none of these is an instrument', () => {
    const { groups } = settleChoices({ rosterName: 'Nemak', candidates: nemak() });
    expect(groups.flatMap((g) => g.choices).every((c) => c.caution === undefined)).toBe(true);
  });
});

describe('two reporters disagreeing is the interesting artefact, and survives', () => {
  /**
   * The blind evaluator naming a different company is what the second read
   * exists to catch. A disagreement can never hoist — it is by definition not
   * shared — and the row has to show both verdicts rather than picking one.
   */
  it('never hoists a discriminator two reporters read differently', () => {
    const candidates = nsk();
    candidates[2]!.verdicts = [
      ...V('street=pass'),
      ...V('street=fail', 'evaluator'),
      ...V('locality=pass lei_witness=unavailable liveness=unavailable'),
    ];
    const { shared } = settleChoices({ rosterName: 'NSK', candidates });
    expect(shared.map((s) => s.discriminator)).not.toContain('street');
  });

  it('marks the row disputed and keeps both verdicts', () => {
    const candidates = [nsk()[2]!, nsk()[3]!];
    candidates[0]!.verdicts = [...V('street=pass'), ...V('street=fail', 'evaluator')];
    const { groups } = settleChoices({ rosterName: 'NSK', candidates });
    const row = groups.flatMap((g) => g.choices).find((c) => c.entityId === 'M_bKIsKm8M7jv0xju_VcAw')!;
    const street = row.verdicts.find((v) => v.discriminator === 'street')!;
    expect(street.disputed).toBe(true);
    expect(street.reportedBy.sort()).toEqual(['evaluator', 'rules']);
  });
});

describe('what the settle page says before the apparatus', () => {
  /**
   * The page opened on the Identity Standard, then a table. Neither says what
   * is being asked of the reader, and the honest answer for NSK is unflattering:
   * of nine records, six read identically once the shared verdicts are taken
   * out. Saying so is what stops a reader assuming the top row is the answer.
   */
  it('leads with the size of the tie the checks could not break', () => {
    const answer = settleAnswer({ rosterName: 'NSK', candidates: nsk() });
    expect(answer.said).toBe('Nine candidates, and the eight checks read identically on six of them.');
    expect(answer.tone).toBe('you');
  });

  it('names the record that cannot be the counterparty, before the list does', () => {
    const answer = settleAnswer({ rosterName: 'NSK', candidates: nsk() });
    expect(answer.because).toMatch(/most corroborated record on this page is a security/);
  });

  it('says so plainly when nothing was ever found', () => {
    const answer = settleAnswer({ rosterName: 'NSK', candidates: [] });
    expect(answer.said).toBe('No candidate in this country was ever seen.');
    expect(answer.because).toMatch(/Searching by hand/);
  });

  it('does not claim a tie when one record stands alone', () => {
    const answer = settleAnswer({ rosterName: 'NSK', candidates: [nsk()[2]!] });
    expect(answer.said).toBe('One candidate, and it did not reach the bar for an automatic accept.');
  });

  /** When every record reads differently, the sentence must not invent a tie. */
  it('says the checks told every record apart when they did', () => {
    const candidates = [nsk()[1]!, nsk()[2]!];
    const answer = settleAnswer({ rosterName: 'NSK', candidates });
    expect(answer.said).toBe('Two candidates, and the eight checks tell both apart.');
  });

  /** All nine reading alike is the artboard's case, and it is said as such. */
  it('says none of them when the checks separate nothing at all', () => {
    const candidates = nsk().map((c) => ({ ...c, verdicts: V(CLEAN) }));
    const answer = settleAnswer({ rosterName: 'NSK', candidates });
    expect(answer.said).toBe('Nine candidates, and the eight checks separate none of them.');
  });
});

describe('one row never carries two badges that say the same thing', () => {
  /**
   * `NSK LTD /ADR/` is filed under a name the roster does not use *and* is an
   * instrument rather than a company. Both are true; only the second decides,
   * and rendering both puts a badge beside it that explains nothing the caution
   * did not already say.
   */
  it('drops the other-name badge when the row is cautioned', () => {
    const adr = choices()
      .groups.flatMap((g) => g.choices)
      .find((c) => c.entityId === 'kr79WmkleiLVroowJWrtgw')!;
    expect(adr.caution).toBeDefined();
    expect(adr.otherName).toBe(false);
  });

  it('still marks an other-name record that carries no caution', () => {
    const japanese = choices()
      .groups.flatMap((g) => g.choices)
      .find((c) => c.entityId === 'yAk5_IMxLmWW2YvS-aAAIg')!;
    expect(japanese.otherName).toBe(true);
  });
});
