ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS printed_contact_fields jsonb NOT NULL DEFAULT '["email"]'::jsonb;

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS next_step varchar(500),
  ADD COLUMN IF NOT EXISTS follow_up_date date,
  ADD COLUMN IF NOT EXISTS interview_at timestamptz,
  ADD COLUMN IF NOT EXISTS interview_timezone varchar(100);

CREATE INDEX IF NOT EXISTS applications_workspace_follow_up_idx
  ON applications (workspace_id, follow_up_date)
  WHERE follow_up_date IS NOT NULL;
