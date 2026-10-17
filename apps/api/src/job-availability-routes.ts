/**
 * The person's side of ADR 021: closing and reopening a job, and the availability history and "a source still
 * lists it" note shown on the job page. Sources keep counting while a job is closed by the person.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { pool } from '@career/db';
import { jobAvailability, type JobAvailability } from '@career/domain';
import { FEED_PROVIDERS, setAvailability, type Queryable } from './job-availability.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AvailabilityEvent = { fromState: JobAvailability; toState: JobAvailability; reason: string; createdAt: Date };
export type AvailabilityDetail = { closedByUser: boolean; history: AvailabilityEvent[]; stillListedBySource: boolean };

/**
 * A job's availability history (oldest first) and, for a job the person closed, whether a source listed it in a
 * fresh read after it was closed: a board or public feed whose latest complete read included it, or a Himalayas
 * sighting.
 */
export async function availabilityDetail(db: Queryable, workspaceId: string, jobId: string): Promise<AvailabilityDetail> {
  const job = (await db.query('select closed_by_user from jobs where workspace_id = $1 and id = $2', [workspaceId, jobId])).rows[0];
  const history = (await db.query('select from_state, to_state, reason, created_at from job_availability_events where workspace_id = $1 and job_id = $2 order by created_at, id', [workspaceId, jobId])).rows
    .map((row) => ({ fromState: row.from_state as JobAvailability, toState: row.to_state as JobAvailability, reason: String(row.reason), createdAt: new Date(String(row.created_at)) }));
  const closedByUser = job?.closed_by_user === true;
  const closedAt = closedByUser ? [...history].reverse().find((event) => event.reason === 'CLOSED_BY_USER')?.createdAt ?? null : null;
  let stillListedBySource = false;
  if (closedAt) {
    const { rows } = await db.query(`select missed_complete_reads, last_seen_at, true as can_give_absence from job_occurrences where workspace_id = $1 and job_id = $2
      union all select missed_complete_reads, last_seen_at, provider = any($3::text[]) from job_search_sources where workspace_id = $1 and job_id = $2`, [workspaceId, jobId, [...FEED_PROVIDERS]]);
    stillListedBySource = rows.some((row) => row.last_seen_at !== null && new Date(String(row.last_seen_at)) >= closedAt && (row.can_give_absence !== true || Number(row.missed_complete_reads) === 0));
  }
  return { closedByUser, history, stillListedBySource };
}

type Outcome = { status: 200; availability: JobAvailability } | { status: 404 } | { status: 409; error: string; availability: JobAvailability };

/**
 * Closes or reopens a job if its availability is still the one the person saw. Closing works from any state;
 * reopening works from CLOSED or POSSIBLY_CLOSED and resets every absence count of the job.
 */
export async function changeAvailability(workspaceId: string, jobId: string, action: 'close' | 'reopen', expected: JobAvailability, now = new Date()): Promise<Outcome> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const job = (await client.query('select availability, closed_by_user from jobs where workspace_id = $1 and id = $2 for update', [workspaceId, jobId])).rows[0] as { availability: JobAvailability; closed_by_user: boolean } | undefined;
    const outcome = await (async (): Promise<Outcome> => {
      if (!job) return { status: 404 };
      const current = job.availability;
      if (current !== expected) return { status: 409, error: 'STALE_JOB_AVAILABILITY', availability: current };
      if (action === 'close') {
        if (job.closed_by_user) return { status: 409, error: 'JOB_ALREADY_CLOSED', availability: current };
        await client.query('update jobs set closed_by_user = true where workspace_id = $1 and id = $2', [workspaceId, jobId]);
        // Recorded even when the job was already CLOSED (data from before ADR 021): the decision and its time matter.
        await setAvailability(client, workspaceId, jobId, current, 'CLOSED', 'CLOSED_BY_USER', now);
        return { status: 200, availability: 'CLOSED' };
      }
      if (current !== 'CLOSED' && current !== 'POSSIBLY_CLOSED') return { status: 409, error: 'JOB_NOT_CLOSED', availability: current };
      await client.query('update jobs set closed_by_user = false where workspace_id = $1 and id = $2', [workspaceId, jobId]);
      await client.query('update job_occurrences set missed_complete_reads = 0 where workspace_id = $1 and job_id = $2', [workspaceId, jobId]);
      await client.query('update job_search_sources set missed_complete_reads = 0 where workspace_id = $1 and job_id = $2', [workspaceId, jobId]);
      await setAvailability(client, workspaceId, jobId, current, 'OPEN', 'REOPENED_BY_USER', now);
      return { status: 200, availability: 'OPEN' };
    })();
    await client.query(outcome.status === 200 ? 'COMMIT' : 'ROLLBACK');
    return outcome;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function registerJobAvailabilityRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string) {
  app.post('/api/v1/jobs/:id/availability', async (request, reply) => {
    const { id: jobId } = request.params as { id: string };
    if (!UUID.test(jobId)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const body = request.body as { action?: unknown; expectedAvailability?: unknown } | null;
    const action = body?.action; const expected = body?.expectedAvailability;
    if ((action !== 'close' && action !== 'reopen') || !(jobAvailability as readonly unknown[]).includes(expected)) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const outcome = await changeAvailability(workspaceId, jobId, action, expected as JobAvailability);
    if (outcome.status === 404) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (outcome.status === 409) return reply.code(409).send({ error: outcome.error, availability: outcome.availability });
    return { id: jobId, availability: outcome.availability, ...await availabilityDetail(pool, workspaceId, jobId) };
  });
}
