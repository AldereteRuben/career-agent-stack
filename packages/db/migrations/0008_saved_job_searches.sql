CREATE TABLE "saved_job_searches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
	"role" varchar(200),
	"company" varchar(200),
	"location" varchar(200),
	"work_mode" varchar(16) DEFAULT 'any' NOT NULL,
	"frequency_hours" integer DEFAULT 12 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"auto_prepare" boolean DEFAULT false NOT NULL,
	"language" varchar(2) DEFAULT 'en' NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"last_run_status" varchar(24),
	"last_result_count" integer DEFAULT 0 NOT NULL,
	"last_new_count" integer DEFAULT 0 NOT NULL,
	"last_error" varchar(80),
	"failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_job_searches_workspace_id_uq" UNIQUE("workspace_id", "id"),
	CONSTRAINT "saved_job_searches_scope_check" CHECK ("role" IS NOT NULL OR "company" IS NOT NULL),
	CONSTRAINT "saved_job_searches_mode_check" CHECK ("work_mode" in ('any', 'remote', 'hybrid', 'onsite')),
	CONSTRAINT "saved_job_searches_frequency_check" CHECK ("frequency_hours" in (6, 12, 24)),
	CONSTRAINT "saved_job_searches_language_check" CHECK ("language" in ('en', 'es'))
);
--> statement-breakpoint
CREATE INDEX "saved_job_searches_due_idx" ON "saved_job_searches" USING btree ("enabled", "next_run_at");
--> statement-breakpoint
CREATE TABLE "job_search_provider_cache" (
	"provider" varchar(24) PRIMARY KEY NOT NULL,
	"payload" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"coverage" varchar(16) DEFAULT 'COMPLETE' NOT NULL,
	"fetched_at" timestamp with time zone,
	"next_fetch_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" varchar(80),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_search_provider_cache_provider_check" CHECK ("provider" in ('remotive', 'arbeitnow'))
);
--> statement-breakpoint
CREATE TABLE "job_search_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"provider" varchar(24) NOT NULL,
	"external_id" varchar(300) NOT NULL,
	"source_url" text NOT NULL,
	"posted_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "job_search_sources_workspace_job_fk" FOREIGN KEY ("workspace_id", "job_id") REFERENCES "jobs"("workspace_id", "id") ON DELETE CASCADE,
	CONSTRAINT "job_search_sources_identity_uq" UNIQUE("workspace_id", "provider", "external_id"),
	CONSTRAINT "job_search_sources_provider_check" CHECK ("provider" in ('remotive', 'arbeitnow')),
	CONSTRAINT "job_search_sources_https_check" CHECK ("source_url" like 'https://%')
);
--> statement-breakpoint
CREATE INDEX "job_search_sources_job_idx" ON "job_search_sources" USING btree ("workspace_id", "job_id");
--> statement-breakpoint
CREATE TABLE "saved_job_search_matches" (
	"workspace_id" uuid NOT NULL,
	"search_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"auto_prepared_at" timestamp with time zone,
	"auto_prepare_attempts" integer DEFAULT 0 NOT NULL,
	"auto_prepare_error" varchar(80),
	"auto_prepare_next_attempt_at" timestamp with time zone,
	CONSTRAINT "saved_job_search_matches_workspace_search_fk" FOREIGN KEY ("workspace_id", "search_id") REFERENCES "saved_job_searches"("workspace_id", "id") ON DELETE CASCADE,
	CONSTRAINT "saved_job_search_matches_workspace_job_fk" FOREIGN KEY ("workspace_id", "job_id") REFERENCES "jobs"("workspace_id", "id") ON DELETE CASCADE,
	CONSTRAINT "saved_job_search_matches_identity_uq" UNIQUE("workspace_id", "search_id", "job_id")
);
--> statement-breakpoint
CREATE INDEX "saved_job_search_matches_search_idx" ON "saved_job_search_matches" USING btree ("search_id", "last_matched_at");
--> statement-breakpoint
CREATE INDEX "saved_job_search_matches_pending_idx" ON "saved_job_search_matches" USING btree ("auto_prepared_at", "auto_prepare_next_attempt_at", "workspace_id");
