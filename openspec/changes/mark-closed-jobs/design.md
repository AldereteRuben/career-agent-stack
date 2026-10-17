# Design

## Context

See proposal.md (Why) and specs/job-availability/spec.md (requirements). What the code does today:

- **Followed company boards** (`apps/api/src/discovery.ts`, `refreshBoard`):
  - each refresh reports coverage `COMPLETE` or `PARTIAL` (`sourceReport.skipped`);
  - every listed job is written with `availability: 'OPEN'`, and its `job_occurrences` row gets `last_seen_at` and `last_successful_refresh_at`;
  - occurrences missing from a refresh are not touched.
- **Remotive and Arbeitnow** are read as whole public feeds by `loadProviderFeed` in `apps/api/src/job-search.ts`, cached in `job_search_provider_cache` and shared by every saved search in both pipelines (`job-search.ts` v1 and `search-execution.ts` v2):
  - a feed is `COMPLETE` when every page was read (Remotive has one page; Arbeitnow stops at a page limit and is then `BOUNDED`);
  - `job_search_sources` (provider, external id, `last_seen_at`) records only jobs that matched some search.
- **Himalayas** (`himalayasFeed` in `search-execution.ts`) is a per-query search capped at three pages; its results depend on the query, not on whether a job still exists.
- **Manual imports** create jobs with `availability: 'UNKNOWN'` and no source row.
- **The rest of the stack:**
  - `jobs.availability` is filtered by `GET /api/v1/jobs?availability=` but only ever set to `OPEN` or `UNKNOWN`;
  - there is no job history table;
  - applications reference jobs without a cascade (ADR 020's deletion order already handles that);
  - ADR 020's proof test fails if a new table is not placed in the deletion order.

## Goals / Non-Goals

**Goals:**
- One pure function decides a job's next availability from its sources, so the rule is unit-tested once and applied identically after every kind of read and after the person's actions.
- Absence is counted once per source read, not once per saved search, so jobs shared across searches behave like any other.
- No read that is partial, bounded, cached, stale, failed or suspicious can close anything.

**Non-Goals:**
- Fetching job detail pages or any extra request to look for closure signals; this change adds no network traffic.
- Per-source thresholds; one rule for all sources until evidence says otherwise.
- Re-deriving availability for jobs whose sources are no longer read.

## Decisions

1. **Counters on source rows, not a log of reads.**
   - **Data:**
     - `job_occurrences` and `job_search_sources` get `missed_complete_reads integer not null default 0`;
     - the board (`boards`) and the provider cache (`job_search_provider_cache`) get `last_complete_count integer` for the suspicious-read check.
   - **Presence** (brief §5): only a read made now in which every page read succeeded can mark a job seen (`last_seen_at = now`, counter 0): a `COMPLETE` board refresh, a freshly downloaded `COMPLETE` Remotive or Arbeitnow feed, or a freshly downloaded Himalayas result. This changes today's behavior, where a partial board refresh also updates `last_seen_at`. Suspicious complete reads still give presence for the jobs they list.
   - **Absence:** missing from a non-suspicious counting read → counter + 1.
   - **Alternative rejected:** storing every read's job list and computing streaks. It is exact but grows without bound and holds job lists the app does not otherwise need.
2. **Where absence is counted.**
   - **Boards:** inside the existing `refreshBoard` transaction, after the listed jobs are written, only when coverage is `COMPLETE` and the read is not suspicious. Every occurrence of that board that was not listed gets its counter increased.
   - **Remotive and Arbeitnow:** inside `loadProviderFeed`, in the same transaction that stores a **freshly downloaded** `COMPLETE` feed, so it happens exactly once per download however many searches use the feed. Cached reuse never counts.
     - The cache is global per provider, while `job_search_sources` rows belong to workspaces. A download is a public fact, so it updates that provider's source rows in **every** workspace, whichever search triggered it.
     - Re-evaluation and history are done per workspace (`workspace_id` on every query and event), so no workspace's rows or events mention another's.
   - **Himalayas:** only sets `last_seen_at` on matched sources; never counts absence.
3. **A pure decision function in `packages/domain`:**
   - `nextAvailability({ current, closedByUser, sources, now })`, where each source carries `canGiveAbsence`, `missedCompleteReads` and `lastSeenAt`;
   - it returns the new state, or nothing to change, plus a reason;
   - constants `ABSENCE_READS = 3` and `ABSENCE_MIN_HOURS = 48` live next to it, and ADR 021 records them.
   - **Alternative rejected:** SQL updates in each pipeline. The rule would be duplicated in three places and easy to drift.
4. **Re-evaluate only the jobs a read touched:** those listed, and those whose counter changed. They are re-evaluated in the same transaction, and their availability and history are written together.
5. **The person's decision is a flag, not a fifth state.**
   - `jobs.closed_by_user boolean not null default false`, with `availability = 'CLOSED'`.
   - Sources keep counting while it is set, so the page can say "a source still lists it", but the decision function returns `CLOSED` while the flag is set.
   - Reopening clears the flag, sets `OPEN`, and resets every counter of the job.
   - **Alternative rejected:** a `CLOSED_BY_USER` availability value. It would need changing the shared enum, the filter and every consumer.
6. **History table** `job_availability_events`:
   - columns: id, workspace_id, job_id (cascade), from_state, to_state, reason (`ABSENT_FROM_SOURCES`, `SEEN_AGAIN`, `CLOSED_BY_USER`, `REOPENED_BY_USER`), created_at;
   - no job text;
   - placed in ADR 020's deletion order (it cascades from jobs, so any position before `jobs` works).
7. **Routes:**
   - `POST /api/v1/jobs/:id/availability` with `{ action: 'close' | 'reopen', expectedAvailability }`; a mismatch gives `409 STALE_JOB_AVAILABILITY`, and the current state is returned;
   - `GET /api/v1/jobs/:id` gains the availability history and whether a source still lists a user-closed job.
8. **Writers stop forcing `OPEN`.** The board, v1 and v2 writers currently set `availability: 'OPEN'` on every sighting. They will instead create new jobs as `OPEN` and leave existing jobs to the decision function, so a user-closed job is not reopened by a sighting.
9. **UI:**
   - the job page shows the state, its latest reason and the history, with Close and Reopen buttons;
   - lists and My applications show a text badge;
   - starting preparation for a non-`OPEN` job shows a warning notice.
   - All texts are in Spanish and English; nothing relies on color alone.

## Risks / Trade-offs

- [A provider returns a truncated feed that still claims to be complete] → the suspicious-read rule (empty, or under half the previous complete count) gives no absence evidence. 48 hours and three reads are also required.
- [A real mass closure, such as a company removing most postings, is ignored once as suspicious] → the next complete read compares against the last complete count, which the suspicious read does not update, so it will count. Accepted delay of one read.
- [Counting inside existing transactions makes board refreshes and feed downloads slower] → one update per source row per read, scoped by board or provider; feed sizes (about a thousand jobs) are well within this.
- [Two pipelines (v1, v2) share `loadProviderFeed`] → counting lives only there, so both get it once; tests cover both.
- [A user-closed job keeps accumulating counters] → harmless; they reset on reopen.
- [Jobs from boards later disabled keep their last state forever] → documented limit; the person can close them.

## Migration Plan

1. Migration `0013` (after ADR 020's `0012`): add the counter columns with default 0, `last_complete_count` nullable, `jobs.closed_by_user` default false, and the history table.
   - Existing jobs keep their availability. The first counting read after upgrade starts the streak from zero, so nothing becomes possibly closed before 3 complete reads after the upgrade have missed it. A job last seen more than 48 hours before the upgrade can become possibly closed on that third read.
2. Add `job_availability_events` to `DELETION_ORDER` in `apps/api/src/workspace-deletion.ts`. Its proof test enforces this.
3. Rollback: the columns and the table are additive. An older build ignores them; `POSSIBLY_CLOSED` and `CLOSED` were already valid values.
