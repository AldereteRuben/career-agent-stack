# Proposal

## Why

Career Stack can evaluate a job and prepare a general resume, but the person still has to build, by hand, an offer-specific resume and a cover letter before applying. An application is "ready" only when the documents fit the offer, every statement is backed by facts the person approved, and the person has read and approved them. Follow-up writing after applying ([#115](https://github.com/AldereteRuben/career-agent-stack/issues/115)) is a separate, later need.

## Implementation gate

Planning is based on PR #129 at head `8a7f57164103d25314c8ea34a83ae0fe8faa720e`. **Every implementation task is blocked until PR #129's CI is green and the PR is merged into `main`.** This change does not touch that branch. Work starts from `main` after the merge, and migration numbers are taken from `main` at that time (the next free number after `0018` is expected, not assumed). Migrations are serialized: the base migration merges first, and any later migration (the follow-up draft) is created only after that merge, from the updated `main`. Sensitive pull requests (migration, deletion, backup, privacy and log redaction, PDF rendering and approval, assistant, ZIP) pass an `opus-reviewer` review *before* they are merged.

## What Changes

- **Offer-specific resume draft and cover letter**, built locally from approved profile facts and the saved offer (its latest snapshot). Offer data (company, role, location, taken from the application's immutable columns) may appear only as an *offer reference*; it never supports a statement about the candidate. Every statement about the candidate carries the approved facts it rests on. Nothing is invented; a requirement with no approved fact stays visibly unconfirmed and is never written as experience.
- **Editable review before approval.** The person edits every sentence, removes or restores items, and sees which facts support each one. The text and PDF of a revision are rendered once, when the revision is saved, and stored as an immutable preview; the person reviews those exact bytes. Approval is an explicit human action bound to the exact revision, text hash, PDF hash and fact and offer freshness the person was shown; it verifies the stored digests and rechecks current facts and offer, and never re-renders. Editing after approval creates a new revision that needs approval again. Edits to candidate claims either keep valid citations and add no new fact, or are explicitly marked `USER_UNSUPPORTED` and need the person's confirmation. Nothing is shared, downloaded as "ready" or attached to an application before approval.
- **Two outputs per version:** a PDF and an editable text file (UTF-8 plain text), both rendered from the same approved content.
- **One language per version**, Spanish or English, chosen when the version is created. Mixed-language content in one version is refused; a second language is a separate version.
- **Optional Codex rewording, only with per-draft confirmation.** Codex never drafts from scratch: it proposes rewordings of sentences that the local builder already produced. A remembered or standing consent does not cover documents; every request shows the exact payload (every sentence sent), and the payload sent is byte-identical to the one previewed. Automatic origins are refused. The request is synchronous: proposals come back in the response and nothing is stored or added to the draft until the person accepts them; the server then accepts only text that matches the sentence hashes it recorded. Output must cite shared approved facts, and anything without a valid citation or that adds a fact is rejected. The run is controlled like any other Codex run (a one-off consent row, a new `DOCUMENT_REWORD` operation, the account lease and run-row lease with heartbeat, one run per workspace, atomic busy check under the queue lock, a database operation constraint updated in the base migration, usage recorded and no manual daily budget; `payloadSha256` covers the exact prompt messages sent). Without Codex the whole flow still works. An application with no saved offer (no job or no snapshot) cannot have documents: creation is refused with `409 APPLICATION_HAS_NO_OFFER` and an explanation in both languages.
- **Application-scoped ZIP.** From an application, the person selects approved documents and downloads one ZIP of them (PDF and text, plus a manifest of what and when). The selection exists only in the request and is never stored. Unapproved, stale or superseded revisions cannot be selected. The ZIP may contain the approved resume and cover-letter content and a manifest, and no unrelated profile fields.
- **Data lifecycle:** new data is included in the JSON export (PDF bytes only for approved and newest-pending revisions, other revisions with text and `pdf_sha256`; within the existing 30 MB artifact limit, refused rather than silently trimmed), the encrypted backup and restore, workspace deletion and migrations, and is isolated per workspace. New tables point one way at `applications` (no circular foreign keys); the existing `applications.document_id` link is left unchanged. Deletion in this iteration is workspace deletion only: rows are removed by the ordered deletion, never by cascade, and new text and PDF files live under `FILES_LOCAL_PATH` (path-contained), which the existing job empties for this one-workspace installation. Per-workspace file deletion is not added.
- **Later phase, separately bounded: follow-up email draft (#115).** A plain-text draft stored on the application, editable and copy-only. No sending, no mailbox access, no AI. It is its own pull request: it may start once the base migration (1.2) and the backup work (1.4) are merged, needs only 1.2, 1.4 and their dependencies rather than the other document phases, and is delivered last by default.

## Capabilities

### New Capabilities
- `application-documents`: offer-specific resume draft and cover letter, editable review, approval, PDF plus text, one language per version.
- `application-document-assist`: optional Codex rewording of existing sentences, per-draft confirmation, exact payload, citations and no invented facts.
- `application-package-export`: application-scoped ZIP of selected approved documents.
- `application-document-data`: export, encrypted backup and restore, deletion, workspace isolation and migrations for the new data.
- `application-follow-up-draft`: later, bounded follow-up email draft on the application (copy only).

### Modified Capabilities
<!-- None: openspec/specs/ is empty; existing behavior is documented in code and ADRs only. -->

## Impact

- **Domain:** new rules in `packages/domain` (draft building from approved facts, citation validation, language check, approval and staleness); reuses `documents.ts` and `ai-documents.ts` claim contracts.
- **Database:** a base migration after the latest on `main` for application documents and revisions (cover letters, stored text and PDF; no selection table), and later, strictly after the base migration is merged, a separate migration for the follow-up draft; new tables in `DELETION_ORDER` ([ADR 020](../../../docs/decisions/020-deletion-and-uninstall.md)), the JSON export and the encrypted backup ([ADR 019](../../../docs/decisions/019-encrypted-backups.md)).
- **API:** document routes beside `ai-document-routes.ts` and `document-renderer.ts`; a ZIP download route.
- **Dashboard:** application page review editor, approval, selection and download; Spanish and English labels.
- **Docs:** a new ADR (documents tied to applications, ZIP boundary), updates to `docs/operations/backup-restore.md`, `docs/operations/assistant.md` and the install and uninstall notes.
- **Out of scope:**
  - provider submission automation and any form filling beyond what [ADR 015](../../../docs/decisions/015-assisted-applications.md) already does (#43);
  - sending email, reading a mailbox, or any AI for the follow-up draft (#115);
  - versions, `RELEASE_VERSION` and `CHANGELOG` edits; a release is a separate decision of the owner;
  - mixed-language documents, templates marketplace, DOCX output, rich-text styling beyond the existing resume layout;
  - ZIPs that span several applications;
  - converting an existing `applications.document_id` resume into the new tables (it stays as it is);
  - deleting an individual application or its documents: the repository has no application DELETE route, and this change adds none. Documents are removed only by workspace deletion;
  - deleting or editing a single revision's files (revisions and their files are immutable).
- **Limits that remain:**
  - drafts are only as good as the approved facts; a thin profile gives a thin draft and the interface says so;
  - the editable text file is plain text and carries no layout;
  - Codex wording can read stiffly; the person edits it, and a rejected output leaves the local draft;
  - documents are removed only by deleting the workspace, and that deletion empties the whole files folder (one-workspace installation);
  - the ZIP is not encrypted; the person controls where it is saved. Use the encrypted backup for safekeeping;
  - documents need a saved offer; an application created without a job gets no documents until one is linked (not offered by this change);
  - workspace deletion requested during a Codex rewording run answers `503 DELETION_BUSY` until the run ends (at most the run timeout);
  - the person remains responsible for what they submit; the app never submits.
