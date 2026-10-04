CREATE TABLE "ai_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "provider" varchar(24) NOT NULL,
  "official_context_ref" text,
  "masked_identity" varchar(200),
  "account_fingerprint" varchar(64) NOT NULL,
  "binary_version" varchar(100),
  "capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "selected_model" varchar(160),
  "revision" integer DEFAULT 1 NOT NULL,
  "state" varchar(32) DEFAULT 'UNAVAILABLE' NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ai_connections_workspace_id_uq" UNIQUE("workspace_id", "id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_connections_active_provider_uq" ON "ai_connections" ("workspace_id", "provider") WHERE "active";
--> statement-breakpoint
CREATE TABLE "ai_consents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "provider" varchar(24) NOT NULL,
  "account_fingerprint" varchar(64) NOT NULL,
  "connection_revision" integer NOT NULL,
  "revision" integer NOT NULL,
  "operation" varchar(32) NOT NULL,
  "data_categories" jsonb NOT NULL,
  "search_ids" jsonb,
  "remembered" boolean DEFAULT false NOT NULL,
  "notice_version" varchar(64) NOT NULL,
  "granted_at" timestamptz DEFAULT now() NOT NULL,
  "revoked_at" timestamptz,
  CONSTRAINT "ai_consents_workspace_id_uq" UNIQUE("workspace_id", "id"),
  CONSTRAINT "ai_consents_workspace_connection_fk" FOREIGN KEY ("workspace_id", "connection_id") REFERENCES "ai_connections"("workspace_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_consents_revision_uq" ON "ai_consents" ("workspace_id", "connection_id", "operation", "revision");
--> statement-breakpoint
CREATE TABLE "ai_automation_policies" (
  "activated_at" timestamptz DEFAULT now() NOT NULL,
  "locale" varchar(2) DEFAULT 'es' NOT NULL,
  "selected_fact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "selection_snapshot" jsonb,
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL,
  "consent_id" uuid NOT NULL,
  "search_ids" jsonb NOT NULL,
  "active" boolean DEFAULT false NOT NULL,
  "paused" boolean DEFAULT true NOT NULL,
  "maximum_daily_starts" integer DEFAULT 10 NOT NULL,
  "revision" integer DEFAULT 1 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ai_automation_policies_workspace_id_uq" UNIQUE("workspace_id", "id"),
  CONSTRAINT "ai_automation_workspace_connection_fk" FOREIGN KEY ("workspace_id", "connection_id") REFERENCES "ai_connections"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "ai_automation_workspace_consent_fk" FOREIGN KEY ("workspace_id", "consent_id") REFERENCES "ai_consents"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "ai_automation_daily_check" CHECK ("maximum_daily_starts" BETWEEN 0 AND 10)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_automation_active_workspace_uq" ON "ai_automation_policies" ("workspace_id") WHERE "active";
--> statement-breakpoint
CREATE TABLE "ai_runs" (
  "search_id" uuid,
  "automation_policy_id" uuid,
  "automation_policy_revision" integer,
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "consent_id" uuid NOT NULL,
  "provider" varchar(24) NOT NULL,
  "model" varchar(160),
  "connection_revision" integer NOT NULL,
  "consent_revision" integer NOT NULL,
  "account_fingerprint" varchar(64) NOT NULL,
  "operation" varchar(32) NOT NULL,
  "origin" varchar(16) NOT NULL,
  "status" varchar(24) DEFAULT 'QUEUED' NOT NULL,
  "idempotency_key" varchar(200) NOT NULL,
  "content_identity" varchar(64) NOT NULL,
  "account_lock_key" varchar(64) NOT NULL,
  "snapshot" jsonb NOT NULL,
  "snapshot_hash" varchar(64) NOT NULL,
  "input_versions" jsonb NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "reservation_pass_id" uuid,
  "reserved_at" timestamptz DEFAULT now() NOT NULL,
  "reserved_day" date DEFAULT ((now() AT TIME ZONE 'UTC')::date) NOT NULL,
  "lease_token" uuid,
  "lease_owner" varchar(160),
  "lease_until" timestamptz,
  "attempt" integer DEFAULT 0 NOT NULL,
  "retry_of" uuid,
  "error" jsonb,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ai_runs_workspace_id_uq" UNIQUE("workspace_id", "id"),
  CONSTRAINT "ai_runs_workspace_connection_fk" FOREIGN KEY ("workspace_id", "connection_id") REFERENCES "ai_connections"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "ai_runs_workspace_consent_fk" FOREIGN KEY ("workspace_id", "consent_id") REFERENCES "ai_consents"("workspace_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "ai_runs_workspace_search_fk" FOREIGN KEY ("workspace_id", "search_id") REFERENCES "saved_job_searches"("workspace_id", "id"),
  CONSTRAINT "ai_runs_workspace_policy_fk" FOREIGN KEY ("workspace_id", "automation_policy_id") REFERENCES "ai_automation_policies"("workspace_id", "id"),
  CONSTRAINT "ai_runs_workspace_retry_fk" FOREIGN KEY ("workspace_id", "retry_of") REFERENCES "ai_runs"("workspace_id", "id"),
  CONSTRAINT "ai_runs_status_check" CHECK ("status" IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCEL_REQUESTED','CANCELLED','INTERRUPTED')),
  CONSTRAINT "ai_runs_origin_check" CHECK ("origin" IN ('MANUAL','AUTOMATIC')),
  CONSTRAINT "ai_runs_operation_check" CHECK ("operation" IN ('SEARCH_DRAFT','JOB_ANALYSIS','RESUME_DRAFT','ANSWER_DRAFT'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_runs_idempotency_uq" ON "ai_runs" ("workspace_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "ai_runs_queue_idx" ON "ai_runs" ("status", "priority", "reserved_at");
--> statement-breakpoint
CREATE INDEX "ai_runs_account_idx" ON "ai_runs" ("account_lock_key", "status");
--> statement-breakpoint
CREATE INDEX "ai_runs_content_idx" ON "ai_runs" ("workspace_id", "content_identity", "status");
--> statement-breakpoint
CREATE TABLE "ai_account_leases" (
  "account_lock_key" varchar(64) PRIMARY KEY,
  "run_id" uuid,
  "workspace_id" uuid,
  "lease_token" uuid,
  "lease_owner" varchar(160),
  "lease_until" timestamptz NOT NULL DEFAULT 'epoch',
  CONSTRAINT "ai_account_leases_workspace_run_fk" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "ai_runs"("workspace_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE "ai_artifacts" (
  "revision" integer DEFAULT 1 NOT NULL,
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "schema_version" integer NOT NULL,
  "prompt_version" varchar(64) NOT NULL,
  "locale" varchar(2) NOT NULL,
  "output" jsonb NOT NULL,
  "sources" jsonb NOT NULL,
  "state" varchar(24) DEFAULT 'PENDING_REVIEW' NOT NULL,
  "approved_at" timestamptz,
  "approved_hash" varchar(64),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ai_artifacts_workspace_id_uq" UNIQUE("workspace_id", "id"),
  CONSTRAINT "ai_artifacts_workspace_run_fk" FOREIGN KEY ("workspace_id", "run_id") REFERENCES "ai_runs"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "ai_artifacts_state_check" CHECK ("state" IN ('PENDING_REVIEW','ACCEPTED','DISMISSED','STALE'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_artifacts_run_uq" ON "ai_artifacts" ("workspace_id", "run_id");
--> statement-breakpoint
CREATE TABLE "ai_usage_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "availability" varchar(16) NOT NULL,
  "windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "source" varchar(80) NOT NULL,
  "observed_at" timestamptz NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ai_usage_workspace_connection_fk" FOREIGN KEY ("workspace_id", "connection_id") REFERENCES "ai_connections"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "ai_usage_availability_check" CHECK ("availability" IN ('KNOWN','STALE','UNAVAILABLE'))
);
--> statement-breakpoint
CREATE INDEX "ai_usage_workspace_connection_idx" ON "ai_usage_snapshots" ("workspace_id", "connection_id", "observed_at");
--> statement-breakpoint
CREATE TABLE "ai_daily_budgets" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "control_day" date NOT NULL,
  "automatic_reserved" integer DEFAULT 0 NOT NULL,
  "automatic_started" integer DEFAULT 0 NOT NULL,
  "manual_reserved" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ai_daily_budgets_pk" PRIMARY KEY("workspace_id", "control_day"),
  CONSTRAINT "ai_daily_budgets_nonnegative_check" CHECK ("automatic_reserved" >= 0 AND "automatic_started" >= 0 AND "manual_reserved" >= 0)
);
--> statement-breakpoint
ALTER TABLE "llm_usage" ALTER COLUMN "model" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "answer_versions" ADD COLUMN "ai_provenance" jsonb;
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "ai_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "availability" varchar(16) DEFAULT 'UNAVAILABLE' NOT NULL;
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_availability_check" CHECK ("availability" IN ('KNOWN','STALE','UNAVAILABLE'));
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_workspace_ai_run_fk" FOREIGN KEY ("workspace_id", "ai_run_id") REFERENCES "ai_runs"("workspace_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX "llm_usage_ai_run_uq" ON "llm_usage" ("workspace_id", "ai_run_id");
--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "claims_contract_version" integer;
--> statement-breakpoint
ALTER TABLE "document_versions" ADD COLUMN "claims_basis" jsonb;
--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_claims_contract_check" CHECK ("claims_contract_version" IS NULL OR "claims_contract_version" = 1);
--> statement-breakpoint
CREATE FUNCTION "ai_runs_immutable_input"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."workspace_id" <> OLD."workspace_id" OR NEW."connection_id" <> OLD."connection_id" OR NEW."consent_id" <> OLD."consent_id"
     OR NEW."provider" <> OLD."provider" OR NEW."model" IS DISTINCT FROM OLD."model" OR NEW."connection_revision" <> OLD."connection_revision"
     OR NEW."consent_revision" <> OLD."consent_revision" OR NEW."account_fingerprint" <> OLD."account_fingerprint" OR NEW."reservation_pass_id" IS DISTINCT FROM OLD."reservation_pass_id"
     OR NEW."operation" <> OLD."operation" OR NEW."origin" <> OLD."origin" OR NEW."idempotency_key" <> OLD."idempotency_key"
     OR NEW."content_identity" <> OLD."content_identity" OR NEW."account_lock_key" <> OLD."account_lock_key" OR NEW."snapshot" <> OLD."snapshot"
     OR NEW."search_id" IS DISTINCT FROM OLD."search_id" OR NEW."automation_policy_id" IS DISTINCT FROM OLD."automation_policy_id"
     OR NEW."automation_policy_revision" IS DISTINCT FROM OLD."automation_policy_revision" OR NEW."reserved_day" <> OLD."reserved_day"
     OR NEW."snapshot_hash" <> OLD."snapshot_hash" OR NEW."input_versions" <> OLD."input_versions" OR NEW."retry_of" IS DISTINCT FROM OLD."retry_of" THEN
    RAISE EXCEPTION 'AI run identity and input are immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "ai_runs_immutable_input_trigger" BEFORE UPDATE ON "ai_runs" FOR EACH ROW EXECUTE FUNCTION "ai_runs_immutable_input"();
--> statement-breakpoint
CREATE FUNCTION "ai_artifacts_immutable_output"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."workspace_id" <> OLD."workspace_id" OR NEW."run_id" <> OLD."run_id" OR NEW."schema_version" <> OLD."schema_version"
     OR NEW."prompt_version" <> OLD."prompt_version" OR NEW."locale" <> OLD."locale" OR NEW."output" <> OLD."output" OR NEW."sources" <> OLD."sources" THEN
    RAISE EXCEPTION 'AI artifact output and provenance are immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "ai_artifacts_immutable_output_trigger" BEFORE UPDATE ON "ai_artifacts" FOR EACH ROW EXECUTE FUNCTION "ai_artifacts_immutable_output"();
--> statement-breakpoint
ALTER TABLE "ai_artifacts" ADD COLUMN "dismissed_at" timestamptz;
--> statement-breakpoint
CREATE TABLE "ai_run_tombstones" (
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "run_id" uuid NOT NULL, "consent_id" uuid NOT NULL, "idempotency_hash" varchar(64) NOT NULL,
  "job_id" uuid, "canonical_identity" varchar(64), "reservation_pass_id" uuid, "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "ai_run_tombstones_pk" PRIMARY KEY("workspace_id", "run_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ai_tombstone_idempotency_uq" ON "ai_run_tombstones"("workspace_id", "idempotency_hash");
--> statement-breakpoint
CREATE INDEX "ai_tombstone_job_idx" ON "ai_run_tombstones"("workspace_id", "job_id");
--> statement-breakpoint
CREATE INDEX "ai_tombstone_identity_idx" ON "ai_run_tombstones"("workspace_id", "canonical_identity");
--> statement-breakpoint
CREATE INDEX "ai_tombstone_consent_idx" ON "ai_run_tombstones"("workspace_id", "consent_id");
