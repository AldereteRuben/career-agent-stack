import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { applicationEvents, applications, assistedAttempts, db } from '@career/db';
import { classifyRecruitmentStageChange, type RecruitmentStage } from '@career/domain';
import { findStage, MAX_EMAIL_BYTES, parseEml } from './email-import-parser.js';

const MAX_REVIEW_TEXT = 100_000;
const PREVIEW_TTL_MS = 10 * 60 * 1000;
type Source = 'PASTED_TEXT' | 'EML';
type PendingImport = {
  applicationId: string;
  workspaceId: string;
  source: Source;
  messageRef: string;
  messageIdRef?: string;
  messageDate: string | null;
  proposedStage: RecruitmentStage | null;
  expectedVersion: number;
  expectedStage: RecruitmentStage;
  expiresAt: number;
};

const pendingImports = new Map<string, PendingImport>();

const trimExpired = (now = Date.now()) => { for (const [key, value] of pendingImports) if (value.expiresAt <= now) pendingImports.delete(key); };
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const decodeBase64 = (value: unknown): Buffer | null => {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_EMAIL_BYTES * 4 / 3) + 8 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.byteLength <= MAX_EMAIL_BYTES ? decoded : null;
};
export function registerApplicationEmailImportRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string) {
  app.post('/api/v1/applications/:id/email-import/preview', { bodyLimit: 1_500_000 }, async (request, reply) => {
    const { id: applicationId } = request.params as { id: string };
    const workspaceId = workspace(request);
    const body = request.body as { source?: unknown; text?: unknown; emlBase64?: unknown } | null;
    if (body?.source !== 'PASTED_TEXT' && body?.source !== 'EML') return reply.code(400).send({ error: 'INVALID_EMAIL_IMPORT' });
    let text: string;
    let messageId: string | undefined;
    let messageDate: string | null = null;
    if (body.source === 'EML') {
      const decoded = decodeBase64(body.emlBase64);
      if (!decoded) return reply.code(400).send({ error: 'INVALID_EMAIL_FILE' });
      try {
        const parsed = await parseEml(decoded);
        text = parsed.text; messageId = parsed.messageId; messageDate = parsed.messageDate;
      } catch { return reply.code(400).send({ error: 'EMAIL_FILE_UNREADABLE' }); }
    } else {
      if (typeof body.text !== 'string' || !body.text.trim() || Buffer.byteLength(body.text, 'utf8') > MAX_REVIEW_TEXT) return reply.code(400).send({ error: 'INVALID_EMAIL_TEXT' });
      text = body.text;
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_REVIEW_TEXT) return reply.code(400).send({ error: 'EMAIL_TEXT_TOO_LARGE' });
    text = text.replace(/\0/g, '').trim();
    if (!text) return reply.code(400).send({ error: 'EMAIL_HAS_NO_READABLE_TEXT' });
    const messageRef = digest(Buffer.from(text.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase(), 'utf8'));
    const messageIdRef = messageId ? digest(Buffer.from(`message-id:${messageId.toLowerCase()}`)) : undefined;
    const application = (await db.select().from(applications).where(and(eq(applications.id, applicationId), eq(applications.workspaceId, workspaceId))).limit(1))[0];
    if (!application) return reply.code(404).send({ error: 'NOT_FOUND' });
    const suggestion = findStage(text);
    const stageChange = suggestion.stage ? classifyRecruitmentStageChange(application.recruitmentStage, suggestion.stage) : 'UNCHANGED';
    const offerProtected = application.recruitmentStage === 'OFFER' && suggestion.stage === 'REJECTED';
    const nextStage = suggestion.stage && stageChange === 'ADVANCE' && !offerProtected ? suggestion.stage : null;
    const token = randomUUID();
    trimExpired();
    pendingImports.set(token, {
      applicationId, workspaceId, source: body.source, messageRef,
      ...(messageIdRef ? { messageIdRef } : {}),
      messageDate, proposedStage: nextStage,
      expectedVersion: application.version, expectedStage: application.recruitmentStage, expiresAt: Date.now() + PREVIEW_TTL_MS,
    });
    return reply.header('Cache-Control', 'no-store').send({ token, source: body.source, messageDate, currentStage: application.recruitmentStage, detectedStage: suggestion.stage, proposedStage: nextStage, evidence: suggestion.excerpt.slice(0, 360), stageAlreadyReached: stageChange === 'UNCHANGED' && suggestion.stage === application.recruitmentStage, stageRegressionBlocked: stageChange === 'REJECTED_REGRESSION' || offerProtected, offerProtected });
  });

  app.post('/api/v1/applications/:id/email-import/confirm', async (request, reply) => {
    const { id: applicationId } = request.params as { id: string };
    const workspaceId = workspace(request);
    const body = request.body as { token?: unknown; applyStage?: unknown } | null;
    if (typeof body?.token !== 'string' || typeof body.applyStage !== 'boolean') return reply.code(400).send({ error: 'INVALID_EMAIL_CONFIRMATION' });
    trimExpired();
    const pending = pendingImports.get(body.token);
    if (!pending || pending.applicationId !== applicationId || pending.workspaceId !== workspaceId || pending.expiresAt <= Date.now()) return reply.code(409).send({ error: 'EMAIL_PREVIEW_EXPIRED' });
    if (body.applyStage && !pending.proposedStage) return reply.code(409).send({ error: 'NO_STAGE_PROPOSED' });
    const event = await db.transaction(async (tx) => {
      const current = (await tx.select().from(applications).where(and(eq(applications.id, applicationId), eq(applications.workspaceId, workspaceId))).limit(1).for('update'))[0];
      if (!current) return { error: 'NOT_FOUND' as const };
      if (current.version !== pending.expectedVersion || current.recruitmentStage !== pending.expectedStage) return { error: 'STALE_APPLICATION_VERSION' as const };
      if (body.applyStage) {
        const activeAssist = await tx.select({ id: assistedAttempts.id }).from(assistedAttempts).where(and(eq(assistedAttempts.workspaceId, workspaceId), eq(assistedAttempts.applicationId, applicationId), inArray(assistedAttempts.status, ['PREPARED', 'STARTING', 'REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF', 'UNKNOWN']))).limit(1);
        if (activeAssist.length) return { error: 'ASSIST_ACTIVE_ATTEMPT' as const };
      }
      const messageRefs = [pending.messageRef, pending.messageIdRef].filter((value): value is string => Boolean(value));
      const duplicate = await tx.select({ id: applicationEvents.id }).from(applicationEvents).where(and(
        eq(applicationEvents.workspaceId, workspaceId), eq(applicationEvents.applicationId, applicationId),
        sql`(${applicationEvents.evidence}->>'messageRef' = ANY(${messageRefs}::text[]) OR ${applicationEvents.evidence}->>'messageIdRef' = ANY(${messageRefs}::text[]))`,
      )).limit(1);
      if (duplicate.length) return { error: 'EMAIL_ALREADY_IMPORTED' as const };
      let version = current.version;
      let nextStage = current.recruitmentStage;
      if (body.applyStage && pending.proposedStage) {
        if (classifyRecruitmentStageChange(current.recruitmentStage, pending.proposedStage) !== 'ADVANCE') return { error: 'RECRUITMENT_STAGE_CANNOT_REGRESS' as const };
        const updated = (await tx.update(applications).set({ recruitmentStage: pending.proposedStage, updatedAt: new Date(), version: current.version + 1 }).where(and(eq(applications.id, applicationId), eq(applications.workspaceId, workspaceId), eq(applications.version, current.version))).returning())[0];
        if (!updated) return { error: 'STALE_APPLICATION_VERSION' as const };
        version = updated.version;
        nextStage = updated.recruitmentStage;
      }
      const imported = (await tx.insert(applicationEvents).values({
        workspaceId, applicationId, eventType: 'EMAIL_IMPORTED', reason: body.applyStage ? 'Email import confirmed with stage change' : 'Email import confirmed without stage change',
        priorState: current.recruitmentStage, newState: nextStage,
        evidence: { messageRef: pending.messageRef, ...(pending.messageIdRef ? { messageIdRef: pending.messageIdRef } : {}), source: pending.source, messageDate: pending.messageDate, ...(body.applyStage && pending.proposedStage ? { stageProposal: pending.proposedStage } : {}) }, aggregateVersion: version,
      }).returning())[0]!;
      return { event: imported, applicationVersion: version, recruitmentStage: nextStage };
    });
    if ('error' in event) return reply.code(event.error === 'NOT_FOUND' ? 404 : 409).send({ error: event.error });
    pendingImports.delete(body.token);
    return reply.code(201).header('Cache-Control', 'no-store').send(event);
  });
}
