# 024 — Greenhouse hosted-form assistance

Status: proposed; implementation deferred under [ADR 027](027-assisted-applications-manual-only.md) pending maintainer approval and provider-specific terms review. Date: 2026-10-18.

## Context

Issue [#43](https://github.com/AldereteRuben/career-agent-stack/issues/43) asks for Greenhouse assistance alongside the existing experimental Lever adapter. Greenhouse's public Job Board API exposes job and form data, but its application POST uses an employer-side Job Board API key. Greenhouse says that key is secret, must be proxied by a server, and recommends its hosted/embedded application form because custom forms must reproduce required-field validation and spam protection.

This app is a local candidate tool, not an employer's recruiting integration. It must not ask a candidate to obtain or store an employer API key, call Harvest/Job Board write APIs, infer consent, or submit an application.

## Proposed decision

Add a **visible-browser autofill adapter for standard Greenhouse-hosted forms only**, following the boundaries in [ADR 015](015-assisted-applications.md). Do not call Greenhouse write APIs. The adapter may fill only uniquely identified, visible, editable contact fields that the person has reviewed in the immutable application plan: first name, last name and email; phone and current organization are optional. It never clicks Submit.

The initial supported URL set is limited to canonical HTTPS Greenhouse-hosted job application pages on an explicitly allow-listed Greenhouse origin and standard job path. The implementation must define and test the exact host/path allow-list before enabling the adapter; customer-branded sites, arbitrary redirects, embedded cross-origin forms, internal boards, and URLs with ambiguous job identifiers remain manual-only.

Before changing the page, preflight the full visible form. If a required field is missing, duplicated, hidden, disabled, custom, or not safely recognized, do not fill any field. Keep location, resume/cover-letter uploads, custom questions, data-compliance consent, demographic/equal-opportunity questions, CAPTCHA, and all other fields manual. Never infer an answer from a CV or profile. A person reviews the displayed company, role, origin and exact contact values, then grants the existing one-use authorization. The ephemeral browser is visible; network is blocked during autofill and review; handoff resumes the same window for the person to finish uploads, answer questions, read employer notices and submit. Opening the employer site itself can reveal network metadata and must be explained before consent.

Keep the existing separate, revision-bound `PII_TRANSFER` approval, immutable plan, one-use grant, no automatic retry for unknown outcomes, and explicit user reconciliation. An HTTP response, redirect, tab close or page title never confirms submission.

## Synthetic verification

Add synthetic Greenhouse-like forms for recognized contact fields, duplicated/unknown required fields, hidden/disabled fields, custom questions, legal/data-compliance questions, file uploads, CAPTCHA, redirects, popups and network requests. Assert that unsupported required fields cause zero field writes and that the adapter never clicks Submit. Do not submit tests to a real employer or use real candidate data.

Before coding, record an exact allow-list and review Greenhouse terms/policies for this candidate-side automation. No provider terms review or real-employer submission validation is claimed by this proposal.

## Consequences

- No employer API key or employer-side account permission is needed by the candidate tool.
- The app assists with a small, reviewable set of fields and leaves employer-specific and sensitive answers to the person.
- The hosted form may change or use dynamic controls; unsupported changes fall back to manual completion.
- This does not establish that any live employer form is compatible or authorize automated submission.

## References

- [Greenhouse Job Board API: authentication and application submission](https://docs.greenhouse.io/job-board.html)
- [Greenhouse API overview](https://support.greenhouse.io/hc/en-us/articles/10568627186203-Greenhouse-API-overview)
- [ADR 015 — Assisted applications](015-assisted-applications.md)
- [Issue #43](https://github.com/AldereteRuben/career-agent-stack/issues/43)
