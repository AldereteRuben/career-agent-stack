import { RELEASE_VERSION } from '@career/domain';
import { registerBackupRoutes } from './backup-routes.js';
import { config, projectRoot } from './config.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { and, desc, eq, ne, gt, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, pool, applications, applicationEvents, assistedAttempts, answerVersions, boards, documentVersions, jobs, jobOccurrences, jobSnapshots, profileFacts, profileVersions, searchProfiles, sourcePolicyReviews, workspaces } from '@career/db';
import { legacyEmployment, applicationUpdateSchema, applicationSchema, applicationState, answerSchema, boardSchema, factSchema, jobImportSchema, profileUpdateSchema, canTransitionApplication, classifyRecruitmentStageChange, documentFileName, documentLanguage, normalizeLocaleTag, printedResumeIdentity, printedStatement, profileCompletion } from '@career/domain';
import { enforceLocalRequest, expiredSessionCookie, issueSession, sessionCookie, workspaceFromRequest } from './session.js';
import { normalizeJobUrl, readBoardWithReport } from './sources.js';
import { registerAssistedRoutes } from './assisted-routes.js';
import { renderResume } from './document-renderer.js';
import { documentReadiness } from './document-reuse.js';
import { registerResumeJourney } from './resume-journey.js';
import { answerLockKey, latestAnswers, latestFacts, latestProfile, loadMatchingContext, lockKey, occurrencesForBoard, profileLockKey, rescoreWorkspaceJobs, scoreJobs, applyMatch, type Tx } from './workspace-data.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] }, bodyLimit: 1_000_000, trustProxy: false, disableRequestLogging: true });
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

const localData = config.DATA_LOCAL_PATH;
await mkdir(localData, { recursive: true, mode: 0o700 });
const workspaceRows = await db.select().from(workspaces).limit(1);
const workspaceId = workspaceRows[0]?.id ?? (await db.insert(workspaces).values({ name: 'My career workspace', timezone: 'Europe/Madrid' }).returning({ id: workspaces.id }))[0]!.id;
await db.insert(profileVersions).values({ workspaceId, revision: 1, profile: {} }).onConflictDoNothing();
const setupTokenPath = resolve(localData, 'setup-token');
let setupToken: string;
try { setupToken = (await readFile(setupTokenPath, 'utf8')).trim(); }
catch {
  setupToken = randomBytes(24).toString('base64url');
  await writeFile(setupTokenPath, setupToken, { mode: 0o600 });
  await chmod(setupTokenPath, 0o600);
  app.log.warn({ setupTokenPath }, 'First-run sign-in token written to a private local file');
}

app.addHook('onRequest', async (request, reply) => {
  const rejected = enforceLocalRequest(request, reply);
  if (rejected) return;
  const path = request.url.split('?')[0];
  if (path === '/healthz' || path === '/api/v1/session') return;
  if (!workspaceFromRequest(request)) return reply.code(401).send({ error: 'SESSION_REQUIRED' });
});

const workspace = (request: FastifyRequest) => workspaceFromRequest(request) ?? workspaceId;
const isClosedApplication = (application: { state: string; recruitmentStage: string }) => application.state === 'CANCELLED' || ['REJECTED', 'WITHDRAWN'].includes(application.recruitmentStage);
const fail = (reply: FastifyReply, status: number, code: string, detail?: string) => reply.code(status).send({ error: code, ...(detail ? { detail } : {}) });
type BodySchema<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } };
const parseBody = <T>(schema: BodySchema<T>, body: unknown, reply: FastifyReply): T | null => {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  fail(reply, 400, 'INVALID_INPUT', result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  return null;
};
const omit = <T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> => {
  const copy = { ...value };
  for (const key of keys) delete (copy as Partial<T>)[key];
  return copy;
};

app.get('/healthz', async (_request, reply) => {
  try { await pool.query('select 1'); return { status: 'ok', database: 'ready', externalWrites: true, version: RELEASE_VERSION }; }
  catch { return fail(reply, 503, 'DATABASE_UNAVAILABLE'); }
});

app.get('/api/v1/session', async (request) => ({ authenticated: Boolean(workspaceFromRequest(request)), setupRequired: true, capabilities: { profile: true, tracking: true, discovery: true, documentExport: true, autofill: true, externalWrites: true, email: false, ai: false } }));
app.post('/api/v1/session', async (request, reply) => {
  const body = request.body as { setupToken?: unknown } | null;
  if (typeof body?.setupToken !== 'string' || !body.setupToken || body.setupToken.length > 200) return fail(reply, 400, 'SETUP_TOKEN_REQUIRED');
  let token: string;
  try { token = (await readFile(setupTokenPath, 'utf8')).trim(); } catch { return fail(reply, 410, 'SETUP_TOKEN_ALREADY_USED', 'Use the local session recovery command to create a new token.'); }
  const expected = Buffer.from(token); const actual = Buffer.from(body.setupToken);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return fail(reply, 401, 'INVALID_SETUP_TOKEN');
  await unlink(setupTokenPath);
  reply.header('Set-Cookie', sessionCookie(issueSession(workspaceId)));
  return { authenticated: true, expiresInSeconds: 1_209_600 };
});
let stopAssistedBrowsers = async () => {};
app.delete('/api/v1/session', async (_request, reply) => { await stopAssistedBrowsers(); reply.header('Set-Cookie', expiredSessionCookie()); return { authenticated: false }; });

app.get('/api/v1/summary', async (request) => {
  const id = workspace(request);
  const now = new Date();
  const approvedBoard = and(eq(boards.workspaceId, id), eq(boards.enabled, true), eq(boards.permissionStatus, 'APPROVED_FOR_SCOPE'), eq(boards.associationStatus, 'VERIFIED'), or(isNull(boards.reviewDueAt), gt(boards.reviewDueAt, now)));
  const profile = await latestProfile(db, id);
  const [boardRows, jobRows, applicationRows, facts, answerRows, counts, jobCount, boardCounts, context] = await Promise.all([
    db.select().from(boards).where(eq(boards.workspaceId, id)).orderBy(desc(boards.updatedAt)).limit(10),
    db.select().from(jobs).where(eq(jobs.workspaceId, id)).orderBy(desc(jobs.updatedAt)).limit(6),
    db.select().from(applications).where(eq(applications.workspaceId, id)).orderBy(desc(applications.updatedAt)).limit(6),
    latestFacts(db, id, profile?.id),
    latestAnswers(db, id),
    db.select({ state: applications.state, count: sql<number>`count(*)::int`, active: sql<number>`(count(*) filter (where ${applications.state} <> 'CANCELLED' and ${applications.recruitmentStage} not in ('REJECTED', 'WITHDRAWN', 'HIRED')))::int` }).from(applications).where(eq(applications.workspaceId, id)).groupBy(applications.state),
    db.select({ count: sql<number>`count(*)::int` }).from(jobs).where(eq(jobs.workspaceId, id)),
    db.select({ total: sql<number>`count(*)::int`, approved: sql<number>`(count(*) filter (where ${approvedBoard}))::int` }).from(boards).where(eq(boards.workspaceId, id)),
    loadMatchingContext(db, id),
  ]);
  const applicationCounts = Object.fromEntries(applicationState.map((state) => [state, counts.find((row) => row.state === state)?.count ?? 0])) as Record<(typeof applicationState)[number], number>;
  // Active = not cancelled and not in a terminal recruitment stage (REJECTED, WITHDRAWN, HIRED); mirrors isActiveApplication in @career/domain.
  const activeApplications = counts.reduce((sum, row) => sum + row.active, 0);
  const completion = profileCompletion(profile?.profile ?? {}, facts);
  return {
    boards: boardRows, recentJobs: await scoreJobs(db, id, jobRows, context), recentApplications: applicationRows, pendingFacts: completion.pendingFactCount, unansweredItems: answerRows.filter((answer) => answer.approvalStatus === 'UNANSWERED').length,
    applicationCounts, activeApplications, totalJobs: jobCount[0]?.count ?? 0, boardCount: boardCounts[0]?.total ?? 0, approvedSourceCount: boardCounts[0]?.approved ?? 0, profileCompletion: completion,
    capabilities: { externalWrites: true, email: false, browserRunner: true, hostedAI: false },
  };
});

app.get('/api/v1/profile', async (request) => {
  const id = workspace(request);
  const profile = await latestProfile(db, id);
  const [facts, answers] = await Promise.all([
    latestFacts(db, id, profile?.id),
    latestAnswers(db, id),
  ]);
  return { revision: profile?.revision ?? 1, locale: profile?.locale ?? 'en-GB', profile: profile?.profile ?? {}, facts: facts.map((fact) => ({ ...fact, details: fact.details ?? legacyEmployment(fact.kind, fact.statement) })), answers, completion: profileCompletion(profile?.profile ?? {}, facts) };
});

/** Rescoring is derived data; a failure must not undo the user's committed change. */
const rescoreAfterChange = async (id: string) => {
  try { await rescoreWorkspaceJobs(db, id); } catch (error) { app.log.error({ err: error, workspaceId: id }, 'Job rescoring failed'); }
};

app.put('/api/v1/profile', async (request, reply) => {
  const id = workspace(request);
  const parsed = profileUpdateSchema.safeParse(request.body);
  if (!parsed.success) return fail(reply, 400, 'INVALID_PROFILE');
  const result = await db.transaction(async (tx) => {
    await lockKey(tx, profileLockKey(id));
    const latest = await latestProfile(tx, id);
    if (parsed.data.expectedRevision !== undefined && parsed.data.expectedRevision !== (latest?.revision ?? 1)) return { conflict: latest?.revision ?? 1 } as const;
    const locale = parsed.data.locale !== undefined ? normalizeLocaleTag(parsed.data.locale, latest?.locale ?? 'en-GB') : latest?.locale ?? 'en-GB';
    const created = (await tx.insert(profileVersions).values({ workspaceId: id, revision: (latest?.revision ?? 0) + 1, locale, profile: parsed.data.profile }).returning())[0]!;
    if (latest) {
      const priorFacts = await latestFacts(tx, id, latest.id);
      if (priorFacts.length) await tx.insert(profileFacts).values(priorFacts.map((fact) => ({ ...omit(fact, 'id'), profileVersionId: created.id })));
    }
    return { created } as const;
  });
  if ('conflict' in result) return fail(reply, 409, 'PROFILE_REVISION_CONFLICT', `Current revision is ${result.conflict}.`);
  await rescoreAfterChange(id);
  return reply.code(201).send(result.created);
});

app.post('/api/v1/profile/facts', async (request, reply) => {
  const parsed = parseBody(factSchema, request.body, reply); if (!parsed) return;
  if (parsed.approvalStatus === 'USER_APPROVED') return fail(reply, 400, 'APPROVAL_REQUIRES_SEPARATE_ACTION');
  const id = workspace(request);
  const fact = await db.transaction(async (tx) => {
    await lockKey(tx, profileLockKey(id));
    const version = await latestProfile(tx, id);
    if (!version) return null;
    return (await tx.insert(profileFacts).values({ workspaceId: id, profileVersionId: version.id, kind: parsed.kind, statement: parsed.statement, details: parsed.details, tags: parsed.tags, source: parsed.source, approvalStatus: 'SUGGESTED' }).returning())[0];
  });
  if (!fact) return fail(reply, 409, 'PROFILE_NOT_CONFIGURED');
  return reply.code(201).send(fact);
});
// Corrections create a new profile revision. Earlier facts and PDF claims remain intact.
app.put('/api/v1/profile/facts/:id', async (request, reply) => {
  const body = request.body as { expectedRevision?: unknown; fact?: unknown } | null;
  if (!Number.isSafeInteger(body?.expectedRevision) || Number(body?.expectedRevision) < 1) return fail(reply, 400, 'INVALID_PROFILE');
  const parsed = parseBody(factSchema, body?.fact, reply); if (!parsed) return;
  if (parsed.approvalStatus === 'USER_APPROVED') return fail(reply, 400, 'APPROVAL_REQUIRES_SEPARATE_ACTION');
  const id = workspace(request); const { id: factId } = request.params as { id: string };
  const result = await db.transaction(async (tx) => {
    await lockKey(tx, profileLockKey(id));
    const latest = await latestProfile(tx, id);
    if (!latest || latest.revision !== body?.expectedRevision) return 'PROFILE_REVISION_CONFLICT' as const;
    const facts = await latestFacts(tx, id, latest.id);
    if (!facts.some((fact) => fact.id === factId)) return 'FACT_NOT_IN_CURRENT_REVISION' as const;
    const created = (await tx.insert(profileVersions).values({ workspaceId: id, revision: latest.revision + 1, locale: latest.locale, profile: latest.profile }).returning())[0]!;
    const unchanged = facts.filter((fact) => fact.id !== factId);
    if (unchanged.length) await tx.insert(profileFacts).values(unchanged.map((fact) => ({ ...omit(fact, 'id'), profileVersionId: created.id })));
    return (await tx.insert(profileFacts).values({ workspaceId: id, profileVersionId: created.id, kind: parsed.kind, statement: parsed.statement, details: parsed.details, tags: parsed.tags, source: 'USER_ENTERED', approvalStatus: 'SUGGESTED' }).returning())[0]!;
  });
  if (typeof result === 'string') return fail(reply, 409, result);
  await rescoreAfterChange(id);
  return reply.code(201).send(result);
});

app.post('/api/v1/profile/facts/:id/:action', async (request, reply) => {
  const { id: factId, action } = request.params as { id: string; action: string }; if (!['approve', 'reject'].includes(action)) return fail(reply, 404, 'NOT_FOUND');
  const id = workspace(request);
  const status = action === 'approve' ? 'USER_APPROVED' as const : 'REJECTED' as const;
  // Serialized with profile saves so an approval can never land on a revision that is being superseded and get lost in the copy.
  const result = await db.transaction(async (tx: Tx) => {
    await lockKey(tx, profileLockKey(id));
    const row = (await tx.select().from(profileFacts).where(and(eq(profileFacts.id, factId), eq(profileFacts.workspaceId, id))).limit(1))[0];
    if (!row) return 'NOT_FOUND' as const;
    const latest = await latestProfile(tx, id);
    if (row.profileVersionId !== latest?.id) return 'FACT_NOT_IN_CURRENT_REVISION' as const;
    if (row.approvalStatus === status) return { fact: row, changed: false };
    const updated = (await tx.update(profileFacts).set({ approvalStatus: status, approvedAt: status === 'USER_APPROVED' ? new Date() : null }).where(and(eq(profileFacts.id, factId), eq(profileFacts.workspaceId, id))).returning())[0]!;
    return { fact: updated, changed: true };
  });
  if (result === 'NOT_FOUND') return fail(reply, 404, 'NOT_FOUND');
  if (result === 'FACT_NOT_IN_CURRENT_REVISION') return fail(reply, 409, 'FACT_NOT_IN_CURRENT_REVISION', 'Reload the profile; this fact belongs to an older revision.');
  if (result.changed) await rescoreAfterChange(id);
  return result.fact;
});

app.get('/api/v1/answers', async (request) => {
  const id = workspace(request);
  // Latest revision per question by default; ?history=true returns every stored revision.
  if ((request.query as { history?: string }).history === 'true') return db.select().from(answerVersions).where(eq(answerVersions.workspaceId, id)).orderBy(desc(answerVersions.createdAt));
  return latestAnswers(db, id);
});
app.post('/api/v1/answers', async (request, reply) => {
  const parsed = parseBody(answerSchema, request.body, reply); if (!parsed) return;
  if (parsed.approvalStatus === 'USER_APPROVED') return fail(reply, 400, 'APPROVAL_REQUIRES_SEPARATE_ACTION');
  const id = workspace(request);
  const created = await db.transaction(async (tx) => {
    await lockKey(tx, answerLockKey(id, parsed));
    const previous = await tx.select({ revision: answerVersions.revision }).from(answerVersions).where(and(eq(answerVersions.workspaceId, id), eq(answerVersions.semanticKey, parsed.semanticKey), eq(answerVersions.jurisdiction, parsed.jurisdiction), eq(answerVersions.questionScope, parsed.questionScope))).orderBy(desc(answerVersions.revision)).limit(1);
    return tx.insert(answerVersions).values({ workspaceId: id, semanticKey: parsed.semanticKey, jurisdiction: parsed.jurisdiction, questionScope: parsed.questionScope, questionText: parsed.questionText || null, value: parsed.value, strategy: parsed.strategy, approvalStatus: 'UNANSWERED', reviewAfter: parsed.reviewAfter ? new Date(parsed.reviewAfter) : null, revision: (previous[0]?.revision ?? 0) + 1 }).returning();
  });
  return reply.code(201).send(created[0]);
});
app.post('/api/v1/answers/:id/approve', async (request, reply) => {
  const { id: answerId } = request.params as { id: string }; const id = workspace(request);
  const result = await db.transaction(async (tx) => {
    const answer = (await tx.select().from(answerVersions).where(and(eq(answerVersions.id, answerId), eq(answerVersions.workspaceId, id))).limit(1))[0];
    if (!answer) return 'NOT_FOUND' as const;
    await lockKey(tx, answerLockKey(id, answer));
    const latest = await tx.select({ id: answerVersions.id }).from(answerVersions).where(and(eq(answerVersions.workspaceId, id), eq(answerVersions.semanticKey, answer.semanticKey), eq(answerVersions.jurisdiction, answer.jurisdiction), eq(answerVersions.questionScope, answer.questionScope))).orderBy(desc(answerVersions.revision)).limit(1);
    if (latest[0]?.id !== answer.id) return 'ANSWER_REVISION_STALE' as const;
    return (await tx.update(answerVersions).set({ approvalStatus: 'USER_APPROVED' }).where(and(eq(answerVersions.id, answerId), eq(answerVersions.workspaceId, id))).returning())[0]!;
  });
  if (result === 'NOT_FOUND') return fail(reply, 404, 'NOT_FOUND');
  if (result === 'ANSWER_REVISION_STALE') return fail(reply, 409, 'ANSWER_REVISION_STALE', 'A newer version of this answer exists; approve the latest one.');
  return result;
});

app.get('/api/v1/boards', async (request) => db.select().from(boards).where(eq(boards.workspaceId, workspace(request))).orderBy(desc(boards.createdAt)));
app.post('/api/v1/boards', async (request, reply) => {
  const parsed = parseBody(boardSchema, request.body, reply); if (!parsed) return;
  if (parsed.permissionStatus !== 'UNKNOWN' || parsed.associationStatus !== 'UNVERIFIED' || parsed.enabled) return fail(reply, 400, 'BOARD_REQUIRES_REVIEW_FIRST');
  const created = await db.insert(boards).values({ workspaceId: workspace(request), provider: parsed.provider, tenant: parsed.tenant, region: parsed.region, companyName: parsed.companyName, companyDomain: parsed.companyDomain.toLowerCase(), careersUrl: parsed.careersUrl, associationStatus: 'UNVERIFIED', permissionStatus: 'UNKNOWN', enabled: false }).returning();
  return reply.code(201).send(created[0]);
});
app.post('/api/v1/boards/:id/review', async (request, reply) => {
  const body = request.body as { officialAssociationConfirmed?: unknown; publicReadReviewed?: unknown; referenceUrl?: unknown; notes?: unknown } | null;
  if (body?.officialAssociationConfirmed !== true || body.publicReadReviewed !== true || typeof body.referenceUrl !== 'string' || typeof body.notes !== 'string') return fail(reply, 400, 'REVIEW_ACKNOWLEDGEMENT_REQUIRED');
  let ref: URL; try { ref = new URL(body.referenceUrl); } catch { return fail(reply, 400, 'REFERENCE_URL_INVALID'); }
  if (ref.protocol !== 'https:') return fail(reply, 400, 'REFERENCE_URL_INVALID');
  const { id: boardId } = request.params as { id: string }; const id = workspace(request);
  const board = (await db.select().from(boards).where(and(eq(boards.id, boardId), eq(boards.workspaceId, id))).limit(1))[0]; if (!board) return fail(reply, 404, 'NOT_FOUND');
  const reviewedAt = new Date(); const due = new Date(reviewedAt.getTime() + 90 * 86_400_000);
  await db.insert(sourcePolicyReviews).values({ workspaceId: id, boardId, capability: 'PUBLIC_JOB_READ', accessClass: 'DOCUMENTED_PUBLIC_READ', permissionStatus: 'APPROVED_FOR_SCOPE', apiHost: board.provider === 'greenhouse' ? 'boards-api.greenhouse.io' : board.provider === 'lever' ? (board.region.toLowerCase() === 'eu' ? 'api.eu.lever.co' : 'api.lever.co') : 'api.ashbyhq.com', referenceUrl: body.referenceUrl, notes: body.notes, adapterVersion: '0.2.0', fixtureCoverage: 0, reviewedAt, reviewDueAt: due });
  const updated = await db.update(boards).set({ associationStatus: 'VERIFIED', permissionStatus: 'APPROVED_FOR_SCOPE', enabled: true, reviewedAt, reviewDueAt: due, updatedAt: reviewedAt }).where(eq(boards.id, boardId)).returning();
  return updated[0];
});
app.post('/api/v1/boards/:id/disable', async (request, reply) => {
  const { id: boardId } = request.params as { id: string };
  const updated = await db.update(boards).set({ enabled: false, updatedAt: new Date() }).where(and(eq(boards.id, boardId), eq(boards.workspaceId, workspace(request)))).returning();
  return updated[0] ? updated[0] : fail(reply, 404, 'NOT_FOUND');
});

app.post('/api/v1/boards/:id/refresh', async (request, reply) => {
  const id = workspace(request); const { id: boardId } = request.params as { id: string };
  const board = (await db.select().from(boards).where(and(eq(boards.id, boardId), eq(boards.workspaceId, id))).limit(1))[0];
  if (!board) return fail(reply, 404, 'NOT_FOUND');
  if (!board.enabled || board.permissionStatus !== 'APPROVED_FOR_SCOPE' || board.associationStatus !== 'VERIFIED' || (board.reviewDueAt && board.reviewDueAt < new Date())) return fail(reply, 403, 'BOARD_NOT_APPROVED_FOR_DISCOVERY');
  const lastRun = board.lastSuccessfulRefreshAt; if (lastRun && Date.now() - lastRun.getTime() < 6 * 60 * 60 * 1000) return fail(reply, 429, 'BOARD_REFRESH_COOLDOWN', 'Wait at least six hours between refreshes.');
  const refreshLock = await pool.connect();
  const lock = await refreshLock.query<{ acquired: boolean }>('select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired', [boardId]);
  if (!lock.rows[0]?.acquired) { refreshLock.release(); return fail(reply, 409, 'BOARD_REFRESH_ALREADY_RUNNING'); }
  try {
    const sourceReport = await readBoardWithReport({ provider: board.provider, tenant: board.tenant, region: board.region });
    const discovered = sourceReport.jobs;
    const result = await db.transaction(async (tx) => {
      // Context and existing identities are loaded once per refresh instead of once per discovered job.
      const context = await loadMatchingContext(tx, id);
      const existingByExternalId = await occurrencesForBoard(tx, id, board);
      const candidates = await tx.select().from(jobs).where(and(eq(jobs.workspaceId, id), sql`lower(${jobs.company}) = lower(${board.companyName})`));
      const candidateByKey = new Map(candidates.map((job) => [`${job.title}\n${job.canonicalUrl}`, job]));
      const knownJobIds = [...new Set([...existingByExternalId.values()].map((occurrence) => occurrence.jobId))];
      const latestHashes = knownJobIds.length ? await tx.selectDistinctOn([jobSnapshots.jobId], { jobId: jobSnapshots.jobId, snapshotHash: jobSnapshots.snapshotHash }).from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, id), inArray(jobSnapshots.jobId, knownJobIds))).orderBy(jobSnapshots.jobId, desc(jobSnapshots.fetchedAt)) : [];
      const hashByJob = new Map(latestHashes.map((row) => [row.jobId, row.snapshotHash]));
      const now = new Date();
      let added = 0; let updated = 0;
      for (const item of discovered) {
        if (!item.externalId || !item.title || !item.jobUrl) continue;
        const existing = existingByExternalId.get(item.externalId);
        let jobId = existing?.jobId ?? candidateByKey.get(`${item.title}\n${item.jobUrl}`)?.id;
        const snapshotHash = createHash('sha256').update(`${item.title}\n${item.description ?? ''}`).digest('hex');
        const scored = applyMatch({ id: jobId ?? '', workspaceId: id, company: board.companyName, title: item.title, location: item.location, canonicalUrl: item.jobUrl, availability: 'OPEN', shortlistDecision: 'UNREVIEWED', fitScore: null, evidenceCoverage: null, eligibility: 'NEEDS_REVIEW', reasons: [], createdAt: now, updatedAt: now }, item.description, context);
        const scores = { fitScore: scored.fitScore, evidenceCoverage: scored.evidenceCoverage, eligibility: scored.eligibility, reasons: scored.reasons };
        if (!jobId) {
          jobId = (await tx.insert(jobs).values({ workspaceId: id, company: board.companyName, title: item.title, location: item.location, canonicalUrl: item.jobUrl, availability: 'OPEN', ...scores }).returning({ id: jobs.id }))[0]!.id; added++;
        } else {
          await tx.update(jobs).set({ title: item.title, location: item.location, availability: 'OPEN', ...scores, updatedAt: now }).where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, id))); updated++;
        }
        let occurrenceId = existing?.id;
        if (existing) {
          await tx.update(jobOccurrences).set({ lastSeenAt: now, sourceUpdatedAt: item.updatedAt ? new Date(item.updatedAt) : null, lastSuccessfulRefreshAt: now, sourcePayload: item.raw, jobUrl: item.jobUrl, applyUrl: item.applyUrl }).where(eq(jobOccurrences.id, existing.id));
        } else {
          occurrenceId = (await tx.insert(jobOccurrences).values({ workspaceId: id, jobId, provider: board.provider, region: board.region, tenant: board.tenant, externalJobId: item.externalId, jobUrl: item.jobUrl, applyUrl: item.applyUrl, sourcePostedAt: item.postedAt ? new Date(item.postedAt) : null, sourceUpdatedAt: item.updatedAt ? new Date(item.updatedAt) : null, lastSuccessfulRefreshAt: now, sourcePayload: item.raw }).returning({ id: jobOccurrences.id }))[0]!.id;
        }
        // Store a new snapshot only when the posting text changed, so documents keep pointing at what was actually read.
        if (hashByJob.get(jobId) !== snapshotHash) {
          await tx.insert(jobSnapshots).values({ workspaceId: id, jobId, occurrenceId: occurrenceId ?? null, title: item.title, descriptionText: item.description, snapshotHash });
          hashByJob.set(jobId, snapshotHash);
        }
      }
      await tx.update(boards).set({ lastSuccessfulRefreshAt: now, updatedAt: now }).where(and(eq(boards.id, boardId), eq(boards.workspaceId, id)));
      return { added, updated, total: added + updated, coverage: sourceReport.skipped ? 'PARTIAL' : 'COMPLETE', skipped: sourceReport.skipped, fetchedAt: now.toISOString() };
    });
    return result;
  } catch (error) { app.log.error({ err: error, boardId }, 'Board refresh failed'); return fail(reply, 502, 'BOARD_REFRESH_FAILED', error instanceof Error ? error.message : 'Unknown source error'); }
  finally { await refreshLock.query('select pg_advisory_unlock(hashtextextended($1, 0))', [boardId]); refreshLock.release(); }
});

app.get('/api/v1/jobs', async (request) => {
  const query = request.query as { q?: string; availability?: string; scope?: string; page?: string; paged?: string };
  const id = workspace(request); const filters = [eq(jobs.workspaceId, id)];
  if (query.q) { const pattern = `%${query.q.slice(0, 80).replace(/[\\%_]/g, (char) => `\\${char}`)}%`; filters.push(or(ilike(jobs.title, pattern), ilike(jobs.company, pattern))!); }
  if (query.scope === 'favorites') filters.push(eq(jobs.shortlistDecision, 'SHORTLISTED'));
  else if (query.scope === 'archived') filters.push(eq(jobs.shortlistDecision, 'ARCHIVED'));
  else if (query.scope === 'active') filters.push(ne(jobs.shortlistDecision, 'ARCHIVED'));
  if (['OPEN', 'POSSIBLY_CLOSED', 'CLOSED', 'UNKNOWN'].includes(query.availability ?? '')) filters.push(eq(jobs.availability, query.availability as 'OPEN' | 'POSSIBLY_CLOSED' | 'CLOSED' | 'UNKNOWN'));
  const paged = query.paged === 'true'; const page = Math.max(1, Math.min(100000, Number.parseInt(query.page ?? '1', 10) || 1));
  const [rows, count] = await Promise.all([
    db.select().from(jobs).where(and(...filters)).orderBy(desc(jobs.updatedAt), desc(jobs.id)).limit(paged ? 24 : 200).offset(paged ? (page - 1) * 24 : 0),
    paged ? db.select({ total: sql<number>`count(*)::int` }).from(jobs).where(and(...filters)) : Promise.resolve([]),
  ]);
  const items = await scoreJobs(db, id, rows);
  return paged ? { items, total: count[0]?.total ?? 0, page, pageSize: 24 } : items;
});
app.get('/api/v1/jobs/:id', async (request, reply) => {
  const { id: jobId } = request.params as { id: string }; const id = workspace(request);
  const job = (await db.select().from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, id))).limit(1))[0];
  if (!job) return fail(reply, 404, 'NOT_FOUND');
  const [snapshots, occurrences, applicationsForJob] = await Promise.all([
    db.select().from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, id), eq(jobSnapshots.jobId, jobId))).orderBy(desc(jobSnapshots.fetchedAt)),
    db.select().from(jobOccurrences).where(and(eq(jobOccurrences.workspaceId, id), eq(jobOccurrences.jobId, jobId))),
    db.select().from(applications).where(and(eq(applications.workspaceId, id), eq(applications.jobId, jobId))).orderBy(desc(applications.updatedAt)),
  ]);
  const [scored] = await scoreJobs(db, id, [job]);
  return { job: scored ?? job, snapshots, sources: occurrences.map((occurrence) => omit(occurrence, 'sourcePayload')), applications: applicationsForJob };
});
app.post('/api/v1/jobs/import', async (request, reply) => {
  const parsed = parseBody(jobImportSchema, request.body, reply); if (!parsed) return;
  if (/linkedin\.com$/i.test(new URL(parsed.jobUrl).hostname) || new URL(parsed.jobUrl).hostname.toLowerCase().endsWith('.linkedin.com')) return fail(reply, 400, 'LINKEDIN_URL_MANUAL_ONLY', 'Add the description or the employer career URL; no request was made.');
  let jobUrl: string; try { jobUrl = normalizeJobUrl(parsed.jobUrl); } catch { return fail(reply, 400, 'JOB_URL_INVALID'); }
  const id = workspace(request);
  const now = new Date();
  const scored = applyMatch({ id: '', workspaceId: id, company: parsed.company, title: parsed.title, location: parsed.location, canonicalUrl: jobUrl, availability: 'UNKNOWN', shortlistDecision: 'UNREVIEWED', fitScore: null, evidenceCoverage: null, eligibility: 'NEEDS_REVIEW', reasons: ['MANUAL_IMPORT_REVIEW_REQUIRED'], createdAt: now, updatedAt: now }, parsed.description, await loadMatchingContext(db, id));
  const created = await db.transaction(async (tx) => {
    await lockKey(tx, `job-url:${id}:${jobUrl}`);
    const duplicate = (await tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.workspaceId, id), eq(jobs.canonicalUrl, jobUrl))).limit(1))[0];
    if (duplicate) return { duplicateId: duplicate.id };
    const job = (await tx.insert(jobs).values({ workspaceId: id, company: parsed.company, title: parsed.title, location: parsed.location, canonicalUrl: jobUrl, availability: 'UNKNOWN', fitScore: scored.fitScore, evidenceCoverage: scored.evidenceCoverage, eligibility: scored.eligibility, reasons: scored.reasons }).returning())[0]!;
    await tx.insert(jobSnapshots).values({ workspaceId: id, jobId: job.id, title: parsed.title, descriptionText: parsed.description, snapshotHash: createHash('sha256').update(`${parsed.title}\n${parsed.description ?? ''}`).digest('hex') });
    return { ...job, provisional: scored.provisional, match: scored.match };
  });
  if ('duplicateId' in created) return fail(reply, 409, 'JOB_ALREADY_EXISTS', created.duplicateId);
  return reply.code(201).send(created);
});
app.post('/api/v1/jobs/:id/shortlist', async (request, reply) => {
  const body = request.body as { decision?: unknown } | null;
  if (!['SHORTLISTED', 'SKIPPED', 'ARCHIVED', 'UNREVIEWED'].includes(String(body?.decision))) return fail(reply, 400, 'INVALID_SHORTLIST_DECISION');
  const { id: jobId } = request.params as { id: string };
  const updated = await db.update(jobs).set({ shortlistDecision: body!.decision as 'SHORTLISTED' | 'SKIPPED' | 'ARCHIVED' | 'UNREVIEWED', updatedAt: new Date() }).where(and(eq(jobs.id, jobId), eq(jobs.workspaceId, workspace(request)))).returning();
  return updated[0] ? updated[0] : fail(reply, 404, 'NOT_FOUND');
});

registerResumeJourney(app, workspace);
registerBackupRoutes(app, workspace, { root: projectRoot, data: config.DATA_LOCAL_PATH, files: config.FILES_LOCAL_PATH, database: config.DATABASE_URL, key: config.APP_ENCRYPTION_KEY });

app.get('/api/v1/applications', async (request) => db.select().from(applications).where(eq(applications.workspaceId, workspace(request))).orderBy(desc(applications.updatedAt)).limit(500));
app.post('/api/v1/applications', async (request, reply) => {
  const parsed = parseBody(applicationSchema, request.body, reply); if (!parsed) return;
  if (parsed.state !== 'DRAFT' && (parsed.state !== 'CONFIRMED' || parsed.confirmationEvidence !== 'USER_ATTESTATION')) return fail(reply, 400, 'APPLICATION_CREATION_STATE_UNSUPPORTED');
  const id = workspace(request);
  if (parsed.jobId) {
    const job = (await db.select().from(jobs).where(and(eq(jobs.id, parsed.jobId), eq(jobs.workspaceId, id))).limit(1))[0]; if (!job) return fail(reply, 404, 'JOB_NOT_FOUND');
  }
  const result = await db.transaction(async (tx) => {
    let applicationCycle = 1;
    if (parsed.jobId) {
      // One open application per job: repeated creates (double clicks, retries) return the open cycle; a new cycle starts only after the previous one closed.
      await lockKey(tx, `application:${id}:${parsed.jobId}`);
      const latest = (await tx.select().from(applications).where(and(eq(applications.workspaceId, id), eq(applications.jobId, parsed.jobId))).orderBy(desc(applications.applicationCycle)).limit(1))[0];
      if (latest && !isClosedApplication(latest)) return { application: latest, created: false };
      applicationCycle = (latest?.applicationCycle ?? 0) + 1;
    }
    const application = (await tx.insert(applications).values({ workspaceId: id, jobId: parsed.jobId, applicationCycle, company: parsed.company, role: parsed.role, location: parsed.location, canonicalUrl: parsed.canonicalUrl, state: parsed.state, recruitmentStage: parsed.recruitmentStage, shortlistDecision: parsed.shortlistDecision, notes: parsed.notes }).returning())[0]!;
    await tx.insert(applicationEvents).values({ workspaceId: id, applicationId: application.id, eventType: parsed.state === 'CONFIRMED' ? 'MANUAL_APPLICATION_RECORDED' : 'APPLICATION_CREATED', reason: 'Manual user record', priorState: null, newState: parsed.state, evidence: { ...(parsed.state === 'CONFIRMED' ? { type: 'USER_ATTESTATION' } : {}), applicationCycle }, aggregateVersion: application.version });
    return { application, created: true };
  });
  return reply.code(result.created ? 201 : 200).send(result.application);
});
app.get('/api/v1/applications/:id', async (request, reply) => {
  const id = workspace(request); const { id: applicationId } = request.params as { id: string };
  const row = (await db.select().from(applications).where(and(eq(applications.workspaceId, id), eq(applications.id, applicationId))).limit(1))[0];
  return row ?? fail(reply, 404, 'NOT_FOUND');
});
app.get('/api/v1/applications/:id/events', async (request, reply) => {
  const { id: applicationId } = request.params as { id: string }; const id = workspace(request);
  const application = (await db.select().from(applications).where(and(eq(applications.id, applicationId), eq(applications.workspaceId, id))).limit(1))[0]; if (!application) return fail(reply, 404, 'NOT_FOUND');
  return db.select().from(applicationEvents).where(and(eq(applicationEvents.applicationId, applicationId), eq(applicationEvents.workspaceId, id))).orderBy(desc(applicationEvents.createdAt));
});
app.patch('/api/v1/applications/:id', async (request, reply) => {
  const parsed = parseBody(applicationUpdateSchema, request.body, reply); if (!parsed) return;
  if (parsed.state && ['READY', 'IN_PROGRESS', 'UNKNOWN'].includes(parsed.state)) return fail(reply, 409, 'CAPABILITY_NOT_AVAILABLE', 'Use the assisted application workflow for browser progress and reconciliation.');
  const { id: applicationId } = request.params as { id: string }; const id = workspace(request);
  const updated = await db.transaction(async (tx) => {
    const current = (await tx.select().from(applications).where(and(eq(applications.id, applicationId), eq(applications.workspaceId, id))).limit(1).for('update'))[0];
    if (!current) return null;
    const activeAssist = await tx.select({ id: assistedAttempts.id }).from(assistedAttempts).where(and(eq(assistedAttempts.workspaceId, id), eq(assistedAttempts.applicationId, applicationId), inArray(assistedAttempts.status, ['PREPARED', 'STARTING', 'REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF', 'UNKNOWN']))).limit(1);
    if (activeAssist.length && (parsed.state || parsed.recruitmentStage)) throw new Error('ASSIST_ACTIVE_ATTEMPT');
    if (parsed.state && parsed.state !== current.state && !canTransitionApplication(current.state, parsed.state, parsed.confirmationEvidence)) throw new Error('INVALID_STATE_TRANSITION');
    if (parsed.state === 'CONFIRMED' && current.state !== 'CONFIRMED' && (request.body as { confirmationEvidence?: unknown } | null)?.confirmationEvidence !== 'USER_ATTESTATION') throw new Error('CONFIRMATION_EVIDENCE_REQUIRED');
    if (parsed.expectedVersion !== undefined && parsed.expectedVersion !== current.version) throw new Error('STALE_APPLICATION_VERSION');
    const stageChange = parsed.recruitmentStage ? classifyRecruitmentStageChange(current.recruitmentStage, parsed.recruitmentStage, parsed.correction === true) : 'UNCHANGED';
    if (stageChange === 'REJECTED_REGRESSION') throw new Error('RECRUITMENT_STAGE_CANNOT_REGRESS');
    const nextState = parsed.state ?? current.state;
    const changes = omit(parsed, 'confirmationEvidence', 'correction', 'reason', 'expectedVersion');
    const row = (await tx.update(applications).set({ ...changes, updatedAt: new Date(), version: current.version + 1 }).where(and(eq(applications.id, applicationId), eq(applications.workspaceId, id), eq(applications.version, current.version))).returning())[0];
    if (!row) throw new Error('STALE_APPLICATION_VERSION');
    if (parsed.state && parsed.state !== current.state) await tx.insert(applicationEvents).values({ workspaceId: id, applicationId, eventType: 'APPLICATION_STATE_CHANGED', reason: parsed.reason ?? (parsed.state === 'CONFIRMED' ? 'User-attested confirmation' : null), priorState: current.state, newState: nextState, evidence: parsed.state === 'CONFIRMED' ? { type: 'USER_ATTESTATION' } : null, aggregateVersion: row.version });
    if (parsed.recruitmentStage && stageChange !== 'UNCHANGED') await tx.insert(applicationEvents).values({ workspaceId: id, applicationId, eventType: stageChange === 'CORRECTION' ? 'RECRUITMENT_STAGE_CORRECTED' : 'RECRUITMENT_STAGE_CHANGED', reason: parsed.reason ?? (stageChange === 'CORRECTION' ? 'User correction' : null), priorState: current.recruitmentStage, newState: parsed.recruitmentStage, evidence: stageChange === 'CORRECTION' ? { correction: true, priorStage: current.recruitmentStage, newStage: parsed.recruitmentStage } : null, aggregateVersion: row.version });
    return row;
  }).catch((error: unknown) => { if (error instanceof Error) return error.message; throw error; });
  if (updated === 'ASSIST_ACTIVE_ATTEMPT') return fail(reply, 409, updated);
  if (updated === 'INVALID_STATE_TRANSITION' || updated === 'CONFIRMATION_EVIDENCE_REQUIRED' || updated === 'RECRUITMENT_STAGE_CANNOT_REGRESS' || updated === 'STALE_APPLICATION_VERSION') return fail(reply, 409, updated);
  if (!updated) return fail(reply, 404, 'NOT_FOUND');
  return updated;
});

app.post('/api/v1/applications/:id/events', async (request, reply) => {
  const body = request.body as { eventType?: unknown; note?: unknown; recruitmentStage?: unknown } | null;
  if (typeof body?.eventType !== 'string' || body.eventType.length > 80 || body.eventType.startsWith('ASSIST_') || typeof body.note !== 'string' || body.note.length > 10_000) return fail(reply, 400, 'INVALID_EVENT');
  const { id: applicationId } = request.params as { id: string }; const id = workspace(request);
  const application = (await db.select().from(applications).where(and(eq(applications.id, applicationId), eq(applications.workspaceId, id))).limit(1))[0]; if (!application) return fail(reply, 404, 'NOT_FOUND');
  const event = (await db.insert(applicationEvents).values({ workspaceId: id, applicationId, eventType: body.eventType, reason: body.note, aggregateVersion: application.version }).returning())[0]; return reply.code(201).send(event);
});

const documentView = <T extends { id: string; name: string; revision: number; approvalStatus: string }>(row: T) => ({ ...row, reviewRequired: row.approvalStatus === 'PENDING_REVIEW', fileName: documentFileName(row.name, row.revision), downloadUrl: `/api/v1/documents/${row.id}/file` });
app.get('/api/v1/documents', async (request) => {
  const id = workspace(request);
  const documents = await db.select().from(documentVersions).where(eq(documentVersions.workspaceId, id)).orderBy(desc(documentVersions.createdAt));
  return (await documentReadiness(db, id, documents)).map(documentView);
});
app.post('/api/v1/documents', async (request, reply) => {
  const body = request.body as { name?: unknown; factIds?: unknown; jobId?: unknown; locale?: unknown } | null;
  if (typeof body?.name !== 'string' || !body.name.trim() || body.name.length > 200 || !Array.isArray(body.factIds) || body.factIds.length < 1 || body.factIds.length > 50 || !body.factIds.every((value) => typeof value === 'string')) return fail(reply, 400, 'INVALID_DOCUMENT_REQUEST');
  const factIds = [...new Set(body.factIds as string[])]; if (factIds.length !== body.factIds.length) return fail(reply, 400, 'DUPLICATE_FACT_ID');
  const id = workspace(request);
  const profile = await latestProfile(db, id); if (!profile) return fail(reply, 409, 'PROFILE_NOT_CONFIGURED');
  const facts = await db.select().from(profileFacts).where(and(eq(profileFacts.workspaceId, id), eq(profileFacts.profileVersionId, profile.id), eq(profileFacts.approvalStatus, 'USER_APPROVED')));
  const selected = facts.filter((fact) => factIds.includes(fact.id));
  if (selected.length !== factIds.length) return fail(reply, 400, 'FACTS_MUST_BE_APPROVED_IN_CURRENT_PROFILE');
  const identity = printedResumeIdentity(profile.profile);
  let snapshotId: string | null = null; let role = '';
  if (body.jobId !== undefined && body.jobId !== null) {
    if (typeof body.jobId !== 'string') return fail(reply, 400, 'JOB_NOT_FOUND');
    const job = (await db.select().from(jobs).where(and(eq(jobs.id, body.jobId), eq(jobs.workspaceId, id))).limit(1))[0]; if (!job) return fail(reply, 404, 'JOB_NOT_FOUND');
    const snapshot = (await db.select().from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, id), eq(jobSnapshots.jobId, job.id))).orderBy(desc(jobSnapshots.fetchedAt)).limit(1))[0];
    snapshotId = snapshot?.id ?? null; role = job.title;
  }
  const name = body.name.trim();
  // The file name is independent of the revision so rendering can happen outside the revision lock; the revision is assigned atomically afterwards.
  const docId = randomUUID(); const relativePath = `${id}/${docId}.pdf`;
  const storageRoot = resolve(config.FILES_LOCAL_PATH); const filePath = resolve(storageRoot, relativePath);
  const computedRelativePath = relative(storageRoot, filePath);
  if (computedRelativePath.startsWith(`..${sep}`) || computedRelativePath === '..' || isAbsolute(computedRelativePath)) return fail(reply, 400, 'DOCUMENT_PATH_INVALID');
  const removeFile = () => unlink(filePath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') app.log.warn({ err: error, documentId: docId }, 'Could not remove orphaned document file'); });
  const pdfLocale = documentLanguage(body.locale, profile.locale);
  const renderedFacts = selected.map((fact) => ({ kind: fact.kind, statement: printedStatement(fact, pdfLocale), tags: fact.tags }));
  let rendered: { sha256: string; size: number };
  try { rendered = await renderResume({ path: filePath, fullName: identity.fullName, email: identity.email, role, locale: pdfLocale, facts: renderedFacts }); }
  catch (error) { await removeFile(); app.log.error({ err: error, workspaceId: id }, 'Document generation failed'); return fail(reply, 503, 'DOCUMENT_RENDER_FAILED', error instanceof Error ? error.message : 'Unknown renderer error'); }
  // Claims come from approved facts, but the generated document itself has not been reviewed yet.
  const claims = selected.map((fact, index) => ({ text: renderedFacts[index]!.statement, sourceFactIds: [fact.id], approvalStatus: 'PENDING_REVIEW' }));
  let row: typeof documentVersions.$inferSelect;
  try {
    row = await db.transaction(async (tx) => {
      await lockKey(tx, `document:${id}:${name}`);
      const latestRevision = await tx.select({ revision: sql<number>`coalesce(max(${documentVersions.revision}), 0)::int` }).from(documentVersions).where(and(eq(documentVersions.workspaceId, id), eq(documentVersions.name, name)));
      const revision = (latestRevision[0]?.revision ?? 0) + 1;
      return (await tx.insert(documentVersions).values({ id: docId, workspaceId: id, name, revision, language: pdfLocale, profileRevisionId: profile.id, jobSnapshotId: snapshotId, mediaType: 'application/pdf', storagePath: relativePath, sha256: rendered.sha256, claims, approvalStatus: 'PENDING_REVIEW' }).returning())[0]!;
    });
  } catch (error) { await removeFile(); throw error; }
  return reply.code(201).send({ ...documentView((await documentReadiness(db, id, [row]))[0]!), sizeBytes: rendered.size });
});
app.post('/api/v1/documents/:id/approve', async (request, reply) => {
  const body = request.body as { confirmReviewed?: unknown } | null; if (body?.confirmReviewed !== true) return fail(reply, 400, 'EXPLICIT_REVIEW_REQUIRED');
  const { id: documentId } = request.params as { id: string }; const id = workspace(request);
  // Same lock as profile saves and fact approval/rejection, so the source facts cannot change between this check and the approval.
  const result = await db.transaction(async (tx) => {
    await lockKey(tx, profileLockKey(id));
    const document = (await tx.select().from(documentVersions).where(and(eq(documentVersions.id, documentId), eq(documentVersions.workspaceId, id))).limit(1).for('update'))[0];
    if (!document) return 'NOT_FOUND' as const;
    if (document.approvalStatus !== 'PENDING_REVIEW') return 'DOCUMENT_ALREADY_REVIEWED' as const;
    // The PDF must still print exactly the current identity and approved facts; preference-only saves do not change it.
    if (!(await documentReadiness(tx, id, [document]))[0]?.reviewReady) return 'PROFILE_CHANGED_REGENERATE_DOCUMENT' as const;
    const reviewedClaims = document.claims.map((claim) => ({ ...claim, approvalStatus: 'USER_REVIEWED' }));
    return (await tx.update(documentVersions).set({ approvalStatus: 'USER_APPROVED', claims: reviewedClaims }).where(and(eq(documentVersions.id, documentId), eq(documentVersions.workspaceId, id), eq(documentVersions.approvalStatus, 'PENDING_REVIEW'))).returning())[0] ?? 'DOCUMENT_ALREADY_REVIEWED' as const;
  });
  if (result === 'NOT_FOUND') return fail(reply, 404, 'NOT_FOUND');
  if (result === 'DOCUMENT_ALREADY_REVIEWED' || result === 'PROFILE_CHANGED_REGENERATE_DOCUMENT') return fail(reply, 409, result);
  return documentView(result);
});
app.get('/api/v1/documents/:id/file', async (request, reply) => {
  const { id: documentId } = request.params as { id: string }; const id = workspace(request);
  const document = (await db.select().from(documentVersions).where(and(eq(documentVersions.id, documentId), eq(documentVersions.workspaceId, id))).limit(1))[0]; if (!document) return fail(reply, 404, 'NOT_FOUND');
  const root = resolve(config.FILES_LOCAL_PATH); const filePath = resolve(root, document.storagePath); const rel = relative(root, filePath);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return fail(reply, 500, 'DOCUMENT_PATH_INVALID');
  try {
    const content = await readFile(filePath);
    if (createHash('sha256').update(content).digest('hex') !== document.sha256) return fail(reply, 409, 'DOCUMENT_HASH_MISMATCH');
    return reply.header('Content-Type', 'application/pdf').header('Content-Length', content.byteLength).header('Content-Disposition', `attachment; filename="${documentFileName(document.name, document.revision)}"`).send(content);
  } catch { return fail(reply, 410, 'DOCUMENT_FILE_UNAVAILABLE'); }
});

app.get('/api/v1/search-profiles', async (request) => db.select().from(searchProfiles).where(eq(searchProfiles.workspaceId, workspace(request))).orderBy(desc(searchProfiles.createdAt)));
app.post('/api/v1/search-profiles', async (request, reply) => {
  const body = request.body as Record<string, unknown> | null;
  if (!body || typeof body.name !== 'string' || body.name.length > 160) return fail(reply, 400, 'INVALID_SEARCH_PROFILE');
  const created = await db.insert(searchProfiles).values({ workspaceId: workspace(request), name: body.name, targetTitles: Array.isArray(body.targetTitles) ? body.targetTitles.filter((v): v is string => typeof v === 'string').slice(0, 30) : [], countries: Array.isArray(body.countries) ? body.countries.filter((v): v is string => typeof v === 'string').slice(0, 30) : [], workModes: Array.isArray(body.workModes) ? body.workModes.filter((v): v is string => typeof v === 'string').slice(0, 10) : [], enabled: false }).returning(); return reply.code(201).send(created[0]);
});

function scrubExport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubExport);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/secret|token|cookie|credential|session|key$/i.test(key)).map(([key, item]) => [key, scrubExport(item)]));
  return value;
}
app.get('/api/v1/export', async (request, reply) => {
  const id = workspace(request);
  const [workspaceRow, profiles, facts, answers, boardRows, jobRows, occurrences, snapshots, applicationRows, events, documents, search, assistRows] = await Promise.all([
    db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1), db.select().from(profileVersions).where(eq(profileVersions.workspaceId, id)), db.select().from(profileFacts).where(eq(profileFacts.workspaceId, id)), db.select().from(answerVersions).where(eq(answerVersions.workspaceId, id)), db.select().from(boards).where(eq(boards.workspaceId, id)), db.select().from(jobs).where(eq(jobs.workspaceId, id)), db.select().from(jobOccurrences).where(eq(jobOccurrences.workspaceId, id)), db.select().from(jobSnapshots).where(eq(jobSnapshots.workspaceId, id)), db.select().from(applications).where(eq(applications.workspaceId, id)), db.select().from(applicationEvents).where(eq(applicationEvents.workspaceId, id)), db.select().from(documentVersions).where(eq(documentVersions.workspaceId, id)), db.select().from(searchProfiles).where(eq(searchProfiles.workspaceId, id)), db.select().from(assistedAttempts).where(eq(assistedAttempts.workspaceId, id)),
  ]);
  const artifacts: Array<{ documentId: string; sha256: string; contentBase64: string }> = [];
  let totalArtifactBytes = 0;
  for (const document of documents) {
    const root = resolve(config.FILES_LOCAL_PATH); const filePath = resolve(root, document.storagePath); const rel = relative(root, filePath);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return fail(reply, 500, 'DOCUMENT_PATH_INVALID');
    let content: Buffer; try { content = await readFile(filePath); } catch { return fail(reply, 409, 'DOCUMENT_FILE_UNAVAILABLE', document.id); }
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== document.sha256) return fail(reply, 409, 'DOCUMENT_HASH_MISMATCH', document.id);
    totalArtifactBytes += content.byteLength;
    if (totalArtifactBytes > 30_000_000) return fail(reply, 413, 'EXPORT_ARTIFACT_LIMIT', 'Export the PDF files separately, then create a new workspace export.');
    artifacts.push({ documentId: document.id, sha256: digest, contentBase64: content.toString('base64') });
  }
  const data = scrubExport({ workspace: workspaceRow[0], profiles, facts, answers, boards: boardRows.map((board) => ({ ...board, enabled: false, permissionStatus: 'UNKNOWN' })), jobs: jobRows, occurrences, snapshots, applications: applicationRows, events, documents, documentArtifacts: artifacts, searchProfiles: search, assistedAttempts: assistRows.map((attempt) => ({ ...attempt, status: attempt.status === 'PREPARED' ? 'INVALIDATED' : ['STARTING', 'REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF'].includes(attempt.status) ? 'UNKNOWN' : attempt.status })) });
  const contentHash = createHash('sha256').update(JSON.stringify(data)).digest('hex');
  return reply.header('Content-Type', 'application/json').header('Content-Disposition', `attachment; filename="career-workspace-${new Date().toISOString().slice(0, 10)}.json"`).send({ format: 'career-agent-stack-export', schemaVersion: 1, createdAt: new Date().toISOString(), warning: 'Contains personal data and generated PDFs. Store privately. Credentials, tokens, browser sessions and source permissions are excluded or disabled.', sha256: contentHash, data });
});

app.get('/api/v1/capabilities', async () => ({ release: RELEASE_VERSION, available: ['manual-profile', 'fact-approval', 'answer-bank', 'manual-job-import', 'approved-board-discovery', 'rule-based-matching', 'application-ledger', 'reviewed-pdf-drafts', 'json-export', 'local-backup-restore', 'browser-autofill'], unavailable: ['ai-processing', 'external-submission', 'email-oauth', 'interview-coach', 'hosted-multi-tenancy'], externalWrites: true, automaticSubmission: false }));

app.setErrorHandler((error, _request, reply) => {
  if ((error as { statusCode?: number }).statusCode === 429) return fail(reply, 429, 'RATE_LIMIT_EXCEEDED');
  app.log.error({ err: error }, 'Request failed');
  const errorMessage = error instanceof Error ? error.message : 'INTERNAL_ERROR';
  if (['INVALID_STATE_TRANSITION', 'CONFIRMATION_EVIDENCE_REQUIRED', 'RECRUITMENT_STAGE_CANNOT_REGRESS', 'STALE_APPLICATION_VERSION'].includes(errorMessage)) return fail(reply, 409, errorMessage);
  if ((error as { code?: string }).code === '23505') return fail(reply, 409, 'DUPLICATE_RECORD');
  return fail(reply, 500, 'INTERNAL_ERROR');
});

const assistedRuntime = await registerAssistedRoutes(app, workspace);
stopAssistedBrowsers = assistedRuntime.stopAll;

await app.listen({ host: config.API_HOST, port: config.API_PORT });
app.log.info({ host: config.API_HOST, port: config.API_PORT, externalWrites: true, setupTokenPath }, `Career Agent Stack API ${RELEASE_VERSION} started`);
for (const unavailable of ['automatic submission', 'email OAuth', 'interview coaching']) app.log.info({ capability: unavailable, status: 'UNAVAILABLE', release: RELEASE_VERSION });

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 15_000); deadline.unref();
    void app.close().then(() => pool.end()).then(() => {
      clearTimeout(deadline); process.exit(0);
    }).catch(() => { clearTimeout(deadline); process.exit(1); });
  });
}
