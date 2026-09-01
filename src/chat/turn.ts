import { asc, eq } from 'drizzle-orm';
import * as t from '@/db/schema';
import type { Database } from '@/db/client';
import { createUpstream } from '@/upstream';
import type { UpstreamCredentials } from '@/upstream/types';
import { openRun } from '@/jobs/runs';
import { getRegistry, type Registry } from '@/tools';
import { runLoop } from '@/model';
import type { ModelCredentials } from '@/model/types';
import { buildPageBlock, toChatTools, type PendingProposal } from '@/model/chat-tools';
import * as chatPrompts from '@/model/prompts/chat';
import { CHAT_TOOL_CALL_CAP } from '@/config/constants';

/**
 * One chat turn (SPEC §14, §2.2).
 *
 * Lifted out of the route handler so that **the recorded path and the served
 * path are the same code**. A fixture captured from a script that re-created
 * the route's setup by hand would prove only that the script works.
 *
 * It runs in the **web** process, on the **same `runLoop()`** the worker uses —
 * that shared chokepoint is why a chat turn is metered and priced exactly like
 * a Job turn even though chat has no Trace.
 *
 * **Chat has no Trace**, because `thread_message.role` widens to
 * `user | assistant | tool`, which makes the transcript the complete record.
 * Trace stays a Job artifact carrying replay semantics a conversation cannot
 * honour — and that is also what lets chat afford context editing, which is in
 * tension with replay.
 */

export type ChatTurnRequest = {
  threadId?: string | undefined;
  programId: string;
  message: string;
  pageRef: string;
  viewState?: Record<string, string | string[] | undefined> | undefined;
};

export type ChatTurnDeps = {
  db: Database;
  /**
   * Omitted under replay, which is the whole mechanism rather than a mode flag:
   * a wrapper built without credentials cannot fall through to a live call, so
   * it stops and names the key it missed (SPEC §16, §19.1).
   */
  upstreamCredentials?: UpstreamCredentials | undefined;
  modelCredentials: ModelCredentials;
};

/**
 * The turn's events, in order: `open` once, `delta` many, then exactly one of
 * `done` or `error`.
 *
 * A callback rather than a stream, so this function owns the ordering — the
 * caller decides how to transport an event, never whether it happens.
 */
export type ChatEmit = (event: 'open' | 'delta' | 'done' | 'error', data: unknown) => void;

/**
 * The spine. Reads top to bottom as the phases named above: the Thread, the
 * Run, the tools a turn may call, the turn itself, and the transcript it
 * leaves behind.
 */
export async function runChatTurn(
  deps: ChatTurnDeps,
  request: ChatTurnRequest,
  emit: ChatEmit,
): Promise<void> {
  const { db } = deps;
  const registry = getRegistry();

  // ── The Thread ─────────────────────────────────────────────────────────────
  const { threadId, history } = await ensureThread(db, request, emit);

  // ── The Run ────────────────────────────────────────────────────────────────
  const runId = await ensureRun(db, request, threadId);
  const upstream = createUpstream({ db, runId, credentials: deps.upstreamCredentials });

  // ── The tools this turn may call ────────────────────────────────────────────
  const { chatTools, tools, proposals, widgets } = buildChatTools(registry, db, upstream, runId, request);

  // …history, {role:'user'}, {role:'system', <page block>}
  const messages = [
    ...history
      .filter((row) => row.role !== 'tool' && row.text)
      .map((row) => ({ role: row.role as 'user' | 'assistant', content: row.text! })),
    buildPageBlock(request.pageRef, request.viewState ?? {}),
  ];

  const outcome = await runLoop(
    {
      loop: 'chat',
      system: chatPrompts.system,
      tools,
      messages: messages as never,
      // Chat has no per-Job ceiling in the Job sense; the confirm gate bounds it.
      caps: { toolCalls: CHAT_TOOL_CALL_CAP, tokens: 0 },
      toolDigest: registry.digest(chatTools),
      onTextDelta: (delta) => emit('delta', delta),
    },
    // No jobId: chat spends inside a Run but outside any Job, and writes no
    // trace_turn at all.
    { db, runId, credentials: deps.modelCredentials },
  );

  const text =
    outcome.status === 'done'
      ? ((outcome.finalMessage as { content?: { type: string; text?: string }[] } | undefined)?.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n')
          .trim()
      : `That did not work: ${'error' in outcome ? outcome.error : outcome.status}`;

  // ── The transcript is written before `done` is emitted ─────────────────────
  await writeTranscript(db, { threadId, widgets, proposals, text, pageRef: request.pageRef });

  emit('done', { threadId, text, widgets, proposals });
}

/**
 * ── The Thread ────────────────────────────────────────────────────────────
 *
 * Gets or creates the Thread, records the user's message, emits `open` —
 * before any text, so a client can attach to a brand-new Thread whose id it
 * could not otherwise know until the turn ended — then loads the history the
 * rest of the turn reads from.
 */
async function ensureThread(
  db: Database,
  request: ChatTurnRequest,
  emit: ChatEmit,
): Promise<{ threadId: string; history: (typeof t.threadMessage.$inferSelect)[] }> {
  let threadId = request.threadId;
  if (!threadId) {
    const [thread] = await db
      .insert(t.thread)
      .values({
        programId: request.programId,
        // Auto-titled from the first message and the page it was opened from,
        // never manually named, never deleted.
        title: `${request.message.slice(0, 48)}${request.message.length > 48 ? '…' : ''}`,
      })
      .returning({ id: t.thread.id });
    threadId = thread!.id;
  }

  await db.insert(t.threadMessage).values({
    threadId,
    role: 'user',
    text: request.message,
    // The page AND its view state, because chat that could not see the rail
    // would answer about a ranking the person is not looking at.
    pageRef: request.pageRef,
  });

  // Emitted before any text, so a client can attach to a brand-new Thread whose
  // id it could not otherwise know until the turn ended.
  emit('open', { threadId });

  const history = await db
    .select()
    .from(t.threadMessage)
    .where(eq(t.threadMessage.threadId, threadId))
    .orderBy(asc(t.threadMessage.createdAt));

  return { threadId, history };
}

/**
 * ── The Run ───────────────────────────────────────────────────────────────
 *
 * A Thread's first **model** turn lazily opens one Run, to which every later
 * spend in the Thread attaches — so every amount the app spends sits inside
 * exactly one Run with no orphan path.
 *
 * That Run carries **no budget**: a Thread has no N, and chat's inline
 * lookups never reach a dequeue point or a Round boundary. **The confirm gate
 * is the bound, and it is the stronger one.**
 */
async function ensureRun(db: Database, request: ChatTurnRequest, threadId: string): Promise<string> {
  const existingRun = await db.query.run.findFirst({ where: eq(t.run.threadId, threadId) });
  return (
    existingRun?.id ?? (await openRun(db, { programId: request.programId, trigger: 'thread', threadId }))
  );
}

/**
 * ── The tools this turn may call ─────────────────────────────────────────
 *
 * Wired to collect this turn's proposals and widgets as `runLoop` drives
 * them — `proposals` and `widgets` are the exact arrays the transcript phase
 * later writes, mutated in place by the callbacks below as tools run.
 */
function buildChatTools(
  registry: Registry,
  db: Database,
  upstream: ReturnType<typeof createUpstream>,
  runId: string,
  request: ChatTurnRequest,
) {
  const proposals: PendingProposal[] = [];
  const widgets: { toolName: string; widget: unknown }[] = [];

  const chatTools = registry.forSurface('chat');
  const tools = toChatTools(
    chatTools,
    {
      db,
      upstream,
      meter: { addModelTokens: () => {} },
      runId,
      surface: 'chat',
      // The rail the person is actually looking at. A read that can default its
      // weight vector from this cannot answer about the program default while
      // a what-if is on screen (SPEC §14.3).
      viewState: request.viewState,
    },
    {
      onProposal: (proposal) => proposals.push(proposal),
      onResult: (toolName, result) => {
        if (result.widget) widgets.push({ toolName, widget: result.widget });
      },
    },
  );

  return { chatTools, tools, proposals, widgets };
}

/**
 * ── The transcript is written before `done` is emitted ───────────────────
 *
 * Text deltas are *display*; these rows are the record. A client that
 * re-reads the Thread on `done` therefore cannot see a half-written turn.
 */
async function writeTranscript(
  db: Database,
  turn: {
    threadId: string;
    widgets: { toolName: string; widget: unknown }[];
    proposals: PendingProposal[];
    text: string;
    pageRef: string;
  },
): Promise<void> {
  const { threadId, widgets, proposals, text, pageRef } = turn;

  // Every tool call is its own row, which is what makes the transcript the
  // complete record and is why chat needs no Trace.
  for (const { toolName, widget } of widgets) {
    await db.insert(t.threadMessage).values({
      threadId,
      role: 'tool',
      text: toolName,
      widget: widget as never,
      pageRef,
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
      pageRef,
    });
  }

  await db.insert(t.threadMessage).values({
    threadId,
    role: 'assistant',
    text,
    pageRef,
  });
}
