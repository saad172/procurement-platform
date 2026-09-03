ALTER TYPE "public"."enrichment_source" ADD VALUE 'sayari_owner_edges' BEFORE 'world_bank';--> statement-breakpoint
ALTER TABLE "entity" ADD COLUMN "risk_sources" jsonb;