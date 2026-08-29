CREATE TYPE "public"."assessment_kind" AS ENUM('standard', 'dossier');--> statement-breakpoint
CREATE TYPE "public"."assessment_verdict" AS ENUM('recommend', 'recommend_with_conditions', 'do_not_shortlist', 'escalate');--> statement-breakpoint
CREATE TYPE "public"."confirm_state" AS ENUM('proposed', 'accepted', 'declined');--> statement-breakpoint
CREATE TYPE "public"."discriminator_name" AS ENUM('country', 'locality', 'street', 'name_cover', 'alias_context', 'lei_witness', 'business_purpose', 'liveness');--> statement-breakpoint
CREATE TYPE "public"."discriminator_verdict" AS ENUM('pass', 'fail', 'unavailable');--> statement-breakpoint
CREATE TYPE "public"."enrichment_source" AS ENUM('sayari_negative_news', 'sayari_ownership_family', 'world_bank', 'gleif', 'usitc', 'nominatim');--> statement-breakpoint
CREATE TYPE "public"."enrichment_subject_kind" AS ENUM('entity', 'country', 'hs_line', 'address');--> statement-breakpoint
CREATE TYPE "public"."evaluator_outcome" AS ENUM('passed', 'published_with_objections');--> statement-breakpoint
CREATE TYPE "public"."geocode_precision" AS ENUM('building', 'street', 'locality', 'city', 'region', 'country', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('resolve', 'enrich', 'traverse', 'assess', 'recommend', 'discover', 'dossier');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('queued', 'running', 'done', 'failed', 'paused_on_budget', 'terminated', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."job_subject_type" AS ENUM('supplier', 'category', 'entity', 'program');--> statement-breakpoint
CREATE TYPE "public"."lead_classification" AS ENUM('manufacturer', 'forwarder_or_logistics', 'trader_or_distributor', 'consumer_goods', 'unclear');--> statement-breakpoint
CREATE TYPE "public"."match_settled_by" AS ENUM('rules', 'agents', 'human', 'discovered');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('accepted', 'needs_review', 'not_found');--> statement-breakpoint
CREATE TYPE "public"."pick_role" AS ENUM('award', 'second_source', 'develop', 'avoid');--> statement-breakpoint
CREATE TYPE "public"."recommendation_mark" AS ENUM('accepted', 'rejected', 'needs_work');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('high', 'elevated', 'relevant');--> statement-breakpoint
CREATE TYPE "public"."round_role" AS ENUM('proposer', 'lead', 'evaluator', 'human');--> statement-breakpoint
CREATE TYPE "public"."round_source" AS ENUM('model', 'code', 'human');--> statement-breakpoint
CREATE TYPE "public"."rubric_item" AS ENUM('support', 'strength', 'number_fidelity', 'caveats', 'eligibility', 'omission');--> statement-breakpoint
CREATE TYPE "public"."run_state" AS ENUM('queued', 'running', 'done', 'failed', 'paused_on_budget', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."sentence_section" AS ENUM('identity', 'compliance', 'ownership', 'country', 'tariff', 'media', 'limits', 'headline', 'rationale', 'conditions', 'open_questions', 'dissent');--> statement-breakpoint
CREATE TYPE "public"."supplier_origin" AS ENUM('imported', 'discovered');--> statement-breakpoint
CREATE TYPE "public"."thread_message_role" AS ENUM('user', 'assistant', 'tool');--> statement-breakpoint
CREATE TYPE "public"."trace_fidelity" AS ENUM('replayable', 'timeline');--> statement-breakpoint
CREATE TYPE "public"."upstream_error_kind" AS ENUM('parse', 'entitlement', 'auth', 'rate_limit', 'not_found', 'bad_request', 'timeout', 'transport', 'upstream_5xx', 'projection');--> statement-breakpoint
CREATE TYPE "public"."upstream_source" AS ENUM('sayari', 'gleif', 'worldbank', 'usitc', 'nominatim');--> statement-breakpoint
CREATE TYPE "public"."upstream_via" AS ENUM('sdk', 'raw');--> statement-breakpoint
CREATE TYPE "public"."usage_outcome" AS ENUM('ok', 'error');--> statement-breakpoint
CREATE TABLE "category" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "category_flag" (
	"category_id" uuid NOT NULL,
	"flag_key" text NOT NULL,
	"note" text,
	CONSTRAINT "category_flag_category_id_flag_key_pk" PRIMARY KEY("category_id","flag_key")
);
--> statement-breakpoint
CREATE TABLE "category_hs_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"category_id" uuid NOT NULL,
	"hs_code" text NOT NULL,
	"label" text NOT NULL,
	"rate" numeric(6, 3) NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "country_flag" (
	"country" text NOT NULL,
	"flag_key" text NOT NULL,
	"note" text,
	CONSTRAINT "country_flag_country_flag_key_pk" PRIMARY KEY("country","flag_key")
);
--> statement-breakpoint
CREATE TABLE "criterion" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"blurb" text NOT NULL,
	"direction" text DEFAULT 'higher_is_better' NOT NULL,
	"is_weighted" boolean DEFAULT true NOT NULL,
	"sort_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"code" text NOT NULL,
	"role" text NOT NULL,
	"city" text NOT NULL,
	"country" text NOT NULL,
	"lat" double precision NOT NULL,
	"lon" double precision NOT NULL,
	"precision" "geocode_precision" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "program" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"importing_country" text NOT NULL,
	"vehicle_class" text NOT NULL,
	"sourcing_horizon" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "program_criterion_weight" (
	"program_id" uuid NOT NULL,
	"criterion_key" text NOT NULL,
	"weight" numeric(6, 3) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "program_criterion_weight_program_id_criterion_key_pk" PRIMARY KEY("program_id","criterion_key")
);
--> statement-breakpoint
CREATE TABLE "supplier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"origin" "supplier_origin" NOT NULL,
	"roster_index" integer,
	"roster_name" text,
	"roster_address" text,
	"roster_country" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_origin_roster_consistency" CHECK (("supplier"."origin" = 'imported' AND "supplier"."roster_name" IS NOT NULL AND "supplier"."roster_index" IS NOT NULL)
        OR ("supplier"."origin" = 'discovered' AND "supplier"."roster_name" IS NULL AND "supplier"."roster_index" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "supplier_category" (
	"supplier_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	CONSTRAINT "supplier_category_supplier_id_category_id_pk" PRIMARY KEY("supplier_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "tariff_flag" (
	"key" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"why_not_a_rate" text NOT NULL,
	"sort_order" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upstream_response" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "upstream_source" NOT NULL,
	"endpoint" text NOT NULL,
	"params_hash" text NOT NULL,
	"params" jsonb NOT NULL,
	"body" jsonb NOT NULL,
	"body_hash" text NOT NULL,
	"via" "upstream_via" NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"job_id" uuid,
	"source" "upstream_source",
	"endpoint" text NOT NULL,
	"bucket" text,
	"via" "upstream_via",
	"ms" integer NOT NULL,
	"outcome" "usage_outcome" NOT NULL,
	"error_kind" "upstream_error_kind",
	"cache_hit" boolean DEFAULT false NOT NULL,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_creation_input_tokens" integer,
	"cache_read_input_tokens" integer,
	"trace_turn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"entity_type" text,
	"country" text,
	"address_line" text,
	"city" text,
	"postcode" text,
	"lat" double precision,
	"lon" double precision,
	"lei" text,
	"source_count" jsonb,
	"distinct_source_count" integer,
	"sanctioned" boolean DEFAULT false NOT NULL,
	"pep" boolean DEFAULT false NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"risk" jsonb,
	"psa_count" integer,
	"relationship_count" jsonb,
	"relationships_truncated" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_relationship" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_entity_id" text NOT NULL,
	"to_entity_id" text NOT NULL,
	"relationship_type" text NOT NULL,
	"former" boolean DEFAULT false NOT NULL,
	"start_date" text,
	"end_date" text,
	"source_record_id" text,
	"hop_depth" integer DEFAULT 1 NOT NULL,
	"discovered_by_job" uuid,
	"attributes" jsonb,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text,
	"source_label" text,
	"collected_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"fields" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"status" "match_status" NOT NULL,
	"entity_id" text,
	"settled_by" "match_settled_by" NOT NULL,
	"match_strength" text,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_supplier_id_unique" UNIQUE("supplier_id")
);
--> statement-breakpoint
CREATE TABLE "match_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"job_id" uuid,
	"attempt_n" integer NOT NULL,
	"rungs_used" jsonb,
	"outcome_status" "match_status" NOT NULL,
	"outcome_entity_id" text,
	"settled_by" "match_settled_by" NOT NULL,
	"thread_message_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_candidate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_attempt_id" uuid NOT NULL,
	"entity_id" text NOT NULL,
	"found_by_rung" text NOT NULL,
	"query_provenance" text,
	"score" numeric(12, 6),
	"match_strength" text,
	"explanation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_candidate_verdict" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_candidate_id" uuid NOT NULL,
	"discriminator" text NOT NULL,
	"verdict" "discriminator_verdict" NOT NULL,
	"reasoning" text NOT NULL,
	"reported_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "country_indicator" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrichment_id" uuid NOT NULL,
	"country" text NOT NULL,
	"indicator_code" text NOT NULL,
	"indicator_label" text NOT NULL,
	"year" integer,
	"value" double precision,
	"lower_bound" double precision,
	"upper_bound" double precision
);
--> statement-breakpoint
CREATE TABLE "enrichment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "enrichment_source" NOT NULL,
	"subject_kind" "enrichment_subject_kind" NOT NULL,
	"subject_key" text NOT NULL,
	"request_params" jsonb NOT NULL,
	"upstream_response_id" uuid NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"job_id" uuid
);
--> statement-breakpoint
CREATE TABLE "family_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrichment_id" uuid NOT NULL,
	"root_entity_id" text NOT NULL,
	"member_entity_id" text NOT NULL,
	"path" jsonb,
	"hop_depth" integer NOT NULL,
	"discovered_by_job" uuid,
	"truncated" boolean DEFAULT false NOT NULL,
	"explored_count" integer,
	"reachable_count" integer,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geocode" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrichment_id" uuid NOT NULL,
	"query_address" text NOT NULL,
	"lat" double precision,
	"lon" double precision,
	"precision" "geocode_precision" NOT NULL,
	"display_name" text,
	"provider" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lei_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrichment_id" uuid NOT NULL,
	"lei" text NOT NULL,
	"legal_name" text NOT NULL,
	"legal_address_line" text,
	"legal_city" text,
	"legal_postcode" text,
	"legal_country" text,
	"status" text,
	"registration_status" text
);
--> statement-breakpoint
CREATE TABLE "news_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrichment_id" uuid NOT NULL,
	"entity_id" text,
	"title" text NOT NULL,
	"source_name" text,
	"url" text,
	"published_at" timestamp with time zone,
	"risk_flags" jsonb
);
--> statement-breakpoint
CREATE TABLE "tariff_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enrichment_id" uuid NOT NULL,
	"hs_code" text NOT NULL,
	"importer_country" text NOT NULL,
	"origin_country" text,
	"description" text,
	"mfn_rate" numeric(6, 3),
	"rate_text" text
);
--> statement-breakpoint
CREATE TABLE "criterion_value" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"category_id" uuid,
	"criterion_key" text NOT NULL,
	"value" double precision,
	"unknown_reason" text,
	"raw_inputs" jsonb NOT NULL,
	"anchor_line" text NOT NULL,
	"supersedes_id" uuid,
	"is_current" boolean DEFAULT true NOT NULL,
	"job_id" uuid,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assessment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"supplier_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"kind" "assessment_kind" DEFAULT 'standard' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assessment_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assessment_id" uuid NOT NULL,
	"verdict" "assessment_verdict",
	"n" integer NOT NULL,
	"frozen_inputs" jsonb NOT NULL,
	"evaluator_outcome" "evaluator_outcome" NOT NULL,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "citation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sentence_id" uuid NOT NULL,
	"entity_id" text,
	"record_id" text,
	"enrichment_id" uuid,
	"criterion_value_id" uuid,
	"match_id" uuid,
	"shortlist_program_id" uuid,
	"shortlist_category_id" uuid,
	CONSTRAINT "citation_exactly_one_target_group" CHECK (("citation"."entity_id" IS NOT NULL)::int
      + ("citation"."record_id" IS NOT NULL)::int
      + ("citation"."enrichment_id" IS NOT NULL)::int
      + ("citation"."criterion_value_id" IS NOT NULL)::int
      + ("citation"."match_id" IS NOT NULL)::int
      + (("citation"."shortlist_program_id" IS NOT NULL AND "citation"."shortlist_category_id" IS NOT NULL))::int = 1),
	CONSTRAINT "citation_shortlist_pair_is_whole" CHECK (("citation"."shortlist_program_id" IS NULL) = ("citation"."shortlist_category_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "lead" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"entity_id" text NOT NULL,
	"classification" "lead_classification",
	"classification_reasoning" text,
	"shipment_count" integer,
	"latest_shipment_date" text,
	"top_hs_codes" jsonb,
	"arrival_countries" jsonb,
	"related_supplier_id" uuid,
	"relation_verified" boolean DEFAULT false NOT NULL,
	"dismissed" boolean DEFAULT false NOT NULL,
	"promoted_supplier_id" uuid,
	"job_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendation_pick" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recommendation_version_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"role" "pick_role" NOT NULL,
	"rank" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendation_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"human_mark" "recommendation_mark",
	"human_marked_at" timestamp with time zone,
	"n" integer NOT NULL,
	"frozen_inputs" jsonb NOT NULL,
	"evaluator_outcome" "evaluator_outcome" NOT NULL,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "round" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_attempt_id" uuid,
	"assessment_version_id" uuid,
	"recommendation_version_id" uuid,
	"n" integer NOT NULL,
	"role" "round_role" NOT NULL,
	"source" "round_source" NOT NULL,
	"text" text,
	"objection" text,
	"reply" text,
	"rubric" jsonb,
	"dismissed_to" timestamp with time zone,
	"dismissed_inputs_hash" text,
	"job_round_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "round_one_owner" CHECK (("round"."match_attempt_id" IS NOT NULL)::int
      + ("round"."assessment_version_id" IS NOT NULL)::int
      + ("round"."recommendation_version_id" IS NOT NULL)::int = 1)
);
--> statement-breakpoint
CREATE TABLE "sentence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assessment_version_id" uuid,
	"recommendation_version_id" uuid,
	"section" "sentence_section" NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"pick_id" uuid,
	CONSTRAINT "sentence_one_owner" CHECK (("sentence"."assessment_version_id" IS NOT NULL)::int + ("sentence"."recommendation_version_id" IS NOT NULL)::int = 1),
	CONSTRAINT "sentence_pick_only_in_conditions" CHECK ("sentence"."pick_id" IS NULL OR "sentence"."section" = 'conditions')
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" "job_kind" NOT NULL,
	"subject_type" "job_subject_type" NOT NULL,
	"subject_id" text NOT NULL,
	"state" "job_state" DEFAULT 'queued' NOT NULL,
	"tool_call_cap" integer NOT NULL,
	"token_cap" integer NOT NULL,
	"tool_calls_used" integer DEFAULT 0 NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"trace_fidelity" "trace_fidelity" DEFAULT 'replayable' NOT NULL,
	"terminated_reason" text,
	"error" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_round" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"checkpoint" jsonb NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"state" "run_state" DEFAULT 'queued' NOT NULL,
	"trigger" text NOT NULL,
	"subject_label" text,
	"budget_usd" numeric(10, 4),
	"supplier_count" integer,
	"estimate_usd" numeric(10, 4),
	"thread_id" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trace_tool_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_turn_id" uuid NOT NULL,
	"tool_use_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb,
	"upstream_response_id" uuid,
	"body_hash" text,
	"ms" integer NOT NULL,
	"ok" jsonb
);
--> statement-breakpoint
CREATE TABLE "trace_turn" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"n" integer NOT NULL,
	"request" jsonb NOT NULL,
	"response" jsonb NOT NULL,
	"stop_reason" text,
	"stop_details" jsonb,
	"tool_names" jsonb,
	"tool_digest_hash" text,
	"ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" "thread_message_role" NOT NULL,
	"text" text,
	"thinking_summary" text,
	"page_ref" text,
	"widget" jsonb,
	"confirm" jsonb,
	"confirm_state" "confirm_state",
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_program_id_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_flag" ADD CONSTRAINT "category_flag_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_flag" ADD CONSTRAINT "category_flag_flag_key_tariff_flag_key_fk" FOREIGN KEY ("flag_key") REFERENCES "public"."tariff_flag"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_hs_line" ADD CONSTRAINT "category_hs_line_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "country_flag" ADD CONSTRAINT "country_flag_flag_key_tariff_flag_key_fk" FOREIGN KEY ("flag_key") REFERENCES "public"."tariff_flag"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plant" ADD CONSTRAINT "plant_program_id_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_criterion_weight" ADD CONSTRAINT "program_criterion_weight_program_id_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_criterion_weight" ADD CONSTRAINT "program_criterion_weight_criterion_key_criterion_key_fk" FOREIGN KEY ("criterion_key") REFERENCES "public"."criterion"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_program_id_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_category" ADD CONSTRAINT "supplier_category_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_category" ADD CONSTRAINT "supplier_category_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relationship" ADD CONSTRAINT "entity_relationship_from_entity_id_entity_id_fk" FOREIGN KEY ("from_entity_id") REFERENCES "public"."entity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relationship" ADD CONSTRAINT "entity_relationship_to_entity_id_entity_id_fk" FOREIGN KEY ("to_entity_id") REFERENCES "public"."entity"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match" ADD CONSTRAINT "match_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match" ADD CONSTRAINT "match_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_attempt" ADD CONSTRAINT "match_attempt_match_id_match_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."match"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_attempt" ADD CONSTRAINT "match_attempt_outcome_entity_id_entity_id_fk" FOREIGN KEY ("outcome_entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_candidate" ADD CONSTRAINT "match_candidate_match_attempt_id_match_attempt_id_fk" FOREIGN KEY ("match_attempt_id") REFERENCES "public"."match_attempt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_candidate" ADD CONSTRAINT "match_candidate_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_candidate_verdict" ADD CONSTRAINT "match_candidate_verdict_match_candidate_id_match_candidate_id_fk" FOREIGN KEY ("match_candidate_id") REFERENCES "public"."match_candidate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "country_indicator" ADD CONSTRAINT "country_indicator_enrichment_id_enrichment_id_fk" FOREIGN KEY ("enrichment_id") REFERENCES "public"."enrichment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment" ADD CONSTRAINT "enrichment_upstream_response_id_upstream_response_id_fk" FOREIGN KEY ("upstream_response_id") REFERENCES "public"."upstream_response"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_member" ADD CONSTRAINT "family_member_enrichment_id_enrichment_id_fk" FOREIGN KEY ("enrichment_id") REFERENCES "public"."enrichment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_member" ADD CONSTRAINT "family_member_root_entity_id_entity_id_fk" FOREIGN KEY ("root_entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "family_member" ADD CONSTRAINT "family_member_member_entity_id_entity_id_fk" FOREIGN KEY ("member_entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geocode" ADD CONSTRAINT "geocode_enrichment_id_enrichment_id_fk" FOREIGN KEY ("enrichment_id") REFERENCES "public"."enrichment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lei_record" ADD CONSTRAINT "lei_record_enrichment_id_enrichment_id_fk" FOREIGN KEY ("enrichment_id") REFERENCES "public"."enrichment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_item" ADD CONSTRAINT "news_item_enrichment_id_enrichment_id_fk" FOREIGN KEY ("enrichment_id") REFERENCES "public"."enrichment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_item" ADD CONSTRAINT "news_item_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tariff_line" ADD CONSTRAINT "tariff_line_enrichment_id_enrichment_id_fk" FOREIGN KEY ("enrichment_id") REFERENCES "public"."enrichment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criterion_value" ADD CONSTRAINT "criterion_value_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criterion_value" ADD CONSTRAINT "criterion_value_program_id_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criterion_value" ADD CONSTRAINT "criterion_value_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criterion_value" ADD CONSTRAINT "criterion_value_criterion_key_criterion_key_fk" FOREIGN KEY ("criterion_key") REFERENCES "public"."criterion"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment" ADD CONSTRAINT "assessment_program_id_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_version" ADD CONSTRAINT "assessment_version_assessment_id_assessment_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation" ADD CONSTRAINT "citation_sentence_id_sentence_id_fk" FOREIGN KEY ("sentence_id") REFERENCES "public"."sentence"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation" ADD CONSTRAINT "citation_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation" ADD CONSTRAINT "citation_record_id_record_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."record"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation" ADD CONSTRAINT "citation_enrichment_id_enrichment_id_fk" FOREIGN KEY ("enrichment_id") REFERENCES "public"."enrichment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation" ADD CONSTRAINT "citation_criterion_value_id_criterion_value_id_fk" FOREIGN KEY ("criterion_value_id") REFERENCES "public"."criterion_value"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation" ADD CONSTRAINT "citation_match_id_match_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."match"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation" ADD CONSTRAINT "citation_shortlist_program_id_program_id_fk" FOREIGN KEY ("shortlist_program_id") REFERENCES "public"."program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "citation" ADD CONSTRAINT "citation_shortlist_category_id_category_id_fk" FOREIGN KEY ("shortlist_category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_program_id_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_entity_id_entity_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entity"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_related_supplier_id_supplier_id_fk" FOREIGN KEY ("related_supplier_id") REFERENCES "public"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_promoted_supplier_id_supplier_id_fk" FOREIGN KEY ("promoted_supplier_id") REFERENCES "public"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_program_id_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation" ADD CONSTRAINT "recommendation_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_pick" ADD CONSTRAINT "recommendation_pick_recommendation_version_id_recommendation_version_id_fk" FOREIGN KEY ("recommendation_version_id") REFERENCES "public"."recommendation_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_pick" ADD CONSTRAINT "recommendation_pick_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_version" ADD CONSTRAINT "recommendation_version_recommendation_id_recommendation_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendation"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round" ADD CONSTRAINT "round_assessment_version_id_assessment_version_id_fk" FOREIGN KEY ("assessment_version_id") REFERENCES "public"."assessment_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "round" ADD CONSTRAINT "round_recommendation_version_id_recommendation_version_id_fk" FOREIGN KEY ("recommendation_version_id") REFERENCES "public"."recommendation_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentence" ADD CONSTRAINT "sentence_assessment_version_id_assessment_version_id_fk" FOREIGN KEY ("assessment_version_id") REFERENCES "public"."assessment_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentence" ADD CONSTRAINT "sentence_recommendation_version_id_recommendation_version_id_fk" FOREIGN KEY ("recommendation_version_id") REFERENCES "public"."recommendation_version"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sentence" ADD CONSTRAINT "sentence_pick_id_recommendation_pick_id_fk" FOREIGN KEY ("pick_id") REFERENCES "public"."recommendation_pick"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_run_id_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_round" ADD CONSTRAINT "job_round_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run" ADD CONSTRAINT "run_program_id_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_tool_call" ADD CONSTRAINT "trace_tool_call_trace_turn_id_trace_turn_id_fk" FOREIGN KEY ("trace_turn_id") REFERENCES "public"."trace_turn"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_tool_call" ADD CONSTRAINT "trace_tool_call_upstream_response_id_upstream_response_id_fk" FOREIGN KEY ("upstream_response_id") REFERENCES "public"."upstream_response"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_turn" ADD CONSTRAINT "trace_turn_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread" ADD CONSTRAINT "thread_program_id_program_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."program"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_message" ADD CONSTRAINT "thread_message_thread_id_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."thread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "category_program_code_key" ON "category" USING btree ("program_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "category_hs_line_category_code_key" ON "category_hs_line" USING btree ("category_id","hs_code");--> statement-breakpoint
CREATE INDEX "category_hs_line_category_idx" ON "category_hs_line" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plant_program_code_key" ON "plant" USING btree ("program_id","code");--> statement-breakpoint
CREATE INDEX "supplier_program_idx" ON "supplier" USING btree ("program_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_program_roster_index_key" ON "supplier" USING btree ("program_id","roster_index");--> statement-breakpoint
CREATE INDEX "supplier_category_category_idx" ON "supplier_category" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "upstream_response_key_idx" ON "upstream_response" USING btree ("source","endpoint","params_hash","fetched_at");--> statement-breakpoint
CREATE INDEX "usage_event_run_idx" ON "usage_event" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "usage_event_job_idx" ON "usage_event" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "entity_country_idx" ON "entity" USING btree ("country");--> statement-breakpoint
CREATE INDEX "entity_lei_idx" ON "entity" USING btree ("lei");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_relationship_edge_key" ON "entity_relationship" USING btree ("from_entity_id","to_entity_id","relationship_type","source_record_id");--> statement-breakpoint
CREATE INDEX "entity_relationship_from_idx" ON "entity_relationship" USING btree ("from_entity_id");--> statement-breakpoint
CREATE INDEX "entity_relationship_to_idx" ON "entity_relationship" USING btree ("to_entity_id");--> statement-breakpoint
CREATE INDEX "match_entity_idx" ON "match" USING btree ("entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_attempt_match_n_key" ON "match_attempt" USING btree ("match_id","attempt_n");--> statement-breakpoint
CREATE INDEX "match_attempt_match_idx" ON "match_attempt" USING btree ("match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_candidate_attempt_entity_key" ON "match_candidate" USING btree ("match_attempt_id","entity_id");--> statement-breakpoint
CREATE INDEX "match_candidate_attempt_idx" ON "match_candidate" USING btree ("match_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_candidate_verdict_key" ON "match_candidate_verdict" USING btree ("match_candidate_id","discriminator","reported_by");--> statement-breakpoint
CREATE INDEX "country_indicator_country_idx" ON "country_indicator" USING btree ("country","indicator_code");--> statement-breakpoint
CREATE INDEX "enrichment_subject_idx" ON "enrichment" USING btree ("source","subject_kind","subject_key","fetched_at");--> statement-breakpoint
CREATE INDEX "family_member_root_idx" ON "family_member" USING btree ("root_entity_id");--> statement-breakpoint
CREATE INDEX "lei_record_lei_idx" ON "lei_record" USING btree ("lei");--> statement-breakpoint
CREATE INDEX "news_item_entity_idx" ON "news_item" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "tariff_line_key_idx" ON "tariff_line" USING btree ("hs_code","importer_country");--> statement-breakpoint
CREATE INDEX "criterion_value_current_idx" ON "criterion_value" USING btree ("supplier_id","program_id","category_id","criterion_key","is_current");--> statement-breakpoint
CREATE INDEX "criterion_value_program_idx" ON "criterion_value" USING btree ("program_id","is_current");--> statement-breakpoint
CREATE INDEX "assessment_supplier_idx" ON "assessment" USING btree ("supplier_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_version_n_key" ON "assessment_version" USING btree ("assessment_id","n");--> statement-breakpoint
CREATE INDEX "citation_sentence_idx" ON "citation" USING btree ("sentence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_program_category_entity_key" ON "lead" USING btree ("program_id","category_id","entity_id");--> statement-breakpoint
CREATE INDEX "lead_category_idx" ON "lead" USING btree ("category_id","dismissed");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendation_program_category_key" ON "recommendation" USING btree ("program_id","category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendation_pick_version_supplier_key" ON "recommendation_pick" USING btree ("recommendation_version_id","supplier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendation_version_n_key" ON "recommendation_version" USING btree ("recommendation_id","n");--> statement-breakpoint
CREATE INDEX "round_match_attempt_idx" ON "round" USING btree ("match_attempt_id","n");--> statement-breakpoint
CREATE INDEX "round_assessment_idx" ON "round" USING btree ("assessment_version_id","n");--> statement-breakpoint
CREATE INDEX "round_recommendation_idx" ON "round" USING btree ("recommendation_version_id","n");--> statement-breakpoint
CREATE INDEX "sentence_assessment_idx" ON "sentence" USING btree ("assessment_version_id","section","ordinal");--> statement-breakpoint
CREATE INDEX "sentence_recommendation_idx" ON "sentence" USING btree ("recommendation_version_id","section","ordinal");--> statement-breakpoint
CREATE INDEX "job_dequeue_idx" ON "job" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "job_run_idx" ON "job" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "job_subject_idx" ON "job" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_round_job_n_key" ON "job_round" USING btree ("job_id","n");--> statement-breakpoint
CREATE INDEX "run_program_idx" ON "run" USING btree ("program_id","created_at");--> statement-breakpoint
CREATE INDEX "trace_tool_call_turn_idx" ON "trace_tool_call" USING btree ("trace_turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trace_turn_job_n_key" ON "trace_turn" USING btree ("job_id","n");--> statement-breakpoint
CREATE INDEX "thread_program_idx" ON "thread" USING btree ("program_id","created_at");--> statement-breakpoint
CREATE INDEX "thread_message_thread_idx" ON "thread_message" USING btree ("thread_id","created_at");