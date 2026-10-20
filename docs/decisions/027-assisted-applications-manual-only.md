# 027 — Greenhouse and Ashby applicant-side assistance

Status: proposed; requires maintainer approval. Date: 2026-10-19.

## Context

Issue [#43](https://github.com/AldereteRuben/career-agent-stack/issues/43) requested designs for Greenhouse and Ashby assistance, then a provider decision after comparing the designs and terms. ADRs [024](024-assisted-applications-greenhouse.md) and [025](025-assisted-applications-ashby.md) proposed visible-browser autofill, but neither establishes that the applicable terms permit a third-party candidate tool to automate an employer's application page.

## Evidence reviewed

| Provider | Official evidence | What it establishes | What remains unresolved |
| --- | --- | --- | --- |
| Greenhouse | [MyGreenhouse User Agreement](https://my.greenhouse.io/users/agreement) prohibits automated means to access or use the MyGreenhouse services. The [Job Board API guide](https://docs.greenhouse.io/job-board.html) describes application submission as an employer integration using an employer-side API key. | Do not use the employer write API or treat the employer's credentials as candidate credentials. | The MyGreenhouse agreement does not clearly establish whether the prohibition applies to local, user-initiated autofill on every employer-hosted application page. |
| Ashby | [Custom careers page guide](https://developers.ashbyhq.com/docs/creating-a-custom-careers-page) describes building and submitting application forms through an employer's careers-page integration. The [`applicationForm.submit` reference](https://developers.ashbyhq.com/reference/applicationformsubmit) requires `candidatesWrite`. Ashby also documents [application spam protection](https://docs.ashbyhq.com/job-board-setup). | Do not call the employer-facing submit API or request/store employer API keys. | The published material reviewed does not expressly permit or prohibit a separate local applicant tool from filling the hosted page. |

## Proposed decision

Keep Greenhouse and Ashby application assistance **manual-only** in Career Stack for now. Do not implement browser automation, DOM autofill, application API calls, uploads, or submission for either provider. The existing read-only job import remains separate from application assistance.

The reason is the missing permission boundary: Greenhouse's relevant agreement raises a concrete restriction, while the Ashby material reviewed is written for customer integrations and does not answer the applicant-tool question. Absence of an explicit prohibition is not treated as permission.

Reconsider an adapter only after the maintainer records provider-specific evidence that local applicant-side autofill is allowed for the exact page type and reviews the page's candidate notices. Any future adapter still needs a separate approved ADR, explicit `PII_TRANSFER` consent, an immutable one-use plan, fully manual completion of uploads and sensitive questions, synthetic fixtures, and a no-submit boundary. If permission cannot be confirmed, keep the manual flow.

This decision does not change or validate the existing experimental Lever adapter.

## Consequences

- The Greenhouse and Ashby proposals in ADRs 024 and 025 remain useful design records, but are not implementation authorization.
- Candidates can still use Career Stack's existing application preparation and tracking features, then complete employer forms themselves.
- No employer API credentials, application data, or test submissions are sent to either provider by this decision.
- Issue #43 can close when this manual-only policy is accepted; a future explicit provider permission can start a new scoped issue.

## Referenced issue

- [Issue #43](https://github.com/AldereteRuben/career-agent-stack/issues/43)
