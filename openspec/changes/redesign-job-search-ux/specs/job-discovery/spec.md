# Spec Delta

## Purpose

Defines how users browse found offers and review the information needed to decide whether to save, archive, or prepare an application for a job.

## ADDED Requirements

### Requirement: Job lists communicate scope and review state
The job list SHALL make the active list scope, search and filter controls, and each offer's essential summary understandable before the user opens an offer.

#### Scenario: User browses found offers
- **WHEN** the user opens a job list scope
- **THEN** the page identifies that scope, shows the available search and filter controls, and presents offer summaries with role, company, location when available, and review or availability state when relevant

#### Scenario: No offers match the current filters
- **WHEN** the current query and filters produce no results
- **THEN** the page explains that no offers match and provides a clear way to adjust or clear the filters

### Requirement: Offer review keeps the result list in context
At desktop widths, job discovery SHALL show a compact result list beside the selected offer details. The selected offer SHALL be represented in the URL so users can navigate or share the current review state without losing the active search and filters.

#### Scenario: User selects an offer on desktop
- **WHEN** the user selects an offer from the desktop result list
- **THEN** its details appear beside the list, the selected row is identified visually and programmatically, and the URL retains the active search and filters with the selected offer

#### Scenario: User selects an offer on a narrow screen
- **WHEN** the user selects an offer at a narrow viewport
- **THEN** the detail view replaces the list in the visible area, no horizontal page scrolling is required, and a keyboard- and touch-operable back action returns to the filtered list

#### Scenario: User opens a full job detail link
- **WHEN** the user opens a direct `/jobs/{id}` link or chooses the full detail action
- **THEN** the complete job detail remains available and provides a return path to the originating list state when one exists

### Requirement: Job details prioritize decision-relevant information
The job detail view SHALL make the role, company, location when available, offer availability, fit evidence, and available next actions easy to find while keeping the original job description accessible.

#### Scenario: User reviews an offer
- **WHEN** the user opens a found offer
- **THEN** the offer's key facts and current availability are distinguishable from the description and fit explanation, and available actions are clearly labeled

#### Scenario: Fit information is incomplete
- **WHEN** there is not enough approved profile evidence to assess fit
- **THEN** the page identifies the assessment as unavailable or provisional and does not imply a hiring prediction

### Requirement: Job actions preserve user control
The job discovery experience SHALL distinguish reviewing or saving an offer from preparing or submitting an application.

#### Scenario: User saves or reviews an offer
- **WHEN** the user saves, archives, or marks an offer as reviewed
- **THEN** the interface communicates the resulting state without presenting that action as an application submission

#### Scenario: User continues toward an application
- **WHEN** the user chooses to prepare an application from an offer
- **THEN** the user is taken to the existing preparation workflow and no application is submitted automatically
