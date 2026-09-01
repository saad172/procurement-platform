/**
 * The approved demo Sourcing Program (SPEC §20, `docs/seed/demo-program.md`).
 *
 * Approved fixture data a human owns. It seeds at boot alongside the roster, so
 * the reviewer's first action is **Run**, not an import.
 *
 * Two things it deliberately is not: it is not derived from Sayari, and it
 * names no buyer company.
 */

export const PROGRAM = {
  name: 'MY2029 Crossover BEV — North America',
  /**
   * One importer for the whole Program. With P4 in Mexico this is an explicit
   * **proxy**, not a fact: parts delivered to Ramos Arizpe are not imported
   * into the US at all, so for those flows the tariff Criterion answers "what
   * would this content cost to bring into the Program's US side". A per-Plant
   * importer is reachable (WITS supports non-US reporters) and deferred.
   */
  importingCountry: 'USA',
  vehicleClass: 'Battery-electric midsize crossover, North American build',
  sourcingHorizon: 'Award decisions in FY2027 for a 2029 model year',
} as const;

/**
 * Four Plants, **all at `city` precision** (±5 km) and labelled as such,
 * because a city centroid is not a factory.
 *
 * P4 is the consequential one. It is what makes the single importing country a
 * simplification rather than a fact, and it is what makes "nearest Plant"
 * genuinely discriminate: Nemak (García, Nuevo León) sits ~60 km from it and
 * flips from worst-in-class to best-in-class, instead of every North American
 * row collapsing onto the Michigan cluster.
 */
export const PLANTS = [
  {
    code: 'P1',
    role: 'Final assembly + battery pack assembly',
    city: 'Spring Hill, Tennessee',
    country: 'USA',
    lat: 35.751,
    lon: -86.93,
  },
  {
    code: 'P2',
    role: 'Final assembly',
    city: 'Arlington, Texas',
    country: 'USA',
    lat: 32.736,
    lon: -97.108,
  },
  {
    code: 'P3',
    role: 'Stamping and structures',
    city: 'Lansing, Michigan',
    country: 'USA',
    lat: 42.733,
    lon: -84.556,
  },
  {
    code: 'P4',
    role: 'Final assembly + subassembly',
    city: 'Ramos Arizpe, Coahuila',
    country: 'MEX',
    lat: 25.542,
    lon: -100.956,
  },
] as const;

/**
 * Eight Categories, **every HS line verified against a live USITC HTS pull**.
 *
 * A Category carries several lines because the honest classification is often
 * ambiguous. `isDefault` names the line the Score uses; the others are what the
 * mandatory caveat sentence enumerates. Rates are the verified general (MFN)
 * rate, as a percentage.
 *
 * Two ambiguities the fresh pull closed, both worth keeping visible:
 *
 * - **The enclosure classification is cheap.** Whichever way an empty pack
 *   housing classifies, the rate lands in a 0.4-point band — so ENC gets a real
 *   number with a three-line caveat, rather than a manual-verify flag.
 * - **Battery thermal has a rate and it is the seed's highest.** `8419.50.10.00`
 *   ("brazed aluminum plate-fin heat exchangers") is 4.2%, while everything else
 *   under `8419.50` is Free — so THM must carry the sub-line, not the heading.
 *
 * Power semiconductors was offered and declined, so no Category here shows a
 * manual-verify flag and Infineon stays uncategorised.
 */
export const CATEGORIES = [
  {
    code: 'BAT',
    name: 'Battery pack assembly',
    note: 'The `.00.10` sub-line is literally "of a kind used as the primary source of electrical power for electrically powered vehicles". `.00.30` is stationary storage and is not this Category.',
    hsLines: [
      {
        hsCode: '8507.60.00.10',
        label: 'Lithium-ion batteries, primary source of electrical power for EVs',
        rate: 3.4,
        isDefault: true,
      },
    ],
  },
  {
    code: 'ENC',
    name: 'Battery enclosures & structural castings',
    note: 'Three candidate classifications in a 0.4-point band. The caveat sentence names all three.',
    hsLines: [
      {
        hsCode: '7616.99.51.60',
        label: 'Aluminium castings, other articles',
        rate: 2.5,
        isDefault: true,
      },
      { hsCode: '7326.90.86.88', label: 'Steel, other articles', rate: 2.9, isDefault: false },
      {
        hsCode: '8708.99.81',
        label: 'Recognisable vehicle part, other',
        rate: 2.5,
        isDefault: false,
        note: '8708.99 is a trap above 8 digits — its lines run Free to 2.5%. Never cache the 6-digit heading.',
      },
    ],
  },
  {
    code: 'HAR',
    name: 'Wire harnesses & electrical distribution',
    note: 'The highest baseline rate in the seed. Column 2 is 30% and is irrelevant here — no roster row is a General-Note-3(b) country.',
    hsLines: [
      {
        hsCode: '8544.30',
        label: 'Ignition wiring sets and other wiring sets for vehicles',
        rate: 5.0,
        isDefault: true,
      },
    ],
  },
  {
    code: 'PWR',
    name: 'Power electronics & traction inverters',
    note: 'Traction inverters fall to the residual "other" static-converter lines, Free at every 8-digit line checked.',
    hsLines: [{ hsCode: '8504.40', label: 'Static converters', rate: 0.0, isDefault: true }],
  },
  {
    code: 'THM',
    name: 'Thermal management systems',
    note: 'The battery cold-plate line is the seed’s highest verified rate, and it sits under a heading that is otherwise Free.',
    hsLines: [
      {
        hsCode: '8419.50.10.00',
        label: 'Brazed aluminium plate-fin heat exchangers (battery cold plates)',
        rate: 4.2,
        isDefault: true,
      },
      { hsCode: '8708.91', label: 'Radiators', rate: 2.5, isDefault: false },
      { hsCode: '8415.20', label: 'Cabin air conditioning', rate: 1.4, isDefault: false },
    ],
  },
  {
    code: 'SEA',
    name: 'Seating systems',
    note: 'The one heading cross-validated by two independent sources — HTS and WITS both returned 0%.',
    hsLines: [
      {
        hsCode: '9401.20',
        label: 'Seats of a kind used for motor vehicles',
        rate: 0.0,
        isDefault: true,
      },
    ],
  },
  {
    code: 'BRK',
    name: 'Braking & steering systems',
    note: 'A clean baseline pair — same rate for both halves, no sub-line trap.',
    hsLines: [
      { hsCode: '8708.30', label: 'Brakes and servo-brakes', rate: 2.5, isDefault: true },
      {
        hsCode: '8708.94',
        label: 'Steering wheels, columns and boxes',
        rate: 2.5,
        isDefault: false,
      },
    ],
  },
  {
    code: 'LGT',
    name: 'Exterior lighting & signaling',
    note: 'Two different general rates under one HS6. A headlamp and a turn signal are not the same tariff answer, so the Category resolves to the sub-line.',
    hsLines: [
      { hsCode: '8512.20', label: 'Lighting equipment', rate: 0.0, isDefault: true },
      { hsCode: '8512.20.40', label: 'Visual signaling equipment', rate: 2.5, isDefault: false },
    ],
  },
] as const;

/**
 * The six trade-action flags — **authored and never computed** (SPEC §7.2).
 *
 * Each keys on a fact the app does not have, which is exactly why it is a badge
 * beside the rate rather than an adjustment to it.
 */
export const TARIFF_FLAGS = [
  {
    key: 'section232_autos_parts',
    label: 'Section 232 — autos and parts (+25%)',
    whyNotARate:
      'USMCA-qualifying parts are exempt entirely on importer self-certification, and JPN / EU / KOR / GBR negotiated their own reduced rates. Whether it applies depends on facts this app does not have.',
    appliesToAllCategories: true,
  },
  {
    key: 'section232_steel_al',
    label: 'Section 232 — steel and aluminium',
    whyNotARate: 'Keyed on material content and melt-and-pour origin, not on the HS heading alone.',
    categories: ['ENC'],
  },
  {
    key: 'section301_forced_labor',
    label: 'Section 301 — forced labour action (July 2026)',
    whyNotARate:
      'Origin-keyed across ~60 economies. Of this roster only CHN and IND are plausibly in scope, so it rarely fires here.',
    countries: ['CHN', 'IND'],
  },
  {
    key: 'section301_china_legacy',
    label: 'Section 301 — legacy China action',
    whyNotARate: 'Origin-keyed, and its product lists do not map cleanly onto an HS heading.',
    countries: ['CHN'],
  },
  {
    key: 'usmca_eligible_but_unverified',
    label: 'USMCA eligible, unverified',
    whyNotARate:
      'Regional value content is not derivable from a registered address, and a US-importer duty says nothing about a Mexican entry. The most load-bearing flag in the seed.',
    countries: ['MEX', 'CAN'],
  },
  {
    key: 'adcvd_possible',
    label: 'AD/CVD order possible',
    whyNotARate:
      '779 active orders, none exposed by HS heading in any API. Out of scope for automated lookup.',
  },
] as const;

/**
 * The seven Criteria, six of which carry weight (SPEC §9.2).
 *
 * The weights here are the **final** vector, not the seed document's original
 * 25/15/15/15/10/10/10: Data confidence was demoted from a weighted Criterion
 * to a badge, and the remaining six were re-weighted to sum to 100.
 *
 * The demotion is the interesting part. As a scored Criterion, data confidence
 * penalises a Supplier for sitting in a thin registry — it takes points off for
 * what we do not know, and double-counts with country resilience. As a badge it
 * does something better: it **gates what may be called *clean***, so a
 * Supplier in a sparse registry loses Criteria to `unknown` instead of losing
 * points.
 */
export const CRITERIA = [
  {
    key: 'compliance_risk',
    label: 'Compliance risk',
    weight: 28,
    isWeighted: true,
    blurb:
      'Every entity-level risk factor except the country-derived ones, plus sanctioned / PEP / closed. The only Criterion where a single finding can be disqualifying rather than merely bad.',
  },
  {
    key: 'ownership_exposure',
    label: 'Ownership exposure',
    weight: 17,
    isWeighted: true,
    blurb:
      'Current one-hop owner edges with each owner’s own risk, state ownership, and the ownership-family `psa_` factors. Shared ownership between two bidders is a Shortlist finding, not an input here.',
  },
  {
    key: 'country_resilience',
    label: 'Country resilience',
    weight: 17,
    isWeighted: true,
    blurb:
      'World Bank LPI and five WGI dimensions for the resolved Profile’s country, on fixed scales. Discriminates weakly on a roster that is 43/50 G7 origins.',
  },
  {
    key: 'tariff_exposure',
    label: 'Tariff exposure',
    weight: 17,
    isWeighted: true,
    blurb:
      'The Category’s default HS line × the Profile’s country as origin × importer USA. Separates Categories rather than Suppliers, because MFN is origin-invariant across every roster country.',
  },
  {
    key: 'proximity',
    label: 'Proximity',
    weight: 11,
    isWeighted: true,
    blurb:
      'Great-circle distance from the Profile’s coordinates to the nearest Plant, linear-clamped at 8 000 km. Measured from a registered head office, which is not a factory.',
  },
  {
    key: 'media_signal',
    label: 'Media signal',
    weight: 10,
    isWeighted: true,
    blurb:
      'Sayari `negativeNews` on the resolved legal name, flag-weighted, plus the adverse-media risk family. Owns all adverse-media evidence so no fact is counted twice.',
  },
  {
    key: 'data_confidence',
    label: 'Data confidence',
    weight: 0,
    isWeighted: false,
    blurb:
      'A badge, never a Criterion: it adds no points and moves no rank. Its job is to gate what may be called *clean*, so a Supplier in a thin registry loses Criteria to `unknown` instead of losing points.',
  },
] as const;
