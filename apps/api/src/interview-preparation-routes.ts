import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  applications, db, documentVersions, interviewPreparationEvidence, interviewPreparationItems, interviewPreparationPlans,
  interviewPreparationSessions, interviewPreparationTurns, jobSnapshots, profileFacts,
} from '@career/db';
import { interviewEvidenceKinds, interviewEvidenceStatus, interviewPlanNeedsReview, type InterviewEvidenceCurrent, type InterviewEvidenceKind } from '@career/domain';

// ADR 024: a plan belongs to one application. It keeps references and hashes of its evidence, compares them with the
// current records whenever it is opened, and is deleted together with everything under it.
const createPlanSchema = z.object({
  language: z.enum(['es', 'en']),
  stage: z.string().trim().min(1).max(30).optional(),
  evidence: z.array(z.object({ kind: z.enum(interviewEvidenceKinds), sourceId: z.string().uuid() }).strict()).max(200).default([]),
}).strict();
const idParamsSchema = z.object({ id: z.string().uuid() });

type PreparationDatabase = typeof db;
type EvidenceReference = { kind: InterviewEvidenceKind; sourceId: string };

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
/** Facts are hashed on what the person approved: their kind and text. */
export const factEvidenceHash = (fact: { kind: string; statement: string }) => sha256(`${fact.kind}\n${fact.statement}`);

/** What each referenced record looks like now, keyed by `kind:id`. A record that no longer exists is absent. */
async function currentEvidence(database: PreparationDatabase, workspaceId: string, references: EvidenceReference[]): Promise<Map<string, InterviewEvidenceCurrent>> {
  const current = new Map<string, InterviewEvidenceCurrent>();
  const ids = (kind: InterviewEvidenceKind) => [...new Set(references.filter((reference) => reference.kind === kind).map((reference) => reference.sourceId))];
  const [snapshotIds, resumeIds, factIds] = [ids('JOB_SNAPSHOT'), ids('RESUME_VERSION'), ids('APPROVED_FACT')];
  if (snapshotIds.length) {
    for (const row of await database.select({ id: jobSnapshots.id, hash: jobSnapshots.snapshotHash }).from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, workspaceId), inArray(jobSnapshots.id, snapshotIds)))) current.set(`JOB_SNAPSHOT:${row.id}`, { hash: row.hash });
  }
  if (resumeIds.length) {
    for (const row of await database.select({ id: documentVersions.id, hash: documentVersions.sha256 }).from(documentVersions).where(and(eq(documentVersions.workspaceId, workspaceId), inArray(documentVersions.id, resumeIds)))) current.set(`RESUME_VERSION:${row.id}`, { hash: row.hash });
  }
  if (factIds.length) {
    for (const row of await database.select({ id: profileFacts.id, kind: profileFacts.kind, statement: profileFacts.statement, approval: profileFacts.approvalStatus }).from(profileFacts).where(and(eq(profileFacts.workspaceId, workspaceId), inArray(profileFacts.id, factIds)))) {
      current.set(`APPROVED_FACT:${row.id}`, { hash: factEvidenceHash(row), withdrawn: row.approval !== 'USER_APPROVED' });
    }
  }
  return current;
}

/** Plans with their evidence status, items and sessions. Nothing here returns profile text or resume content. */
async function describePlans(database: PreparationDatabase, workspaceId: string, plans: Array<typeof interviewPreparationPlans.$inferSelect>) {
  if (!plans.length) return [];
  const planIds = plans.map((plan) => plan.id);
  const [evidence, items, sessions] = await Promise.all([
    database.select().from(interviewPreparationEvidence).where(and(eq(interviewPreparationEvidence.workspaceId, workspaceId), inArray(interviewPreparationEvidence.planId, planIds))).orderBy(asc(interviewPreparationEvidence.createdAt), asc(interviewPreparationEvidence.id)),
    database.select().from(interviewPreparationItems).where(and(eq(interviewPreparationItems.workspaceId, workspaceId), inArray(interviewPreparationItems.planId, planIds))).orderBy(asc(interviewPreparationItems.position)),
    database.select().from(interviewPreparationSessions).where(and(eq(interviewPreparationSessions.workspaceId, workspaceId), inArray(interviewPreparationSessions.planId, planIds))).orderBy(desc(interviewPreparationSessions.createdAt), desc(interviewPreparationSessions.id)),
  ]);
  const turns = sessions.length
    ? await database.select().from(interviewPreparationTurns).where(and(eq(interviewPreparationTurns.workspaceId, workspaceId), inArray(interviewPreparationTurns.sessionId, sessions.map((session) => session.id)))).orderBy(asc(interviewPreparationTurns.position))
    : [];
  const current = await currentEvidence(database, workspaceId, evidence.map((row) => ({ kind: row.kind as InterviewEvidenceKind, sourceId: row.sourceId })));
  return plans.map((plan) => {
    const planEvidence = evidence.filter((row) => row.planId === plan.id).map((row) => ({
      id: row.id, kind: row.kind as InterviewEvidenceKind, sourceId: row.sourceId,
      status: interviewEvidenceStatus(row.contentSha256, current.get(`${row.kind}:${row.sourceId}`)),
    }));
    return {
      id: plan.id, applicationId: plan.applicationId, language: plan.language, stage: plan.stage, createdAt: plan.createdAt, updatedAt: plan.updatedAt,
      needsReview: interviewPlanNeedsReview(planEvidence.map((row) => row.status)),
      evidence: planEvidence,
      items: items.filter((item) => item.planId === plan.id).map((item) => ({ id: item.id, kind: item.kind, origin: item.origin, position: item.position, content: item.content, evidenceId: item.evidenceId })),
      sessions: sessions.filter((session) => session.planId === plan.id).map((session) => ({
        id: session.id, status: session.status, createdAt: session.createdAt, endedAt: session.endedAt,
        turns: turns.filter((turn) => turn.sessionId === session.id).map((turn) => ({ id: turn.id, position: turn.position, question: turn.question, answer: turn.answer, feedback: turn.feedback, learningItems: turn.learningItems })),
      })),
    };
  });
}

export function registerInterviewPreparationRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, database: PreparationDatabase = db) {
  app.get('/api/v1/applications/:id/interview-preparation', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const application = (await database.select({ id: applications.id }).from(applications).where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, params.data.id))).limit(1))[0];
    if (!application) return reply.code(404).send({ error: 'NOT_FOUND' });
    const plans = await database.select().from(interviewPreparationPlans)
      .where(and(eq(interviewPreparationPlans.workspaceId, workspaceId), eq(interviewPreparationPlans.applicationId, application.id)))
      .orderBy(desc(interviewPreparationPlans.createdAt), desc(interviewPreparationPlans.id));
    return { plans: await describePlans(database, workspaceId, plans) };
  });

  app.post('/api/v1/applications/:id/interview-preparation', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const parsed = createPlanSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const result = await database.transaction(async (tx) => {
      const application = (await tx.select({ id: applications.id, jobId: applications.jobId, documentId: applications.documentId }).from(applications)
        .where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, params.data.id))).limit(1))[0];
      if (!application) return { kind: 'missing' as const };
      const references = [...new Map(parsed.data.evidence.map((reference) => [`${reference.kind}:${reference.sourceId}`, reference])).values()];
      const current = await currentEvidence(tx as unknown as PreparationDatabase, workspaceId, references);
      for (const reference of references) {
        const found = current.get(`${reference.kind}:${reference.sourceId}`);
        if (!found) return { kind: 'evidence' as const, error: 'EVIDENCE_NOT_FOUND' };
        if (found.withdrawn) return { kind: 'evidence' as const, error: 'EVIDENCE_NOT_APPROVED' };
      }
      // The offer and the resume must be the ones this application is about, never another application's.
      const snapshotIds = references.filter((reference) => reference.kind === 'JOB_SNAPSHOT').map((reference) => reference.sourceId);
      if (snapshotIds.length) {
        const owned = application.jobId ? await tx.select({ id: jobSnapshots.id }).from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, workspaceId), eq(jobSnapshots.jobId, application.jobId), inArray(jobSnapshots.id, snapshotIds))) : [];
        if (owned.length !== snapshotIds.length) return { kind: 'evidence' as const, error: 'EVIDENCE_NOT_FOR_APPLICATION' };
      }
      if (references.some((reference) => reference.kind === 'RESUME_VERSION' && reference.sourceId !== application.documentId)) return { kind: 'evidence' as const, error: 'EVIDENCE_NOT_FOR_APPLICATION' };
      const plan = (await tx.insert(interviewPreparationPlans).values({ workspaceId, applicationId: application.id, language: parsed.data.language, stage: parsed.data.stage ?? null }).returning())[0]!;
      if (references.length) {
        await tx.insert(interviewPreparationEvidence).values(references.map((reference) => ({
          workspaceId, planId: plan.id, kind: reference.kind, sourceId: reference.sourceId, contentSha256: current.get(`${reference.kind}:${reference.sourceId}`)!.hash,
        })));
      }
      return { kind: 'created' as const, plan };
    });
    if (result.kind === 'missing') return reply.code(404).send({ error: 'NOT_FOUND' });
    if (result.kind === 'evidence') return reply.code(400).send({ error: result.error });
    return reply.code(201).send({ plan: (await describePlans(database, workspaceId, [result.plan]))[0] });
  });

  app.get('/api/v1/interview-preparation/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const plan = (await database.select().from(interviewPreparationPlans).where(and(eq(interviewPreparationPlans.workspaceId, workspaceId), eq(interviewPreparationPlans.id, params.data.id))).limit(1))[0];
    if (!plan) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { plan: (await describePlans(database, workspaceId, [plan]))[0] };
  });

  app.delete('/api/v1/interview-preparation/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const removed = await database.delete(interviewPreparationPlans)
      .where(and(eq(interviewPreparationPlans.workspaceId, workspace(request)), eq(interviewPreparationPlans.id, params.data.id))).returning({ id: interviewPreparationPlans.id });
    if (!removed.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { ok: true };
  });

  app.post('/api/v1/interview-preparation/:id/sessions', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const plan = (await database.select({ id: interviewPreparationPlans.id }).from(interviewPreparationPlans).where(and(eq(interviewPreparationPlans.workspaceId, workspaceId), eq(interviewPreparationPlans.id, params.data.id))).limit(1))[0];
    if (!plan) return reply.code(404).send({ error: 'NOT_FOUND' });
    const session = (await database.insert(interviewPreparationSessions).values({ workspaceId, planId: plan.id }).returning())[0]!;
    return reply.code(201).send({ session: { id: session.id, status: session.status, createdAt: session.createdAt, endedAt: session.endedAt, turns: [] } });
  });

  app.delete('/api/v1/interview-preparation/sessions/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const removed = await database.delete(interviewPreparationSessions)
      .where(and(eq(interviewPreparationSessions.workspaceId, workspace(request)), eq(interviewPreparationSessions.id, params.data.id))).returning({ id: interviewPreparationSessions.id });
    if (!removed.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { ok: true };
  });
}
