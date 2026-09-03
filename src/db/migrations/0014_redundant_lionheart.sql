DROP INDEX "graph_path_root_idx";--> statement-breakpoint
CREATE INDEX "graph_path_root_kind_idx" ON "graph_path" USING btree ("root_entity_id","kind");--> statement-breakpoint
ALTER TABLE "graph_path" ADD CONSTRAINT "graph_path_kind_direction_invariant" CHECK (("graph_path"."kind" <> 'family' OR "graph_path"."direction" = 'down')
        AND ("graph_path"."kind" <> 'supply_chain' OR "graph_path"."direction" = 'upstream'));