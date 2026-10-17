# Spec Delta

## Purpose

Defines how users scan tracked applications and inspect an individual application's current state, next steps, and recorded history.

## ADDED Requirements

### Requirement: Application lists make progress scannable
The application list SHALL present each tracked role with its company, current application state, hiring stage, and recent update information when available.

#### Scenario: User scans tracked applications
- **WHEN** the user opens the application tracker
- **THEN** each listed application exposes its role, company, current state, hiring stage, and recent update in a consistent and scannable way

#### Scenario: User filters the application list
- **WHEN** the user searches or filters tracked applications
- **THEN** the list communicates the active query or filter and provides a clear empty state when there are no matches

### Requirement: Selected applications expose progress and history
The selected-application view SHALL organize the current stage, resume status, notes, and recorded activity so the user can identify the next relevant action.

#### Scenario: User inspects an application
- **WHEN** the user selects an application
- **THEN** the detail view shows its current state and stage, available resume actions, tracking controls, notes, and activity history

#### Scenario: User corrects an application record
- **WHEN** the user changes a previously recorded application state or stage
- **THEN** the interface asks the user to confirm the correction and makes clear that the record reflects the user's statement

### Requirement: Application tracking remains usable on small screens
The application tracker SHALL allow users to move between the application list and its selected detail on narrow screens without losing the current selection.

#### Scenario: User opens an application on a narrow screen
- **WHEN** the user selects an application at a narrow viewport
- **THEN** the detail is readable without horizontal page scrolling and a keyboard- and touch-operable action returns to the list
