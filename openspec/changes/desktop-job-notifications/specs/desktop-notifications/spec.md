# Desktop Notifications

## ADDED Requirements

### Requirement: Desktop notifications are opt-in

The application MUST keep desktop notifications disabled unless the workspace explicitly enables them. The application MUST provide a way to disable notifications, and disabling MUST prevent queued notifications from being delivered later.

#### Scenario: Notifications start disabled

- **WHEN** a workspace has no desktop notification settings
- **THEN** desktop notifications are treated as disabled

#### Scenario: User disables notifications

- **WHEN** a workspace disables desktop notifications
- **THEN** pending notifications are marked disabled and are not replayed if notifications are enabled again later

### Requirement: Notify only for completed automatic searches with new jobs

The application MUST queue one notification only after a successful automatic search completes with one or more new jobs. It MUST NOT notify for manual runs, failed or partial runs, or completed runs with no new jobs.

#### Scenario: Automatic search finds new jobs

- **WHEN** an automatic search completes successfully and saves new jobs
- **THEN** the application queues one notification containing the number of new jobs

#### Scenario: Manual or unsuccessful search

- **WHEN** a search is manual, unsuccessful, partial, or finds no new jobs
- **THEN** the application does not queue a desktop notification

### Requirement: Notification content minimizes sensitive data

Desktop notification content MUST contain only the localized new-job count and MUST NOT include job titles, company names, salary, descriptions, or job URLs.

#### Scenario: Lock-screen notification

- **WHEN** a desktop notification is displayed
- **THEN** it contains the localized count and no job-specific details

### Requirement: Local provider status and navigation

Settings MUST report whether a local notification provider is available, provide a test notification, and report the last delivery result without claiming that an accepted send proves OS permission. Where supported, activating a notification MUST open the local new-jobs list. Provider unavailability MUST NOT prevent search functionality.

#### Scenario: Provider unavailable

- **WHEN** the current operating system has no supported local provider
- **THEN** Settings reports it unavailable and searches continue to work

#### Scenario: User tests and opens a notification

- **WHEN** a user requests a test notification
- **THEN** the application sends localized test content through the local provider
- **WHEN** the user activates a supported notification
- **THEN** the application opens the local new-jobs list
