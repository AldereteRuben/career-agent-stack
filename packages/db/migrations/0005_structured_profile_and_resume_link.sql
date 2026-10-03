ALTER TABLE "applications" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_workspace_id_uq" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_workspace_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "public"."document_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;