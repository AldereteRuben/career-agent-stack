import { documentReadiness } from './document-reuse.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, applications, applicationEvents, assistedAttempts, documentVersions } from '@career/db';
import { activeAssistedStates, assistedPrepareSchema, assistedConsentSchema, assistedSubmitConsentSchema, assistedHandoffSchema, assistedResolutionSchema, leverApplicationUrl, readIdentity, documentFileName, type AssistedPlan } from '@career/domain';
import { latestProfile, lockKey, profileLockKey, type Tx } from './workspace-data.js';
import { AssistedBrowser } from './assisted-browser.js';
import { config } from './config.js';

type Attempt = typeof assistedAttempts.$inferSelect;
type SubmissionPermit = { state: string; digest?: string; claimedAt?: string; completedAt?: string };
const resultObject = (value: Attempt['result']) => (value ?? {}) as Record<string, unknown> & { submissionPermit?: SubmissionPermit };
const digest = (plan: AssistedPlan) => createHash('sha256').update(JSON.stringify(plan)).digest('hex');
const fail = (code: string): never => { throw new Error(code); };
const terminalApplication = (state: string, stage: string) => ['CONFIRMED', 'CANCELLED'].includes(state) || ['HIRED', 'REJECTED', 'WITHDRAWN'].includes(stage);

export async function registerAssistedRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, browser = new AssistedBrowser()) {
  // A restart never resumes a grant or a browser action. Uncertain runs require human reconciliation.
  await db.update(assistedAttempts).set({ status: 'INVALIDATED', updatedAt: new Date(), result: { reason: 'ASSIST_RESTARTED' } }).where(eq(assistedAttempts.status, 'PREPARED'));
  await db.execute(sql`update assisted_attempts set status = 'UNKNOWN', updated_at = now(), result = coalesce(result, '{}'::jsonb) || jsonb_build_object('reason', 'ASSIST_BROWSER_LOST') where status in ('STARTING', 'REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF')`);
  await db.execute(sql`update applications set state = 'UNKNOWN', version = version + 1, updated_at = now() where state not in ('CONFIRMED', 'CANCELLED', 'UNKNOWN') and id in (select application_id from assisted_attempts where status = 'UNKNOWN')`);
  app.addHook('onClose', async () => { await stopAll(); });
  const attemptWhere = (id: string, workspaceId: string) => and(eq(assistedAttempts.id, id), eq(assistedAttempts.workspaceId, workspaceId));
  async function getAttempt(tx: Tx, id: string, workspaceId: string) {
    const row = (await tx.select().from(assistedAttempts).where(attemptWhere(id, workspaceId)).limit(1).for('update'))[0];
    return row ?? fail('ASSIST_NOT_FOUND');
  }
  async function getApplication(tx: Tx, id: string, workspaceId: string) {
    const row = (await tx.select().from(applications).where(and(eq(applications.id, id), eq(applications.workspaceId, workspaceId))).limit(1).for('update'))[0];
    return row ?? fail('ASSIST_NOT_FOUND');
  }
  async function planFor(tx: Tx, applicationId: string, workspaceId: string, documentId: string, phone: string, org: string): Promise<AssistedPlan> {
    const application = await getApplication(tx, applicationId, workspaceId);
    if (terminalApplication(application.state, application.recruitmentStage)) fail('ASSIST_APPLICATION_CLOSED');
    const url = leverApplicationUrl(application.canonicalUrl); if (!url) return fail('ASSIST_UNSUPPORTED_URL');
    const profile = await latestProfile(tx, workspaceId); if (!profile) return fail('ASSIST_PROFILE_REQUIRED');
    const identity = readIdentity(profile.profile);
    if (!identity.fullName || identity.fullName.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email) || identity.email.length > 254) fail('ASSIST_PROFILE_REQUIRED');
    const document = (await tx.select().from(documentVersions).where(and(eq(documentVersions.id, documentId), eq(documentVersions.workspaceId, workspaceId))).limit(1))[0];
    if (!document || document.approvalStatus !== 'USER_APPROVED') return fail('ASSIST_DOCUMENT_REQUIRED');
    // Same printed-content check as approval and linking: the PDF must still show the current name, email and approved facts.
    if (!(await documentReadiness(tx, workspaceId, [document]))[0]?.assistReady) fail('ASSIST_DOCUMENT_STALE');
    const root = resolve(config.FILES_LOCAL_PATH); const path = resolve(root, document.storagePath); const rel = relative(root, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) fail('ASSIST_DOCUMENT_REQUIRED');
    const bytes = await readFile(path).catch(() => fail('ASSIST_DOCUMENT_REQUIRED'));
    if (createHash('sha256').update(bytes).digest('hex') !== document.sha256) fail('ASSIST_DOCUMENT_STALE');
    return { adapter: 'lever-hosted-v1', url, documentId, documentSha256: document.sha256, documentName: documentFileName(document.name, document.revision), applicationVersion: application.version, fields: { name: identity.fullName, email: identity.email, phone, org } };
  }
  async function validate(tx: Tx, attempt: Attempt, workspaceId: string) {
    const current = await planFor(tx, attempt.applicationId, workspaceId, attempt.plan.documentId, attempt.plan.fields.phone, attempt.plan.fields.org);
    if (digest(current) !== attempt.digest) fail('ASSIST_INPUTS_CHANGED');
  }
  async function event(tx: Tx, attempt: Attempt, type: string, reason: string) {
    const application = await getApplication(tx, attempt.applicationId, attempt.workspaceId);
    await tx.insert(applicationEvents).values({ workspaceId: attempt.workspaceId, applicationId: attempt.applicationId, eventType: type, reason, aggregateVersion: application.version, evidence: { attemptId: attempt.id, adapter: attempt.plan.adapter, digest: attempt.digest } });
  }
  async function markLost(id: string, workspaceId: string) {
    await db.transaction(async (tx) => {
      const attempt = await getAttempt(tx, id, workspaceId);
      if (!['STARTING', 'REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF'].includes(attempt.status)) return;
      await tx.update(assistedAttempts).set({ status: 'UNKNOWN', updatedAt: new Date(), result: { ...attempt.result, reason: 'ASSIST_BROWSER_LOST' } }).where(attemptWhere(id, workspaceId));
      const application = await getApplication(tx, attempt.applicationId, workspaceId);
      if (!['CONFIRMED', 'CANCELLED'].includes(application.state)) await tx.update(applications).set({ state: 'UNKNOWN', version: application.version + 1, updatedAt: new Date() }).where(eq(applications.id, application.id));
      await event(tx, attempt, 'ASSIST_BROWSER_LOST', 'Browser closed or connection lost; no automatic retry is permitted.');
    });
  }
  const wrap = (handler: (request: FastifyRequest) => Promise<unknown>) => async (request: FastifyRequest, reply: import('fastify').FastifyReply) => {
    try { return await handler(request); }
    catch (error) {
      const code = error instanceof Error && /^ASSIST_[A-Z_]+$/.test(error.message) ? error.message : 'ASSIST_OPERATION_FAILED';
      return reply.code(code === 'ASSIST_NOT_FOUND' ? 404 : code === 'ASSIST_INVALID_INPUT' ? 400 : 409).send({ error: code });
    }
  };
  const requestId = (request: FastifyRequest) => {
    const id = (request.params as { id: string }).id;
    if (!/^[a-f0-9-]{36}$/i.test(id)) fail('ASSIST_NOT_FOUND');
    return id;
  };
  app.get('/api/v1/applications/:id/assist', wrap(async (request) => {
    const workspaceId = workspace(request); const id = requestId(request);
    const application = (await db.select().from(applications).where(and(eq(applications.id, id), eq(applications.workspaceId, workspaceId))).limit(1))[0];
    if (!application) return fail('ASSIST_NOT_FOUND');
    const [profile, documents, attempts] = await Promise.all([
      latestProfile(db, workspaceId),
      db.select().from(documentVersions).where(and(eq(documentVersions.workspaceId, workspaceId), eq(documentVersions.approvalStatus, 'USER_APPROVED'))).orderBy(desc(documentVersions.createdAt)),
      db.select().from(assistedAttempts).where(and(eq(assistedAttempts.workspaceId, workspaceId), eq(assistedAttempts.applicationId, id))).orderBy(desc(assistedAttempts.createdAt)).limit(30),
    ]);
    return { supported: Boolean(leverApplicationUrl(application.canonicalUrl)), url: leverApplicationUrl(application.canonicalUrl), identity: readIdentity(profile?.profile ?? {}), application, documents: (await documentReadiness(db, workspaceId, documents)).map(({ id, name, revision, sha256, approvalStatus, assistReady }) => ({ id, name, revision, sha256, approvalStatus, assistReady })), attempts };
  }));
  app.post('/api/v1/applications/:id/assist/prepare', wrap(async (request) => {
    const parsed = assistedPrepareSchema.safeParse(request.body); if (!parsed.success) return fail('ASSIST_INVALID_INPUT');
    const workspaceId = workspace(request); const applicationId = requestId(request);
    return db.transaction(async (tx) => {
      await lockKey(tx, profileLockKey(workspaceId));
      await getApplication(tx, applicationId, workspaceId);
      const existing = (await tx.select().from(assistedAttempts).where(and(eq(assistedAttempts.workspaceId, workspaceId), eq(assistedAttempts.applicationId, applicationId), inArray(assistedAttempts.status, activeAssistedStates))).limit(1))[0];
      if (existing && !(existing.status === 'PREPARED' && existing.expiresAt < new Date())) return fail('ASSIST_ACTIVE_ATTEMPT');
      if (existing) await tx.update(assistedAttempts).set({ status: 'INVALIDATED', updatedAt: new Date(), result: { reason: 'ASSIST_CONSENT_EXPIRED' } }).where(attemptWhere(existing.id, workspaceId));
      const plan = await planFor(tx, applicationId, workspaceId, parsed.data.documentId, parsed.data.phone, parsed.data.organization);
      const attempt = (await tx.insert(assistedAttempts).values({ workspaceId, applicationId, plan, digest: digest(plan), expiresAt: new Date(Date.now() + 600_000) }).returning())[0]!;
      await event(tx, attempt, 'ASSIST_PREPARED', 'Candidate reviewed contact data and document selection; no employer page opened.');
      return attempt;
    });
  }));
  app.post('/api/v1/assisted-attempts/:id/start', wrap(async (request) => {
    const parsed = assistedConsentSchema.safeParse(request.body); if (!parsed.success) return fail('ASSIST_INVALID_INPUT');
    const workspaceId = workspace(request); const id = requestId(request);
    if (browser.busy()) return fail('ASSIST_BROWSER_BUSY');
    await db.transaction(async (tx) => {
      await lockKey(tx, profileLockKey(workspaceId));
      const attempt = await getAttempt(tx, id, workspaceId);
      if (attempt.status !== 'PREPARED') fail('ASSIST_CONSENT_ALREADY_USED');
      if (attempt.expiresAt < new Date()) fail('ASSIST_CONSENT_EXPIRED');
      if (attempt.digest !== parsed.data.expectedDigest) fail('ASSIST_INPUTS_CHANGED');
      await validate(tx, attempt, workspaceId);
      await tx.update(assistedAttempts).set({ status: 'STARTING', consentedAt: new Date(), updatedAt: new Date() }).where(attemptWhere(id, workspaceId));
      await event(tx, attempt, 'ASSIST_CONSENT_GRANTED', 'One-use consent to open the displayed Lever page and fill displayed contact fields. No upload or submission authorized.');
    });
    try {
      return await db.transaction(async (tx) => {
        await lockKey(tx, profileLockKey(workspaceId));
        const attempt = await getAttempt(tx, id, workspaceId);
        if (attempt.status !== 'STARTING') fail('ASSIST_CONSENT_ALREADY_USED');
        await validate(tx, attempt, workspaceId);
        const result = await browser.start(id, attempt.plan, () => markLost(id, workspaceId));
        const row = (await tx.update(assistedAttempts).set({ status: result.reason ? 'HANDOFF_REQUIRED' : 'REVIEW', result, updatedAt: new Date() }).where(attemptWhere(id, workspaceId)).returning())[0]!;
        await event(tx, attempt, 'ASSIST_REVIEW_REQUIRED', 'Visible browser ready; network paused until explicit manual handoff.');
        return row;
      });
    } catch {
      await browser.close(id).catch(() => undefined);
      await db.update(assistedAttempts).set({ status: 'FAILED', result: { reason: 'ASSIST_BROWSER_START_FAILED' }, updatedAt: new Date() }).where(and(attemptWhere(id, workspaceId), eq(assistedAttempts.status, 'STARTING')));
      return fail('ASSIST_BROWSER_START_FAILED');
    }
  }));
  app.post('/api/v1/assisted-attempts/:id/handoff', wrap(async (request) => {
    if (!assistedHandoffSchema.safeParse(request.body).success) return fail('ASSIST_INVALID_INPUT');
    const workspaceId = workspace(request); const id = requestId(request);
    const row = await db.transaction(async (tx) => {
      await lockKey(tx, profileLockKey(workspaceId));
      const attempt = await getAttempt(tx, id, workspaceId);
      if (!['REVIEW', 'HANDOFF_REQUIRED'].includes(attempt.status)) return fail('ASSIST_INVALID_STATE');
      if (!browser.has(id)) return fail('ASSIST_BROWSER_LOST');
      await validate(tx, attempt, workspaceId);
      const application = await getApplication(tx, attempt.applicationId, workspaceId);
      await tx.update(applications).set({ state: 'IN_PROGRESS', version: application.version + 1, updatedAt: new Date() }).where(eq(applications.id, application.id));
      await event(tx, attempt, 'ASSIST_MANUAL_HANDOFF', 'User reviewed the same browser and took control of uploads, answers, consents and submission.');
      return (await tx.update(assistedAttempts).set({ status: 'HANDED_OFF', updatedAt: new Date() }).where(attemptWhere(id, workspaceId)).returning())[0]!;
    });
    try { await browser.handoff(id); } catch { await markLost(id, workspaceId); return fail('ASSIST_BROWSER_LOST'); }
    return row;
  }));
  app.post('/api/v1/assisted-attempts/:id/submit', wrap(async (request) => {
    const parsed = assistedSubmitConsentSchema.safeParse(request.body); if (!parsed.success) return fail('ASSIST_INVALID_INPUT');
    const workspaceId = workspace(request); const id = requestId(request);
    const preview = await db.transaction(async (tx) => {
      await lockKey(tx, profileLockKey(workspaceId));
      const attempt = await getAttempt(tx, id, workspaceId);
      if (attempt.status !== 'REVIEW') fail('ASSIST_INVALID_STATE');
      if (attempt.digest !== parsed.data.expectedDigest) fail('ASSIST_INPUTS_CHANGED');
      if (resultObject(attempt.result).submissionPermit) fail('ASSIST_SUBMISSION_ALREADY_AUTHORIZED');
      if (!browser.has(id)) fail('ASSIST_BROWSER_LOST');
      await validate(tx, attempt, workspaceId);
      return attempt;
    });
    const inspection = await browser.inspectSubmit(id);
    if (!inspection.supported) return fail(inspection.reason);
    const claimed = await db.transaction(async (tx) => {
        await lockKey(tx, profileLockKey(workspaceId));
        const attempt = await getAttempt(tx, id, workspaceId);
        if (attempt.status !== 'REVIEW' || resultObject(attempt.result).submissionPermit) fail('ASSIST_SUBMISSION_ALREADY_AUTHORIZED');
        if (attempt.digest !== preview.digest || attempt.digest !== parsed.data.expectedDigest) fail('ASSIST_INPUTS_CHANGED');
        if (!browser.has(id)) fail('ASSIST_BROWSER_LOST');
        await validate(tx, attempt, workspaceId);
        const document = (await tx.select().from(documentVersions).where(and(eq(documentVersions.id, attempt.plan.documentId), eq(documentVersions.workspaceId, workspaceId))).limit(1))[0];
        if (!document) return fail('ASSIST_DOCUMENT_STALE');
        if (document.sha256 !== attempt.plan.documentSha256 || document.approvalStatus !== 'USER_APPROVED') fail('ASSIST_DOCUMENT_STALE');
        const root = resolve(config.FILES_LOCAL_PATH); const path = resolve(root, document.storagePath); const rel = relative(root, path);
        if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) fail('ASSIST_DOCUMENT_REQUIRED');
        const uploaded = await readFile(path).catch(() => fail('ASSIST_DOCUMENT_REQUIRED'));
        if (createHash('sha256').update(uploaded).digest('hex') !== attempt.plan.documentSha256) fail('ASSIST_DOCUMENT_STALE');
        const now = new Date().toISOString();
        const row = (await tx.update(assistedAttempts).set({ result: { ...resultObject(attempt.result), submissionPermit: { state: 'CLAIMED', digest: attempt.digest, claimedAt: now } } as Attempt['result'], updatedAt: new Date() }).where(attemptWhere(id, workspaceId)).returning())[0]!;
        await event(tx, attempt, 'ASSIST_SUBMISSION_AUTHORIZED', 'Candidate separately authorized one upload and submission for the exact displayed employer URL, contact fields and PDF hash.');
        return { row, bytes: uploaded };
    });
    const permit = claimed.row; const bytes = claimed.bytes;
    let submission;
    try {
      submission = await browser.submit(id, { bytes, sha256: permit.plan.documentSha256, name: permit.plan.documentName, fields: permit.plan.fields });
    } catch {
      submission = { outcome: 'UNKNOWN' as const, reason: 'ASSIST_SUBMISSION_UNCERTAIN' };
      await browser.close(id);
    }
    return db.transaction(async (tx) => {
      const attempt = await getAttempt(tx, id, workspaceId);
      const application = await getApplication(tx, attempt.applicationId, workspaceId);
      const outcome = attempt.status === 'REVIEW' ? submission.outcome : 'UNKNOWN';
      const finalReason = attempt.status === 'REVIEW' ? submission.reason : 'ASSIST_SUBMISSION_CANCELLED_DURING_WRITE';
      const state = outcome === 'CONFIRMED' ? 'CONFIRMED' : 'UNKNOWN';
      if (!['CANCELLED', 'CONFIRMED'].includes(application.state)) await tx.update(applications).set({ state, version: application.version + 1, updatedAt: new Date() }).where(eq(applications.id, application.id));
      const result = { ...resultObject(attempt.result), submissionPermit: { ...resultObject(attempt.result).submissionPermit, state: outcome, completedAt: new Date().toISOString() }, reason: finalReason, ...(outcome === 'CONFIRMED' && submission.receipt ? { receipt: submission.receipt } : {}) } as Attempt['result'];
      const row = (await tx.update(assistedAttempts).set({ status: outcome === 'CONFIRMED' ? 'CONFIRMED' : 'UNKNOWN', result, updatedAt: new Date() }).where(attemptWhere(id, workspaceId)).returning())[0]!;
      await tx.insert(applicationEvents).values({ workspaceId, applicationId: application.id, eventType: outcome === 'CONFIRMED' ? 'ASSIST_SUBMISSION_CONFIRMED' : 'ASSIST_SUBMISSION_UNKNOWN', reason: finalReason, priorState: application.state, newState: state, aggregateVersion: application.version + 1, evidence: { attemptId: id, adapter: attempt.plan.adapter, digest: attempt.digest, receipt: submission.receipt ?? null } });
      return row;
    });
  }));
  app.post('/api/v1/assisted-attempts/:id/cancel', wrap(async (request) => {
    const workspaceId = workspace(request); const id = requestId(request);
    const row = await db.transaction(async (tx) => {
      const attempt = await getAttempt(tx, id, workspaceId);
      if (!activeAssistedStates.includes(attempt.status as typeof activeAssistedStates[number])) return fail('ASSIST_INVALID_STATE');
      const status = attempt.status === 'PREPARED' ? 'CANCELLED' : 'UNKNOWN';
      if (status === 'UNKNOWN') {
        const application = await getApplication(tx, attempt.applicationId, workspaceId);
        if (!['CONFIRMED', 'CANCELLED'].includes(application.state)) await tx.update(applications).set({ state: 'UNKNOWN', version: application.version + 1, updatedAt: new Date() }).where(eq(applications.id, application.id));
      }
      return (await tx.update(assistedAttempts).set({ status, updatedAt: new Date(), result: { ...attempt.result, reason: 'ASSIST_USER_CLOSED' } }).where(attemptWhere(id, workspaceId)).returning())[0]!;
    });
    await browser.close(id); return row;
  }));
  async function stopAll() {
    const rows = await db.select({ id: assistedAttempts.id, workspaceId: assistedAttempts.workspaceId }).from(assistedAttempts).where(inArray(assistedAttempts.status, ['STARTING', 'REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF']));
    await browser.closeAll();
    for (const row of rows) await markLost(row.id, row.workspaceId);
    // Startup may have completed while its database row was locked.
    await browser.closeAll();
    await db.update(assistedAttempts).set({ status: 'INVALIDATED', updatedAt: new Date(), result: { reason: 'ASSIST_SESSION_ENDED' } }).where(eq(assistedAttempts.status, 'PREPARED'));
  }
  app.post('/api/v1/assisted-attempts/:id/resolve', wrap(async (request) => {
    const parsed = assistedResolutionSchema.safeParse(request.body); if (!parsed.success) return fail('ASSIST_INVALID_INPUT');
    const workspaceId = workspace(request); const id = requestId(request);
    const row = await db.transaction(async (tx) => {
      const attempt = await getAttempt(tx, id, workspaceId);
      if (!['REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF', 'UNKNOWN'].includes(attempt.status)) return fail('ASSIST_INVALID_STATE');
      const application = await getApplication(tx, attempt.applicationId, workspaceId);
      if (application.state === 'CANCELLED' || (application.state === 'CONFIRMED' && parsed.data.outcome !== 'CONFIRMED')) return fail('ASSIST_APPLICATION_CLOSED');
      // Stop the same browser before allowing a new attempt; do not leave a submission-capable window behind.
      await browser.close(id);
      const state = parsed.data.outcome === 'CONFIRMED' ? 'CONFIRMED' : parsed.data.outcome === 'NOT_SUBMITTED' ? 'REVIEW_REQUIRED' : 'UNKNOWN';
      await tx.update(applications).set({ state, version: application.version + 1, updatedAt: new Date() }).where(eq(applications.id, application.id));
      await tx.insert(applicationEvents).values({ workspaceId, applicationId: application.id, eventType: 'ASSIST_USER_RECONCILED', reason: parsed.data.reason, priorState: application.state, newState: state, aggregateVersion: application.version + 1, evidence: { type: 'USER_ATTESTATION', attemptId: id, outcome: parsed.data.outcome } });
      return (await tx.update(assistedAttempts).set({ status: parsed.data.outcome, result: { ...attempt.result, outcome: parsed.data.outcome, reason: parsed.data.reason }, updatedAt: new Date() }).where(attemptWhere(id, workspaceId)).returning())[0]!;
    });
    await browser.close(id); return row;
  }));
  return { stopAll };
}
