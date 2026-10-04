import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { aiArtifacts, aiRuns, type answerVersions } from '@career/db';
import { aiSourceSnapshotSchema } from '@career/domain';
import { latestAnswers, type Executor } from '../workspace-data.js';
import { loadAiSourceRecords } from './source-reader.js';
import { checkAiSourceCurrent } from './source-snapshot.js';
const hash=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');

/** Approval checks the saved wording and its supporting facts, while allowing the new answer revision itself. */
export async function aiAnswerCurrent(executor: Executor, workspaceId: string, answer: typeof answerVersions.$inferSelect) {
  if (answer.workspaceId !== workspaceId) return false;
  if (!answer.aiProvenance) return true;
  const provenance = z.object({ artifactId: z.uuid(), sourceSnapshotHash: z.string(), textHash: z.string() }).passthrough().safeParse(answer.aiProvenance);
  if (!provenance.success || typeof answer.value !== 'string' || hash(answer.value) !== provenance.data.textHash) return false;
  const artifact = (await executor.select().from(aiArtifacts).where(and(eq(aiArtifacts.workspaceId, workspaceId), eq(aiArtifacts.id, provenance.data.artifactId))).limit(1))[0];
  if (!artifact || artifact.state !== 'ACCEPTED' || artifact.approvedHash !== provenance.data.textHash) return false;
  const run = (await executor.select().from(aiRuns).where(and(eq(aiRuns.workspaceId, workspaceId), eq(aiRuns.id, artifact.runId))).limit(1))[0];
  const snapshot = aiSourceSnapshotSchema.safeParse(run?.snapshot);
  if (run?.status !== 'SUCCEEDED' || !snapshot.success || snapshot.data.operation !== 'ANSWER_DRAFT' || !snapshot.data.question || snapshot.data.snapshotHash !== provenance.data.sourceSnapshotHash) return false;
  const records = await loadAiSourceRecords(executor, workspaceId, snapshot.data);
  records.question = { id: snapshot.data.question.questionId, workspaceId, questionText: answer.questionText, jurisdiction: answer.jurisdiction, questionScope: answer.questionScope };
  return checkAiSourceCurrent(snapshot.data, workspaceId, records).ok;
}


/** No approval flag is cleared in storage. Stale AI text is excluded whenever a preparation reuses saved answers. */
export async function latestReusableAnswers(executor: Executor, workspaceId: string) {
  const rows=await latestAnswers(executor,workspaceId);
  const usable: typeof rows=[];
  for (const answer of rows) {
    if (!answer.aiProvenance || (answer.approvalStatus==='USER_APPROVED' && await aiAnswerCurrent(executor,workspaceId,answer))) usable.push(answer);
  }
  return usable;
}
