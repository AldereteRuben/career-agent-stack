import { db, jobs } from '@career/db';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { lockJobIdentity } from './job-identity.js';

/** One definition of "reviewed" shared by searches (v1/v2, combined), /jobs, summary and discovery counts.
 * A job is reviewed when any surface marked it seen: `jobs.seen_at` (global review), a per-search review
 * written by an earlier release (`search_job_reviews.seen_at`), or a save/skip/archive decision. New = not reviewed.
 * Restoring a job (decision back to UNREVIEWED) keeps it reviewed: it returns to Active/All, never to New.
 * Reviews and decisions propagate to strong-identity duplicates unless the identity group is conflicted
 * (different decisions or applications), in which case each record keeps its own state.
 * Fragments interpolate only fixed table aliases, never request input. */
export const reviewedJobsCte = (workspaceParam: string) => `SELECT job_id,min(seen_at) AS seen_at FROM search_job_reviews WHERE workspace_id=${workspaceParam} AND seen_at IS NOT NULL GROUP BY job_id`;
export const effectiveSeenAtSql = (job: string, reviewed: string) => `coalesce(${job}.seen_at,${reviewed}.seen_at,CASE WHEN ${job}.shortlist_decision<>'UNREVIEWED' THEN ${job}.updated_at END)`;
/** Row filter form of the same predicate. The review subquery is uncorrelated so PostgreSQL hashes it once
 * instead of probing per row (a correlated anti-join measured >1s for 10,000 fresh, unanalyzed rows). */
export const isNewJobSql = (job: string, workspaceParam: string) => `(${job}.seen_at IS NULL AND ${job}.shortlist_decision='UNREVIEWED'
  AND ${job}.id NOT IN(SELECT review.job_id FROM search_job_reviews review WHERE review.workspace_id=${workspaceParam} AND review.seen_at IS NOT NULL))`;
/** isNewJobSql for drizzle queries over the unaliased jobs table. */
export const isNewJob = (workspaceId: string): SQL => { const [before, after] = isNewJobSql('"jobs"', '\u0000').split('\u0000'); return sql`${sql.raw(before!)}${workspaceId}::uuid${sql.raw(after!)}`; };

/** The job plus its strong-identity duplicates, unless that identity group has conflicting decisions or applications. */
export const sameVacancySql = (workspaceId: string, jobId: string): SQL => sql`SELECT ${jobId}::uuid UNION SELECT b.job_id FROM job_identity_members a
  JOIN job_identity_members b ON b.workspace_id=a.workspace_id AND b.identity_key=a.identity_key WHERE a.workspace_id=${workspaceId} AND a.job_id=${jobId}::uuid
  AND NOT EXISTS(SELECT 1 FROM job_identity_members c JOIN jobs cj ON cj.workspace_id=c.workspace_id AND cj.id=c.job_id
    LEFT JOIN applications ca ON ca.workspace_id=c.workspace_id AND ca.job_id=c.job_id
    WHERE c.workspace_id=a.workspace_id AND c.identity_key=a.identity_key GROUP BY c.identity_key HAVING count(DISTINCT cj.shortlist_decision)>1 OR count(DISTINCT ca.id)>1)`;

type Executor = Pick<typeof db, 'execute'>;
/** Marks the vacancy reviewed everywhere. Call inside a transaction holding the workspace job-identity lock. Idempotent. */
export async function markJobReviewed(tx: Executor, workspaceId: string, jobId: string): Promise<boolean> {
  const updated = await tx.execute(sql`UPDATE jobs SET seen_at=coalesce(seen_at,now()) WHERE workspace_id=${workspaceId} AND id IN(${sameVacancySql(workspaceId, jobId)}) RETURNING id`);
  await tx.execute(sql`UPDATE search_job_reviews SET seen_at=now() WHERE workspace_id=${workspaceId} AND seen_at IS NULL AND job_id IN(${sameVacancySql(workspaceId, jobId)})`);
  return updated.rows.some((row) => row.id === jobId);
}

/** POST /jobs/:id/seen: reviewing from /jobs also clears the vacancy from every search inbox. */
export async function reviewJob(workspaceId: string, jobId: string): Promise<boolean> {
  return db.transaction(async (tx) => { await lockJobIdentity(tx, workspaceId); return markJobReviewed(tx, workspaceId, jobId); });
}

/** POST /jobs/:id/shortlist. Any decision, including restoring to UNREVIEWED, counts as a review:
 * the job leaves New and a restore returns it to Active/All, not to New. */
export async function decideJob(workspaceId: string, jobId: string, decision: string) {
  return db.transaction(async (tx) => {
    await lockJobIdentity(tx, workspaceId);
    await tx.execute(sql`UPDATE jobs SET shortlist_decision=${decision},updated_at=now() WHERE workspace_id=${workspaceId} AND id IN(${sameVacancySql(workspaceId, jobId)})`);
    await markJobReviewed(tx, workspaceId, jobId);
    return (await tx.select().from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.id, jobId))))[0] ?? null;
  });
}

type ReviewableJob = { id: string; seenAt: Date | null; shortlistDecision: string; updatedAt: Date };
/** Applies effectiveSeenAtSql to already loaded job rows so the NEW label matches the New lists and counts. */
export async function withEffectiveSeenAt<T extends ReviewableJob>(executor: Executor, workspaceId: string, rows: T[]): Promise<T[]> {
  const pending = rows.filter((row) => !row.seenAt).map((row) => row.id);
  const reviewed = new Map<string, Date>();
  if (pending.length) {
    const result = await executor.execute(sql`SELECT job_id,min(seen_at) AS seen_at FROM search_job_reviews WHERE workspace_id=${workspaceId}
      AND job_id IN(${sql.join(pending.map((id) => sql`${id}::uuid`), sql`,`)}) AND seen_at IS NOT NULL GROUP BY job_id`);
    for (const row of result.rows) reviewed.set(String(row.job_id), row.seen_at instanceof Date ? row.seen_at : new Date(String(row.seen_at)));
  }
  return rows.map((row) => row.seenAt ? row : { ...row, seenAt: reviewed.get(row.id) ?? (row.shortlistDecision !== 'UNREVIEWED' ? row.updatedAt : null) });
}
