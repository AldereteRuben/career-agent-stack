# Proposal

## Why

Career Stack already supports job discovery and application tracking, but these workflows present dense information with different visual patterns. Applying the clearer hierarchy and compact list/detail patterns observed in JobSync can make offers easier to review and application progress easier to scan while keeping Career Stack's own identity and user-controlled workflow.

## What Changes

- Refine the shared dashboard shell, page headers, and visual hierarchy for navigation, primary actions, and status information.
- Redesign job discovery as a responsive master-detail workspace: keep a compact offer list beside the selected offer on desktop, and provide a focused list/detail transition on mobile. Make search results, key offer facts, fit evidence, and next actions easier to scan.
- Redesign the application tracker list and selected-application view to make status, next steps, and history easier to navigate.
- Keep Spanish and English copy, keyboard access, mobile layouts, existing data and workflows, and clear user control over application submission.

Out of scope: redesigning every dashboard page, adding contacts or other new product capabilities, changing APIs or data models, automating or submitting applications, and copying JobSync's branding or assets. Manual application submission and any unsupported employer-site steps remain unchanged. This change does not alter package versions, `RELEASE_VERSION`, or the changelog.

## Capabilities

### New Capabilities

- `dashboard-shell`: Shared navigation, page framing, and responsive visual behavior for the dashboard.
- `job-discovery`: Browsing, filtering, and reviewing found job offers.
- `application-tracking`: Reviewing tracked applications, their current progress, and activity.

### Modified Capabilities

None. The repository has no existing OpenSpec capability specifications.

## Impact

- `apps/dashboard/components/shell.tsx` and `apps/dashboard/app/globals.css` for shared presentation.
- `apps/dashboard/app/jobs/page.tsx`, `apps/dashboard/app/jobs/[id]/page.tsx`, and their styles for job discovery and its responsive master-detail layout.
- `apps/dashboard/app/applications/page.tsx` and its styles for application tracking.
- No API, database, external dependency, or submission-flow changes are expected.
