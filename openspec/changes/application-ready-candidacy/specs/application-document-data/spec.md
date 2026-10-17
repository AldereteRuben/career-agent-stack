# Spec Delta

## Purpose

Keeps application documents inside the existing privacy guarantees: exported, backed up, restored, deleted and isolated like the rest of the workspace, and migrated safely.

## ADDED Requirements

### Requirement: Included in JSON export
The JSON export SHALL include application documents, revisions, approvals, origins, citations, hashes and every revision's text, and the hash-only `ai_document_reword_proposals` rows, without credentials. PDFs SHALL be exported only for approved revisions and the newest pending one of each logical document; other revisions carry text and `pdf_sha256`. Included PDFs count against the 30,000,000-byte limit and the export is refused over it. Package selections are not stored.

#### Scenario: Export
- **WHEN** the person exports their data
- **THEN** every document revision row, text, hash and approval of every application appears, with the PDF of each approved and each newest pending revision

#### Scenario: Many revisions do not break the export
- **WHEN** a logical document has many saved pending revisions whose PDFs would together exceed 30,000,000 bytes, and only its approved and newest pending revisions fit
- **THEN** the export succeeds, historical pending revisions appear with text and `pdf_sha256` and no PDF, and the included PDFs equal the approved and newest pending ones

#### Scenario: Over the limit
- **WHEN** the included PDFs would push the export past 30,000,000 bytes
- **THEN** the export is refused with the artifact-limit error and no partial export is produced

### Requirement: Encrypted backup and restore
Document content and files SHALL be restored with their approval state, citations and file digests, and the hash-only proposal rows SHALL be restored with their runs. The backup SHALL cover both document tables under the shared lock and list the text file and PDF of every revision; restore SHALL verify both digests, and a document SHALL read as needing review if a cited fact did not restore (computed on read, never written by restore).

#### Scenario: Round trip
- **WHEN** a backup is created and restored into an empty workspace
- **THEN** approved documents are approved again with identical files and digests

#### Scenario: Restore applies staleness rules
- **WHEN** a restored document cites a fact or offer snapshot that did not restore, or whose hash differs
- **THEN** the document reads as needing review rather than approved and current

A consistent `pg_dump`/`pg_restore` of one snapshot keeps ids and the `RESTRICT` snapshot key, so this case arises only from a crafted or partial backup; the test builds such a backup on purpose (see the tasks).

#### Scenario: Both tables and both files are covered
- **WHEN** a backup is taken while a revision is being saved
- **THEN** documents and revisions come from one consistent snapshot, and the backup lists a text file and a PDF for every revision

#### Scenario: Proposal hashes round trip
- **WHEN** a backup holding a succeeded rewording run with proposal-hash rows is restored
- **THEN** the run and its rows are restored together and accepting the proposals still works; no proposal row exists without its run

#### Scenario: Tampered file
- **WHEN** a stored text file or PDF does not match its digest
- **THEN** restore refuses it and reports which document

### Requirement: Deletion
Deletion SHALL be workspace deletion only; no route deletes one application, document or revision. It SHALL remove document rows by the ordered deletion, never by cascade, and the proposal-hash rows before `ai_runs` (their foreign key cascades only so history clearing removes them with their run). Files SHALL live under `FILES_LOCAL_PATH`, path-contained, and be removed by the existing job emptying that folder, retried after an interruption (ADR 020).

#### Scenario: Delete workspace
- **WHEN** the person deletes a workspace that has applications linked to resumes and application documents with stored text and PDF files
- **THEN** no document rows and no proposal-hash rows remain, no file remains under `FILES_LOCAL_PATH`, and deletion succeeds without a foreign key error

#### Scenario: Files removed by the existing cleanup
- **WHEN** workspace deletion runs
- **THEN** the revision rows are deleted in `DELETION_ORDER` with no cascade, the files are removed because the job empties `FILES_LOCAL_PATH`, and the `run/` folder and the control entries that the existing job preserves survive

#### Scenario: Crash after the rows are committed
- **WHEN** the process stops after the row transaction commits and before the files are deleted
- **THEN** the next start retries the deletion job and finishes removing every file, leaving none under `FILES_LOCAL_PATH`

#### Scenario: Path containment
- **WHEN** a revision write would resolve its text or PDF path outside `FILES_LOCAL_PATH`
- **THEN** the write is refused, no revision is created and no file outside the folder is touched

#### Scenario: Reference direction and order
- **WHEN** the schema is inspected
- **THEN** foreign keys from the new tables point one way to applications with explicit `RESTRICT` rules (no cascade that could delete rows, and no self-referencing foreign key), `applications` has no key to them, and they are deleted before applications, which are deleted before the resumes they link

### Requirement: Workspace isolation
Every table and query for this data SHALL be scoped by workspace with composite foreign keys, and no route SHALL return data of another workspace.

#### Scenario: Cross-workspace read
- **WHEN** a request in workspace A names an id from workspace B
- **THEN** it behaves as not found

### Requirement: Safe migrations
Migrations SHALL be additive, apply in order on an existing database with data, keep existing resumes and approvals valid, and have a tested path from the previous schema. Migrations SHALL NOT use the real workspace.

#### Scenario: Upgrade with existing resumes
- **WHEN** the new migration runs on a database with approved resumes, including one linked to an application through `document_id`
- **THEN** those resumes keep their approval state, files and application link, and no row is backfilled into the new tables

#### Scenario: Run input stays immutable
- **WHEN** the base migration has run and anything tries to update `ai_runs.snapshot`
- **THEN** the existing trigger still refuses it, because proposal hashes are stored in their own table

#### Scenario: Serialized migrations
- **WHEN** a later migration for this change (the follow-up draft) is prepared
- **THEN** it is created only after the base migration is merged, with the next free number on `main`

### Requirement: Local-only and private by default
The feature SHALL NOT send document content to any service except a Codex request confirmed for that draft, SHALL NOT log document text, and SHALL keep test fixtures synthetic.

#### Scenario: Logs
- **WHEN** documents are created, edited, approved, downloaded and packaged into a ZIP
- **THEN** server logs contain ids and codes but no document text, checked by a test that uses unique sentinel sentences

#### Scenario: ZIP logs
- **WHEN** a package ZIP is built and downloaded
- **THEN** logs and stderr contain no document sentence, cited fact text or document file name beyond ids and codes, checked with the same sentinels
