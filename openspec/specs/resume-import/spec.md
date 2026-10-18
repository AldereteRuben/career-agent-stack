# resume-import Specification

## Purpose
Let people turn an existing resume into reviewable profile suggestions while keeping the resume and its text in the browser and requiring explicit approval before any imported fact affects matching.

## Requirements

### Requirement: Resume text stays in the browser
The resume PDF and its extracted or pasted text SHALL be processed only in the browser's memory. They SHALL NOT be sent to the API, an AI provider, browser storage or logs. Only the entries the person ticks SHALL be sent, as profile facts.

#### Scenario: Person imports a PDF
- **WHEN** the person selects a resume PDF on the import page
- **THEN** no request carries the PDF or text outside the ticked entries, and browser storage holds nothing from the resume

### Requirement: Proposals are source-backed and never guessed
The parser SHALL propose entries only from recognised Spanish or English section headings and SHALL show each proposal with the exact resume lines it came from. A date SHALL become a month only when its month and year are written; otherwise the original text SHALL be kept and the entry flagged for the person to complete. Unrecognised sections SHALL be reported as skipped.

#### Scenario: A job has only years
- **WHEN** a job line reads "2018 - 2021"
- **THEN** the proposal has no start or end month, keeps "2018 - 2021" as text, and is flagged "Dates to complete"

#### Scenario: A resume has no recognised headings
- **WHEN** the text contains no known section heading
- **THEN** no entries are proposed and the page explains how to continue

### Requirement: Imported entries require explicit confirmation
Saved proposals SHALL be stored as `SUGGESTED` facts with source `IMPORTED_SUGGESTION` and one import identifier. They SHALL NOT affect matching or resumes until confirmed one by one or in a batch whose size the person confirms explicitly. A confirmed batch SHALL rescore jobs once.

#### Scenario: Person confirms a batch
- **WHEN** the person ticks entries and confirms "Yes, confirm N"
- **THEN** exactly those entries become approved and job evidence coverage reflects them

### Requirement: Duplicates are flagged, not dropped
A proposal or stored suggestion that repeats an active profile entry (same kind and statement ignoring case and spacing) SHALL be flagged and left unticked by default.

#### Scenario: Resume repeats an approved entry
- **WHEN** a proposal matches an approved fact
- **THEN** it shows "Already in your profile" and is not selected for saving

### Requirement: Review survives a reload and can be undone
The review screen SHALL work from stored suggestions of one import, allow correcting, discarding and confirming each entry, and undo the whole import after showing how many entries will be discarded or archived. Nothing SHALL be deleted.

#### Scenario: Person undoes an import
- **WHEN** the person confirms undoing an import with confirmed entries
- **THEN** pending entries are discarded, confirmed entries are archived, and jobs are rescored
