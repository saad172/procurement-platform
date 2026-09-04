ALTER TYPE "public"."enrichment_source" ADD VALUE 'sayari_trade_footprint' BEFORE 'world_bank';--> statement-breakpoint
ALTER TYPE "public"."enrichment_source" ADD VALUE 'sayari_supply_chain_upstream' BEFORE 'world_bank';--> statement-breakpoint
ALTER TYPE "public"."job_kind" ADD VALUE 'trade';--> statement-breakpoint
CREATE TABLE "trade_buyer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrichment_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"buyer_entity_id" text NOT NULL,
	"buyer_name" text NOT NULL,
	"countries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk" jsonb,
	"sanctioned" boolean,
	"pep" boolean
);
--> statement-breakpoint
CREATE TABLE "trade_footprint" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrichment_id" uuid NOT NULL,
	"shipment_count" integer NOT NULL,
	"latest_shipment_date" text,
	"hs_facet" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trade_shipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrichment_id" uuid NOT NULL,
	"shipment_id" text NOT NULL,
	"arrival_date" jsonb,
	"departure_date" jsonb,
	"buyer" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"product_origin" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hs_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"monetary_value" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"weight" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"record" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trade_buyer" ADD CONSTRAINT "trade_buyer_enrichment_id_enrichment_id_fk" FOREIGN KEY ("enrichment_id") REFERENCES "public"."enrichment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_footprint" ADD CONSTRAINT "trade_footprint_enrichment_id_enrichment_id_fk" FOREIGN KEY ("enrichment_id") REFERENCES "public"."enrichment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_shipment" ADD CONSTRAINT "trade_shipment_enrichment_id_enrichment_id_fk" FOREIGN KEY ("enrichment_id") REFERENCES "public"."enrichment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trade_buyer_enrichment_idx" ON "trade_buyer" USING btree ("enrichment_id");--> statement-breakpoint
CREATE INDEX "trade_footprint_enrichment_idx" ON "trade_footprint" USING btree ("enrichment_id");--> statement-breakpoint
CREATE INDEX "trade_shipment_enrichment_idx" ON "trade_shipment" USING btree ("enrichment_id");