import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, jobResearchNotes, jobs } from '@career/db';

const paramsSchema = z.object({ id: z.uuid() }).strict();
const notesSchema = z.object({
  business: z.string().max(4_000),
  model: z.string().max(4_000),
  news: z.string().max(4_000),
  culture: z.string().max(4_000),
  questions: z.string().max(4_000),
}).strict();
const bodySchema = z.object({ notes: notesSchema, expectedRevision: z.number().int().positive().nullable() }).strict();
const deleteSchema = z.object({ expectedRevision: z.number().int().positive().nullable() }).strict();
export type JobResearchNotes = z.infer<typeof notesSchema>;
const emptyNotes: JobResearchNotes = { business: '', model: '', news: '', culture: '', questions: '' };

export function registerJobResearchRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string) {
  app.get('/api/v1/jobs/:id/research-notes', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'NOT_FOUND' });
    const workspaceId = workspace(request);
    const job = (await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.id, params.data.id), eq(jobs.workspaceId, workspaceId))).limit(1))[0];
    if (!job) return reply.code(404).send({ error: 'NOT_FOUND' });
    const row = (await db.select({ notes: jobResearchNotes.notes, revision: jobResearchNotes.revision }).from(jobResearchNotes).where(and(eq(jobResearchNotes.workspaceId, workspaceId), eq(jobResearchNotes.jobId, job.id))).limit(1))[0];
    return { notes: row?.notes ?? emptyNotes, revision: row?.revision ?? null };
  });

  app.put('/api/v1/jobs/:id/research-notes', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = paramsSchema.safeParse(request.params);
    const body = bodySchema.safeParse(request.body);
    if (!params.success) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (!body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const result = await db.transaction(async (tx) => {
      const job = (await tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.id, params.data.id), eq(jobs.workspaceId, workspaceId))).for('update').limit(1))[0];
      if (!job) return { status: 'missing' as const };
      const current = (await tx.select({ revision: jobResearchNotes.revision }).from(jobResearchNotes).where(and(eq(jobResearchNotes.workspaceId, workspaceId), eq(jobResearchNotes.jobId, job.id))).limit(1))[0];
      if ((current?.revision ?? null) !== body.data.expectedRevision) return { status: 'conflict' as const };
      const revision = (current?.revision ?? 0) + 1;
      if (current) await tx.update(jobResearchNotes).set({ notes: body.data.notes, revision, updatedAt: new Date() }).where(and(eq(jobResearchNotes.workspaceId, workspaceId), eq(jobResearchNotes.jobId, job.id)));
      else await tx.insert(jobResearchNotes).values({ workspaceId, jobId: job.id, notes: body.data.notes, revision });
      return { status: 'saved' as const, revision };
    });
    if (result.status === 'missing') return reply.code(404).send({ error: 'NOT_FOUND' });
    if (result.status === 'conflict') return reply.code(409).send({ error: 'NOTES_CONFLICT' });
    return { notes: body.data.notes, revision: result.revision };
  });

  app.delete('/api/v1/jobs/:id/research-notes', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = paramsSchema.safeParse(request.params);
    const body = deleteSchema.safeParse(request.body);
    if (!params.success) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (!body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const result = await db.transaction(async (tx) => {
      const job = (await tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.id, params.data.id), eq(jobs.workspaceId, workspaceId))).for('update').limit(1))[0];
      if (!job) return 'missing' as const;
      const current = (await tx.select({ revision: jobResearchNotes.revision }).from(jobResearchNotes).where(and(eq(jobResearchNotes.workspaceId, workspaceId), eq(jobResearchNotes.jobId, job.id))).limit(1))[0];
      if ((current?.revision ?? null) !== body.data.expectedRevision) return 'conflict' as const;
      if (!current) return { status: 'cleared' as const, revision: null };
      const revision = current.revision + 1;
      // Keep only an empty revision marker so a deleted-and-recreated note cannot reuse an old revision token.
      await tx.update(jobResearchNotes).set({ notes: emptyNotes, revision, updatedAt: new Date() }).where(and(eq(jobResearchNotes.workspaceId, workspaceId), eq(jobResearchNotes.jobId, job.id)));
      return { status: 'cleared' as const, revision };
    });
    if (result === 'missing') return reply.code(404).send({ error: 'NOT_FOUND' });
    if (result === 'conflict') return reply.code(409).send({ error: 'NOTES_CONFLICT' });
    return { notes: emptyNotes, revision: result.revision };
  });
}
