# 022 — Job evaluation reports and batches decide with rules, not a model

Status: **accepted** (issues [#109](https://github.com/AldereteRuben/career-agent-stack/issues/109) and [#110](https://github.com/AldereteRuben/career-agent-stack/issues/110)); planned in the OpenSpec change `openspec/changes/job-evaluation-reports/`. Date: 2026-10-17.

## Context

The person wants to know whether a job is worth applying to, and to compare many saved jobs at once. The app already recognises known skills in a posting and compares them with approved facts (`computeJobMatch`), and offers Codex help for a job only after a preview of what is shared and a consent. A conclusion that looks like a hiring probability, or one built from facts the person did not approve, would mislead.

## Decision

1. **The conclusion is one of three words** — "Good option", "Worth reviewing", "Probably not a fit" — chosen by fixed, conservative rules in `packages/domain/src/job-report.ts`. "Good option" needs positive evidence on every axis the report can read; "Probably not a fit" needs evidence against; missing information is always "Worth reviewing".
2. **No score, percentage or probability appears in the report.** The existing fit score stays in its optional section, explained as not a hiring probability.
3. **Only approved facts and the posting's own sentences are evidence.** Suggested and rejected facts are never read.
4. **The report never contacts an assistant.** It links to the existing consented "Understand this job" request, which shares only the posting after a preview. Batches never use Codex, so the automatic analysis daily limit does not apply to them; they reuse its pass size of five.
5. **Batches advance one pass per request, driven by the open page**, under a row lock, so pausing, cancelling and repeated requests are safe without a background worker. At most 50 jobs per batch and one running or paused batch per workspace.

## Consequences

- Reports are reproducible and testable, and work for everyone without an account.
- Recognition is limited to the known skill list; jobs outside it usually conclude "Worth reviewing" and say requirements were not recognised.
- A batch stops advancing when Saved jobs is closed and continues when the person returns.
- A future Codex-written report would need its own operation, consent covering approved facts, and the per-pass and daily limits of automatic analysis.
