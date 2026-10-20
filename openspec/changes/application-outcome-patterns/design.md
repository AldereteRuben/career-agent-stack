# Design

## Data flow

The existing workspace-scoped tracking endpoint keeps its confirmation events and current-application cohort. It loads each cohort application's linked job IDs, then reads provider IDs from `job_occurrences` and `job_search_sources`, both constrained to the active workspace and those job IDs. The pure metric calculator derives independent source, role, and country groups from that cohort.

## Grouping rules

- Source: deduplicate the explicitly linked provider IDs. One provider uses that provider's key, more than one becomes `multiple`, and none becomes `unidentified`.
- Role: trim and collapse whitespace, then compare case-insensitively. Do not infer a role family or use AI.
- Country: use the single `unidentified` bucket. `location` is free text, not a validated country code.
- Each dimension is grouped independently. Groups are ordered by confirmed-application count descending, then key.
- Each group includes confirmed and interviewed counts. Conversion is rounded to a whole percent at five or more applications; smaller groups return no percentage and are explicitly marked small.

## Interface and privacy

The existing overview renders the three independent lists in the selected period. Every visible label is bilingual and keyboard reachable; the responsive list layout reuses existing dashboard styles. The API returns only the active workspace's existing application role titles, source keys, and aggregate counts. It does not return location text or send data outside the local service.
