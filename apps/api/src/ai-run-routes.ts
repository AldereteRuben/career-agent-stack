import { randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { aiConnections, aiConsents, aiRuns, aiArtifacts, type db } from '@career/db';
import { AI_SCHEMA_VERSION, aiOperationSchema, aiOutputSchema, aiSourceSnapshotSchema, aiSnapshotDataCategories, canonicalAiReuseKey, checkAiConsent, type AiConsent, type AiSourceSnapshot } from '@career/domain';
import { createCurrentAiSnapshot, checkCurrentAiSnapshot } from './ai/source-reader.js';
import { AI_PROMPT_VERSION, buildAiPrompt } from './ai/prompts.js';
import { CODEX_DEFAULT_MODEL } from './ai/codex.js';
import { AI_QUEUE_LOCK, AiQueueError, type AiQueue } from './ai/queue.js';
import { AiSourceError } from './ai/source-snapshot.js';
import { lockKey, profileLockKey } from './workspace-data.js';

export const AI_CONFIG_VERSION = 'codex-0.160.0-v1';
export const AI_NOTICE_VERSION = 'career-sharing-v1';
type Preview = { id: string; workspaceId: string; connectionId: string; connectionRevision: number; accountFingerprint: string; maskedIdentity: string | null; snapshot: AiSourceSnapshot; at: number; runId?: string; consent?: typeof aiConsents.$inferSelect; idempotencyKey?: string; task?: Promise<unknown> };
const paramsSchema = z.object({ id: z.uuid() }).strict();
const createSchema = z.object({ previewId: z.uuid(), idempotencyKey: z.uuid(), rememberPermission: z.boolean().default(false) }).strict();
const reviewSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
const listSchema = z.object({ operation: aiOperationSchema, locale: z.enum(['es', 'en']), jobId: z.uuid().optional(), questionId: z.uuid().optional(), searchRequestHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();

export function aiVisibleSources(snapshot: AiSourceSnapshot) {
  return {
    ...(snapshot.searchRequest ? { searchRequest: snapshot.searchRequest.text } : {}),
    ...(snapshot.job ? { job: snapshot.job.normalizedText } : {}),
    facts: snapshot.facts.map(({ factId, kind, text }) => ({ factId, kind, text })),
    ...(snapshot.question ? { question: snapshot.question.text } : {}),
  };
}
export function storedAiConsent(row: typeof aiConsents.$inferSelect): AiConsent {
  return { consentId: row.id, workspaceId: row.workspaceId, connectionId: row.connectionId, provider: row.provider as AiConsent['provider'], accountFingerprint: row.accountFingerprint, connectionRevision: row.connectionRevision, revision: row.revision, operation: row.operation as AiConsent['operation'], dataCategories: row.dataCategories as AiConsent['dataCategories'], searchIds: row.searchIds, noticeVersion: row.noticeVersion, grantedAt: row.grantedAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null };
}

export function registerAiRunRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, options: {
  enabled: boolean; database: typeof db; queue: AiQueue; cancelRun?: (id: string) => void;
}) {
  const database = options.database;
  const previews = new Map<string, Preview>();
  const activeConnection = async (id: string) => (await database.select().from(aiConnections).where(and(eq(aiConnections.workspaceId, id), eq(aiConnections.provider, 'codex'), eq(aiConnections.active, true), eq(aiConnections.state, 'CONNECTED'))).limit(1))[0];
  const runView = async (workspaceId: string, id: string) => {
    const run = (await database.select().from(aiRuns).where(and(eq(aiRuns.workspaceId, workspaceId), eq(aiRuns.id, id))).limit(1))[0];
    if (!run) return null;
    const artifact = (await database.select({ id: aiArtifacts.id }).from(aiArtifacts).where(and(eq(aiArtifacts.workspaceId, workspaceId), eq(aiArtifacts.runId, id))).limit(1))[0];
    return { id: run.id, state: run.status, origin: run.origin, ...(run.error ? { error: run.error } : {}), ...(artifact ? { artifactId: artifact.id } : {}) };
  };
  const remembered = async (preview: Preview) => {
    const rows = await database.select().from(aiConsents).where(and(eq(aiConsents.workspaceId, preview.workspaceId), eq(aiConsents.connectionId, preview.connectionId), eq(aiConsents.operation, preview.snapshot.operation), eq(aiConsents.remembered, true), isNull(aiConsents.searchIds))).orderBy(desc(aiConsents.revision));
    return rows.find(row => checkAiConsent(storedAiConsent(row), { workspaceId: preview.workspaceId, connectionId: preview.connectionId, provider: 'codex', accountFingerprint: preview.accountFingerprint, connectionRevision: preview.connectionRevision, operation: preview.snapshot.operation, origin: 'MANUAL', dataCategories: aiSnapshotDataCategories(preview.snapshot) }).ok);
  };
  app.addHook('onRoute', route => {
    if (!route.url.startsWith('/api/v1/ai/runs') && !route.url.startsWith('/api/v1/ai/artifacts') && !route.url.startsWith('/api/v1/ai/consents')) return;
    if (route.errorHandler) return;
    route.errorHandler = (error, _request, reply) => {
      if (error.statusCode === 429) return reply.code(429).send({ error: 'RATE_LIMIT_EXCEEDED' });
      if (error.statusCode === 400 || error.statusCode === 413) return reply.code(error.statusCode).send({ error: 'INVALID_INPUT' });
      const code = error instanceof AiSourceError ? error.code : error instanceof AiQueueError ? `AI_${error.code}` : 'AI_UNAVAILABLE';
      return reply.code(error instanceof AiSourceError || error instanceof AiQueueError ? 409 : 503).send({ error: code });
    };
  });
  app.get('/api/v1/ai/consents', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const rows = await database.select().from(aiConsents).where(and(eq(aiConsents.workspaceId, workspace(request)), isNull(aiConsents.revokedAt))).orderBy(desc(aiConsents.grantedAt));
    return { consents: rows.filter(row => row.remembered || row.searchIds?.length).map(row => ({ id: row.id, operation: row.operation, dataCategories: row.dataCategories, searchIds: row.searchIds, remembered: row.remembered, grantedAt: row.grantedAt.toISOString() })) };
  });
  app.post('/api/v1/ai/consents/:id/revoke', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const id = workspace(request);
    const consent = (await database.select({ id: aiConsents.id }).from(aiConsents).where(and(eq(aiConsents.workspaceId, id), eq(aiConsents.id, parsed.data.id))).limit(1))[0];
    if (!consent) return reply.code(404).send({ error: 'AI_CONSENT_NOT_FOUND' });
    await options.queue.revokeConsent(id, parsed.data.id);
    const pending = await database.select({ id: aiRuns.id }).from(aiRuns).where(and(eq(aiRuns.workspaceId, id), eq(aiRuns.consentId, parsed.data.id), eq(aiRuns.status, 'CANCEL_REQUESTED')));
    pending.forEach(run => options.cancelRun?.(run.id));
    return { revoked: true };
  });
  app.post('/api/v1/ai/runs/preview', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!options.enabled) return reply.code(503).send({ error: 'AI_UNAVAILABLE' });
    const id = workspace(request);
    const connection = await activeConnection(id);
    if (!connection) return reply.code(409).send({ error: 'AI_NOT_CONNECTED' });
    const snapshot = await createCurrentAiSnapshot(database, id, request.body);
    buildAiPrompt(snapshot, { workspaceId: id, operation: snapshot.operation, locale: snapshot.locale });
    for (const [key, value] of previews) if (Date.now() - value.at >= 300_000 && !value.task) previews.delete(key);
    if ([...previews.values()].filter(value => value.workspaceId === id).length >= 20) return reply.code(429).send({ error: 'AI_TOO_MANY_PREVIEWS' });
    const preview: Preview = { id: randomUUID(), workspaceId: id, connectionId: connection.id, connectionRevision: connection.revision, accountFingerprint: connection.accountFingerprint, maskedIdentity: connection.maskedIdentity, snapshot, at: Date.now() };
    previews.set(preview.id, preview);
    return { previewId: preview.id, operation: snapshot.operation, locale: snapshot.locale, expiresAt: new Date(preview.at + 300_000).toISOString(), categories: aiSnapshotDataCategories(snapshot), sources: aiVisibleSources(snapshot), rememberedPermission: Boolean(await remembered(preview)), connection: { maskedIdentity: connection.maskedIdentity } };
  });
  app.post('/api/v1/ai/runs', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!options.enabled) return reply.code(503).send({ error: 'AI_UNAVAILABLE' });
    const body = createSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const id = workspace(request);
    const accepted = (run: unknown) => run ? reply.code(202).send(run) : reply.code(409).send({ error: 'AI_PREVIEW_EXPIRED' });
    const prior = (await database.select().from(aiRuns).where(and(eq(aiRuns.workspaceId, id), eq(aiRuns.idempotencyKey, body.data.idempotencyKey))).limit(1))[0];
    if (prior) {
      if (prior.origin !== 'MANUAL' || prior.inputVersions.previewId !== body.data.previewId) return reply.code(409).send({ error: 'AI_IDEMPOTENCY_CONFLICT' });
      return accepted(await runView(id, prior.id));
    }
    const preview = previews.get(body.data.previewId);
    if (!preview || preview.workspaceId !== id || Date.now() - preview.at >= 300_000) return reply.code(409).send({ error: 'AI_PREVIEW_EXPIRED' });
    if (preview.idempotencyKey && preview.idempotencyKey !== body.data.idempotencyKey) return reply.code(409).send({ error: 'AI_IDEMPOTENCY_CONFLICT' });
    if (preview.runId) {
      const run = await runView(id, preview.runId);
      if (run) return reply.code(202).send(run);
      // History removal also invalidates the in-memory preview. Replaying it must
      // never return a null run or silently authorize another provider task.
      previews.delete(preview.id);
      return reply.code(409).send({ error: 'AI_PREVIEW_EXPIRED' });
    }
    if (preview.task) return accepted(await preview.task);
    preview.idempotencyKey = body.data.idempotencyKey;
    const execute = async () => {
      const connection = await activeConnection(id);
      if (!connection || connection.id !== preview.connectionId || connection.revision !== preview.connectionRevision || connection.accountFingerprint !== preview.accountFingerprint) throw new AiQueueError('CONSENT_INVALID');
      const current = await database.transaction(async tx => { await lockKey(tx, profileLockKey(id)); return checkCurrentAiSnapshot(tx, id, preview.snapshot); });
      if (!current.ok) throw new AiSourceError('AI_SOURCE_CHANGED');
      let consent = preview.consent ?? await remembered(preview);
      if (!consent) consent = await database.transaction(async tx => {
        await lockKey(tx, AI_QUEUE_LOCK);
        const last = (await tx.select().from(aiConsents).where(and(eq(aiConsents.workspaceId, id), eq(aiConsents.connectionId, connection.id), eq(aiConsents.operation, preview.snapshot.operation))).orderBy(desc(aiConsents.revision)).limit(1))[0];
        return (await tx.insert(aiConsents).values({ workspaceId: id, connectionId: connection.id, provider: 'codex', accountFingerprint: connection.accountFingerprint, connectionRevision: connection.revision, revision: (last?.revision ?? 0) + 1, operation: preview.snapshot.operation, dataCategories: aiSnapshotDataCategories(preview.snapshot), searchIds: null, noticeVersion: AI_NOTICE_VERSION, remembered: body.data.rememberPermission }).returning())[0]!;
      });
      preview.consent = consent;
      const prompt = buildAiPrompt(preview.snapshot, { workspaceId: id, operation: preview.snapshot.operation, locale: preview.snapshot.locale });
      const contentIdentity = createHash('sha256').update(canonicalAiReuseKey({ workspaceId: id, operation: preview.snapshot.operation, connectionId: connection.id, accountFingerprint: connection.accountFingerprint, inputContentHash: prompt.inputContentHash, jobIdentity: preview.snapshot.job?.canonicalIdentity ?? null, jobContentHash: preview.snapshot.job?.contentHash ?? null, evidenceHashes: preview.snapshot.facts.map(fact => fact.contentHash), questionHash: preview.snapshot.question?.contentHash ?? null, locale: preview.snapshot.locale, schemaVersion: AI_SCHEMA_VERSION, promptVersion: AI_PROMPT_VERSION, configVersion: AI_CONFIG_VERSION })).digest('hex');
      const run = await options.queue.enqueue({ workspaceId: id, connectionId: connection.id, consentId: consent.id, connectionRevision: connection.revision, consentRevision: consent.revision, provider: 'codex', accountFingerprint: connection.accountFingerprint, operation: preview.snapshot.operation, origin: 'MANUAL', idempotencyKey: body.data.idempotencyKey, contentIdentity, accountLockKey: connection.accountFingerprint, snapshot: preview.snapshot, snapshotHash: preview.snapshot.snapshotHash, inputVersions: { previewId: preview.id, schemaVersion: AI_SCHEMA_VERSION, promptVersion: AI_PROMPT_VERSION, configVersion: AI_CONFIG_VERSION, model: CODEX_DEFAULT_MODEL, connectionRevision: connection.revision, consentRevision: consent.revision } });
      preview.runId = run.id;
      return runView(id, run.id);
    };
    preview.task = execute();
    try { return accepted(await preview.task); } finally { delete preview.task; }
  });
  app.get('/api/v1/ai/runs', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = listSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const query = parsed.data;
    const rows = await database.select({ run: aiRuns, artifactId: aiArtifacts.id }).from(aiRuns)
      .leftJoin(aiArtifacts, and(eq(aiArtifacts.workspaceId, aiRuns.workspaceId), eq(aiArtifacts.runId, aiRuns.id)))
      .where(and(eq(aiRuns.workspaceId, workspace(request)), eq(aiRuns.operation, query.operation),
        sql`${aiRuns.snapshot}->>'locale' = ${query.locale}`,
        query.jobId ? sql`${aiRuns.snapshot}->'job'->>'jobId' = ${query.jobId}` : sql`${aiRuns.snapshot}->>'job' IS NULL`,
        query.questionId ? sql`${aiRuns.snapshot}->'question'->>'questionId' = ${query.questionId}` : sql`${aiRuns.snapshot}->>'question' IS NULL`,
        query.searchRequestHash ? sql`${aiRuns.snapshot}->'searchRequest'->>'contentHash' = ${query.searchRequestHash}` : undefined))
      .orderBy(desc(aiRuns.reservedAt), desc(aiRuns.id)).limit(20);
    const recovered = [];
    for (const { run, artifactId } of rows) {
      const snapshot = aiSourceSnapshotSchema.safeParse(run.snapshot);
      if (!snapshot.success) continue;
      const current = snapshot.data.facts.length ? await checkCurrentAiSnapshot(database, workspace(request), snapshot.data) : null;
      recovered.push({ id: run.id, state: run.status, origin: run.origin, ...(run.error ? { error: run.error } : {}), ...(artifactId ? { artifactId } : {}), selectedFactIds: current?.ok ? current.resolvedFacts.map(fact => fact.currentFactId) : snapshot.data.facts.map(fact => fact.factId) });
    }
    return { runs: recovered };
  });
  app.get('/api/v1/ai/runs/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const result = await runView(workspace(request), params.data.id);
    return result ?? reply.code(404).send({ error: 'AI_RUN_NOT_FOUND' });
  });
  app.post('/api/v1/ai/runs/:id/cancel', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const id = workspace(request);
    if (!(await runView(id, params.data.id))) return reply.code(404).send({ error: 'AI_RUN_NOT_FOUND' });
    await options.queue.cancel(id, params.data.id); options.cancelRun?.(params.data.id);
    return runView(id, params.data.id);
  });
  app.get('/api/v1/ai/artifacts/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const id = workspace(request);
    let artifact = (await database.select().from(aiArtifacts).where(and(eq(aiArtifacts.workspaceId, id), eq(aiArtifacts.id, params.data.id))).limit(1))[0];
    if (!artifact) return reply.code(404).send({ error: 'AI_ARTIFACT_NOT_FOUND' });
    const run = (await database.select().from(aiRuns).where(and(eq(aiRuns.workspaceId, id), eq(aiRuns.id, artifact.runId))).limit(1))[0];
    if (!run || run.status !== 'SUCCEEDED') return reply.code(409).send({ error: 'AI_ARTIFACT_NOT_AVAILABLE' });
    const parsedSnapshot = aiSourceSnapshotSchema.safeParse(run.snapshot);
    if (!parsedSnapshot.success) return reply.code(409).send({ error: 'AI_ARTIFACT_NOT_AVAILABLE' });
    const snapshot = parsedSnapshot.data;
    const current = await database.transaction(async tx => { await lockKey(tx, profileLockKey(id)); return checkCurrentAiSnapshot(tx, id, snapshot); });
    if (!current.ok && artifact.state === 'PENDING_REVIEW') {
      await database.update(aiArtifacts).set({ state: 'STALE', revision: sql`${aiArtifacts.revision} + 1` }).where(and(eq(aiArtifacts.workspaceId, id), eq(aiArtifacts.id, artifact.id), eq(aiArtifacts.revision, artifact.revision)));
      const latest = (await database.select().from(aiArtifacts).where(and(eq(aiArtifacts.workspaceId, id), eq(aiArtifacts.id, artifact.id))).limit(1))[0];
      if (!latest) return reply.code(404).send({ error: 'AI_ARTIFACT_NOT_FOUND' });
      artifact = latest;
    }
    const output = aiOutputSchema.safeParse(artifact.output);
    if (!output.success) return reply.code(409).send({ error: 'AI_ARTIFACT_NOT_AVAILABLE' });
    return { id: artifact.id, revision: artifact.revision, state: artifact.state, operation: output.data.operation, output: output.data, sources: aiVisibleSources(snapshot) };
  });
  app.post('/api/v1/ai/artifacts/:id/dismiss', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = paramsSchema.safeParse(request.params); const body = reviewSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const rows = await database.update(aiArtifacts).set({ state: 'DISMISSED', dismissedAt: new Date(), revision: sql`${aiArtifacts.revision} + 1` }).where(and(eq(aiArtifacts.workspaceId, workspace(request)), eq(aiArtifacts.id, params.data.id), eq(aiArtifacts.revision, body.data.expectedRevision), inArray(aiArtifacts.state, ['PENDING_REVIEW', 'STALE']))).returning({ id: aiArtifacts.id, revision: aiArtifacts.revision, state: aiArtifacts.state });
    return rows[0] ?? reply.code(409).send({ error: 'AI_REVIEW_CHANGED' });
  });
  app.addHook('onClose', async () => { await Promise.allSettled([...previews.values()].flatMap(preview => preview.task ? [preview.task] : [])); previews.clear(); });
}
