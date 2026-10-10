# 018 — Importing an existing resume into the profile

Status: **accepted**, implementation pending (tracking issue [#23](https://github.com/AldereteRuben/career-agent-stack/issues/23), task T0). Date: 2026-10-08.

## Context

People who already have a resume should not have to retype it. The profile already models suggestions: facts with `approvalStatus: 'SUGGESTED'` and `source: 'IMPORTED_SUGGESTION'` are stored but ignored by matching and resume generation until the person confirms them. Nothing creates imported suggestions yet.

A resume contains more personal data than the profile needs (phone, home address, sometimes date of birth). Operational backups are not encrypted yet ([#84](https://github.com/AldereteRuben/career-agent-stack/issues/84)), and data deletion is still being designed ([#25](https://github.com/AldereteRuben/career-agent-stack/issues/25)). Browser security headers and a nonce-based Content-Security-Policy are in place since [#24](https://github.com/AldereteRuben/career-agent-stack/issues/24), which the issue required before processing uploaded files.

## Decision

### 1. The path without AI comes first

The first release imports **without AI**: the browser extracts the text and splits it into sections (Experience, Education, Skills… in Spanish and English), then proposes editable entries. It is always available and nothing leaves the device.

This path builds every shared piece: the batch import API (T1), batch approval (T2), PDF text extraction (T3), section splitting (T4) and the review screen (T5). The Codex path (T6) comes later as a second way to produce suggestions for the same review screen. It needs its own AI operation, data category and notice version, removes contact details locally before sending, and drops any suggestion that does not cite the exact resume excerpt it comes from.

### 2. The extracted text is discarded

The extracted or pasted text lives **only in the browser's memory** while the person imports. It is never sent as a whole to the API, stored in the database, written to browser storage or kept in logs. Only the resulting entries are sent to the API, where they are stored as suggestions (see 4). To import again, the person selects the file again.

Because the raw text is never stored, exports, backups and deletion need no new handling. The suggestions are ordinary profile facts and are already covered.

### 3. Limits

| Limit | Value | Reason |
|---|---|---|
| PDF file size | 5 MB | Text resumes are usually well under 1 MB; larger files are more likely scans or image-heavy documents, which are out of scope. |
| Pages read | 10 | Resumes are usually 1 to 4 pages. Longer documents are truncated with a visible notice, not refused. |
| Extracted or pasted text | 50,000 characters | Same limit as a job description (`jobImportSchema`); about 10 dense pages. |
| Extraction time | 30 seconds in total | After that the worker is terminated and the person can paste the text instead. |
| Suggestions per import | 100 | Keeps one import reviewable and the request well under the API's 1 MB body limit. |
| Characters per suggestion | 4,000 (existing fact limit) | Longer sections are split into several entries. |

A file is checked before PDF.js opens it: size first, then the `%PDF-` signature. PDF.js runs in its worker from `/pdf-assets` (allowed by the CSP), with a timeout, and the worker is terminated when extraction ends or fails. `pdfjs-dist` 6.3 does not use `eval`, so no CSP exception is needed. A PDF with almost no extractable text is reported as probably scanned (OCR is out of scope) and the person is offered to paste the text.

### 4. Suggestions are stored, grouped by an import identifier

T1 stores the imported entries as profile facts with `approvalStatus: 'SUGGESTED'` and `source: 'IMPORTED_SUGGESTION'`, in one transaction, on the current profile revision. Nothing changes in matching or resumes until the person confirms.

T1 also adds a nullable `import_id` column to `profile_facts` in an **additive migration**, like the v0.8 and v0.9 migrations. Every fact from one import shares the same `import_id`; facts entered by hand keep `NULL`. Profile revisions already copy every column of every fact, so the identifier survives later edits. Undoing an import (T10) reverts **the whole import** after one confirmation that states how many entries are affected: suggestions of that `import_id` that are still unconfirmed are discarded, and entries already confirmed are **archived**, the same action the profile offers for a single entry. Nothing is deleted: archived entries leave new resumes, remain in the PDFs that already used them, and can be restored one by one. Deleting confirmed entries would break the record of what each generated PDF contains, which the app never does. Before undoing, the import summary reports `pending`, `confirmed` and `inactive` entries. `inactive` groups suggestions discarded earlier and entries archived after confirmation, because both are stored as `REJECTED`; an interface must label it neutrally (for example "already removed") rather than as archived.

Possible duplicates of existing facts (same kind and the same statement after trimming and case folding) are flagged for the review screen, not silently dropped.

### 5. Batch approval is explicit

T2 approves a list of suggestion IDs in one request, only after an explicit confirmation in the review screen that names how many entries will be approved. Jobs are rescored once after the batch, not once per fact.

### 6. Identity and target titles are proposed, never applied

Name, email and country found in the resume are shown apart from the facts and are applied only if the person chooses them; they never overwrite the profile silently. **The phone number is not imported** while the profile has no phone field ([#45](https://github.com/AldereteRuben/career-agent-stack/issues/45)).

The one to three most recent job titles are offered as optional **target titles**, shown separately and **unchecked by default**. They are added to the person's target titles only if checked, and never replace existing ones.

### 7. Professional summary and links are not imported yet

There are no profile fields for a professional summary or links. They are left out of the import rather than stored under a new fact kind, and will be mapped once [#45](https://github.com/AldereteRuben/career-agent-stack/issues/45) adds those fields. Certifications and languages already have fact kinds and can be imported; the profile form will offer them once [#26](https://github.com/AldereteRuben/career-agent-stack/issues/26) lands.

## Consequences

- T1 (batch import with `import_id` and the migration) and T2 (batch approval) can start. T3, T4 and T8 are open to contributors and can start in parallel with T1.
- T5 (review screen) waits for T1, T2 and T3. T6 (Codex) waits for T1 and T3 and follows the no-AI release.
- The review screen works from stored suggestions, so it survives a reload without keeping any draft in browser storage.
- Repeating an import requires selecting the file again. This is deliberate: the raw resume is never kept.

## Out of scope

OCR, DOCX, importing from LinkedIn (LinkedIn pages are never fetched: decision 007 in the [implementation brief](../implementation-brief.md)), keeping the original PDF, and inferring salary, work authorization or other answers the brief forbids inferring.
