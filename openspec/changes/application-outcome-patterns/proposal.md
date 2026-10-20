# Proposal

## Why

The existing application summary shows overall interview outcomes but does not show how those outcomes differ by the recorded source or role title. Issue #111 asks for descriptive patterns while making the small size and limits of the local dataset clear.

## What Changes

- Add separate breakdowns by explicitly linked job source, normalized stored role title, and country.
- Reuse #16's cohort: unique applications with explicit confirmation that remain `CONFIRMED` in the selected period.
- Show counts for every group, but show an interview percentage only when that group has at least five applications.
- Do not infer source from a company name, classify titles semantically, or infer country from free-text location.

## Out of Scope

- Cross-tabulations, rankings, causal claims, predictions, recommendations, AI classification, and external analytics.
- Country extraction or normalization. The current schema has no validated country field, so this dimension reports `Country not identified` until such a field exists.
- Changes to #16's overall cohort, periods, or existing totals.

## Limits That Remain

- Manually entered applications without a linked job have no source attribution.
- A linked job with multiple distinct providers is grouped as `Multiple sources` to avoid counting the application more than once.
- Country is unavailable for every row until a validated country field is added.
