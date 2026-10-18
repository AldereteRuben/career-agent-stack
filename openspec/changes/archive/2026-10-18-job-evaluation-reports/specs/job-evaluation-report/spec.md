# Spec Delta

## Purpose

Helps the person decide whether a job is worth applying to, from evidence they can check, without an AI account and without ever suggesting a hiring probability.

## ADDED Requirements

### Requirement: Every job has a report without any action
The job page SHALL show the job's evaluation report as soon as the job loads, computed locally from the job's latest description and the person's current approved facts and preferences. Building it SHALL NOT contact an assistant or any other service.

#### Scenario: Opening a saved job
- **WHEN** the person opens a job's page
- **THEN** the report appears with its conclusion and four parts, without the person requesting it

#### Scenario: No assistant account
- **WHEN** no Codex account is connected or assistant help is disabled
- **THEN** the report is still shown in full

### Requirement: Exactly three conclusions in words
The report SHALL conclude with exactly one of "Good option", "Worth reviewing" or "Probably not a fit" (Spanish: "Buena opción", "Conviene revisar", "Probablemente no encaja"), with the reasons for it. The report SHALL NOT show a score, a percentage or a probability.

#### Scenario: Well supported job
- **WHEN** a job's recognised requirements are mostly backed by approved facts, no required one is unconfirmed, its title matches a target role, its location matches the person's country and its work mode does not differ
- **THEN** the conclusion is "Good option"

#### Scenario: Unrelated job
- **WHEN** a job's title matches no target role and at most a third of its recognised requirements are backed
- **THEN** the conclusion is "Probably not a fit"

#### Scenario: Job without clear requirements
- **WHEN** a job has no description, or no recognised requirements, or the person has no approved facts
- **THEN** the conclusion is "Worth reviewing" with the reason "not enough information", never "Probably not a fit"

#### Scenario: Unclear location or different work mode
- **WHEN** an otherwise well supported job states a location whose compatibility is unclear, or a work mode different from the person's preference
- **THEN** the conclusion is "Worth reviewing" and the reason says what to confirm

### Requirement: Evidence comes only from approved facts and the posting
Each requirement in the report SHALL show the posting sentence that names it, when there is one, and the approved facts that mention it. Suggested and rejected facts SHALL NOT be used or shown. Requirements without approved facts SHALL be listed as not confirmed, with a way to add them to the profile.

#### Scenario: Suggested fact
- **WHEN** the only fact mentioning a required skill is suggested or rejected
- **THEN** that skill is listed as not confirmed and the fact does not appear in the report

### Requirement: Details to check and unknowns are explicit
The report SHALL show pay, work mode and location as stated, not stated, matching the person's preferences, differing from them, or to confirm, quoting the posting when it states them. It SHALL list what it cannot know, including work authorization, which is never inferred.

#### Scenario: Pay not mentioned
- **WHEN** the posting does not mention pay
- **THEN** pay is shown as "not stated" and "the job does not mention pay" is listed under what is not known

### Requirement: Assistant help stays separate and consented
The report SHALL link to the existing "Understand this job" request only when assistant help is available, and that request SHALL keep previewing what is shared before anything is sent. When the authorized account's last check found no signed-in session, the request SHALL say so instead of asking to connect an account.

#### Scenario: Authorized account signed out
- **WHEN** the person asks for a summary while their authorized Codex account was not signed in at the last check
- **THEN** the message asks them to check the account in Settings and says no new authorization is needed

### Requirement: Bilingual, keyboard and mobile
The report SHALL be available in Spanish and English, readable with a screen reader through headings, and fit a 390 px wide screen without horizontal scrolling.

#### Scenario: Phone width
- **WHEN** the job page is shown at 390 px wide
- **THEN** the report has no horizontal scroll
