# Design

## Context

See proposal.md and the two spec deltas. What exists:

- `computeJobMatch` (`packages/domain/src/matching.ts`) recognises known skills in a posting, compares them with approved facts, aligns the title with target roles and checks location conservatively. It produces a 0–100 fit score shown as "not a hiring probability".
- Codex help for a job (`JOB_ANALYSIS`) goes through a preview that lists what will be shared and a consent per operation. Automatic analysis is limited to five reservations per pass and ten starts per UTC day (`AI_LIMITS`).
- Job descriptions live in `job_snapshots`; public feed snapshots are HTML converted for display with `plainDescription`.

## Goals / Non-Goals

**Goals:**
- One pure function builds the report, so its rules are unit-tested once and used by the job page and batches alike.
- The report is useful without any account and never shares data.
- Batches survive pauses, cancellations, failures and repeated or concurrent requests without evaluating a job twice.

**Non-Goals:**
- Replacing the fit score elsewhere; it stays in the optional "Fit with your profile" section.
- Background batch workers.

## Decisions

1. **Rules, not a model, decide the conclusion** (ADR 022). "Good option" requires: a description with recognised requirements, at least one approved fact, at least two thirds of requirements backed, no *required* requirement unconfirmed, a title matching a target role, a location that is not stated-but-unclear and a work mode that does not differ. "Probably not a fit" requires an incompatible location, or a non-target title with at most a third backed, or three or more requirements with none backed. Everything else is "worth reviewing".
2. **Evidence is quoted, not paraphrased:** each requirement carries the first posting sentence that names it and up to three approved facts that mention it. Suggested and rejected facts are never read.
3. **No numbers that read as probability:** the report type has no score field; the UI shows counts of requirements ("2 of 2 recognised requirements backed") only in batch results.
4. **Batches are driven by the page, one pass per request.** `POST …/advance` locks the batch row, evaluates up to five pending items and completes the batch when none remain. Passes, pauses and cancellations serialize on that lock; only `PENDING` items are evaluated, so repeating or racing requests are harmless. The page loops while the batch runs and the tab is visible, with a short pause between passes.
5. **Creation is idempotent and exclusive:** an advisory lock per workspace covers the idempotency check and the one-active-batch check; a partial unique index enforces one running or paused batch. A replayed key with the same jobs returns the batch; with different jobs, `409 IDEMPOTENCY_CONFLICT`.
6. **Items keep labels and reports, not references:** items store company, title and the report so a job that disappears is shown as failed and evaluated jobs survive cancelling. Job IDs from another workspace are stored without labels and fail as "not found".
7. **`AI_SESSION_UNAVAILABLE`:** the preview distinguishes "no authorized account" from "authorized, but the last check found no signed-in session". Authorization rules are unchanged.

## Risks / Trade-offs

- **Coarse requirement recognition** → shown as an explicit unknown and stated in the report footer.
- **A batch only advances with the page open** → the panel says so; a paused or running batch is shown again when the person returns.
- **Stored reports age** → batch results are a snapshot of when they ran; the job page always shows the current report.
