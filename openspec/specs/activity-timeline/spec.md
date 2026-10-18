# activity-timeline Specification

## Purpose
Give people a chronological, workspace-scoped view of job-search activity in their own time zone, so they can remember when offers appeared, applications changed, interviews were scheduled and follow-ups became due.

## Requirements

### Requirement: Timeline returns dated workspace activity
For an inclusive range of at most 93 local calendar days, the API SHALL return dated jobs, applications, application status changes, recruitment stage changes, interviews and follow-ups belonging to the signed-in workspace. Each record SHALL use its stored timestamp or calendar date; the API SHALL NOT estimate dates from unrelated timestamps or include another workspace's records. Preparation runs, free-form notes and edits of follow-ups or interviews SHALL NOT appear as records.

#### Scenario: Person opens a month
- **WHEN** the person requests a month with their time zone
- **THEN** each record appears once on the viewer's local day of its instant, ordered by day with date-only follow-ups first and timed records by instant

#### Scenario: A job enters the workspace
- **WHEN** a job is added manually or found by automatic discovery
- **THEN** the timeline shows one record on its stored creation day and identifies whether discovery was automatic

#### Scenario: Record belongs to another workspace
- **WHEN** another workspace has records in the same range
- **THEN** none of them appear in the response

#### Scenario: Stage was corrected
- **WHEN** a recruitment stage change was recorded as a correction
- **THEN** the stage record is marked as a correction

#### Scenario: Request is invalid
- **WHEN** the range is reversed, longer than 93 days or not real dates, the time zone is not a valid IANA name, or the types are unknown or empty
- **THEN** the API rejects the request with `INVALID_INPUT`

### Requirement: Found-job records preserve their source
The timeline SHALL date a found-job record using `jobs.created_at`. It SHALL mark the record as automatic only when `jobs.discovered_at` is present.

#### Scenario: Job is manually imported
- **WHEN** a person adds a job directly
- **THEN** its timeline record uses its creation timestamp and is not marked as automatic discovery

#### Scenario: Job is found automatically
- **WHEN** discovery creates a job
- **THEN** its timeline record uses its creation timestamp and is marked as automatic discovery

### Requirement: Saved jobs are dated from the moment they are saved
The workspace SHALL record when a job becomes saved, keep that date while it stays saved and clear it when the decision changes. Only the job the person saved SHALL receive the date when duplicates share the decision. Jobs saved before dates were recorded SHALL stay undated and SHALL NOT appear on the timeline.

#### Scenario: Person saves a job
- **WHEN** the person saves a job that was not saved
- **THEN** the job records the save time and the timeline shows it on that day

#### Scenario: Job was saved before dates were recorded
- **WHEN** the person saves again a job that was already saved without a date
- **THEN** the job stays undated rather than being dated today

### Requirement: Follow-ups use the chosen calendar date and surface when overdue
Follow-ups SHALL appear on the calendar date the person chose regardless of time zone, and only for open applications. A follow-up SHALL be overdue when its date is before today in the viewer's time zone. The response SHALL list overdue follow-ups separately, whatever range is shown, with their total.

#### Scenario: Follow-up was missed in an earlier month
- **WHEN** an open application has a follow-up date before today and the person views a later month
- **THEN** the follow-up appears in the overdue list with its next step

#### Scenario: Application is closed
- **WHEN** an application is cancelled, rejected, withdrawn or hired
- **THEN** its follow-up does not appear and is never overdue

### Requirement: Timeline filters and page are bilingual and accessible
The dashboard SHALL offer a timeline page under Applications, in Spanish and English, with month navigation, a checkbox per record type, interview times in the viewer's zone plus the interview's own zone when different, and the overdue list. Controls SHALL be operable by keyboard and the page SHALL not overflow horizontally at phone width.

#### Scenario: Person filters by type
- **WHEN** the person clears the interviews checkbox from the keyboard
- **THEN** interviews disappear and the other types remain

#### Scenario: Person switches language
- **WHEN** the person switches between Spanish and English
- **THEN** labels, dates and times are shown in that language
