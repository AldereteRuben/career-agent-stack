-- Job availability (ADR 021): how many complete reads in a row missed a job, per source, so a job can become
-- POSSIBLY_CLOSED; the size of the previous complete read, so a suspicious read gives no absence evidence; the
-- person's own decision to close a job; and the history of every availability change. All additive: existing rows
-- start with no misses, so nothing closes earlier than three complete reads over 48 hours after upgrading.
ALTER TABLE "job_occurrences" ADD COLUMN "missed_complete_reads" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "job_search_sources" ADD COLUMN "missed_complete_reads" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "last_complete_count" integer;
--> statement-breakpoint
ALTER TABLE "job_search_provider_cache" ADD COLUMN "last_complete_count" integer;
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "closed_by_user" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "job_availability_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "job_id" uuid NOT NULL,
  "from_state" "job_availability" NOT NULL,
  "to_state" "job_availability" NOT NULL,
  "reason" varchar(30) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "job_availability_events_reason_check" CHECK ("reason" IN ('ABSENT_FROM_SOURCES', 'SEEN_AGAIN', 'CLOSED_BY_USER', 'REOPENED_BY_USER')),
  CONSTRAINT "job_availability_events_workspace_job_fk" FOREIGN KEY ("workspace_id", "job_id") REFERENCES "jobs"("workspace_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "job_availability_events_job_idx" ON "job_availability_events" ("workspace_id", "job_id", "created_at");
