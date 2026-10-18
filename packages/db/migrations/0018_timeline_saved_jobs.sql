ALTER TABLE "jobs" ADD COLUMN "saved_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "application_events_workspace_created_idx" ON "application_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "applications_workspace_interview_idx" ON "applications" USING btree ("workspace_id","interview_at") WHERE "applications"."interview_at" is not null;--> statement-breakpoint
CREATE INDEX "jobs_workspace_saved_idx" ON "jobs" USING btree ("workspace_id","saved_at") WHERE "jobs"."saved_at" is not null;