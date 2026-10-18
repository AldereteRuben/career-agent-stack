# 025 — Ashby hosted-form assistance

Status: proposed; implement only after maintainer approval and provider-specific terms review. Date: 2026-10-18.

## Context

Issue [#43](https://github.com/AldereteRuben/career-agent-stack/issues/43) asks for Ashby assistance alongside the existing experimental Lever adapter. Ashby documents a custom careers-page flow: retrieve job postings and their form specifications, then send completed forms through `applicationForm.submit`. The API reference labels that endpoint as requiring `candidatesWrite`, while the custom-careers guide's sample request omits an authorization header; that permission detail needs clarification before an API-based design could be considered. Ashby's general API uses long-lived keys for most endpoints, scopes keys by endpoint permissions, and warns that keys should not be used in browsers. This app must not collect an employer's API key or create a recruiting-system integration on an applicant's behalf.

## Proposed decision

Add a **visible-browser autofill adapter for standard Ashby-hosted application pages only**, following the boundaries in [ADR 015](015-assisted-applications.md). Do not call Ashby's candidate or application write APIs. The adapter may fill only uniquely identified, visible, editable contact fields that the person has reviewed in the immutable application plan: name and email; phone is optional. It never clicks Submit.

The initial supported URL set is limited to canonical HTTPS Ashby-hosted job pages on an explicitly allow-listed Ashby origin and standard job path. The implementation must define and test the exact host/path allow-list before enabling the adapter; customer-branded sites, arbitrary redirects, embedded cross-origin forms and URLs with ambiguous job identifiers remain manual-only.

Before changing the page, preflight the full visible form. If a required field is missing, duplicated, hidden, disabled, custom, or not safely recognized, do not fill any field. Keep resume/cover-letter uploads, custom fields, legal or data-compliance consent, demographic/equal-opportunity questions, CAPTCHA and all other fields manual. Never infer answers from a CV or profile. The person reviews the displayed company, role, origin and exact contact values, then grants the existing one-use authorization. The ephemeral browser is visible; network is blocked during autofill and review; handoff resumes the same window for the person to finish uploads, answer questions, read employer notices and submit. Opening the employer site itself can reveal network metadata and must be explained before consent.

Keep the existing separate, revision-bound `PII_TRANSFER` approval, immutable plan, one-use grant, no automatic retry for unknown outcomes, and explicit user reconciliation. An HTTP response, redirect, tab close or page title never confirms submission.

## Synthetic verification

Add synthetic Ashby-like forms for recognized contact fields, duplicated/unknown required fields, hidden/disabled fields, custom fields, legal/data-compliance questions, file uploads, CAPTCHA, redirects, popups and network requests. Assert that unsupported required fields cause zero field writes and that the adapter never clicks Submit. Do not submit tests to a real employer or use real candidate data.

Before coding, record an exact allow-list and review Ashby terms/policies for this candidate-side automation. No provider terms review or real-employer submission validation is claimed by this proposal.

## Consequences

- No employer API key or employer-side account permission is needed by the candidate tool.
- The app assists with a small, reviewable set of fields and leaves employer-specific and sensitive answers to the person.
- The hosted form may change or use dynamic controls; unsupported changes fall back to manual completion.
- This does not establish that any live employer form is compatible or authorize automated submission.

## References

- [Ashby API: authentication](https://developers.ashbyhq.com/reference/authentication)
- [Ashby API: applicationForm.submit](https://developers.ashbyhq.com/reference/applicationformsubmit)
- [Ashby: creating a custom careers page](https://developers.ashbyhq.com/docs/creating-a-custom-careers-page)
- [ADR 015 — Assisted applications](015-assisted-applications.md)
- [Issue #43](https://github.com/AldereteRuben/career-agent-stack/issues/43)
