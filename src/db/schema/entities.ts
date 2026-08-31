import { relations } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { upstreamResponse } from './upstream';

/**
 * The entity layer (SPEC §3.2).
 *
 * **A Profile is not a table.** It is the role an `entity` row plays once a
 * Supplier's Match points at it. Entities no Supplier matched — owners, family
 * members, Deep Traversal nodes — are stored in exactly the same way and are
 * simply not Profiles (CONTEXT.md, *Profile*).
 */

/**
 * The Sayari entity id is the natural primary key. Using it directly is what
 * lets a Citation point at an entity without a join, and what makes "two
 * Suppliers resolved to one company" a finding rather than a write failure.
 *
 * The columns are a **projection** of the Sayari payload, not a copy: the whole
 * body is already in `upstream_response`, so this table holds only what the app
 * reads often enough to want indexed.
 */
export const entity = pgTable('entity', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  entityType: text('entity_type'),

  /**
   * From `attributes.address` — **never** the first entry of the multi-valued
   * `countries[]`, which returned eight values for one seeded company
   * (SPEC §11.3).
   */
  country: text('country'),
  addressLine: text('address_line'),
  city: text('city'),
  postcode: text('postcode'),

  /**
   * Sayari's own coordinates supersede external geocoding for a resolved
   * Profile (SPEC §7.1). Nominatim is for Plants and unresolved rows.
   */
  lat: doublePrecision('lat'),
  lon: doublePrecision('lon'),

  lei: text('lei'),

  /**
   * `sourceCount` is an **object keyed by source hash**, not a scalar — so the
   * data-confidence band must say whether it means *distinct sources* or a
   * *summed count*, and it says distinct (SPEC §9.2).
   */
  sourceCount: jsonb('source_count'),
  distinctSourceCount: integer('distinct_source_count'),

  sanctioned: boolean('sanctioned').notNull().default(false),
  pep: boolean('pep').notNull().default(false),
  closed: boolean('closed').notNull().default(false),

  /**
   * The whole `risk` object, keyed by factor name. Classification is by
   * family/substring rules in `score.ts` and never by a split on a trailing
   * token: factor names are compound, so `forced_labor_..._subtier_...` carries
   * its variant word in the middle (SPEC §9.3).
   *
   * When two Sayari endpoints disagree about an entity's risk we union them
   * with per-factor provenance, because the traversal payload and `getEntity`
   * returned 10 and 6 factors for the same company (SPEC §8.2).
   */
  risk: jsonb('risk'),

  /** `possibly_same_as` count. A Twin is evidence, never identity. */
  psaCount: integer('psa_count'),

  /**
   * `relationshipCount` is an **object keyed by relation type**, not a scalar.
   * That object is what distinguishes *this company has no recorded owner* from
   * *we did not look far enough*, at zero cost (SPEC §16.6).
   */
  relationshipCount: jsonb('relationship_count'),
  /** True when the returned relationship window was smaller than the count. */
  relationshipsTruncated: boolean('relationships_truncated').notNull().default(false),

  /**
   * **The payload this row was projected from** (SPEC §3.2).
   *
   * `enrichment` has carried this link since the beginning and `entity` did
   * not, so a Profile could show every figure it had computed and nothing a
   * reader could check them against. Nine hundred stored bodies were reachable
   * from nowhere in the UI.
   *
   * Two things it deliberately is not:
   *
   * - **Not `notNull`.** Most entities were never fetched on their own — they
   *   arrived nested inside somebody else's traversal or search result, and for
   *   those there is no payload that is theirs. Null says exactly that, and the
   *   page says it in words rather than showing an empty box.
   * - **Not the citation target.** A Citation points at evidence a sentence
   *   used; this points at provenance a reader may audit. Keeping them separate
   *   is why `on delete set null` is right here — losing a cached body must
   *   blank a provenance link, never cascade away the company.
   */
  upstreamResponseId: uuid('upstream_response_id').references(() => upstreamResponse.id, {
    onDelete: 'set null',
  }),

  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('entity_country_idx').on(t.country), index('entity_lei_idx').on(t.lei)]);

/**
 * A Sayari record — the target of a Citation's record hop (SPEC §3.2).
 *
 * Load-bearing for the Dossier profile in particular: a Citation must resolve
 * to a **live local row**, and a record id seen inside `entity.attributes[]`
 * has no local row unless something fetched it (SPEC §15.3).
 */
export const record = pgTable('record', {
  id: text('id').primaryKey(),
  source: text('source'),
  sourceLabel: text('source_label'),
  collectedAt: timestamp('collected_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  fields: jsonb('fields'),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * An edge in the entity graph, including `possibly_same_as` (SPEC §3.2).
 *
 * Three columns carry rules rather than data:
 *
 * - `hopDepth` takes the **minimum** on upsert. An edge first seen at depth 3
 *   by a Deep Traversal and later at depth 1 by an ownership read is a 1-hop
 *   edge, and Ownership exposure scores 1-hop edges.
 * - `discoveredByJob` is how a Deep Traversal's finds are distinguished from
 *   the automatic family read, while writing into the same tables.
 * - `firstSeenAt` **the upsert must not touch**. It is what the *new evidence*
 *   staleness chip is computed from: a row first seen after a version was
 *   written (SPEC §12.3). Re-stamping it on every refresh would silence the
 *   signal permanently.
 */
export const entityRelationship = pgTable('entity_relationship', {
  id: uuid('id').primaryKey().defaultRandom(),
  fromEntityId: text('from_entity_id')
    .notNull()
    .references(() => entity.id, { onDelete: 'cascade' }),
  toEntityId: text('to_entity_id')
    .notNull()
    .references(() => entity.id, { onDelete: 'cascade' }),
  relationshipType: text('relationship_type').notNull(),
  /** A former owner is not a current one, and only current edges are scored. */
  former: boolean('former').notNull().default(false),
  startDate: text('start_date'),
  endDate: text('end_date'),
  sourceRecordId: text('source_record_id'),
  hopDepth: integer('hop_depth').notNull().default(1),
  discoveredByJob: uuid('discovered_by_job'),
  attributes: jsonb('attributes'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('entity_relationship_edge_key').on(
    t.fromEntityId,
    t.toEntityId,
    t.relationshipType,
    t.sourceRecordId,
  ),
  index('entity_relationship_from_idx').on(t.fromEntityId),
  index('entity_relationship_to_idx').on(t.toEntityId),
]);

export const entityRelations = relations(entity, ({ many }) => ({
  outgoing: many(entityRelationship, { relationName: 'from' }),
  incoming: many(entityRelationship, { relationName: 'to' }),
}));

export const entityRelationshipRelations = relations(entityRelationship, ({ one }) => ({
  from: one(entity, {
    fields: [entityRelationship.fromEntityId],
    references: [entity.id],
    relationName: 'from',
  }),
  to: one(entity, {
    fields: [entityRelationship.toEntityId],
    references: [entity.id],
    relationName: 'to',
  }),
}));
