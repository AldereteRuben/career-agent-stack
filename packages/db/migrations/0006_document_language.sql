ALTER TABLE document_versions ADD COLUMN language varchar(2);
ALTER TABLE document_versions ADD CONSTRAINT document_versions_language_check CHECK (language IS NULL OR language IN ('es', 'en'));
