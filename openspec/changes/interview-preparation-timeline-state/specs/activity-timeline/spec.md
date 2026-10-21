# Activity timeline delta

## Requirement: Interview items expose interview preparation status

Each `INTERVIEW` item returned by `GET /api/v1/timeline` SHALL include `interviewPreparationStatus`, with one of `NO_PLAN`, `PLAN_READY`, `MOCK_IN_PROGRESS` or `MOCK_COMPLETED`. The status SHALL be derived from the most recently created preparation plan for the application and the most recently created session belonging to that plan. A plan with no session SHALL be `PLAN_READY`; an application with no plan SHALL be `NO_PLAN`.

The lookup SHALL be restricted to the requesting workspace and the applications whose interview items are in the response. It SHALL read only IDs and session status, SHALL NOT return preparation items or session content, and SHALL NOT create or modify preparation data.

### Scenario: Interview has no plan

- **WHEN** the timeline returns an interview for an application with no preparation plan
- **THEN** the item includes `interviewPreparationStatus: NO_PLAN`

### Scenario: Interview has a plan but no session

- **WHEN** the latest plan for the application has no sessions
- **THEN** the item includes `interviewPreparationStatus: PLAN_READY`

### Scenario: Latest mock session is in progress

- **WHEN** the latest session for the latest plan is in progress
- **THEN** the item includes `interviewPreparationStatus: MOCK_IN_PROGRESS`

### Scenario: Latest mock session is completed

- **WHEN** the latest session for the latest plan is completed
- **THEN** the item includes `interviewPreparationStatus: MOCK_COMPLETED`

### Scenario: Preparation content is private

- **WHEN** a timeline request returns interview preparation status
- **THEN** it does not include plan items, questions, answers, notes, feedback or learning items, and it does not change preparation records

### Scenario: Another workspace has preparation data

- **WHEN** another workspace has plans or sessions for its applications
- **THEN** those records do not affect the requesting workspace's interview statuses or appear in its response
