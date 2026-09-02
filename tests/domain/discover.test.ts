import { describe, expect, it } from 'vitest';
import {
  decideLeadRelation,
  prefilterScore,
  programTerritories,
  readLeadClassification,
  sharesNameToken,
} from '@/domain/discover-leads';
import { leadClassificationLabel, leadRelation } from '@/domain/lead-answer';
import { DISCOVER_CLASSIFY_TOP_N, DISCOVER_TRADE_LIMIT } from '@/config/constants';
import { PLANTS, PROGRAM } from '@/db/seed-data/program';
import type { RunLoopOutcome } from '@/model/types';

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

/**
 * **The territories are the Program's, not a constant** (SPEC §11).
 *
 * `arrivalCountries` was `[program?.importingCountry ?? 'USA', 'MEX']`, so a
 * Program importing into Mexico asked Sayari for `['MEX', 'MEX']`. The second
 * territory was never missing data — it is where the Plants are, and the seed
 * says so in P4's own note: it is what makes the single importing country a
 * simplification rather than a fact.
 */
describe("the Program's territories", () => {
  it('derives the founding Program’s two territories from its own rows', () => {
    expect(programTerritories(PROGRAM, PLANTS)).toEqual(['USA', 'MEX']);
  });

  it('does not repeat a territory when the importer is where a Plant is', () => {
    // The case the hardcoded 'MEX' got wrong: asking twice for one country.
    expect(programTerritories({ importingCountry: 'MEX' }, PLANTS)).toEqual(['MEX', 'USA']);
  });

  it('leads with the importing country, because that is the Program’s declaration', () => {
    expect(programTerritories({ importingCountry: 'USA' }, [{ country: 'CAN' }])).toEqual([
      'USA',
      'CAN',
    ]);
  });

  it('is the importing country alone when the Program has no Plants yet', () => {
    expect(programTerritories({ importingCountry: 'USA' }, [])).toEqual(['USA']);
  });
});

/**
 * **How a Lead relates to a Supplier already on the roster** (SPEC §11.2).
 *
 * Both halves of this were computed and discarded: the name-token result ended
 * at `void nameFlag`, and `relatedSupplierId` was written into every row as a
 * literal `null` — so `leadRelation` could never reach its unverified branch
 * and the *possibly related · name match, unverified* badge could not render
 * at all. The verified branch could render, and did so off a `family_member`
 * map built with no `WHERE`: any Program's ownership graph, naming no
 * Supplier.
 */
describe('the relation a Lead is stored with', () => {
  const roster = [
    { supplierId: 'supplier-yazaki', rosterName: 'Yazaki' },
    { supplierId: 'supplier-aptiv', rosterName: 'Aptiv' },
  ];

  it('names the Supplier whose ownership family holds the Lead', () => {
    const relation = decideLeadRelation(
      { entityId: 'entity-hai-phong', label: 'YAZAKI HAI PHONG VIETNAM CO LTD' },
      { familyOwners: new Map([['entity-hai-phong', 'supplier-yazaki']]), roster },
    );
    expect(relation).toEqual({ relatedSupplierId: 'supplier-yazaki', relationVerified: true });
    const said = leadRelation(relation, 'Yazaki');
    expect(said.kind).toBe('verified');
    expect(said.kind === 'verified' && said.label).toBe(
      'related to Yazaki by ownership · verified',
    );
  });

  it('stores the name-token flag, unverified, and names what it guessed at', () => {
    const relation = decideLeadRelation(
      { entityId: 'entity-morocco', label: 'YAZAKI MOROCCO SARL' },
      { familyOwners: new Map(), roster },
    );
    expect(relation).toEqual({ relatedSupplierId: 'supplier-yazaki', relationVerified: false });
    const said = leadRelation(relation, 'Yazaki');
    expect(said.kind).toBe('unverified');
    expect(said.kind === 'unverified' && said.label).toBe(
      'possibly related to Yazaki · name match, unverified',
    );
  });

  it('leaves a Lead in NO relation when neither the graph nor the name says so', () => {
    const relation = decideLeadRelation(
      { entityId: 'entity-catl', label: 'CONTEMPORARY AMPEREX TECHNOLOGY CO., LIMITED' },
      { familyOwners: new Map(), roster },
    );
    expect(relation).toEqual({ relatedSupplierId: null, relationVerified: false });
    expect(leadRelation(relation).kind).toBe('none');
  });

  it('does not verify a Lead that only another Program’s family holds', () => {
    // `familyOwners` is scoped to this Program by `loadFamilyOwners`, which is
    // asserted against the database in tests/jobs/discover-relations.test.ts.
    // What this pins is the decision the map feeds: a member nobody on THIS
    // roster owns is not verified, whatever some other roster's graph says.
    const relation = decideLeadRelation(
      { entityId: 'entity-owned-elsewhere', label: 'A COMPANY IN ANOTHER PROGRAM' },
      { familyOwners: new Map(), roster },
    );
    expect(relation.relationVerified).toBe(false);
    expect(relation.relatedSupplierId).toBeNull();
  });

  it('never lets a name token upgrade a Lead to verified', () => {
    const relation = decideLeadRelation(
      { entityId: 'entity-morocco', label: 'YAZAKI MOROCCO SARL' },
      { familyOwners: new Map(), roster },
    );
    expect(relation.relationVerified).toBe(false);
  });
});

/**
 * **A classifier that did not answer is not a model that said `unclear`**
 * (SPEC §11.1).
 *
 * `classification: submitted?.classification ?? 'unclear'` collapsed four
 * different things into one word: a model that looked and could not tell, a
 * loop that hit a cap, a loop that failed, and a submission outside the closed
 * enum. `unclear` is a real answer a person can act on; the other three are
 * things that happened to us.
 */
describe('what the classifier answered, or why it did not', () => {
  const done = (input: unknown): RunLoopOutcome => ({
    status: 'done',
    finalMessage: null,
    toolUses: [{ name: 'submit_lead_classification', input }],
    turns: 1,
    toolCalls: 1,
    tokens: 10,
  });

  it('takes the submitted classification and its reasoning', () => {
    expect(
      readLeadClassification(done({ classification: 'manufacturer', reasoning: 'makes cells' })),
    ).toEqual({
      classification: 'manufacturer',
      reasoning: 'makes cells',
      notClassifiedReason: null,
    });
  });

  it('keeps `unclear` as the real answer it is', () => {
    const outcome = readLeadClassification(
      done({ classification: 'unclear', reasoning: 'nothing separates it from a reseller' }),
    );
    expect(outcome.classification).toBe('unclear');
    expect(outcome.notClassifiedReason).toBeNull();
    expect(leadClassificationLabel(outcome).label).toBe('unclear');
  });

  it('records a terminated loop as NOT classified, with the cap that fired', () => {
    const outcome = readLeadClassification({
      status: 'terminated',
      reason: 'tool-call cap reached',
      turns: 4,
      toolCalls: 4,
      tokens: 900,
      toolUses: [],
    });
    expect(outcome.classification).toBeNull();
    expect(outcome.notClassifiedReason).toBe('the classifier loop stopped: tool-call cap reached');
    expect(leadClassificationLabel(outcome).label).toBe(
      'not classified: the classifier loop stopped: tool-call cap reached',
    );
  });

  it('still reads a submission out of a loop that was terminated after it', () => {
    // `RunLoopOutcome` carries `toolUses` on `terminated` for exactly this
    // reason: a ceiling firing one turn after the model answered used to
    // discard the answer.
    const outcome = readLeadClassification({
      status: 'terminated',
      reason: 'token ceiling reached',
      turns: 3,
      toolCalls: 1,
      tokens: 900,
      toolUses: [
        {
          name: 'submit_lead_classification',
          input: { classification: 'manufacturer', reasoning: 'r' },
        },
      ],
    });
    expect(outcome.classification).toBe('manufacturer');
    expect(outcome.notClassifiedReason).toBeNull();
  });

  it('records a failed loop as NOT classified, naming the failure', () => {
    const outcome = readLeadClassification({ status: 'failed', error: 'overloaded_error' });
    expect(outcome.classification).toBeNull();
    expect(outcome.notClassifiedReason).toBe('the classifier failed: overloaded_error');
  });

  it('refuses a category outside the closed enum rather than writing it', () => {
    // `toolUses` carries the model's RAW input; the tool's own zod schema
    // never saw it. A value outside the enum is a database error waiting on
    // the insert, and it is not a classification either.
    const outcome = readLeadClassification(
      done({ classification: 'battery maker', reasoning: 'x' }),
    );
    expect(outcome.classification).toBeNull();
    expect(outcome.notClassifiedReason).toBe(
      'the classifier submitted a category outside the closed enum',
    );
  });

  it('records a loop that finished without submitting anything', () => {
    const outcome = readLeadClassification({
      status: 'done',
      finalMessage: null,
      toolUses: [],
      turns: 1,
      toolCalls: 0,
      tokens: 10,
    });
    expect(outcome.notClassifiedReason).toBe(
      'the classifier finished without submitting a classification',
    );
  });

  it('says a lead was left unclassified by the budget, not by the model', () => {
    const outcome = readLeadClassification({
      status: 'paused_on_budget',
      spentUsd: 12,
      turns: 1,
      toolCalls: 0,
      tokens: 10,
    });
    expect(outcome.notClassifiedReason).toBe(
      'the run reached its budget before this lead was classified',
    );
  });
});
