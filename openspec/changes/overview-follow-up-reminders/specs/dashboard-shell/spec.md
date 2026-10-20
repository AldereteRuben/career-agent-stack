# Dashboard shell specification delta

## Requirement: Overview surfaces upcoming application actions

The overview SHALL surface overdue follow-ups and upcoming interviews or follow-ups without requiring the person to open the activity timeline. It SHALL use the viewer's calendar time zone, show no more than three items in each group, and link each item to its application and the complete timeline. The overview card SHALL be read-only and SHALL NOT change notification preferences or application data.

### Scenario: There are follow-ups needing attention

- **WHEN** the overview has overdue follow-ups or interviews/follow-ups due within the next 30 local calendar days
- **THEN** it shows up to three overdue follow-ups and up to three upcoming items, with dates and links to their applications

### Scenario: There are no upcoming actions

- **WHEN** there are no overdue follow-ups or upcoming interviews/follow-ups
- **THEN** the overview does not show an empty reminder card

### Scenario: Timeline data cannot be loaded

- **WHEN** the timeline request fails
- **THEN** the overview shows a short error and a retry action, without hiding the rest of the overview
