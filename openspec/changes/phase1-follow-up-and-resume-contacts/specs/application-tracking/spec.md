# Spec Delta

## ADDED Requirements

### Requirement: Applications retain a next step and follow-up date
The tracker SHALL let a person record an optional next step and a real calendar date for following up. The tracker SHALL show overdue and due-today follow-ups for open applications and let the person order the list by follow-up date. Closed applications SHALL not appear overdue and SHALL sort after active applications. Within each group, dated applications SHALL appear before undated applications and be ordered from earliest to latest.

#### Scenario: Person records a follow-up
- **WHEN** the person saves a next step and a valid follow-up date
- **THEN** the application retains both values and its activity history records the change

#### Scenario: Follow-up date is invalid
- **WHEN** the person submits a date that is not a real calendar date
- **THEN** the API rejects the update without changing the application

#### Scenario: Follow-up is due
- **WHEN** an open application has a follow-up date before today or equal to today in the person's local calendar
- **THEN** the tracker labels it as overdue or due today respectively

#### Scenario: Person orders by follow-up
- **WHEN** the person chooses follow-up ordering
- **THEN** active applications appear before closed applications
- **AND** within each group, applications with a date appear before undated applications, ordered from earliest to latest

### Requirement: Interviews preserve the selected time zone
The tracker SHALL let a person record or clear an interview using a local date and time and an IANA time zone. It SHALL store the corresponding instant and zone and SHALL reject nonexistent or ambiguous daylight-saving wall times.

#### Scenario: Person records an interview
- **WHEN** the person saves a valid local interview time and IANA zone
- **THEN** the application retains the instant and selected zone and its activity history records the change

#### Scenario: Interview wall time is invalid
- **WHEN** the local time does not exist or occurs twice in the selected zone
- **THEN** the update is rejected and the existing interview remains unchanged
