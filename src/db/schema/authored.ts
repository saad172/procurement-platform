import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { geocodePrecision, supplierOrigin } from './enums';

/**
 * Authored rows — written only by `src/db/seed.ts` (SPEC §3.1).
 *
 * One schema, with a documented authored/derived convention, rather than
 * separate `seed` and `app` schemas: derived rows FK into authored ones
 * constantly, and a cross-schema foreign key buys nothing but ceremony.
 *
 * The convention is the whole point of the split, so it is stated once here:
 * **nothing outside the seed writes to any table in this file.**
 */

const now = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// ── Sourcing Program ─────────────────────────────────────────────────────────

/** The buying effort a Shortlist serves (CONTEXT.md, *Sourcing Program*). */
export const program = pgTable('program', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /**
   * One importer for the whole Program. With a Mexican Plant in the seed this
   * is an explicit *proxy* rather than a fact: the tariff Criterion answers
   * "what would this content cost to bring into the US side", not "what duty
   * will be paid" (SPEC §20). A per-Plant importer is deferred, not forgotten.
   */
  importingCountry: text('importing_country').notNull(),
  vehicleClass: text('vehicle_class').notNull(),
  sourcingHorizon: text('sourcing_horizon').notNull(),
  createdAt: now(),
});

/**
 * A location of the buyer's that goods are delivered to; the reference point
 * for proximity.
 *
 * Coordinates are **authored, never geocoded** (SPEC §3.1). Every seeded Plant
 * is at `city` precision — good to roughly ±5 km — and the column exists so the
 * UI can say so rather than imply a surveyed point.
 */
export const plant = pgTable(
  'plant',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id')
      .notNull()
      .references(() => program.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    role: text('role').notNull(),
    city: text('city').notNull(),
    country: text('country').notNull(),
    lat: doublePrecision('lat').notNull(),
    lon: doublePrecision('lon').notNull(),
    precision: geocodePrecision('precision').notNull(),
    createdAt: now(),
  },
  (t) => [uniqueIndex('plant_program_code_key').on(t.programId, t.code)],
);

// ── Categories and their HS lines ────────────────────────────────────────────

/**
 * One kind of thing a Program buys, carrying the HS codes used for tariffs.
 *
 * Every other column in this file is authored-only (see the file's own header
 * comment). The three `discover_*` columns below are the one exception:
 * they are written by the Discover job (`src/jobs/discover.ts`), overwritten
 * whole on every run of that job for this Category, never by the seed.
 */
export const category = pgTable(
  'category',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id')
      .notNull()
      .references(() => program.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    note: text('note'),
    /**
     * The trade search envelope's own `size.count` off the most recent Discover
     * run for this Category — how many counterparties the query matched in
     * total, so the UI can say "n of m" rather than just "n proposed" (ticket
     * 01 item C; A3). Null when no Discover run has completed yet, or the last
     * one's search returned no count.
     *
     * **Not on the Lead row.** A trade total is a fact about one Discover
     * RUN, not about any one Lead it proposed: `lead` rows are written
     * `onConflictDoNothing` (`recordLead`), so a second run's rows disagree
     * with the first run's about a number that was never theirs to carry, and
     * nothing ever read it off the Lead. It lives here instead, overwritten
     * whole each run, which is what a per-run fact overwritten per run should
     * do (A3+C3).
     */
    discoverTotalCount: integer('discover_total_count'),
    /**
     * `size.qualifier` off the same envelope — `eq` (the count is exact) or
     * `gte` (the count is a floor: the query matched at least this many).
     * Read beside `discover_total_count` so a `gte` renders "at least n"
     * rather than an exact total it never was (C3).
     */
    discoverTotalQualifier: text('discover_total_qualifier'),
    /** When the Discover run that produced the two columns above finished. */
    discoveredAt: timestamp('discovered_at', { withTimezone: true }),
    createdAt: now(),
  },
  (t) => [uniqueIndex('category_program_code_key').on(t.programId, t.code)],
);

/**
 * Several per Category (SPEC §3.1).
 *
 * A Category needs more than one line because the honest classification is
 * often ambiguous — a battery enclosure is plausibly an aluminium casting, an
 * "other steel article", or a recognisable vehicle part, and the three land in
 * a 0.4-point band. `is_default` names the line the Score uses; the others are
 * what the mandatory caveat sentence enumerates.
 *
 * `rate` is the verified MFN rate as a percentage, stored `numeric` so 3.4 is
 * 3.4 and not 3.4000000000000004.
 */
export const categoryHsLine = pgTable(
  'category_hs_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id, { onDelete: 'cascade' }),
    hsCode: text('hs_code').notNull(),
    label: text('label').notNull(),
    rate: numeric('rate', { precision: 6, scale: 3 }).notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    note: text('note'),
    createdAt: now(),
  },
  (t) => [
    uniqueIndex('category_hs_line_category_code_key').on(t.categoryId, t.hsCode),
    index('category_hs_line_category_idx').on(t.categoryId),
  ],
);

// ── Suppliers ────────────────────────────────────────────────────────────────

/**
 * A company the sourcing team is considering — usually one row of an imported
 * list, otherwise a Lead promoted from Discover.
 *
 * Program-scoped, and the roster columns are **nullable**: a promoted Lead was
 * never imported, so it has no roster name, address or country to carry
 * (SPEC §3.1, §11.3). `origin` is what tells the two apart.
 */
export const supplier = pgTable(
  'supplier',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    programId: uuid('program_id')
      .notNull()
      .references(() => program.id, { onDelete: 'cascade' }),
    origin: supplierOrigin('origin').notNull(),
    /** Position in the imported list. Null for a promoted Lead. */
    rosterIndex: integer('roster_index'),
    rosterName: text('roster_name'),
    rosterAddress: text('roster_address'),
    /**
     * ISO3 as the roster gives it. The *scored* country is the settled site's
     * (SPEC §9.4, finding 107): this one, normalised, when the settled
     * candidate's `country` Discriminator passed — the Profile's own otherwise.
     */
    rosterCountry: text('roster_country'),
    createdAt: now(),
  },
  (t) => [
    index('supplier_program_idx').on(t.programId),
    uniqueIndex('supplier_program_roster_index_key').on(t.programId, t.rosterIndex),
    // An imported Supplier came off a list and must carry its row; a discovered
    // one never did. Making that a CHECK stops a half-populated row existing.
    check(
      'supplier_origin_roster_consistency',
      sql`(${t.origin} = 'imported' AND ${t.rosterName} IS NOT NULL AND ${t.rosterIndex} IS NOT NULL)
        OR (${t.origin} = 'discovered' AND ${t.rosterName} IS NULL AND ${t.rosterIndex} IS NULL)`,
    ),
  ],
);

/**
 * Which Categories a Supplier bids on. Many-to-many, hand-authored, and
 * deliberately carrying **no provenance column** (SPEC §3.1).
 *
 * The mapping is a plausibility judgement from general industry knowledge, not
 * derived from any source. A `source` column would imply otherwise, and the
 * seed forbids implying a source it does not have. No app behaviour may depend
 * on the mapping being right.
 */
export const supplierCategory = pgTable(
  'supplier_category',
  {
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => supplier.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.supplierId, t.categoryId] }),
    index('supplier_category_category_idx').on(t.categoryId),
  ],
);

// ── Criteria and weights ─────────────────────────────────────────────────────

/**
 * The seven Criteria, of which six carry weight. Data confidence is the
 * seventh: a badge that gates what may be called *clean* and moves no rank
 * (SPEC §9.2).
 *
 * `direction` is documented rather than used — every Criterion is 0–100 where
 * higher is better for this Program, by the scale contract in §9.1. The column
 * exists so the contract is visible in the data, not only in `score.ts`.
 */
export const criterion = pgTable('criterion', {
  key: text('key').primaryKey(),
  label: text('label').notNull(),
  blurb: text('blurb').notNull(),
  direction: text('direction').notNull().default('higher_is_better'),
  /** False for `data_confidence`, the one Criterion that carries no weight. */
  isWeighted: boolean('is_weighted').notNull().default(true),
  sortOrder: integer('sort_order').notNull(),
});

/**
 * The stored default weight vector the rail saves into (SPEC §3.1, §13.4).
 *
 * A what-if lives in the URL and never touches this table; "Save as Program
 * default" is the one act separating a what-if from the record. The **presets**
 * are code constants rather than rows, because the seed's presets had already
 * gone stale — summing to 101 and 112 — when a Criterion was dropped, and a row
 * would have survived that silently.
 */
export const programCriterionWeight = pgTable(
  'program_criterion_weight',
  {
    programId: uuid('program_id')
      .notNull()
      .references(() => program.id, { onDelete: 'cascade' }),
    criterionKey: text('criterion_key')
      .notNull()
      .references(() => criterion.key),
    weight: numeric('weight', { precision: 6, scale: 3 }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.programId, t.criterionKey] })],
);

// ── Trade-action flags ───────────────────────────────────────────────────────

/**
 * The six trade-action flags, **authored and never computed** (SPEC §7.2).
 *
 * They key on facts the app does not have — melt-and-pour origin, regional
 * value content, declared end-use — so computing one would be inventing it.
 * They ride beside the MFN rate as badges and are never folded into it.
 */
export const tariffFlag = pgTable('tariff_flag', {
  key: text('key').primaryKey(),
  label: text('label').notNull(),
  /** Why this is a flag rather than a rate. Rendered in the UI verbatim. */
  whyNotARate: text('why_not_a_rate').notNull(),
  sortOrder: integer('sort_order').notNull(),
});

/** A flag that bites a Category (material- or heading-keyed). */
export const categoryFlag = pgTable(
  'category_flag',
  {
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id, { onDelete: 'cascade' }),
    flagKey: text('flag_key')
      .notNull()
      .references(() => tariffFlag.key),
    note: text('note'),
  },
  (t) => [primaryKey({ columns: [t.categoryId, t.flagKey] })],
);

/** A flag that bites an origin country. */
export const countryFlag = pgTable(
  'country_flag',
  {
    country: text('country').notNull(),
    flagKey: text('flag_key')
      .notNull()
      .references(() => tariffFlag.key),
    note: text('note'),
  },
  (t) => [primaryKey({ columns: [t.country, t.flagKey] })],
);

// ── Relations ────────────────────────────────────────────────────────────────

export const programRelations = relations(program, ({ many }) => ({
  plants: many(plant),
  categories: many(category),
  suppliers: many(supplier),
  weights: many(programCriterionWeight),
}));

/**
 * Drizzle needs BOTH sides of a relation declared: a `many()` without its
 * matching `one()` fails at query time with "not enough information to infer
 * relation", not at build time. So every `many()` above has its inverse here.
 */
export const plantRelations = relations(plant, ({ one }) => ({
  program: one(program, { fields: [plant.programId], references: [program.id] }),
}));

export const programCriterionWeightRelations = relations(programCriterionWeight, ({ one }) => ({
  program: one(program, { fields: [programCriterionWeight.programId], references: [program.id] }),
  criterion: one(criterion, {
    fields: [programCriterionWeight.criterionKey],
    references: [criterion.key],
  }),
}));

export const categoryFlagRelations = relations(categoryFlag, ({ one }) => ({
  category: one(category, { fields: [categoryFlag.categoryId], references: [category.id] }),
  flag: one(tariffFlag, { fields: [categoryFlag.flagKey], references: [tariffFlag.key] }),
}));

export const countryFlagRelations = relations(countryFlag, ({ one }) => ({
  flag: one(tariffFlag, { fields: [countryFlag.flagKey], references: [tariffFlag.key] }),
}));

export const categoryRelations = relations(category, ({ one, many }) => ({
  program: one(program, { fields: [category.programId], references: [program.id] }),
  hsLines: many(categoryHsLine),
  suppliers: many(supplierCategory),
  flags: many(categoryFlag),
}));

export const supplierRelations = relations(supplier, ({ one, many }) => ({
  program: one(program, { fields: [supplier.programId], references: [program.id] }),
  categories: many(supplierCategory),
}));

export const supplierCategoryRelations = relations(supplierCategory, ({ one }) => ({
  supplier: one(supplier, { fields: [supplierCategory.supplierId], references: [supplier.id] }),
  category: one(category, { fields: [supplierCategory.categoryId], references: [category.id] }),
}));

export const categoryHsLineRelations = relations(categoryHsLine, ({ one }) => ({
  category: one(category, { fields: [categoryHsLine.categoryId], references: [category.id] }),
}));
