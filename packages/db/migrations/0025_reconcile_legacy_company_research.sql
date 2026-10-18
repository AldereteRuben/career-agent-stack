-- Reconcile databases that applied the former company-research migration before
-- the main-branch migrations 0020-0024 were added. The objects are guarded so
-- this also runs safely after the complete migration chain on a fresh database.
CREATE TABLE IF NOT EXISTS "job_filter_overrides" (
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_filter_overrides_pkey" PRIMARY KEY("workspace_id","job_id"),
	CONSTRAINT "job_filter_overrides_workspace_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."jobs"("workspace_id","id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_filter_preferences" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"preferences" jsonb DEFAULT '{"excludedCompanies":[],"requiredTerms":[],"excludedTerms":[]}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_filter_preferences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_snapshots_workspace_job_fetched_idx" ON "job_snapshots" USING btree ("workspace_id","job_id","fetched_at","id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_match_feedback" (
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"rating" varchar(20) NOT NULL,
	"reason" varchar(24),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_match_feedback_pkey" PRIMARY KEY("workspace_id","job_id"),
	CONSTRAINT "job_match_feedback_rating_check" CHECK ("rating" in ('INTERESTED','NOT_FOR_ME')),
	CONSTRAINT "job_match_feedback_reason_check" CHECK ("reason" is null or "reason" in ('LOCATION','SENIORITY','WORK_MODE','ROLE_TYPE','REQUIREMENT','OTHER')),
	CONSTRAINT "job_match_feedback_workspace_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."jobs"("workspace_id","id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_match_feedback_workspace_created_idx" ON "job_match_feedback" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspace_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"profile_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_contacts_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "workspace_contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "application_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"role" varchar(120) NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_contacts_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "application_contacts_workspace_application_fk" FOREIGN KEY ("workspace_id","application_id") REFERENCES "public"."applications"("workspace_id","id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "application_contacts_workspace_contact_fk" FOREIGN KEY ("workspace_id","contact_id") REFERENCES "public"."workspace_contacts"("workspace_id","id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "application_contacts_application_contact_uq" ON "application_contacts" USING btree ("workspace_id","application_id","contact_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "application_contacts_workspace_application_idx" ON "application_contacts" USING btree ("workspace_id","application_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_contacts_workspace_name_idx" ON "workspace_contacts" USING btree ("workspace_id","name");
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "company_research" jsonb DEFAULT '{"whatItDoes":"","howItMakesMoney":"","recentNews":"","culture":"","questionsToAsk":""}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "company_research_revision" integer DEFAULT 1 NOT NULL;
