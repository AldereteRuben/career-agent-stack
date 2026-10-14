# Proposal

## Why

Job availability has four states (`OPEN`, `POSSIBLY_CLOSED`, `CLOSED`, `UNKNOWN`) and the Availability filter offers all four, but no code ever sets `POSSIBLY_CLOSED` or `CLOSED` ([#35](https://github.com/AldereteRuben/career-agent-stack/issues/35)). A job withdrawn months ago still looks open, the person can prepare an application for it, and the filter offers states that never have results. The implementation brief (§5, "Refresh and lifecycle rules") already defines the intended behavior; this change implements it conservatively.

## What Changes

- **Absence evidence from complete reads only.** A job missing from a source counts as absent only when that source's read was complete:
  - a followed company board refresh with coverage `COMPLETE`;
  - a freshly downloaded `COMPLETE` Remotive or Arbeitnow public feed.

  Partial, bounded, cached, stale and failed reads never count. Himalayas returns query results (at most three pages), so its absence never counts, though its presence does.
- **`POSSIBLY_CLOSED` by a stated rule:** a job becomes `POSSIBLY_CLOSED` only when every source that can give absence evidence for it has missed it in **3 consecutive complete reads**, and **at least 48 hours** have passed since any source last saw it. The 48 hours are measured from that last sighting, not from the first miss or from a reopening. Proposed defaults, recorded in an ADR; the same rule for every source.
- **Back to `OPEN` automatically** when a source lists the job again in a fresh read in which every page succeeded (a complete board refresh, a newly downloaded complete Remotive or Arbeitnow feed, or a new Himalayas result), unless the person marked it closed. Partial refreshes and cached feeds give no presence (brief §5).
- **The person can mark a job closed or reopen it**, from the job page. Their decision wins over sources:
  - a job they closed stays `CLOSED` even if a source still lists it, and the page says so;
  - reopening resets the absence count.
- **History:** every availability change is recorded with its reason, and the job page shows it.
- **Clear display** on the job page, in job lists and in My applications. Applications are never cancelled or changed by a job's availability (brief §5 and §8); preparing an application for a job that is not `OPEN` shows a warning but is not blocked.
- **No provider closure signal yet:** `CLOSED` comes only from the person. No current source exposes a confirmed closure signal through the endpoints the app reads.

## Capabilities

### New Capabilities
- `job-availability`: how a job's availability is derived from its sources' complete reads, changed by the person, recorded in a history, and shown, without ever affecting applications.

### Modified Capabilities
<!-- None: openspec/specs/ is empty; existing behavior is documented in code and ADRs only. -->

## Impact

- **Database:** a migration adds absence counters to `job_occurrences` and `job_search_sources`, a `closed_by_user` marker on `jobs`, and a `job_availability_events` table, which must be added to the deletion order of ADR 020.
- **API:**
  - `apps/api/src/discovery.ts` (board refresh);
  - `apps/api/src/job-search.ts` (`loadProviderFeed`, shared by both search pipelines);
  - `apps/api/src/search-execution.ts` (Himalayas presence only);
  - a new availability module;
  - routes to close and reopen a job and to read its history.
- **Dashboard:** `apps/dashboard/app/jobs/[id]/page.tsx`, `apps/dashboard/app/jobs/page.tsx`, My applications, `apps/dashboard/lib/labels.ts`, Spanish and English texts.
- **Docs:** a new ADR (021) for the rule; README "current limits" updated.
- **Out of scope:**
  - provider-specific closure signals (detail endpoints returning 404);
  - closing jobs that only Himalayas or a manual import knows about, except by the person;
  - notifications about closed jobs;
  - changing any application automatically;
  - backfilling history for availability changes before this release.
- **Limits that remain:**
  - a job imported by hand stays `UNKNOWN` until the person marks it;
  - a source that stops being read (a board disabled or no longer approved, a provider removed from every search) gives no more evidence, so its jobs keep their last state;
  - a laptop that sleeps through refreshes delays `POSSIBLY_CLOSED`, because only reads that actually happen count.
