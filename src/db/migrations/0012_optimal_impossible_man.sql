ALTER TYPE "public"."enrichment_source" ADD VALUE 'sayari_owner_edges' BEFORE 'world_bank';--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "discover_total_count" integer;--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "discover_total_qualifier" text;--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "discovered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entity" ADD COLUMN "risk_sources" jsonb;--> statement-breakpoint
ALTER TABLE "match_candidate" ADD COLUMN "highlight" jsonb;