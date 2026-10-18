# Proposal

## Why

Each job shows an explainable match today, but nothing helps the person decide calmly whether a job is worth applying to ([#109](https://github.com/AldereteRuben/career-agent-stack/issues/109)). With many saved jobs, opening them one by one is slow ([#110](https://github.com/AldereteRuben/career-agent-stack/issues/110)). Both must work without an AI account and must never invent experience or suggest a hiring probability.

## What Changes

- **A report on every job page, without any action**, computed locally from the job text and the person's approved facts and preferences, in four parts:
  1. what the job asks for, with the sentence of the posting and the approved facts that support it;
  2. what the job asks for that is not confirmed yet, with a link to the profile;
  3. details to check before applying: pay, work mode and location, each "stated", "not stated", "matches your preferences", "differs" or "to confirm", with the posting's words;
  4. what the report does not know (no description, no clear requirements, no confirmed facts, no target roles, unclear location, pay, work mode, work authorization).
- **Exactly three conclusions in words:** "Good option", "Worth reviewing", "Probably not a fit". Conservative rules ([ADR 022](../../../docs/decisions/022-job-evaluation-reports.md)): "good option" needs positive evidence on every axis; "probably not a fit" needs evidence against; missing data always means "worth reviewing". No score, percentage or probability is shown in the report.
- **Evaluate several saved jobs in one action** from Saved jobs: tick jobs (or all on the page), see how many will be evaluated and confirm, then the page evaluates them in passes of five (the automatic analysis pass size) while it stays open. Pause, continue and cancel never lose evaluated jobs. A job that no longer exists fails, an archived job is skipped, and a report that cannot be built fails only that job; each is explained. Results list every job with the most favourable conclusions first.
- **Bounded and idempotent batches:** at most 50 jobs per batch, one running or paused batch per workspace, an idempotency key per creation, passes serialized by a row lock so each job is evaluated once.
- **Codex stays separate and consented:** the report links to the existing "Understand this job" request, which previews exactly what is shared (only the posting) before anything is sent. Batches never use Codex.
- **Clearer Codex message:** an authorized Codex account whose last check found no signed-in session now says so (`AI_SESSION_UNAVAILABLE`, "check the account in Settings; no new authorization needed") instead of "connect your Codex account".

## Capabilities

### New Capabilities
- `job-evaluation-report`: the per-job report, its evidence, unknowns and three conclusions.
- `job-report-batches`: evaluating several saved jobs in bounded, pausable, cancellable passes.

### Modified Capabilities
<!-- None: openspec/specs/ is empty; existing behavior is documented in code and ADRs only. -->

## Impact

- **Domain:** `packages/domain/src/job-report.ts` (report, rules, batch transitions and ordering); `requirementTerms` exported from `matching.ts`.
- **Database:** migration `0017_job_report_batches.sql` adds `job_report_batches` and `job_report_batch_items`; both are in the deletion order (ADR 020) and the JSON export.
- **API:** `apps/api/src/job-report-routes.ts` (`GET /api/v1/jobs/:id/report`, `/api/v1/job-report-batches` create, current, read, advance, pause, resume, cancel); `AI_SESSION_UNAVAILABLE` in `ai-run-routes.ts`.
- **Dashboard:** report card on the job page, evaluation panel and per-job selection on Saved jobs, Spanish and English labels.
- **Docs:** ADR 022.
- **Out of scope:**
  - Codex-written reports or batches that call Codex; the issue's "five per pass and ten per UTC day" limits only apply when Codex is used, and batches here never use it;
  - showing a conclusion on job cards or sorting the whole Saved list by conclusion (the batch results are sorted instead);
  - evaluating batches in the background after the page is closed;
  - recognising requirements beyond the known skill list used by matching.
- **Limits that remain:**
  - requirements are recognised only from the fixed skill list, so roles outside it often stay "worth reviewing" with "no clear requirements";
  - required versus nice-to-have is read from words in the same sentence (ES/EN) and can be wrong;
  - a paused or running batch only advances while Saved jobs is open in a visible tab;
  - work authorization is never inferred, so it is always listed as unknown.
