import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { companyResearchSchema } from '@career/domain';
import { db, jobs } from '@career/db';

export function registerCompanyResearchRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, database: typeof db = db) {
  app.put('/api/v1/jobs/:id/company-research', async (request, reply) => {
    const parsed = companyResearchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT', detail: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const updated = await database.update(jobs).set({ companyResearch: parsed.data }).where(and(eq(jobs.id, id), eq(jobs.workspaceId, workspace(request)))).returning({ companyResearch: jobs.companyResearch });
    return updated[0] ? updated[0] : reply.code(404).send({ error: 'NOT_FOUND' });
  });
}
