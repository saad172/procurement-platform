import { asc, eq } from 'drizzle-orm';
import { getPooledDb } from '@/db/client';
import * as t from '@/db/schema';
import { loadEnv } from '@/config/env';
import { createUpstream } from '@/upstream';
import { openRun } from '@/jobs/runs';
import { getRegistry } from '@/tools';
import { runLoop } from '@/model';
import { buildPageBlock, toChatTools, type PendingProposal } from '@/model/chat-tools';
import * as chatPrompts from '@/model/prompts/chat';

/**
 * The chat route handler (SPEC §14, §2.2).
 *
 * Runs in the **web** process, on the **same `runLoop()`** the worker uses —
 * that shared chokepoint is why a chat turn is metered and priced exactly like
 * a Job turn even though chat has no Trace.
 *
 * **Chat has no Trace**, because `thread_message.role` widens to
 * `user | assistant | tool`, which makes the transcript the complete record.
 * Trace stays a Job artifact carrying replay semantics a conversation cannot
 * honour — and that is also what lets chat afford context editing, which is in
 * tension with replay.
 *
 * **One in-flight turn per Thread.** The input is disabled while streaming, so
 * there is no interleaving to reason about.
 */

export const dynamic = 'force-dynamic';

type ChatRequest = {
  threadId?: string;
  programId: string;
  message: string;
  pageRef: string;
  viewState?: Record<string, unknown>;
};

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json()) as ChatRequest;
  const env = loadEnv();
  const db = getPooledDb();
  const registry = getRegistry();

  // ── The Thread ───────────────────────────────────────────────────────────
  let threadId = body.threadId;
  if (!threadId) {
    const [thread] = await db
      .insert(t.thread)
      .values({
        programId: body.programId,
        // Auto-titled from the first message and the page it was opened from,
        // never manually named, never deleted.
        title: `${body.message.slice(0, 48)}${body.message.length > 48 ? '…' : ''}`,
      })
      .returning({ id: t.thread.id });
    threadId = thread!.id;
  }

  await db.insert(t.threadMessage).values({
    threadId,
    role: 'user',
    text: body.message,
    // The page AND its view state, because chat that could not see the rail
    // would answer about a ranking the person is not looking at.
    pageRef: body.pageRef,
  });

  const history = await db
    .select()
    .from(t.threadMessage)
    .where(eq(t.threadMessage.threadId, threadId))
    .orderBy(asc(t.threadMessage.createdAt));

  /**
   * A Thread's first **model** turn lazily opens one Run, to which every later
   * spend in the Thread attaches — so every amount the app spends sits inside
   * exactly one Run with no orphan path.
   *
   * That Run carries **no budget**: a Thread has no N, and chat's inline
   * lookups never reach a dequeue point or a Round boundary. **The confirm gate
   * is the bound, and it is the stronger one.**
   */
  const existingRun = await db.query.run.findFirst({ where: eq(t.run.threadId, threadId) });
  const runId =
    existingRun?.id ??
    (await openRun(db, { programId: body.programId, trigger: 'thread', threadId }));

  const upstream = createUpstream({
    db,
    runId,
    credentials: {
      sayariClientId: env.SAYARI_CLIENT_ID,
      sayariClientSecret: env.SAYARI_CLIENT_SECRET,
      nominatimUserAgent: env.NOMINATIM_USER_AGENT,
    },
  });

  const proposals: PendingProposal[] = [];
  const widgets: { toolName: string; widget: unknown }[] = [];

  const chatTools = registry.forSurface('chat');
  const tools = toChatTools(
    chatTools,
    { db, upstream, meter: { addModelTokens: () => {} }, runId, surface: 'chat' },
    {
      onProposal: (proposal) => proposals.push(proposal),
      onResult: (toolName, result) => {
        if (result.widget) widgets.push({ toolName, widget: result.widget });
      },
    },
  );

  // …history, {role:'user'}, {role:'system', <page block>}
  const messages = [
    ...history
      .filter((row) => row.role !== 'tool' && row.text)
      .map((row) => ({ role: row.role as 'user' | 'assistant', content: row.text! })),
    buildPageBlock(body.pageRef, body.viewState ?? {}),
  ];

  const outcome = await runLoop(
    {
      loop: 'chat',
      system: chatPrompts.system,
      tools,
      messages: messages as never,
      // Chat has no per-Job ceiling in the Job sense; the confirm gate bounds it.
      caps: { toolCalls: 20, tokens: 0 },
      toolDigest: registry.digest(chatTools),
    },
    // No jobId: chat spends inside a Run but outside any Job, and writes no
    // trace_turn at all.
    { db, runId, credentials: { apiKey: env.ANTHROPIC_API_KEY } },
  );

  const text =
    outcome.status === 'done'
      ? ((outcome.finalMessage as { content?: { type: string; text?: string }[] } | undefined)?.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n')
          .trim()
      : `That did not work: ${'error' in outcome ? outcome.error : outcome.status}`;

  // Every tool call is its own row, which is what makes the transcript the
  // complete record and is why chat needs no Trace.
  for (const { toolName, widget } of widgets) {
    await db.insert(t.threadMessage).values({
      threadId,
      role: 'tool',
      text: toolName,
      widget: widget as never,
      pageRef: body.pageRef,
    });
  }

  // A proposal is stored with its estimate FROZEN, in the state `proposed`.
  // Nothing has run.
  for (const proposal of proposals) {
    await db.insert(t.threadMessage).values({
      threadId,
      role: 'assistant',
      text: proposal.estimate.what,
      confirm: { toolName: proposal.toolName, input: proposal.input, estimate: proposal.estimate } as never,
      confirmState: 'proposed',
      pageRef: body.pageRef,
    });
  }

  await db.insert(t.threadMessage).values({
    threadId,
    role: 'assistant',
    text,
    pageRef: body.pageRef,
  });

  return Response.json({ threadId, text, widgets, proposals });
}
