# Changelog

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
