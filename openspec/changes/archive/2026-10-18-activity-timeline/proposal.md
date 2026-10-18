# Proposal

## Why

The overview calendar only counts jobs found and applications created per day. People also need to see, by date, the jobs they saved, the status and stage changes of their applications, their interviews and their follow-ups, and to notice follow-ups they missed. Everything shown must come from dates the workspace actually stores.

## What Changes

- Add `GET /api/v1/timeline` for an inclusive range of local calendar days (at most 93), the viewer's IANA time zone and an optional set of record types. It reports jobs found (distinguishing automatic discovery from manual addition), saved jobs, created applications, application status changes, recruitment stage changes (marking corrections), interviews and follow-ups, scoped to the signed-in workspace.
- Report overdue follow-ups of open applications in a separate list whatever range is shown, using today in the viewer's time zone.
- Record when a job is saved (`jobs.saved_at`) from now on. Jobs saved earlier stay undated and do not appear; the saved date is never estimated from other timestamps.
- Add a bilingual, keyboard- and mobile-usable timeline page under Applications, with month navigation, type filters and an overdue follow-up list, linked from Applications and the overview activity calendar.

Out of scope: calendar synchronization or `.ics` export, reminders or notifications, marking a follow-up as done (the person changes or clears the date), backfilling save dates for jobs saved before this change, free-form notes or preparation runs as timeline records, rescheduled interview slots (only the current interview is shown), and any change to versions, `RELEASE_VERSION` or the changelog.

## Capabilities

### New Capabilities

- `activity-timeline`: Dated, workspace-scoped timeline of saved jobs, applications, status and stage changes, interviews and follow-ups.

### Modified Capabilities

None. Follow-up dates and interview times keep the fields and rules from `phase1-follow-up-and-resume-contacts` (issue #44).

## Impact

API (new route and saved-date recording in the job decision), database (one additive migration: `jobs.saved_at` and three indexes), dashboard (new page, navigation routing, links), tests (unit, disposable-database integration, isolated browser scenario) and CI (one disposable-database step). Remaining limits: a follow-up stays overdue until its date is changed or cleared, and pre-existing saved jobs have no date.
