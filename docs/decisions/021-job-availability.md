# 021 — How a job becomes possibly closed or closed

Status: **accepted** (issue [#35](https://github.com/AldereteRuben/career-agent-stack/issues/35)); planned in the OpenSpec change `openspec/changes/mark-closed-jobs/` ([#107](https://github.com/AldereteRuben/career-agent-stack/pull/107)). Date: 2026-10-10.

## Context

A job's availability is `OPEN`, `POSSIBLY_CLOSED`, `CLOSED` or `UNKNOWN`, and the Availability filter offers all four, but until now no code set `POSSIBLY_CLOSED` or `CLOSED`. Jobs withdrawn long ago still looked open.

[Implementation brief](../implementation-brief.md) §5 ("Refresh and lifecycle rules") sets the principles:
- a completed refresh updates presence only after all pages succeeded;
- partial results, schema errors, timeouts and HTTP failures cannot mark missing jobs closed;
- after repeated complete refreshes show absence, mark `POSSIBLY_CLOSED`;
- `CLOSED` needs a provider-specific confirmed closure signal or the person's confirmation.

The sources read today:

| Source | What a read returns | Can its absence mean anything? |
|---|---|---|
| Followed company board (Greenhouse, Lever, Ashby) | The company's whole public listing; coverage `COMPLETE` or `PARTIAL` | Yes, when `COMPLETE` |
| Remotive public feed | The whole public feed, one page | Yes, when freshly downloaded |
| Arbeitnow public feed | The whole public feed, up to a page limit (`COMPLETE` or `BOUNDED`) | Yes, when freshly downloaded and `COMPLETE` |
| Himalayas | Results of one query, at most three pages | No: absence only means the query did not return it |
| Manual import | Nothing is read again | No |

## Decision

1. **Presence** comes only from a read made now in which every page read succeeded:
   - a `COMPLETE` board refresh;
   - a freshly downloaded `COMPLETE` Remotive or Arbeitnow feed;
   - a freshly downloaded Himalayas result.

   Partial refreshes, bounded, cached, stale and failed reads give no presence. A listed job resets that source's absence count.
2. **Absence** comes only from the same complete reads, never from Himalayas. A job missing from such a read adds one to that source's count.
3. **Suspicious reads give no absence:** a complete read that lists no jobs after a complete read that listed some, or that lists fewer than half as many as the previous complete read. The jobs such a read does list still count as seen.
4. **`POSSIBLY_CLOSED`:** a job becomes possibly closed when every source able to give absence evidence for it has missed it in **3 consecutive complete reads**, and **at least 48 hours** have passed since any source last saw it.
   - The same rule applies to every source. With the six-hour refresh interval, that is at least two days.
   - Jobs whose sources cannot give absence (Himalayas only, manual imports) keep their availability.
5. **Back to `OPEN`** automatically when a source counts the job as seen again.
6. **`CLOSED` comes only from the person.** No current source exposes a confirmed closure signal through the endpoints the app reads, and the app makes no extra requests to look for one.
   - The person's decision wins over sources: a job they closed stays `CLOSED` even if a source still lists it, and the job page says so.
   - Reopening resets every absence count of the job.
7. **History:** every change is recorded with its reason (absent from sources, seen again, closed by the person, reopened by the person). It holds no job content.
8. **Applications never change:** availability never cancels, submits, changes or blocks an application. Person-initiated preparation for a job that is not `OPEN` shows a warning and remains possible. Automatic preparation only attempts `OPEN` jobs; it skips `POSSIBLY_CLOSED`, `CLOSED`, and `UNKNOWN` without recording a failed attempt. A skipped job can enter the automatic queue if it becomes `OPEN` again.
9. **A shared Remotive or Arbeitnow download updates every workspace's sources**, because the feed is public. Each workspace is evaluated and recorded separately.

The thresholds (`3` reads, `48` hours, `50%` shrinkage) are constants next to the decision function in `packages/domain`. Changing them is a new decision.

## Consequences

- A job disappears from the "open" view only after about two days of consistent, complete evidence, and comes back as soon as it is seen again.
- One provider glitch (an empty or truncated "complete" feed) cannot close jobs in bulk.
- A real mass closure is counted one read late. The suspicious read does not update the comparison count, so the next complete read counts.
- A partial board refresh no longer updates when a job was last seen, which changes what "last seen" means for boards.

**Limits that remain:**
- A job imported by hand stays `UNKNOWN` until the person marks it.
- A job known only from Himalayas is never marked possibly closed.
- A source that is no longer read (a board disabled or no longer approved, a provider removed from every search) gives no more evidence, so its jobs keep their last state.
- A computer that sleeps through refreshes delays `POSSIBLY_CLOSED`, because only reads that actually happen count.

## Out of scope

- Provider closure signals from detail endpoints.
- Notifications about closed jobs.
- Changing applications.
- Backfilling history for changes before this release.
