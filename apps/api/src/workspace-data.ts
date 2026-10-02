import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { answerVersions, db, jobOccurrences, jobs, jobSnapshots, profileFacts, profileVersions, searchProfiles } from '@career/db';
import { computeJobMatch, hasTargetTitlesPreference, readIdentity, readPreferences, type JobMatch, type MatchingContext } from '@career/domain';

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Executor = typeof db | Tx;

/** Transaction-scoped advisory lock; released automatically at commit or rollback. */
export async function lockKey(tx: Tx, key: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
export const profileLockKey = (workspaceId: string) => `profile:${workspaceId}`;

export async function latestProfile(executor: Executor, workspaceId: string) {
  return (await executor.select().from(profileVersions).where(eq(profileVersions.workspaceId, workspaceId)).orderBy(desc(profileVersions.revision)).limit(1))[0];
}

export async function latestFacts(executor: Executor, workspaceId: string, profileVersionId: string | undefined) {
  if (!profileVersionId) return [];
  return executor.select().from(profileFacts).where(and(eq(profileFacts.workspaceId, workspaceId), eq(profileFacts.profileVersionId, profileVersionId))).orderBy(desc(profileFacts.createdAt));
}

/** Current approved facts plus profile.preferences. Legacy search-profile titles apply only when the profile never stored targetTitles; an explicit [] means "no targets". */
export async function loadMatchingContext(executor: Executor, workspaceId: string): Promise<MatchingContext> {
  const profile = await latestProfile(executor, workspaceId);
  const facts = profile ? await executor.select().from(profileFacts).where(and(eq(profileFacts.workspaceId, workspaceId), eq(profileFacts.profileVersionId, profile.id), eq(profileFacts.approvalStatus, 'USER_APPROVED'))) : [];
  const preferences = readPreferences(profile?.profile ?? {});
  let targetTitles = preferences.targetTitles;
  if (!hasTargetTitlesPreference(profile?.profile ?? {})) {
    const legacy = await executor.select({ targetTitles: searchProfiles.targetTitles }).from(searchProfiles).where(eq(searchProfiles.workspaceId, workspaceId)).orderBy(desc(searchProfiles.updatedAt)).limit(1);
    targetTitles = (legacy[0]?.targetTitles ?? []).filter((title) => typeof title === 'string' && title.trim()).slice(0, 30);
  }
  return {
    evidence: facts.map((fact) => ({ id: fact.id, text: fact.statement, tags: fact.tags, approval: 'USER_APPROVED' as const })),
    targetTitles, workModes: preferences.workModes, country: readIdentity(profile?.profile ?? {}).country || null,
    // Work authorization is jurisdiction-specific and never inferred (implementation brief, answer semantics).
    authorizationKnown: false,
    profileRevision: profile?.revision ?? 1,
  };
}

/** Reasons that describe how a job entered the workspace rather than the match, kept across recalculation. */
const stickyReasons = new Set(['MANUAL_IMPORT_REVIEW_REQUIRED']);

type JobRow = typeof jobs.$inferSelect;
export type ScoredJob = JobRow & { provisional: boolean; match: JobMatch['match'] };

export async function latestDescriptions(executor: Executor, workspaceId: string, jobIds: string[]) {
  if (!jobIds.length) return new Map<string, string | null>();
  const rows = await executor.selectDistinctOn([jobSnapshots.jobId], { jobId: jobSnapshots.jobId, descriptionText: jobSnapshots.descriptionText })
    .from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, workspaceId), inArray(jobSnapshots.jobId, jobIds))).orderBy(jobSnapshots.jobId, desc(jobSnapshots.fetchedAt));
  return new Map(rows.map((row) => [row.jobId, row.descriptionText]));
}

export function applyMatch(job: JobRow, description: string | null, context: MatchingContext): ScoredJob {
  const result = computeJobMatch({ title: job.title, location: job.location, description }, context);
  const sticky = job.reasons.filter((reason) => stickyReasons.has(reason));
  return { ...job, fitScore: result.fitScore, evidenceCoverage: result.evidenceCoverage, eligibility: result.eligibility, reasons: [...new Set([...result.reasons, ...sticky])], provisional: result.provisional, match: result.match };
}

/** Scores jobs against the current context with one snapshot query (no per-job lookups). */
export async function scoreJobs(executor: Executor, workspaceId: string, rows: JobRow[], context?: MatchingContext): Promise<ScoredJob[]> {
  if (!rows.length) return [];
  const ctx = context ?? await loadMatchingContext(executor, workspaceId);
  const descriptions = await latestDescriptions(executor, workspaceId, rows.map((row) => row.id));
  return rows.map((row) => applyMatch(row, descriptions.get(row.id) ?? null, ctx));
}

const sameReasons = (a: string[], b: string[]) => a.length === b.length && a.every((reason, index) => reason === b[index]);

/** Persists recalculated scores for every job in the workspace using a single bulk UPDATE for the rows that changed. */
export async function rescoreWorkspaceJobs(executor: Executor, workspaceId: string) {
  const rows = await executor.select().from(jobs).where(eq(jobs.workspaceId, workspaceId));
  const scored = await scoreJobs(executor, workspaceId, rows);
  const changed = scored.filter((job, index) => {
    const before = rows[index]!;
    return before.fitScore !== job.fitScore || before.evidenceCoverage !== job.evidenceCoverage || before.eligibility !== job.eligibility || !sameReasons(before.reasons, job.reasons);
  });
  if (!changed.length) return { total: rows.length, updated: 0 };
  const ids = changed.map((job) => job.id);
  const scores = changed.map((job) => job.fitScore);
  const coverage = changed.map((job) => job.evidenceCoverage);
  const eligibility = changed.map((job) => job.eligibility);
  const reasons = changed.map((job) => JSON.stringify(job.reasons));
  await executor.execute(sql`
    update ${jobs} set fit_score = v.fit_score, evidence_coverage = v.evidence_coverage, eligibility = v.eligibility, reasons = v.reasons::jsonb
    from (select unnest(${sql.param(ids)}::uuid[]) as id, unnest(${sql.param(scores)}::int[]) as fit_score, unnest(${sql.param(coverage)}::int[]) as evidence_coverage, unnest(${sql.param(eligibility)}::varchar[]) as eligibility, unnest(${sql.param(reasons)}::text[]) as reasons) as v
    where ${jobs.id} = v.id and ${jobs.workspaceId} = ${workspaceId}`);
  return { total: rows.length, updated: changed.length };
}

export async function occurrencesForBoard(executor: Executor, workspaceId: string, board: { provider: 'greenhouse' | 'lever' | 'ashby'; region: string; tenant: string }) {
  const rows = await executor.select().from(jobOccurrences).where(and(eq(jobOccurrences.workspaceId, workspaceId), eq(jobOccurrences.provider, board.provider), eq(jobOccurrences.region, board.region), eq(jobOccurrences.tenant, board.tenant)));
  return new Map(rows.map((row) => [row.externalJobId, row]));
}

type AnswerRow = typeof answerVersions.$inferSelect;
/** Latest revision per (semanticKey, jurisdiction, questionScope); older revisions stay in the table for history and export. */
export async function latestAnswers(executor: Executor, workspaceId: string): Promise<AnswerRow[]> {
  const rows = await executor.selectDistinctOn([answerVersions.semanticKey, answerVersions.jurisdiction, answerVersions.questionScope]).from(answerVersions)
    .where(eq(answerVersions.workspaceId, workspaceId)).orderBy(answerVersions.semanticKey, answerVersions.jurisdiction, answerVersions.questionScope, desc(answerVersions.revision));
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}
export const answerLockKey = (workspaceId: string, answer: { semanticKey: string; jurisdiction: string; questionScope: string }) => `answer:${workspaceId}:${answer.semanticKey}:${answer.jurisdiction}:${answer.questionScope}`;
