# Design

## Context

See `proposal.md` for motivation and scope. The dashboard already has a shared shell, bilingual copy, reusable UI primitives, responsive navigation, a card-based job list, a long-form job detail page, and a split application list/detail tracker. The redesign should use these existing structures and preserve their routes and domain behavior.

## Goals / Non-Goals

**Goals:**

- Make the current destination, primary action, and important state easier to recognize.
- Give job lists and application tracking a more compact, consistent scan pattern.
- Organize offer and application details so users can find key facts, progress, and history quickly.
- Preserve Spanish and English, keyboard behavior, responsive layouts, accessibility contrast, and the existing visual identity.

**Non-Goals:**

- Replacing the dashboard shell or introducing a new component library.
- Redesigning every dashboard route in this phase.
- Changing job matching, application state, APIs, persistence, or application submission.
- Copying JobSync branding, proprietary assets, or exact screen layouts.

## Decisions

### Reuse the existing shell and design tokens

Keep `AppShell`, its route behavior, locale handling, and responsive drawer. Refine the shared CSS tokens and existing primitives only where needed to establish clearer spacing, hierarchy, and status treatment. Keep the existing system font stack and navy navigation identity; do not add a web-font or component-library dependency.

Alternative considered: replace the shell with a new navigation architecture. Rejected because the current shell already supports primary and grouped secondary navigation, mobile drawer behavior, keyboard focus management, and bilingual labels.

### Use a responsive master-detail workspace for job discovery

Keep the current job scopes, query parameters, filters, card actions, and dedicated `/jobs/[id]` route. On `/jobs`, present a compact, scannable offer list beside a selected-offer detail panel at desktop widths. Store the selected offer in a `selected` query parameter so the view is linkable and browser navigation remains predictable. Show role, company, location, availability, review state, and fit evidence in a clear order in both panes. At narrow widths, show one pane at a time: selecting an offer opens its detail view with a visible back-to-list control that preserves the current search and filters. Keep `/jobs/[id]` as the complete detail route for deep links and expanded review. Do not change the meaning of fit information or submit an application automatically.

Alternative considered: retain a card grid and navigate away to a full-width detail page for every offer. Rejected because it leaves the results list out of view and does not match the compact side-by-side review pattern the user chose.

### Clarify application list and detail hierarchy

Keep the existing selected-application model, URL selection, filtering, pagination, focus management, and correction confirmations. Refine the list rows to prioritize role, company, stage, status, and recent update. Group the detail content into distinct sections for progress, resume, tracking controls, notes, and activity. At narrow widths, keep a clear route back to the list and preserve the selected application when moving between views.

Alternative considered: move application data into a new tabbed sub-route. Rejected because it would add navigation state and could obscure actions users currently access directly from the selected application.

### Scope new presentation styles to the changed workflows

Use shared tokens and primitives for cross-page consistency, and page-level styles for job and application layouts. Preserve current semantic elements, labels, focus behavior, and status announcements. Add or update bilingual strings alongside any changed labels. Keep content order meaningful when styles collapse to mobile layouts.

Alternative considered: broadly restyle all pages in `globals.css`. Rejected because it could create unintended regressions across profile, documents, company sources, and search setup pages that are outside this change.

## Risks / Trade-offs

- [Shared CSS changes affect untouched routes] → Limit global edits to tokens and shared primitives; use page-scoped styles for new layouts and review adjacent routes.
- [A denser master-detail layout can reduce readability] → Preserve readable text sizes, contrast, spacing, visible status labels, and responsive reflow; show only one pane at a time on narrow screens and do not rely on color alone.
- [Reorganized details may make actions harder to find] → Keep primary actions near the summary and use visible section headings; retain keyboard access and existing focus behavior.
- [JobSync patterns may not fit Career Stack's privacy and manual-approval flow] → Borrow information hierarchy only; retain explicit user-controlled preparation and submission boundaries.

## Migration Plan

No data migration or rollout switch is required. Implement the shared presentation refinements and the two workflow layouts in the dashboard, then review the changed routes at desktop and narrow viewport widths using synthetic job and application records. Rollback consists of reverting the presentation changes; routes, APIs, stored records, and user data remain compatible.
