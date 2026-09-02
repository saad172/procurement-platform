CREATE TYPE "public"."match_country_source" AS ENUM('gleif', 'matched_address', 'profile');--> statement-breakpoint
ALTER TABLE "match" ADD COLUMN "settled_country" text;--> statement-breakpoint
ALTER TABLE "match" ADD COLUMN "settled_country_source" "match_country_source";