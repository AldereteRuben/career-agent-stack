# Tasks

## 1. Decision record and data model

- [x] 1.1 Add ADR `docs/decisions/022-job-evaluation-reports.md` (rule-based conclusions, no score in the report, no assistant in batches, page-driven passes) linking #109 and #110.
- [x] 1.2 Add migration `0017_job_report_batches.sql`, its journal entry and snapshot, and the Drizzle tables; verify `pnpm run typecheck` and the disposable-database tests apply every migration in order.
- [x] 1.3 Add both tables to `DELETION_ORDER` and to the JSON export; verify `pnpm run test:deletion` (its coverage test fails without them).

## 2. Report and batch rules (domain)

- [x] 2.1 Implement `buildJobReport` and the three conclusions in `packages/domain/src/job-report.ts`; verify `packages/domain/test/job-report.test.ts` covers a good option, a job without clear requirements, a job without description and an empty profile, an unrelated job, unclear location, different work mode, required versus preferred, suggested and rejected facts never used, Spanish postings and the absence of any score (`pnpm run test:unit`).
- [x] 2.2 Implement `jobReportBatchTransition`, `sortJobReportBatchItems` and `JOB_REPORT_BATCH_LIMITS` (50 jobs, five per pass, equal to `AI_LIMITS.automaticReservationsPerPass`); verify unit tests in the same file.

## 3. API

- [x] 3.1 Add `GET /api/v1/jobs/:id/report` and the batch routes in `apps/api/src/job-report-routes.ts`; verify `apps/api/test/job-reports.test.ts` against a disposable database (`pnpm run test:job-reports`, wired into CI): evidence and no score, unclear requirements and HTML feed text, other-workspace and unknown jobs, a batch with valid, failing and archived jobs sorted by conclusion, one failing report, pause and continue, cancel, idempotency and one active batch including a race, concurrent passes evaluating each job once, workspace isolation.
- [x] 3.2 Return `AI_SESSION_UNAVAILABLE` from the assistant preview when the authorized account's last check found no session; verify `apps/api/test/ai-routes-integration.test.ts` (`pnpm run test:ai`).

## 4. Interface

- [x] 4.1 Report card on the job page (`apps/dashboard/components/job-report.tsx`) and evaluation panel with per-job selection on Saved jobs (`apps/dashboard/components/job-report-batch.tsx`); Spanish and English labels in `apps/dashboard/lib/labels.ts`; verify `apps/dashboard/lib/labels.test.ts` checks every code has both languages and no conclusion contains a number (`pnpm run test:ui-logic`).
- [x] 4.2 Browser scenario `apps/api/e2e/job-reports.ts` (`E2E_ONLY=job-evaluation-report-and-batch pnpm run test:e2e`): report in Spanish and English with evidence and no score, job without clear requirements, 390 px without horizontal scroll, keyboard selection, confirmation with focus, pause before the first pass, continue, results order with a missing and an archived job, cancel, and the availability card's inner spacing.
