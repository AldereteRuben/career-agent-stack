# Premium UX implementation plan

## Product outcome

Make Career Stack feel like one calm, guided workspace for moving from job discovery to a prepared application and a reliable follow-up record. Reduce unnecessary navigation, repeated explanations, long pages, and visual competition while preserving user control and clear evidence.

The primary journey is:

```text
Offers → Applications → Calendar → Profile and resume
```

The journey is a navigation model, not a forced wizard. Users can enter from any page and return to a saved offer or application without losing their place.

## Design principles

- Show the next useful action before secondary metrics and explanations.
- Keep the offer verdict, supporting evidence, and unknowns together before application preparation.
- Use progressive disclosure for secondary details, historical caveats, and long activity lists.
- Preserve a visible distinction between discovered facts, user-confirmed facts, and model-generated suggestions.
- Use consistent page headings, status labels, spacing, and responsive behavior across the primary journey.
- Keep every workflow bilingual, keyboard-operable, and usable at narrow widths.
- Require the user to review and explicitly authorize any external application submission.

## Delivery phases and acceptance criteria

### 1. Shared navigation and page framing

- Organize primary navigation around Home, Offers, Applications, and Calendar; group Profile and resume together and place less frequent tools under More.
- Keep route highlighting and breadcrumbs correct for filtered offers, job details, preparation, and tracker views.
- Keep the mobile drawer operable by keyboard and expose the current destination to assistive technology.

**Acceptance:** Spanish and English labels are present; direct links and back navigation preserve relevant filters and selection; no primary destination is hidden in the secondary group.

### 2. Home as a next-action surface

- Show one prominent next step derived from current workspace state.
- Show the new-offers inbox only when it has offers, searches to explain, or an error to surface; let the next step use the available width when the inbox has no useful content.
- Keep activity, metrics, and secondary setup guidance available below the primary action and collapsed until requested, even when review work exists.

**Acceptance:** empty, searching, results-available, failed-refresh, and pending-review states each offer a clear next action without contradictory counts or empty panels.

### 3. Offer discovery and fit report

- Keep offers scannable in the list and preserve a stable return path from the selected offer.
- Present “good option / review / probably not a fit” with evidence, missing information, and source freshness; never present unknown data as a confirmed mismatch.
- Put the report before application preparation and adapt evidence columns to the available content width.

**Acceptance:** list/detail navigation remains shareable; report sections reflow without horizontal page overflow; each outcome remains understandable without color alone; the original job source remains easy to open.

### 4. Candidacy preparation and consent

- Reuse approved profile facts and imported resume evidence; keep unreviewed facts visibly unconfirmed.
- Ask only for missing information, group optional corrections away from the primary path, and make prepared documents easy to preview and retain.
- Keep explicit user review and authorization before any submission step.

**Acceptance:** a prepared application can be reviewed and corrected without losing its source offer; the UI does not claim an application was sent until the user confirms it; consent copy remains visible at the relevant action.

### 5. Application tracking and calendar

- Keep role, company, stage, status, and next follow-up scannable in the tracker.
- Use a consistent calendar/timeline for discovered and saved offers, applications, stage changes, interviews, and overdue follow-ups, with links back to the source record.
- Keep long histories and date/time-zone caveats available without dominating the main task.

**Acceptance:** recorded events have a real source and timestamp; historical data without timestamps is not fabricated; overdue items are distinguishable and navigable; long titles and statuses wrap at narrow widths.

### 6. Visual and accessibility review

- Refine density, component rhythm, alignment, content width, and mobile wrapping across the complete journey.
- Verify empty, loading, success, and error states as well as populated states.
- Preserve visible keyboard focus, semantic headings and labels, readable contrast, and non-color status cues.

**Acceptance:** review Home, Offers, an offer detail, Applications, a selected application, Calendar, Profile, and resume documents at desktop and mobile widths in both locales; confirm keyboard navigation and no horizontal page scrolling.

## Current implementation status

Implementation is complete in the working tree on branch `codex/premium-ux-foundation`. Changes reorganize navigation, make Home prioritize the next action, keep pending profile facts reachable beside a higher-priority action, move the fit report ahead of preparation, compact secondary timeline notes, collapse interview scheduling details until requested (while keeping existing interviews open and summarized), and refine offer-report and tracker responsiveness. The mobile application detail hides list-only filters and actions while a record is selected, and the CV builder explains when a preserved draft includes facts that are no longer confirmed. Browser fixtures now reflect the current navigation: Offers owns its saved/new filter, Profile and resume are grouped in the main menu, and Home's activity calendar is opened through its disclosure. The tracker journey is now a compact three-column progress indicator on mobile. Long guidance for assisted preparation is collapsed by default while its experimental limitation stays visible; each authorization and full consent text remain visible at the action that needs them. Timeline filters use a consistent two-column layout on narrow phones while keeping all seven controls visible and keyboard-operable. Visual review found no horizontal overflow at 320/390 px and confirmed the tracker progress indicator remains legible. The selected tracker screenshot is about 3,061 px tall; optional materials, contacts, email, interview scheduling, and activity remain progressively disclosed.

The complete isolated browser suite and a targeted rerun of the final tracker density change passed against the current diff. Generated captures cover Home, Offers, Applications, Calendar behavior, Profile, and resume workflows in both locales and at narrow mobile widths. A dedicated cross-locale visual screenshot review of the Calendar page remains useful.

## Product limits to keep explicit

- Job coverage is limited to configured and approved sources; “no matches” does not mean the whole market was searched.
- Fit and eligibility depend on the information available in the offer and profile. The app cannot verify a person's qualifications or guarantee employer decisions.
- Imported resume facts remain suggestions until the user reviews them.
- Timeline entries represent recorded events only. Missing historical dates are not inferred.
- Preparing a candidacy is distinct from submitting it. External forms, uploads, terms, and final submission remain user-reviewed and explicitly authorized.
- Optional AI assistance may be unavailable or incomplete; core navigation and review should remain usable without it.

## Verification record

| Check | Current evidence | Remaining evidence |
|---|---|---|
| UI logic tests | 63/63 passed under Node 24 after final UI changes | Complete |
| Lint | Passed under Node 24 after final UI changes | Complete |
| Dashboard typecheck | Passed under Node 24 after final UI changes | Complete |
| Production build | Passed under Node 24 after final UI changes | Complete |
| Diff whitespace check | Passed; temporary root `.env` removed after every E2E run | Complete |
| Rendered review | Reviewed Home, offer detail, selected tracker, assisted preparation, profile, resume/import, and Calendar captures in Spanish and English, including 320/390 px mobile states. Calendar filters align in two columns on narrow phones; no horizontal overflow was found. The mobile progress indicator is compact; the selected tracker capture is 3,061 px tall with optional areas disclosed. | Complete |
| E2E | Complete isolated browser suite passed 55/55 after updating to current `main`, including Home, job discovery, mobile application tracking, activity calendar, assisted preparation, resume import, accessibility-tree checks, and state/recovery edge cases. The isolated V051 sign-out → document lifecycle chain passed in the full run. The calendar scenario verifies keyboard-operable filters in both locales and the visual review checked 320/390 px screenshots. | Complete |

The isolated browser harness requires a local PostgreSQL anchor URL from a temporary root `.env`. The file was removed after each run; the database and file store were disposable and isolated.

No version, changelog, API, data-model, or submission-policy change is part of this UX work.
