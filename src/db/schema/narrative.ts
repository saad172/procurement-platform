import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { category, program, supplier } from './authored';
import { entity, record } from './entities';
import {
  assessmentKind,
  assessmentVerdict,
  evaluatorOutcome,
  leadClassification,
  pickRole,
  recommendationMark,
  roundRole,
  roundSource,
  sentenceSection,
} from './enums';
import { enrichment } from './enrichment';
import { match } from './matching';
import { criterionValue } from './scoring';

/**
 * The narrative layer (SPEC §3.6, §10).
 *
 *   assessment / recommendation  →  *_version  →  sentence  →  citation
 *
 * The whole point of this shape is one constraint: **a sentence without a
 * resolvable Citation cannot be inserted.** The guard is at insert time, not in
 * a later scan, so there is no window in which the record contains an unproven
 * claim.
 */

// ── Headers ──────────────────────────────────────────────────────────────────

/**
 * One per Supplier × Program — **never per Category** (SPEC §10.1), though it
 * carries a Score for each Category that Supplier bids on.
 *
 * A Dossier is an `assessment` with `kind='dossier'`, not a table of its own.
 * The honest cost of that, stated rather than discovered: `verdict` goes
 * nullable, and the required-section list becomes per-kind in code.
 */
export const assessment = pgTable(
  'assessment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => supplier.id, { onDelete: 'cascade' }),
    programId: uuid('program_id')
      .notNull()
      .references(() => program.id, { onDelete: 'cascade' }),
    kind: assessmentKind('kind').notNull().default('standard'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('assessment_supplier_idx').on(t.supplierId, t.kind)],
);

/** One per Program × Category — eight per full run (SPEC §10.1). */
export const recommendation = pgTable(
  'recommendation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id')
      .notNull()
      .references(() => program.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('recommendation_program_category_key').on(t.programId, t.categoryId)],
);

// ── Versions ─────────────────────────────────────────────────────────────────

/**
 * `frozen_inputs` is what makes the *inputs moved* banner computable: the
 * weight vector, the Criterion values, the Scores, the Shortlist order, **and
 * each Shortlist Supplier's verdict and evaluator outcome** (SPEC §10.6).
 *
 * The verdicts are in there because a Supplier re-assessed into
 * `do_not_shortlist` was otherwise invisible to both staleness signals — its
 * verdict moved no number, and a Recommendation may not cite an Assessment.
 */
const versionColumns = {
  n: integer('n').notNull(),
  frozenInputs: jsonb('frozen_inputs').notNull(),
  evaluatorOutcome: evaluatorOutcome('evaluator_outcome').notNull(),
  jobId: uuid('job_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
};

/**
 * **A version contains its Rounds; it is not created by one** (SPEC §10.6).
 *
 * Intermediate drafts live in `round.text`; `sentence` rows are written once,
 * when the loop ends, so the insert-time citation guarantee covers exactly what
 * is displayed. A re-run always versions, even when the text is identical,
 * because *"the weights changed and the argument didn't"* is the most
 * interesting thing the diff can say.
 */
export const assessmentVersion = pgTable(
  'assessment_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assessmentId: uuid('assessment_id')
      .notNull()
      .references(() => assessment.id, { onDelete: 'cascade' }),
    /** Nullable because a Dossier has no verdict — the cost of sharing the table. */
    verdict: assessmentVerdict('verdict'),
    ...versionColumns,
  },
  (t) => [uniqueIndex('assessment_version_n_key').on(t.assessmentId, t.n)],
);

export const recommendationVersion = pgTable(
  'recommendation_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recommendationId: uuid('recommendation_id')
      .notNull()
      .references(() => recommendation.id, { onDelete: 'cascade' }),
    /**
     * The human's mark. **A re-run never clears an accepted mark** — the page
     * shows the most recent accepted version if one exists, otherwise the latest,
     * with a strip naming any newer one (SPEC §12.5).
     */
    humanMark: recommendationMark('human_mark'),
    /**
     * When a person marked it. Null exactly when `human_mark` is null, because
     * the two are one act recorded in two columns — a mark with no moment is a
     * mark nobody can date, and the header says when as well as what.
     *
     * A Job never writes either: `publishVersion` writes `human_mark: null` on
     * every version it creates, so an agent cannot accept its own argument.
     */
    humanMarkedAt: timestamp('human_marked_at', { withTimezone: true }),
    ...versionColumns,
  },
  (t) => [
    uniqueIndex('recommendation_version_n_key').on(t.recommendationId, t.n),
    /**
     * **At most one accepted version per Recommendation**, as a partial unique
     * index rather than as a rule in the action that writes marks.
     *
     * *Acceptance never moves* (SPEC §12.5) is the load-bearing sentence on
     * this table: the page shows the most recent accepted version, so two
     * accepted siblings would make "the accepted one" ambiguous and the page's
     * answer depend on row order. The writer clears the sibling in the same
     * transaction; this index is what makes the state unrepresentable if it
     * ever forgets, the same way the citation CHECK guards the sentence
     * insert rather than trusting the validator that runs before it.
     */
    uniqueIndex('recommendation_version_one_accepted_key')
      .on(t.recommendationId)
      .where(sql`${t.humanMark} = 'accepted'`),
  ],
);

/**
 * One Supplier named in a Recommendation, with the role it is named for.
 *
 * Typed rows rather than prose, because a Pick is a decision and an enum is not
 * a claim. Pick legality is checked in `submit_recommendation` before insert:
 * accepted Match, linked to this Category, has a Score, ≤ 3 picks, ≤ 1 `award`
 * (SPEC §10.4).
 */
export const recommendationPick = pgTable(
  'recommendation_pick',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recommendationVersionId: uuid('recommendation_version_id')
      .notNull()
      .references(() => recommendationVersion.id, { onDelete: 'cascade' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => supplier.id),
    role: pickRole('role').notNull(),
    rank: integer('rank').notNull(),
  },
  (t) => [
    uniqueIndex('recommendation_pick_version_supplier_key').on(
      t.recommendationVersionId,
      t.supplierId,
    ),
  ],
);

// ── Sentences and Citations ──────────────────────────────────────────────────

/**
 * One factual sentence of a published version.
 *
 * The owner is nullable on both sides under a one-of CHECK, so a sentence
 * belongs to exactly one document. `pickId` is meaningful only in the
 * `conditions` section — a condition attaches to the Pick it conditions.
 */
export const sentence = pgTable(
  'sentence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assessmentVersionId: uuid('assessment_version_id').references(() => assessmentVersion.id, {
      onDelete: 'cascade',
    }),
    recommendationVersionId: uuid('recommendation_version_id').references(
      () => recommendationVersion.id,
      { onDelete: 'cascade' },
    ),
    section: sentenceSection('section').notNull(),
    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
    pickId: uuid('pick_id').references(() => recommendationPick.id, { onDelete: 'cascade' }),
  },
  (t) => [
    check(
      'sentence_one_owner',
      sql`(${t.assessmentVersionId} IS NOT NULL)::int + (${t.recommendationVersionId} IS NOT NULL)::int = 1`,
    ),
    check(
      'sentence_pick_only_in_conditions',
      sql`${t.pickId} IS NULL OR ${t.section} = 'conditions'`,
    ),
    index('sentence_assessment_idx').on(t.assessmentVersionId, t.section, t.ordinal),
    index('sentence_recommendation_idx').on(t.recommendationVersionId, t.section, t.ordinal),
  ],
);

/**
 * A pointer from a sentence to a **stored thing** (SPEC §3.6, §10.2).
 *
 * The one-of CHECK is over target **groups**, not columns, because the
 * shortlist reference is two columns — a `(program_id, category_id)` pair.
 * Every group is a foreign key, so a Citation to a row that does not exist
 * cannot be inserted. That is the whole mechanism: not a validator that runs
 * afterwards, a constraint that refuses the write.
 *
 * Never to another sentence, and never to an Assessment or a Recommendation: a
 * Citation points at evidence, not at prose. Allowing prose would let an
 * unproven claim be inherited by reference and would make the citation graph
 * two-level, with this CHECK guarding only the bottom of it.
 */
export const citation = pgTable(
  'citation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sentenceId: uuid('sentence_id')
      .notNull()
      .references(() => sentence.id, { onDelete: 'cascade' }),

    // ── Global evidence: NO ACTION on delete, deliberately ──
    // These rows are append-only and the app never deletes them. Leaving the
    // foreign key un-cascaded turns it into a second guard: you may not delete
    // evidence that a published sentence cites. If that ever blocks a delete, the
    // delete is the bug.
    entityId: text('entity_id').references(() => entity.id),
    recordId: text('record_id').references(() => record.id),
    enrichmentId: uuid('enrichment_id').references(() => enrichment.id),

    // ── Program-scoped targets: CASCADE ──
    // A Criterion value, a Match and a Shortlist all belong to one Program.
    // Tearing down a Program tears down the whole argument made about it, so a
    // Citation into one of them goes with it rather than blocking the teardown.
    criterionValueId: uuid('criterion_value_id').references(() => criterionValue.id, {
      onDelete: 'cascade',
    }),
    matchId: uuid('match_id').references(() => match.id, { onDelete: 'cascade' }),

    /** The shortlist reference: one group, two columns. */
    shortlistProgramId: uuid('shortlist_program_id').references(() => program.id, {
      onDelete: 'cascade',
    }),
    shortlistCategoryId: uuid('shortlist_category_id').references(() => category.id, {
      onDelete: 'cascade',
    }),
  },
  (t) => [
    check(
      'citation_exactly_one_target_group',
      sql`(${t.entityId} IS NOT NULL)::int
      + (${t.recordId} IS NOT NULL)::int
      + (${t.enrichmentId} IS NOT NULL)::int
      + (${t.criterionValueId} IS NOT NULL)::int
      + (${t.matchId} IS NOT NULL)::int
      + ((${t.shortlistProgramId} IS NOT NULL AND ${t.shortlistCategoryId} IS NOT NULL))::int = 1`,
    ),
    check(
      'citation_shortlist_pair_is_whole',
      sql`(${t.shortlistProgramId} IS NULL) = (${t.shortlistCategoryId} IS NULL)`,
    ),
    index('citation_sentence_idx').on(t.sentenceId),
  ],
);

// ── Rounds ───────────────────────────────────────────────────────────────────

/**
 * One proposer → evaluator exchange, polymorphic over its three owners
 * (SPEC §3.6).
 *
 * One table rather than three, because a Round is the same thing in all three
 * loops and the objections it keeps are read the same way. `source='code'` is
 * how a validator failure is recorded as the Round it costs; `role='human'`
 * carries a person's note, and — with a timestamp and a `frozen_inputs` hash —
 * a staleness **dismissal watermark** (SPEC §12.4).
 */
export const round = pgTable(
  'round',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    matchAttemptId: uuid('match_attempt_id'),
    assessmentVersionId: uuid('assessment_version_id').references(() => assessmentVersion.id, {
      onDelete: 'cascade',
    }),
    recommendationVersionId: uuid('recommendation_version_id').references(
      () => recommendationVersion.id,
      { onDelete: 'cascade' },
    ),
    n: integer('n').notNull(),
    role: roundRole('role').notNull(),
    source: roundSource('source').notNull(),
    text: text('text'),
    /** The objection this Round raised, if it raised one. Survivors become Dissent. */
    objection: text('objection'),
    /** The reply the objection drew. Nobody writes dissent; this is what is left. */
    reply: text('reply'),
    /** The six rubric verdicts, when an evaluator produced them. */
    rubric: jsonb('rubric'),
    /** For a dismissal watermark: what it dismissed to and against. */
    dismissedTo: timestamp('dismissed_to', { withTimezone: true }),
    dismissedInputsHash: text('dismissed_inputs_hash'),
    jobRoundId: uuid('job_round_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'round_one_owner',
      sql`(${t.matchAttemptId} IS NOT NULL)::int
      + (${t.assessmentVersionId} IS NOT NULL)::int
      + (${t.recommendationVersionId} IS NOT NULL)::int = 1`,
    ),
    index('round_match_attempt_idx').on(t.matchAttemptId, t.n),
    index('round_assessment_idx').on(t.assessmentVersionId, t.n),
    index('round_recommendation_idx').on(t.recommendationVersionId, t.n),
  ],
);

// ── Leads ────────────────────────────────────────────────────────────────────

/**
 * A company Discover proposes that is on no imported list (SPEC §11).
 *
 * **Not a Citation target.** The classifier returns a closed enum, an enum is
 * not a claim, so Discover adds a table and no new Citation target group — the
 * reasoning stays inspectable in the Trace instead.
 */
export const lead = pgTable(
  'lead',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id')
      .notNull()
      .references(() => program.id, { onDelete: 'cascade' }),
    /** The Category whose HS lines seeded the search. */
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id, { onDelete: 'cascade' }),
    entityId: text('entity_id')
      .notNull()
      .references(() => entity.id),

    classification: leadClassification('classification'),
    classificationReasoning: text('classification_reasoning'),

    // Evidence, as plain columns rather than prose.
    shipmentCount: integer('shipment_count'),
    /** Absent on 13 of 25 sampled rows, so it is a displayed column, never a filter. */
    latestShipmentDate: text('latest_shipment_date'),
    topHsCodes: jsonb('top_hs_codes'),
    arrivalCountries: jsonb('arrival_countries'),

    /**
     * Dedupe is exact entity-id plus an **unverified name-token overlap flag** —
     * labelled, never hidden. Since the Corporate family is free, a Lead that is
     * already a `family_member` of an accepted Supplier renders *related by
     * ownership, verified* instead (SPEC §11.2).
     */
    relatedSupplierId: uuid('related_supplier_id').references(() => supplier.id),
    relationVerified: boolean('relation_verified').notNull().default(false),

    /** Per (Program, Category), reversible, and it must persist or the same nine
     * forwarders return every run. */
    dismissed: boolean('dismissed').notNull().default(false),
    promotedSupplierId: uuid('promoted_supplier_id').references(() => supplier.id),

    jobId: uuid('job_id'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('lead_program_category_entity_key').on(t.programId, t.categoryId, t.entityId),
    index('lead_category_idx').on(t.categoryId, t.dismissed),
  ],
);

// ── Relations ────────────────────────────────────────────────────────────────

export const assessmentRelations = relations(assessment, ({ one, many }) => ({
  supplier: one(supplier, { fields: [assessment.supplierId], references: [supplier.id] }),
  versions: many(assessmentVersion),
}));

export const assessmentVersionRelations = relations(assessmentVersion, ({ one, many }) => ({
  assessment: one(assessment, {
    fields: [assessmentVersion.assessmentId],
    references: [assessment.id],
  }),
  sentences: many(sentence),
  rounds: many(round),
}));

export const recommendationRelations = relations(recommendation, ({ one, many }) => ({
  program: one(program, { fields: [recommendation.programId], references: [program.id] }),
  category: one(category, { fields: [recommendation.categoryId], references: [category.id] }),
  versions: many(recommendationVersion),
}));

export const recommendationVersionRelations = relations(recommendationVersion, ({ one, many }) => ({
  recommendation: one(recommendation, {
    fields: [recommendationVersion.recommendationId],
    references: [recommendation.id],
  }),
  picks: many(recommendationPick),
  sentences: many(sentence),
  rounds: many(round),
}));

export const sentenceRelations = relations(sentence, ({ one, many }) => ({
  assessmentVersion: one(assessmentVersion, {
    fields: [sentence.assessmentVersionId],
    references: [assessmentVersion.id],
  }),
  recommendationVersion: one(recommendationVersion, {
    fields: [sentence.recommendationVersionId],
    references: [recommendationVersion.id],
  }),
  citations: many(citation),
}));

export const citationRelations = relations(citation, ({ one }) => ({
  sentence: one(sentence, { fields: [citation.sentenceId], references: [sentence.id] }),
  entity: one(entity, { fields: [citation.entityId], references: [entity.id] }),
  record: one(record, { fields: [citation.recordId], references: [record.id] }),
  enrichment: one(enrichment, { fields: [citation.enrichmentId], references: [enrichment.id] }),
  criterionValue: one(criterionValue, {
    fields: [citation.criterionValueId],
    references: [criterionValue.id],
  }),
  match: one(match, { fields: [citation.matchId], references: [match.id] }),
}));

export const roundRelations = relations(round, ({ one }) => ({
  assessmentVersion: one(assessmentVersion, {
    fields: [round.assessmentVersionId],
    references: [assessmentVersion.id],
  }),
  recommendationVersion: one(recommendationVersion, {
    fields: [round.recommendationVersionId],
    references: [recommendationVersion.id],
  }),
}));

export const recommendationPickRelations = relations(recommendationPick, ({ one }) => ({
  version: one(recommendationVersion, {
    fields: [recommendationPick.recommendationVersionId],
    references: [recommendationVersion.id],
  }),
  supplier: one(supplier, { fields: [recommendationPick.supplierId], references: [supplier.id] }),
}));

export const leadRelations = relations(lead, ({ one }) => ({
  program: one(program, { fields: [lead.programId], references: [program.id] }),
  category: one(category, { fields: [lead.categoryId], references: [category.id] }),
  entity: one(entity, { fields: [lead.entityId], references: [entity.id] }),
}));
