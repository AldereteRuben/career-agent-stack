# interview-preparation Specification

## Purpose
Help a person prepare for an interview from one specific application, with a useful no-AI path, transparent evidence, and optional assistant requests that remain under the person's control.

## Requirements

### Requirement: Preparation is application-scoped and evidence-based
A preparation plan and its sessions SHALL belong to one application and workspace. The plan SHALL keep references and content hashes for the offer snapshot, submitted resume and approved facts it uses, rather than copying full profile facts or resume files into preparation records. Requirements without approved evidence SHALL remain explicitly unknown; suggested or rejected facts SHALL NOT support a claim. Each plan item SHALL retain its origin.

#### Scenario: A requirement has approved support
- **WHEN** a saved offer requirement matches an approved profile fact
- **THEN** the plan links the requirement to that fact and identifies its evidence origin

#### Scenario: A requirement has no approved support
- **WHEN** no approved fact supports a recognised requirement
- **THEN** the plan marks it unknown and does not invent a skill or experience claim

#### Scenario: Evidence changes
- **WHEN** the person reopens a plan after its source offer, resume or fact changed or was removed
- **THEN** the plan reports the affected evidence as stale or missing and requires review before reuse

#### Scenario: Another workspace requests a plan
- **WHEN** a request targets another workspace's application, plan or session
- **THEN** the application does not reveal or mutate that preparation data

### Requirement: The no-AI preparation flow remains complete
The person SHALL be able to create and edit their preparation plan, add personal notes and questions, run a text mock session, review its rubric feedback and retain its history without a connected AI provider. Generated practice content SHALL be labelled as such and SHALL NOT be presented as a verified employer question or an approved profile fact.

#### Scenario: AI is unavailable
- **WHEN** no assistant is connected, the person declines a request, or a provider fails
- **THEN** the no-AI plan and text mock session remain usable and no failed assistant output changes the plan or session

#### Scenario: Preparation session ends
- **WHEN** a text mock session is completed
- **THEN** its questions, answers, feedback and learning items remain attached to that application's preparation history

### Requirement: Assistant preparation requests require per-request consent
Before each assistant request, the person SHALL see the exact payload and explicitly confirm that request. Only the selected offer, selected submitted resume, relevant approved facts, interview stage and user-selected notes or public research may be sent. The full profile, unrelated applications, suggested or rejected facts, and private assessment material SHALL NOT be sent. Remembered consent SHALL NOT authorize another request. Assistant suggestions SHALL be labelled as generated and SHALL NOT enter a plan until the person accepts them.

#### Scenario: Preview only
- **WHEN** the person previews an assistant request
- **THEN** the application shows the selected content and sends nothing to the provider

#### Scenario: Payload is changed after review
- **WHEN** the evidence or selection changes after the person reviewed the preview
- **THEN** the application rejects the old confirmation and asks the person to review the new payload

#### Scenario: The person declines or the provider fails
- **WHEN** the person declines, cancels, or the provider is unavailable
- **THEN** no assistant result is stored and the preparation plan remains unchanged

### Requirement: Optional mock-session feedback is deliberate and preparation-only
The person MAY request assistant feedback for one selected mock answer. Each request SHALL show its exact payload and require fresh consent. Only that answer, its question, and the minimum context the person selects may be sent, with only relevant approved facts and current evidence. Feedback SHALL be identified as generated and SHALL NOT change the session until the person accepts it. The application SHALL NOT offer this assistance during a live interview or employer assessment.

#### Scenario: Accept or discard generated feedback
- **WHEN** the assistant returns feedback for a selected mock answer
- **THEN** the person can accept it or discard it, and discarding leaves the turn unchanged

#### Scenario: Feedback evidence is stale
- **WHEN** relevant evidence changes after review or before the response is accepted
- **THEN** the application stores no feedback and leaves the session unchanged

### Requirement: Preparation data follows workspace lifecycle controls
Deleting a preparation plan SHALL delete its evidence, items, sessions and turns without deleting the source application or profile facts. Workspace deletion SHALL remove all preparation data. Workspace JSON export and encrypted backup/restore SHALL preserve plans, evidence provenance, notes, sessions, turns and their relationships, while excluding credentials and keeping restored external permissions and automation disabled.

#### Scenario: Export a completed mock session
- **WHEN** the person exports their workspace
- **THEN** the export includes the plan, evidence, notes, mock session and linked turns, including their identifiers and answers

#### Scenario: Restore an encrypted backup in isolation
- **WHEN** a valid backup is restored to a new workspace database
- **THEN** interview-preparation records and relationships are preserved while external permissions remain disabled

#### Scenario: Delete a plan or workspace
- **WHEN** the person deletes a plan or deletes the entire workspace
- **THEN** its preparation records and session answers are removed according to that deletion scope

### Requirement: Interview preparation is bilingual, accessible and isolated in tests
The interface SHALL be available in Spanish and English, operable by keyboard and usable at 390 px without horizontal overflow. Unit, API, browser and backup/restore tests SHALL use the documented fictional fixtures; browser and database walkthroughs SHALL use disposable isolated workspaces. CI SHALL run the interview-preparation checks.

#### Scenario: Run the isolated browser walkthrough
- **WHEN** CI runs the interview-preparation E2E scenario
- **THEN** it uses only fictional run-specific data, checks the plan and mock flow, and verifies interview data and provenance survive JSON export

#### Scenario: Run the encrypted round trip
- **WHEN** CI runs the backup/restore integration scenario
- **THEN** it creates and restores interview records only in disposable databases and verifies evidence and linked turns survive
