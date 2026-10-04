ALTER TABLE saved_job_searches ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 ADD COLUMN matcher_version integer NOT NULL DEFAULT 1 CHECK (matcher_version IN (1,2)),
 ADD COLUMN provider_ids jsonb NOT NULL DEFAULT '["remotive","arbeitnow"]'::jsonb CHECK (jsonb_typeof(provider_ids) = 'array'),
 ADD COLUMN include_related boolean NOT NULL DEFAULT false,
 ADD COLUMN idempotency_key varchar(100);
CREATE UNIQUE INDEX saved_search_request_uq ON saved_job_searches(workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE job_search_sources DROP CONSTRAINT job_search_sources_provider_check;
ALTER TABLE job_search_sources ADD CONSTRAINT job_search_sources_provider_check CHECK (provider IN ('remotive','arbeitnow','himalayas'));
--> statement-breakpoint
CREATE TABLE search_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL, search_id uuid NOT NULL,
 revision integer NOT NULL, criteria jsonb NOT NULL, status varchar(16) NOT NULL DEFAULT 'QUEUED',
 manual boolean NOT NULL DEFAULT false, owner uuid, lease_until timestamptz,
 error varchar(80), created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
 FOREIGN KEY (workspace_id,search_id) REFERENCES saved_job_searches(workspace_id,id) ON DELETE CASCADE,
 UNIQUE(workspace_id,id), CHECK (status IN ('QUEUED','RUNNING','PARTIAL','SUCCEEDED','FAILED','CANCELLED'))
);
CREATE UNIQUE INDEX search_active_run_uq ON search_runs(workspace_id,search_id,revision) WHERE finished_at IS NULL;
CREATE INDEX search_runs_queue_idx ON search_runs(status,lease_until,created_at);
CREATE TABLE search_run_sources (
 workspace_id uuid NOT NULL, run_id uuid NOT NULL, provider varchar(24) NOT NULL,
 status varchar(16) NOT NULL DEFAULT 'QUEUED', coverage varchar(16), fetched_at timestamptz,
 next_fetch_at timestamptz, error varchar(80), found integer NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,run_id,provider), FOREIGN KEY(workspace_id,run_id) REFERENCES search_runs(workspace_id,id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE search_query_cache (
 provider varchar(24) NOT NULL, query_hash varchar(64) NOT NULL, payload jsonb NOT NULL DEFAULT '[]',
 coverage varchar(16) NOT NULL DEFAULT 'BOUNDED', fetched_at timestamptz, next_fetch_at timestamptz,
 last_used_at timestamptz NOT NULL DEFAULT now(), error varchar(80), failures integer NOT NULL DEFAULT 0,
 PRIMARY KEY(provider,query_hash)
);
CREATE TABLE search_provider_budget (
 provider varchar(24) NOT NULL, day date NOT NULL, requests integer NOT NULL DEFAULT 0,
 PRIMARY KEY(provider,day)
);
CREATE TABLE search_run_results (
 workspace_id uuid NOT NULL, run_id uuid NOT NULL, search_id uuid NOT NULL, job_id uuid NOT NULL,
 score integer NOT NULL, reasons jsonb NOT NULL DEFAULT '[]', location_status varchar(32) NOT NULL,
 unknown_location boolean NOT NULL DEFAULT false, posted_at timestamptz, sources jsonb NOT NULL DEFAULT '[]',
 PRIMARY KEY(workspace_id,run_id,job_id),
 FOREIGN KEY(workspace_id,run_id) REFERENCES search_runs(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,search_id) REFERENCES saved_job_searches(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,job_id) REFERENCES jobs(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX search_run_results_rank_idx ON search_run_results(workspace_id,search_id,run_id,score DESC,job_id);
CREATE TABLE search_job_reviews (
 workspace_id uuid NOT NULL, search_id uuid NOT NULL, job_id uuid NOT NULL, first_matched_at timestamptz NOT NULL DEFAULT now(), seen_at timestamptz,
 PRIMARY KEY(workspace_id,search_id,job_id),
 FOREIGN KEY(workspace_id,search_id) REFERENCES saved_job_searches(workspace_id,id) ON DELETE CASCADE,
 FOREIGN KEY(workspace_id,job_id) REFERENCES jobs(workspace_id,id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE job_identity_members (
 workspace_id uuid NOT NULL, job_id uuid NOT NULL, identity_key varchar(64) NOT NULL, evidence jsonb NOT NULL,
 PRIMARY KEY(workspace_id,job_id), FOREIGN KEY(workspace_id,job_id) REFERENCES jobs(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX job_identity_group_idx ON job_identity_members(workspace_id,identity_key);
CREATE TABLE search_preparation_budget (
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, day date NOT NULL,
 attempted integer NOT NULL DEFAULT 0, PRIMARY KEY(workspace_id,day)
);
