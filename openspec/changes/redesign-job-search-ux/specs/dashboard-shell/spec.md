# Spec Delta

## Purpose

Defines a consistent, accessible dashboard frame that helps users navigate Career Stack and recognize their current location across supported screen sizes and languages.

## ADDED Requirements

### Requirement: Dashboard navigation identifies the current destination
The dashboard SHALL provide consistent primary and secondary navigation and clearly identify the current destination to both visual and assistive technology users.

#### Scenario: User navigates between primary destinations
- **WHEN** the user opens a dashboard destination
- **THEN** the matching navigation item is visibly active and programmatically identified as the current page

#### Scenario: User uses the navigation with a keyboard
- **WHEN** the user moves through navigation controls with a keyboard
- **THEN** each available destination and expandable navigation group can be reached and operated without a pointer

### Requirement: Dashboard frame adapts to narrow viewports
The dashboard SHALL keep navigation and page content usable at narrow viewport widths without requiring horizontal page scrolling.

#### Scenario: User opens the dashboard on a narrow screen
- **WHEN** the viewport is narrower than the desktop navigation layout
- **THEN** navigation remains available through a touch- and keyboard-operable compact control and the page content fits the viewport

### Requirement: Dashboard content supports both product languages
The dashboard shell and the changed workflows SHALL present user-facing navigation, actions, statuses, and empty states in the selected Spanish or English locale.

#### Scenario: User changes the selected locale
- **WHEN** the dashboard is rendered in Spanish or English
- **THEN** shell navigation and the changed workflow's user-facing text use that locale consistently

### Requirement: Dashboard overview provides a dated activity calendar
The dashboard SHALL open at the overview and show a calendar of workspace activity by day.

#### Scenario: User opens the dashboard root
- **WHEN** the user opens `/`
- **THEN** the dashboard redirects to `/overview`

#### Scenario: User reviews activity for a day
- **WHEN** the overview loads activity for its displayed calendar range
- **THEN** each day reflects activity in the viewer's calendar timezone and can be opened to inspect that day's activity
