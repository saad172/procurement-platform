import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { runChatTurn } from '@/chat/turn';
import { resetAnthropicClients } from '@/model/client';
import { replayFetch } from '@/fixtures/replay-fetch';
import { loadFixture } from '@/fixtures/load';
import { seedUpstream } from '@/fixtures/replay-upstream';
import { getTestDb, testDatabaseIsUp } from '../support/test-db';

/**
 * `chat/one-turn` (SPEC §19.2) — the sole home of three claims:
 *
 * 1. a widget **freezes onto a message**;
 * 2. a confirm **freezes onto a message**, with its estimate;
 * 3. **no `job` row exists until the confirm is accepted**.
 *
 * The third is the one worth a fixture. Everything else in this app is bounded
 * by counting after the fact; the confirm gate is the one control that stops a
 * write *before* it happens, and "the model asked to spend and nothing spent"
 * is not a claim a unit test on our own code can make — the model has to
 * genuinely ask.
 *
 * ## Why chat is recorded differently
 *
 * Chat has no Trace, so there are no `trace_turn` rows to export. It is
 * captured at the same seam it is replayed at (`recordingFetch` /
 * `replayFetch`), and the turns come back as the **raw SSE text** the API sent —
 * so the streaming path is part of what runs here, rather than something a
 * replay reassembles.
 */

const FIXTURE = 'chat/one-turn';

describe('chat/one-turn replays', () => {
  it('freezes a widget and a confirm, and creates no job', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const fixture = await loadFixture(FIXTURE);

    const [program] = await db.select().from(t.program).limit(1);
    if (!program) return;

    await seedUpstream(db, fixture);
    resetAnthropicClients();

    const events: { event: string; data: unknown }[] = [];
    await runChatTurn(
      {
        db,
        // No upstream credentials and no usable model key: keyless by
        // construction, not by a mock that could be bypassed.
        modelCredentials: { apiKey: 'not-a-key', fetch: replayFetch(fixture) },
      },
      {
        programId: program.id,
        message: 'Show me Yazaki, then re-assess it.',
        pageRef: `/program/${program.id}`,
      },
      (event, data) => events.push({ event, data }),
    );

    // ── The event contract: open once, deltas, then exactly one done ────────
    expect(events[0]?.event).toBe('open');
    expect(events.filter((entry) => entry.event === 'delta').length).toBeGreaterThan(0);
    expect(events.filter((entry) => entry.event === 'done')).toHaveLength(1);
    expect(events.filter((entry) => entry.event === 'error')).toHaveLength(0);

    const done = events.at(-1)!.data as {
      threadId: string;
      text: string;
      widgets: { toolName: string }[];
      proposals: { toolName: string; estimate: { what: string } }[];
    };
    expect(events.at(-1)!.event).toBe('done');

    // ── Frozen onto messages, not merely returned ───────────────────────────
    const messages = await db
      .select()
      .from(t.threadMessage)
      .where(eq(t.threadMessage.threadId, done.threadId));

    const widgetRows = messages.filter((row) => row.widget != null);
    expect(widgetRows.length).toBe(done.widgets.length);
    expect(widgetRows.every((row) => row.role === 'tool')).toBe(true);

    const confirmRows = messages.filter((row) => row.confirm != null);
    expect(confirmRows.length).toBe(done.proposals.length);
    expect(confirmRows.length).toBeGreaterThan(0);
    // `proposed` is the frozen state. Nothing has run.
    expect(confirmRows.every((row) => row.confirmState === 'proposed')).toBe(true);

    // The estimate is frozen WITH the proposal, so what the person agreed to is
    // what they were shown — recomputing it at accept time would let the number
    // move between the question and the answer.
    for (const row of confirmRows) {
      const confirm = row.confirm as { toolName?: string; estimate?: { what?: string } };
      expect(confirm.toolName).toMatch(/^enqueue_/);
      expect(confirm.estimate?.what).toBeTruthy();
    }

    // ── The claim this fixture exists for ───────────────────────────────────
    const run = await db.query.run.findFirst({ where: eq(t.run.threadId, done.threadId) });
    expect(run, 'a chat turn opens exactly one Run, so spend has no orphan path').toBeDefined();

    const jobs = await db.select().from(t.job).where(eq(t.job.runId, run!.id));
    expect(jobs, 'the model proposed a job and the gate created none').toHaveLength(0);
  });

  it('spends nothing on the model, because every turn came from the fixture', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();

    /**
     * A replayed turn still writes `usage_event` rows — the bookkeeping runs on
     * the recorded message exactly as it would on a live one, which is what
     * makes a replay a test of the metering too.
     *
     * What it must not do is reach the network. That is guaranteed by the key
     * being unusable rather than asserted here; this checks the other half —
     * that the rows were written at all.
     */
    const usage = await db
      .select()
      .from(t.usageEvent)
      .where(and(eq(t.usageEvent.endpoint, 'messages.toolRunner')));
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((row) => row.model != null)).toBe(true);
  });
});
