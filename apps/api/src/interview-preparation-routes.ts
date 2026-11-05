import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  applications, db, documentVersions, interviewPreparationEvidence, interviewPreparationItems, interviewPreparationPlans,
  interviewPreparationSessions, interviewPreparationTurns, jobSnapshots, jobs, profileFacts,
} from '@career/db';
import {
  buildInterviewPreparationItems, buildJobReport, INTERVIEW_PLAN_LIMITS, interviewEvidenceKinds, interviewEvidenceStatus, interviewPlanFactIds, interviewPlanNeedsReview, interviewTurnVerdict,
  type InterviewEvidenceCurrent, type InterviewEvidenceKind, type InterviewTurnFeedback,
} from '@career/domain';
import { readableDescriptions } from './job-report-routes.js';
import { loadMatchingContext, lockKey, type Executor } from './workspace-data.js';

// ADR 024: a plan belongs to one application. It keeps references and hashes of its evidence, compares them with the
// current records whenever it is opened, and is deleted together with everything under it.
const createPlanSchema = z.object({
  language: z.enum(['es', 'en']),
  stage: z.string().trim().min(1).max(30).optional(),
  evidence: z.array(z.object({ kind: z.enum(interviewEvidenceKinds), sourceId: z.string().uuid() }).strict()).max(200).default([]),
}).strict();
const idParamsSchema = z.object({ id: z.string().uuid() });
const buildPlanSchema = z.object({ language: z.enum(['es', 'en']), stage: z.string().trim().min(1).max(30).optional() }).strict();
// People add their own notes and questions; generated items are fixed, and can only be removed.
const userItemSchema = z.object({
  kind: z.enum(['NOTE', 'QUESTION']), origin: z.enum(['USER_NOTE', 'USER_RESEARCH']).default('USER_NOTE'),
  content: z.string().trim().min(1).max(INTERVIEW_PLAN_LIMITS.maxContent),
}).strict();
const editItemSchema = z.object({ content: z.string().trim().min(1).max(INTERVIEW_PLAN_LIMITS.maxContent) }).strict();
export const interviewPreparationPlanLockKey = (workspaceId: string, planId: string) => `interview-preparation-plan:${workspaceId}:${planId}`;
const userOrigins = ['USER_NOTE', 'USER_RESEARCH'];

type PreparationDatabase = typeof db;
export type EvidenceReference = { kind: InterviewEvidenceKind; sourceId: string };

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
/** Facts are hashed on what the person approved: their kind and text. */
export const factEvidenceHash = (fact: { kind: string; statement: string }) => sha256(`${fact.kind}\n${fact.statement}`);

/** What each referenced record looks like now, keyed by `kind:id`. A record that no longer exists is absent. */
export async function currentEvidence(database: PreparationDatabase, workspaceId: string, references: EvidenceReference[]): Promise<Map<string, InterviewEvidenceCurrent>> {
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

export const itemView = (item: typeof interviewPreparationItems.$inferSelect) => ({
  id: item.id, kind: item.kind, origin: item.origin, position: item.position, content: item.content,
  evidenceId: item.evidenceId, support: item.support, factIds: item.factIds, hints: item.hints,
});

/** A turn as the person sees it. An empty answer means the question was skipped; the verdict never calls an answer correct unless they rated it so. */
export const turnView = (turn: typeof interviewPreparationTurns.$inferSelect) => ({
  id: turn.id, position: turn.position, kind: turn.kind, itemId: turn.itemId, question: turn.question, answer: turn.answer, skipped: turn.answer === '',
  feedback: turn.feedback, verdict: turn.answer ? interviewTurnVerdict(turn.feedback as InterviewTurnFeedback | null) : null, learningItems: turn.learningItems,
});

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
      items: items.filter((item) => item.planId === plan.id).map(itemView),
      sessions: sessions.filter((session) => session.planId === plan.id).map((session) => ({
        id: session.id, status: session.status, createdAt: session.createdAt, endedAt: session.endedAt,
        turns: turns.filter((turn) => turn.sessionId === session.id).map(turnView),
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

  // The no-AI plan (#200): built from the saved offer, the current stage, the submitted resume and approved facts only.
  app.post('/api/v1/applications/:id/interview-preparation/build', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const parsed = buildPlanSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const result = await database.transaction(async (tx) => {
      const executor = tx as unknown as Executor;
      const application = (await tx.select({ id: applications.id, jobId: applications.jobId, documentId: applications.documentId, stage: applications.recruitmentStage }).from(applications)
        .where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, params.data.id))).limit(1))[0];
      if (!application) return { kind: 'missing' as const };
      const job = application.jobId ? (await tx.select().from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.id, application.jobId))).limit(1))[0] : undefined;
      const snapshot = job ? (await tx.select({ id: jobSnapshots.id }).from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, workspaceId), eq(jobSnapshots.jobId, job.id))).orderBy(desc(jobSnapshots.fetchedAt), desc(jobSnapshots.id)).limit(1))[0] : undefined;
      let report = null;
      if (job) {
        // Sequential: a transaction is one connection, which runs one query at a time.
        const context = await loadMatchingContext(executor, workspaceId);
        const description = (await readableDescriptions(executor, workspaceId, [job.id])).get(job.id) ?? null;
        report = buildJobReport({ title: job.title, location: job.location, description }, context);
      }
      const stage = parsed.data.stage ?? application.stage;
      const drafts = buildInterviewPreparationItems({ language: parsed.data.language, stage, report, jobSnapshotId: snapshot?.id ?? null });
      const resume = application.documentId ? (await tx.select({ id: documentVersions.id }).from(documentVersions).where(and(eq(documentVersions.workspaceId, workspaceId), eq(documentVersions.id, application.documentId))).limit(1))[0] : undefined;
      const references: EvidenceReference[] = [
        ...(snapshot ? [{ kind: 'JOB_SNAPSHOT' as const, sourceId: snapshot.id }] : []),
        ...(resume ? [{ kind: 'RESUME_VERSION' as const, sourceId: resume.id }] : []),
        ...interviewPlanFactIds(drafts).map((sourceId) => ({ kind: 'APPROVED_FACT' as const, sourceId })),
      ];
      const current = await currentEvidence(tx as unknown as PreparationDatabase, workspaceId, references);
      const usable = references.filter((reference) => { const found = current.get(`${reference.kind}:${reference.sourceId}`); return found && !found.withdrawn; });
      const plan = (await tx.insert(interviewPreparationPlans).values({ workspaceId, applicationId: application.id, language: parsed.data.language, stage }).returning())[0]!;
      const evidenceIds = new Map<string, string>();
      if (usable.length) {
        const rows = await tx.insert(interviewPreparationEvidence).values(usable.map((reference) => ({
          workspaceId, planId: plan.id, kind: reference.kind, sourceId: reference.sourceId, contentSha256: current.get(`${reference.kind}:${reference.sourceId}`)!.hash,
        }))).returning({ id: interviewPreparationEvidence.id, kind: interviewPreparationEvidence.kind, sourceId: interviewPreparationEvidence.sourceId });
        for (const row of rows) evidenceIds.set(`${row.kind}:${row.sourceId}`, row.id);
      }
      if (drafts.length) {
        await tx.insert(interviewPreparationItems).values(drafts.map((item, position) => ({
          workspaceId, planId: plan.id, kind: item.kind, origin: item.origin, position, content: item.content, support: item.support,
          factIds: item.factIds.filter((id) => evidenceIds.has(`APPROVED_FACT:${id}`)),
          evidenceId: item.evidence ? evidenceIds.get(`${item.evidence.kind}:${item.evidence.sourceId}`) ?? null : null,
        })));
      }
      return { kind: 'created' as const, plan };
    });
    if (result.kind === 'missing') return reply.code(404).send({ error: 'NOT_FOUND' });
    return reply.code(201).send({ plan: (await describePlans(database, workspaceId, [result.plan]))[0] });
  });

  app.post('/api/v1/interview-preparation/:id/items', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const parsed = userItemSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const result = await database.transaction(async (tx) => {
      await lockKey(tx, interviewPreparationPlanLockKey(workspaceId, params.data.id));
      // The plan row is locked so two additions cannot take the same position.
      const plan = (await tx.select({ id: interviewPreparationPlans.id }).from(interviewPreparationPlans)
        .where(and(eq(interviewPreparationPlans.workspaceId, workspaceId), eq(interviewPreparationPlans.id, params.data.id))).for('update').limit(1))[0];
      if (!plan) return { kind: 'missing' as const };
      const existing = await tx.select({ position: interviewPreparationItems.position }).from(interviewPreparationItems)
        .where(and(eq(interviewPreparationItems.workspaceId, workspaceId), eq(interviewPreparationItems.planId, plan.id)));
      if (existing.length >= INTERVIEW_PLAN_LIMITS.maxItems) return { kind: 'full' as const };
      const position = existing.reduce((highest, row) => Math.max(highest, row.position), -1) + 1;
      const item = (await tx.insert(interviewPreparationItems).values({ workspaceId, planId: plan.id, position, ...parsed.data }).returning())[0]!;
      await tx.update(interviewPreparationPlans).set({ updatedAt: new Date() }).where(and(eq(interviewPreparationPlans.workspaceId, workspaceId), eq(interviewPreparationPlans.id, plan.id)));
      return { kind: 'created' as const, item };
    });
    if (result.kind === 'missing') return reply.code(404).send({ error: 'NOT_FOUND' });
    if (result.kind === 'full') return reply.code(409).send({ error: 'PLAN_FULL' });
    return reply.code(201).send({ item: itemView(result.item) });
  });

  app.patch('/api/v1/interview-preparation/items/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    const parsed = editItemSchema.safeParse(request.body);
    if (!params.success || !parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const result = await database.transaction(async (tx) => {
      const item = (await tx.select().from(interviewPreparationItems).where(and(eq(interviewPreparationItems.workspaceId, workspaceId), eq(interviewPreparationItems.id, params.data.id))).limit(1))[0];
      if (!item) return { kind: 'missing' as const };
      await lockKey(tx, interviewPreparationPlanLockKey(workspaceId, item.planId));
      const current = (await tx.select().from(interviewPreparationItems).where(and(eq(interviewPreparationItems.workspaceId, workspaceId), eq(interviewPreparationItems.id, item.id))).limit(1))[0];
      if (!current) return { kind: 'missing' as const };
      // Generated items stay as they were made so their provenance is true; the person can remove them or add their own.
      if (!userOrigins.includes(current.origin)) return { kind: 'immutable' as const };
      const updated = (await tx.update(interviewPreparationItems).set({ content: parsed.data.content, updatedAt: new Date() })
        .where(and(eq(interviewPreparationItems.workspaceId, workspaceId), eq(interviewPreparationItems.id, current.id))).returning())[0]!;
      return { kind: 'updated' as const, item: updated };
    });
    if (result.kind === 'missing') return reply.code(404).send({ error: 'NOT_FOUND' });
    if (result.kind === 'immutable') return reply.code(409).send({ error: 'ITEM_NOT_EDITABLE' });
    return { item: itemView(result.item) };
  });

  app.delete('/api/v1/interview-preparation/items/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const removed = await database.transaction(async (tx) => {
      const item = (await tx.select({ planId: interviewPreparationItems.planId }).from(interviewPreparationItems)
        .where(and(eq(interviewPreparationItems.workspaceId, workspaceId), eq(interviewPreparationItems.id, params.data.id))).limit(1))[0];
      if (!item) return false;
      await lockKey(tx, interviewPreparationPlanLockKey(workspaceId, item.planId));
      const deleted = await tx.delete(interviewPreparationItems)
        .where(and(eq(interviewPreparationItems.workspaceId, workspaceId), eq(interviewPreparationItems.id, params.data.id))).returning({ id: interviewPreparationItems.id });
      return deleted.length > 0;
    });
    if (!removed) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { ok: true };
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
    const workspaceId = workspace(request);
    const removed = await database.transaction(async (tx) => {
      await lockKey(tx, interviewPreparationPlanLockKey(workspaceId, params.data.id));
      return tx.delete(interviewPreparationPlans)
        .where(and(eq(interviewPreparationPlans.workspaceId, workspaceId), eq(interviewPreparationPlans.id, params.data.id))).returning({ id: interviewPreparationPlans.id });
    });
    if (!removed.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { ok: true };
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
