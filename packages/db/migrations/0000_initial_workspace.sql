CREATE TYPE "public"."application_state" AS ENUM('DRAFT', 'PREPARING', 'REVIEW_REQUIRED', 'READY', 'IN_PROGRESS', 'UNKNOWN', 'CONFIRMED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."association_status" AS ENUM('VERIFIED', 'UNVERIFIED');--> statement-breakpoint
CREATE TYPE "public"."job_availability" AS ENUM('OPEN', 'POSSIBLY_CLOSED', 'CLOSED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."fact_approval" AS ENUM('SUGGESTED', 'USER_APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."permission_status" AS ENUM('APPROVED_FOR_SCOPE', 'UNKNOWN', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."provider_id" AS ENUM('greenhouse', 'lever', 'ashby');--> statement-breakpoint
CREATE TYPE "public"."recruitment_stage" AS ENUM('NO_RESPONSE', 'RECRUITER_CONTACT', 'ASSESSMENT', 'INTERVIEW', 'FINAL_INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN', 'HIRED');--> statement-breakpoint
CREATE TYPE "public"."shortlist_decision" AS ENUM('UNREVIEWED', 'SHORTLISTED', 'SKIPPED', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "answer_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"semantic_key" varchar(100) NOT NULL,
	"jurisdiction" varchar(2) NOT NULL,
	"question_scope" varchar(160) NOT NULL,
	"value" jsonb,
	"strategy" varchar(40) NOT NULL,
	"approval_status" varchar(30) DEFAULT 'UNANSWERED' NOT NULL,
	"review_after" timestamp with time zone,
	"revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"actor" varchar(80) DEFAULT 'USER' NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"reason" text,
	"prior_state" varchar(40),
	"new_state" varchar(40),
	"evidence" jsonb,
	"aggregate_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid,
	"application_cycle" integer DEFAULT 1 NOT NULL,
	"company" varchar(200) NOT NULL,
	"role" varchar(300) NOT NULL,
	"location" varchar(300),
	"canonical_url" text,
	"state" "application_state" DEFAULT 'DRAFT' NOT NULL,
	"recruitment_stage" "recruitment_stage" DEFAULT 'NO_RESPONSE' NOT NULL,
	"shortlist_decision" "shortlist_decision" DEFAULT 'UNREVIEWED' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_workspace_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" "provider_id" NOT NULL,
	"tenant" varchar(200) NOT NULL,
	"region" varchar(40) NOT NULL,
	"company_name" varchar(200) NOT NULL,
	"company_domain" varchar(253) NOT NULL,
	"careers_url" text NOT NULL,
	"association_status" "association_status" DEFAULT 'UNVERIFIED' NOT NULL,
	"permission_status" "permission_status" DEFAULT 'UNKNOWN' NOT NULL,
	"allowed_application_origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"reviewed_at" timestamp with time zone,
	"review_due_at" timestamp with time zone,
	"last_successful_refresh_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "boards_workspace_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "deletion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" varchar(30) DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"revision" integer NOT NULL,
	"profile_revision_id" uuid,
	"job_snapshot_id" uuid,
	"media_type" varchar(120) NOT NULL,
	"storage_path" text NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_status" varchar(30) DEFAULT 'PENDING_REVIEW' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"provider" "provider_id" NOT NULL,
	"region" varchar(40) NOT NULL,
	"tenant" varchar(200) NOT NULL,
	"external_job_id" varchar(300) NOT NULL,
	"job_url" text NOT NULL,
	"apply_url" text,
	"source_posted_at" timestamp with time zone,
	"source_updated_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_successful_refresh_at" timestamp with time zone,
	"source_payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"occurrence_id" uuid,
	"title" varchar(300) NOT NULL,
	"description_text" text,
	"snapshot_hash" varchar(64) NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"company" varchar(200) NOT NULL,
	"title" varchar(300) NOT NULL,
	"location" varchar(300),
	"canonical_url" text,
	"availability" "job_availability" DEFAULT 'UNKNOWN' NOT NULL,
	"shortlist_decision" "shortlist_decision" DEFAULT 'UNREVIEWED' NOT NULL,
	"fit_score" integer,
	"evidence_coverage" integer,
	"eligibility" varchar(20) DEFAULT 'NEEDS_REVIEW' NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_workspace_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" varchar(80) NOT NULL,
	"model" varchar(160) NOT NULL,
	"operation" varchar(100) NOT NULL,
	"status" varchar(30) NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"profile_version_id" uuid NOT NULL,
	"kind" varchar(64) NOT NULL,
	"statement" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" varchar(40) DEFAULT 'USER_ENTERED' NOT NULL,
	"approval_status" "fact_approval" DEFAULT 'SUGGESTED' NOT NULL,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"locale" varchar(20) DEFAULT 'en-GB' NOT NULL,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_versions_workspace_id_uq" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "search_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"target_titles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"countries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"work_modes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unknown_location_policy" varchar(40) DEFAULT 'NEEDS_REVIEW' NOT NULL,
	"maximum_posted_age_days" integer DEFAULT 14 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"board_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_policy_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"board_id" uuid NOT NULL,
	"capability" varchar(50) NOT NULL,
	"access_class" varchar(60) NOT NULL,
	"permission_status" "permission_status" NOT NULL,
	"api_host" varchar(255) NOT NULL,
	"reference_url" text,
	"notes" text DEFAULT '' NOT NULL,
	"adapter_version" varchar(80) NOT NULL,
	"fixture_coverage" integer DEFAULT 0 NOT NULL,
	"reviewed_at" timestamp with time zone NOT NULL,
	"review_due_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_policy_fixture_coverage_check" CHECK ("source_policy_reviews"."fixture_coverage" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) DEFAULT 'My career workspace' NOT NULL,
	"timezone" varchar(100) DEFAULT 'Europe/Madrid' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answer_versions" ADD CONSTRAINT "answer_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_workspace_application_fk" FOREIGN KEY ("workspace_id","application_id") REFERENCES "public"."applications"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_workspace_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_occurrences" ADD CONSTRAINT "job_occurrences_workspace_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."jobs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_snapshots" ADD CONSTRAINT "job_snapshots_workspace_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."jobs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_workspace_revision_fk" FOREIGN KEY ("workspace_id","profile_version_id") REFERENCES "public"."profile_versions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_versions" ADD CONSTRAINT "profile_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_profiles" ADD CONSTRAINT "search_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_policy_reviews" ADD CONSTRAINT "source_policy_reviews_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_policy_reviews" ADD CONSTRAINT "source_policy_workspace_board_fk" FOREIGN KEY ("workspace_id","board_id") REFERENCES "public"."boards"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "answer_versions_workspace_key_jurisdiction_scope_revision_uq" ON "answer_versions" USING btree ("workspace_id","semantic_key","jurisdiction","question_scope","revision");--> statement-breakpoint
CREATE INDEX "application_events_workspace_application_idx" ON "application_events" USING btree ("workspace_id","application_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_workspace_job_cycle_uq" ON "applications" USING btree ("workspace_id","job_id","application_cycle");--> statement-breakpoint
CREATE INDEX "applications_workspace_state_idx" ON "applications" USING btree ("workspace_id","state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "boards_workspace_provider_region_tenant_uq" ON "boards" USING btree ("workspace_id","provider","region","tenant");--> statement-breakpoint
CREATE INDEX "boards_workspace_enabled_idx" ON "boards" USING btree ("workspace_id","enabled");--> statement-breakpoint
CREATE INDEX "document_versions_workspace_created_idx" ON "document_versions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_occurrences_identity_uq" ON "job_occurrences" USING btree ("workspace_id","provider","region","tenant","external_job_id");--> statement-breakpoint
CREATE INDEX "jobs_workspace_availability_idx" ON "jobs" USING btree ("workspace_id","availability");--> statement-breakpoint
CREATE INDEX "profile_facts_workspace_approval_idx" ON "profile_facts" USING btree ("workspace_id","approval_status");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_versions_workspace_revision_uq" ON "profile_versions" USING btree ("workspace_id","revision");