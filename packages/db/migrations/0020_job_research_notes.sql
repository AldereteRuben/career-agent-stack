CREATE TABLE "job_research_notes" (
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"notes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_research_notes_workspace_id_job_id_pk" PRIMARY KEY("workspace_id","job_id")
);
--> statement-breakpoint
ALTER TABLE "job_research_notes" ADD CONSTRAINT "job_research_notes_workspace_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."jobs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;