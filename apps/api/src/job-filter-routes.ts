import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db, jobFilterOverrides, jobFilterPreferences, jobs } from '@career/db';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

export type JobFilterPreferences = { excludedCompanies: string[]; requiredTerms: string[]; excludedTerms: string[] };
export const emptyJobFilterPreferences: JobFilterPreferences = { excludedCompanies: [], requiredTerms: [], excludedTerms: [] };
const keys = Object.keys(emptyJobFilterPreferences) as Array<keyof JobFilterPreferences>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseJobFilterPreferences(value: unknown): JobFilterPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.includes(key as keyof JobFilterPreferences))) return null;
  const parsed = {} as JobFilterPreferences;
  for (const key of keys) {
    const entries = input[key] ?? [];
    if (!Array.isArray(entries) || entries.length > 50 || entries.some((entry) => typeof entry !== 'string' || entry.trim().length > 100)) return null;
    const unique = new Map<string, string>();
    for (const entry of entries as string[]) { const cleaned = entry.trim(); const normalized = normalizeFilter(cleaned); if (normalized && !unique.has(normalized)) unique.set(normalized, cleaned); }
    parsed[key] = [...unique.values()];
  }
  return parsed;
}

export function normalizeFilter(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

export function evaluateJobFilters(job: { company: string; title: string; description?: string | null }, preferences: JobFilterPreferences) {
  const company = normalizeFilter(job.company);
  const haystack = normalizeFilter(`${job.title} ${job.company} ${job.description ?? ''}`);
  const excludedCompany = preferences.excludedCompanies.find((entry) => normalizeFilter(entry) === company) ?? null;
  const missingRequiredTerms = preferences.requiredTerms.filter((entry) => !containsPhrase(haystack, normalizeFilter(entry)));
  const matchedExcludedTerms = preferences.excludedTerms.filter((entry) => containsPhrase(haystack, normalizeFilter(entry)));
  return {
    excluded: Boolean(excludedCompany || missingRequiredTerms.length || matchedExcludedTerms.length),
    reasons: { excludedCompany, missingRequiredTerms, matchedExcludedTerms },
  };
}

/** SQL predicate shared by the discovered-job list; result paging happens after the rules are applied. */
export function jobFilterExclusionSql(preferences: JobFilterPreferences, workspaceId: string): SQL {
  const prefs = sql`${JSON.stringify(preferences)}::jsonb`;
  const normalizeSql = (value: SQLWrapper) => sql`trim(regexp_replace(lower(normalize(${value}, NFKD)), U&'[\\0300-\\036f]', '', 'g'))`;
  const wordsSql = (value: SQLWrapper) => sql`trim(regexp_replace(${normalizeSql(value)}, '[^[:alnum:]]+',' ','g'))`;
  const company = wordsSql(sql`jobs.company`);
  const text = wordsSql(sql`concat_ws(' ',jobs.title,jobs.company,(SELECT description_text FROM job_snapshots WHERE workspace_id=${workspaceId} AND job_id=jobs.id ORDER BY fetched_at DESC,id DESC LIMIT 1))`);
  const companyExcluded = sql`EXISTS(SELECT 1 FROM jsonb_array_elements_text(${prefs}->'excludedCompanies') AS terms(value) WHERE ${company}=${wordsSql(sql`terms.value`)})`;
  const requiredMissing = sql`EXISTS(SELECT 1 FROM jsonb_array_elements_text(${prefs}->'requiredTerms') AS terms(value) WHERE position(' '||${wordsSql(sql`terms.value`)}||' ' IN ' '||${text}||' ')=0)`;
  const excludedTerm = sql`EXISTS(SELECT 1 FROM jsonb_array_elements_text(${prefs}->'excludedTerms') AS terms(value) WHERE position(' '||${wordsSql(sql`terms.value`)}||' ' IN ' '||${text}||' ')>0)`;
  return sql`(${companyExcluded} OR ${requiredMissing} OR ${excludedTerm})`;
}

function containsPhrase(haystack: string, phrase: string) {
  return Boolean(phrase) && (` ${haystack} `).includes(` ${phrase} `);
}

export function registerJobFilterRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string) {
  app.get('/api/v1/job-filters', async (request) => {
    const row = (await db.select().from(jobFilterPreferences).where(eq(jobFilterPreferences.workspaceId, workspace(request))).limit(1))[0];
    return row?.preferences ?? emptyJobFilterPreferences;
  });

  app.put('/api/v1/job-filters', async (request, reply) => {
    const body = request.body as { preferences?: unknown } | null;
    const preferences = parseJobFilterPreferences(body?.preferences);
    if (!preferences) return reply.code(400).send({ error: 'INVALID_JOB_FILTER_PREFERENCES' });
    const workspaceId = workspace(request);
    const row = (await db.insert(jobFilterPreferences).values({ workspaceId, preferences }).onConflictDoUpdate({
      target: jobFilterPreferences.workspaceId,
      set: { preferences, updatedAt: new Date() },
    }).returning())[0]!;
    return row.preferences;
  });

  app.post('/api/v1/job-filters/:jobId/restore', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    if (!uuid.test(jobId)) return reply.code(404).send({ error: 'NOT_FOUND' });
    const workspaceId = workspace(request);
    const exists = (await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.id, jobId))).limit(1))[0];
    if (!exists) return reply.code(404).send({ error: 'NOT_FOUND' });
    await db.insert(jobFilterOverrides).values({ workspaceId, jobId }).onConflictDoNothing();
    return { ok: true };
  });

  app.delete('/api/v1/job-filters/:jobId/restore', async (request, reply) => {
    const { jobId } = request.params as { jobId: string };
    if (!uuid.test(jobId)) return reply.code(404).send({ error: 'NOT_FOUND' });
    await db.delete(jobFilterOverrides).where(and(eq(jobFilterOverrides.workspaceId, workspace(request)), eq(jobFilterOverrides.jobId, jobId)));
    return { ok: true };
  });
}
