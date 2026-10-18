# Proposal

## Why

People who already have a resume should not retype it (issue #23, ADR 018). The import API, batch approval, undo and in-browser PDF extraction are on `main`, but nothing turns a resume into entries a person can review, so imported experience cannot reach the profile or matching yet.

## What Changes

- Split resume text into Spanish and English sections without AI, read month-year date ranges, and propose editable entries for experience, education, skills, languages, certifications, projects, achievements and a professional summary (ADR 018, task T4). Ambiguous or missing dates are left for the person; unknown sections are listed as skipped.
- Add `/profile/import`: read a PDF or pasted text in the browser, preview the proposals with their resume excerpt and duplicate flags, and save only the ticked ones as unconfirmed `IMPORTED_SUGGESTION` facts. Identity and target-title proposals are optional and unticked (task T5).
- Review one import from its stored suggestions: confirm, correct, discard, confirm a ticked batch after an explicit confirmation, and undo the whole import. Confirmed entries rescore jobs once (tasks T5, T10 reuse).
- Link the import from the profile page and the profile setup guide (task T11), and document it (task T9).

Out of scope: the Codex-assisted import (task T6, deferred by ADR 018), OCR for scanned PDFs, DOCX, LinkedIn, storing the original PDF or its text, and importing phone numbers or addresses. No new API route, migration or AI operation is added. Versions, `RELEASE_VERSION` and the changelog are unchanged.

## Limits

- Parsing is heuristic: role/employer order is assumed to be "role, employer", two-column PDFs may interleave lines, and the person must check each entry before confirming it.
- A year without a month is never converted; such jobs are saved as plain text and the person completes the dates in the review screen.
- At most 100 entries per import and 4,000 characters per entry (3,500 for a job description); longer sections are split and marked.
- The excerpt shown next to each proposal exists only in the page's memory; stored suggestions do not keep it.

## Capabilities

### New Capabilities

- `resume-import`: In-browser resume parsing, preview and review of imported suggestions.

## Impact

`packages/domain` gains a pure parser (`resume-sections.ts`) and exports for CommonJS test loading. The dashboard gains the import page, its review logic and entry links. The API and database are unchanged; the browser end-to-end suite gains one scenario.
