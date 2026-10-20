import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { applications, applicationFollowUpDrafts, db } from '@career/db';

const followUpDraftSchema = z.object({
  language: z.enum(['es', 'en']),
  subject: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(10_000),
}).strict();
const applicationParamsSchema = z.object({ id: z.string().uuid() });

type FollowUpDatabase = typeof db;

export function registerApplicationFollowUpRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, database: FollowUpDatabase = db) {
  app.get('/api/v1/applications/:id/follow-up-draft', async (request, reply) => {
    const params = applicationParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request); const applicationId = params.data.id;
    const application = (await database.select({ id: applications.id }).from(applications)
      .where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, applicationId))).limit(1))[0];
    if (!application) return reply.code(404).send({ error: 'NOT_FOUND' });
    const draft = (await database.select().from(applicationFollowUpDrafts)
      .where(and(eq(applicationFollowUpDrafts.workspaceId, workspaceId), eq(applicationFollowUpDrafts.applicationId, applicationId))).limit(1))[0] ?? null;
    return { draft };
  });

  app.post('/api/v1/applications/:id/follow-up-draft', async (request, reply) => {
    const parsed = followUpDraftSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const params = applicationParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request); const applicationId = params.data.id;
    const result = await database.transaction(async (tx) => {
      const application = (await tx.select({ id: applications.id }).from(applications)
        .where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, applicationId))).limit(1))[0];
      if (!application) return { kind: 'missing' as const };
      const inserted = await tx.insert(applicationFollowUpDrafts).values({ workspaceId, applicationId, ...parsed.data })
        .onConflictDoNothing({ target: [applicationFollowUpDrafts.workspaceId, applicationFollowUpDrafts.applicationId] }).returning();
      return inserted[0] ? { kind: 'created' as const, draft: inserted[0] } : { kind: 'exists' as const };
    });
    if (result.kind === 'missing') return reply.code(404).send({ error: 'NOT_FOUND' });
    if (result.kind === 'exists') return reply.code(409).send({ error: 'DRAFT_ALREADY_EXISTS' });
    return reply.code(201).send({ draft: result.draft });
  });

  app.put('/api/v1/applications/:id/follow-up-draft', async (request, reply) => {
    const parsed = followUpDraftSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const params = applicationParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request); const applicationId = params.data.id;
    const draft = (await database.update(applicationFollowUpDrafts).set({ ...parsed.data, updatedAt: new Date() })
      .where(and(eq(applicationFollowUpDrafts.workspaceId, workspaceId), eq(applicationFollowUpDrafts.applicationId, applicationId))).returning())[0];
    if (!draft) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { draft };
  });

  app.delete('/api/v1/applications/:id/follow-up-draft', async (request, reply) => {
    const params = applicationParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request); const applicationId = params.data.id;
    const removed = await database.delete(applicationFollowUpDrafts)
      .where(and(eq(applicationFollowUpDrafts.workspaceId, workspaceId), eq(applicationFollowUpDrafts.applicationId, applicationId))).returning({ id: applicationFollowUpDrafts.id });
    if (!removed.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.code(200).send({ ok: true });
  });
}
