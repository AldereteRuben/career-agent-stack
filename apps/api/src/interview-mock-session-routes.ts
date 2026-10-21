import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db, interviewPreparationEvidence, interviewPreparationItems, interviewPreparationPlans, interviewPreparationSessions, interviewPreparationTurns, profileFacts } from '@career/db';
import {
  applyInterviewSelfAssessment, assessInterviewAnswer, INTERVIEW_MOCK_LIMITS, interviewProbeText, interviewRubricCriteria, interviewRubricStatuses, nextInterviewPracticeItem,
  type CandidateEvidence, type InterviewRubricCriterion, type InterviewRubricStatus, type InterviewTurnFeedback,
} from '@career/domain';
import { turnView } from './interview-preparation-routes.js';

/**
 * Text mock sessions (ADR 024, #202): one question at a time, an answer, observable feedback against an explicit rubric, at
 * most one follow-up for a weak answer, and learning items the person can edit or discard. Preparation only: nothing here
 * submits an answer anywhere, assists a live interview, or changes an approved fact. Questions are the practice exercises of
 * the plan; the checks live in the domain package and never judge whether an answer is right.
 */
const uuid = z.uuid();
const idParams = z.object({ id: uuid }).strict();
const answerBody = z.object({ turnId: uuid, answer: z.string().trim().min(1).max(INTERVIEW_MOCK_LIMITS.answerLength) }).strict();
const skipBody = z.object({ turnId: uuid }).strict();
const reviewBody = z.object({
  selfAssessment: z.partialRecord(z.enum(interviewRubricCriteria), z.enum(interviewRubricStatuses)).optional(),
  learningItems: z.array(z.string().trim().min(1).max(INTERVIEW_MOCK_LIMITS.learningItemLength)).max(INTERVIEW_MOCK_LIMITS.learningItems).optional(),
  discardFeedback: z.literal(true).optional(),
}).strict().refine((body) => body.selfAssessment !== undefined || body.learningItems !== undefined || body.discardFeedback !== undefined, 'Nothing to change.');

type MockDatabase = typeof db;
type Turn = typeof interviewPreparationTurns.$inferSelect;
class MockSessionError extends Error { constructor(readonly code: string, readonly status = 409) { super(code); } }

const sessionView = (session: typeof interviewPreparationSessions.$inferSelect, turns: Turn[]) => ({
  id: session.id, planId: session.planId, status: session.status, createdAt: session.createdAt, endedAt: session.endedAt, turns: turns.map(turnView),
});

export function registerInterviewMockSessionRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, database: MockDatabase = db) {
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/v1/interview-preparation/')) return;
    const original = route.errorHandler;
    route.errorHandler = function (error, request, reply) {
      if (error instanceof MockSessionError) return reply.code(error.status).send({ error: error.code });
      return original ? original.call(this, error, request, reply) : reply.send(error);
    };
  });

  const lockSession = async (tx: Pick<MockDatabase, 'select'>, workspaceId: string, sessionId: string) => {
    const session = (await tx.select().from(interviewPreparationSessions).where(and(eq(interviewPreparationSessions.workspaceId, workspaceId), eq(interviewPreparationSessions.id, sessionId))).for('update').limit(1))[0];
    if (!session) throw new MockSessionError('NOT_FOUND', 404);
    return session;
  };
  const sessionTurns = (tx: Pick<MockDatabase, 'select'>, workspaceId: string, sessionId: string) =>
    tx.select().from(interviewPreparationTurns).where(and(eq(interviewPreparationTurns.workspaceId, workspaceId), eq(interviewPreparationTurns.sessionId, sessionId))).orderBy(asc(interviewPreparationTurns.position));
  /** The practice exercise to ask next, or null when the plan has none left. Asked items are the QUESTION turns of this session. */
  const nextQuestion = async (tx: Pick<MockDatabase, 'select'>, workspaceId: string, planId: string, turns: Turn[]) => {
    const items = await tx.select({ id: interviewPreparationItems.id, kind: interviewPreparationItems.kind, position: interviewPreparationItems.position, content: interviewPreparationItems.content })
      .from(interviewPreparationItems).where(and(eq(interviewPreparationItems.workspaceId, workspaceId), eq(interviewPreparationItems.planId, planId)));
    return nextInterviewPracticeItem(items, new Set(turns.filter((turn) => turn.kind === 'QUESTION' && turn.itemId).map((turn) => turn.itemId!)));
  };
  /** Approved facts the plan cites, as evidence for the checks. Withdrawn facts count for nothing. */
  const planFacts = async (tx: Pick<MockDatabase, 'select'>, workspaceId: string, planId: string): Promise<CandidateEvidence[]> => {
    const ids = (await tx.select({ id: interviewPreparationEvidence.sourceId }).from(interviewPreparationEvidence)
      .where(and(eq(interviewPreparationEvidence.workspaceId, workspaceId), eq(interviewPreparationEvidence.planId, planId), eq(interviewPreparationEvidence.kind, 'APPROVED_FACT')))).map((row) => row.id);
    if (!ids.length) return [];
    return (await tx.select().from(profileFacts).where(and(eq(profileFacts.workspaceId, workspaceId), inArray(profileFacts.id, ids))))
      .map((fact) => ({ id: fact.id, text: fact.statement, tags: fact.tags, approval: fact.approvalStatus }));
  };

  app.post('/api/v1/interview-preparation/:id/sessions', async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const created = await database.transaction(async (tx) => {
      const plan = (await tx.select().from(interviewPreparationPlans).where(and(eq(interviewPreparationPlans.workspaceId, workspaceId), eq(interviewPreparationPlans.id, params.data.id))).for('update').limit(1))[0];
      if (!plan) throw new MockSessionError('NOT_FOUND', 404);
      const first = await nextQuestion(tx, workspaceId, plan.id, []);
      if (!first) throw new MockSessionError('NO_PRACTICE_ITEMS');
      const session = (await tx.insert(interviewPreparationSessions).values({ workspaceId, planId: plan.id }).returning())[0]!;
      const turn = (await tx.insert(interviewPreparationTurns).values({ workspaceId, sessionId: session.id, position: 0, kind: 'QUESTION', itemId: first.id, question: first.content }).returning())[0]!;
      return sessionView(session, [turn]);
    });
    return reply.code(201).send({ session: created });
  });

  app.post('/api/v1/interview-preparation/sessions/:id/answer', async (request, reply) => {
    const params = idParams.safeParse(request.params); const body = answerBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const result = await database.transaction(async (tx) => {
      const session = await lockSession(tx, workspaceId, params.data.id);
      if (session.status !== 'IN_PROGRESS') throw new MockSessionError('SESSION_COMPLETED');
      const turns = await sessionTurns(tx, workspaceId, session.id);
      const current = turns.at(-1);
      if (!current || current.id !== body.data.turnId) throw new MockSessionError('TURN_NOT_CURRENT');
      if (current.answer !== null) throw new MockSessionError('ALREADY_ANSWERED');
      const plan = (await tx.select().from(interviewPreparationPlans).where(and(eq(interviewPreparationPlans.workspaceId, workspaceId), eq(interviewPreparationPlans.id, session.planId))).limit(1))[0]!;
      const check = assessInterviewAnswer({ language: plan.language as 'es' | 'en', answer: body.data.answer, facts: await planFacts(tx, workspaceId, plan.id) });
      const answered = (await tx.update(interviewPreparationTurns).set({ answer: body.data.answer, feedback: check.feedback as unknown as Record<string, unknown>, learningItems: check.learningItems, updatedAt: new Date() })
        .where(and(eq(interviewPreparationTurns.workspaceId, workspaceId), eq(interviewPreparationTurns.id, current.id))).returning())[0]!;
      // A weak question answer is followed up once. The answer to a follow-up never starts another, so the session always moves on.
      let next: Turn | null = null;
      if (check.feedback.probe && current.kind === 'QUESTION') {
        next = (await tx.insert(interviewPreparationTurns).values({ workspaceId, sessionId: session.id, position: current.position + 1, kind: 'PROBE', itemId: current.itemId, question: interviewProbeText(check.feedback.probe, plan.language as 'es' | 'en') }).returning())[0]!;
      } else {
        const item = await nextQuestion(tx, workspaceId, plan.id, [...turns]);
        if (item) next = (await tx.insert(interviewPreparationTurns).values({ workspaceId, sessionId: session.id, position: current.position + 1, kind: 'QUESTION', itemId: item.id, question: item.content }).returning())[0]!;
      }
      return { turn: answered, next };
    });
    return reply.send({ turn: turnView(result.turn), next: result.next ? turnView(result.next) : null, done: result.next === null });
  });

  app.post('/api/v1/interview-preparation/sessions/:id/skip', async (request, reply) => {
    const params = idParams.safeParse(request.params); const body = skipBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const result = await database.transaction(async (tx) => {
      const session = await lockSession(tx, workspaceId, params.data.id);
      if (session.status !== 'IN_PROGRESS') throw new MockSessionError('SESSION_COMPLETED');
      const turns = await sessionTurns(tx, workspaceId, session.id);
      const current = turns.at(-1);
      if (!current || current.id !== body.data.turnId) throw new MockSessionError('TURN_NOT_CURRENT');
      if (current.answer !== null) throw new MockSessionError('ALREADY_ANSWERED');
      // An empty answer marks a skipped question: it stays in the record so it is not asked again.
      const skipped = (await tx.update(interviewPreparationTurns).set({ answer: '', updatedAt: new Date() })
        .where(and(eq(interviewPreparationTurns.workspaceId, workspaceId), eq(interviewPreparationTurns.id, current.id))).returning())[0]!;
      const item = await nextQuestion(tx, workspaceId, session.planId, [...turns]);
      const next = item ? (await tx.insert(interviewPreparationTurns).values({ workspaceId, sessionId: session.id, position: current.position + 1, kind: 'QUESTION', itemId: item.id, question: item.content }).returning())[0]! : null;
      return { turn: skipped, next };
    });
    return reply.send({ turn: turnView(result.turn), next: result.next ? turnView(result.next) : null, done: result.next === null });
  });

  // The person reviews the feedback: rate the criteria themselves, edit the learning items, or discard the feedback.
  app.patch('/api/v1/interview-preparation/sessions/turns/:id', async (request, reply) => {
    const params = idParams.safeParse(request.params); const body = reviewBody.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const turn = await database.transaction(async (tx) => {
      const found = (await tx.select().from(interviewPreparationTurns).where(and(eq(interviewPreparationTurns.workspaceId, workspaceId), eq(interviewPreparationTurns.id, params.data.id))).for('update').limit(1))[0];
      if (!found) throw new MockSessionError('NOT_FOUND', 404);
      if (!found.answer) throw new MockSessionError('TURN_NOT_ANSWERED');
      let feedback = found.feedback as InterviewTurnFeedback | null;
      if (body.data.discardFeedback) feedback = null;
      if (body.data.selfAssessment) {
        if (!feedback) throw new MockSessionError('FEEDBACK_DISCARDED');
        feedback = applyInterviewSelfAssessment(feedback, body.data.selfAssessment as Partial<Record<InterviewRubricCriterion, InterviewRubricStatus>>);
      }
      const learningItems = body.data.learningItems ? [...new Set(body.data.learningItems)] : found.learningItems;
      return (await tx.update(interviewPreparationTurns).set({ feedback: feedback as unknown as Record<string, unknown> | null, learningItems, updatedAt: new Date() })
        .where(and(eq(interviewPreparationTurns.workspaceId, workspaceId), eq(interviewPreparationTurns.id, found.id))).returning())[0]!;
    });
    return { turn: turnView(turn) };
  });

  app.post('/api/v1/interview-preparation/sessions/:id/complete', async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const view = await database.transaction(async (tx) => {
      const session = await lockSession(tx, workspaceId, params.data.id);
      if (session.status === 'COMPLETED') return sessionView(session, await sessionTurns(tx, workspaceId, session.id));
      // A question that was asked but never answered is dropped rather than recorded as an empty answer.
      const turns = await sessionTurns(tx, workspaceId, session.id);
      const open = turns.at(-1);
      if (open && open.answer === null) await tx.delete(interviewPreparationTurns).where(and(eq(interviewPreparationTurns.workspaceId, workspaceId), eq(interviewPreparationTurns.id, open.id)));
      const completed = (await tx.update(interviewPreparationSessions).set({ status: 'COMPLETED', endedAt: new Date() })
        .where(and(eq(interviewPreparationSessions.workspaceId, workspaceId), eq(interviewPreparationSessions.id, session.id))).returning())[0]!;
      return sessionView(completed, await sessionTurns(tx, workspaceId, session.id));
    });
    return { session: view };
  });

  app.get('/api/v1/interview-preparation/sessions/:id', async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const workspaceId = workspace(request);
    const session = (await database.select().from(interviewPreparationSessions).where(and(eq(interviewPreparationSessions.workspaceId, workspaceId), eq(interviewPreparationSessions.id, params.data.id))).limit(1))[0];
    if (!session) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { session: sessionView(session, await sessionTurns(database, workspaceId, session.id)) };
  });
}
