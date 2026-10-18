# Spec Delta

## Purpose

Separately bounded and delivered as its own pull request: lets the person keep a follow-up email draft on an application to edit and copy. It never sends anything and uses no AI ([#115](https://github.com/AldereteRuben/career-agent-stack/issues/115)).

## ADDED Requirements

### Requirement: Draft stored on the application
The person SHALL be able to create, edit and delete one follow-up email draft per application, in one language chosen by the person, stored with the application in the workspace.

#### Scenario: Create and edit
- **WHEN** the person opens an application and writes a follow-up draft
- **THEN** it is saved on that application and can be edited later

### Requirement: Template from application facts only
The system MAY pre-fill a draft from the company, role, application date and the person's name using fixed Spanish and English templates. It SHALL NOT invent details and SHALL NOT use AI.

#### Scenario: Template
- **WHEN** the person chooses "Start from template" in English
- **THEN** the draft contains the company, role and date and fixed wording

### Requirement: Copy only, no sending
The interface SHALL offer copy to clipboard (and select-all for manual copy). The system SHALL NOT send email, open a mail account, read a mailbox or schedule anything, and copying SHALL NOT change the application state.

#### Scenario: Copy
- **WHEN** the person activates "Copy"
- **THEN** the text is copied, a status message is announced and nothing is sent

### Requirement: Lifecycle, isolation and accessibility
The draft SHALL be included in export, encrypted backup and restore and workspace deletion, SHALL be scoped to its workspace and application, and SHALL be bilingual, keyboard operable and usable at 390 px.

#### Scenario: Timing and migration order
- **WHEN** the follow-up draft work is scheduled
- **THEN** it may start once the base application-documents migration and the backup work are merged to `main`, needs only the base migration, the backup work and their dependencies (which include the staleness rules) rather than the remaining document phases, and its migration takes the next free number then

#### Scenario: Delete workspace
- **WHEN** a workspace is deleted
- **THEN** its follow-up drafts are removed; deleting a single application is not supported in this iteration
