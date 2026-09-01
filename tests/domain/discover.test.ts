import { describe, expect, it } from 'vitest';
import { prefilterScore, sharesNameToken } from '@/jobs/discover';
import { DISCOVER_CLASSIFY_TOP_N, DISCOVER_TRADE_LIMIT } from '@/config/constants';

/**
 * SPEC §11 — Discover, where **noise is the hard part**.
 *
 * The measurement this is all built around: a seeded HS line returned 3 385
 * counterparties whose top 25 by shipments was nine freight forwarders, and the
 * two rows that most needed separating — a logistics company at 16 822
 * shipments and a real component maker at 1 047 — differ in **no field**.
 *
 * So these tests assert what the code can do *and* are explicit about what it
 * cannot: the prefilter reorders and never removes, because a rule that removed
 * rows would remove the wrong ones.
 */

describe('the prefilter reorders and never removes', () => {
  it('demotes recognisable forwarders', () => {
    expect(prefilterScore('DAMCO CHINA LTD')).toBeLessThan(0);
    expect(prefilterScore('Kuehne + Nagel')).toBeLessThan(0);
    expect(prefilterScore('DB Schenker Logistics')).toBeLessThan(0);
    expect(prefilterScore('Expeditors International')).toBeLessThan(0);
  });

  it('leaves a manufacturer alone', () => {
    expect(prefilterScore('Samsung SDI Hungary')).toBe(0);
    expect(prefilterScore('YAZAKI CORPORATION')).toBe(0);
  });

  it('is a SCORE, not a filter — the caller sorts, and nothing is dropped', () => {
    // A logistics company at 16,822 shipments and a component maker at 1,047
    // are structurally identical rows. A rule that removed the first would be
    // guessing, and would eventually remove a real supplier.
    const rows = ['DAMCO CHINA', 'Samsung SDI Hungary'];
    const ranked = [...rows].sort((a, b) => prefilterScore(b) - prefilterScore(a));
    expect(ranked[0]).toBe('Samsung SDI Hungary');
    expect(ranked).toHaveLength(rows.length);
  });
});

describe('the unverified name-token flag', () => {
  it('catches a roster supplier appearing as a foreign subsidiary', () => {
    // Roster suppliers appear in trade data as their foreign subsidiaries, and
    // traversal.ubo returns nothing — so entity-id dedupe alone would propose a
    // company already on the list under a different id.
    expect(sharesNameToken('Yazaki Hải Phòng Vietnam Co', ['Yazaki', 'Aptiv'])).toBe('Yazaki');
    expect(
      sharesNameToken('SUMI VIET NAM WIRING SYSTEMS', ['Sumitomo Electric', 'Yazaki']),
    ).toBeNull();
  });

  it('ignores short tokens, which would match almost anything', () => {
    expect(sharesNameToken('ABC Co Ltd', ['XYZ Co Ltd'])).toBeNull();
  });

  it('returns the roster name it matched, so the flag can NAME what it means', () => {
    // "possibly related to Yazaki (name match, unverified)" — labelled, never
    // hidden. An unverified relationship presented as fact is worse than one
    // presented as a question.
    expect(sharesNameToken('Yazaki Morocco SARL', ['Yazaki'])).toBe('Yazaki');
  });
});

describe('the caps', () => {
  it('reads 100 from the API and classifies the top 25', () => {
    // Measured latency of 3.6-13.4 s for the trade call alone rules out running
    // this inline, which is why Discover is a Job.
    expect(DISCOVER_TRADE_LIMIT).toBe(100);
    expect(DISCOVER_CLASSIFY_TOP_N).toBe(25);
  });
});

/**
 * The prefilter only ever *reorders*, so a miss is survivable — the classifier
 * still sees the row. A **false positive** is not: it would push a real
 * manufacturer below the cut, and the classifier would never be asked.
 *
 * `pnpm check:prefilter` measures this live against Sayari's own
 * `logisticsEntity` flag (0 false positives on the 100-row BAT page). These
 * cases pin the manufacturers that measurement covered, so a later addition to
 * FORWARDER_MARKERS that starts demoting real suppliers fails here rather than
 * silently changing which rows get classified.
 */
describe('prefilterScore never demotes a manufacturer', () => {
  const manufacturers = [
    'LG ENERGY SOLUTION, LTD.',
    'CONTEMPORARY AMPEREX TECHNOLOGY CO., LIMITED',
    'SAMSUNG SDI HUNGARY ZRT',
    'TESLA SHANGHAI CO LTD',
    'LG CHEM WROCLAW ENERGY SP. Z.O.O.',
    'Công ty TNHH Samsung Electronics Việt Nam',
    'ZEBRA TECHNOLOGIES INTERNATIONAL LLC.',
    'PANASONIC ENERGY CO., LTD.',
    'ROBERT BOSCH GMBH',
    'YAZAKI CORPORATION',
  ];

  it.each(manufacturers)('leaves %s at zero', (name) => {
    expect(prefilterScore(name)).toBe(0);
  });
});
