-- Deleting all data (ADR 020): a session cookie carries the workspace's session generation, and deleting all data
-- increases it, so every existing session stops working in every browser. Existing rows start at 0, which is also
-- what a cookie issued before this migration counts as, so upgrading signs nobody out.
ALTER TABLE "workspaces" ADD COLUMN "session_generation" integer DEFAULT 0 NOT NULL;
