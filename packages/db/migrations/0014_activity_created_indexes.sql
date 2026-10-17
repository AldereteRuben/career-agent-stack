-- Activity calendar on the dashboard overview: counts jobs and applications per day for the last twelve months.
-- Additive indexes only; no data changes.
CREATE INDEX IF NOT EXISTS "jobs_workspace_created_idx" ON "jobs" USING btree ("workspace_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "applications_workspace_created_idx" ON "applications" USING btree ("workspace_id","created_at");
