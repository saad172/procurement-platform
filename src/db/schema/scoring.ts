import { relations } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { category, criterion, program, supplier } from './authored';

/**
 * Scoring (SPEC §3.5, §9).
 *
 * **There is no `score` table and no `shortlist` table.** Both are computed by
 * one pure `score.ts` called by server and browser alike, so a weight drag
 * re-ranks in the browser with no round trip and no Job re-run. Storing a Score
 * would also mean storing something a saved Citation could point at while the
 * weights behind it moved.
 */

/**
 * One Criterion's value for one Supplier, in one Program, optionally for one
 * Category.
 *
 * **Append-only**, with `supersedes` and `isCurrent` (SPEC §3.5). Append-only
 * because a published Assessment cites a `criterion_value` row: if a re-enrich
 * could overwrite the row in place, a cited number would change underneath a
 * sentence that argued from it.
 *
 * `categoryId` is **nullable**, and the nullability carries the design:
 * - Tariff exposure differs per Category, so it is stored per Category.
 * - The other five do not, so they are stored once at `category = null`.
 * - An uncategorised Supplier therefore carries five values and **no Score**,
 *   which is a state, not an error (SPEC §9.4).
 *
 * `value` is null when the Criterion is **`unknown`** — it drops out and the
 * remaining weights renormalise. A neutral 50 was rejected as a fabricated fact
 * a Citation could point at, which is the worst failure this app has (§9.1).
 */
export const criterionValue = pgTable(
  'criterion_value',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => supplier.id, { onDelete: 'cascade' }),
    programId: uuid('program_id')
      .notNull()
      .references(() => program.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').references(() => category.id, { onDelete: 'cascade' }),
    criterionKey: text('criterion_key')
      .notNull()
      .references(() => criterion.key),

    /** 0–100, higher is better. Null means `unknown` — the Criterion drops out. */
    value: doublePrecision('value'),
    /** Why it is unknown, when it is. Named in the Assessment's `limits` section. */
    unknownReason: text('unknown_reason'),

    /**
     * The raw inputs the value was computed from — the MFN rate, the kilometre
     * distance, the list of risk factors and their levels.
     *
     * The app **may never render a Criterion number alone** (SPEC §9.1), so this
     * column is not diagnostic extra: it is what the UI displays beside every
     * value, and what the number-fidelity validator matches a sentence's figures
     * against.
     */
    rawInputs: jsonb('raw_inputs').notNull(),
    /** The fixed anchor line, e.g. "0–10% MFN, linear". Rendered with the value. */
    anchorLine: text('anchor_line').notNull(),

    /** The `criterion_value` this one replaced, if any. */
    supersedesId: uuid('supersedes_id'),
    isCurrent: boolean('is_current').notNull().default(true),

    jobId: uuid('job_id'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('criterion_value_current_idx').on(
      t.supplierId,
      t.programId,
      t.categoryId,
      t.criterionKey,
      t.isCurrent,
    ),
    index('criterion_value_program_idx').on(t.programId, t.isCurrent),
  ],
);

export const criterionValueRelations = relations(criterionValue, ({ one }) => ({
  supplier: one(supplier, { fields: [criterionValue.supplierId], references: [supplier.id] }),
  program: one(program, { fields: [criterionValue.programId], references: [program.id] }),
  category: one(category, { fields: [criterionValue.categoryId], references: [category.id] }),
  criterion: one(criterion, {
    fields: [criterionValue.criterionKey],
    references: [criterion.key],
  }),
}));
