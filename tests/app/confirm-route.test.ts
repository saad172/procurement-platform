import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import { loadEnv, resetEnvForTesting } from '@/config/env';
import { closePooledDb } from '@/db/client';
import { TEST_DATABASE_URL, getTestDb, testDatabaseIsUp, type TestDb } from '../support/test-db';
import { seededProgram } from '../support/seeded-program';

/**
 * The confirm gate, at the route (SPEC §14.5).
 *
 * **The gate is the bound on chat spend**, and it is the stronger one precisely
 * because it stops a write before it happens rather than counting reads after
 * the fact. That claim rests on a proposal being answered *once*: the route
 * never read `confirmState`, so posting the same `messageId` twice ran the tool
 * twice — a second `openRun` and a second `enqueueJob` from a double-click.
 *
 * The route reads the **pooled** connection, so the environment is pointed at
 * the test database before anything opens it. Nothing here reaches a model or
 * an upstream: `enqueue_reassess` opens a Run and queues a Job, which is
 * exactly the write the gate exists to hold back.
 */

const up = await testDatabaseIsUp();

describe.skipIf(!up)('POST /api/chat/confirm', () => {
  let db: TestDb;
  let post: (request: Request) => Promise<Response>;
  let supplierId: string;
  let threadId: string;
  let messageId: string;
  /** The Run the accepted proposal opened, so it can be taken away again. */
  let acceptedRunId: string | undefined;

  beforeAll(async () => {
    db = await getTestDb();

    resetEnvForTesting();
    loadEnv({
      DATABASE_URL: TEST_DATABASE_URL,
      DIRECT_DATABASE_URL: TEST_DATABASE_URL,
      SAYARI_CLIENT_ID: 'not-a-key',
      SAYARI_CLIENT_SECRET: 'not-a-key',
      ANTHROPIC_API_KEY: 'not-a-key',
    });
    ({ POST: post } = await import('@/app/api/chat/confirm/route'));

    const program = await seededProgram(db);
    const supplier = await db.query.supplier.findFirst({
      where: eq(t.supplier.programId, program!.id),
    });
    supplierId = supplier!.id;

    const [thread] = await db
      .insert(t.thread)
      .values({ programId: program!.id, title: 'confirm fixture' })
      .returning({ id: t.thread.id });
    threadId = thread!.id;

    // A Thread's Run carries no budget: the gate is the bound instead.
    await db
      .insert(t.run)
      .values({ programId: program!.id, state: 'running', trigger: 'thread', threadId });

    const [message] = await db
      .insert(t.threadMessage)
      .values({
        threadId,
        role: 'assistant',
        text: 'Re-run this supplier’s assessment.',
        confirm: {
          toolName: 'enqueue_reassess',
          input: { supplierId },
          estimate: {
            what: 'Re-run this supplier’s assessment.',
            spends: { modelTokens: { min: 40_000, max: 450_000 } },
            basis: 'Up to three proposer/evaluator rounds.',
            caveats: [],
          },
        } as never,
        confirmState: 'proposed',
        pageRef: `/program/${program!.id}`,
      })
      .returning({ id: t.threadMessage.id });
    messageId = message!.id;
  });

  afterAll(async () => {
    if (!up) return;
    // The accepted proposal opens a Run of its own and queues a Job in it, and
    // `dequeueJob` takes the oldest queued Job ANYWHERE — one left behind here
    // is one another suite claims, while proving that two workers never take
    // the same Job.
    if (acceptedRunId) await db.delete(t.run).where(eq(t.run.id, acceptedRunId));
    await db.delete(t.thread).where(eq(t.thread.id, threadId));
    await closePooledDb();
    resetEnvForTesting();
  });

  const confirm = (accept: boolean) =>
    post(
      new Request('http://localhost/api/chat/confirm', {
        method: 'POST',
        body: JSON.stringify({ messageId, accept }),
      }),
    );

  it('runs the tool once, and refuses the second post with a sentence', async () => {
    const first = await confirm(true);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { ok: boolean; data: { runId: string } };
    expect(body.ok).toBe(true);
    acceptedRunId = body.data.runId;

    const afterFirst = await db.select().from(t.job);
    const queuedForSupplier = afterFirst.filter((job) => job.subjectId === supplierId);
    expect(queuedForSupplier).toHaveLength(1);

    // The same post again — a double-click, or a client that retried.
    const second = await confirm(true);
    expect(second.status).toBe(409);
    expect((await second.json()).error).toMatch(/answered once/);

    const afterSecond = await db.select().from(t.job);
    expect(
      afterSecond.filter((job) => job.subjectId === supplierId),
      'the second post enqueued a second Job',
    ).toHaveLength(1);
  });

  it('refuses a decline of a proposal that was already accepted', async () => {
    // A decline writes a message and tells the model, so a decline after an
    // accept would leave the transcript claiming both.
    const declined = await confirm(false);
    expect(declined.status).toBe(409);

    const message = await db.query.threadMessage.findFirst({
      where: eq(t.threadMessage.id, messageId),
    });
    expect(message!.confirmState).toBe('accepted');
  });
});
