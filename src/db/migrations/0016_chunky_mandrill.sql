-- Hand-edited (ticket 03, network spec §9): the sentence-section rename
-- `ownership` → `network` needs a data rewrite of its own, and the reasoning
-- differs from every hand-edit before it in this migrations folder, so it is
-- written out here rather than assumed obvious.
--
-- drizzle-kit's own diff (the four ALTER/DROP/CREATE/ALTER statements below,
-- unedited) recreates the enum type wholesale — `text` cast out, `DROP
-- TYPE`, `CREATE TYPE` with the renamed value, `text` cast back in —
-- because Postgres enums have no "rename value" the type-diff algorithm
-- reaches for on its own (it CAN be done with `ALTER TYPE ... RENAME
-- VALUE`, but that is not what generate produces here, and rewriting a
-- generated statement to use it would be exactly the kind of hand-edit this
-- file is for the DATA, not the DDL).
--
-- Two separate problems showed up running the generated statements against
-- a real database, not a hypothetical one — both found by actually applying
-- this migration, not by reading the SQL:
--
-- 1. The first `ALTER TABLE ... SET DATA TYPE text` fails outright, on
--    every database, with `operator does not exist: text = sentence_section`
--    — nothing to do with any row's data. `sentence`'s own
--    `sentence_pick_only_in_conditions` CHECK constraint
--    (`src/db/schema/narrative.ts`) reads `"section" = 'conditions'`, and
--    Postgres re-typechecks a CHECK constraint's expression against a
--    column's new type as part of `ALTER COLUMN ... SET DATA TYPE`, rather
--    than deferring that check to `USING`. Confirmed by reproducing it
--    directly: dropping the constraint first and adding it back once
--    `section` is the new enum again (statements 1 and 5 of this block) is
--    what makes the exact four generated statements succeed, unedited, in
--    between. `sentence_one_owner`, the table's other CHECK, does not
--    mention `section` and needed no such treatment.
-- 2. Only once that runs at all does the second problem show: the final
--    `USING "section"::"public"."sentence_section"` cast throws on any
--    `sentence.section = 'ownership'` row, because the new enum has nowhere
--    for it to land. That is the data rewrite the rename is actually about,
--    and it has to happen in the one-statement window where the column is a
--    plain `text` and can still hold the old value — after it is cast OUT
--    of the old enum, before it is cast INTO the new one.
ALTER TABLE "sentence" DROP CONSTRAINT "sentence_pick_only_in_conditions";--> statement-breakpoint
ALTER TABLE "sentence" ALTER COLUMN "section" SET DATA TYPE text;--> statement-breakpoint
UPDATE "sentence" SET "section" = 'network' WHERE "section" = 'ownership';--> statement-breakpoint
DROP TYPE "public"."sentence_section";--> statement-breakpoint
CREATE TYPE "public"."sentence_section" AS ENUM('identity', 'compliance', 'network', 'country', 'tariff', 'media', 'limits', 'headline', 'rationale', 'conditions', 'open_questions', 'dissent');--> statement-breakpoint
ALTER TABLE "sentence" ALTER COLUMN "section" SET DATA TYPE "public"."sentence_section" USING "section"::"public"."sentence_section";--> statement-breakpoint
ALTER TABLE "sentence" ADD CONSTRAINT "sentence_pick_only_in_conditions" CHECK ("sentence"."pick_id" IS NULL OR "sentence"."section" = 'conditions');--> statement-breakpoint

-- Hand-edited (ticket 03, network spec §9): `criterion.key`
-- `ownership_exposure` → `network_exposure`, and everything that points at it.
--
-- This is the judgement call the ticket flags, so the reasoning is written
-- out in full. `criterion.key` / `program_criterion_weight.criterion_key` /
-- `criterion_value.criterion_key` are `text` columns, not a `pgEnum` — the
-- CriterionKey rename in `src/domain/scoring/types.ts` is a TypeScript-only
-- change and drizzle-kit's schema diff cannot see a value living inside a
-- `text` column at all, generated or otherwise. Left alone, a database that
-- already ran the seed carries a `criterion` row (and every
-- `program_criterion_weight` / `criterion_value` row keyed on it) under the
-- OLD key forever: the app's `CriterionKey` union no longer has
-- `'ownership_exposure'` as a member, so nothing in the running code would
-- ever again look that row up, an append-only `criterion_value` history
-- would fork in two at this migration, and a re-run of `seed.ts` would not
-- repair it — `seedCriteria`'s `onConflictDoNothing({ target:
-- t.criterion.key })` only inserts the row it does not find; it has no
-- reason to touch a row under an unrelated key it has never heard of, so the
-- stale row would sit there un-renamed and orphaned rather than get cleaned
-- up automatically. So this is written by hand, in the same migration as the
-- sentence_section rename, for the reason network spec §9 gives for doing
-- every rename "in one PR": the enum, the seeded row and the fixtures move
-- together, or a reader hits a data type that no longer agrees with the code
-- that reads it.
--
-- The three tables cannot be touched with one `UPDATE criterion SET key =
-- 'network_exposure' WHERE key = 'ownership_exposure'` the way
-- `sentence.section` above was: `criterion.key` is a PRIMARY KEY, and both
-- `program_criterion_weight.criterion_key` and
-- `criterion_value.criterion_key` reference it with the schema's default
-- `ON UPDATE no action` (verified against
-- `0000_lovely_hitman.sql`'s `..._criterion_key_criterion_key_fk`
-- constraints, and neither is declared `DEFERRABLE`) — so renaming the
-- parent row while a child still points at the old value fails immediately
-- with a foreign-key violation, in either order. The move is therefore
-- insert-repoint-delete rather than update-in-place:
--   1. insert `network_exposure` as a copy of the existing
--      `ownership_exposure` row — every column but `key` and `label` carries
--      over verbatim, because this migration renames the Criterion, it does
--      not re-decide its weight, its blurb or its position in the rail
--      (network spec §12 leaves the default weight open for a later
--      decision; this migration is not that decision). `label` becomes
--      "Network exposure" per spec §9's rename table, matching
--      `CRITERION_LABELS.network_exposure` in `src/domain/score.ts` and
--      `CRITERIA` in `src/db/seed-data/program.ts`, both renamed in this
--      same PR.
--   2. repoint every `program_criterion_weight` and `criterion_value` row
--      still keyed on `ownership_exposure` to `network_exposure` — legal now
--      that the parent row exists under the new key.
--   3. drop the now-unreferenced `ownership_exposure` row — legal now that
--      nothing points at it.
-- The insert's `ON CONFLICT ("key") DO NOTHING` and the two `UPDATE`/`DELETE`
-- statements' `WHERE` clauses make the whole block a no-op wherever
-- `ownership_exposure` was never seeded — a fresh database that migrates
-- before it ever runs `seed.ts` (this ticket's own test database among
-- them), which seeds straight from the already-renamed `CRITERIA` and never
-- creates the old key at all. It is therefore safe to run unconditionally on
-- every database this migration reaches, seeded or not, once or twice.
INSERT INTO "criterion" ("key", "label", "blurb", "direction", "is_weighted", "sort_order")
SELECT 'network_exposure', 'Network exposure', "blurb", "direction", "is_weighted", "sort_order"
FROM "criterion"
WHERE "key" = 'ownership_exposure'
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint
UPDATE "program_criterion_weight" SET "criterion_key" = 'network_exposure'
WHERE "criterion_key" = 'ownership_exposure';--> statement-breakpoint
UPDATE "criterion_value" SET "criterion_key" = 'network_exposure'
WHERE "criterion_key" = 'ownership_exposure';--> statement-breakpoint
DELETE FROM "criterion" WHERE "key" = 'ownership_exposure';
