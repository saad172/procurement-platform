CREATE TYPE "public"."tariff_line_match" AS ENUM('exact', 'sub_line', 'none');--> statement-breakpoint
ALTER TABLE "tariff_line" ADD COLUMN "matched_htsno" text;--> statement-breakpoint
ALTER TABLE "tariff_line" ADD COLUMN "matched_by" "tariff_line_match";