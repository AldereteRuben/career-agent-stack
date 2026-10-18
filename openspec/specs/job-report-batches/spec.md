# job-report-batches Specification

## Purpose
Lets the person evaluate several saved jobs in one action, safely bounded, and compare the conclusions without losing any job from view.

## Requirements

### Requirement: Confirm how many jobs will be evaluated
From Saved jobs, the person SHALL choose jobs individually or all on the current page, and SHALL see how many jobs will be evaluated and confirm before anything starts. A batch SHALL hold between 1 and 50 jobs, each at most once.

#### Scenario: Confirmation
- **WHEN** the person selects four saved jobs and chooses to evaluate them
- **THEN** the page says four jobs will be evaluated and starts only after "Yes, evaluate"

#### Scenario: Too many jobs
- **WHEN** a request names more than 50 jobs, a job twice, or none
- **THEN** it is refused with `400 INVALID_INPUT` and no batch is created

### Requirement: Bounded, idempotent passes
A batch SHALL be evaluated in passes of at most five jobs. Each pass SHALL evaluate only jobs still pending, under a lock on the batch, so repeated or concurrent passes evaluate every job exactly once. A workspace SHALL have at most one running or paused batch. Creating a batch SHALL require an idempotency key: the same key with the same jobs returns the same batch, with different jobs it is refused.

#### Scenario: Concurrent passes
- **WHEN** several pass requests for the same batch arrive at once
- **THEN** every job is evaluated once and the batch completes

#### Scenario: Second batch while one is active
- **WHEN** a batch is running or paused and the person starts another
- **THEN** it is refused with `409 JOB_REPORT_BATCH_ACTIVE` naming the active batch

#### Scenario: Repeated creation
- **WHEN** the same creation request is sent twice with the same idempotency key
- **THEN** one batch exists and both responses describe it

### Requirement: Pause, continue and cancel without losing work
The person SHALL be able to pause a running batch, continue a paused one, and cancel either. Jobs already evaluated SHALL be kept; cancelling SHALL mark the remaining jobs as not evaluated. Repeating an action SHALL change nothing, and a finished batch SHALL NOT be resumed or paused.

#### Scenario: Pause
- **WHEN** the person pauses a batch
- **THEN** no further job is evaluated until they continue, and evaluated jobs stay listed

#### Scenario: Cancel
- **WHEN** the person cancels a batch after five of seven jobs were evaluated
- **THEN** the five keep their conclusions and the two others show "not evaluated: you cancelled the evaluation"

### Requirement: Failures are per job and explained
A job that no longer exists in the workspace SHALL fail with "the job no longer exists", an archived job SHALL be skipped with "the job is archived", and a report that cannot be built SHALL fail that job only; the batch SHALL continue with the rest. Jobs of another workspace SHALL be treated as not existing and SHALL NOT reveal their labels.

#### Scenario: Batch with valid, failing and archived jobs
- **WHEN** a batch holds three valid saved jobs, a job that no longer exists and a job archived after it was selected
- **THEN** the three are evaluated, the missing one fails and the archived one is skipped, each with its explanation

### Requirement: Results sorted without hiding jobs
Batch results SHALL list every job: evaluated jobs by conclusion ("Good option", then "Worth reviewing", then "Probably not a fit"), then failed jobs, then skipped jobs, then jobs still waiting, keeping the person's order within each group.

#### Scenario: Finished batch
- **WHEN** a batch finishes
- **THEN** the results show the good options first and the failed and skipped jobs last, all with links to their pages when they still exist

### Requirement: No assistant and bilingual interface
Batches SHALL NOT send any data to Codex or another provider. The evaluation panel SHALL be available in Spanish and English, operable with the keyboard, and fit a 390 px wide screen without horizontal scrolling.

#### Scenario: Keyboard selection
- **WHEN** the person moves to a job's "Evaluate" checkbox with Tab and presses Space
- **THEN** the job is selected and the count to evaluate updates
