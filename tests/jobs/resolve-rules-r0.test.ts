import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { runResolveJob } from '@/jobs/resolve-job';
import { DISCRIMINATOR_NAMES } from '@/domain/match/discriminators';
import { resetAnthropicClients } from '@/model/client';
import { loadFixture } from '@/fixtures/load';
import { seedUpstream, replayUpstream } from '@/fixtures/replay-upstream';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { seededProgram } from '../support/seeded-program';
import { resetDerived } from '../support/reset';
import { JOB_CAPS } from '@/config/constants';

/**
 * `resolve/rules-r0` (SPEC §6.3) — a Match settled by the gate **alone**: plain
 * code, zero Rounds, zero model turns.
 *
 * ## The row moved from Bosch to American Axle, and that is the finding
 *
 * This fixture used to be recorded from roster row 1, "Bosch", which finding 14
 * reported clearing the gate at zero tokens. It no longer does, and nothing
 * about Bosch changed: the gate now refuses a clean winner when **another
 * Candidate failed nothing either**, and Sayari carries a second record simply
 * labelled `ROBERT BOSCH` — no country, no city, no LEI, no status — which
 * fails no Discriminator because there is nothing on it to fail one. Its eight
 * verdicts are four passes and four `can't tell`s. That is a rival the code
 * cannot tell apart from `ROBERT BOSCH GMBH`, and settling between them is the
 * agents' job.
 *
 * `American Axle & Manufacturing` is the row where the gate's own change is the
 * point. It used to settle by rules on `American Axle & Manufacturing
 * (Thailand) Co., Ltd.` — which passed all eight because the country, locality
 * and street rungs each quantified over *any* of the record's addresses and the
 * Thai subsidiary files its parent's Detroit plant among them. Anchoring all
 * three rungs on one address, and reading GLEIF's `jurisdiction` (`TH`) rather
 * than only its city (`DETROIT`, the parent's), moves the settlement to
 * `AMERICAN AXLE & MANUFACTURING INC` — the legal entity at the roster address.
 *
 * Recorded live against the test database on 2026-09-02, from the state
 * `resetDerived()` rebuilds (finding 85): one `resolution.resolutionPost`, five
 * `entity.getEntity`, four `lei-records.byId`, and no model call at all.
 */

const FIXTURE = 'resolve/rules-r0';
const ACCEPTED_ENTITY_ID = 'cAmnI92Pnaemjk7pVLfysw';
const ROSTER_NAME = 'American Axle & Manufacturing';

describe('resolve/rules-r0 replays', () => {
  it('settles by rules alone, in zero Rounds and zero model turns', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const fixture = await loadFixture(FIXTURE);

    await resetDerived(db);

    const supplier = await db.query.supplier.findFirst({
      where: eq(t.supplier.rosterName, ROSTER_NAME),
    });
    if (!supplier) return;

    await seedUpstream(db, fixture);
    resetAnthropicClients();

    const program = await seededProgram(db);
    const [run] = await db
      .insert(t.run)
      .values({ programId: program!.id, state: 'running', trigger: 'full', subjectLabel: 'replay' })
      .returning({ id: t.run.id });
    const [job] = await db
      .insert(t.job)
      .values({
        runId: run!.id,
        kind: 'resolve',
        subjectType: 'supplier',
        subjectId: supplier.id,
        state: 'running',
        toolCallCap: JOB_CAPS.resolve.toolCalls,
        tokenCap: JOB_CAPS.resolve.tokens,
      })
      .returning({ id: t.job.id });

    // No `round` deps at all — the gate settles alone, or this Job parks. A
    // `runRound` here would make "zero model turns" untestable: the fixture
    // has none to replay, so any attempt to reach one throws a cache miss.
    const outcome = await runResolveJob(
      { db, upstream: replayUpstream(db, run!.id, job!.id), jobId: job!.id },
      { supplierId: supplier.id },
    );

    expect(outcome.status).toBe('accepted');
    expect(outcome.settledBy).toBe('rules');
    expect(outcome.rounds).toBe(0);
    expect(outcome.entityId).toBe(ACCEPTED_ENTITY_ID);

    // ── The row the UI reads, not the value the function returned ───────────
    const match = await db.query.match.findFirst({ where: eq(t.match.supplierId, supplier.id) });
    expect(match?.status).toBe('accepted');
    expect(match?.settledBy).toBe('rules');
    expect(match?.entityId).toBe(ACCEPTED_ENTITY_ID);
    // Sayari's own `match_strength` for the accepted Candidate, carried onto
    // the Match row (ticket 01 item A) — recorded "strong" for this row.
    expect(match?.matchStrength).toBe('strong');

    // Zero model turns — not "few", zero. No `runRound` was ever handed to
    // `resolveSupplier`, and this is the row a Trace view would read.
    const turns = await db.query.traceTurn.findMany({ where: eq(t.traceTurn.jobId, job!.id) });
    expect(turns).toHaveLength(0);

    const attempt = await db.query.matchAttempt.findFirst({
      where: eq(t.matchAttempt.matchId, match!.id),
      with: { candidates: { with: { entity: true, verdicts: true } } },
    });
    expect(attempt?.rungsUsed as string[]).toEqual(['R1']);
    expect(attempt?.settledBy).toBe('rules');

    // Five candidates, every one of them an American Axle company — the
    // Thai subsidiary, the Mexican one, the holding company, the Delaware
    // shell named for the founder, and the operating parent. They are
    // decoys rather than noise precisely because they are all the same
    // family, which is what the gate now has to see through.
    const candidates = attempt?.candidates ?? [];
    expect(candidates.length).toBeGreaterThan(1);

    /**
     * **The subsidiary was rejected, and by the two checks this step added.**
     *
     * It is on the same list, it carries the parent's Detroit plant among its
     * addresses, and under the previous rules it was the row that settled.
     */
    const thailand = candidates.find((c) => /thailand/i.test(c.entity.label));
    expect(thailand, 'the Thai subsidiary should still be a recorded Candidate').toBeTruthy();
    const thaiVerdicts = new Map(thailand!.verdicts.map((v) => [v.discriminator, v]));
    expect(thaiVerdicts.get('lei_witness')!.verdict).toBe('fail');
    expect(thaiVerdicts.get('lei_witness')!.reasoning).toMatch(/Thailand/);
    expect(thaiVerdicts.get('name_cover')!.verdict).toBe('unavailable');
    expect(thaiVerdicts.get('name_cover')!.reasoning).toMatch(/\(Thailand\)/);

    const accepted = candidates.find((c) => c.entityId === ACCEPTED_ENTITY_ID);
    const rejected = candidates.filter((c) => c.entityId !== ACCEPTED_ENTITY_ID);
    expect(accepted, 'the accepted entity should be stored as one of the candidates').toBeTruthy();
    expect(rejected.length).toBeGreaterThan(0);

    // The accepted candidate's eight verdicts are all `pass`.
    const verdicts = accepted!.verdicts;
    expect(verdicts).toHaveLength(8);
    expect(new Set(verdicts.map((v) => v.discriminator))).toEqual(new Set(DISCRIMINATOR_NAMES));
    expect(verdicts.every((v) => v.verdict === 'pass')).toBe(true);

    /**
     * **The four evidence columns, read from the actual recorded resolution
     * body** (ticket 01 item A). `settleMatch` has always written these when
     * given them; what was broken is that nothing upstream of it ever was —
     * every one of these four read null on every row in the database before
     * this fix, on every Candidate, not only the accepted one.
     */
    expect(Number(accepted!.score)).toBeCloseTo(216.92903, 3);
    expect(accepted!.matchStrength).toBe('strong');
    expect(accepted!.explanation).toBeTruthy();
    expect(accepted!.explanation).toHaveProperty('name');
    expect(accepted!.highlight).toBeTruthy();
    expect(accepted!.highlight).toHaveProperty('name');

    // Every one of the five pre-pass Candidates carries its OWN resolution
    // row's evidence, not only the accepted Candidate's (V3).
    for (const candidate of candidates) {
      expect(candidate.score, `${candidate.entity.label} should carry its own score`).not.toBeNull();
      expect(
        candidate.matchStrength,
        `${candidate.entity.label} should carry its own match_strength`,
      ).not.toBeNull();
    }

    /**
     * **B: noted, never scored on.** `name_cover` and `alias_context` name
     * which field Sayari's own resolution highlighted, as a note appended to
     * a verdict that was already decided — it never settles a Match on its
     * own (SPEC §6.2).
     *
     * **C1**: `high-quality name match` is the field's own `match_quality`/
     * `high_quality_match_name` grade, read as the PROJECTED snake_case keys
     * — the bug this pins down never fired on real data because the old code
     * read the SDK's camelCase, which `snakeKeys` had already converted away
     * by the time this body was projected.
     *
     * The note's wording changed after recording: the first phrasing —
     * *"grading it high"* — read as an endorsement to the agents rather than
     * a fact about text similarity, and two roster rows that had settled
     * correctly for months flipped once it started appearing (see
     * `withResolutionEvidence`'s doc comment). The caveat below is what
     * closes that gap.
     */
    const nameCoverVerdict = verdicts.find((v) => v.discriminator === 'name_cover')!;
    expect(nameCoverVerdict.reasoning).toMatch(/Sayari's own resolution/);
    expect(nameCoverVerdict.reasoning).toMatch(/high-quality name match/);
    expect(nameCoverVerdict.reasoning).toMatch(/does not by itself tell this record apart/);
    const aliasContextVerdict = verdicts.find((v) => v.discriminator === 'alias_context')!;
    expect(aliasContextVerdict.reasoning).toMatch(/Sayari's own resolution/);
  });
});
