import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  aiConnections, aiRuns, db, documentVersions, interviewPreparationEvidence, interviewPreparationFeedbackProposals,
  interviewPreparationPlans, interviewPreparationSessions, interviewPreparationTurns, profileFacts, profileVersions,
  jobSnapshots,
} from '@career/db';
import {
  AI_SCHEMA_VERSION, aiSnapshotDataCategories, aiSourceSnapshotSchema, interviewEvidenceStatus,
  interviewMockFeedbackOutputSchema, validateAiOutput, type AiSourceSnapshot, type InterviewEvidenceKind,
} from '@career/domain';
import { AI_NOTICE_VERSION } from './ai-run-routes.js';
import { buildAiPrompt, hashAiInputContent, hashAiPromptMessages, AI_PROMPT_VERSION } from './ai/prompts.js';
import { CODEX_DEFAULT_MODEL, CodexExecutionError, executeCodex, type CodexDependencies, type CodexExecutionResult } from './ai/codex.js';
import { AiQueueError, type AiQueue, type AiRunUsage } from './ai/queue.js';
import type { AiDocumentRewordCancellation } from './ai-application-document-routes.js';
import { currentEvidence, interviewPreparationPlanLockKey, turnView } from './interview-preparation-routes.js';
import { lockKey, profileLockKey } from './workspace-data.js';

class MockFeedbackError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); this.name = 'MockFeedbackError'; }
}
type Options = {
  enabled: boolean; database: typeof db; identitySalt: string; queue: AiQueue; cancellation: AiDocumentRewordCancellation;
  execute?: typeof executeCodex; now?: () => Date;
};
const uuid = z.uuid();
const selection = z.object({ factIds: z.array(uuid).max(20).refine((ids) => new Set(ids).size === ids.length) }).strict();
const runBody = selection.extend({ payloadSha256: z.string().regex(/^[a-f0-9]{64}$/u), confirmed: z.boolean(), origin: z.enum(['MANUAL', 'AUTOMATIC']).default('MANUAL') }).strict();
const acceptBody = z.object({ runId: uuid, payloadSha256: z.string().regex(/^[a-f0-9]{64}$/u), feedback: interviewMockFeedbackOutputSchema }).strict();
const discardBody = z.object({ runId: uuid }).strict();
type Executor = Pick<typeof db, 'select'>;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const stableJson = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
});

async function loadFeedbackInput(executor: Executor, workspaceId: string, sessionId: string, turnId: string, factIds: string[]) {
  const session = (await executor.select().from(interviewPreparationSessions).where(and(eq(interviewPreparationSessions.workspaceId, workspaceId), eq(interviewPreparationSessions.id, sessionId))).limit(1))[0];
  if (!session) throw new MockFeedbackError('NOT_FOUND', 404);
  const plan = (await executor.select().from(interviewPreparationPlans).where(and(eq(interviewPreparationPlans.workspaceId, workspaceId), eq(interviewPreparationPlans.id, session.planId))).limit(1))[0];
  if (!plan) throw new MockFeedbackError('NOT_FOUND', 404);
  const turn = (await executor.select().from(interviewPreparationTurns).where(and(eq(interviewPreparationTurns.workspaceId, workspaceId), eq(interviewPreparationTurns.sessionId, session.id), eq(interviewPreparationTurns.id, turnId))).limit(1))[0];
  if (!turn) throw new MockFeedbackError('NOT_FOUND', 404);
  if (!turn.answer?.trim()) throw new MockFeedbackError('TURN_NOT_ANSWERED', 409);
  if (turn.assistantFeedback) throw new MockFeedbackError('FEEDBACK_ALREADY_ACCEPTED');

  const evidence = await executor.select().from(interviewPreparationEvidence).where(and(eq(interviewPreparationEvidence.workspaceId, workspaceId), eq(interviewPreparationEvidence.planId, plan.id)));
  const current = await currentEvidence(executor as never, workspaceId, evidence.map((row) => ({ kind: row.kind as InterviewEvidenceKind, sourceId: row.sourceId })));
  if (evidence.some((row) => interviewEvidenceStatus(row.contentSha256, current.get(`${row.kind}:${row.sourceId}`)) !== 'CURRENT')) throw new MockFeedbackError('PLAN_EVIDENCE_STALE');
  const planFactIds = evidence.filter((row) => row.kind === 'APPROVED_FACT').map((row) => row.sourceId);
  if (factIds.some((id) => !planFactIds.includes(id))) throw new MockFeedbackError('INVALID_SELECTION', 400);
  const selected = factIds.length ? await executor.select().from(profileFacts).where(and(
    eq(profileFacts.workspaceId, workspaceId), inArray(profileFacts.id, factIds), eq(profileFacts.approvalStatus, 'USER_APPROVED'),
  )) : [];
  if (selected.length !== factIds.length) throw new MockFeedbackError('PLAN_EVIDENCE_STALE');
  const profileIds = [...new Set(selected.map((fact) => fact.profileVersionId))];
  if (profileIds.length > 1) throw new MockFeedbackError('PLAN_EVIDENCE_STALE');
  const profile = profileIds.length ? (await executor.select().from(profileVersions).where(and(eq(profileVersions.workspaceId, workspaceId), eq(profileVersions.id, profileIds[0]!))).limit(1))[0] : null;
  if (selected.length && !profile) throw new MockFeedbackError('PLAN_EVIDENCE_STALE');

  const locale = plan.language as 'es' | 'en';
  const parsed = aiSourceSnapshotSchema.safeParse({
    schemaVersion: AI_SCHEMA_VERSION, snapshotId: turn.id, workspaceId, operation: 'INTERVIEW_MOCK_FEEDBACK', locale, snapshotHash: '0'.repeat(64),
    searchRequest: null, job: null, question: null, resume: undefined, documentReword: undefined, interviewPrep: undefined,
    interviewMockFeedback: { planId: plan.id, sessionId: session.id, turnId: turn.id, question: turn.question, answer: turn.answer },
    facts: selected.map((fact) => ({ factId: fact.id, approvalStatus: 'USER_APPROVED', kind: fact.kind, text: fact.statement, contentHash: sha256(`${fact.kind}\n${fact.statement}`) })),
    profileRevision: profile?.revision ?? null, identityFingerprint: null,
  });
  if (!parsed.success) throw new MockFeedbackError(parsed.error.issues.some((issue) => issue.code === 'too_big') ? 'SOURCE_TOO_LARGE' : 'SOURCE_INVALID', 422);
  const snapshot: AiSourceSnapshot = parsed.data;
  snapshot.snapshotHash = hashAiInputContent(snapshot);
  const prompt = buildAiPrompt(snapshot, { workspaceId, operation: 'INTERVIEW_MOCK_FEEDBACK', locale });
  return {
    plan, session, turn, snapshot, prompt, locale,
    payloadSha256: hashAiPromptMessages(prompt.messages),
    sent: { question: turn.question, answer: turn.answer, facts: selected.map((fact) => ({ factId: fact.id, kind: fact.kind, text: fact.statement })) },
  };
}

async function lockFeedbackSources(executor: Executor, workspaceId: string, planId: string, sessionId: string, turnId: string) {
  await executor.select({ id: interviewPreparationPlans.id }).from(interviewPreparationPlans).where(and(
    eq(interviewPreparationPlans.workspaceId, workspaceId), eq(interviewPreparationPlans.id, planId),
  )).for('share');
  await executor.select({ id: interviewPreparationSessions.id }).from(interviewPreparationSessions).where(and(
    eq(interviewPreparationSessions.workspaceId, workspaceId), eq(interviewPreparationSessions.id, sessionId),
  )).for('share');
  await executor.select({ id: interviewPreparationTurns.id }).from(interviewPreparationTurns).where(and(
    eq(interviewPreparationTurns.workspaceId, workspaceId), eq(interviewPreparationTurns.sessionId, sessionId), eq(interviewPreparationTurns.id, turnId),
  )).for('share');
  const evidence = await executor.select({ kind: interviewPreparationEvidence.kind, sourceId: interviewPreparationEvidence.sourceId })
    .from(interviewPreparationEvidence).where(and(
      eq(interviewPreparationEvidence.workspaceId, workspaceId), eq(interviewPreparationEvidence.planId, planId),
    )).for('share');
  const ids = (kind: InterviewEvidenceKind) => [...new Set(evidence.filter((row) => row.kind === kind).map((row) => row.sourceId))];
  const snapshotIds = ids('JOB_SNAPSHOT');
  const resumeIds = ids('RESUME_VERSION');
  const factIds = ids('APPROVED_FACT');
  if (snapshotIds.length) await executor.select({ id: jobSnapshots.id }).from(jobSnapshots).where(and(
    eq(jobSnapshots.workspaceId, workspaceId), inArray(jobSnapshots.id, snapshotIds),
  )).for('share');
  if (resumeIds.length) await executor.select({ id: documentVersions.id }).from(documentVersions).where(and(
    eq(documentVersions.workspaceId, workspaceId), inArray(documentVersions.id, resumeIds),
  )).for('share');
  if (factIds.length) await executor.select({ id: profileFacts.id }).from(profileFacts).where(and(
    eq(profileFacts.workspaceId, workspaceId), inArray(profileFacts.id, factIds),
  )).for('share');
}

export function registerAiInterviewMockFeedbackRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, options: Options) {
  const database = options.database; const now = options.now ?? (() => new Date());
  const activeConnection = async (workspaceId: string) => (await database.select().from(aiConnections)
    .where(and(eq(aiConnections.workspaceId, workspaceId), eq(aiConnections.provider, 'codex'), eq(aiConnections.active, true), eq(aiConnections.state, 'CONNECTED'))).limit(1))[0];
  app.addHook('onRoute', (route) => {
    if (!route.url.includes('/assistant-feedback')) return;
    route.errorHandler = (error, _request, reply) => {
      if (error instanceof MockFeedbackError) return reply.code(error.status).send({ error: error.code });
      if (error instanceof AiQueueError) return reply.code(error.code === 'AI_BUSY' ? 409 : 503).send({ error: error.code === 'AI_BUSY' ? 'AI_BUSY' : 'AI_UNAVAILABLE' });
      if (error.statusCode === 400 || error.statusCode === 413) return reply.code(error.statusCode).send({ error: 'INVALID_INPUT' });
      return reply.code(503).send({ error: 'AI_UNAVAILABLE' });
    };
  });

  app.post('/api/v1/interview-preparation/sessions/:sessionId/turns/:turnId/assistant-feedback/preview', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = z.object({ sessionId: uuid, turnId: uuid }).strict().safeParse(request.params); const body = selection.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const input = await loadFeedbackInput(database, workspace(request), params.data.sessionId, params.data.turnId, body.data.factIds);
    return {
      sessionId: input.session.id, turnId: input.turn.id, provider: 'codex', model: CODEX_DEFAULT_MODEL, available: options.enabled, operation: 'INTERVIEW_MOCK_FEEDBACK',
      locale: input.locale, categories: aiSnapshotDataCategories(input.snapshot), messages: input.prompt.messages,
      payloadSha256: input.payloadSha256, sent: input.sent,
    };
  });

  app.post('/api/v1/interview-preparation/sessions/:sessionId/turns/:turnId/assistant-feedback', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!options.enabled) return reply.code(503).send({ error: 'AI_UNAVAILABLE' });
    const params = z.object({ sessionId: uuid, turnId: uuid }).strict().safeParse(request.params); const body = runBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    if (body.data.origin === 'AUTOMATIC') return reply.code(403).send({ error: 'CONSENT_REQUIRES_PERSON' });
    if (!body.data.confirmed) return { declined: true };
    if (request.raw.aborted) return reply.code(499).send({ error: 'REQUEST_ABORTED' });
    const workspaceId = workspace(request);
    const input = await loadFeedbackInput(database, workspaceId, params.data.sessionId, params.data.turnId, body.data.factIds);
    const connection = await activeConnection(workspaceId);
    if (!connection) return reply.code(409).send({ error: 'AI_NOT_CONNECTED' });
    if (input.payloadSha256 !== body.data.payloadSha256) return reply.code(409).send({ error: 'PAYLOAD_CHANGED' });
    const run = await options.queue.beginDocumentRun({
      workspaceId, connectionId: connection.id, connectionRevision: connection.revision, accountFingerprint: connection.accountFingerprint,
      model: CODEX_DEFAULT_MODEL, idempotencyKey: randomUUID(), contentIdentity: sha256(stableJson({ payloadSha256: input.payloadSha256, turnId: input.turn.id })),
      payloadSha256: input.payloadSha256, baseRevisionId: input.turn.id, citedFactIds: input.snapshot.facts.map((fact) => fact.factId),
      inputVersions: { sessionId: input.session.id, turnId: input.turn.id, promptVersion: AI_PROMPT_VERSION, schemaVersion: AI_SCHEMA_VERSION },
      noticeVersion: AI_NOTICE_VERSION, now: now(), leaseMs: 180_000, operation: 'INTERVIEW_MOCK_FEEDBACK', dataCategories: aiSnapshotDataCategories(input.snapshot),
    });
    const controller = new AbortController(); options.cancellation.attach(run.id, { workspaceId, connectionId: connection.id, controller });
    const abortIfDisconnected = () => { if (request.raw.aborted || (reply.raw.destroyed && !reply.raw.writableEnded)) controller.abort(); };
    request.raw.once('aborted', abortIfDisconnected); reply.raw.once('close', abortIfDisconnected); abortIfDisconnected();
    const timer = setInterval(() => { void options.queue.heartbeatDocumentRun(run.id, run.leaseToken, 180_000, now()).then((ok) => { if (!ok) controller.abort(); }, () => controller.abort()); }, 25_000); timer.unref();
    let finished = false; let observed: CodexExecutionResult | undefined;
    let fallbackErrorCode: CodexExecutionError['code'] = 'INTERNAL';
    let fallbackDispatched: CodexExecutionError['dispatched'] | undefined;
    const usageOf = (result: CodexExecutionResult): AiRunUsage => ({ availability: 'KNOWN', model: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens });
    const task = (async () => {
      try {
        if (controller.signal.aborted) throw new Error('CANCELLED');
        const dispatchGuard: NonNullable<CodexDependencies['dispatchGuard']> = async (dispatch) => database.transaction(async (tx) => {
          await lockKey(tx, profileLockKey(workspaceId));
          await lockKey(tx, interviewPreparationPlanLockKey(workspaceId, input.plan.id));
          if (controller.signal.aborted) throw new MockFeedbackError('REQUEST_ABORTED', 499);
          const executor = tx as unknown as Executor;
          await lockFeedbackSources(executor, workspaceId, input.plan.id, input.session.id, input.turn.id);
          const current = await loadFeedbackInput(executor, workspaceId, input.session.id, input.turn.id, body.data.factIds);
          if (current.payloadSha256 !== body.data.payloadSha256) throw new MockFeedbackError('PAYLOAD_CHANGED');
          if (current.payloadSha256 !== input.payloadSha256) throw new MockFeedbackError('PLAN_EVIDENCE_STALE');
          if (controller.signal.aborted) throw new MockFeedbackError('REQUEST_ABORTED', 499);
          await dispatch();
        });
        observed = await (options.execute ?? executeCodex)(input.snapshot, connection.accountFingerprint, options.identitySalt, controller.signal, CODEX_DEFAULT_MODEL, { dispatchGuard });
        if (controller.signal.aborted) throw new Error('CANCELLED');
        const validated = validateAiOutput(observed.output, input.snapshot, { workspaceId, operation: 'INTERVIEW_MOCK_FEEDBACK', locale: input.locale });
        if (!validated.ok || validated.output.operation !== 'INTERVIEW_MOCK_FEEDBACK') throw new Error('INVALID_OUTPUT');
        const feedbackSha256 = sha256(stableJson(validated.output));
        const status = await options.queue.finishDocumentRun(run.id, run.leaseToken, {
          status: 'SUCCEEDED', feedbackHash: { turnId: input.turn.id, feedbackSha256 }, usage: usageOf(observed), now: now(),
        });
        finished = true;
        if (status !== 'SUCCEEDED') return reply.code(409).send({ error: status === 'CANCELLED' ? 'AI_CANCELLED' : 'AI_PROPOSAL_EXPIRED' });
        return reply.send({ runId: run.id, payloadSha256: input.payloadSha256, label: 'GENERATED_PRACTICE_FEEDBACK', feedback: validated.output });
      } catch (error) {
        if (error instanceof MockFeedbackError) {
          fallbackErrorCode = 'CANCELLED';
          fallbackDispatched = 'NO';
          const status = await options.queue.finishDocumentRun(run.id, run.leaseToken, {
            status: 'FAILED', error: { code: 'CANCELLED', dispatched: 'NO' }, now: now(),
          });
          finished = true;
          if (status === null) return reply.code(409).send({ error: 'AI_PROPOSAL_EXPIRED' });
          return reply.code(error.status).send({ error: error.code });
        }
        const cancelled = controller.signal.aborted || (error instanceof Error && error.message === 'CANCELLED');
        const codexError = error instanceof CodexExecutionError ? error : null;
        fallbackErrorCode = codexError?.code ?? (cancelled ? 'CANCELLED' : 'INVALID_OUTPUT');
        fallbackDispatched = codexError?.dispatched ?? (observed ? 'YES' : cancelled ? 'NO' : 'UNKNOWN');
        const status = await options.queue.finishDocumentRun(run.id, run.leaseToken, {
          status: 'FAILED', error: { code: fallbackErrorCode, dispatched: fallbackDispatched }, ...(observed ? { usage: usageOf(observed) } : {}), now: now(),
        });
        finished = true;
        if (status === 'CANCELLED') return reply.code(409).send({ error: 'AI_CANCELLED' });
        if (status === null) return reply.code(409).send({ error: 'AI_PROPOSAL_EXPIRED' });
        return reply.code(cancelled ? 499 : 503).send({ error: cancelled ? 'REQUEST_ABORTED' : 'AI_UNAVAILABLE' });
      } finally {
        clearInterval(timer); request.raw.off('aborted', abortIfDisconnected); reply.raw.off('close', abortIfDisconnected);
        if (!finished) await options.queue.finishDocumentRun(run.id, run.leaseToken, { status: 'FAILED', error: { code: fallbackErrorCode, dispatched: fallbackDispatched ?? (observed ? 'YES' : 'UNKNOWN') }, now: now() }).catch(() => undefined);
        options.cancellation.detach(run.id);
      }
    })();
    options.cancellation.track(run.id, task);
    return task;
  });

  app.post('/api/v1/interview-preparation/sessions/:sessionId/turns/:turnId/assistant-feedback/accept', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = z.object({ sessionId: uuid, turnId: uuid }).strict().safeParse(request.params); const body = acceptBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const turn = await database.transaction(async (tx) => {
      const session = (await tx.select({ planId: interviewPreparationSessions.planId }).from(interviewPreparationSessions).where(and(
        eq(interviewPreparationSessions.workspaceId, workspaceId), eq(interviewPreparationSessions.id, params.data.sessionId),
      )).limit(1))[0];
      if (!session) throw new MockFeedbackError('NOT_FOUND', 404);
      // Match dispatch's lock order so evidence cannot be revoked or changed between validation and save.
      await lockKey(tx, profileLockKey(workspaceId));
      await lockKey(tx, interviewPreparationPlanLockKey(workspaceId, session.planId));
      await lockFeedbackSources(tx as unknown as Executor, workspaceId, session.planId, params.data.sessionId, params.data.turnId);
      const found = (await tx.select().from(interviewPreparationTurns).where(and(
        eq(interviewPreparationTurns.workspaceId, workspaceId), eq(interviewPreparationTurns.sessionId, params.data.sessionId), eq(interviewPreparationTurns.id, params.data.turnId),
      )).for('update').limit(1))[0];
      if (!found) throw new MockFeedbackError('NOT_FOUND', 404);
      if (found.assistantFeedback) throw new MockFeedbackError('FEEDBACK_ALREADY_ACCEPTED');
      const run = (await tx.select().from(aiRuns).where(and(eq(aiRuns.workspaceId, workspaceId), eq(aiRuns.id, body.data.runId))).limit(1))[0];
      const runSnapshot = run?.snapshot as { payloadSha256?: unknown; baseRevisionId?: unknown; citedFactIds?: unknown } | undefined;
      if (!run || run.operation !== 'INTERVIEW_MOCK_FEEDBACK' || run.status !== 'SUCCEEDED' || runSnapshot?.baseRevisionId !== found.id || runSnapshot.payloadSha256 !== body.data.payloadSha256) throw new MockFeedbackError('AI_PROPOSAL_EXPIRED');
      const factIds = z.array(uuid).max(20).safeParse(runSnapshot.citedFactIds);
      if (!factIds.success) throw new MockFeedbackError('AI_PROPOSAL_EXPIRED');
      const input = await loadFeedbackInput(tx as never, workspaceId, params.data.sessionId, params.data.turnId, factIds.data);
      if (input.payloadSha256 !== body.data.payloadSha256) throw new MockFeedbackError('PAYLOAD_CHANGED');
      const proposal = (await tx.select().from(interviewPreparationFeedbackProposals).where(and(
        eq(interviewPreparationFeedbackProposals.workspaceId, workspaceId), eq(interviewPreparationFeedbackProposals.runId, run.id), eq(interviewPreparationFeedbackProposals.turnId, found.id),
      )).limit(1))[0];
      if (!proposal || proposal.feedbackSha256 !== sha256(stableJson(body.data.feedback))) throw new MockFeedbackError('AI_PROPOSAL_EXPIRED');
      const validated = validateAiOutput(body.data.feedback, input.snapshot, { workspaceId, operation: 'INTERVIEW_MOCK_FEEDBACK', locale: input.locale });
      if (!validated.ok) throw new MockFeedbackError('AI_PROPOSAL_EXPIRED');
      const saved = (await tx.update(interviewPreparationTurns).set({
        assistantFeedback: { generated: true, provider: 'codex', acceptedAt: now().toISOString(), runId: run.id, ...validated.output }, updatedAt: now(),
      }).where(and(eq(interviewPreparationTurns.workspaceId, workspaceId), eq(interviewPreparationTurns.id, found.id))).returning())[0]!;
      await tx.delete(interviewPreparationFeedbackProposals).where(and(
        eq(interviewPreparationFeedbackProposals.workspaceId, workspaceId), eq(interviewPreparationFeedbackProposals.runId, run.id), eq(interviewPreparationFeedbackProposals.turnId, found.id),
      ));
      return saved;
    });
    return reply.code(201).send({ turn: turnView(turn) });
  });

  app.post('/api/v1/interview-preparation/sessions/:sessionId/turns/:turnId/assistant-feedback/discard', async (request, reply) => {
    const params = z.object({ sessionId: uuid, turnId: uuid }).strict().safeParse(request.params); const body = discardBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    await database.transaction(async (tx) => {
      // Acceptance locks this same row, so discard and accept have a single winner.
      const turn = (await tx.select({ id: interviewPreparationTurns.id, assistantFeedback: interviewPreparationTurns.assistantFeedback }).from(interviewPreparationTurns).where(and(
        eq(interviewPreparationTurns.workspaceId, workspaceId), eq(interviewPreparationTurns.sessionId, params.data.sessionId), eq(interviewPreparationTurns.id, params.data.turnId),
      )).for('update').limit(1))[0];
      if (!turn) throw new MockFeedbackError('NOT_FOUND', 404);
      if (turn.assistantFeedback) throw new MockFeedbackError('FEEDBACK_ALREADY_ACCEPTED');
      await tx.delete(interviewPreparationFeedbackProposals).where(and(
        eq(interviewPreparationFeedbackProposals.workspaceId, workspaceId), eq(interviewPreparationFeedbackProposals.runId, body.data.runId), eq(interviewPreparationFeedbackProposals.turnId, turn.id),
      ));
    });
    return reply.code(204).send();
  });
}
