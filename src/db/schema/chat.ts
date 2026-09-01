import { relations } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { program } from './authored';
import { confirmState, threadMessageRole } from './enums';

/**
 * Chat (SPEC §3.7, §14).
 *
 * **Chat is the only surface in this app where an agent may write an uncited
 * sentence — so everything it shows is frozen from a tool, and everything it
 * does is proposed rather than done.**
 *
 * The Citation rule is deliberately not extended here: a validator on a
 * streaming turn either blocks the stream or rejects after the person has
 * already read the sentence. The exemption is stated in the dock instead, and
 * chat prose is barred from being a Citation target or quoted into the record.
 */

/** Many per Program, created by an explicit *new chat*, auto-titled, never deleted. */
export const thread = pgTable(
  'thread',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id')
      .notNull()
      .references(() => program.id, { onDelete: 'cascade' }),
    /** Derived from the first message and the page it was opened from. */
    title: text('title'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('thread_program_idx').on(t.programId, t.createdAt)],
);

/**
 * `role` widens to `user | assistant | tool`, which makes **the transcript the
 * complete record** — and is why chat has no Trace (SPEC §14.2).
 *
 * The three frozen columns are the structural mitigation for the citation
 * exemption:
 *
 * - `widget` — every chat-reachable read returns `{ data, widget }` with no
 *   opt-out, and the widget freezes here. A read that renders nothing is a
 *   number entering prose uncited. Widgets are not tools: `render_table` as a
 *   tool would let the model draw a table of numbers it typed itself.
 * - `confirm` — the estimate as `confirm(input)` produced it, so what the
 *   person consented to is what is stored. No editing at the gate.
 * - `pageRef` — the page *and its view state*, so chat can see the weight
 *   vector the person is actually looking at.
 */
export const threadMessage = pgTable(
  'thread_message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => thread.id, { onDelete: 'cascade' }),
    role: threadMessageRole('role').notNull(),
    text: text('text'),
    /** `display: 'summarized'` — a summary, never the chain of thought. */
    thinkingSummary: text('thinking_summary'),
    pageRef: text('page_ref'),
    widget: jsonb('widget'),
    confirm: jsonb('confirm'),
    confirmState: confirmState('confirm_state'),
    /** Set once a confirm is accepted and the Job it proposed is enqueued. */
    jobId: uuid('job_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('thread_message_thread_idx').on(t.threadId, t.createdAt)],
);

export const threadRelations = relations(thread, ({ one, many }) => ({
  program: one(program, { fields: [thread.programId], references: [program.id] }),
  messages: many(threadMessage),
}));

export const threadMessageRelations = relations(threadMessage, ({ one }) => ({
  thread: one(thread, { fields: [threadMessage.threadId], references: [thread.id] }),
}));
