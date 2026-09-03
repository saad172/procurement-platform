import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call } from '@/upstream/call';
import { loadFixture } from '@/fixtures/load';
import { resolutionSchema } from '@/upstream/projections/sayari';
import type { EndpointDef, UpstreamContext } from '@/upstream/types';
import { START_TEST_DB_HINT, closeTestDb, getTestDb, testDatabaseIsUp, testSql } from '../support/test-db';

/**
 * `resolutionSchema` keeps `score`, `match_strength`, `explanation`,
 * `highlight` and `matched_queries` — the resolution-evidence columns ticket
 * 01's own text names, and the fields unit 01c reads off a projected
 * Candidate. This is not new schema (they were already declared on
 * `resolutionCandidateSchemaInner`); what was unverified is that they survive
 * the whole path: a real recorded `resolution.resolutionPost` body, through
 * `call()` — cache write, then projection — the same order every caller
 * goes through, never a direct `.parse()` shortcut.
 */
describe(`resolution evidence survives call() (needs: ${START_TEST_DB_HINT})`, () => {
  let db: Awaited<ReturnType<typeof getTestDb>>;
  let ctx: UpstreamContext;
  let runId: string;

  const makeEndpoint = (body: unknown) =>
    ({
      source: 'sayari',
      endpoint: 'resolution.resolutionPost',
      bucket: 'resolution',
      timeoutMs: 1_000,
      defaults: { enableLlmClean: true, limit: 10 },
      normalizeParams: (p: Record<string, unknown>) => p,
      dispatch: async () => ({ body, via: 'sdk' as const }),
      projection: resolutionSchema,
    }) as unknown as EndpointDef<Record<string, unknown>, unknown>;

  beforeAll(async () => {
    if (!(await testDatabaseIsUp())) return;
    db = await getTestDb();
    const sql = testSql();
    await sql`DELETE FROM program WHERE name = 'resolution-evidence fixture'`;
    const [program] = await sql`
      INSERT INTO program (name, importing_country, vehicle_class, sourcing_horizon)
      VALUES ('resolution-evidence fixture', 'USA', 'BEV', 'FY2027') RETURNING id`;
    const [run] = await sql`
      INSERT INTO run (program_id, state, trigger) VALUES (${program!.id}, 'running', 'test')
      RETURNING id`;
    runId = run!.id;
    ctx = {
      db,
      runId,
      credentials: { sayariClientId: 'id', sayariClientSecret: 's', nominatimUserAgent: 'ua' },
    };
  });

  beforeEach(async () => {
    if (!(await testDatabaseIsUp())) return;
    await testSql()`DELETE FROM upstream_response WHERE endpoint = 'resolution.resolutionPost'`;
    await testSql()`DELETE FROM usage_event WHERE run_id = ${runId}`;
  });

  afterAll(async () => {
    if (!(await testDatabaseIsUp())) return;
    await testSql()`DELETE FROM upstream_response WHERE endpoint = 'resolution.resolutionPost'`;
    await testSql()`DELETE FROM program WHERE name = 'resolution-evidence fixture'`;
    await closeTestDb();
  });

  it('keeps score, match_strength, explanation, highlight and matched_queries', async () => {
    if (!(await testDatabaseIsUp())) return;
    const fixture = await loadFixture('resolve/rules-r0');
    const recorded = fixture.upstream.find((row) => row.endpoint === 'resolution.resolutionPost');
    expect(recorded).toBeTruthy();

    const result = await call(makeEndpoint(recorded!.body), { limit: 10 }, ctx);
    const candidates = (result.data as { data?: unknown[] }).data as Array<
      Record<string, unknown>
    >;
    expect(candidates.length).toBeGreaterThan(0);

    const americanAxle = candidates.find(
      (c) => c.label === 'AMERICAN AXLE & MANUFACTURING INC',
    );
    expect(americanAxle).toBeTruthy();
    // Read from the fixture's own recorded body, not a hardcoded value:
    // `matching.ts`'s own schema comment says `score` "is Sayari's, and is
    // **not comparable between queries**" — measured directly, re-recording
    // this fixture twice in one session returned two different scores for
    // the identical query. The claim under test is that the value survives
    // `call()` unchanged, not that it equals any particular number.
    const rawCandidates = (recorded!.body as { data?: Array<Record<string, unknown>> }).data ?? [];
    const rawAmericanAxle = rawCandidates.find(
      (c) => c.label === 'AMERICAN AXLE & MANUFACTURING INC',
    );
    expect(rawAmericanAxle?.score).toBeTypeOf('number');
    expect(americanAxle!.score).toBeCloseTo(rawAmericanAxle!.score as number, 5);
    expect((americanAxle!.match_strength as { value?: string }).value).toBe('strong');
    expect(americanAxle!.matched_queries).toEqual(
      expect.arrayContaining(['address', 'country', 'name']),
    );
    expect(americanAxle!.explanation).toBeTruthy();
    expect(americanAxle!.highlight).toBeTruthy();
    // A cache hit re-derives the same evidence with no re-spend — the whole
    // reason projecting-after-caching is the design (SPEC §16.2).
    const second = await call(makeEndpoint(recorded!.body), { limit: 10 }, ctx);
    expect(second.cacheHit).toBe(true);
    const secondCandidates = (second.data as { data?: unknown[] }).data as Array<
      Record<string, unknown>
    >;
    expect(secondCandidates.find((c) => c.label === americanAxle!.label)!.score).toBe(
      americanAxle!.score,
    );
  });
});
