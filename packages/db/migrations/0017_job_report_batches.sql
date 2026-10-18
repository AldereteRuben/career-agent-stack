-- Job evaluation batches (#110): several saved jobs evaluated in one action, at most 50 per batch and one running or
-- paused batch per workspace. Items keep each job's report so pausing or cancelling never loses what was evaluated.
-- Additive only: existing data is untouched.
CREATE TABLE "job_report_batch_items" (
	"workspace_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"company" varchar(200),
	"title" varchar(300),
	"status" varchar(16) DEFAULT 'PENDING' NOT NULL,
	"verdict" varchar(24),
	"error_code" varchar(40),
	"report" jsonb,
	"evaluated_at" timestamp with time zone,
	CONSTRAINT "job_report_batch_items_workspace_id_batch_id_job_id_pk" PRIMARY KEY("workspace_id","batch_id","job_id"),
	CONSTRAINT "job_report_batch_items_status_check" CHECK ("job_report_batch_items"."status" in ('PENDING', 'DONE', 'FAILED', 'SKIPPED')),
	CONSTRAINT "job_report_batch_items_verdict_check" CHECK ("job_report_batch_items"."verdict" is null or "job_report_batch_items"."verdict" in ('GOOD_OPTION', 'REVIEW', 'PROBABLY_NOT_A_FIT'))
);
--> statement-breakpoint
CREATE TABLE "job_report_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'RUNNING' NOT NULL,
	"total" integer NOT NULL,
	"report_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "job_report_batches_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "job_report_batches_status_check" CHECK ("job_report_batches"."status" in ('RUNNING', 'PAUSED', 'CANCELLED', 'COMPLETED')),
	CONSTRAINT "job_report_batches_total_check" CHECK ("job_report_batches"."total" between 1 and 50)
);
--> statement-breakpoint
ALTER TABLE "job_report_batch_items" ADD CONSTRAINT "job_report_batch_items_workspace_batch_fk" FOREIGN KEY ("workspace_id","batch_id") REFERENCES "public"."job_report_batches"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_report_batches" ADD CONSTRAINT "job_report_batches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_report_batch_items_pending_idx" ON "job_report_batch_items" USING btree ("workspace_id","batch_id","status","position");--> statement-breakpoint
CREATE UNIQUE INDEX "job_report_batches_idempotency_uq" ON "job_report_batches" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "job_report_batches_one_active_uq" ON "job_report_batches" USING btree ("workspace_id") WHERE "job_report_batches"."status" in ('RUNNING', 'PAUSED');--> statement-breakpoint
CREATE INDEX "job_report_batches_workspace_created_idx" ON "job_report_batches" USING btree ("workspace_id","created_at");
