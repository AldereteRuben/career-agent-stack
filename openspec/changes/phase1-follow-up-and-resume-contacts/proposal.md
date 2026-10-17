# Proposal

## Why

Tracked applications need a clear next action and interview time that remains correct across time zones. Resume headers also need optional contact details chosen for each PDF, while keeping those details private from AI providers and requiring the person to approve any professional summary.

## What Changes

- Add a next step, calendar follow-up date, and interview time with an explicit IANA time zone to tracked applications; retain changes in the activity history and make due follow-ups easy to find.
- Let people maintain optional phone, city, and up to four HTTPS profile links, and choose which available contact fields appear in each resume.
- Support a professional-summary fact through the existing approval and review flow. Do not include contact fields in AI requests.

Out of scope: sending applications or reminders, calendar synchronization or `.ics` export, inferring contact details, or changing package versions, `RELEASE_VERSION`, or the changelog. Application submission remains a manual action.

## Capabilities

### New Capabilities

- `resume-profile`: Optional resume contact details and per-document contact selection.

### Modified Capabilities

- `application-tracking`: Next steps, due dates, and time-zone-aware interview scheduling.

## Impact

The dashboard profile, document builder, AI-assisted resume review, application tracker, API contracts, domain validation, document readiness, and database schema are affected. One additive database migration persists contact selections and application dates. No contact details are sent to AI providers.
