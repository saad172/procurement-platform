import { eq } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { loadEnv } from '@/config/env';
import { createUpstream } from '@/upstream';
import { getRegistry, type Estimate } from '@/tools';

/**
 * Accepting or declining a proposal (SPEC §14.5).
 *
 * **A decline writes a message** — `role: assistant`, the estimate still
 * frozen, state `declined` — and the model is told, so it can offer a cheaper
 * alternative instead of silently re-proposing. A decline that left no trace
 * would leave the model free to propose the same spend again next turn.
 *
 * **The estimate is not written back to.** A message that silently gains an
 * actual is a rewritten record, so the comparison lives on the Run page
 * instead.
 */
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const { messageId, accept } = (await request.json()) as { messageId: string; accept: boolean };
  const db = getPooledDb();

  const message = await db.query.threadMessage.findFirst({
    where: eq(t.threadMessage.id, messageId),
  });
  if (!message?.confirm) return Response.json({ error: 'no such proposal' }, { status: 404 });

  /**
   * **A proposal is answered once.**
   *
   * The frozen state is the record of the answer, and nothing read it: posting
   * the same `messageId` twice ran the tool twice, which for an `enqueue_*`
   * means a second Run and a second Job — spending, from a double-click or a
   * retried request, that no one pressed a button for. The confirm gate's whole
   * claim is that a spend is a person's act, and an act happens once.
   *
   * Refused with a sentence rather than silently ignored, because the second
   * caller is usually a client that thinks it has not been answered yet.
   */
  if (message.confirmState !== 'proposed') {
    return Response.json(
      {
        error: `This proposal was already ${message.confirmState ?? 'answered'}. A proposal is answered once, so nothing ran.`,
      },
      { status: 409 },
    );
  }

  const proposal = message.confirm as { toolName: string; input: unknown; estimate: Estimate };

  if (!accept) {
    await db
      .update(t.threadMessage)
      .set({ confirmState: 'declined' })
      .where(eq(t.threadMessage.id, messageId));
    return Response.json({ declined: true });
  }

  const thread = await db.query.thread.findFirst({ where: eq(t.thread.id, message.threadId) });
  const run = await db.query.run.findFirst({ where: eq(t.run.threadId, message.threadId) });
  if (!thread || !run) return Response.json({ error: 'no run for this thread' }, { status: 500 });

  const env = loadEnv();
  const registry = getRegistry();
  const tool = registry.byName.get(proposal.toolName);
  if (!tool) return Response.json({ error: 'no such tool' }, { status: 404 });

  const upstream = createUpstream({
    db,
    runId: run.id,
    credentials: {
      sayariClientId: env.SAYARI_CLIENT_ID,
      sayariClientSecret: env.SAYARI_CLIENT_SECRET,
      nominatimUserAgent: env.NOMINATIM_USER_AGENT,
    },
  });

  // NOW it runs — after a person read an estimate and pressed a button.
  const result = await tool.handler(proposal.input as never, {
    db,
    upstream,
    meter: { addModelTokens: () => {} },
    runId: run.id,
    surface: 'chat',
  });

  await db
    .update(t.threadMessage)
    .set({
      confirmState: 'accepted',
      // Where accepting enqueued a Job, the message points at it — so the
      // status strip can poll the `job` row. The APP announces completion, not
      // the model: a model turn would write prose about results it has not read.
      jobId: result.ok ? ((result.data as { jobId?: string } | undefined)?.jobId ?? null) : null,
    })
    .where(eq(t.threadMessage.id, messageId));

  await db.insert(t.threadMessage).values({
    threadId: message.threadId,
    role: 'tool',
    text: proposal.toolName,
    widget: (result.ok ? { type: 'source_result', payload: result.data } : null) as never,
    pageRef: message.pageRef,
  });

  return Response.json({ ok: result.ok, data: result.ok ? result.data : result.objections });
}
