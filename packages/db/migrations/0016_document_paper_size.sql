ALTER TABLE document_versions
  ADD COLUMN IF NOT EXISTS paper_size varchar(6) NOT NULL DEFAULT 'A4';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'document_versions_paper_size_check'
      AND conrelid = 'document_versions'::regclass
  ) THEN
    ALTER TABLE document_versions
      ADD CONSTRAINT document_versions_paper_size_check CHECK (paper_size IN ('A4', 'LETTER'));
  END IF;
END $$;
