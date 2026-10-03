# Changelog

## 0.4.1

Usability improvements in Spanish and English.

- Guided sign-in with a masked access-code field and a macOS recovery launcher that creates and copies a new one-time code. Existing sessions and workspace data are preserved.
- Consistent job/application terminology, clearer empty states and manual job entry instructions.
- Resume prerequisites appear before the builder; name, email and confirmed experience are required in the UI. Country is optional for resume preparation.
- Opening a PDF moves keyboard focus to the preview; closing it restores focus. Cancelling profile edits returns focus to saved entries.
- Company forms preserve drafts in the current tab, explain the two required links and clearly state that job refreshes are manual.
- Settings distinguishes recovery backups from JSON data exports and puts technical capability details behind an expandable section.
- A shared release constant supplies the API and dashboard version.
- Updated shared branding, aligned profile controls and select arrows, full-width prepare/saved-resume views, compact saved resume actions and aligned company panels.
- Generic installation wording with operating-system-specific shortcuts clearly labelled.

Validation on macOS: production build, TypeScript, ESLint, 108 unit/integration/synthetic-browser checks, all 17 E2E scenarios (run 91c30fb02eb3), and a clean-install smoke including isolated access-code recovery. The ES/EN layout and focus scenario includes 1096px desktop and 390px mobile captures. GitHub CI passed Linux quality checks and Windows/Linux build plus domain-test jobs (run 37123530516). Backup restoration still requires a terminal. Native Windows startup/shutdown is not supported by the Unix-based launcher; Windows/Linux CI covers build and domain tests, not full installation. No live workspace credentials were reset.

## 0.4.0

A connected profile-to-application workflow. See [verification and limitations](docs/releases/v0.4.0.md).

### Added

- Structured work experience and education with editable dates and current-position/study fields. Canonical older employment entries can be edited as fields; ambiguous text is preserved.
- Profile → Resume → Application navigation preserves the job. Approved resumes can be linked to an application and remain selected for assisted preparation. Repeated continuation reuses the existing open application.
- English/Spanish PDF language selection and zoom controls with scrolling contained within the preview.
- Job title/company search, favorites and availability filters, reversible archiving, and pagination with URL-persisted filters.
- Additive database migration for entry metadata and application-resume links, with upgrade regression coverage.

### Preserved

- Earlier profile text, PDF bytes and application history remain intact. Resume changes are blocked for submitted/closed applications and active assisted attempts.
- Employer submission remains manual. Public-repository preparation and dependency alert follow-ups remain deferred.

## 0.3.1

Profile, resume and draft reliability fixes. See [verification and limitations](docs/releases/v0.3.1.md).

### Fixed

- Resume reuse resolves unchanged copies of facts across profile revisions, including existing data. Edited or archived content is excluded with actionable feedback.
- Editing a profile entry creates a new revision requiring confirmation; earlier PDF content stays intact. Entries can be archived and restored.
- Assisted application options expose only currently usable approved resumes, with a route to regenerate outdated versions. Server checks remain authoritative.
- Job imports, manual application forms and per-application notes survive navigation and reloads in the same tab. Explicit sign-out clears their session drafts; failed saves retain them.
- Job search distinguishes no matches, no saved jobs, loading and request failure, and ignores stale search responses.

### Improved

- Clearer EN/ES navigation, home guidance, profile sections and work-experience date inputs.
- Local PDF preview, readable one-column resume layout and explicit review-state guidance; no draft watermark in generated PDFs.
- Release labels, startup READMEs and third-party notices updated.

## 0.3.0

Assisted applications with explicit consent and manual submission. See [verification and limitations](docs/releases/v0.3.0.md).

### Added

- Experimental contact-field autofill for hosted Lever forms in a visible local browser.
- One-use, expiring consent bound to the destination, profile, selected resume and application version.
- Same-window review and explicit manual handoff; files, custom questions, legal consents, CAPTCHA and submission remain manual.
- Durable attempt history and explicit reconciliation of unknown outcomes; no automatic resubmission.
- Session/restart/restore invalidation, bilingual guidance and synthetic browser/database/UI regression coverage.
- Noncommercial license, personal job-search permission and contribution templates included in this tagged release.

### Limits

- No real employer submission was performed in validation. Lever support is experimental and has no universal-compatibility promise.
- Public-repository preparation and dependency alert follow-ups remain deferred; visibility remains private.

## 0.2.0

Local reliability and recovery release. See the [release verification notes](docs/releases/v0.2.0.md) for the checks performed and platform limits.

### Added

- Coordinated database and document backups with integrity manifests and isolated restoration.
- Repeatable clean-install verification and clearer setup recovery messages.
- Deterministic source-adapter regression tests and an opt-in real-feed validation command.
- Export progress, retryable errors, and browser verification of downloaded JSON.

### Improved

- Bounded streaming reads and validation of external job feeds.
- Job descriptions preserve paragraph breaks and provider-specific requirements sections.
- Partial feed results are identified in the interface.
- Release labels and user guidance in English and Spanish.

## 0.1.0

Initial local workspace: bilingual dashboard, approved profile facts, scoped answers, manually saved and discovered jobs, explainable matching, versioned PDF drafts, application history, and JSON export.
