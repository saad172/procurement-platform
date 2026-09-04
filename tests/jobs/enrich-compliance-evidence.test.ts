import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { assembleScoringInput, loadCachedRiskIntelligence } from '@/jobs/enrich-supplier';
import { upsertEntity } from '@/jobs/resolve';
import { settleMatch } from '@/domain/match/settle-match';
import { complianceRisk } from '@/domain/scoring/criteria';
import { loadFixture } from '@/fixtures/load';
import { replayUpstream, seedUpstream } from '@/fixtures/replay-upstream';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { resetDerived } from '../support/reset';
import { seededProgram } from '../support/seeded-program';
import { openJob } from '../support/pipeline';

/**
 * **A real compliance-risk deduction can cite the program/authority/list/date
 * behind it**, not only the bare factor name — the live-scoring half of the
 * wiring `db/queries/entity-page.ts` already had for display (SPEC §9.2's
 * `evidence` field on a `factorsScored` entry, `domain/scoring/criteria.ts`).
 *
 * Calls `assembleScoringInput` and `loadCachedRiskIntelligence` directly, the
 * same two functions `enrichSupplier` calls, rather than running the whole
 * Job: `resolve/sanctioned` was recorded for a resolve run
 * (`arranged-replay.test.ts`), so it carries no `negativeNews` /
 * `ownership` / `watchlist` bodies for this candidate, and fabricating those
 * would mean recording a fixture this ticket has no reason to spend a Sayari
 * credit on. What this test needs from a real recording is the one thing
 * `resolve/sanctioned` genuinely has: a `getEntity` body whose own `risk`
 * object and `attributes.risk_intelligence` block name the same factor.
 *
 * The candidate used, `9LtTGZXn_LlN05C47cwZ5w`, carries a `regulatory_action`
 * risk factor at `level: 'high'` — a scoreable level, unlike the same entity's
 * `sanctioned_*` factors, which the recording carries at Sayari's own
 * `'critical'`, a level this app's three-band scale does not carry and so
 * cannot demonstrate the join — alongside a matching `risk_intelligence` entry
 * naming an OFAC-listed program and a 2015 effective date.
 */
const SANCTIONED_ENTITY = '9LtTGZXn_LlN05C47cwZ5w';

describe('compliance-risk deductions cite the cached risk-intelligence evidence', () => {
  it('attaches a program/authority/list/date citation to a real deduction', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    await resetDerived(db);

    const program = await seededProgram(db);
    const supplier = await db.query.supplier.findFirst({
      where: (row, { eq: is }) => is(row.rosterName, 'Yazaki'),
    });
    if (!supplier) throw new Error('no seeded Yazaki');

    await seedUpstream(db, await loadFixture('resolve/sanctioned'));
    const [run] = await db
      .insert(t.run)
      .values({
        programId: program.id,
        state: 'running',
        trigger: 'full',
        subjectLabel: 'compliance-evidence',
      })
      .returning({ id: t.run.id });
    const jobId = await openJob(db, run!.id, 'enrich', supplier.id);

    const fetched = await replayUpstream(db, run!.id, jobId).sayari.getEntity({
      id: SANCTIONED_ENTITY,
    });
    await upsertEntity(db, fetched.data, fetched.upstreamResponseId, 'getEntity');

    await settleMatch(db, {
      supplierId: supplier.id,
      status: 'accepted',
      entityId: SANCTIONED_ENTITY,
      settledBy: 'human',
      note: 'Settled by hand: this test is about compliance evidence, not about resolution.',
    });

    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplier.id) });
    const profileRow = await db.query.entity.findFirst({
      where: eq(t.entity.id, SANCTIONED_ENTITY),
    });
    if (!match?.entityId || !profileRow) throw new Error('match or profile did not settle');

    // The exact cached-body read `enrichSupplier` performs before scoring —
    // never a new Sayari fetch, just this row's own `upstream_response`.
    const ctx = { db } as never;
    const riskIntelligence = await loadCachedRiskIntelligence(ctx, profileRow);
    expect(riskIntelligence, 'the cached body carried no risk_intelligence attribute').toBeDefined();

    const input = await assembleScoringInput(
      ctx,
      { programId: program.id },
      {
        supplier,
        match: { ...match, entityId: match.entityId },
        categories: [],
        profileRow,
        siteCountry: undefined,
        countrySource: 'profile',
      },
      {
        written: [],
        returned: [],
        family: { enrichmentId: 'stand-in', members: [], truncated: false, reachable: null },
        tariffByCategory: new Map(),
        lat: null,
        lon: null,
        coordinatePrecision: undefined,
      },
      { owners: [], gapCoverage: 'unknown' },
      riskIntelligence,
    );

    const outcome = complianceRisk(input, 'strong');
    expect(outcome.status).toBe('value');

    const rawInputs = outcome.rawInputs as {
      factorsScored: {
        factor: string;
        level: string;
        evidence?: { program?: string; authority?: string; list?: string; fromDate?: string }[];
      }[];
    };
    const regulatoryAction = rawInputs.factorsScored.find((f) => f.factor === 'regulatory_action');
    expect(
      regulatoryAction,
      `no 'regulatory_action' deduction among: ${rawInputs.factorsScored.map((f) => f.factor).join(', ')}`,
    ).toBeDefined();
    expect(regulatoryAction?.evidence).toEqual([
      expect.objectContaining({
        authority: 'OFAC',
        list: 'USA SAM.gov Entity Exclusions Database',
        fromDate: '2015-12-22',
      }),
    ]);
  });
});
