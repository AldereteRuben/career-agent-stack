import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { applications, applicationEvents, db, documentVersions, jobSnapshots, jobs, profileFacts, profileVersions } from '@career/db';
import { documentLanguage, printedResumeIdentity, printedStatement, readIdentity } from '@career/domain';
import { config } from './config.js';
import { renderResume } from './document-renderer.js';
import { applicationPreparationBlockReason, findPriorPreparationResult, preparationGaps, preparationKey, selectRelevantPreparationFacts } from './preparation-domain.js';
import { latestAnswers, lockKey, profileLockKey } from './workspace-data.js';

export type PreparationLocale = 'es' | 'en';
export type PreparationResult = {
  status: 'PREPARED' | 'NEEDS_REVIEW' | 'BLOCKED'; jobId: string; applicationId: string | null; documentId: string | null;
  profileRevisionId: string | null; snapshotId: string | null;
  selectedFacts: Array<{ id: string; statement: string; reason: string }>;
  answerSuggestions: Array<{ answerId: string; semanticKey: string; question: string; value: unknown; provenance: string }>;
  gaps: string[]; reason?: string;
};

const asLocale = (value: unknown): PreparationLocale => value === 'es' ? 'es' : 'en';
const blocked = (jobId: string, reason: string, profileRevisionId: string | null = null, snapshotId: string | null = null): PreparationResult => ({ status: 'BLOCKED', jobId, applicationId: null, documentId: null, profileRevisionId, snapshotId, selectedFacts: [], answerSuggestions: [], gaps: [], reason });
const closedStages = ['HIRED', 'REJECTED', 'WITHDRAWN'];


function answerSuggestions(rows: Awaited<ReturnType<typeof latestAnswers>>, jobText: string, locale: PreparationLocale) {
  const lower = jobText.toLocaleLowerCase();
  return rows.filter((row) => row.approvalStatus === 'USER_APPROVED' && row.value !== null)
    .filter((row) => [row.semanticKey, row.questionScope, row.questionText ?? ''].some((text) => {
      const terms = text.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 3);
      return terms.some((term) => lower.includes(term));
    }))
    .map((row) => ({ answerId: row.id, semanticKey: row.semanticKey, question: row.questionText || row.questionScope, value: row.value, provenance: locale === 'es' ? `Respuesta aprobada · revisión ${row.revision} · ${row.jurisdiction}` : `Approved stored answer · revision ${row.revision} (${row.jurisdiction}, ${row.questionScope})` }));
}

/** Deterministically prepares a review draft from the current approved profile facts and saved job snapshot. */
export async function prepareApplication(workspaceId: string, jobId: string, locale: PreparationLocale = 'en') : Promise<PreparationResult> {
  let generatedFilePath: string | null = null;
  try {
    const result = await db.transaction(async (tx) => {
      await lockKey(tx, profileLockKey(workspaceId));
      await lockKey(tx, `application:${workspaceId}:${jobId}`);
      const job = (await tx.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, workspaceId))).limit(1))[0];
      if (!job) return blocked(jobId, 'JOB_NOT_FOUND');
      const profile = (await tx.select().from(profileVersions).where(eq(profileVersions.workspaceId, workspaceId)).orderBy(desc(profileVersions.revision)).limit(1))[0];
      const snapshot = (await tx.select().from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, workspaceId), eq(jobSnapshots.jobId, jobId))).orderBy(desc(jobSnapshots.fetchedAt)).limit(1))[0];
      const snapshotId = snapshot?.id ?? null;
      const profileRevisionId = profile?.id ?? null;
      const identity = readIdentity(profile?.profile ?? {});
      const facts = profile ? await tx.select().from(profileFacts).where(and(eq(profileFacts.workspaceId, workspaceId), eq(profileFacts.profileVersionId, profile.id))) : [];
      const jobText = `${snapshot?.title ?? job.title}\n${snapshot?.descriptionText ?? ''}`;
      const pdfLocale = documentLanguage(locale, profile?.locale);
      const approved = facts.filter((fact) => fact.approvalStatus === 'USER_APPROVED');
      const selected = selectRelevantPreparationFacts(approved, jobText, locale);
      const answers = await latestAnswers(tx, workspaceId);
      const suggestions = answerSuggestions(answers, jobText, locale);
      const key = preparationKey({
        profileRevisionId, snapshotId, locale,
        identity: printedResumeIdentity(profile?.profile ?? {}),
        facts: approved.map((fact) => ({ id: fact.id, kind: fact.kind, printedText: printedStatement(fact, pdfLocale), tags: fact.tags })),
        answers: answers.filter((answer) => answer.approvalStatus === 'USER_APPROVED' && answer.value !== null).map((answer) => ({ id: answer.id, semanticKey: answer.semanticKey, jurisdiction: answer.jurisdiction, questionScope: answer.questionScope, revision: answer.revision, value: answer.value })),
      });
      const previousApps = await tx.select().from(applications).where(and(eq(applications.workspaceId, workspaceId), eq(applications.jobId, jobId))).orderBy(desc(applications.applicationCycle));
      const previousIds = previousApps.map((row) => row.id);
      const events = previousIds.length ? await tx.select().from(applicationEvents).where(and(eq(applicationEvents.workspaceId, workspaceId), eq(applicationEvents.eventType, 'PREPARATION_CREATED'))).orderBy(desc(applicationEvents.createdAt)) : [];
      const current = previousApps[0] ?? null;
      const generatedDocumentId = current?.documentId && events.some((event) => event.applicationId === current.id && (event.evidence?.result as PreparationResult | undefined)?.documentId === current.documentId) ? current.documentId : null;
      const linkedDocument = current?.documentId ? (await tx.select({ id: documentVersions.id, approvalStatus: documentVersions.approvalStatus }).from(documentVersions).where(and(eq(documentVersions.workspaceId, workspaceId), eq(documentVersions.id, current.documentId))).limit(1))[0] : undefined;
      const replaceableGeneratedDocument = generatedDocumentId && linkedDocument?.approvalStatus === 'PENDING_REVIEW' ? generatedDocumentId : null;
      // Protect user decisions before consulting a cached preparation result.
      const protectedReason = applicationPreparationBlockReason(current, replaceableGeneratedDocument) ?? (job.availability === 'CLOSED' ? 'JOB_CLOSED' : null);
      if (protectedReason) {
        const result = { ...blocked(jobId, protectedReason, profileRevisionId, snapshotId), applicationId: current?.id ?? null };
        if (current) await tx.insert(applicationEvents).values({ workspaceId, applicationId: current.id, eventType: 'PREPARATION_CREATED', reason: null, evidence: { preparationKey: key, profileRevisionId, snapshotId, gaps: [], selectedFacts: [], answers: [], result }, aggregateVersion: current.version });
        return result;
      }
      const priorResult = findPriorPreparationResult<PreparationResult>(events.filter((event) => previousIds.includes(event.applicationId)).map((event) => ({ preparationKey: event.evidence?.preparationKey, result: event.evidence?.result })), key);
      if (priorResult && priorResult.applicationId === current?.id && priorResult.documentId === current?.documentId) return priorResult;

      const gaps = preparationGaps({ profileExists: Boolean(profile), fullName: identity.fullName, email: identity.email, factCount: selected.length, jobTextAvailable: Boolean(snapshot?.title || job.title) });
      const appToUse = current && (!current.documentId || replaceableGeneratedDocument === current.documentId) && !['CONFIRMED', 'UNKNOWN', 'IN_PROGRESS', 'CANCELLED'].includes(current.state) && !closedStages.includes(current.recruitmentStage) ? current : null;
      let application = appToUse;
      if (!application) {
        const cycle = (previousApps[0]?.applicationCycle ?? 0) + 1;
        application = (await tx.insert(applications).values({ workspaceId, jobId, applicationCycle: cycle, company: job.company, role: job.title, location: job.location, canonicalUrl: job.canonicalUrl, state: 'REVIEW_REQUIRED' }).returning())[0]!;
        await tx.insert(applicationEvents).values({ workspaceId, applicationId: application.id, eventType: 'APPLICATION_CREATED', newState: 'REVIEW_REQUIRED', reason: null, aggregateVersion: application.version });
      }
      let documentId: string | null = null;
      if (!gaps.length && selected.length) {
        const fullName = printedResumeIdentity(profile!.profile).fullName;
        const email = printedResumeIdentity(profile!.profile).email;
        const docId = randomUUID(); const relPath = `${workspaceId}/${docId}.pdf`;
        const root = resolve(config.FILES_LOCAL_PATH); const filePath = resolve(root, relPath); const rel = relative(root, filePath);
        if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('DOCUMENT_PATH_INVALID');
        generatedFilePath = filePath;
        await mkdir(resolve(filePath, '..'), { recursive: true, mode: 0o700 });
        const renderFacts = selected.map((fact) => ({ kind: fact.kind, statement: printedStatement(fact, pdfLocale), tags: fact.tags }));
        const rendered = await renderResume({ path: filePath, fullName, email, role: job.title, locale: pdfLocale, facts: renderFacts });
        const name = `${locale === 'es' ? 'Candidatura' : 'Application'} ${job.company} - ${job.title}`.slice(0, 200);
        const latestRevision = await tx.select({ revision: sql<number>`coalesce(max(${documentVersions.revision}), 0)::int` }).from(documentVersions).where(and(eq(documentVersions.workspaceId, workspaceId), eq(documentVersions.name, name)));
        const revision = (latestRevision[0]?.revision ?? 0) + 1;
        const claims = selected.map((fact, index) => ({ text: renderFacts[index]!.statement, sourceFactIds: [fact.id], approvalStatus: 'PENDING_REVIEW' }));
        await tx.insert(documentVersions).values({ id: docId, workspaceId, name, revision, language: pdfLocale, profileRevisionId: profile!.id, jobSnapshotId: snapshotId, mediaType: 'application/pdf', storagePath: relPath, sha256: rendered.sha256, claims, approvalStatus: 'PENDING_REVIEW' });
        application = (await tx.update(applications).set({ documentId: docId, state: 'REVIEW_REQUIRED', version: application.version + 1, updatedAt: new Date() }).where(eq(applications.id, application.id)).returning())[0]!;
        documentId = docId;
      } else if (application.state !== 'REVIEW_REQUIRED') {
        application = (await tx.update(applications).set({ state: 'REVIEW_REQUIRED', version: application.version + 1, updatedAt: new Date() }).where(eq(applications.id, application.id)).returning())[0]!;
      }
      const result: PreparationResult = {
        status: gaps.length ? 'NEEDS_REVIEW' : 'PREPARED', jobId, applicationId: application.id, documentId, profileRevisionId, snapshotId,
        selectedFacts: selected.map(({ id, statement, reason }) => ({ id, statement, reason })), answerSuggestions: suggestions, gaps,
      };
      await tx.insert(applicationEvents).values({ workspaceId, applicationId: application.id, eventType: 'PREPARATION_CREATED', reason: null, priorState: current?.state ?? null, newState: application.state, evidence: { preparationKey: key, profileRevisionId, snapshotId, selectedFacts: result.selectedFacts, answers: suggestions, gaps, result }, aggregateVersion: application.version });
      return result;
    });
    generatedFilePath = null;
    return result;
  } catch (error) {
    if (generatedFilePath) await unlink(generatedFilePath).catch(() => {});
    throw error;
  }
}

const preparationInput = z.object({ jobId: z.string().uuid(), locale: z.enum(['es', 'en']).optional() }).strict();

export function registerPreparationRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string) {
  app.post('/api/v1/preparations', async (request, reply) => {
    const parsed = preparationInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_PREPARATION_REQUEST' });
    const result = await prepareApplication(workspace(request), parsed.data.jobId, asLocale(parsed.data.locale));
    return reply.code(result.status === 'BLOCKED' && result.reason === 'JOB_NOT_FOUND' ? 404 : result.status === 'BLOCKED' ? 409 : 200).send(result.status === 'BLOCKED' ? { ...result, error: result.reason } : result);
  });
  app.get('/api/v1/preparations', async (request) => {
    const id = workspace(request);
    const rows = await db.select({ event: applicationEvents, application: applications, job: jobs }).from(applicationEvents)
      .innerJoin(applications, and(eq(applications.id, applicationEvents.applicationId), eq(applications.workspaceId, id)))
      .leftJoin(jobs, and(eq(jobs.id, applications.jobId), eq(jobs.workspaceId, id)))
      .where(and(eq(applicationEvents.workspaceId, id), eq(applicationEvents.eventType, 'PREPARATION_CREATED'))).orderBy(desc(applicationEvents.createdAt)).limit(200);
    const latest = new Map<string, PreparationResult>();
    for (const row of rows) if (row.event.evidence?.result && !latest.has(row.application.id)) latest.set(row.application.id, row.event.evidence.result as PreparationResult);
    return [...latest.values()].map((result) => ({ ...result, company: rows.find((row) => row.application.id === result.applicationId)?.job?.company ?? '', title: rows.find((row) => row.application.id === result.applicationId)?.job?.title ?? '' }));
  });
}
