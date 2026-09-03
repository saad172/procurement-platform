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
-- Hand-edited (ticket 02, one-time exception to "generated migrations are
-- never hand-edited"): move family_member's rows into graph_path before the
-- table is dropped, rather than losing them.
--
-- Two decisions this INSERT encodes, both deliberate:
--
-- 1. `edge_ids` is left empty ('[]'::jsonb) for every migrated row. A Path's
--    edge_ids are `entity_relationship.id`s, and family_member never recorded
--    which relationship rows its path ran through — only the raw traversal
--    `path` JSON, which carries Sayari's own field/entity shape, not our
--    entity_relationship ids. There is no live re-read at migration time to
--    resolve one against the other, so backfilling here would mean guessing.
--    The next automatic enrich pass re-upserts these Paths (and their edges)
--    through the normal write path, populating real edge_ids going forward;
--    until then, a migrated row's chain is absent rather than wrong.
-- 2. `partial_results` is copied from `truncated`. family_member has no
--    partial_results column of its own, and `truncated` — "the 50-node window
--    was smaller than the reachable set" — is the closest existing proxy for
--    "this Path set is incomplete." It is an approximation (partial_results
--    is meant to come straight off the read's own envelope), but it is a
--    better-than-nothing carry-forward for rows that predate the envelope
--    being read at all.
INSERT INTO graph_path (root_entity_id, terminal_entity_id, kind, direction, hop_depth, edge_ids, explored_count, partial_results, truncated, enrichment_id, discovered_by_job, filtered, first_seen_at)
SELECT root_entity_id, member_entity_id, 'family', 'down', hop_depth, '[]'::jsonb, explored_count, truncated, truncated, enrichment_id, discovered_by_job, false, first_seen_at
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