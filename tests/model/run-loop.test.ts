import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { z } from 'zod/v4';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as t from '@/db/schema';
import { runLoop } from '@/model';
import { resetAnthropicClients } from '@/model/client';
import { JOB_CAPS } from '@/config/constants';
import { getTestDb, testDatabaseIsUp, type TestDb } from '../support/test-db';
import { seededProgram } from '../support/seeded-program';

/**
 * The chokepoint's own behaviour, over canned turns (SPEC §17.2, §17.6).
 *
 * A replay fixture proves the loop against turns a model really produced; these
 * prove the branches a recording cannot contain, because they are the ones a
 * healthy run never takes — a truncated turn, and a second call inside the same
 * Job. The canned `fetch` sits at the same seam `replayFetch` uses, so the real
 * client and the real Tool Runner still run.
 */

type CannedTurn = {
  content?: unknown[];
  stop_reason?: string;
  usage?: Record<string, number>;
};

/** Serves canned turns and keeps every request body it was asked with. */
function cannedFetch(turns: CannedTurn[]): { fetch: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  let n = 0;
  const fetchImpl = (async (_input: unknown, init?: { body?: unknown }) => {
    if (typeof init?.body === 'string') bodies.push(init.body);
    const turn = turns[Math.min(n, turns.length - 1)]!;
    n += 1;
    return new Response(
      JSON.stringify({
        id: `msg_canned_${n}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: turn.content ?? [{ type: 'text', text: 'answered' }],
        stop_reason: turn.stop_reason ?? 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          ...turn.usage,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, bodies };
}

const noopTool = betaZodTool({
  name: 'get_nothing',
  description: 'Returns nothing at all.',
  inputSchema: z.object({}),
  run: async () => 'nothing',
});

async function openJob(db: TestDb, programId: string, kind: 'assess' = 'assess') {
  const [run] = await db
    .insert(t.run)
    .values({ programId, state: 'running', trigger: 'test', subjectLabel: 'run-loop' })
    .returning({ id: t.run.id });
  const [job] = await db
    .insert(t.job)
    .values({
      runId: run!.id,
      kind,
      subjectType: 'program',
      subjectId: programId,
      state: 'running',
      toolCallCap: JOB_CAPS[kind].toolCalls,
      tokenCap: JOB_CAPS[kind].tokens,
    })
    .returning({ id: t.job.id });
  return { runId: run!.id, jobId: job!.id };
}

describe('a truncated turn is not a mis-shaped draft', () => {
  it('fails naming the stop reason, rather than passing a half-written message off as done', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const program = await seededProgram(db);
    if (!program) return;
    resetAnthropicClients();

    const { runId, jobId } = await openJob(db, program.id);
    const canned = cannedFetch([{ stop_reason: 'max_tokens' }]);

    const outcome = await runLoop(
      {
        loop: 'assess',
        system: 'A system prompt.',
        tools: [noopTool],
        messages: [{ role: 'user', content: 'Write something long.' }],
        caps: JOB_CAPS.assess,
      },
      { db, runId, jobId, credentials: { apiKey: 'not-a-key', fetch: canned.fetch } },
    );

    // `max_tokens` ends the SDK's loop, so this used to arrive as `done` with a
    // truncated final message and be reported as a refinement failure.
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.error).toContain('max_tokens');
    expect(outcome.error).toContain('16,000');
  });

  it('does the same for model_context_window_exceeded', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const program = await seededProgram(db);
    if (!program) return;
    resetAnthropicClients();

    const { runId, jobId } = await openJob(db, program.id);
    const canned = cannedFetch([{ stop_reason: 'model_context_window_exceeded' }]);

    const outcome = await runLoop(
      {
        loop: 'assess',
        system: 'A system prompt.',
        tools: [noopTool],
        messages: [{ role: 'user', content: 'Read everything.' }],
        caps: JOB_CAPS.assess,
      },
      { db, runId, jobId, credentials: { apiKey: 'not-a-key', fetch: canned.fetch } },
    );

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.error).toContain('model_context_window_exceeded');
  });
});

describe('the ceilings count the whole Job', () => {
  it('carries a first call’s spend into the second, because a Job calls the loop many times', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const program = await seededProgram(db);
    if (!program) return;
    resetAnthropicClients();

    const { runId, jobId } = await openJob(db, program.id);
    const ctx = {
      db,
      runId,
      jobId,
      credentials: { apiKey: 'not-a-key', fetch: cannedFetch([{}]).fetch },
    };
    const params = {
      loop: 'assess' as const,
      system: 'A system prompt.',
      tools: [noopTool],
      messages: [{ role: 'user' as const, content: 'One question.' }],
      caps: JOB_CAPS.assess,
    };

    const first = await runLoop(params, ctx);
    const second = await runLoop(params, {
      ...ctx,
      credentials: { apiKey: 'not-a-key', fetch: cannedFetch([{}]).fetch },
    });

    expect(first.status).toBe('done');
    expect(second.status).toBe('done');
    if (first.status !== 'done' || second.status !== 'done') return;

    // 110 tokens per canned turn, seeded from `usage_event` on the second call.
    expect(first.tokens).toBe(110);
    expect(second.tokens).toBe(220);

    // And the Job's own ledger says so, which nothing wrote before.
    const job = await db.query.job.findFirst({ where: eq(t.job.id, jobId) });
    expect(job!.tokensUsed).toBe(220);
  });

  it('terminates when the running total crosses the ceiling, naming it', async () => {
    if (!(await testDatabaseIsUp())) return;
    const db = await getTestDb();
    const program = await seededProgram(db);
    if (!program) return;
    resetAnthropicClients();

    const { runId, jobId } = await openJob(db, program.id);
    const canned = cannedFetch([{ usage: { input_tokens: 10, output_tokens: 1 } }]);

    const outcome = await runLoop(
      {
        loop: 'assess',
        system: 'A system prompt.',
        tools: [noopTool],
        messages: [{ role: 'user', content: 'One question.' }],
        // A ceiling below one turn, so the first turn crosses it.
        caps: { toolCalls: 40, tokens: 5 },
      },
      { db, runId, jobId, credentials: { apiKey: 'not-a-key', fetch: canned.fetch } },
    );

    expect(outcome.status).toBe('terminated');
    if (outcome.status !== 'terminated') return;
    expect(outcome.reason).toContain('5-token ceiling');
  });
});
