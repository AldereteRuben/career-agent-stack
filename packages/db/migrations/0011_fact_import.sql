-- Resume import (ADR 018): facts created by one import share an import_id so the whole import can be undone.
-- Additive and nullable: facts entered by hand, and every fact written by earlier releases, keep NULL.
ALTER TABLE "profile_facts" ADD COLUMN "import_id" uuid;
--> statement-breakpoint
CREATE INDEX "profile_facts_workspace_import_idx" ON "profile_facts" ("workspace_id", "import_id") WHERE "import_id" IS NOT NULL;
