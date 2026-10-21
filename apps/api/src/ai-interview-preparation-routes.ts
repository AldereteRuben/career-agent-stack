import { createHash, randomUUID } from 'node:crypto';
import { clearInterval, setInterval } from 'node:timers';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  aiConnections, aiDocumentRewordProposals, aiRuns, applications, documentVersions, interviewPreparationEvidence, interviewPreparationItems,
  interviewPreparationPlans, jobSearchSources, jobSnapshots, profileFacts, type db,
} from '@career/db';
import {
  AI_SCHEMA_VERSION, aiInterviewPrepRequests, aiSnapshotDataCategories, aiSourceSnapshotSchema, INTERVIEW_PLAN_LIMITS, interviewEvidenceStatus,
  validateAiOutput, type AiSourceSnapshot, type InterviewEvidenceKind,
} from '@career/domain';
import { AI_NOTICE_VERSION } from './ai-run-routes.js';
import { buildAiPrompt, hashAiInputContent, hashAiPromptMessages, AI_PROMPT_VERSION } from './ai/prompts.js';
import { CODEX_DEFAULT_MODEL, CodexExecutionError, executeCodex, type CodexDependencies, type CodexExecutionResult } from './ai/codex.js';
import { AiQueueError, type AiQueue, type AiRunUsage } from './ai/queue.js';
import type { AiDocumentRewordCancellation } from './ai-application-document-routes.js';
import { currentEvidence, interviewPreparationPlanLockKey, itemView } from './interview-preparation-routes.js';
import { plainDescription } from './job-search-sources.js';
import { lockKey, profileLockKey } from './workspace-data.js';

/**
 * Optional, per-request Codex suggestions for one interview preparation plan (ADR 024, #201). Same contract as the document
 * reword path: the person sees the exact messages first, confirms that one request (a remembered permission never covers it),
 * the work runs inside the request, and nothing is saved until the person accepts specific suggestions. The plan, its own
 * items and its other applications are never sent, and stale evidence must be reviewed before the plan is reused.
 */
export class AiInterviewPrepError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); this.name = 'AiInterviewPrepError'; }
}
type Options = {
  enabled: boolean; database: typeof db; identitySalt: string; queue: AiQueue; cancellation: AiDocumentRewordCancellation;
  execute?: typeof executeCodex; now?: () => Date;
};
const uuid = z.uuid();
const selectionShape = {
  request: z.enum(aiInterviewPrepRequests),
  /** Approved facts the plan cites that the person includes. Omitted means all of them; an empty list means none. */
  factIds: z.array(uuid).max(100).refine((ids) => new Set(ids).size === ids.length).optional(),
  /** The person's own notes and questions that they choose to include. Nothing is sent unless chosen. */
  noteIds: z.array(uuid).max(50).refine((ids) => new Set(ids).size === ids.length).default([]),
  includeResume: z.boolean().default(false),
};
const previewBody = z.object(selectionShape).strict();
const runBody = z.object({ ...selectionShape, payloadSha256: z.string().regex(/^[a-f0-9]{64}$/u), confirmed: z.boolean(), origin: z.enum(['MANUAL', 'AUTOMATIC']).default('MANUAL') }).strict();
const suggestionSchema = z.object({
  key: z.string().min(1).max(80), kind: z.enum(['PRACTICE_QUESTION', 'CODING_HINT', 'RECRUITER_QUESTION', 'STUDY_ITEM']), text: z.string().trim().min(1).max(1500),
  hints: z.array(z.string().trim().min(1).max(600)).max(5), sourceFactIds: z.array(uuid).max(10),
}).strict();
const acceptBody = z.object({ runId: uuid, suggestions: z.array(suggestionSchema).min(1).max(20) }).strict();
type Selection = z.infer<typeof previewBody>;
type Suggestion = z.infer<typeof suggestionSchema>;

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const stableJson = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
});
const suggestionHash = (suggestion: Suggestion) => sha256(stableJson({ kind: suggestion.kind, text: suggestion.text, hints: suggestion.hints, sourceFactIds: suggestion.sourceFactIds }));
/** Accepted suggestions become plan items of the matching kind. A practice question is an exercise; a recruiter question is a question to ask. */
const itemKindFor = { PRACTICE_QUESTION: 'EXERCISE', CODING_HINT: 'EXERCISE', RECRUITER_QUESTION: 'QUESTION', STUDY_ITEM: 'STUDY' } as const;

type Executor = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>;

/** Reads the plan and builds exactly what would be sent, or fails with a reason the person can act on. */
async function loadAssistantInput(executor: Executor, workspaceId: string, planId: string, selection: Selection) {
  const plan = (await executor.select().from(interviewPreparationPlans).where(and(eq(interviewPreparationPlans.workspaceId, workspaceId), eq(interviewPreparationPlans.id, planId))).limit(1))[0];
  if (!plan) throw new AiInterviewPrepError('NOT_FOUND', 404);
  const evidence = await executor.select().from(interviewPreparationEvidence).where(and(eq(interviewPreparationEvidence.workspaceId, workspaceId), eq(interviewPreparationEvidence.planId, plan.id))).orderBy(asc(interviewPreparationEvidence.createdAt), asc(interviewPreparationEvidence.id));
  const current = await currentEvidence(executor as never, workspaceId, evidence.map((row) => ({ kind: row.kind as InterviewEvidenceKind, sourceId: row.sourceId })));
  // Stale evidence must be reviewed before the plan is reused, so it is never sent.
  if (evidence.some((row) => interviewEvidenceStatus(row.contentSha256, current.get(`${row.kind}:${row.sourceId}`)) !== 'CURRENT')) throw new AiInterviewPrepError('PLAN_EVIDENCE_STALE');
  const offerEvidence = evidence.find((row) => row.kind === 'JOB_SNAPSHOT');
  if (!offerEvidence) throw new AiInterviewPrepError('PLAN_HAS_NO_OFFER');
  // During the guarded reread this share lock remains held until stdin handoff, so a concurrent application edit
  // either commits before the payload is rebuilt or waits until the already-built payload has been handed off.
  const application = (await executor.select().from(applications).where(and(eq(applications.workspaceId, workspaceId), eq(applications.id, plan.applicationId))).limit(1).for('share'))[0];
  const posting = (await executor.select().from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, workspaceId), eq(jobSnapshots.id, offerEvidence.sourceId))).limit(1))[0];
  if (!application || !posting) throw new AiInterviewPrepError('PLAN_HAS_NO_OFFER');
  const fromFeed = (await executor.select({ id: jobSearchSources.jobId }).from(jobSearchSources).where(and(eq(jobSearchSources.workspaceId, workspaceId), eq(jobSearchSources.jobId, posting.jobId))).limit(1)).length > 0;
  const description = (fromFeed ? plainDescription(posting.descriptionText) : posting.descriptionText) ?? '';

  const planFactIds = evidence.filter((row) => row.kind === 'APPROVED_FACT').map((row) => row.sourceId);
  const factIds = selection.factIds ?? planFactIds;
  if (factIds.some((id) => !planFactIds.includes(id))) throw new AiInterviewPrepError('INVALID_SELECTION', 400);
  const factRows = factIds.length ? await executor.select({ id: profileFacts.id, statement: profileFacts.statement }).from(profileFacts).where(and(eq(profileFacts.workspaceId, workspaceId), inArray(profileFacts.id, factIds))) : [];
  const facts = factIds.map((id) => factRows.find((row) => row.id === id)).filter((row): row is NonNullable<typeof row> => Boolean(row)).map((row) => ({ factId: row.id, text: row.statement }));

  let resume: { text: string } | null = null;
  if (selection.includeResume) {
    const resumeEvidence = evidence.find((row) => row.kind === 'RESUME_VERSION');
    if (!resumeEvidence) throw new AiInterviewPrepError('PLAN_HAS_NO_RESUME');
    const document = (await executor.select({ claims: documentVersions.claims }).from(documentVersions).where(and(eq(documentVersions.workspaceId, workspaceId), eq(documentVersions.id, resumeEvidence.sourceId))).limit(1))[0];
    const text = (document?.claims ?? []).map((claim) => claim.text).filter((line) => typeof line === 'string' && line.trim()).join('\n').trim();
    if (!text) throw new AiInterviewPrepError('PLAN_HAS_NO_RESUME');
    if (text.length > 20_000) throw new AiInterviewPrepError('RESUME_TOO_LARGE');
    resume = { text };
  }

  const noteRows = selection.noteIds.length ? await executor.select().from(interviewPreparationItems).where(and(eq(interviewPreparationItems.workspaceId, workspaceId), eq(interviewPreparationItems.planId, plan.id), inArray(interviewPreparationItems.id, selection.noteIds))) : [];
  // Only the person's own notes and questions can be included; generated items are never sent back.
  if (noteRows.length !== selection.noteIds.length || noteRows.some((row) => !['USER_NOTE', 'USER_RESEARCH'].includes(row.origin))) throw new AiInterviewPrepError('INVALID_SELECTION', 400);
  const notes = selection.noteIds.map((id) => noteRows.find((row) => row.id === id)!).map((row) => ({ noteId: row.id, text: row.content }));

  const locale = plan.language as 'es' | 'en';
  const parsed = aiSourceSnapshotSchema.safeParse({
    schemaVersion: AI_SCHEMA_VERSION, snapshotId: plan.id, workspaceId, operation: 'INTERVIEW_PREP', locale, snapshotHash: '0'.repeat(64),
    searchRequest: null, job: null, question: null, facts: [], profileRevision: null, identityFingerprint: null,
    interviewPrep: {
      planId: plan.id, request: selection.request, stage: plan.stage,
      offer: { company: application.company, role: application.role, location: application.location, title: posting.title, description },
      resume, facts, notes,
    },
  });
  if (!parsed.success) throw new AiInterviewPrepError(parsed.error.issues.some((issue) => issue.code === 'too_big') ? 'SOURCE_TOO_LARGE' : 'SOURCE_INVALID');
  const snapshot: AiSourceSnapshot = parsed.data;
  snapshot.snapshotHash = hashAiInputContent(snapshot);
  const prompt = buildAiPrompt(snapshot, { workspaceId, operation: 'INTERVIEW_PREP', locale });
  return { plan, evidence, offerEvidence, snapshot, prompt, locale, payloadSha256: hashAiPromptMessages(prompt.messages) };
}

export function registerAiInterviewPreparationRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, options: Options) {
  const database = options.database; const now = options.now ?? (() => new Date());
  const activeConnection = async (workspaceId: string) => (await database.select().from(aiConnections)
    .where(and(eq(aiConnections.workspaceId, workspaceId), eq(aiConnections.provider, 'codex'), eq(aiConnections.active, true), eq(aiConnections.state, 'CONNECTED'))).limit(1))[0];
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/v1/interview-preparation/') || !route.url.includes('/assistant')) return;
    route.errorHandler = (error, _request, reply) => {
      if (error instanceof AiInterviewPrepError) return reply.code(error.status).send({ error: error.code });
      if (error instanceof AiQueueError) return reply.code(error.code === 'AI_BUSY' ? 409 : 503).send({ error: error.code === 'AI_BUSY' ? 'AI_BUSY' : 'AI_UNAVAILABLE' });
      if (error.statusCode === 400 || error.statusCode === 413) return reply.code(error.statusCode).send({ error: 'INVALID_INPUT' });
      return reply.code(503).send({ error: 'AI_UNAVAILABLE' });
    };
  });

  // Shows the complete payload. Nothing is sent to any assistant by this route.
  app.post('/api/v1/interview-preparation/:id/assistant/preview', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!options.enabled) return reply.code(503).send({ error: 'AI_UNAVAILABLE' });
    const params = z.object({ id: uuid }).strict().safeParse(request.params); const body = previewBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const input = await loadAssistantInput(database, workspace(request), params.data.id, body.data);
    const source = input.snapshot.interviewPrep!;
    return {
      planId: input.plan.id, provider: 'codex', model: CODEX_DEFAULT_MODEL, operation: 'INTERVIEW_PREP', locale: input.locale, request: source.request,
      categories: aiSnapshotDataCategories(input.snapshot), messages: input.prompt.messages, payloadSha256: input.payloadSha256,
      sent: { stage: source.stage, offer: { company: source.offer.company, role: source.offer.role, title: source.offer.title }, facts: source.facts, resume: source.resume, notes: source.notes },
    };
  });

  app.post('/api/v1/interview-preparation/:id/assistant', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!options.enabled) return reply.code(503).send({ error: 'AI_UNAVAILABLE' });
    const params = z.object({ id: uuid }).strict().safeParse(request.params); const body = runBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    // Consent is given by the person for this one request; nothing automatic or remembered can stand in for it.
    if (body.data.origin === 'AUTOMATIC') return reply.code(403).send({ error: 'CONSENT_REQUIRES_PERSON' });
    if (!body.data.confirmed) return { declined: true };
    if (request.raw.aborted) return reply.code(499).send({ error: 'REQUEST_ABORTED' });
    const workspaceId = workspace(request);
    const input = await loadAssistantInput(database, workspaceId, params.data.id, body.data);
    const connection = await activeConnection(workspaceId);
    if (!connection) return reply.code(409).send({ error: 'AI_NOT_CONNECTED' });
    if (input.payloadSha256 !== body.data.payloadSha256) return reply.code(409).send({ error: 'PAYLOAD_CHANGED' });
    const { snapshot, plan } = input;
    const run = await options.queue.beginDocumentRun({
      workspaceId, connectionId: connection.id, connectionRevision: connection.revision, accountFingerprint: connection.accountFingerprint, model: CODEX_DEFAULT_MODEL,
      idempotencyKey: randomUUID(), contentIdentity: sha256(stableJson({ payloadSha256: input.payloadSha256, planId: plan.id })), payloadSha256: input.payloadSha256,
      baseRevisionId: plan.id, citedFactIds: snapshot.interviewPrep!.facts.map((fact) => fact.factId),
      inputVersions: { planId: plan.id, request: snapshot.interviewPrep!.request, promptVersion: AI_PROMPT_VERSION, schemaVersion: AI_SCHEMA_VERSION },
      noticeVersion: AI_NOTICE_VERSION, now: now(), leaseMs: 180_000, operation: 'INTERVIEW_PREP', dataCategories: aiSnapshotDataCategories(snapshot),
    });
    const controller = new AbortController(); options.cancellation.attach(run.id, { workspaceId, connectionId: connection.id, controller });
    const abortIfDisconnected = () => { if (request.raw.aborted || (reply.raw.destroyed && !reply.raw.writableEnded)) controller.abort(); };
    request.raw.once('aborted', abortIfDisconnected); reply.raw.once('close', abortIfDisconnected);
    abortIfDisconnected();
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
          await lockKey(tx, interviewPreparationPlanLockKey(workspaceId, plan.id));
          const current = await loadAssistantInput(tx as unknown as Executor, workspaceId, plan.id, body.data);
          if (current.payloadSha256 !== body.data.payloadSha256) throw new AiInterviewPrepError('PAYLOAD_CHANGED');
          if (current.payloadSha256 !== input.payloadSha256) throw new AiInterviewPrepError('PLAN_EVIDENCE_STALE');
          await dispatch();
        });
        observed = await (options.execute ?? executeCodex)(snapshot, connection.accountFingerprint, options.identitySalt, controller.signal, CODEX_DEFAULT_MODEL, { dispatchGuard });
        if (controller.signal.aborted) throw new Error('CANCELLED');
        const validated = validateAiOutput(observed.output, snapshot, { workspaceId, operation: 'INTERVIEW_PREP', locale: input.locale });
        if (!validated.ok || validated.output.operation !== 'INTERVIEW_PREP') throw new Error('INVALID_OUTPUT');
        const suggestions: Suggestion[] = validated.output.suggestions.map((suggestion) => ({ key: suggestion.key, kind: suggestion.kind, text: suggestion.text, hints: suggestion.hints, sourceFactIds: suggestion.sourceFactIds }));
        const status = await options.queue.finishDocumentRun(run.id, run.leaseToken, {
          status: 'SUCCEEDED', proposalHashes: suggestions.map((suggestion) => ({ sentenceId: suggestion.key, proposalSha256: suggestionHash(suggestion) })), usage: usageOf(observed), now: now(),
        });
        finished = true;
        if (status !== 'SUCCEEDED') return reply.code(409).send({ error: status === 'CANCELLED' ? 'AI_CANCELLED' : 'AI_PROPOSAL_EXPIRED' });
        // Generated practice material: labelled as such and not part of the plan until the person accepts it.
        return reply.send({ runId: run.id, status, planId: plan.id, request: snapshot.interviewPrep!.request, label: 'GENERATED_PRACTICE_MATERIAL', suggestions, warnings: validated.output.warnings });
      } catch (error) {
        if (error instanceof AiInterviewPrepError) {
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
          status: 'FAILED', error: { code: fallbackErrorCode, dispatched: fallbackDispatched },
          ...(observed ? { usage: usageOf(observed) } : {}), now: now(),
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

  // Saves the suggestions the person chose, exactly as generated. Each one can be accepted once.
  app.post('/api/v1/interview-preparation/:id/assistant/accept', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = z.object({ id: uuid }).strict().safeParse(request.params); const body = acceptBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request); const planId = params.data.id;
    const keys = body.data.suggestions.map((suggestion) => suggestion.key);
    if (new Set(keys).size !== keys.length) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const result = await database.transaction(async (tx) => {
      // Match profile mutations and Codex dispatch: approved facts cannot be revoked while
      // evidence is validated and the accepted items are committed. Keep the profile lock
      // before the per-plan lock everywhere in this flow to avoid lock-order inversions.
      await lockKey(tx, profileLockKey(workspaceId));
      await lockKey(tx, interviewPreparationPlanLockKey(workspaceId, planId));
      const plan = (await tx.select().from(interviewPreparationPlans).where(and(eq(interviewPreparationPlans.workspaceId, workspaceId), eq(interviewPreparationPlans.id, planId))).for('update').limit(1))[0];
      if (!plan) throw new AiInterviewPrepError('NOT_FOUND', 404);
      const run = (await tx.select().from(aiRuns).where(and(eq(aiRuns.workspaceId, workspaceId), eq(aiRuns.id, body.data.runId))).for('update').limit(1))[0];
      const meta = run?.snapshot as { baseRevisionId?: unknown } | undefined;
      if (!run || run.operation !== 'INTERVIEW_PREP' || run.status !== 'SUCCEEDED' || meta?.baseRevisionId !== planId) throw new AiInterviewPrepError('AI_PROPOSAL_EXPIRED');
      const evidence = await tx.select().from(interviewPreparationEvidence).where(and(eq(interviewPreparationEvidence.workspaceId, workspaceId), eq(interviewPreparationEvidence.planId, plan.id)));
      const current = await currentEvidence(tx as never, workspaceId, evidence.map((row) => ({ kind: row.kind as InterviewEvidenceKind, sourceId: row.sourceId })));
      if (evidence.some((row) => interviewEvidenceStatus(row.contentSha256, current.get(`${row.kind}:${row.sourceId}`)) !== 'CURRENT')) throw new AiInterviewPrepError('PLAN_EVIDENCE_STALE');
      const hashes = new Map((await tx.select().from(aiDocumentRewordProposals).where(and(eq(aiDocumentRewordProposals.workspaceId, workspaceId), eq(aiDocumentRewordProposals.runId, run.id)))).map((row) => [row.sentenceId, row.proposalSha256]));
      const planFacts = new Set(evidence.filter((row) => row.kind === 'APPROVED_FACT').map((row) => row.sourceId));
      for (const suggestion of body.data.suggestions) {
        if (!hashes.has(suggestion.key)) throw new AiInterviewPrepError('SUGGESTION_ALREADY_USED');
        if (hashes.get(suggestion.key) !== suggestionHash(suggestion) || suggestion.sourceFactIds.some((id) => !planFacts.has(id))) throw new AiInterviewPrepError('PROPOSAL_MISMATCH', 422);
      }
      const existing = await tx.select({ position: interviewPreparationItems.position }).from(interviewPreparationItems).where(and(eq(interviewPreparationItems.workspaceId, workspaceId), eq(interviewPreparationItems.planId, plan.id)));
      if (existing.length + body.data.suggestions.length > INTERVIEW_PLAN_LIMITS.maxItems) throw new AiInterviewPrepError('PLAN_FULL');
      const offerEvidence = evidence.find((row) => row.kind === 'JOB_SNAPSHOT');
      const factEvidence = new Map(evidence.filter((row) => row.kind === 'APPROVED_FACT').map((row) => [row.sourceId, row.id]));
      const first = existing.reduce((highest, row) => Math.max(highest, row.position), -1) + 1;
      // Consumed: an accepted suggestion cannot be accepted again from the same run.
      await tx.delete(aiDocumentRewordProposals).where(and(eq(aiDocumentRewordProposals.workspaceId, workspaceId), eq(aiDocumentRewordProposals.runId, run.id), inArray(aiDocumentRewordProposals.sentenceId, keys)));
      const inserted = await tx.insert(interviewPreparationItems).values(body.data.suggestions.map((suggestion, index) => ({
        workspaceId, planId: plan.id, kind: itemKindFor[suggestion.kind], origin: 'ASSISTANT', position: first + index, content: suggestion.text, hints: suggestion.hints,
        factIds: suggestion.sourceFactIds, evidenceId: (suggestion.sourceFactIds[0] ? factEvidence.get(suggestion.sourceFactIds[0]) : undefined) ?? offerEvidence?.id ?? null,
      }))).returning();
      await tx.update(interviewPreparationPlans).set({ updatedAt: sql`now()` }).where(and(eq(interviewPreparationPlans.workspaceId, workspaceId), eq(interviewPreparationPlans.id, plan.id)));
      return inserted;
    });
    return reply.code(201).send({ items: result.map(itemView) });
  });
}
