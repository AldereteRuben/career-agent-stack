import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { companyResearchSaveSchema } from '@career/domain';
import { db, jobs } from '@career/db';

export function registerCompanyResearchRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, database: typeof db = db) {
  app.put('/api/v1/jobs/:id/company-research', async (request, reply) => {
    const parsed = companyResearchSaveSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT', detail: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const updated = await database.update(jobs).set({ companyResearch: parsed.data.notes, companyResearchRevision: sql`${jobs.companyResearchRevision} + 1` }).where(and(eq(jobs.id, id), eq(jobs.workspaceId, workspace(request)), eq(jobs.companyResearchRevision, parsed.data.expectedRevision))).returning({ companyResearch: jobs.companyResearch, companyResearchRevision: jobs.companyResearchRevision });
    if (updated[0]) return updated[0];
    const exists = await database.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.id, id), eq(jobs.workspaceId, workspace(request)))).limit(1);
    return exists[0] ? reply.code(409).send({ error: 'RESEARCH_CHANGED' }) : reply.code(404).send({ error: 'NOT_FOUND' });
  });
}
