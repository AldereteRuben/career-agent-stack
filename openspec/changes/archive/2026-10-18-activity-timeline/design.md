# Design

## Sources of each record

| Type | Source | Day |
| --- | --- | --- |
| `JOB_FOUND` | `jobs.created_at`; `automatic` is true only when `jobs.discovered_at` is present | Viewer's local day of the instant |
| `JOB_SAVED` | `jobs.saved_at` of jobs still saved | Viewer's local day of the instant |
| `APPLICATION_CREATED` | `applications.created_at` (same source as the overview calendar) | Viewer's local day |
| `APPLICATION_STATUS_CHANGED` | `application_events` of type `APPLICATION_STATE_CHANGED`, `ASSIST_SUBMISSION_CONFIRMED`, `ASSIST_SUBMISSION_UNKNOWN`, `ASSIST_USER_RECONCILED` whose new state differs from the prior one | Viewer's local day |
| `STAGE_CHANGED` | `application_events` of type `RECRUITMENT_STAGE_CHANGED` or `RECRUITMENT_STAGE_CORRECTED` (flagged `correction`) | Viewer's local day |
| `INTERVIEW` | `applications.interview_at`, with `interview_timezone` | Viewer's local day; the page also shows the interview's own zone when it differs |
| `FOLLOW_UP` | `applications.follow_up_date` of open applications | The stored calendar date, never shifted by a time zone |

Preparation runs, follow-up and interview edit events and free-form notes are history, not milestones, and are excluded. Every query filters by `workspace_id`; event rows join applications on both workspace and application id.

## Saved date

No save time existed: `updated_at` changes for unrelated reasons, so using it would invent dates. `jobs.saved_at` is set to `now()` only when a job that was not saved becomes saved, kept while it stays saved, and cleared when the decision changes. Strong-identity duplicates share the decision but only the job the person acted on gets the date, so one save is one record. Existing saved jobs keep a null date.

## Time zones and overdue

The client sends its IANA zone, validated by `resolveTimeZone`, which now also rejects bare offsets such as `+05`: `Intl` reads them as UTC+5 while PostgreSQL reads them as UTC-5, so days and today would disagree. Instants are compared against UTC bounds padded by a day on each side and then filtered by their local day, as `/activity` does. Today is computed in the viewer's zone; a follow-up is overdue when its date is before today and its application is open (not cancelled and not rejected, withdrawn or hired), matching the tracker. Overdue follow-ups are returned separately, capped at 50 with a total, so a missed one is visible from any month.

## Limits

Ranges are at most 93 days and responses at most 500 items with a `truncated` flag; filtering by type shows the rest. Unknown types, empty type lists, reversed or oversized ranges and invalid zones are rejected with `INVALID_INPUT`.

## Navigation

The timeline lives under Applications (breadcrumb Applications › Timeline) so the main menu keeps its four destinations, which the browser suite asserts.
