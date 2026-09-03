ALTER TYPE "public"."enrichment_source" ADD VALUE 'sayari_owner_edges' BEFORE 'world_bank';--> statement-breakpoint
ALTER TABLE "entity" ADD COLUMN "risk_sources" jsonb;--> statement-breakpoint
ALTER TABLE "match_candidate" ADD COLUMN "highlight" jsonb;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "trade_total_count" integer;