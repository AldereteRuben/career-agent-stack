# 023 — Offer-specific application documents

Status: accepted. Date: 2026-10-17.

## Context

An application needs an offer-specific resume and cover letter before it is ready to submit. Existing profile facts, generated resume PDFs and the immutable offer snapshot provide the inputs, but a document must not turn an offer requirement into a claim about the candidate. The person must review the exact files that will be downloaded, and must explicitly approve them. Documents also need the same workspace isolation, export, encrypted backup, restore and deletion guarantees as the rest of the application data.

This decision does not automate submission. The existing assisted-application boundary in [ADR 015](015-assisted-applications.md) remains: the person handles the employer form and submits manually. The later follow-up draft in [#115](https://github.com/AldereteRuben/career-agent-stack/issues/115) is a separate, copy-only feature.

## Decision

### 1. Build locally from approved facts

The local builder creates an offer-specific resume and cover letter from approved profile facts and the application's saved offer. Each sentence is one of:

- `OFFER_REFERENCE`: a fixed template containing the application's company, role or location. It refers to the offer and makes no claim about the candidate.
- `BOILERPLATE`: a fixed greeting or closing. Rewording it remains boilerplate only while it contains no employer, title, date, number, credential or skill; otherwise it is treated as a candidate claim.
- `CANDIDATE_CLAIM`: any statement about the candidate's experience, skills, education, dates or numbers. It cites approved facts from the same workspace. Offer fields never support a candidate claim.

Suggested and rejected facts are never used. Requirements without supporting approved facts remain visibly unconfirmed. A thin profile produces a short draft rather than invented or generic experience. A document requires a saved offer and its latest snapshot; otherwise creation fails with `409 APPLICATION_HAS_NO_OFFER`.

### 2. Validate edits and approval on the server

The person can edit, remove and restore sentences before approval. On every save, assistant proposal and approval, the server checks that cited facts exist in the same workspace and are approved. Candidate claims must not introduce an employer, title, date, number, credential or skill absent from their cited facts. An unsupported edit is refused unless the person explicitly confirms it; confirmed text is marked `USER_UNSUPPORTED` and must be confirmed again at approval. Unsupported sentences are not sent to Codex.

Editing an existing builder or Codex sentence changes its origin to `USER_EDITED`. Editing an approved document creates a new pending revision; it does not alter the approved revision.

### 3. Bind approval to the stored preview

Saving a revision renders its PDF and UTF-8 plain-text file once and stores both with SHA-256 digests. The person reviews those stored bytes. Approval checks the revision and content hashes, both stored-file digests, citations, unsupported-claim confirmations, and the current fact and offer hashes. It never re-renders. A change to cited facts or material offer content requires a new revision and approval. Older approved revisions become superseded when a newer one is approved.

Offer references use the immutable company, role and location on the application. Offer freshness uses those values plus the latest snapshot's title and normalized description. Fetch time, availability, source identifiers and derived requirements do not affect freshness.

Each version uses one language, Spanish or English. The resume and cover letter are available as PDF and editable plain text, with matching wording. The document feature uses new application-scoped tables and leaves the existing `applications.document_id` resume link unchanged.

### 4. Keep Codex optional and explicitly confirmed per draft

Codex may only reword candidate-claim sentences already produced by the local builder. Each request displays the complete exact payload and needs a one-time confirmation for that draft; remembered consent and automation do not authorize it. The server validates cited facts and rejects added facts. Proposals are returned synchronously and are not stored in the draft until the person accepts them. The server persists only hashes and identifiers needed to verify acceptance, not proposal text. Without Codex, the full document flow remains available.

### 5. Keep package selection request-only

The person may select approved, current, non-superseded revisions belonging to one application and download them as a ZIP. Selection is sent with the request and is never persisted. The archive contains each selected PDF and text file plus a manifest, is limited to 20 documents and 30,000,000 uncompressed bytes, and is not encrypted. It contains no unrelated profile fields or notes. Downloading does not submit or upload anything; the person attaches the files manually.

### 6. Preserve lifecycle and deletion boundaries

New rows reference applications in one direction; the existing application-to-resume link is not changed. Workspace deletion removes dependent rows in explicit child-before-parent order rather than relying on cascades, and removes the new files through the existing `FILES_LOCAL_PATH` cleanup for this single-workspace installation. Individual-application or individual-revision deletion is not added. JSON export includes all document and revision text and hashes, but includes PDF bytes only for approved and newest-pending revisions, subject to the existing 30,000,000-byte artifact limit. Encrypted backup and restore include the rows and both files with digest checks. Restored documents compute freshness from current facts and offer data when read.

### 7. Deliver follow-up drafts separately

The follow-up email draft for [#115](https://github.com/AldereteRuben/career-agent-stack/issues/115) is a later, separate pull request. It is plain text, editable and copy-only, with fixed bilingual templates and no AI, sending, mailbox access or scheduling. Its migration is created only after the base application-document migration is merged and backup support is merged; no migration is developed in parallel with the base migration. The complete workspace JSON export and encrypted backup include the subject and body so the person can recover their editable draft. The application-material ZIP and application-tracker CSV intentionally omit them: the ZIP is limited to reviewed materials intended for an employer, and the CSV remains a tracking summary.

## Consequences

- Documents are reviewable and reproducible: approval and download use the same stored bytes the person saw.
- Unsupported claims require an explicit user decision and remain visible as unsupported.
- The person remains responsible for submitted content; the app does not submit applications.
- A ZIP is unencrypted and may contain the contact details printed on the approved documents. Encrypted backup remains the option for safekeeping.
- Existing attached resumes are not converted, and documents are removed only by deleting the workspace.
- The follow-up draft stays independently reviewable and cannot send email.

## References

- [ADR 015 — Assisted applications](015-assisted-applications.md)
- [ADR 019 — Encrypted operational backups](019-encrypted-backups.md)
- [ADR 020 — Deleting data and uninstalling](020-deletion-and-uninstall.md)
- [Issue #115 — Follow-up drafts](https://github.com/AldereteRuben/career-agent-stack/issues/115)
- [Issue #43 — Assisted submission, explicitly out of scope](https://github.com/AldereteRuben/career-agent-stack/issues/43)
