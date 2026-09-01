/**
 * The imported roster — 50 rows of `Sayari NAG List.xlsx`, the exercise's list_3.
 *
 * Generated from the workbook and checked against the approved seed
 * (`docs/seed/demo-program.md` §4) row for row: names and ISO3 countries agree,
 * and the Category counts come out at PWR 13 · BRK 10 · ENC 9 · THM 9 · LGT 7 ·
 * HAR 6 · SEA 6 · BAT 3, with 42 of 50 mapped.
 *
 * **Roster names are short trade names, not legal entity names.** That gap is
 * the whole point of the Match loop, not a defect in this data: row 1, "Bosch",
 * resolves to the divested Syntegon as Sayari's top hit.
 *
 * The Category mapping is a **hand-authored plausibility judgement** from
 * general industry knowledge. It is not derived from any source, it is
 * unverified against the suppliers' own materials, and **no app behaviour may
 * depend on it being right** — it exists so a Shortlist has something to rank.
 * That is also why `supplier_category` carries no provenance column.
 */

export type RosterRow = {
  /** 1-based position in the imported list. */
  index: number;
  name: string;
  address: string;
  /** ISO3, as the roster gives it. The *scored* country is the Profile's. */
  country: string;
  /** Category codes this Supplier plausibly bids on. Empty for eight rows. */
  categories: string[];
};

export const ROSTER: readonly RosterRow[] = [
  {
    index: 1,
    name: 'Bosch',
    address: 'Robert-Bosch-Platz 1 70839 Gerlingen',
    country: 'DEU',
    categories: ['BRK', 'PWR'],
  },
  {
    index: 2,
    name: 'Denso',
    address: '1-1 Showa-cho Kariya Aichi Prefecture 448-8661',
    country: 'JPN',
    categories: ['THM', 'PWR'],
  },
  {
    index: 3,
    name: 'ZF Friedrichshafen',
    address: 'Löwentaler Straße 20 88046 Friedrichshafen',
    country: 'DEU',
    categories: ['BRK', 'PWR'],
  },
  {
    index: 4,
    name: 'Magna International',
    address: '337 Magna Drive Aurora Ontario L4G 7K1',
    country: 'CAN',
    categories: ['ENC', 'SEA', 'PWR'],
  },
  {
    index: 5,
    name: 'Aisin',
    address: '2-1 Asahi-machi Kariya Aichi Prefecture 448-8650',
    country: 'JPN',
    categories: ['BRK', 'ENC'],
  },
  {
    index: 6,
    name: 'Continental',
    address: 'Vahrenwalder Straße 9 30165 Hannover',
    country: 'DEU',
    categories: ['BRK'],
  },
  {
    index: 7,
    name: 'Hyundai Mobis',
    address: '203 Teheran-ro Gangnam-gu Seoul',
    country: 'KOR',
    categories: ['BRK', 'PWR', 'LGT'],
  },
  {
    index: 8,
    name: 'Lear',
    address: '21557 Telegraph Road Southfield MI 48033',
    country: 'USA',
    categories: ['HAR', 'SEA'],
  },
  {
    index: 9,
    name: 'Faurecia',
    address: '23-27 Avenue des Champs Pierreux 92000 Nanterre',
    country: 'FRA',
    categories: ['SEA'],
  },
  {
    index: 10,
    name: 'Valeo',
    address: '43 Rue Bayen 75017 Paris',
    country: 'FRA',
    categories: ['THM', 'LGT', 'PWR'],
  },
  {
    index: 11,
    name: 'Aptiv',
    address: '5725 Innovation Drive Troy MI 48098',
    country: 'USA',
    categories: ['HAR'],
  },
  {
    index: 12,
    name: 'Yazaki',
    address: '17F Mita Kokusai Building 4-28 Mita 1-chome Minato-ku Tokyo 108-8333',
    country: 'JPN',
    categories: ['HAR'],
  },
  {
    index: 13,
    name: 'Panasonic Automotive',
    address: '2-1-61 Shiromi Chuo-ku Osaka 540-6207',
    country: 'JPN',
    categories: ['BAT'],
  },
  {
    index: 14,
    name: 'Sumitomo Electric',
    address: '5-33 Kitahama 4-chome Chuo-ku Osaka 541-0041',
    country: 'JPN',
    categories: ['HAR'],
  },
  {
    index: 15,
    name: 'BASF',
    address: 'Carl-Bosch-Straße 38 67056 Ludwigshafen am Rhein',
    country: 'DEU',
    categories: [],
  },
  {
    index: 16,
    name: 'Mahle',
    address: 'Pragstraße 26-46 70376 Stuttgart',
    country: 'DEU',
    categories: ['THM'],
  },
  {
    index: 17,
    name: 'Schaeffler',
    address: 'Industriestraße 1-3 91074 Herzogenaurach',
    country: 'DEU',
    categories: ['PWR'],
  },
  {
    index: 18,
    name: 'Yanfeng',
    address: '399 Liuzhou Road Xujiahui Shanghai 200235',
    country: 'CHN',
    categories: ['SEA'],
  },
  {
    index: 19,
    name: 'Adient',
    address: '49200 Halyard Drive Plymouth MI 48170',
    country: 'USA',
    categories: ['SEA'],
  },
  {
    index: 20,
    name: 'ThyssenKrupp Automotive',
    address: 'ThyssenKrupp Allee 1 45143 Essen',
    country: 'DEU',
    categories: ['ENC', 'BRK'],
  },
  {
    index: 21,
    name: 'Gestamp',
    address: 'Calle Alfonso XII 16 28014 Madrid',
    country: 'ESP',
    categories: ['ENC'],
  },
  {
    index: 22,
    name: 'Tenneco',
    address: '500 North Field Drive Lake Forest IL 60045',
    country: 'USA',
    categories: [],
  },
  {
    index: 23,
    name: 'Cummins',
    address: '500 Jackson Street Columbus IN 47201',
    country: 'USA',
    categories: ['PWR'],
  },
  {
    index: 24,
    name: 'Plastic Omnium',
    address: '19 Boulevard Jules Carteret 69007 Lyon',
    country: 'FRA',
    categories: ['ENC', 'LGT'],
  },
  {
    index: 25,
    name: 'Benteler Automotive',
    address: 'Residenzstraße 1 33104 Paderborn',
    country: 'DEU',
    categories: ['ENC'],
  },
  {
    index: 26,
    name: 'Brose',
    address: 'Max-Brose-Straße 1 96450 Coburg',
    country: 'DEU',
    categories: ['SEA', 'THM'],
  },
  {
    index: 27,
    name: 'JTEKT',
    address: '15th Floor Midland Square 4-7-1 Meieki Nakamura-ku Nagoya Aichi 450-8515',
    country: 'JPN',
    categories: ['BRK'],
  },
  {
    index: 28,
    name: 'Flex-N-Gate',
    address: '1306 East University Avenue Urbana IL 61802',
    country: 'USA',
    categories: ['ENC', 'LGT'],
  },
  {
    index: 29,
    name: 'Nemak',
    address: 'Libramiento Arco Vial Km. 3.8 66000 García Nuevo León',
    country: 'MEX',
    categories: ['ENC'],
  },
  {
    index: 30,
    name: 'Infineon Technologies',
    address: 'Am Campeon 1-15 85579 Neubiberg',
    country: 'DEU',
    categories: [],
  },
  {
    index: 31,
    name: 'Dana',
    address: '3939 Technology Drive Maumee OH 43537',
    country: 'USA',
    categories: ['PWR', 'THM'],
  },
  {
    index: 32,
    name: 'Hyundai Wia',
    address: '153 Jeongdong-ro Seongsan-gu Changwon-si Gyeongsangnam-do',
    country: 'KOR',
    categories: ['THM'],
  },
  {
    index: 33,
    name: 'NTN',
    address: '3-17-1 Kyomachibori Nishi-ku Osaka-shi Osaka 550-0003',
    country: 'JPN',
    categories: [],
  },
  {
    index: 34,
    name: 'Hitachi Astemo',
    address: '2520 Takaba Hitachinaka-shi Ibaraki 312-8503',
    country: 'JPN',
    categories: ['BRK', 'PWR'],
  },
  {
    index: 35,
    name: 'Draexlmaier',
    address: 'Landshuter Straße 100 84137 Vilsbiburg',
    country: 'DEU',
    categories: ['HAR', 'BAT'],
  },
  {
    index: 36,
    name: 'Marelli',
    address: '1-11 Sachiura Kanazawa-ku Yokohama Kanagawa 236-8506',
    country: 'JPN',
    categories: ['LGT'],
  },
  {
    index: 37,
    name: 'Grupo Antolin',
    address: 'Ctra. Madrid-Irún Km. 244.8 09007 Burgos',
    country: 'ESP',
    categories: [],
  },
  {
    index: 38,
    name: 'BorgWarner',
    address: '3850 Hamlin Road Auburn Hills MI 48326',
    country: 'USA',
    categories: ['PWR', 'THM'],
  },
  {
    index: 39,
    name: 'HELLA',
    address: 'Rixbecker Straße 75 59552 Lippstadt',
    country: 'DEU',
    categories: ['LGT'],
  },
  {
    index: 40,
    name: 'Samvardhana Motherson',
    address: 'Plot No. 1 Sector 127 Noida-Greater Noida Expressway Noida 201301',
    country: 'IND',
    categories: ['HAR'],
  },
  {
    index: 41,
    name: 'Webasto',
    address: 'Kraillinger Straße 5 82131 Stockdorf',
    country: 'DEU',
    categories: ['BAT', 'THM'],
  },
  {
    index: 42,
    name: 'Toyoda Gosei',
    address: '1 Haruhinagahata Kiyosu Aichi 452-8564',
    country: 'JPN',
    categories: ['LGT'],
  },
  {
    index: 43,
    name: 'DuPont',
    address: '974 Centre Road Wilmington DE 19805',
    country: 'USA',
    categories: [],
  },
  {
    index: 44,
    name: 'GKN Automotive',
    address: '2 Falcon Gate Shire Park Welwyn Garden City Hertfordshire AL7 1TW',
    country: 'GBR',
    categories: ['PWR'],
  },
  {
    index: 45,
    name: 'Eberspächer',
    address: 'Eberspächerstraße 24 73730 Esslingen am Neckar',
    country: 'DEU',
    categories: ['THM'],
  },
  {
    index: 46,
    name: 'Visteon',
    address: 'One Village Center Drive Van Buren Township MI 48111',
    country: 'USA',
    categories: [],
  },
  {
    index: 47,
    name: 'Meritor',
    address: '2135 West Maple Road Troy MI 48084',
    country: 'USA',
    categories: [],
  },
  {
    index: 48,
    name: 'NSK',
    address: 'Nissei Building 1-6-3 Ohsaki Shinagawa-ku Tokyo 141-8560',
    country: 'JPN',
    categories: ['BRK'],
  },
  {
    index: 49,
    name: 'American Axle & Manufacturing',
    address: 'One Dauch Drive Detroit MI 48211',
    country: 'USA',
    categories: ['PWR', 'ENC'],
  },
  {
    index: 50,
    name: 'Mando',
    address: '21 Pangyo-ro 255beon-gil Bundang-gu Seongnam-si Gyeonggi-do',
    country: 'KOR',
    categories: ['BRK'],
  },
];

/**
 * The eight Suppliers deliberately kept with no Category (SPEC §20).
 *
 * They stay in the Program, walk the whole lifecycle, and reach no Shortlist.
 * Two reasons: it is the honest shape of a real roster, and it exercises a
 * state the data model must handle — a Supplier with Criterion values, an
 * Assessment, and no Score at all.
 */
export const UNCATEGORISED_SUPPLIERS = ROSTER.filter((r) => r.categories.length === 0).map(
  (r) => r.name,
);
