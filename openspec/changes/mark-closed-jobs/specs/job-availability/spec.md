# Spec Delta

## Purpose

Keeps each job's availability honest: derived conservatively from complete reads of its sources, decided by the person when they know better, recorded in a history, and never allowed to change an application.

## ADDED Requirements

### Requirement: Only complete reads give absence evidence
A job's absence from a source SHALL count only when that source's read was complete: a followed company board refresh with complete coverage, or a newly downloaded complete Remotive or Arbeitnow public feed. Partial, bounded, cached, stale and failed reads, and every Himalayas read, SHALL NOT count as absence.

#### Scenario: Complete board refresh without the job
- **WHEN** a followed company board refresh completes with complete coverage and a job previously read from that board is not in it
- **THEN** that job's absence count for that board increases by one

#### Scenario: Partial board refresh
- **WHEN** a board refresh completes with partial coverage and a known job is not in it
- **THEN** that job's absence count does not change

#### Scenario: Failed read
- **WHEN** a board refresh or a provider feed download fails, times out or returns an HTTP error
- **THEN** no job's absence count changes and no job's availability changes

#### Scenario: Bounded or cached provider feed
- **WHEN** an Arbeitnow feed stops at the page limit, or a Remotive or Arbeitnow feed is served from cache instead of downloaded
- **THEN** no job's absence count changes

#### Scenario: Himalayas query results
- **WHEN** a Himalayas search no longer returns a job it returned before
- **THEN** that job's absence count does not change

### Requirement: Suspicious complete reads give no absence evidence
A complete read SHALL NOT count as absence when it lists no jobs while the previous complete read of the same source listed some, or when it lists fewer than half as many jobs as that previous complete read. Jobs it does list still count as seen.

#### Scenario: Board suddenly empty
- **WHEN** a board whose previous complete refresh listed 40 jobs completes a refresh that lists 0
- **THEN** no job's absence count changes for that board

#### Scenario: Feed shrinks by more than half
- **WHEN** a Remotive feed whose previous complete download listed 1,000 jobs is downloaded complete with 300
- **THEN** no absence count changes, and the 300 listed jobs count as seen

### Requirement: Only fresh, successful reads give presence evidence
A job SHALL count as seen by a source, resetting that source's absence count to zero, only when it is listed in a read made now in which every page read succeeded: a complete board refresh, a newly downloaded complete Remotive or Arbeitnow feed, or a newly downloaded Himalayas result. Partial refreshes, bounded, cached, stale and failed reads SHALL NOT count as presence.

#### Scenario: Job listed in a complete refresh
- **WHEN** a job with an absence count of 2 on a board is listed in a complete refresh of that board
- **THEN** its absence count for that board becomes 0

#### Scenario: Job listed in a partial refresh
- **WHEN** a job with an absence count of 2 on a board is listed in a partial refresh of that board
- **THEN** its absence count and availability do not change

#### Scenario: Job listed in a cached feed
- **WHEN** a `POSSIBLY_CLOSED` job is listed in a Remotive feed served from cache
- **THEN** its availability stays `POSSIBLY_CLOSED`

#### Scenario: Job seen by Himalayas
- **WHEN** a newly downloaded Himalayas result lists a job
- **THEN** the job counts as seen by that source

### Requirement: A shared feed updates every workspace
A Remotive or Arbeitnow feed is public and shared by every saved search. A newly downloaded complete feed SHALL update the matching sources of every workspace in the installation, and each workspace's jobs SHALL be re-evaluated and recorded separately.

#### Scenario: Two workspaces know the same job
- **WHEN** two workspaces each matched the same Remotive job and it is missing from 3 complete Remotive downloads over 48 hours
- **THEN** each workspace's job becomes `POSSIBLY_CLOSED`, with one history entry in each workspace, and no entry in either refers to the other

### Requirement: Jobs become possibly closed by a stated rule
A job SHALL become `POSSIBLY_CLOSED` only when every source able to give absence evidence for it has an absence count of at least 3 and at least 48 hours have passed since any source last saw it. Jobs whose sources cannot give absence evidence (manual imports, Himalayas only) SHALL keep their availability.

#### Scenario: Three complete misses over two days
- **WHEN** a job from one board has been missing from 3 consecutive complete refreshes and was last seen 50 hours ago
- **THEN** its availability becomes `POSSIBLY_CLOSED`

#### Scenario: Three misses within a day
- **WHEN** a job has been missing from 3 consecutive complete refreshes but was last seen 20 hours ago
- **THEN** its availability stays `OPEN`

#### Scenario: Job shared across sources
- **WHEN** a job is known from a board and from the Remotive feed, the board has missed it 3 times over 2 days, and the latest complete Remotive feed still includes it
- **THEN** its availability stays `OPEN`

#### Scenario: Job shared across saved searches
- **WHEN** two saved searches matched the same Remotive job and it is missing from 3 complete Remotive feeds over 2 days
- **THEN** the job becomes `POSSIBLY_CLOSED` once, with one history entry

#### Scenario: Manual job
- **WHEN** a job was imported by hand and no source has read it
- **THEN** its availability stays `UNKNOWN`

### Requirement: Reappearing jobs reopen automatically
A `POSSIBLY_CLOSED` job SHALL become `OPEN` again as soon as a source counts it as seen under the presence requirement (a fresh read in which every page succeeded), unless the person marked it closed. Partial refreshes and cached feeds SHALL NOT reopen it.

#### Scenario: Job reappears on its board
- **WHEN** a `POSSIBLY_CLOSED` job is listed again in a complete refresh of its board
- **THEN** its availability becomes `OPEN`

### Requirement: The person can close and reopen a job
The person SHALL be able to mark any job closed, and to reopen a closed or possibly closed job. A job the person closed SHALL stay `CLOSED` whatever sources report, until the person reopens it. Reopening SHALL reset every absence count for that job.

#### Scenario: Close a job the board still lists
- **WHEN** the person marks a job closed and a later complete board refresh still lists it
- **THEN** the job stays `CLOSED` and its page says that a source still lists it

#### Scenario: Reopen a possibly closed job
- **WHEN** the person reopens a `POSSIBLY_CLOSED` job
- **THEN** its availability becomes `OPEN` and it becomes `POSSIBLY_CLOSED` again only after 3 new complete misses, with at least 48 hours since any source last saw it

#### Scenario: Stale request
- **WHEN** the person submits a close or reopen action for a job whose availability changed since the page was loaded
- **THEN** the request is refused with a conflict and the page shows the current availability

### Requirement: Every availability change is recorded
Every change of a job's availability SHALL be recorded with its time, its previous and new state, and its reason: absent from complete reads, seen again, closed by the person, or reopened by the person. The record SHALL hold no job content beyond the job reference.

#### Scenario: History on the job page
- **WHEN** a job became `POSSIBLY_CLOSED`, then `OPEN` when it reappeared, then `CLOSED` by the person
- **THEN** the job page lists those three changes in order with their reasons, in Spanish and English

### Requirement: Availability never changes applications
A job's availability SHALL NOT cancel, submit, change or block an application. Person-initiated preparation for a job that is not `OPEN` SHALL show a warning and remain possible. Automatic preparation SHALL only attempt jobs whose availability is `OPEN`; it SHALL skip `POSSIBLY_CLOSED`, `CLOSED`, and `UNKNOWN` jobs without recording a failed attempt.

#### Scenario: Job closes after an application was submitted
- **WHEN** a job with a submitted application becomes `POSSIBLY_CLOSED` or `CLOSED`
- **THEN** the application's state and recruitment stage are unchanged, and My applications shows the job's availability next to it

#### Scenario: Preparing an application for a closed job
- **WHEN** the person starts preparing an application for a `CLOSED` job
- **THEN** a warning explains that the job may no longer accept applications, and the person can continue

#### Scenario: Automatic preparation skips jobs that are not open
- **WHEN** an opted-in saved search has a matched job whose availability is `POSSIBLY_CLOSED`, `CLOSED`, or `UNKNOWN`
- **THEN** automatic preparation does not attempt it or record a failed attempt, while a person can still prepare it manually with a warning

### Requirement: Availability is shown clearly and accessibly
The job page, job lists and My applications SHALL show each job's availability in text, not color alone, in Spanish and English, usable with a keyboard and on a phone-sized screen. The Availability filter SHALL return jobs in every state.

#### Scenario: Filter by possibly closed
- **WHEN** the person filters jobs by `POSSIBLY_CLOSED` and such jobs exist
- **THEN** the list shows exactly those jobs

#### Scenario: Phone-sized screen
- **WHEN** the job page of a `CLOSED` job is shown at 390 px width
- **THEN** the availability, its reason and the reopen action are visible without horizontal scrolling and reachable with the keyboard
