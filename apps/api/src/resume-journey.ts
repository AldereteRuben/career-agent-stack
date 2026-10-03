import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, applications, applicationEvents, assistedAttempts, documentVersions, jobs } from '@career/db';
import { lockKey, profileLockKey } from './workspace-data.js';
import { documentReadiness } from './document-reuse.js';

const input = z.object({ documentId: z.string().uuid(), jobId: z.string().uuid().optional(), applicationId: z.string().uuid().optional() }).strict().refine((value) => Boolean(value.jobId) !== Boolean(value.applicationId));

export function registerResumeJourney(app: FastifyInstance, workspace: (request: FastifyRequest) => string) {
  app.post('/api/v1/applications/with-resume', async (request, reply) => {
    const parsed = input.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_DOCUMENT_REQUEST' });
    const id = workspace(request); const body = parsed.data;
    const result = await db.transaction(async (tx) => {
      // Match the assisted workflow's lock order: profile, then application.
      await lockKey(tx, profileLockKey(id));
      if (body.jobId) await lockKey(tx, `application:${id}:${body.jobId}`);
      const documents = await tx.select().from(documentVersions).where(and(eq(documentVersions.workspaceId, id), eq(documentVersions.id, body.documentId))).limit(1);
      const document = (await documentReadiness(tx, id, documents))[0];
      if (!document?.assistReady) return { error: 'PROFILE_CHANGED_REGENERATE_DOCUMENT' };
      const previous = body.applicationId
        ? (await tx.select().from(applications).where(and(eq(applications.workspaceId, id), eq(applications.id, body.applicationId))).limit(1).for('update'))[0]
        : (await tx.select().from(applications).where(and(eq(applications.workspaceId, id), eq(applications.jobId, body.jobId!))).orderBy(desc(applications.applicationCycle)).limit(1).for('update'))[0];
      if (body.applicationId && !previous) return { error: 'NOT_FOUND' };
      const closed = previous && (previous.state === 'CANCELLED' || ['REJECTED', 'WITHDRAWN'].includes(previous.recruitmentStage));
      let application = (body.applicationId || !closed) ? previous : undefined;
      const jobId = body.jobId ?? application?.jobId;
      if (document.jobId && document.jobId !== jobId) return { error: 'DOCUMENT_JOB_MISMATCH' };
      if (application) {
        if (['CONFIRMED', 'CANCELLED', 'UNKNOWN', 'IN_PROGRESS'].includes(application.state) || ['HIRED', 'REJECTED', 'WITHDRAWN'].includes(application.recruitmentStage)) return { error: 'APPLICATION_RESUME_CLOSED' };
        const active = await tx.select({ id: assistedAttempts.id }).from(assistedAttempts).where(and(eq(assistedAttempts.workspaceId, id), eq(assistedAttempts.applicationId, application.id), inArray(assistedAttempts.status, ['PREPARED', 'STARTING', 'REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF', 'UNKNOWN']))).limit(1);
        if (active.length) return { error: 'ASSIST_ACTIVE_ATTEMPT' };
        if (application.documentId === document.id) return { application };
        application = (await tx.update(applications).set({ documentId: document.id, version: application.version + 1, updatedAt: new Date() }).where(eq(applications.id, application.id)).returning())[0]!;
      } else {
        const job = (await tx.select().from(jobs).where(and(eq(jobs.workspaceId, id), eq(jobs.id, body.jobId!))).limit(1))[0];
        if (!job) return { error: 'JOB_NOT_FOUND' };
        application = (await tx.insert(applications).values({ workspaceId: id, jobId: job.id, applicationCycle: (previous?.applicationCycle ?? 0) + 1, company: job.company, role: job.title, location: job.location, canonicalUrl: job.canonicalUrl, documentId: document.id }).returning())[0]!;
        await tx.insert(applicationEvents).values({ workspaceId: id, applicationId: application.id, eventType: 'APPLICATION_CREATED', newState: 'DRAFT', aggregateVersion: application.version });
      }
      await tx.insert(applicationEvents).values({ workspaceId: id, applicationId: application.id, eventType: 'APPLICATION_RESUME_SELECTED', reason: document.name, evidence: { documentId: document.id }, aggregateVersion: application.version });
      return { application };
    });
    return 'error' in result ? reply.code(result.error === 'NOT_FOUND' || result.error === 'JOB_NOT_FOUND' ? 404 : 409).send(result) : result.application;
  });
}
