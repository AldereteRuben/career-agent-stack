/**
 * Job evaluation reports (#109) and batches of them (#110). Reports are computed locally from the job and the
 * person's approved facts; nothing here contacts an assistant or any other service. A batch is evaluated in passes
 * of at most JOB_REPORT_BATCH_LIMITS.perPass jobs, each pass under a row lock on the batch, so concurrent passes,
 * pauses and cancellations serialize and an item is evaluated at most once.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, jobReportBatchItems, jobReportBatches, jobs, jobSearchSources } from '@career/db';
import {
  buildJobReport, buildSkillGapReport, jobReportBatchTransition, sortJobReportBatchItems, JOB_REPORT_BATCH_LIMITS, JOB_REPORT_VERSION,
  type JobReportBatchItemError, type JobReportBatchItemState, type JobReportBatchState, type JobReportVerdict,
} from '@career/domain';
import { plainDescription } from './job-search-sources.js';
import { latestDescriptions, loadMatchingContext, lockKey, type Executor, type Tx } from './workspace-data.js';

export type ReportBuilder = typeof buildJobReport;

const idParams = z.object({ id: z.uuid() }).strict();
const createSchema = z.object({
  jobIds: z.array(z.uuid()).min(1).max(JOB_REPORT_BATCH_LIMITS.maxJobs).refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, 'Duplicate job.'),
  idempotencyKey: z.uuid(),
}).strict();
const batchLockKey = (workspaceId: string) => `job-report-batch:${workspaceId}`;

/** Posting text as the job page shows it: public feed snapshots are converted from HTML to readable text. */
async function readableDescriptions(executor: Executor, workspaceId: string, jobIds: string[]) {
  // Sequential: a transaction is one connection, which runs one query at a time.
  const descriptions = await latestDescriptions(executor, workspaceId, jobIds);
  const fromFeeds = jobIds.length ? await executor.selectDistinct({ jobId: jobSearchSources.jobId }).from(jobSearchSources).where(and(eq(jobSearchSources.workspaceId, workspaceId), inArray(jobSearchSources.jobId, jobIds))) : [];
  const feed = new Set(fromFeeds.map((row) => row.jobId));
  return new Map(jobIds.map((id) => {
    const description = descriptions.get(id) ?? null;
    return [id, feed.has(id) ? plainDescription(description) : description];
  }));
}

type BatchRow = typeof jobReportBatches.$inferSelect;
type ItemRow = typeof jobReportBatchItems.$inferSelect;

function batchView(batch: BatchRow, items: ItemRow[]) {
  const counts = { pending: 0, done: 0, failed: 0, skipped: 0 };
  for (const item of items) counts[item.status.toLowerCase() as keyof typeof counts] += 1;
  return {
    id: batch.id, status: batch.status as JobReportBatchState, total: batch.total, counts,
    createdAt: batch.createdAt, updatedAt: batch.updatedAt, finishedAt: batch.finishedAt,
    items: sortJobReportBatchItems(items.map((item) => ({
      jobId: item.jobId, position: item.position, company: item.company, title: item.title,
      status: item.status as JobReportBatchItemState, verdict: item.verdict as JobReportVerdict | null, errorCode: item.errorCode as JobReportBatchItemError | null,
      supportedCount: item.report?.supported.length ?? null, requirementCount: item.report ? item.report.supported.length + item.report.unconfirmed.length : null,
      evaluatedAt: item.evaluatedAt,
    }))),
  };
}

async function readBatch(executor: Executor, workspaceId: string, batchId: string) {
  const batch = (await executor.select().from(jobReportBatches).where(and(eq(jobReportBatches.workspaceId, workspaceId), eq(jobReportBatches.id, batchId))).limit(1))[0];
  if (!batch) return null;
  const items = await executor.select().from(jobReportBatchItems).where(and(eq(jobReportBatchItems.workspaceId, workspaceId), eq(jobReportBatchItems.batchId, batchId))).orderBy(asc(jobReportBatchItems.position));
  return batchView(batch, items);
}

const lockBatch = async (tx: Tx, workspaceId: string, batchId: string) =>
  (await tx.select().from(jobReportBatches).where(and(eq(jobReportBatches.workspaceId, workspaceId), eq(jobReportBatches.id, batchId))).for('update').limit(1))[0];

/**
 * Evaluates the next pending items of a running batch, at most one pass. A job that no longer exists fails, an
 * archived job is skipped, and a report that cannot be built fails that job only. Completes the batch when nothing
 * is pending. Returns false when the batch does not exist.
 */
export async function advanceJobReportBatch(workspaceId: string, batchId: string, options: { build?: ReportBuilder; now?: Date } = {}) {
  const build = options.build ?? buildJobReport;
  return db.transaction(async (tx) => {
    const batch = await lockBatch(tx, workspaceId, batchId);
    if (!batch) return false;
    if (batch.status !== 'RUNNING') return true;
    const now = options.now ?? new Date();
    const pending = await tx.select().from(jobReportBatchItems)
      .where(and(eq(jobReportBatchItems.workspaceId, workspaceId), eq(jobReportBatchItems.batchId, batchId), eq(jobReportBatchItems.status, 'PENDING')))
      .orderBy(asc(jobReportBatchItems.position)).limit(JOB_REPORT_BATCH_LIMITS.perPass + 1);
    const pass = pending.slice(0, JOB_REPORT_BATCH_LIMITS.perPass);
    if (pass.length) {
      const ids = pass.map((item) => item.jobId);
      const context = await loadMatchingContext(tx, workspaceId);
      const rows = await tx.select().from(jobs).where(and(eq(jobs.workspaceId, workspaceId), inArray(jobs.id, ids)));
      const descriptions = await readableDescriptions(tx, workspaceId, ids);
      const found = new Map(rows.map((row) => [row.id, row]));
      for (const item of pass) {
        const job = found.get(item.jobId);
        let patch: Partial<ItemRow>;
        if (!job) patch = { status: 'FAILED', errorCode: 'JOB_NOT_FOUND' };
        else if (job.shortlistDecision === 'ARCHIVED') patch = { status: 'SKIPPED', errorCode: 'JOB_ARCHIVED', company: job.company, title: job.title };
        else {
          try {
            const report = build({ title: job.title, location: job.location, description: descriptions.get(job.id) ?? null }, context);
            patch = { status: 'DONE', verdict: report.verdict, report, errorCode: null, company: job.company, title: job.title };
          } catch {
            patch = { status: 'FAILED', errorCode: 'REPORT_FAILED', company: job.company, title: job.title };
          }
        }
        await tx.update(jobReportBatchItems).set({ ...patch, evaluatedAt: now })
          .where(and(eq(jobReportBatchItems.workspaceId, workspaceId), eq(jobReportBatchItems.batchId, batchId), eq(jobReportBatchItems.jobId, item.jobId), eq(jobReportBatchItems.status, 'PENDING')));
      }
    }
    const finished = pending.length <= JOB_REPORT_BATCH_LIMITS.perPass;
    await tx.update(jobReportBatches).set({ updatedAt: now, ...(finished ? { status: 'COMPLETED', finishedAt: now } : {}) })
      .where(and(eq(jobReportBatches.workspaceId, workspaceId), eq(jobReportBatches.id, batchId)));
    return true;
  });
}

type CreateOutcome = { status: 201 | 200; batchId: string } | { status: 409; error: 'JOB_REPORT_BATCH_ACTIVE' | 'IDEMPOTENCY_CONFLICT'; batchId: string };

/** Creates a running batch, or returns the one this idempotency key already created for the same jobs. */
export async function createJobReportBatch(workspaceId: string, input: z.infer<typeof createSchema>): Promise<CreateOutcome> {
  const jobIds = input.jobIds.map((id) => id.toLowerCase());
  return db.transaction(async (tx) => {
    await lockKey(tx, batchLockKey(workspaceId));
    const prior = (await tx.select().from(jobReportBatches).where(and(eq(jobReportBatches.workspaceId, workspaceId), eq(jobReportBatches.idempotencyKey, input.idempotencyKey))).limit(1))[0];
    if (prior) {
      const priorIds = (await tx.select({ jobId: jobReportBatchItems.jobId }).from(jobReportBatchItems).where(and(eq(jobReportBatchItems.workspaceId, workspaceId), eq(jobReportBatchItems.batchId, prior.id)))).map((row) => row.jobId).sort();
      const same = priorIds.length === jobIds.length && [...jobIds].sort().every((id, index) => id === priorIds[index]);
      return same ? { status: 200, batchId: prior.id } : { status: 409, error: 'IDEMPOTENCY_CONFLICT', batchId: prior.id };
    }
    const active = (await tx.select({ id: jobReportBatches.id }).from(jobReportBatches).where(and(eq(jobReportBatches.workspaceId, workspaceId), inArray(jobReportBatches.status, ['RUNNING', 'PAUSED']))).limit(1))[0];
    if (active) return { status: 409, error: 'JOB_REPORT_BATCH_ACTIVE', batchId: active.id };
    // Labels let the person recognise every job, including one that disappears before its turn.
    const rows = await tx.select({ id: jobs.id, company: jobs.company, title: jobs.title }).from(jobs).where(and(eq(jobs.workspaceId, workspaceId), inArray(jobs.id, jobIds)));
    const labels = new Map(rows.map((row) => [row.id, row]));
    const batch = (await tx.insert(jobReportBatches).values({ workspaceId, idempotencyKey: input.idempotencyKey, total: jobIds.length, reportVersion: JOB_REPORT_VERSION }).returning())[0]!;
    await tx.insert(jobReportBatchItems).values(jobIds.map((jobId, position) => ({ workspaceId, batchId: batch.id, jobId, position, company: labels.get(jobId)?.company ?? null, title: labels.get(jobId)?.title ?? null })));
    return { status: 201, batchId: batch.id };
  });
}

/** Pauses, resumes or cancels. Cancelling keeps every evaluated job and marks the rest as skipped. */
export async function changeJobReportBatch(workspaceId: string, batchId: string, action: 'pause' | 'resume' | 'cancel', now = new Date()) {
  return db.transaction(async (tx) => {
    const batch = await lockBatch(tx, workspaceId, batchId);
    if (!batch) return 'NOT_FOUND' as const;
    const next = jobReportBatchTransition(batch.status as JobReportBatchState, action);
    if (!next.ok) return 'INVALID_TRANSITION' as const;
    if (!next.changed) return 'OK' as const;
    await tx.update(jobReportBatches).set({ status: next.state, updatedAt: now, ...(next.state === 'CANCELLED' ? { finishedAt: now } : {}) })
      .where(and(eq(jobReportBatches.workspaceId, workspaceId), eq(jobReportBatches.id, batchId)));
    if (next.state === 'CANCELLED') {
      await tx.update(jobReportBatchItems).set({ status: 'SKIPPED', errorCode: 'CANCELLED' })
        .where(and(eq(jobReportBatchItems.workspaceId, workspaceId), eq(jobReportBatchItems.batchId, batchId), eq(jobReportBatchItems.status, 'PENDING')));
    }
    return 'OK' as const;
  });
}

export function registerJobReportRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, options: { build?: ReportBuilder } = {}) {
  const build = options.build ?? buildJobReport;
  app.get('/api/v1/skill-gap-report', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const workspaceId = workspace(request);
    const savedJobs = await db.select({ id: jobs.id, company: jobs.company, title: jobs.title, canonicalUrl: jobs.canonicalUrl, location: jobs.location })
      .from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.shortlistDecision, 'SHORTLISTED'))).orderBy(desc(jobs.savedAt), desc(jobs.id));
    const jobIds = savedJobs.map((job) => job.id);
    const [context, descriptions] = await Promise.all([loadMatchingContext(db, workspaceId), readableDescriptions(db, workspaceId, jobIds)]);
    return buildSkillGapReport(savedJobs.map((job) => ({ ...job, description: descriptions.get(job.id) ?? null })), context);
  });

  app.get('/api/v1/jobs/:id/report', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'NOT_FOUND' });
    const workspaceId = workspace(request);
    const job = (await db.select().from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.id, params.data.id))).limit(1))[0];
    if (!job) return reply.code(404).send({ error: 'NOT_FOUND' });
    const [context, descriptions] = await Promise.all([loadMatchingContext(db, workspaceId), readableDescriptions(db, workspaceId, [job.id])]);
    return { jobId: job.id, report: build({ title: job.title, location: job.location, description: descriptions.get(job.id) ?? null }, context) };
  });

  app.post('/api/v1/job-report-batches', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'INVALID_INPUT', detail: body.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
    const workspaceId = workspace(request);
    const outcome = await createJobReportBatch(workspaceId, body.data);
    if (outcome.status === 409) return reply.code(409).send({ error: outcome.error, detail: outcome.batchId });
    return reply.code(outcome.status).send(await readBatch(db, workspaceId, outcome.batchId));
  });
  /** The running or paused batch, otherwise the latest one; null when there is none. */
  app.get('/api/v1/job-report-batches/current', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const workspaceId = workspace(request);
    const [active] = await db.select({ id: jobReportBatches.id }).from(jobReportBatches).where(and(eq(jobReportBatches.workspaceId, workspaceId), inArray(jobReportBatches.status, ['RUNNING', 'PAUSED']))).limit(1);
    const [latest] = active ? [active] : await db.select({ id: jobReportBatches.id }).from(jobReportBatches).where(eq(jobReportBatches.workspaceId, workspaceId)).orderBy(desc(jobReportBatches.createdAt), desc(jobReportBatches.id)).limit(1);
    return { batch: latest ? await readBatch(db, workspaceId, latest.id) : null };
  });
  app.get('/api/v1/job-report-batches/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'NOT_FOUND' });
    return await readBatch(db, workspace(request), params.data.id) ?? reply.code(404).send({ error: 'NOT_FOUND' });
  });
  /** Runs one pass. Safe to repeat: only pending items of a running batch are evaluated. */
  app.post('/api/v1/job-report-batches/:id/advance', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'NOT_FOUND' });
    const workspaceId = workspace(request);
    if (!await advanceJobReportBatch(workspaceId, params.data.id, { build })) return reply.code(404).send({ error: 'NOT_FOUND' });
    return readBatch(db, workspaceId, params.data.id);
  });
  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/api/v1/job-report-batches/:id/${action}`, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const params = idParams.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'NOT_FOUND' });
      const workspaceId = workspace(request);
      const outcome = await changeJobReportBatch(workspaceId, params.data.id, action);
      if (outcome === 'NOT_FOUND') return reply.code(404).send({ error: 'NOT_FOUND' });
      const view = await readBatch(db, workspaceId, params.data.id);
      if (outcome === 'INVALID_TRANSITION') return reply.code(409).send({ error: 'JOB_REPORT_BATCH_FINISHED', detail: view?.status });
      return view;
    });
  }
}
