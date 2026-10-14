# Tasks

## 1. Decision record and data model

- [x] 1.1 Add ADR `docs/decisions/021-job-availability.md` recording the rule (complete reads only, 3 misses over 48 hours, suspicious reads ignored, Himalayas presence-only, person's decision wins, no provider closure signal yet) and the limits from proposal.md; verify it links to #35 and to brief §5.
- [x] 1.2 Add migration `0013_job_availability.sql` (counters on `job_occurrences` and `job_search_sources`, `last_complete_count` on `boards` and `job_search_provider_cache`, `jobs.closed_by_user`, table `job_availability_events`), its journal entry and the Drizzle schema; verify `pnpm run typecheck` and `pnpm run test:integration` (all migrations in order) pass.
- [x] 1.3 Add `job_availability_events` to `DELETION_ORDER` in `apps/api/src/workspace-deletion.ts` and a history row to its proof fixture; verify `pnpm run test:deletion` passes (the coverage test fails without it).

## 2. Decision rule (domain)

- [x] 2.1 Implement `nextAvailability` with `ABSENCE_READS = 3` and `ABSENCE_MIN_HOURS = 48` in `packages/domain`; verify unit tests in `packages/domain/test/job-availability.test.ts` cover every scenario of the "possibly closed", "reappearing", "person's decision" and "manual job" requirements, plus the boundaries (2 vs 3 misses, 47 vs 48 hours, Himalayas-only seen recently vs long ago), with `pnpm run test:unit`.
- [x] 2.2 Implement the suspicious-read check (empty after a non-empty complete read, or under half the previous complete count) as a pure function; verify unit tests for empty, 49%, 50% and first-ever read pass with `pnpm run test:unit`.

## 3. Counting absence in the readers

- [x] 3.1 In `refreshBoard` (`apps/api/src/discovery.ts`): stop overwriting `availability` on existing jobs; on `COMPLETE` refreshes only, record presence (`last_seen_at`, counter 0) for listed occurrences and, unless suspicious, count misses for the rest; partial refreshes no longer update `last_seen_at`; update `last_complete_count`, and re-evaluate touched jobs with `nextAvailability`, writing history in the same transaction; verify with fictional boards in the discovery tests: complete refresh without the job, partial refresh that lists a job with misses (no change), HTTP error, suspicious empty refresh, reappearing job (`pnpm run test:discovery`).
- [x] 3.2 In `loadProviderFeed` (`apps/api/src/job-search.ts`): on a freshly downloaded non-suspicious `COMPLETE` Remotive or Arbeitnow feed, record presence and, unless suspicious, count misses for that provider's `job_search_sources` in every workspace, update `last_complete_count`, and re-evaluate touched jobs per workspace; cached, bounded, stale and failed feeds change nothing, not even presence; verify with fictional feeds that a job matched by two saved searches gets one history entry, that two workspaces each get their own entry, that a `POSSIBLY_CLOSED` job listed in a cached feed stays so, in both the v1 and v2 pipelines (`pnpm run test:searches`).
- [x] 3.3 In the v1 and v2 writers (`job-search.ts`, `search-execution.ts`): create new jobs as `OPEN` but never force `OPEN` on existing ones; record Himalayas sightings as presence only, and only from newly downloaded results; verify a user-closed job seen again stays `CLOSED` and a Himalayas miss changes nothing (`pnpm run test:searches`).

## 4. The person's actions and history (API)

- [x] 4.1 Add `POST /api/v1/jobs/:id/availability` (`close` / `reopen`, `expectedAvailability`, `409 STALE_JOB_AVAILABILITY`) and the history plus "a source still lists it" in the job detail response; verify with route tests against a disposable database: close, reopen resets counters, stale request, other workspace's job refused (`pnpm run test:searches` or a new `test:job-availability` script wired into CI).
- [x] 4.2 Verify that no availability change touches applications: a test closes, possibly-closes and reopens a job with a submitted application and asserts its state, stage and version are unchanged.

## 5. Interface

- [x] 5.1 Job page (`apps/dashboard/app/jobs/[id]/page.tsx`): state with its latest reason, history list, Close and Reopen buttons, "a source still lists it" note; Spanish and English labels in `apps/dashboard/lib/labels.ts`; verify with `pnpm run test:ui-logic` and a browser scenario in `apps/api/e2e/edge-cases.ts` at desktop and 390 px (no horizontal scroll, keyboard reachable).
- [ ] 5.2 Text badges for non-`OPEN` jobs in job lists and My applications, and a warning (not a block) when preparing an application for a non-`OPEN` job; verify in the same browser scenario, including that filtering by `POSSIBLY_CLOSED` returns exactly those jobs.
- [ ] 5.3 Update README and README.es "current limits" (how availability is decided and what stays manual); verify both languages say the same.

## 6. Integration check

- [ ] 6.1 Run the full local suite (`lint`, `typecheck`, `test:unit`, `test:discovery`, `test:searches`, `test:deletion`, `test:integration`, `test:ui-logic`, `test:edge-cases`) and confirm CI is green on the pull request.

## Workflow follow-up

- Comment on #35 with the rule from ADR 021 before implementation starts, since the issue asks for the rule to be agreed there first.
- Archive the change after the pull request is merged.
