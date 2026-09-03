import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { supplier } from './authored';
import { entity } from './entities';
import { discriminatorVerdict, matchCountrySource, matchSettledBy, matchStatus } from './enums';

/**
 * Matching (SPEC §3.3, §6).
 *
 *   match  →  match_attempt (append-only)  →  match_candidate
 *
 * Rounds live in the polymorphic `round` table in `narrative.ts`, because the
 * Match loop, the Assess loop and the Recommend loop all have Rounds and they
 * are the same thing.
 */

/**
 * One per Supplier — `match` is **total over Suppliers**, which is what lets a
 * promoted Lead be pre-settled (`settled_by='discovered'`, zero attempts)
 * rather than needing a fourth Match status (SPEC §11.3).
 *
 * **There is deliberately no unique constraint on `entityId`.** Two Suppliers
 * may resolve to one entity — a brand-name row and a legal-entity row colliding
 * is *correct* — and it surfaces as a Shortlist finding, not a write failure
 * (SPEC §3.3).
 */
export const match = pgTable(
  'match',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => supplier.id, { onDelete: 'cascade' })
      .unique(),
    status: matchStatus('status').notNull(),
    /** Null unless `status = 'accepted'`. This row, so pointed at, is the Profile. */
    entityId: text('entity_id').references(() => entity.id),
    settledBy: matchSettledBy('settled_by').notNull(),
    /** Sayari's own `matchStrength`. Null for a discovered Supplier reads as strong. */
    matchStrength: text('match_strength'),
    /**
     * **The country this Supplier is scored on**, ISO3, decided at settle time
     * (SPEC §9.4, finding 107).
     *
     * It lives on the Match rather than on the Profile because it is a fact
     * about *this settlement*, not about the entity: the same Sayari record can
     * be the right answer for a Japanese roster row and carry `countries[0] =
     * SWE`, and a second Supplier matching the same record from a different
     * address would be scored on a different site. Deriving it at read time
     * from the Discriminator verdicts — which is where it started — made every
     * reader re-run the derivation and made the answer move when the verdicts
     * were re-recorded.
     *
     * Null on a Match that has never been settled with evidence, which reads as
     * "fall back to the Profile's own country" rather than as "no country".
     */
    settledCountry: text('settled_country'),
    settledCountrySource: matchCountrySource('settled_country_source'),
    settledAt: timestamp('settled_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('match_entity_idx').on(t.entityId)],
);

/**
 * **Append-only.** A human override after an agent accept writes a *new*
 * attempt, so the Needs Review page shows both settlements rather than one
 * overwriting the other (SPEC §6.8).
 */
export const matchAttempt = pgTable(
  'match_attempt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    matchId: uuid('match_id')
      .notNull()
      .references(() => match.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id'),
    attemptN: integer('attempt_n').notNull(),
    /** The rung reached: R1 batch, R2 name+town, R3a address, R3b/R3c LEI. */
    rungsUsed: jsonb('rungs_used'),
    outcomeStatus: matchStatus('outcome_status').notNull(),
    outcomeEntityId: text('outcome_entity_id').references(() => entity.id),
    settledBy: matchSettledBy('settled_by').notNull(),
    /** For a chat-driven settlement: which message asked for it (SPEC §6.8). */
    threadMessageId: uuid('thread_message_id'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('match_attempt_match_n_key').on(t.matchId, t.attemptN),
    index('match_attempt_match_idx').on(t.matchId),
  ],
);

/**
 * A Sayari entity that resolution returned for a Supplier, carrying the verdict
 * of every Discriminator run against it (CONTEXT.md, *Candidate*).
 *
 * Candidates accumulate across a Match's Rounds; at most one becomes the
 * Profile. Both agents' per-Discriminator verdicts are stored, because the
 * blind evaluator naming a different company is the interesting artefact and it
 * has to be readable afterwards.
 *
 * `score` is Sayari's, and is **not comparable between queries** — which is why
 * the auto-accept gate has no ratio margin over the runner-up (SPEC §6.3).
 */
export const matchCandidate = pgTable(
  'match_candidate',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    matchAttemptId: uuid('match_attempt_id')
      .notNull()
      .references(() => matchAttempt.id, { onDelete: 'cascade' }),
    entityId: text('entity_id')
      .notNull()
      .references(() => entity.id),
    /** Which query rung surfaced this Candidate. */
    foundByRung: text('found_by_rung').notNull(),
    /** Why that query term was tried — model knowledge may choose a term but is
     * never evidence, so the provenance of the search is recorded (SPEC §6.6). */
    queryProvenance: text('query_provenance'),
    score: numeric('score', { precision: 12, scale: 6 }),
    matchStrength: text('match_strength'),
    explanation: jsonb('explanation'),
    /**
     * Sayari's own per-query `highlight` block — the matched text snippets the
     * resolution response marked up, keyed by field. Its own column rather than
     * folded into `explanation`, because `explanation` is Sayari's per-field
     * match-quality record (ticket 01 item A) and the two are different data.
     */
    highlight: jsonb('highlight'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('match_candidate_attempt_entity_key').on(t.matchAttemptId, t.entityId),
    index('match_candidate_attempt_idx').on(t.matchAttemptId),
  ],
);

/**
 * One row per (Candidate × Discriminator): the verdict and one line of
 * reasoning (SPEC §6.2).
 *
 * A separate table rather than eight columns, because the eight are a list the
 * UI iterates and the Needs Review page renders as a ladder — and because
 * adding a ninth check should not be a migration on a wide table.
 */
export const matchCandidateVerdict = pgTable(
  'match_candidate_verdict',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    matchCandidateId: uuid('match_candidate_id')
      .notNull()
      .references(() => matchCandidate.id, { onDelete: 'cascade' }),
    discriminator: text('discriminator').notNull(),
    verdict: discriminatorVerdict('verdict').notNull(),
    reasoning: text('reasoning').notNull(),
    /** `rules` when code ran the check, or the agent role that reported it. */
    reportedBy: text('reported_by').notNull(),
  },
  (t) => [
    uniqueIndex('match_candidate_verdict_key').on(
      t.matchCandidateId,
      t.discriminator,
      t.reportedBy,
    ),
  ],
);

export const matchRelations = relations(match, ({ one, many }) => ({
  supplier: one(supplier, { fields: [match.supplierId], references: [supplier.id] }),
  entity: one(entity, { fields: [match.entityId], references: [entity.id] }),
  attempts: many(matchAttempt),
}));

export const matchAttemptRelations = relations(matchAttempt, ({ one, many }) => ({
  match: one(match, { fields: [matchAttempt.matchId], references: [match.id] }),
  candidates: many(matchCandidate),
}));

export const matchCandidateRelations = relations(matchCandidate, ({ one, many }) => ({
  attempt: one(matchAttempt, {
    fields: [matchCandidate.matchAttemptId],
    references: [matchAttempt.id],
  }),
  entity: one(entity, { fields: [matchCandidate.entityId], references: [entity.id] }),
  verdicts: many(matchCandidateVerdict),
}));

export const matchCandidateVerdictRelations = relations(matchCandidateVerdict, ({ one }) => ({
  candidate: one(matchCandidate, {
    fields: [matchCandidateVerdict.matchCandidateId],
    references: [matchCandidate.id],
  }),
}));
