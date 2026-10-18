CREATE TABLE "job_filter_overrides" (
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_filter_overrides_pkey" PRIMARY KEY("workspace_id","job_id")
);
--> statement-breakpoint
CREATE TABLE "job_filter_preferences" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"preferences" jsonb DEFAULT '{"excludedCompanies":[],"requiredTerms":[],"excludedTerms":[]}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_filter_overrides" ADD CONSTRAINT "job_filter_overrides_workspace_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."jobs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_filter_preferences" ADD CONSTRAINT "job_filter_preferences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;