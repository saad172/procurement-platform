/**
 * ISO 3166-1 — alpha-2, alpha-3 and the English short name, complete.
 *
 * ## Why the whole table rather than the eleven origins the roster carries
 *
 * `src/upstream/endpoints.ts` held an eleven-entry `iso3ToIso2` map, and its own
 * comment argued that a partial table returning `undefined` is safer than a full
 * one nobody checks — true of the GLEIF country *filter*, whose failure mode is
 * a dropped filter. It stopped being true the moment two other checks needed the
 * same knowledge and could not get it:
 *
 * - the **LEI witness** compares GLEIF's `jurisdiction` — an ISO 3166-2 code
 *   like `US-DE`, or an alpha-2 like `TH` — against the roster's alpha-3
 *   (SPEC §6.2). A Thai subsidiary filing its American parent's headquarters
 *   passes every address check there is; the jurisdiction is the one field that
 *   separates them, and it cannot be read without the mapping.
 * - **`name_cover`** has to recognise a country or nationality word standing in
 *   a Candidate's surplus name tokens — `(Thailand)`, `de Mexico` — because that
 *   word is usually the whole difference between a parent and its subsidiary.
 *
 * Both of those are decisions about identity, where an unknown code must not
 * quietly read as agreement. So the table is complete and `undefined` means
 * *this is not a country code*, rather than *this is not one of ours*.
 *
 * ## What is deliberately not here
 *
 * No sub-division names, no historical codes (`SU`, `YU`, `ZR`), no numeric
 * codes. Nothing in this build reads any of them, and a code that is not current
 * arriving from GLEIF or Sayari should be `undefined` rather than resolved.
 */

export type Iso3166Country = {
  /** ISO 3166-1 alpha-2, e.g. `DE`. */
  alpha2: string;
  /** ISO 3166-1 alpha-3, e.g. `DEU`. The form the roster and Sayari both use. */
  alpha3: string;
  /** The English short name, as ISO gives it. */
  name: string;
};

/** ISO 3166-1, current as of the 2026 list. 249 entries. */
export const ISO_3166_COUNTRIES: readonly Iso3166Country[] = [
  { alpha2: 'AF', alpha3: 'AFG', name: 'Afghanistan' },
  { alpha2: 'AX', alpha3: 'ALA', name: 'Åland Islands' },
  { alpha2: 'AL', alpha3: 'ALB', name: 'Albania' },
  { alpha2: 'DZ', alpha3: 'DZA', name: 'Algeria' },
  { alpha2: 'AS', alpha3: 'ASM', name: 'American Samoa' },
  { alpha2: 'AD', alpha3: 'AND', name: 'Andorra' },
  { alpha2: 'AO', alpha3: 'AGO', name: 'Angola' },
  { alpha2: 'AI', alpha3: 'AIA', name: 'Anguilla' },
  { alpha2: 'AQ', alpha3: 'ATA', name: 'Antarctica' },
  { alpha2: 'AG', alpha3: 'ATG', name: 'Antigua and Barbuda' },
  { alpha2: 'AR', alpha3: 'ARG', name: 'Argentina' },
  { alpha2: 'AM', alpha3: 'ARM', name: 'Armenia' },
  { alpha2: 'AW', alpha3: 'ABW', name: 'Aruba' },
  { alpha2: 'AU', alpha3: 'AUS', name: 'Australia' },
  { alpha2: 'AT', alpha3: 'AUT', name: 'Austria' },
  { alpha2: 'AZ', alpha3: 'AZE', name: 'Azerbaijan' },
  { alpha2: 'BS', alpha3: 'BHS', name: 'Bahamas' },
  { alpha2: 'BH', alpha3: 'BHR', name: 'Bahrain' },
  { alpha2: 'BD', alpha3: 'BGD', name: 'Bangladesh' },
  { alpha2: 'BB', alpha3: 'BRB', name: 'Barbados' },
  { alpha2: 'BY', alpha3: 'BLR', name: 'Belarus' },
  { alpha2: 'BE', alpha3: 'BEL', name: 'Belgium' },
  { alpha2: 'BZ', alpha3: 'BLZ', name: 'Belize' },
  { alpha2: 'BJ', alpha3: 'BEN', name: 'Benin' },
  { alpha2: 'BM', alpha3: 'BMU', name: 'Bermuda' },
  { alpha2: 'BT', alpha3: 'BTN', name: 'Bhutan' },
  { alpha2: 'BO', alpha3: 'BOL', name: 'Bolivia' },
  { alpha2: 'BQ', alpha3: 'BES', name: 'Bonaire, Sint Eustatius and Saba' },
  { alpha2: 'BA', alpha3: 'BIH', name: 'Bosnia and Herzegovina' },
  { alpha2: 'BW', alpha3: 'BWA', name: 'Botswana' },
  { alpha2: 'BV', alpha3: 'BVT', name: 'Bouvet Island' },
  { alpha2: 'BR', alpha3: 'BRA', name: 'Brazil' },
  { alpha2: 'IO', alpha3: 'IOT', name: 'British Indian Ocean Territory' },
  { alpha2: 'BN', alpha3: 'BRN', name: 'Brunei Darussalam' },
  { alpha2: 'BG', alpha3: 'BGR', name: 'Bulgaria' },
  { alpha2: 'BF', alpha3: 'BFA', name: 'Burkina Faso' },
  { alpha2: 'BI', alpha3: 'BDI', name: 'Burundi' },
  { alpha2: 'CV', alpha3: 'CPV', name: 'Cabo Verde' },
  { alpha2: 'KH', alpha3: 'KHM', name: 'Cambodia' },
  { alpha2: 'CM', alpha3: 'CMR', name: 'Cameroon' },
  { alpha2: 'CA', alpha3: 'CAN', name: 'Canada' },
  { alpha2: 'KY', alpha3: 'CYM', name: 'Cayman Islands' },
  { alpha2: 'CF', alpha3: 'CAF', name: 'Central African Republic' },
  { alpha2: 'TD', alpha3: 'TCD', name: 'Chad' },
  { alpha2: 'CL', alpha3: 'CHL', name: 'Chile' },
  { alpha2: 'CN', alpha3: 'CHN', name: 'China' },
  { alpha2: 'CX', alpha3: 'CXR', name: 'Christmas Island' },
  { alpha2: 'CC', alpha3: 'CCK', name: 'Cocos (Keeling) Islands' },
  { alpha2: 'CO', alpha3: 'COL', name: 'Colombia' },
  { alpha2: 'KM', alpha3: 'COM', name: 'Comoros' },
  { alpha2: 'CD', alpha3: 'COD', name: 'Congo, Democratic Republic of the' },
  { alpha2: 'CG', alpha3: 'COG', name: 'Congo' },
  { alpha2: 'CK', alpha3: 'COK', name: 'Cook Islands' },
  { alpha2: 'CR', alpha3: 'CRI', name: 'Costa Rica' },
  { alpha2: 'CI', alpha3: 'CIV', name: "Côte d'Ivoire" },
  { alpha2: 'HR', alpha3: 'HRV', name: 'Croatia' },
  { alpha2: 'CU', alpha3: 'CUB', name: 'Cuba' },
  { alpha2: 'CW', alpha3: 'CUW', name: 'Curaçao' },
  { alpha2: 'CY', alpha3: 'CYP', name: 'Cyprus' },
  { alpha2: 'CZ', alpha3: 'CZE', name: 'Czechia' },
  { alpha2: 'DK', alpha3: 'DNK', name: 'Denmark' },
  { alpha2: 'DJ', alpha3: 'DJI', name: 'Djibouti' },
  { alpha2: 'DM', alpha3: 'DMA', name: 'Dominica' },
  { alpha2: 'DO', alpha3: 'DOM', name: 'Dominican Republic' },
  { alpha2: 'EC', alpha3: 'ECU', name: 'Ecuador' },
  { alpha2: 'EG', alpha3: 'EGY', name: 'Egypt' },
  { alpha2: 'SV', alpha3: 'SLV', name: 'El Salvador' },
  { alpha2: 'GQ', alpha3: 'GNQ', name: 'Equatorial Guinea' },
  { alpha2: 'ER', alpha3: 'ERI', name: 'Eritrea' },
  { alpha2: 'EE', alpha3: 'EST', name: 'Estonia' },
  { alpha2: 'SZ', alpha3: 'SWZ', name: 'Eswatini' },
  { alpha2: 'ET', alpha3: 'ETH', name: 'Ethiopia' },
  { alpha2: 'FK', alpha3: 'FLK', name: 'Falkland Islands' },
  { alpha2: 'FO', alpha3: 'FRO', name: 'Faroe Islands' },
  { alpha2: 'FJ', alpha3: 'FJI', name: 'Fiji' },
  { alpha2: 'FI', alpha3: 'FIN', name: 'Finland' },
  { alpha2: 'FR', alpha3: 'FRA', name: 'France' },
  { alpha2: 'GF', alpha3: 'GUF', name: 'French Guiana' },
  { alpha2: 'PF', alpha3: 'PYF', name: 'French Polynesia' },
  { alpha2: 'TF', alpha3: 'ATF', name: 'French Southern Territories' },
  { alpha2: 'GA', alpha3: 'GAB', name: 'Gabon' },
  { alpha2: 'GM', alpha3: 'GMB', name: 'Gambia' },
  { alpha2: 'GE', alpha3: 'GEO', name: 'Georgia' },
  { alpha2: 'DE', alpha3: 'DEU', name: 'Germany' },
  { alpha2: 'GH', alpha3: 'GHA', name: 'Ghana' },
  { alpha2: 'GI', alpha3: 'GIB', name: 'Gibraltar' },
  { alpha2: 'GR', alpha3: 'GRC', name: 'Greece' },
  { alpha2: 'GL', alpha3: 'GRL', name: 'Greenland' },
  { alpha2: 'GD', alpha3: 'GRD', name: 'Grenada' },
  { alpha2: 'GP', alpha3: 'GLP', name: 'Guadeloupe' },
  { alpha2: 'GU', alpha3: 'GUM', name: 'Guam' },
  { alpha2: 'GT', alpha3: 'GTM', name: 'Guatemala' },
  { alpha2: 'GG', alpha3: 'GGY', name: 'Guernsey' },
  { alpha2: 'GN', alpha3: 'GIN', name: 'Guinea' },
  { alpha2: 'GW', alpha3: 'GNB', name: 'Guinea-Bissau' },
  { alpha2: 'GY', alpha3: 'GUY', name: 'Guyana' },
  { alpha2: 'HT', alpha3: 'HTI', name: 'Haiti' },
  { alpha2: 'HM', alpha3: 'HMD', name: 'Heard Island and McDonald Islands' },
  { alpha2: 'VA', alpha3: 'VAT', name: 'Holy See' },
  { alpha2: 'HN', alpha3: 'HND', name: 'Honduras' },
  { alpha2: 'HK', alpha3: 'HKG', name: 'Hong Kong' },
  { alpha2: 'HU', alpha3: 'HUN', name: 'Hungary' },
  { alpha2: 'IS', alpha3: 'ISL', name: 'Iceland' },
  { alpha2: 'IN', alpha3: 'IND', name: 'India' },
  { alpha2: 'ID', alpha3: 'IDN', name: 'Indonesia' },
  { alpha2: 'IR', alpha3: 'IRN', name: 'Iran' },
  { alpha2: 'IQ', alpha3: 'IRQ', name: 'Iraq' },
  { alpha2: 'IE', alpha3: 'IRL', name: 'Ireland' },
  { alpha2: 'IM', alpha3: 'IMN', name: 'Isle of Man' },
  { alpha2: 'IL', alpha3: 'ISR', name: 'Israel' },
  { alpha2: 'IT', alpha3: 'ITA', name: 'Italy' },
  { alpha2: 'JM', alpha3: 'JAM', name: 'Jamaica' },
  { alpha2: 'JP', alpha3: 'JPN', name: 'Japan' },
  { alpha2: 'JE', alpha3: 'JEY', name: 'Jersey' },
  { alpha2: 'JO', alpha3: 'JOR', name: 'Jordan' },
  { alpha2: 'KZ', alpha3: 'KAZ', name: 'Kazakhstan' },
  { alpha2: 'KE', alpha3: 'KEN', name: 'Kenya' },
  { alpha2: 'KI', alpha3: 'KIR', name: 'Kiribati' },
  { alpha2: 'KP', alpha3: 'PRK', name: "Korea, Democratic People's Republic of" },
  { alpha2: 'KR', alpha3: 'KOR', name: 'Korea, Republic of' },
  { alpha2: 'KW', alpha3: 'KWT', name: 'Kuwait' },
  { alpha2: 'KG', alpha3: 'KGZ', name: 'Kyrgyzstan' },
  { alpha2: 'LA', alpha3: 'LAO', name: "Lao People's Democratic Republic" },
  { alpha2: 'LV', alpha3: 'LVA', name: 'Latvia' },
  { alpha2: 'LB', alpha3: 'LBN', name: 'Lebanon' },
  { alpha2: 'LS', alpha3: 'LSO', name: 'Lesotho' },
  { alpha2: 'LR', alpha3: 'LBR', name: 'Liberia' },
  { alpha2: 'LY', alpha3: 'LBY', name: 'Libya' },
  { alpha2: 'LI', alpha3: 'LIE', name: 'Liechtenstein' },
  { alpha2: 'LT', alpha3: 'LTU', name: 'Lithuania' },
  { alpha2: 'LU', alpha3: 'LUX', name: 'Luxembourg' },
  { alpha2: 'MO', alpha3: 'MAC', name: 'Macao' },
  { alpha2: 'MG', alpha3: 'MDG', name: 'Madagascar' },
  { alpha2: 'MW', alpha3: 'MWI', name: 'Malawi' },
  { alpha2: 'MY', alpha3: 'MYS', name: 'Malaysia' },
  { alpha2: 'MV', alpha3: 'MDV', name: 'Maldives' },
  { alpha2: 'ML', alpha3: 'MLI', name: 'Mali' },
  { alpha2: 'MT', alpha3: 'MLT', name: 'Malta' },
  { alpha2: 'MH', alpha3: 'MHL', name: 'Marshall Islands' },
  { alpha2: 'MQ', alpha3: 'MTQ', name: 'Martinique' },
  { alpha2: 'MR', alpha3: 'MRT', name: 'Mauritania' },
  { alpha2: 'MU', alpha3: 'MUS', name: 'Mauritius' },
  { alpha2: 'YT', alpha3: 'MYT', name: 'Mayotte' },
  { alpha2: 'MX', alpha3: 'MEX', name: 'Mexico' },
  { alpha2: 'FM', alpha3: 'FSM', name: 'Micronesia' },
  { alpha2: 'MD', alpha3: 'MDA', name: 'Moldova' },
  { alpha2: 'MC', alpha3: 'MCO', name: 'Monaco' },
  { alpha2: 'MN', alpha3: 'MNG', name: 'Mongolia' },
  { alpha2: 'ME', alpha3: 'MNE', name: 'Montenegro' },
  { alpha2: 'MS', alpha3: 'MSR', name: 'Montserrat' },
  { alpha2: 'MA', alpha3: 'MAR', name: 'Morocco' },
  { alpha2: 'MZ', alpha3: 'MOZ', name: 'Mozambique' },
  { alpha2: 'MM', alpha3: 'MMR', name: 'Myanmar' },
  { alpha2: 'NA', alpha3: 'NAM', name: 'Namibia' },
  { alpha2: 'NR', alpha3: 'NRU', name: 'Nauru' },
  { alpha2: 'NP', alpha3: 'NPL', name: 'Nepal' },
  { alpha2: 'NL', alpha3: 'NLD', name: 'Netherlands' },
  { alpha2: 'NC', alpha3: 'NCL', name: 'New Caledonia' },
  { alpha2: 'NZ', alpha3: 'NZL', name: 'New Zealand' },
  { alpha2: 'NI', alpha3: 'NIC', name: 'Nicaragua' },
  { alpha2: 'NE', alpha3: 'NER', name: 'Niger' },
  { alpha2: 'NG', alpha3: 'NGA', name: 'Nigeria' },
  { alpha2: 'NU', alpha3: 'NIU', name: 'Niue' },
  { alpha2: 'NF', alpha3: 'NFK', name: 'Norfolk Island' },
  { alpha2: 'MK', alpha3: 'MKD', name: 'North Macedonia' },
  { alpha2: 'MP', alpha3: 'MNP', name: 'Northern Mariana Islands' },
  { alpha2: 'NO', alpha3: 'NOR', name: 'Norway' },
  { alpha2: 'OM', alpha3: 'OMN', name: 'Oman' },
  { alpha2: 'PK', alpha3: 'PAK', name: 'Pakistan' },
  { alpha2: 'PW', alpha3: 'PLW', name: 'Palau' },
  { alpha2: 'PS', alpha3: 'PSE', name: 'Palestine' },
  { alpha2: 'PA', alpha3: 'PAN', name: 'Panama' },
  { alpha2: 'PG', alpha3: 'PNG', name: 'Papua New Guinea' },
  { alpha2: 'PY', alpha3: 'PRY', name: 'Paraguay' },
  { alpha2: 'PE', alpha3: 'PER', name: 'Peru' },
  { alpha2: 'PH', alpha3: 'PHL', name: 'Philippines' },
  { alpha2: 'PN', alpha3: 'PCN', name: 'Pitcairn' },
  { alpha2: 'PL', alpha3: 'POL', name: 'Poland' },
  { alpha2: 'PT', alpha3: 'PRT', name: 'Portugal' },
  { alpha2: 'PR', alpha3: 'PRI', name: 'Puerto Rico' },
  { alpha2: 'QA', alpha3: 'QAT', name: 'Qatar' },
  { alpha2: 'RE', alpha3: 'REU', name: 'Réunion' },
  { alpha2: 'RO', alpha3: 'ROU', name: 'Romania' },
  { alpha2: 'RU', alpha3: 'RUS', name: 'Russian Federation' },
  { alpha2: 'RW', alpha3: 'RWA', name: 'Rwanda' },
  { alpha2: 'BL', alpha3: 'BLM', name: 'Saint Barthélemy' },
  { alpha2: 'SH', alpha3: 'SHN', name: 'Saint Helena, Ascension and Tristan da Cunha' },
  { alpha2: 'KN', alpha3: 'KNA', name: 'Saint Kitts and Nevis' },
  { alpha2: 'LC', alpha3: 'LCA', name: 'Saint Lucia' },
  { alpha2: 'MF', alpha3: 'MAF', name: 'Saint Martin' },
  { alpha2: 'PM', alpha3: 'SPM', name: 'Saint Pierre and Miquelon' },
  { alpha2: 'VC', alpha3: 'VCT', name: 'Saint Vincent and the Grenadines' },
  { alpha2: 'WS', alpha3: 'WSM', name: 'Samoa' },
  { alpha2: 'SM', alpha3: 'SMR', name: 'San Marino' },
  { alpha2: 'ST', alpha3: 'STP', name: 'Sao Tome and Principe' },
  { alpha2: 'SA', alpha3: 'SAU', name: 'Saudi Arabia' },
  { alpha2: 'SN', alpha3: 'SEN', name: 'Senegal' },
  { alpha2: 'RS', alpha3: 'SRB', name: 'Serbia' },
  { alpha2: 'SC', alpha3: 'SYC', name: 'Seychelles' },
  { alpha2: 'SL', alpha3: 'SLE', name: 'Sierra Leone' },
  { alpha2: 'SG', alpha3: 'SGP', name: 'Singapore' },
  { alpha2: 'SX', alpha3: 'SXM', name: 'Sint Maarten' },
  { alpha2: 'SK', alpha3: 'SVK', name: 'Slovakia' },
  { alpha2: 'SI', alpha3: 'SVN', name: 'Slovenia' },
  { alpha2: 'SB', alpha3: 'SLB', name: 'Solomon Islands' },
  { alpha2: 'SO', alpha3: 'SOM', name: 'Somalia' },
  { alpha2: 'ZA', alpha3: 'ZAF', name: 'South Africa' },
  { alpha2: 'GS', alpha3: 'SGS', name: 'South Georgia and the South Sandwich Islands' },
  { alpha2: 'SS', alpha3: 'SSD', name: 'South Sudan' },
  { alpha2: 'ES', alpha3: 'ESP', name: 'Spain' },
  { alpha2: 'LK', alpha3: 'LKA', name: 'Sri Lanka' },
  { alpha2: 'SD', alpha3: 'SDN', name: 'Sudan' },
  { alpha2: 'SR', alpha3: 'SUR', name: 'Suriname' },
  { alpha2: 'SJ', alpha3: 'SJM', name: 'Svalbard and Jan Mayen' },
  { alpha2: 'SE', alpha3: 'SWE', name: 'Sweden' },
  { alpha2: 'CH', alpha3: 'CHE', name: 'Switzerland' },
  { alpha2: 'SY', alpha3: 'SYR', name: 'Syrian Arab Republic' },
  { alpha2: 'TW', alpha3: 'TWN', name: 'Taiwan' },
  { alpha2: 'TJ', alpha3: 'TJK', name: 'Tajikistan' },
  { alpha2: 'TZ', alpha3: 'TZA', name: 'Tanzania' },
  { alpha2: 'TH', alpha3: 'THA', name: 'Thailand' },
  { alpha2: 'TL', alpha3: 'TLS', name: 'Timor-Leste' },
  { alpha2: 'TG', alpha3: 'TGO', name: 'Togo' },
  { alpha2: 'TK', alpha3: 'TKL', name: 'Tokelau' },
  { alpha2: 'TO', alpha3: 'TON', name: 'Tonga' },
  { alpha2: 'TT', alpha3: 'TTO', name: 'Trinidad and Tobago' },
  { alpha2: 'TN', alpha3: 'TUN', name: 'Tunisia' },
  { alpha2: 'TR', alpha3: 'TUR', name: 'Türkiye' },
  { alpha2: 'TM', alpha3: 'TKM', name: 'Turkmenistan' },
  { alpha2: 'TC', alpha3: 'TCA', name: 'Turks and Caicos Islands' },
  { alpha2: 'TV', alpha3: 'TUV', name: 'Tuvalu' },
  { alpha2: 'UG', alpha3: 'UGA', name: 'Uganda' },
  { alpha2: 'UA', alpha3: 'UKR', name: 'Ukraine' },
  { alpha2: 'AE', alpha3: 'ARE', name: 'United Arab Emirates' },
  { alpha2: 'GB', alpha3: 'GBR', name: 'United Kingdom' },
  { alpha2: 'US', alpha3: 'USA', name: 'United States' },
  { alpha2: 'UM', alpha3: 'UMI', name: 'United States Minor Outlying Islands' },
  { alpha2: 'UY', alpha3: 'URY', name: 'Uruguay' },
  { alpha2: 'UZ', alpha3: 'UZB', name: 'Uzbekistan' },
  { alpha2: 'VU', alpha3: 'VUT', name: 'Vanuatu' },
  { alpha2: 'VE', alpha3: 'VEN', name: 'Venezuela' },
  { alpha2: 'VN', alpha3: 'VNM', name: 'Viet Nam' },
  { alpha2: 'VG', alpha3: 'VGB', name: 'Virgin Islands (British)' },
  { alpha2: 'VI', alpha3: 'VIR', name: 'Virgin Islands (U.S.)' },
  { alpha2: 'WF', alpha3: 'WLF', name: 'Wallis and Futuna' },
  { alpha2: 'EH', alpha3: 'ESH', name: 'Western Sahara' },
  { alpha2: 'YE', alpha3: 'YEM', name: 'Yemen' },
  { alpha2: 'ZM', alpha3: 'ZMB', name: 'Zambia' },
  { alpha2: 'ZW', alpha3: 'ZWE', name: 'Zimbabwe' },
];

/**
 * Spellings a source uses that ISO does not.
 *
 * Kept small and only for forms this build has actually met: GLEIF, Sayari and
 * the roster between them. Every key is already lower-cased and
 * punctuation-free, which is the form `keyOf()` produces.
 */
const NAME_ALIASES: Readonly<Record<string, string>> = {
  'united states of america': 'USA',
  usa: 'USA',
  us: 'USA',
  america: 'USA',
  'great britain': 'GBR',
  'united kingdom of great britain and northern ireland': 'GBR',
  uk: 'GBR',
  england: 'GBR',
  scotland: 'GBR',
  wales: 'GBR',
  deutschland: 'DEU',
  'federal republic of germany': 'DEU',
  'south korea': 'KOR',
  'republic of korea': 'KOR',
  'korea republic of': 'KOR',
  'north korea': 'PRK',
  'czech republic': 'CZE',
  turkey: 'TUR',
  turkiye: 'TUR',
  russia: 'RUS',
  vietnam: 'VNM',
  'viet nam': 'VNM',
  'ivory coast': 'CIV',
  'cote divoire': 'CIV',
  'cape verde': 'CPV',
  swaziland: 'SWZ',
  macedonia: 'MKD',
  burma: 'MMR',
  'hong kong sar': 'HKG',
  'macao sar': 'MAC',
  'the netherlands': 'NLD',
  holland: 'NLD',
  'republic of china': 'TWN',
  'chinese taipei': 'TWN',
  'peoples republic of china': 'CHN',
  'republic of india': 'IND',
  'united mexican states': 'MEX',
  'kingdom of spain': 'ESP',
  'french republic': 'FRA',
};

/** Lower-cases, strips diacritics and punctuation, collapses whitespace. */
function keyOf(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const BY_ALPHA2 = new Map(ISO_3166_COUNTRIES.map((c) => [c.alpha2, c]));
const BY_ALPHA3 = new Map(ISO_3166_COUNTRIES.map((c) => [c.alpha3, c]));
const BY_NAME = new Map(ISO_3166_COUNTRIES.map((c) => [keyOf(c.name), c]));

/** `DEU` → `DE`. `undefined` for anything that is not a current alpha-3. */
export function alpha3ToAlpha2(alpha3: string | undefined): string | undefined {
  if (!alpha3) return undefined;
  return BY_ALPHA3.get(alpha3.trim().toUpperCase())?.alpha2;
}

/** `DE` → `DEU`. `undefined` for anything that is not a current alpha-2. */
export function alpha2ToAlpha3(alpha2: string | undefined): string | undefined {
  if (!alpha2) return undefined;
  return BY_ALPHA2.get(alpha2.trim().toUpperCase())?.alpha3;
}

/**
 * Alpha-2, alpha-3 or a name, to the alpha-3 form the rest of the app uses.
 *
 * `undefined` rather than the input echoed back: a caller comparing two
 * countries must be able to tell *these disagree* from *this is not a country I
 * can read*, and returning the string would collapse the two.
 */
export function toAlpha3(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const upper = trimmed.toUpperCase();
  if (BY_ALPHA3.has(upper)) return upper;
  if (BY_ALPHA2.has(upper)) return BY_ALPHA2.get(upper)!.alpha3;
  const key = keyOf(trimmed);
  return BY_NAME.get(key)?.alpha3 ?? NAME_ALIASES[key];
}

/**
 * GLEIF's `jurisdiction`, which is **ISO 3166-2 as often as 3166-1**: the
 * measured values include `US-DE` (a Delaware corporation), `US-MI`, `CA-ON`
 * and bare `TH`, `DE`, `IN`, `JP`.
 *
 * The subdivision is discarded on purpose. What the LEI witness asks is *which
 * country's register is this LEI in*, and `US-DE` answers `USA` — the Delaware
 * incorporation of an American company is not a different country, while
 * `TH` against a Detroit roster row is.
 */
export function jurisdictionToAlpha3(jurisdiction: string | null | undefined): string | undefined {
  if (!jurisdiction) return undefined;
  const head = jurisdiction.trim().split(/[-_]/)[0];
  return toAlpha3(head);
}

/** The English short name for an alpha-3, for a reasoning line to quote. */
export function countryName(alpha3: string | null | undefined): string | undefined {
  if (!alpha3) return undefined;
  return BY_ALPHA3.get(alpha3.trim().toUpperCase())?.name;
}

/**
 * Nationality and region words a company name carries.
 *
 * Hand-written rather than derived, because a demonym is not a transformation of
 * a country name — `Dutch`, `Swiss` and `Thai` share no stem with `Netherlands`,
 * `Switzerland` or `Thailand`. Kept to the forms an automotive supplier's legal
 * name plausibly carries, and tested as a list rather than as a rule.
 */
export const DEMONYMS: readonly string[] = [
  'american',
  'argentine',
  'asian',
  'australian',
  'austrian',
  'belgian',
  'brazilian',
  'british',
  'canadian',
  'chinese',
  'czech',
  'danish',
  'dutch',
  'european',
  'filipino',
  'finnish',
  'french',
  'german',
  'hungarian',
  'indian',
  'indonesian',
  'irish',
  'italian',
  'japanese',
  'korean',
  'malaysian',
  'mexican',
  'norwegian',
  'polish',
  'portuguese',
  'romanian',
  'russian',
  'scandinavian',
  'singaporean',
  'slovak',
  'slovenian',
  'spanish',
  'swedish',
  'swiss',
  'taiwanese',
  'thai',
  'turkish',
  'vietnamese',
];

/** Multi-country regions a name uses the way it uses a country. */
export const REGION_WORDS: readonly string[] = [
  'africa',
  'america',
  'americas',
  'apac',
  'asia',
  'baltics',
  'benelux',
  'emea',
  'europe',
  'iberia',
  'latam',
  'nordics',
  'oceania',
  'scandinavia',
];

/**
 * Generic words that appear in ISO country names and identify no country.
 *
 * Without this list `United States` would contribute `united` and `states`, and
 * `name_cover` would read *United Technologies* as carrying a country word.
 */
const GENERIC_NAME_WORDS = new Set([
  'and',
  'democratic',
  'federation',
  'island',
  'islands',
  'kingdom',
  'minor',
  'new',
  'north',
  'northern',
  'outlying',
  'people',
  'peoples',
  'republic',
  'saint',
  'south',
  'southern',
  'state',
  'states',
  'territories',
  'territory',
  'the',
  'united',
  'of',
  'west',
  'western',
  'east',
  'eastern',
  'central',
]);

/**
 * Every word that identifies a country, nationality or region.
 *
 * Built from the ISO names' own tokens — and from the alias spellings above, so
 * `Turkey` and `Russia` count as well as `Türkiye` and `Russian Federation` —
 * minus the generic ones, plus the demonyms and region words. **Four letters
 * minimum**: `Nam` from `Viet Nam` and its neighbours in the short-name space
 * produce tokens that collide with ordinary syllables in company names, and the
 * point of this set is to withhold a verdict, not to reach one.
 */
const COUNTRY_WORDS: ReadonlySet<string> = new Set([
  ...[...ISO_3166_COUNTRIES.map((country) => keyOf(country.name)), ...Object.keys(NAME_ALIASES)]
    .flatMap((name) => name.split(' '))
    .filter((word) => word.length >= 4)
    .filter((word) => !GENERIC_NAME_WORDS.has(word)),
  ...DEMONYMS,
  ...REGION_WORDS,
]);

/**
 * Whether one already-normalised token names a country, nationality or region.
 *
 * Used by `name_cover` (SPEC §6.2): a Candidate whose legal name covers the
 * roster name and then adds `Thailand` is a *different company in the corporate
 * family*, and the honest verdict is `unavailable` — a reason to look rather
 * than a reason to conclude, exactly like an alias hit.
 */
export function isCountryWord(token: string): boolean {
  return COUNTRY_WORDS.has(token.toLowerCase());
}
