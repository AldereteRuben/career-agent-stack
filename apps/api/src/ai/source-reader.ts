import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { jobs, jobSnapshots, profileFacts, type db } from '@career/db';
import { aiSourceSnapshotSchema, type AiSourceSnapshot } from '@career/domain';
import { latestAnswers, latestFacts, latestProfile, lockKey, profileLockKey, type Executor } from '../workspace-data.js';
import { hashAiInputContent } from './prompts.js';
import {
  AiSourceError, buildAiSourceSnapshot, checkAiSourceCurrent, parseAiSourceRequest,
  type AiCurrentSources, type AiFactSource, type AiSourceRecords, type AiSourceRequest,
} from './source-snapshot.js';

export class AiSourceReadError extends Error {
  readonly code = 'AI_SOURCE_UNAVAILABLE';
  constructor() { super('AI_SOURCE_UNAVAILABLE'); this.name = 'AiSourceReadError'; }
}
type Database = Pick<typeof db, 'transaction'>;
const databaseId = z.string().uuid();
type Selection = { factIds: string[]; jobId: string | null; questionId: string | null; profile: boolean; historical: boolean };

function selection(workspaceId: string, input: AiSourceRequest | AiSourceSnapshot): Selection {
  if (!databaseId.safeParse(workspaceId).success) throw new AiSourceError('AI_INVALID_REQUEST');
  if (input && typeof input === 'object' && 'schemaVersion' in input) {
    const parsed = aiSourceSnapshotSchema.safeParse(input);
    if (!parsed.success) throw new AiSourceError('AI_SOURCE_INVALID');
    const snapshot = parsed.data;
    if (snapshot.workspaceId !== workspaceId || snapshot.snapshotHash !== hashAiInputContent(snapshot)) throw new AiSourceError('AI_SOURCE_CHANGED');
    const selectedIds = [...snapshot.facts.map((fact) => fact.factId), ...(snapshot.job ? [snapshot.job.jobId] : []), ...(snapshot.question ? [snapshot.question.questionId] : [])];
    if (selectedIds.some((id) => !databaseId.safeParse(id).success)) throw new AiSourceError('AI_SOURCE_INVALID');
    return { factIds: snapshot.facts.map((fact) => fact.factId), jobId: snapshot.job?.jobId ?? null, questionId: snapshot.question?.questionId ?? null, profile: Boolean(snapshot.facts.length || snapshot.identityFingerprint), historical: true };
  }
  const request = parseAiSourceRequest(input);
  return {
    factIds: 'selectedFactIds' in request ? request.selectedFactIds : [], jobId: 'jobId' in request ? request.jobId ?? null : null,
    questionId: request.operation === 'ANSWER_DRAFT' ? request.questionId : null,
    profile: request.operation === 'RESUME_DRAFT' || ('selectedFactIds' in request && request.selectedFactIds.length > 0), historical: false,
  };
}

const factRecord = (fact: typeof profileFacts.$inferSelect): AiFactSource => ({
  id: fact.id, workspaceId: fact.workspaceId, profileVersionId: fact.profileVersionId, kind: fact.kind,
  statement: fact.statement, details: fact.details, tags: fact.tags, source: fact.source, approvalStatus: fact.approvalStatus, createdAt: fact.createdAt,
});

/**
 * All queries are workspace scoped. Use inside a consistent, short caller-owned transaction when a snapshot/currentness
 * decision must be atomic with another write. Returned records are internal data, not an HTTP response or provider input.
 */
export async function loadAiSourceRecords(executor: Executor, workspaceId: string, requestOrSnapshot: AiSourceRequest | AiSourceSnapshot): Promise<AiSourceRecords> {
  const selected = selection(workspaceId, requestOrSnapshot);
  try {
    const [profile, jobRows, postingRows, answers] = [
      selected.profile ? await latestProfile(executor, workspaceId) : undefined,
      selected.jobId ? await executor.select({ id: jobs.id, workspaceId: jobs.workspaceId, title: jobs.title, company: jobs.company, location: jobs.location }).from(jobs)
        .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.id, selected.jobId))).limit(1) : [],
      selected.jobId ? await executor.select({ id: jobSnapshots.id, workspaceId: jobSnapshots.workspaceId, jobId: jobSnapshots.jobId, title: jobSnapshots.title, descriptionText: jobSnapshots.descriptionText }).from(jobSnapshots)
        .where(and(eq(jobSnapshots.workspaceId, workspaceId), eq(jobSnapshots.jobId, selected.jobId))).orderBy(desc(jobSnapshots.fetchedAt), desc(jobSnapshots.id)).limit(1) : [],
      selected.questionId ? await latestAnswers(executor, workspaceId) : [],
    ] as const;
    const current = profile ? await latestFacts(executor, workspaceId, profile.id) : [];
    const approved = current.filter((fact) => fact.approvalStatus === 'USER_APPROVED');
    const facts = approved.filter((fact) => selected.historical || selected.factIds.includes(fact.id)).map(factRecord);
    const missingIds = selected.historical ? selected.factIds.filter((id) => !facts.some((fact) => fact.id === id)) : [];
    const historical = missingIds.length ? await executor.select().from(profileFacts)
      .where(and(eq(profileFacts.workspaceId, workspaceId), inArray(profileFacts.id, missingIds))) : [];
    const question = answers.find((answer) => answer.id === selected.questionId);
    return {
      ...(selected.profile ? { profile: profile ? { id: profile.id, workspaceId: profile.workspaceId, revision: profile.revision, profile: profile.profile } : null, facts } : {}),
      ...(selected.jobId ? { job: jobRows[0] ?? null, jobSnapshot: postingRows[0] ?? null } : {}),
      ...(selected.questionId ? { question: question ? { id: question.id, workspaceId: question.workspaceId, questionText: question.questionText, jurisdiction: question.jurisdiction, questionScope: question.questionScope } : null } : {}),
      ...(selected.historical ? { historicalFacts: historical.map(factRecord) } : {}),
    };
  } catch (error) {
    if (error instanceof AiSourceError || error instanceof AiSourceReadError) throw error;
    throw new AiSourceReadError();
  }
}

/** Consistent input copy only. This transaction ends before any model or provider operation begins. */
export async function createCurrentAiSnapshot(database: Database, workspaceId: string, requestInput: unknown): Promise<AiSourceSnapshot> {
  const request = parseAiSourceRequest(requestInput);
  if (!databaseId.safeParse(workspaceId).success) throw new AiSourceError('AI_INVALID_REQUEST');
  try {
    return await database.transaction(async (tx) => {
      await lockKey(tx, profileLockKey(workspaceId));
      const records = await loadAiSourceRecords(tx, workspaceId, request);
      return buildAiSourceSnapshot(workspaceId, request, records);
    }, { isolationLevel: 'repeatable read', accessMode: 'read write' });
  } catch (error) {
    if (error instanceof AiSourceError || error instanceof AiSourceReadError) throw error;
    throw new AiSourceReadError();
  }
}

/**
 * Reuse within the caller's finalization/approval transaction, while holding the profile lock and relevant source locks.
 * Does not open or commit a nested transaction. The caller must still validate live consent, account, lease and output.
 */
export async function checkCurrentAiSnapshot(executor: Executor, workspaceId: string, snapshot: AiSourceSnapshot): Promise<AiCurrentSources> {
  try { return checkAiSourceCurrent(snapshot, workspaceId, await loadAiSourceRecords(executor, workspaceId, snapshot)); }
  catch (error) {
    if (error instanceof AiSourceError) return { ok: false, code: error.code };
    throw error;
  }
}
