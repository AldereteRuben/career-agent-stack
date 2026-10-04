import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { aiArtifacts, aiRuns, answerVersions, type db } from '@career/db';
import { aiSourceSnapshotSchema, validateAiOutput } from '@career/domain';
import { checkCurrentAiSnapshot } from './ai/source-reader.js';
import { answerLockKey, lockKey, profileLockKey } from './workspace-data.js';
import { lockJobIdentity } from './job-identity.js';

const bodySchema = z.object({ expectedRevision: z.number().int().positive(), text: z.string().trim().min(1).max(4000) }).strict();
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export { aiAnswerCurrent } from './ai/answer-current.js';

/** Saving a reviewed suggestion creates an unapproved answer version with the original scope and expiry. */
export function registerAiAnswerRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, database: typeof db) {
  app.post('/api/v1/ai/artifacts/:id/answer', { errorHandler: (_error, _request, reply) => reply.code(503).send({ error: 'AI_UNAVAILABLE' }) }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
    const body = bodySchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'INVALID_INPUT' });
    const id = workspace(request);
    const result = await database.transaction(async tx => {
      await lockJobIdentity(tx, id);
      await lockKey(tx, profileLockKey(id));
      const artifact = (await tx.select().from(aiArtifacts).where(and(eq(aiArtifacts.workspaceId, id), eq(aiArtifacts.id, params.data.id))).limit(1).for('update'))[0];
      if (!artifact) return { error: 'AI_ARTIFACT_NOT_FOUND' } as const;
      const prior = (await tx.select().from(answerVersions).where(and(eq(answerVersions.workspaceId, id), sql`${answerVersions.aiProvenance}->>'artifactId' = ${artifact.id}`)).limit(1))[0];
      if (prior && prior.aiProvenance?.textHash === hash(body.data.text)) return { answer: prior };
      if (artifact.state !== 'PENDING_REVIEW' || artifact.revision !== body.data.expectedRevision) return { error: 'AI_REVIEW_CHANGED' } as const;
      const run = (await tx.select().from(aiRuns).where(and(eq(aiRuns.workspaceId, id), eq(aiRuns.id, artifact.runId))).limit(1))[0];
      const parsed = aiSourceSnapshotSchema.safeParse(run?.snapshot);
      if (!parsed.success || !parsed.data.question || run?.status !== 'SUCCEEDED') return { error: 'AI_ARTIFACT_NOT_AVAILABLE' } as const;
      const snapshot = parsed.data;
      const validated = validateAiOutput(artifact.output, snapshot, { workspaceId: id, operation: 'ANSWER_DRAFT', locale: snapshot.locale });
      if (!validated.ok || validated.output.operation !== 'ANSWER_DRAFT' || validated.output.result.status !== 'DRAFT') return { error: 'AI_ANSWER_NEEDS_USER_INPUT' } as const;
      const question = (await tx.select().from(answerVersions).where(and(eq(answerVersions.workspaceId, id), eq(answerVersions.id, snapshot.question!.questionId))).limit(1))[0];
      if (!question) return { error: 'AI_SOURCE_CHANGED' } as const;
      await lockKey(tx, answerLockKey(id, question));
      if (!(await checkCurrentAiSnapshot(tx, id, snapshot)).ok) return { error: 'AI_SOURCE_CHANGED' } as const;
      const inserted = (await tx.insert(answerVersions).values({
        workspaceId: id, semanticKey: question.semanticKey, questionText: question.questionText, jurisdiction: question.jurisdiction,
        questionScope: question.questionScope, reviewAfter: question.reviewAfter, revision: question.revision + 1,
        value: body.data.text, approvalStatus: 'UNANSWERED', strategy: 'DRAFT_FOR_REVIEW',
        aiProvenance: { artifactId: artifact.id, sourceFactIds: validated.output.result.evidence.map(item => item.factId), sourceSnapshotHash: snapshot.snapshotHash, textHash: hash(body.data.text), origin: body.data.text === validated.output.result.text ? 'AI' : 'AI_EDITED' },
      }).returning())[0]!;
      await tx.update(aiArtifacts).set({ state: 'ACCEPTED', revision: artifact.revision + 1, approvedAt: new Date(), approvedHash: hash(body.data.text) }).where(and(eq(aiArtifacts.workspaceId, id), eq(aiArtifacts.id, artifact.id)));
      return { answer: inserted };
    });
    return 'error' in result ? reply.code(result.error === 'AI_ARTIFACT_NOT_FOUND' ? 404 : 409).send(result) : reply.code(201).send(result.answer);
  });
}
