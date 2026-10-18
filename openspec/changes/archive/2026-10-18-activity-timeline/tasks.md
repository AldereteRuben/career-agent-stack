# Tasks

## 1. Data

- [x] 1.1 Add `jobs.saved_at` and indexes for saved jobs, interviews and application events in an additive migration with its Drizzle snapshot; migration upgrade tests (`v080`, `v090`, fact import) pass on a disposable database.
- [x] 1.2 Date saves in `decideJob`: set once on the job the person saved, keep while saved, clear on any other decision, never date duplicates or previously saved jobs; covered by `apps/api/test/activity-timeline.integration.test.ts`; `test:searches` still passes.

## 2. API

- [x] 2.1 Add range, type, bounds, today and ordering helpers to `activity-days.ts`; unit tests in `apps/api/test/activity-days.test.ts` (`test:unit`, `test:timeline`).
- [x] 2.2 Add `GET /api/v1/timeline` with workspace scoping, local-day grouping, follow-up status and a separate overdue list; disposable-database tests cover isolation, time zones, filters, closed applications and validation (`test:timeline`, also in CI).

## 3. Dashboard

- [x] 3.1 Add the bilingual timeline page under Applications with month navigation, type checkboxes and the overdue list, linked from Applications and the overview calendar; helper tests in `apps/dashboard/lib/timeline.test.ts` (`test:ui-logic`), typecheck and lint pass.
- [x] 3.2 Browser scenario `apps/api/e2e/timeline.ts` covers ES/EN, found and saved jobs, keyboard filtering and 390 px width; `/timeline` appears in the language and title checks. It passes in the isolated stack.

## 4. Verification

- [x] 4.1 Run typecheck, lint, unit, UI logic, timeline, preparation and search suites with synthetic data on a disposable PostgreSQL only.

## 5. Follow-up from coordinator

- [x] 5.1 `JOB_FOUND` records use `jobs.created_at`, distinguish automatic discovery from manual addition, and are covered by disposable-database, UI-logic and browser tests; proposal, design and spec describe the behavior.
