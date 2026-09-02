import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { z } from 'zod/v4';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { runLoop } from '@/model';
import { resetAnthropicClients } from '@/model/client';
import { ReplayMissError, UnhashableFixtureError, replayFetch } from '@/fixtures/replay-fetch';
import type { Fixture } from '@/fixtures/types';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';
import { seededProgram } from '../support/seeded-program';
import * as t from '@/db/schema';
import { JOB_CAPS } from '@/config/constants';

/**
 * The replay seam, end to end (SPEC §19.1).
 *
 * What makes this test worth having is what it does **not** substitute: the
 * `Anthropic` client is real, `client.beta.messages.toolRunner` is real, and
 * the multi-turn loop, the tool dispatch and the stop-reason handling all run
 * exactly as they do in production. Only `fetch` is replaced.
 *
 * A hand-written `ModelClient` interface would have wrapped our own abstraction
 * *around* the runner, and the suite would then exercise everything except the
 * part nobody has proved.
 *
 * The fixture is `pnpm smoke:model`'s own Job, exported by
 * `pnpm fixtures:record`. Nothing in it was written by hand.
 *
 * Its **manifest pin** was moved on 2026-09-02 without re-running it: the
 * assess evaluator's system prompt changed, so `buildManifest()`'s assess hash
 * moved and `fixture-staleness.test.ts` went red, while both turns still replay
 * byte-for-byte. Only `manifest.loopHashes.assess` was rewritten, to the value
 * `buildManifest({ assess: 'smoke' })` returns today. `fixtures:rehash` cannot
 * do it — that script remaps *turn* wire hashes from dumped bodies, and no turn
 * here needed remapping.
 */

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'model', 'two-turn-tool-loop.json');

/**
 * The recorded Job's tool, restated.
 *
 * A replay must present the *same* tools, because the tool schemas are part of
 * the request body and therefore part of the hash. That is not duplication for
 * its own sake — it is the property under test: change a description here and
 * the replay misses, which is exactly what should happen when a tool drifts.
 */
function lookupTool(onRun: () => void) {
  return betaZodTool({
    name: 'lookup_supplier_country',
    description: 'Returns the roster country recorded for a supplier on this program.',
    inputSchema: z.object({
      supplierName: z.string().describe('The roster name, exactly as imported'),
    }),
    run: async (input) => {
      onRun();
      const known: Record<string, string> = {
        Yazaki: 'JPN',
        'Sumitomo Electric': 'JPN',
        Aptiv: 'USA',
      };
      const country = known[input.supplierName];
      return country ? `${input.supplierName}: ${country}` : 'no such supplier on this program';
    },
  });
}

const RECORDED_SYSTEM =
  'You answer questions about a supplier roster. Use the tool for any fact about a ' +
  'supplier. Be brief, and say plainly when the data cannot settle a question.';

const RECORDED_QUESTION =
  'Yazaki, Sumitomo Electric and Aptiv all bid on wire harnesses. Using only the ' +
  'roster country for each, which of them would face the same US import duty, and ' +
  'what does the roster country NOT tell you about where the harnesses are actually made?';

let fixture: Fixture;

beforeAll(async () => {
  fixture = JSON.parse(await readFile(FIXTURE, 'utf8')) as Fixture;
  resetAnthropicClients();
});

describe('replayFetch', () => {
  it('rejects a fixture whose turns cannot be matched', () => {
    const positional: Fixture = {
      ...fixture,
      turns: fixture.turns.map((turn) => ({ ...turn, wireHash: null })),
    };
    expect(() => replayFetch(positional)).toThrow(UnhashableFixtureError);
  });

  it('drives the real Tool Runner through a recorded two-turn loop', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    const program = await seededProgram(db);
    if (!program) return;

    const [run] = await db
      .insert(t.run)
      .values({ programId: program.id, state: 'running', trigger: 'test', subjectLabel: 'replay' })
      .returning({ id: t.run.id });
    const [job] = await db
      .insert(t.job)
      .values({
        runId: run!.id,
        kind: 'assess',
        subjectType: 'program',
        subjectId: program.id,
        state: 'running',
        toolCallCap: JOB_CAPS.assess.toolCalls,
        tokenCap: JOB_CAPS.assess.tokens,
      })
      .returning({ id: t.job.id });

    let toolRuns = 0;
    const outcome = await runLoop(
      {
        loop: 'assess',
        system: RECORDED_SYSTEM,
        tools: [
          lookupTool(() => {
            toolRuns += 1;
          }),
        ],
        messages: [{ role: 'user', content: RECORDED_QUESTION }],
        caps: { toolCalls: JOB_CAPS.assess.toolCalls, tokens: JOB_CAPS.assess.tokens },
        roundN: 1,
        toolDigest: { names: ['lookup_supplier_country'], hash: 'smoke' },
      },
      {
        db,
        runId: run!.id,
        jobId: job!.id,
        // No usable key: the suite is keyless by construction. A request that
        // escaped the seam would fail loudly rather than quietly succeed.
        credentials: { apiKey: 'not-a-key', fetch: replayFetch(fixture) },
      },
    );

    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;

    // The recorded loop: two turns, three tool calls, and the tools really ran.
    expect(outcome.turns).toBe(2);
    expect(outcome.toolCalls).toBe(3);
    expect(toolRuns).toBe(3);

    // And it wrote its own Trace, so a replayed Job is bookkept like a real one.
    const written = await db.select().from(t.traceTurn).where(eq(t.traceTurn.jobId, job!.id));
    expect(written).toHaveLength(2);
  });

  it('throws naming the drifted turn when the request no longer matches', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    const program = await seededProgram(db);
    if (!program) return;

    const [run] = await db
      .insert(t.run)
      .values({ programId: program.id, state: 'running', trigger: 'test', subjectLabel: 'drift' })
      .returning({ id: t.run.id });
    const [job] = await db
      .insert(t.job)
      .values({
        runId: run!.id,
        kind: 'assess',
        subjectType: 'program',
        subjectId: program.id,
        state: 'running',
        toolCallCap: JOB_CAPS.assess.toolCalls,
        tokenCap: JOB_CAPS.assess.tokens,
      })
      .returning({ id: t.job.id });

    const outcome = await runLoop(
      {
        loop: 'assess',
        // One word changed. This is the whole point of hashing the request:
        // a prompt edit must not be able to reuse an answer to the old prompt.
        system: `${RECORDED_SYSTEM} Answer in French.`,
        tools: [lookupTool(() => {})],
        messages: [{ role: 'user', content: RECORDED_QUESTION }],
        caps: { toolCalls: JOB_CAPS.assess.toolCalls, tokens: JOB_CAPS.assess.tokens },
        roundN: 1,
        toolDigest: { names: ['lookup_supplier_country'], hash: 'smoke' },
      },
      {
        db,
        runId: run!.id,
        jobId: job!.id,
        credentials: { apiKey: 'not-a-key', fetch: replayFetch(fixture) },
      },
    );

    // `runLoop` catches and reports rather than throwing, so the miss surfaces
    // as a failed loop carrying the replay error's message.
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.error).toContain('Replay miss');
    expect(outcome.error).toContain('n=1');
  });
});

describe('ReplayMissError', () => {
  it('names the fixture, the served turns and the next expected one', () => {
    const error = new ReplayMissError(
      'resolve/agree-r1',
      'a'.repeat(64),
      [1],
      [
        { n: 1, wireHash: 'b'.repeat(64), loop: 'resolve', roundN: 1, response: {} },
        { n: 2, wireHash: 'c'.repeat(64), loop: 'resolve', roundN: 2, response: {} },
      ],
    );
    expect(error.message).toContain('resolve/agree-r1');
    expect(error.message).toContain('n=2');
    expect(error.message).toContain('round 2');
    expect(error.message).toContain('Turns served so far: 1');
  });
});
