CREATE TYPE "public"."graph_path_direction" AS ENUM('down', 'up', 'either', 'upstream');--> statement-breakpoint
CREATE TYPE "public"."graph_path_kind" AS ENUM('family', 'watchlist', 'shortest_path', 'deep_traversal', 'supply_chain');--> statement-breakpoint
CREATE TABLE "graph_path" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"root_entity_id" text NOT NULL,
	"terminal_entity_id" text NOT NULL,
	"kind" "graph_path_kind" NOT NULL,
	"direction" "graph_path_direction" NOT NULL,
	"hop_depth" integer NOT NULL,
	"edge_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"explored_count" integer,
	"partial_results" boolean DEFAULT false NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"enrichment_id" uuid NOT NULL,
	"discovered_by_job" uuid,
	"filtered" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Hand-edited (ticket 02): move family_member's rows into graph_path before
-- the table is dropped, rather than losing them. This is not the first
-- data-preserving hand-edit in this repo — 0005_slow_emma_frost.sql already
-- ran a DELETE ... USING dedup over family_member ahead of its own unique
-- index, for the same reason (a data move a plain schema diff cannot express)
-- — so this follows that precedent rather than setting a new one.
--
-- Four decisions this INSERT encodes:
--
-- 1. `explored_count` is sourced from `family_member.reachable_count`, NOT
--    `family_member.explored_count`. The two counters meant different things:
--    `explored_count` was the app's own row count (`byId.size`, capped at the
--    read's `limit` — at most 50), while `reachable_count` was the read's own
--    envelope figure (`envelope.explored_count`, sometimes in the thousands —
--    a Yazaki-scale family measured near 5,000). `graph_path.explored_count`
--    is documented to be "read from the envelope, never inferred from path
--    count" (see the column's own comment in `enrichment.ts`), so the
--    envelope-sourced column is the only correct source here.
-- 2. `kind` and `direction` are both derived per row, not hardcoded, because
--    `family_member` mixed rows from two different reads: the automatic
--    family read (`discovered_by_job IS NULL`), which only ever walks down,
--    and a Deep Traversal (`discovered_by_job IS NOT NULL`), which walks both
--    `ownership` (down) and `ubo` (up) into this same table (`traverse.ts`,
--    `mergeMembers`). Migrating every row as `kind = 'family'` with a
--    hardcoded `direction = 'down'` would both misfile every historical
--    upward Deep Traversal find AND — combined with the
--    `graph_path_kind_direction_invariant` CHECK added in migration 0014,
--    which enforces `kind = 'family' ⇒ direction = 'down'` — make a correctly
--    inferred `'up'` direction on a `kind = 'family'` row impossible to
--    insert. So the two are resolved together, matching the design this
--    ticket gives Deep Traversal going forward (CONTEXT.md, *Deep
--    Traversal*: its own finds are Paths of kind `deep_traversal`, kept apart
--    from a Family member's `family`):
--      - `discovered_by_job IS NULL` (the automatic read) → `kind = 'family'`,
--        `direction = 'down'`, unconditionally — this read never walks up, so
--        no inference is needed and the CHECK is trivially satisfied.
--      - `discovered_by_job IS NOT NULL` (a historical Deep Traversal find,
--        bundled into `family_member` under the pre-ticket-02 design) →
--        `kind = 'deep_traversal'`, with `direction` inferred from the stored
--        `summarisePath()` shape (an array of `{field, entityId}` hops):
--        `src/domain/relationships.ts`'s `upwardOwnershipTypes()` names the
--        three upward-ownership relationship types — `has_shareholder`,
--        `has_beneficial_owner`, `subsidiary_of` — and a row whose path
--        contains any hop with one of those `field` values was found walking
--        up; every other such row is `'down'`.
--    This is a best-effort backfill over historical JSON, not a live re-read:
--    a row misclassified here corrects itself on the next automatic enrich
--    pass or Deep Traversal that touches it. Verified against the dev
--    database this migration was checked against: zero of its 2 093
--    `family_member` rows carry a `discovered_by_job`, so in practice every
--    row here still lands as `kind = 'family'`, `direction = 'down'` today —
--    the branch exists for correctness on any dataset that does carry
--    historical Deep Traversal finds, not because this one needed it.
-- 3. `edge_ids` is left empty ('[]'::jsonb) for every migrated row. A Path's
--    edge_ids are `entity_relationship.id`s, and family_member never recorded
--    which relationship rows its path ran through — only the raw traversal
--    `path` JSON, which carries Sayari's own field/entity shape, not our
--    entity_relationship ids. There is no live re-read at migration time to
--    resolve one against the other, so backfilling here would mean guessing.
--    The next automatic enrich pass re-upserts these Paths (and their edges)
--    through the normal write path, populating real edge_ids going forward;
--    until then, a migrated row's chain is absent rather than wrong.
-- 4. `partial_results` is copied from `truncated`. family_member has no
--    partial_results column of its own, and `truncated` — "the 50-node window
--    was smaller than the reachable set" — is the closest existing proxy for
--    "this Path set is incomplete." It is an approximation (partial_results
--    is meant to come straight off the read's own envelope), but it is a
--    better-than-nothing carry-forward for rows that predate the envelope
--    being read at all.
INSERT INTO graph_path (root_entity_id, terminal_entity_id, kind, direction, hop_depth, edge_ids, explored_count, partial_results, truncated, enrichment_id, discovered_by_job, filtered, first_seen_at)
SELECT
	root_entity_id,
	member_entity_id,
	(CASE WHEN discovered_by_job IS NULL THEN 'family' ELSE 'deep_traversal' END)::graph_path_kind,
	(CASE
		WHEN discovered_by_job IS NULL THEN 'down'
		WHEN EXISTS (
			SELECT 1
			FROM jsonb_array_elements(COALESCE(family_member.path, '[]'::jsonb)) AS hop
			WHERE hop->>'field' IN ('has_shareholder', 'has_beneficial_owner', 'subsidiary_of')
		) THEN 'up'
		ELSE 'down'
	END)::graph_path_direction,
	hop_depth,
	'[]'::jsonb,
	reachable_count,
	truncated,
	truncated,
	enrichment_id,
	discovered_by_job,
	false,
	first_seen_at
FROM family_member;
--> statement-breakpoint
DROP TABLE "family_member" CASCADE;--> statement-breakpoint
ALTER TABLE "job" ADD COLUMN "params" jsonb;--> statement-breakpoint
ALTER TABLE "graph_path" ADD CONSTRAINT "graph_path_root_entity_id_entity_id_fk" FOREIGN KEY ("root_entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_path" ADD CONSTRAINT "graph_path_terminal_entity_id_entity_id_fk" FOREIGN KEY ("terminal_entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_path" ADD CONSTRAINT "graph_path_enrichment_id_enrichment_id_fk" FOREIGN KEY ("enrichment_id") REFERENCES "public"."enrichment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "graph_path_root_idx" ON "graph_path" USING btree ("root_entity_id");--> statement-breakpoint
CREATE INDEX "graph_path_terminal_idx" ON "graph_path" USING btree ("terminal_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "graph_path_root_terminal_kind_key" ON "graph_path" USING btree ("root_entity_id","terminal_entity_id","kind");