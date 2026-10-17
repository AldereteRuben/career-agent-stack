# Tasks

## 1. Shared dashboard presentation

- [x] 1.1 Refine shared dashboard tokens, page headers, navigation hierarchy, and responsive states; verify dashboard typecheck and keyboard navigation in the isolated Playwright end-to-end environment.

## 2. Job discovery

- [x] 2.1 Rework job list summaries and job detail hierarchy while preserving scopes, filters, route behavior, and actions; add or update Playwright UX scenarios with synthetic job records and verify them with `pnpm run test:e2e`.
- [x] 2.2 Replace the isolated job-card grid with the responsive master-detail workspace: compact selectable results and a detail panel on desktop, a single-pane list/detail transition on mobile, and a shareable selected-offer query state. Preserve the full `/jobs/[id]` route, existing filters, actions, and application-preparation boundaries; add synthetic E2E coverage.

## 3. Application tracking

- [x] 3.1 Rework application list rows and selected-application sections while preserving selection, filters, pagination, correction confirmations, and focus behavior; add or update Playwright UX scenarios with synthetic application records and verify them with `pnpm run test:e2e`.

## 4. Integrated responsive and locale review

- [x] 4.1 Verify the changed routes at desktop and narrow viewport widths in Spanish and English using isolated synthetic data; run `pnpm run test:e2e` and confirm no horizontal page scrolling or loss of keyboard-operable navigation.
  - Validation: the changed-route matrix and mobile keyboard scenario passed. The final full E2E run passed all 39/39 scenarios.
- [x] 4.2 Verify the master-detail job workflow at desktop and narrow widths in Spanish and English, including keyboard selection, URL/filter preservation, full-detail links, and no horizontal page scrolling; run the relevant isolated Playwright scenarios and `pnpm run test:e2e`.
  - Validation: `job-discovery-master-detail-responsive-and-locale` passed in isolation for ES/EN at desktop/mobile, including the final no-auto-selection behavior; `manual-job-and-application-tracking`, `v040-favorites-archive-filters-and-pagination`, `v053-notice-actions-wrap-on-mobile`, and `v060-automatic-search-and-new-jobs` passed in isolated runs after updating their navigation to use the full-detail action. Dashboard typecheck and strict OpenSpec validation passed. The final full E2E run passed 39/39 scenarios, including `ux-review-focus-resume-drafts-and-return-filters` and `v061-discovery-recovery-and-inbox-continuity`.
