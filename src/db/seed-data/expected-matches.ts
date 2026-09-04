/**
 * **The truth set** — one row per roster index, saying which Sayari entity each
 * Supplier *should* resolve to under the Identity Standard (SPEC §6.7).
 *
 * ## No app behaviour may depend on this
 *
 * This file is a **hand-authored judgement**, drafted by reading the Candidates
 * the resolve loop actually returned — their labels, addresses, LEIs, GLEIF
 * records and one hop of ownership — against the one sentence that defines the
 * right answer: *the legal entity registered at the roster address, the
 * contract counterparty, not the brand and not a division; the group parent is
 * recorded through the ownership hop instead.*
 *
 * It is not derived from any source, **every row is confirmed by assumption
 * rather than by verification** (see below), and it exists
 * so the Match loop can be *measured* — accepted right, accepted wrong, parked
 * correctly, parked when the answer was there, not found wrongly. Nothing in
 * `src/` outside this file and `scripts/check-matches.ts` may read it, no Score
 * may move because of it, and no Match may be settled from it. That is the same
 * disclaimer `roster.ts` carries about its Category mapping, and for the same
 * reason: a plausibility judgement that quietly becomes an input is a fact
 * nobody sourced.
 *
 * **`confirmed` is `true` on every row, by the owner's instruction of
 * 2026-09-02 ("make the best assumptions for now").** A row stays true until a
 * person reviews it and says otherwise, and
 * `check-matches.ts` counts only confirmed rows in its headline. A scoreboard
 * that grades itself against its own guesses is not a measurement.
 *
 * ## What `expected` can say
 *
 * - `{ entityId, label }` — this entity is the right answer. `label` is the
 *   Sayari label as it stood when this was drafted, carried so a reader can see
 *   what was meant without a lookup; the `entityId` is what identifies it.
 * - `'parking_is_correct'` — the right company is **not among the Candidates**
 *   the loop returned, so `needs_review` or `not_found` is the honest outcome
 *   and accepting anything would be wrong. Gestamp is the measured instance.
 * - `'not_in_sayari'` — the company is believed absent from the graph
 *   altogether. Distinct from the above: parking is right there too, but for a
 *   different reason, and a later run with a different query might find it.
 *
 * ## How the drafting was bounded
 *
 * Read only from the development database's own rows — the Candidates every
 * Match recorded, the entity rows they point at, the cached `lei-records.byId`
 * bodies, and the cached `entity.getEntity` payloads' ownership edges. **No new
 * upstream call was made and no credit was spent**, which is also why a row
 * whose right answer is simply not on the Candidate list says
 * `'parking_is_correct'` rather than naming a company nothing here has seen.
 *
 * Where several Sayari records describe the same company — which is most rows,
 * and is what CONTEXT.md calls a *Twin* — the one carrying the **LEI that
 * GLEIF corroborates against the roster** is named, because that is the record
 * the app can prove the most about. `confidence` is `medium` wherever the
 * choice between Twins is the only thing in doubt, and `low` wherever the
 * company itself is.
 */

export type ExpectedMatch = {
  /** 1-based position in `ROSTER`. */
  rosterIndex: number;
  /** The roster name, repeated so this file reads without a join. */
  rosterName: string;
  expected: { entityId: string; label: string } | 'parking_is_correct' | 'not_in_sayari';
  /**
   * Sayari entity ids known, from the Candidates read when the row was drafted,
   * to describe the same legal entity as `expected` — the same company for the
   * truth set's purpose, a different record for the Match's. A settlement on
   * one is reported as *accepted a Twin*, never as right and never as wrong.
   */
  twins?: readonly string[];
  /**
   * `high` — an LEI GLEIF corroborates against the roster's own country and
   * city, or an address that matches the roster line outright.
   * `medium` — the company is not in doubt, the record is: several Twins carry
   * the same legal name and the choice between them rests on which one the app
   * can prove the most about.
   * `low` — the company itself is in doubt. Read the reason before using it.
   */
  confidence: 'high' | 'medium' | 'low';
  /** Why, in the evidence's own terms. Cites what was read, never a conclusion. */
  reason: string;
  /**
   * `true` once a person has confirmed the row. On 2026-09-02 the owner
   * instructed *"make the best assumptions for now"*, and every row was
   * confirmed on that basis after a read of the low- and medium-confidence
   * reasons and Candidates; one row (28, Flex-N-Gate) was corrected in the
   * same pass. A confirmation by assumption is still a confirmation, and
   * still a judgement: the write-up says so.
   */
  confirmed: boolean;
};

export const EXPECTED_MATCHES: readonly ExpectedMatch[] = [
  {
    rosterIndex: 1,
    rosterName: 'Bosch',
    expected: { entityId: 'vo4mAQFjLR-65BNY5iuM2g', label: 'ROBERT BOSCH GMBH' },
    confidence: 'high',
    reason:
      'LEI 529900F0LT5OP4SV6122; GLEIF registers it in DE and places its legal address in Gerlingen, which is the roster line. The other four Candidates are a Vietnamese subsidiary, two thin brand records and a Mexican Rexroth company.',
    confirmed: true,
  },
  {
    rosterIndex: 2,
    rosterName: 'Denso',
    expected: { entityId: 'LDOdUihYXLQICJqhNn4UHg', label: 'DENSO CORPORATION' },
    confidence: 'high',
    reason:
      'LEI 549300RYPA10CQM3QK38; GLEIF registers 株式会社デンソー in JP at KARIYA, which is the roster line. Two other Candidates carry the same legal name at Kariya without an LEI — Twins of this record.',
    confirmed: true,
  },
  {
    rosterIndex: 3,
    rosterName: 'ZF Friedrichshafen',
    expected: { entityId: '0jJrkmZO892Ic6Um6CCxqQ', label: 'ZF FRIEDRICHSHAFEN AG' },
    confidence: 'high',
    reason:
      'LEI 529900CAYOWB8YIG7X25; GLEIF registers ZF Friedrichshafen AG in DE at Friedrichshafen, which is the roster line. The record’s own `countries[0]` reads LTU, which is why the settled country is taken from GLEIF rather than the Profile.',
    confirmed: true,
  },
  {
    rosterIndex: 4,
    rosterName: 'Magna International',
    expected: { entityId: 'y44ED_pkty2NyDNUwouCFA', label: 'MAGNA INTERNATIONAL INC' },
    confidence: 'medium',
    reason:
      'LEI 95RWVLFZX6VGDZNNTN43; GLEIF registers MAGNA INTERNATIONAL INC. in CA-ON at AURORA, which is the roster line. Six further Candidates carry the same legal name at Aurora with no LEI; the choice between the Twins rests on the LEI alone.',
    confirmed: true,
  },
  {
    rosterIndex: 5,
    rosterName: 'Aisin',
    expected: { entityId: 'wJr4XYZgeHiTDN6l-hqKqQ', label: 'AISIN CORPORATION' },
    confidence: 'high',
    reason:
      'LEI 3538004IOK08PDY6I723; GLEIF registers 株式会社アイシン in JP at 愛知県 刈谷市 — Kariya, Aichi, the roster line. The alternative Candidate is the pre-rename AISIN SEIKI record.',
    confirmed: true,
  },
  {
    rosterIndex: 6,
    rosterName: 'Continental',
    expected: { entityId: 'IRelLN5vzraC-u7R9ZaYyQ', label: 'CONTINENTAL AG' },
    confidence: 'high',
    reason:
      'LEI 529900A7YD9C0LLXM621; GLEIF registers Continental Aktiengesellschaft in DE at Hannover, which is the roster line. The other Candidates are the aftermarket arm, an automotive-technologies subsidiary and a Thai company.',
    confirmed: true,
  },
  {
    rosterIndex: 7,
    rosterName: 'Hyundai Mobis',
    expected: { entityId: 'QKJjDK2j4C_xjstqLZbQ6Q', label: 'HYUNDAI MOBIS' },
    confidence: 'medium',
    reason:
      'LEI 988400HJA9E0ZVDHRS65; GLEIF registers 현대모비스(주) in KR at Seoul, which is the roster line. The record’s own `countries[0]` reads VNM. Three Twins carry the name in KOR with no LEI.',
    confirmed: true,
  },
  {
    rosterIndex: 8,
    rosterName: 'Lear',
    expected: { entityId: 'gC94jqVAt4yW_Ur9IBKLAA', label: 'LEAR CORPORATION' },
    confidence: 'medium',
    reason:
      'LEI 549300UPNBTXA1SYTQ33; GLEIF registers LEAR CORPORATION in US-DE with its headquarters at Southfield, which is the roster line — the legal address is the Delaware one. A second LEAR CORPORATION record sits at Southfield 48033-4248 with no LEI, and the choice between the two rests on the LEI.',
    confirmed: true,
  },
  {
    rosterIndex: 9,
    rosterName: 'Faurecia',
    expected: { entityId: 'Xrmmm_N5jUWd9q5m1IYEcg', label: 'Forvia SE' },
    confidence: 'medium',
    reason:
      'LEI 969500F0VMZLK2IULV85; GLEIF registers FORVIA in FR at NANTERRE, which is the roster line. Faurecia is FORVIA’s former name and Sayari’s own alias data carries it, so the rename is sourced rather than assumed (SPEC §6.6). Two FAURECIA records at Nanterre 92000 carry no LEI; the two other LEI-bearing Candidates are FAURECIA INVESTMENTS and FAURECIA VENTURES, which are not operating companies.',
    confirmed: true,
  },
  {
    rosterIndex: 10,
    rosterName: 'Valeo',
    expected: { entityId: '2j6mxlCk_CJutk7kq6YFcw', label: 'Valeo S.A.' },
    confidence: 'medium',
    reason:
      'LEI 5493006IH2N2WMIBB742; GLEIF registers VALEO in FR at PARIS. Worth a second look: VALEO BAYEN SAS (LEI 549300U28M3DEHW6K494, PARIS 17) is named for the roster’s own street, Rue Bayen, and VALEO FINANCE sits at the same postcode — one of the three is the building and one is the company.',
    confirmed: true,
  },
  {
    rosterIndex: 11,
    rosterName: 'Aptiv',
    expected: { entityId: 'gwg1HOY2I2JVBSfFjSmHNQ', label: 'Aptiv Corporation' },
    confidence: 'low',
    reason:
      'LEI 254900PNETKVRH3VS362; GLEIF registers APTIV LLC in US-DE at WILMINGTON with its headquarters in New York — neither is the roster’s Troy MI. A thin Candidate labelled APTIV does sit at Troy with the roster’s own street number (5725) and no LEI, and Aptiv PLC (LEI 254900HTTDFIJZ32GX53, Dublin) is the listed group parent, which the Identity Standard puts on the ownership hop. Which of the three is the contract counterparty is not settled by anything read here.',
    confirmed: true,
  },
  {
    rosterIndex: 12,
    rosterName: 'Yazaki',
    expected: { entityId: 'CX3012yTGIhgMxcZG6hgnA', label: '矢崎总业株式会社' },
    confidence: 'high',
    reason:
      'LEI 35380087YNQB9R822X46; GLEIF registers 矢崎総業株式会社 in JP at 東京都 港区 — Minato-ku, Tokyo — and this record carries the roster’s exact postcode 108-8333. The Latin-labelled Yazaki Corporation Twins sit at 108-0075, a different postcode.',
    confirmed: true,
  },
  {
    rosterIndex: 13,
    rosterName: 'Panasonic Automotive',
    expected: { entityId: 'Jj9e4e0z8LTbH3Wiurb54w', label: 'PANASONIC AUTOMOTIVE SYSTEMS CO.,LT' },
    twins: ['TIrVRi2ASLt1HGjZGg4rxw'],
    confidence: 'low',
    reason:
      'No Candidate is at the roster’s Osaka address (540-6207), which is a Panasonic group site rather than this company’s registered office. Two records carry the operating company’s legal name: this one at Yokohama 224-8520, and TIrVRi2ASLt1HGjZGg4rxw at Matsumoto City, which is a plant. Neither carries an LEI. The roster row may name the division rather than the legal entity, which is exactly what the Identity Standard forbids matching on.',
    confirmed: true,
  },
  {
    rosterIndex: 14,
    rosterName: 'Sumitomo Electric',
    expected: { entityId: 'T7qBN55xusEWli2X8gwSxw', label: 'SUMITOMO ELECTRIC INDUSTRIES,LTD' },
    confidence: 'high',
    reason:
      'LEI 5493005SP87FL5TOS202; GLEIF registers 住友電気工業株式会社 in JP at 大阪府 大阪市中央区 — Chuo-ku, Osaka, the roster line. The record’s own `countries[0]` reads SWE, which is finding 107’s measured case. Two of the other Candidates (Fine Polymer, Optifrontier) share the roster’s postcode 541-0041 and are different companies.',
    confirmed: true,
  },
  {
    rosterIndex: 15,
    rosterName: 'BASF',
    expected: { entityId: 'YYduGnnDHeKJiCm9mn0Jew', label: 'BASF SE' },
    confidence: 'medium',
    reason:
      'LEI 529900PM64WH8AF1E917; GLEIF registers BASF SE in DE at Ludwigshafen am Rhein, which is the roster line. Four further records carry the identical legal name at Ludwigshafen with no LEI — the widest Twin set on the roster, and the reason the gate now refuses this row.',
    confirmed: true,
  },
  {
    rosterIndex: 16,
    rosterName: 'Mahle',
    expected: { entityId: 'UAxRxWgh2i_-jbGE-MzNcA', label: '马勒有限公司' },
    confidence: 'medium',
    reason:
      'LEI 52990098TR1QJBWIYG58; GLEIF registers MAHLE GmbH in DE at Stuttgart, and this record lists PRAGSTRASSE STUTTGART 70376 — the roster line exactly. Its Sayari label is the Chinese rendering of MAHLE GmbH, so `name_cover` can only read it as unavailable. Three Latin-labelled MAHLE GMBH records carry the same Pragstrasse address and no LEI; any of them may be the better Profile to point at.',
    confirmed: true,
  },
  {
    rosterIndex: 17,
    rosterName: 'Schaeffler',
    expected: { entityId: 'Zut-uEpYFcwtVTb0jYb-Sg', label: 'Schaeffler AG' },
    confidence: 'high',
    reason:
      'LEI 549300Q7E782X7GC1P43; GLEIF registers Schaeffler AG in DE at Herzogenaurach, and this record carries the roster’s postcode 91074. INA-Holding Schaeffler is at the same address and is the group parent, which belongs on the ownership hop.',
    confirmed: true,
  },
  {
    rosterIndex: 18,
    rosterName: 'Yanfeng',
    expected: { entityId: 'W2YFHfhhljD8pimLnnk0tg', label: '延锋汽车饰件系统有限公司' },
    twins: ['NPll4sC0zEczebruZ-iS4w'],
    confidence: 'low',
    reason:
      'Two records carry the operating company’s exact Chinese legal name and neither carries an LEI: this one at 上海 201805 and NPll4sC0zEczebruZ-iS4w at a truncated city. Neither matches the roster’s 200235. The LEI-bearing Candidates are the group (雁峰集团有限公司, Wenzhou) and two other Shanghai companies. Nothing read here separates the two same-named records.',
    confirmed: true,
  },
  {
    rosterIndex: 19,
    rosterName: 'Adient',
    expected: { entityId: 'Cwblskur_znYxcm5yDLapQ', label: 'ADIENT US LLC' },
    confidence: 'medium',
    reason:
      'LEI 213800SOTRCDGZUHL712; GLEIF registers ADIENT US LLC in US-MI at PLYMOUTH, which is the roster line. Six further records carry the same legal name at Plymouth 48170 with no LEI.',
    confirmed: true,
  },
  {
    rosterIndex: 20,
    rosterName: 'ThyssenKrupp Automotive',
    expected: {
      entityId: 'wPC3qasn6QanH3SvlzWvzg',
      label: 'THYSSENKRUPP AUTOMOTIVE SYSTEMS GMBH',
    },
    confidence: 'high',
    reason:
      'LEI 549300AD0WFQSVMY2S48; GLEIF registers ThyssenKrupp Automotive Systems GmbH in DE at Essen, which is the roster line. thyssenkrupp AG (LEI 549300UDG16DOYUPR330) is the group parent and belongs on the ownership hop.',
    confirmed: true,
  },
  {
    rosterIndex: 21,
    rosterName: 'Gestamp',
    expected: 'parking_is_correct',
    confidence: 'high',
    reason:
      'Neither Gestamp Automoción S.A. nor any operating Gestamp company is among the four Candidates. What the loop returned is GESTAMP 2020 SL — a holding vehicle at the roster’s exact address, Calle Alfonso XII 16, 28014 Madrid — plus GESTAMP SOLAR and two unrelated Madrid companies. The right building holds the wrong company, which is the trap the Identity Standard names. Refusing is correct here and no credit was spent looking further.',
    confirmed: true,
  },
  {
    rosterIndex: 22,
    rosterName: 'Tenneco',
    expected: { entityId: 'S5rJs4KGxmk6-olqZuTTWw', label: 'TENNECO INC' },
    confidence: 'medium',
    reason:
      'LEI 549300U0EXXFAQFAD785; GLEIF registers TENNECO LLC in US-DE at WILMINGTON with its headquarters at Northville — the roster says Lake Forest IL. A Candidate labelled TENNECO (MUSA) does sit at LAKE FOREST 60045, the roster line, but reads as a trade-derived record rather than a legal entity.',
    confirmed: true,
  },
  {
    rosterIndex: 23,
    rosterName: 'Cummins',
    expected: { entityId: 'URF1IKUG8YI0klqX9km8kQ', label: 'CUMMINS INC.' },
    confidence: 'high',
    reason:
      'LEI ZUNI8PYC725B6H8JU438; GLEIF registers CUMMINS INC. in US-IN with its headquarters at Columbus, which is the roster line. The other Candidates are Atmus Filtration (a divested filtration business), a sales-and-service company and a UK-registered Cummins record.',
    confirmed: true,
  },
  {
    rosterIndex: 24,
    rosterName: 'Plastic Omnium',
    expected: { entityId: 'OpuOIgnYEwga7jepubTFgQ', label: 'COMPAGNIE PLASTIC OMNIUM' },
    confidence: 'high',
    reason:
      'LEI 9695001VLC2KYXX0DW73; GLEIF registers OPMOBILITY SE in FR at LYON, which is the roster line — Compagnie Plastic Omnium is OPmobility’s former name. The other Candidates are an exterior holding company, two Plastic Omnium service companies and an SMRC subsidiary.',
    confirmed: true,
  },
  {
    rosterIndex: 25,
    rosterName: 'Benteler Automotive',
    expected: { entityId: '_Hc2Y1aLaYkZA_DNnQaZGw', label: 'BENTELER AUTOMOBILTECHNIK GMBH' },
    confidence: 'medium',
    reason:
      'LEI 529900OJZL9OBBBIB336; GLEIF registers Benteler Automobiltechnik GmbH in DE at Paderborn, which is the roster line. Three further records carry the same legal name, one of them (mUBtDMcSXoZBjZcZi5QJpg) at the roster’s exact postcode 33104 with no LEI.',
    confirmed: true,
  },
  {
    rosterIndex: 26,
    rosterName: 'Brose',
    expected: { entityId: '8Fna1B9ZrytLgMFpUjWVBA', label: 'BROSE FAHRZEUGTEILE SE & CO.KG' },
    twins: ['DvSWZuRXAFi0U6xljx-JQw', 'l0tVwdW3_WKVNSFUVDNUUw'],
    confidence: 'low',
    reason:
      'The roster address is Max-Brose-Straße 1, 96450 Coburg, and three Candidates carry a Brose Fahrzeugteile legal name at Coburg 96450 with no LEI — this one, DvSWZuRXAFi0U6xljx-JQw and l0tVwdW3_WKVNSFUVDNUUw. The only Brose Fahrzeugteile record with an LEI (529900ZQ6DYC0ZUD9S28) is the Bamberg company, a different registered seat, and Brose SE (529900EX4MMSGGEYA696) is the group. Nothing read here separates the three Coburg records.',
    confirmed: true,
  },
  {
    rosterIndex: 27,
    rosterName: 'JTEKT',
    expected: { entityId: 'R1a1FJd0ecYumgFfxx0HGw', label: 'JTEKT CORPORATION' },
    twins: ['jAytS5--KS3lm3I2whrWtQ'],
    confidence: 'low',
    reason:
      'No Candidate is at the roster’s Nagoya address (450-8515). Two records carry the legal name JTEKT CORPORATION and neither has an LEI: this one at Kariya 448-8652, and jAytS5--KS3lm3I2whrWtQ at a truncated city with postcode 4480032 — the same Kariya postcode without its hyphen. They are almost certainly the same company; which record should be the Profile is not settled by anything read here.',
    confirmed: true,
  },
  {
    rosterIndex: 28,
    rosterName: 'Flex-N-Gate',
    expected: { entityId: '07zRxTFDUaxAHjHeDTCSWg', label: 'FLEX N GATE COVINGTON' },
    twins: ['BAX_tQm9fXltkk3ZkhTAVA'],
    confidence: 'medium',
    reason:
      'The one Candidate whose LEI GLEIF corroborates against the roster is 07zRxTFDUaxAHjHeDTCSWg — LEI 549300REAUV9ZD1VE488, which GLEIF names FLEX-N-GATE LLC in US-IL at URBANA, the roster’s own town — but Sayari labels that record FLEX N GATE COVINGTON, a plant. This record carries the parent’s legal name and sits at Troy MI. The label and the LEI point at different records, and neither is at 1306 East University Avenue. Confirmed on the LEI: GLEIF is the second witness and it names FLEX-N-GATE LLC at Urbana under that LEI, so the record carrying it is the registered entity whatever Sayari labelled it from a trade record; the settled Troy record is the group name at a plant address.',
    confirmed: true,
  },
  {
    rosterIndex: 29,
    rosterName: 'Nemak',
    expected: { entityId: 'D8GMaegMcydep5QWv6TXAw', label: 'NEMAK S A B DE C V' },
    confidence: 'high',
    reason:
      'LEI 5493000MY3DAIB0BP706; GLEIF registers NEMAK S A B DE C V in MX at Garcia, which is the roster line. A person settled this Match by hand; a Twin (rvEB1jlEZctwGy050XxP1w) carries the same name at Garcia 66000 without an LEI.',
    confirmed: true,
  },
  {
    rosterIndex: 30,
    rosterName: 'Infineon Technologies',
    expected: { entityId: '7wHV28d3Du8AJ11DaJfGig', label: 'INFINEON TECHNOLOGIES AG' },
    confidence: 'high',
    reason:
      'LEI TSI2PJM6EPETEQ4X1U25; GLEIF registers Infineon Technologies AG in DE at Neubiberg, which is the roster line. The other four Candidates are a holding company, two shelf companies and a subsidiary, all at Neubiberg 85579 — the right building holding several wrong companies.',
    confirmed: true,
  },
  {
    rosterIndex: 31,
    rosterName: 'Dana',
    expected: { entityId: 'HIlEEZJ1vDutRQaeuZMe4A', label: 'DANA INC' },
    confidence: 'high',
    reason:
      'LEI KVWHW7YLZPFJM8QYNJ51; GLEIF registers DANA INCORPORATED in US-DE with its headquarters at Maumee, which is the roster line. The Dana Limited records are a different legal entity at the same site.',
    confirmed: true,
  },
  {
    rosterIndex: 32,
    rosterName: 'Hyundai Wia',
    expected: { entityId: 'o9X2EBZaQ95AqbgpiRq24Q', label: 'HYUNDAI WIA CORPORATION' },
    confidence: 'medium',
    reason:
      'No Candidate carries an LEI, so there is no second witness at all. This record carries the exact legal name; the alternatives are the same name with the roster address run into it, the Korean-script rendering, and a WIA Machine Tools record at a different Changwon street.',
    confirmed: true,
  },
  {
    rosterIndex: 33,
    rosterName: 'NTN',
    expected: { entityId: 'jBqUJXlVjOrQq_tZ-cFdGg', label: 'NTN CORPORATION' },
    confidence: 'high',
    reason:
      'LEI 3538008XP7ZG9BKBQX64; GLEIF registers NTN株式会社 in JP at 大阪府 大阪市北区 — Kita-ku, Osaka, against a roster line reading Nishi-ku. Same city, different ward; the only other Candidates are a run-together address string and the French NTN-SNR company.',
    confirmed: true,
  },
  {
    rosterIndex: 34,
    rosterName: 'Hitachi Astemo',
    expected: { entityId: 'I8PT1Nf42AhzihboD48kbw', label: 'Astemo, Ltd.' },
    confidence: 'high',
    reason:
      'This record carries the roster’s exact city and postcode — Hitachinaka-shi 312-8503 — and Astemo is Hitachi Astemo’s current name. No Candidate carries an LEI, so this row could never have been auto-accepted.',
    confirmed: true,
  },
  {
    rosterIndex: 35,
    rosterName: 'Draexlmaier',
    expected: { entityId: 'jhcxo7mFapiYuPJ15pzwFg', label: 'LISA DRAEXLMAIER GMBH' },
    confidence: 'high',
    reason:
      'This record carries the roster’s exact city and postcode — Vilsbiburg 84137 — and the operating company’s legal name. The other Candidates are the DAS Draexlmaier automotive-systems companies at the same address. No LEI on any of them.',
    confirmed: true,
  },
  {
    rosterIndex: 36,
    rosterName: 'Marelli',
    expected: { entityId: 'cnxkWBpPiyYSJAGIvFtW-Q', label: 'マレリ株式会社' },
    confidence: 'low',
    reason:
      'This is the operating company’s Japanese legal name, but the record’s address reads Palm City FL — nothing like the roster’s Yokohama 236-8506. MARELLI HOLDINGS CO., LTD. (LEI 549300I3WCUJQQLV3R34, GLEIF さいたま市) is the group parent, which the Identity Standard puts on the ownership hop, and the Calsonic Kansei records are the pre-merger name.',
    confirmed: true,
  },
  {
    rosterIndex: 37,
    rosterName: 'Grupo Antolin',
    expected: { entityId: 'kCLoOQPGBWpe8s7URZe9dg', label: 'Grupo Antolin Irausa SA' },
    confidence: 'high',
    reason:
      'LEI 213800OILC5Q9AR63B63; GLEIF registers GRUPO ANTOLIN IRAUSA S.A. in ES at Burgos, which is the roster line. The record’s own `countries[0]` reads USA. GRUPO ANTOLIN HOLDCO SA is the group parent.',
    confirmed: true,
  },
  {
    rosterIndex: 38,
    rosterName: 'BorgWarner',
    expected: { entityId: '3zhlMxJKdLZUFanQ9cWOag', label: 'BORGWARNER INC' },
    confidence: 'high',
    reason:
      'LEI 549300DSFX2IE88NSX47; GLEIF registers BORGWARNER INC. in US-DE with its headquarters at Auburn Hills, which is the roster line. The other four Candidates are BorgWarner subsidiaries, three of which file the same Auburn Hills headquarters.',
    confirmed: true,
  },
  {
    rosterIndex: 39,
    rosterName: 'HELLA',
    expected: { entityId: 'hTIUags7DgyByDtAiPoByg', label: 'HELLA GMBH & CO. KGAA' },
    confidence: 'high',
    reason:
      'LEI 529900PLX4ADJFWIY024; GLEIF registers HELLA GmbH & Co. KGaA in DE at Lippstadt, which is the roster line. It is the only Candidate the loop returned for this row.',
    confirmed: true,
  },
  {
    rosterIndex: 40,
    rosterName: 'Samvardhana Motherson',
    expected: {
      entityId: '3ouiXnypOrUcKWoShN27SA',
      label: 'Samvardhana Motherson International Ltd.',
    },
    confidence: 'high',
    reason:
      'This record sits at NOIDA 201301 — the roster’s exact city and postcode — and carries LEI 335800C7BQ19CKG8GH63, which GLEIF registers in IN. The Match settled instead on SAMVARDHANA MOTHERSON ADSYS TECH LIMITED, a Delhi subsidiary owned by this company. A second record with the same legal name (OrR0rkX2CKFJc8NpiHWE-g) reads `inactive`.',
    confirmed: true,
  },
  {
    rosterIndex: 41,
    rosterName: 'Webasto',
    expected: { entityId: 'p1FpgtWzYV7UG-3VQjabJA', label: 'Webasto SE' },
    confidence: 'medium',
    reason:
      'LEI 529900O9AL7R1MJ20B61; GLEIF registers Webasto SE in DE at Stockdorf, which is the roster line, though the record’s own city reads Nürnberg. Two further Webasto SE records sit at Stockdorf 82131 with no LEI, and Webasto Thermo & Comfort SE (529900KE7ES0KRD0GX52) is a different company at the same address.',
    confirmed: true,
  },
  {
    rosterIndex: 42,
    rosterName: 'Toyoda Gosei',
    expected: { entityId: '1EUd63d83C4kfbkoO8e77w', label: 'TOYODA GOSEI COMPANY LIMITED' },
    confidence: 'high',
    reason:
      'LEI 353800ZV4HXVM4DWPO50; GLEIF registers 豊田合成株式会社 in JP at 愛知県 清須市 — Kiyosu, Aichi, the roster line. Both GLEIF cities are in Japanese script, which is why the LEI witness can now only read this row as unavailable. The other Candidates are the Czech, East Japan, Kyushu and South India subsidiaries.',
    confirmed: true,
  },
  {
    rosterIndex: 43,
    rosterName: 'DuPont',
    expected: { entityId: 'Iw-6_jOpFiwjVw-ap8-rjg', label: 'DuPont de Nemours, Inc.' },
    confidence: 'high',
    reason:
      'LEI 5493004JF0SDFLM8GD76; GLEIF registers DUPONT DE NEMOURS, INC. in US-DE at WILMINGTON, and this record carries the roster’s exact postcode 19805. E. I. du Pont de Nemours and Company (GLU7INWNWH88J9XBXD45) is the historic entity at 19898 and Corteva is the divested agriculture business.',
    confirmed: true,
  },
  {
    rosterIndex: 44,
    rosterName: 'GKN Automotive',
    expected: { entityId: 'pFxxi31oDDIX5TgC2bSy9g', label: 'Gkn Automotive Limited' },
    confidence: 'medium',
    reason:
      'No Candidate carries an LEI. This record has the operating company’s legal name at Birmingham B37 7YE; the roster’s Welwyn Garden City address is the group’s registered office rather than this company’s. Gkn Automotive Holdings Limited, at the same Birmingham postcode, is the holding company.',
    confirmed: true,
  },
  {
    rosterIndex: 45,
    rosterName: 'Eberspächer',
    expected: { entityId: 'glm7wwQo6tzxlvvQer9fjQ', label: 'Eberspächer Gruppe GmbH & Co. KG' },
    confidence: 'medium',
    reason:
      'LEI 529900TPI9K2ZCWZOW03; GLEIF registers Eberspächer Gruppe GmbH & Co. KG in DE at Esslingen am Neckar, which is the roster line. It is also the group, and six other Candidates sit at the same address — J. Eberspächer GmbH & Co. KG, the climate-control companies, a Beteiligungs-GmbH and an insurance-services company. Which of them the roster row means is a question about the roster, not about the graph.',
    confirmed: true,
  },
  {
    rosterIndex: 46,
    rosterName: 'Visteon',
    expected: { entityId: 'FpVm2HsNjl864tQHM-6vyA', label: 'VISTEON CORP' },
    confidence: 'high',
    reason:
      'LEI 549300MOVLYHRW4GGW78; GLEIF registers VISTEON CORPORATION in US-DE with its headquarters at Van Buren Township, which is the roster line. A Twin (b46CrSMh2JtKMLe016eScg) carries the same name at Van Buren Twp. 48111 with no LEI.',
    confirmed: true,
  },
  {
    rosterIndex: 47,
    rosterName: 'Meritor',
    expected: { entityId: '60ADOmPsqP_ouLbtcVxytA', label: 'MERITOR INC' },
    confidence: 'medium',
    reason:
      'LEI 5LTG829X630QFHTFBO82; GLEIF registers MERITOR, INC. in US-IN with its headquarters at Troy, which is the roster line. The record’s own `countries[0]` reads SGP. Four further records carry the same legal name at Troy 48084 with no LEI.',
    confirmed: true,
  },
  {
    rosterIndex: 48,
    rosterName: 'NSK',
    expected: { entityId: 'M_bKIsKm8M7jv0xju_VcAw', label: 'NSK LTD.' },
    confidence: 'medium',
    reason:
      'This record carries the roster’s exact city and postcode — Shinagawa-ku Tokyo 141-8560 — and a person settled the Match on it by hand. The LEI 353800FVQK6SULSPBC69, which GLEIF registers to 日本精工株式会社 in JP at 東京都 品川区 (Shinagawa-ku), sits on a different Sayari record labelled NSK LTD /ADR/ at Fukuoka; four more Twins share the roster postcode.',
    confirmed: true,
  },
  {
    rosterIndex: 49,
    rosterName: 'American Axle & Manufacturing',
    expected: { entityId: 'cAmnI92Pnaemjk7pVLfysw', label: 'AMERICAN AXLE & MANUFACTURING INC' },
    confidence: 'high',
    reason:
      'LEI RY5TAKFOBLDUGX31MS24; GLEIF registers AMERICAN AXLE & MANUFACTURING, INC. in US-DE with its headquarters at DETROIT, and this record lists ONE DAUCH DRIVE, DETROIT MI 48211 — the roster line, word for word. The Match settled instead on American Axle & Manufacturing (Thailand) Co., Ltd., which files the same Detroit plant among its addresses and whose own owner, in its Sayari payload, is this company.',
    confirmed: true,
  },
  {
    rosterIndex: 50,
    rosterName: 'Mando',
    expected: { entityId: 'qrvGp58mGO1h6d6t453diA', label: 'HL MANDO CORPORATION' },
    confidence: 'high',
    reason:
      'LEI 988400P5GM9DGVVOJQ79; GLEIF registers 에이치엘만도 주식회사 in KR at Pyeongtaek-si — HL Mando is Mando Corporation’s current name. The other three Candidates are the pre-rename Mando records and a run-together address string.',
    confirmed: true,
  },
];

/** The truth set by roster index, for `check-matches.ts`. */
export const EXPECTED_BY_INDEX: ReadonlyMap<number, ExpectedMatch> = new Map(
  EXPECTED_MATCHES.map((row) => [row.rosterIndex, row]),
);
