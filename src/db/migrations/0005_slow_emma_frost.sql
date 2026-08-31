-- The table had only its `id` primary key, so the `onConflictDoNothing` on the
-- insert had nothing to conflict on — a fresh uuid never collides — and a
-- second enrichment of the same Profile inserted the whole family again.
-- Bosch and Magna each held 100 rows for 50 distinct members, which the
-- supplier page counted directly: the badge read "28 of 100 explored" where
-- the truth was 14 of 50, both halves doubled.
--
-- The newest row per (root, member) survives, because it came from the most
-- recent read and so carries the freshest path, depth and coverage counts.
DELETE FROM "family_member" a
USING "family_member" b
WHERE a."root_entity_id" = b."root_entity_id"
  AND a."member_entity_id" = b."member_entity_id"
  AND (a."first_seen_at", a."id") < (b."first_seen_at", b."id");
--> statement-breakpoint
CREATE UNIQUE INDEX "family_member_root_member_key" ON "family_member" USING btree ("root_entity_id","member_entity_id");
