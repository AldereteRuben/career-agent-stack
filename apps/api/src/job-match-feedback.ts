import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, gte } from 'drizzle-orm';
import { db, jobMatchFeedback, jobs } from '@career/db';

export const jobFeedbackReasons = ['LOCATION', 'SENIORITY', 'WORK_MODE', 'ROLE_TYPE', 'REQUIREMENT', 'OTHER'] as const;
export type JobFeedbackReason = typeof jobFeedbackReasons[number];
export type JobFeedbackRating = 'INTERESTED' | 'NOT_FOR_ME';
export type JobFeedbackInput = { rating: JobFeedbackRating; reason: JobFeedbackReason | null };
export const jobFeedbackWindowDays = 90;
export const jobFeedbackMinimumSample = 5;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseJobFeedback(value: unknown): JobFeedbackInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'rating' && key !== 'reason')) return null;
  if (body.rating !== 'INTERESTED' && body.rating !== 'NOT_FOR_ME') return null;
  if (body.reason !== undefined && body.reason !== null && !jobFeedbackReasons.includes(body.reason as JobFeedbackReason)) return null;
  return { rating: body.rating, reason: (body.reason as JobFeedbackReason | null | undefined) ?? null };
}

export function summarizeJobFeedback(rows: Array<{ rating: JobFeedbackRating; reason: JobFeedbackReason | null; updatedAt: Date | string }>, now = new Date()) {
  const periodStart = new Date(now.getTime() - jobFeedbackWindowDays * 24 * 60 * 60 * 1000);
  const recent = rows.filter((row) => new Date(row.updatedAt).getTime() >= periodStart.getTime() && new Date(row.updatedAt).getTime() <= now.getTime());
  const notForMe = recent.filter((row) => row.rating === 'NOT_FOR_ME');
  const counts = new Map<JobFeedbackReason, number>();
  for (const row of notForMe) if (row.reason) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
  const patterns = notForMe.length < jobFeedbackMinimumSample ? [] : jobFeedbackReasons.flatMap((reason) => {
    const count = counts.get(reason) ?? 0;
    return count >= jobFeedbackMinimumSample ? [{ reason, count }] : [];
  });
  return {
    periodStart: periodStart.toISOString(), periodEnd: now.toISOString(), windowDays: jobFeedbackWindowDays,
    total: recent.length, interested: recent.length - notForMe.length, notForMe: notForMe.length,
    minimumSample: jobFeedbackMinimumSample, patterns,
  };
}

export function registerJobMatchFeedbackRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string) {
  const findJob = async (workspaceId: string, jobId: string) => {
    if (!uuid.test(jobId)) return false;
    return Boolean((await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.id, jobId))).limit(1))[0]);
  };

  app.get('/api/v1/job-feedback/summary', async (request) => {
    const id = workspace(request); const cutoff = new Date(Date.now() - jobFeedbackWindowDays * 24 * 60 * 60 * 1000);
    const rows = await db.select({ rating: jobMatchFeedback.rating, reason: jobMatchFeedback.reason, updatedAt: jobMatchFeedback.updatedAt })
      .from(jobMatchFeedback).where(and(eq(jobMatchFeedback.workspaceId, id), gte(jobMatchFeedback.updatedAt, cutoff))).orderBy(desc(jobMatchFeedback.updatedAt));
    return summarizeJobFeedback(rows as Array<{ rating: JobFeedbackRating; reason: JobFeedbackReason | null; updatedAt: Date }>);
  });

  app.get('/api/v1/jobs/:jobId/feedback', async (request, reply) => {
    const id = workspace(request); const { jobId } = request.params as { jobId: string };
    if (!(await findJob(id, jobId))) return reply.code(404).send({ error: 'NOT_FOUND' });
    return (await db.select().from(jobMatchFeedback).where(and(eq(jobMatchFeedback.workspaceId, id), eq(jobMatchFeedback.jobId, jobId))).limit(1))[0] ?? null;
  });

  app.put('/api/v1/jobs/:jobId/feedback', async (request, reply) => {
    const id = workspace(request); const { jobId } = request.params as { jobId: string };
    if (!(await findJob(id, jobId))) return reply.code(404).send({ error: 'NOT_FOUND' });
    const input = parseJobFeedback(request.body);
    if (!input) return reply.code(400).send({ error: 'INVALID_JOB_FEEDBACK' });
    return (await db.insert(jobMatchFeedback).values({ workspaceId: id, jobId, ...input }).onConflictDoUpdate({
      target: [jobMatchFeedback.workspaceId, jobMatchFeedback.jobId], set: { ...input, updatedAt: new Date() },
    }).returning())[0];
  });

  app.delete('/api/v1/jobs/:jobId/feedback', async (request, reply) => {
    const id = workspace(request); const { jobId } = request.params as { jobId: string };
    if (!(await findJob(id, jobId))) return reply.code(404).send({ error: 'NOT_FOUND' });
    await db.delete(jobMatchFeedback).where(and(eq(jobMatchFeedback.workspaceId, id), eq(jobMatchFeedback.jobId, jobId)));
    return { ok: true };
  });
}
