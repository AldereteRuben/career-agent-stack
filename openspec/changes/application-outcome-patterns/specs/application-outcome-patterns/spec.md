# application-outcome-patterns Specification

## Purpose

Show descriptive, workspace-local patterns in confirmed applications without overstating sparse or uncertain data.

## Requirements

### Requirement: Outcome breakdowns reuse the confirmed-application cohort

The tracking metrics response SHALL provide separate breakdowns by linked source, stored role title, and country for the same unique applications, selected period, current `CONFIRMED` state, and explicit-confirmation evidence used by the overall metrics. The dimensions SHALL NOT be combined into a cross-tabulation. Existing overall totals SHALL retain their current definitions.

#### Scenario: Application has no source link

- **WHEN** a confirmed application has no linked job or its job has no source-provider record
- **THEN** it appears once under `Source not identified`

#### Scenario: Job has multiple provider records

- **WHEN** a linked job has records from more than one distinct provider
- **THEN** its application appears once under `Multiple sources`, not once per provider

#### Scenario: Role titles differ only in case or spacing

- **WHEN** confirmed applications have stored role titles that differ only by capitalization or repeated whitespace
- **THEN** they appear in the same role group, without semantic classification

### Requirement: Uncertain country is not inferred

The tracking metrics response SHALL NOT derive a country from company headquarters, provider region, or free-text location. Until a validated country field exists, applications SHALL appear in the `Country not identified` group.

#### Scenario: Location is free text

- **WHEN** a confirmed application has a free-text location
- **THEN** the country breakdown does not inspect or return that text and identifies the country as unknown

### Requirement: Small breakdown samples are descriptive only

Every group SHALL show its confirmed-application and interview counts. The dashboard SHALL show an interview-conversion percentage only when the group contains at least five confirmed applications; smaller groups SHALL show an explicit small-sample notice and no percentage. Groups SHALL not be ranked as better or presented as causal findings.

#### Scenario: Group has fewer than five applications

- **WHEN** a breakdown group contains one to four confirmed applications
- **THEN** its exact counts are visible, its percentage is omitted, and the interface says the sample is small

#### Scenario: Group reaches the minimum sample

- **WHEN** a breakdown group contains at least five confirmed applications
- **THEN** it shows the rounded interview-conversion percentage and its counts

### Requirement: Breakdown data remains local and usable

The API SHALL scope application and source reads to the active workspace. The overview SHALL provide the breakdowns in Spanish and English and SHALL remain usable by keyboard and at phone widths.

#### Scenario: Other workspace has matching source keys

- **WHEN** another workspace has applications or source records with the same IDs or providers
- **THEN** none of their counts or role titles affect the active workspace's response

#### Scenario: Person switches language

- **WHEN** the person switches the dashboard language
- **THEN** breakdown headings, unknown-data labels, and small-sample notices use the selected language
