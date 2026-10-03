# 015 — Assisted applications, visible browser and manual submission

Status: implemented in v0.3.0. Date: 2026-10-03.

## Decision

The first adapter targets the **hosted Lever form**, using canonical HTTPS URLs on `jobs.lever.co` and `jobs.eu.lever.co`. It fills recognized name and email inputs, plus optional phone and current organization. It does not use an employer API key, upload a file, select legal/demographic answers, solve CAPTCHA, click Submit, or infer successful submission.

The user selects a reviewed PDF and sees its name, destination and exact contact values before granting one-use authorization. The PDF is verified locally and downloaded for manual attachment. An ephemeral, visible Chromium context opens the employer page. During filling and review its network requests are blocked. A separate user confirmation enables manual interaction in the **same window**. The person completes the remaining fields, uploads the PDF, handles challenges and submits.

## Durable records and reconciliation

`assisted_attempts` records the application, immutable plan, SHA-256 digest, profile revision, PDF digest, expiry, consent timestamp, state and outcome. A partial unique index permits only one unresolved attempt per application. It is not a stored browser session. No cookies, trace, screenshot or employer response body is saved.

```text
PREPARED → STARTING → REVIEW / HANDOFF_REQUIRED → HANDED_OFF
                           ↓                         ↓
                           └──────── UNKNOWN ────────┘
                                       ↓ explicit user attestation
                            CONFIRMED / NOT_SUBMITTED
```

PREPARED can be cancelled or invalidated. Starting failures are recorded as FAILED. Grants expire after ten minutes and cannot be reused. Profile/document/application changes prevent starting or handing off stale data. PostgreSQL locks coordinate this check with profile edits; browser startup holds the relevant locks for its bounded operation.

An unknown outcome prevents another attempt until the person checks the employer page or email and explicitly records the result. Closing the browser is not evidence of submission or non-submission. Confirmed is always a **user attestation**, never inferred from an HTTP 200, a closed tab or a page title. Restart and restore invalidate unused grants and move interrupted attempts to UNKNOWN; nothing is automatically resumed.

## Boundary and limitations

The adapter preflights unique, visible, editable input fields and refuses an unfamiliar required-field structure before filling anything. Optional/unrecognized fields stay manual. Main-frame redirects while loading, other navigation during review, popups, service workers and WebSockets are blocked. Browser traffic is restricted to the selected Lever origin and hCaptcha origins; these are request controls, not a general browser exploit or OS sandbox. A network request already admitted during initial loading may complete later. Only the standard hosted form is in scope; custom company sites, OAuth, embedded ATS forms and other providers are manual-only.

The connection is intentionally paused during review. After handoff, the employer site can autosave or process uploaded data before final submission; the interface says so. CAPTCHA or third-party assets may need manual intervention or a reload; reloading can discard filled values. The adapter cannot promise future compatibility with every Lever tenant or prevent a person from submitting in another browser. It must not be advertised as universal autofill or guaranteed duplicate prevention across external systems.

The implementation was checked against a public Lever demo form by read-only retrieval, and exercised with synthetic forms and disposable databases. No real application was submitted as a test. Field support is experimental; a real employer submission has not been validated end to end.

## References

- [Lever postings documentation](https://github.com/lever/postings-api): hosted application URLs and separate authenticated employer submission APIs.
- [Playwright routing](https://playwright.dev/docs/api/class-browsercontext#browser-context-route): request interception; service workers require explicit blocking.
- [Operating the feature](../operations/assisted-applications.md).
