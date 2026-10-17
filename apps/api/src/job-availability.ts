/**
 * Applies ADR 021 after each read: counts presence and absence per source, then re-evaluates the jobs a read
 * touched with the domain rule and records every change. Works on any SQL client in the caller's transaction, so
 * board refreshes (Drizzle), feed downloads and the v2 search writer (pg) all share one implementation.
 */
import { nextAvailability, suspiciousRead, type AvailabilityReason, type AvailabilitySource, type JobAvailability } from '@career/domain';
import { sql, type SQL } from 'drizzle-orm';

export type Queryable = { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };

/** A Queryable over a Drizzle transaction: `$n` placeholders become bound parameters. */
export function fromDrizzle(tx: { execute(query: SQL): Promise<unknown> }): Queryable {
  return {
    async query(text, values = []) {
      const parts = text.split(/\$(\d+)/);
      const chunks: SQL[] = [];
      // sql.param binds each value as one parameter: an array stays a PostgreSQL array instead of a list.
      parts.forEach((part, index) => { chunks.push(index % 2 ? sql`${sql.param(values[Number(part) - 1])}` : sql.raw(part)); });
      const result = await tx.execute(sql.join(chunks, sql.raw(''))) as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
      return { rows: Array.isArray(result) ? result : result.rows ?? [] };
    },
  };
}

/** Providers whose whole public feed is read, so a complete download can show absence (not Himalayas). */
export const FEED_PROVIDERS = new Set(['remotive', 'arbeitnow']);

const asDate = (value: unknown) => (value instanceof Date ? value : value ? new Date(String(value)) : null);

/**
 * Re-evaluates jobs of one workspace and records every change. Returns how many changed. The jobs are locked for
 * the rest of the caller's transaction, so concurrent reads cannot write conflicting history.
 */
export async function reevaluateJobs(db: Queryable, workspaceId: string, jobIds: Iterable<string>, now = new Date()) {
  const ids = [...new Set(jobIds)];
  if (!ids.length) return 0;
  const { rows: jobRows } = await db.query('select id, availability, closed_by_user from jobs where workspace_id = $1 and id = any($2::uuid[]) order by id for update', [workspaceId, ids]);
  const sources = new Map<string, AvailabilitySource[]>();
  const add = (jobId: string, source: AvailabilitySource) => { sources.set(jobId, [...(sources.get(jobId) ?? []), source]); };
  for (const row of (await db.query('select job_id, missed_complete_reads, last_seen_at from job_occurrences where workspace_id = $1 and job_id = any($2::uuid[])', [workspaceId, ids])).rows) {
    add(String(row.job_id), { canGiveAbsence: true, missedCompleteReads: Number(row.missed_complete_reads), lastSeenAt: asDate(row.last_seen_at) });
  }
  for (const row of (await db.query('select job_id, provider, missed_complete_reads, last_seen_at from job_search_sources where workspace_id = $1 and job_id = any($2::uuid[])', [workspaceId, ids])).rows) {
    add(String(row.job_id), { canGiveAbsence: FEED_PROVIDERS.has(String(row.provider)), missedCompleteReads: Number(row.missed_complete_reads), lastSeenAt: asDate(row.last_seen_at) });
  }
  let changed = 0;
  for (const job of jobRows) {
    const id = String(job.id); const current = String(job.availability) as JobAvailability;
    const change = nextAvailability({ current, closedByUser: job.closed_by_user === true, sources: sources.get(id) ?? [], now });
    if (!change) continue;
    await setAvailability(db, workspaceId, id, current, change.state, change.reason, now);
    changed += 1;
  }
  return changed;
}

/** Writes a job's new availability and its history entry. */
export async function setAvailability(db: Queryable, workspaceId: string, jobId: string, from: JobAvailability, to: JobAvailability, reason: AvailabilityReason, now = new Date()) {
  await db.query('update jobs set availability = $3, updated_at = $4 where workspace_id = $1 and id = $2', [workspaceId, jobId, to, now]);
  await db.query('insert into job_availability_events (workspace_id, job_id, from_state, to_state, reason, created_at) values ($1, $2, $3, $4, $5, $6)', [workspaceId, jobId, from, to, reason, now]);
}

/**
 * Counts a complete board refresh (ADR 021): listed occurrences were seen, the others missed it, unless the read
 * is suspicious. Returns the jobs to re-evaluate. Call only for COMPLETE refreshes, inside their transaction.
 */
export async function countCompleteBoardRead(db: Queryable, board: { id: string; workspaceId: string; provider: string; region: string; tenant: string; lastCompleteCount: number | null }, listedExternalIds: readonly string[], now = new Date()) {
  const key = [board.workspaceId, board.provider, board.region, board.tenant];
  const seen = await db.query(`update job_occurrences set last_seen_at = $6, missed_complete_reads = 0
    where workspace_id = $1 and provider = $2 and region = $3 and tenant = $4 and external_job_id = any($5::text[]) returning job_id`, [...key, [...listedExternalIds], now]);
  const touched = seen.rows.map((row) => String(row.job_id));
  if (!suspiciousRead(listedExternalIds.length, board.lastCompleteCount)) {
    const missed = await db.query(`update job_occurrences set missed_complete_reads = missed_complete_reads + 1
      where workspace_id = $1 and provider = $2 and region = $3 and tenant = $4 and not (external_job_id = any($5::text[])) returning job_id`, [...key, [...listedExternalIds]]);
    touched.push(...missed.rows.map((row) => String(row.job_id)));
    await db.query('update boards set last_complete_count = $3 where workspace_id = $1 and id = $2', [board.workspaceId, board.id, listedExternalIds.length]);
  }
  return touched;
}

/**
 * Counts a freshly downloaded, complete Remotive or Arbeitnow feed (ADR 021) for every workspace, since the feed is
 * public, then re-evaluates each workspace's touched jobs. Returns how many jobs changed in all.
 */
export async function countCompleteFeedRead(db: Queryable, provider: string, listedExternalIds: readonly string[], lastCompleteCount: number | null, now = new Date()) {
  const touched = new Map<string, Set<string>>();
  const note = (rows: Array<Record<string, unknown>>) => { for (const row of rows) { const ws = String(row.workspace_id); touched.set(ws, (touched.get(ws) ?? new Set()).add(String(row.job_id))); } };
  note((await db.query(`update job_search_sources set last_seen_at = $3, missed_complete_reads = 0
    where provider = $1 and external_id = any($2::text[]) returning workspace_id, job_id`, [provider, [...listedExternalIds], now])).rows);
  const suspicious = suspiciousRead(listedExternalIds.length, lastCompleteCount);
  if (!suspicious) {
    note((await db.query(`update job_search_sources set missed_complete_reads = missed_complete_reads + 1
      where provider = $1 and not (external_id = any($2::text[])) returning workspace_id, job_id`, [provider, [...listedExternalIds]])).rows);
  }
  let changed = 0;
  for (const [workspaceId, jobIds] of touched) changed += await reevaluateJobs(db, workspaceId, jobIds, now);
  return { changed, suspicious };
}
