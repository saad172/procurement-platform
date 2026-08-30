// Next.js loads `.env` itself; a plain Node entrypoint has to ask.
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { and, eq, gte, isNotNull } from 'drizzle-orm';
import { closeDirectDb, getDirectDb } from '@/db/client';
import * as t from '@/db/schema';
import { loadEnv } from '@/config/env';
import { runChatTurn } from '@/chat/turn';
import { resetAnthropicClients } from '@/model/client';
import { recordingFetch, type RecordingSink } from '@/fixtures/record-fetch';
import { fixtureDigest, serializeFixture } from '@/fixtures/record';
import { buildManifest } from '@/model';
import { getRegistry } from '@/tools';
import type { Fixture, FixtureUpstreamRow } from '@/fixtures/types';

/**
 * Records the `chat/one-turn` fixture (SPEC §19.2).
 *
 *   pnpm fixtures:record-chat [message]
 *
 * **Chat needs its own recorder because chat has no Trace.** The other six
 * fixtures are exports of `trace_turn` rows; `writeTurn` returns early when
 * there is no `jobId`, so for chat there is nothing to export. It is captured
 * at the same seam it is replayed at instead — see `record-fetch.ts` for why
 * that symmetry is the argument rather than a workaround.
 *
 * **It spends Anthropic tokens** and, depending on the question, Sayari credits.
 */

const FIXTURE_NAME = 'chat/one-turn';

/**
 * A question chosen to exercise what this fixture is the sole home of: a widget
 * frozen onto a message, and a **confirm proposal that creates no `job` row**.
 *
 * It has to name something an `enqueue_*` tool actually does **from the state
 * the fixture is recorded in**, or the gate never engages and the fixture
 * proves only that reads work.
 *
 * Two attempts failed that way, and neither was the model's fault:
 *
 * - *"re-run the identity match"* — there is no `enqueue_resolve` tool at all,
 *   so it did three honest reads and proposed nothing.
 * - *"re-assess it"* — recorded against a reset database, where the Supplier
 *   has no Match and no Assessment, so a re-assessment is not a thing that can
 *   be re-run. It read four rows and correctly declined.
 *
 * Enrichment is the one that works from seed state: `enqueue_enrichment`
 * re-fetches the six sources for any Supplier, so the gate engages whatever
 * else is in the database — which is exactly what an *independent* fixture
 * needs.
 */
const DEFAULT_MESSAGE = 'Show me Yazaki, then refresh its enrichment data.';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = getDirectDb();

  try {
    const program = await db.query.program.findFirst();
    if (!program) {
      console.error('Seed the database first: pnpm db:seed');
      process.exitCode = 1;
      return;
    }

    const message = process.argv[2] ?? DEFAULT_MESSAGE;
    const startedAt = new Date();

    /**
     * The recording client is built here and the module cache cleared around
     * it, so the recording fetch cannot leak into a later call and a cached
     * production client cannot serve this one.
     */
    resetAnthropicClients();
    const sink: RecordingSink = { turns: [] };
    const recorded = recordingFetch(fetch, sink, { loop: 'chat' });

    const events: { event: string; data: unknown }[] = [];
    await runChatTurn(
      {
        db,
        upstreamCredentials: {
          sayariClientId: env.SAYARI_CLIENT_ID,
          sayariClientSecret: env.SAYARI_CLIENT_SECRET,
          nominatimUserAgent: env.NOMINATIM_USER_AGENT,
        },
        modelCredentials: { apiKey: env.ANTHROPIC_API_KEY, fetch: recorded },
      },
      { programId: program.id, message, pageRef: `/program/${program.id}` },
      (event, data) => events.push({ event, data }),
    );
    resetAnthropicClients();

    const done = events.find((entry) => entry.event === 'done')?.data as
      | { threadId: string; text: string; widgets: unknown[]; proposals: unknown[] }
      | undefined;
    if (!done) {
      console.error('The turn produced no `done` event, so there is nothing to record.');
      process.exitCode = 1;
      return;
    }

    const run = await db.query.run.findFirst({ where: eq(t.run.threadId, done.threadId) });

    /**
     * Upstream bodies are captured by **time window** — every row written since
     * the turn began.
     *
     * That is complete only if every upstream call this turn made was live. A
     * cache *hit* reused a row that already existed, which the window misses,
     * and a fixture missing a body it needs fails at replay with a cache miss
     * rather than here. So a hit is refused now, where the fix is obvious.
     */
    const upstreamUsage = run
      ? await db
          .select({ endpoint: t.usageEvent.endpoint, cacheHit: t.usageEvent.cacheHit })
          .from(t.usageEvent)
          .where(and(eq(t.usageEvent.runId, run.id), isNotNull(t.usageEvent.source)))
      : [];

    const hits = upstreamUsage.filter((row) => row.cacheHit);
    if (hits.length > 0) {
      console.error(
        [
          `${hits.length} upstream call(s) were served from cache, so their bodies were not`,
          'written during this turn and the fixture would be missing them:',
          ...hits.map((row) => `  ${row.endpoint}`),
          '',
          'Delete those `upstream_response` rows and record again, so every body the',
          'fixture needs is captured in the window.',
        ].join('\n'),
      );
      process.exitCode = 1;
      return;
    }

    const upstreamRows = await db
      .select()
      .from(t.upstreamResponse)
      .where(gte(t.upstreamResponse.fetchedAt, startedAt));

    const upstream: FixtureUpstreamRow[] = upstreamRows.map((row) => ({
      source: row.source,
      endpoint: row.endpoint,
      paramsHash: row.paramsHash,
      params: row.params,
      body: row.body,
      bodyHash: row.bodyHash,
      via: row.via,
    }));

    const registry = getRegistry();
    const chatDigest = registry.digest(registry.forSurface('chat')).hash;
    const chatManifest = buildManifest({ chat: chatDigest }).find((entry) => entry.loop === 'chat')!;

    const fixture: Fixture = {
      manifest: {
        name: FIXTURE_NAME,
        recordedAt: new Date().toISOString(),
        loopHashes: { chat: chatManifest.hash },
        toolDigests: { chat: chatDigest },
      },
      turns: sink.turns,
      upstream,
    };

    const path = join(process.cwd(), 'tests', 'fixtures', `${FIXTURE_NAME}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, serializeFixture(fixture));

    console.warn(
      [
        '',
        `  ${FIXTURE_NAME}`,
        `    ${fixture.turns.length} turn(s), ${fixture.turns.filter((turn) => turn.sse).length} streamed`,
        `    ${upstream.length} cached upstream row(s)`,
        `    ${done.widgets.length} widget(s), ${done.proposals.length} proposal(s)`,
        `    digest ${fixtureDigest(fixture).slice(0, 16)}…`,
        `    written to ${path}`,
        '',
      ].join('\n'),
    );
  } finally {
    await closeDirectDb();
  }
}

void main();
