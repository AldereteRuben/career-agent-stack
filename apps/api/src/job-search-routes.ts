import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db, jobs, jobSearchSources, savedJobSearches, savedJobSearchMatches } from '@career/db';
import { type JobSearchInput, type OnPrepare, JobSearchError, matchesSearch, processPendingJobPreparations, refreshSavedJobSearch } from './job-search.js';
import { MAX_ARBEITNOW_PAGES, PROVIDERS, type PublicJob, type SearchWorkMode } from './job-search-sources.js';

const modes: SearchWorkMode[] = ['any', 'remote', 'hybrid', 'onsite'];
const frequencies = [6, 12, 24] as const;

function parseInput(value: unknown, partial = false): Partial<JobSearchInput> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>; const result: Partial<JobSearchInput> = {};
  const stringFields = ['role', 'company', 'location'] as const;
  for (const key of stringFields) {
    if (!(key in body) && partial) continue;
    const entry = body[key];
    if (entry === null) result[key] = null;
    else if (typeof entry === 'string') result[key] = entry.trim() ? entry.trim().slice(0, key === 'role' || key === 'company' ? 200 : 200) : null;
    else return null;
  }
  if ('workMode' in body || !partial) {
    if (typeof body.workMode !== 'string' || !modes.includes(body.workMode as SearchWorkMode)) return null;
    result.workMode = body.workMode as SearchWorkMode;
  }
  if ('frequencyHours' in body || !partial) {
    if (typeof body.frequencyHours !== 'number' || !frequencies.includes(body.frequencyHours as 6 | 12 | 24)) return null;
    result.frequencyHours = body.frequencyHours as 6 | 12 | 24;
  }
  for (const key of ['enabled', 'autoPrepare'] as const) {
    if (key in body || !partial) {
      if (typeof body[key] !== 'boolean') return null;
      result[key] = body[key];
    }
  }
  if ('language' in body || !partial) {
    if (body.language !== 'en' && body.language !== 'es') return null;
    result.language = body.language;
  }
  if (!partial && !result.role && !result.company) return null;
  return result;
}

function error(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, reason: string, status: number) {
  return reply.code(status).send({ error: reason });
}

export function registerJobSearchRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, onPrepare?: OnPrepare) {
  app.get('/api/v1/job-searches', async (request) => {
    const workspaceId = workspace(request);
    const rows = await db.select().from(savedJobSearches).where(eq(savedJobSearches.workspaceId, workspaceId)).orderBy(asc(savedJobSearches.createdAt));
    return { searches: rows, coverage: { providers: PROVIDERS, maxRefreshesPerProviderPerDay: 4, remotiveMaxRequestsPerDay: 4, arbeitnowMaxPagesPerRefresh: MAX_ARBEITNOW_PAGES, cacheHours: 6, sources: 'Public listings from Remotive and Arbeitnow; no employer links or API keys are required.' } };
  });

  app.post('/api/v1/job-searches', async (request, reply) => {
    const input = parseInput(request.body);
    if (!input) return error(reply, 'INVALID_INPUT', 400);
    const workspaceId = workspace(request);
    const created = (await db.insert(savedJobSearches).values({ workspaceId, ...input, nextRunAt: input.enabled ? new Date() : null }).returning())[0];
    if (!created) return error(reply, 'SAVE_FAILED', 500);
    let refresh = null;
    if (created.enabled) {
      try { refresh = await refreshSavedJobSearch(workspaceId, created.id, { initial: true }); }
      catch (cause) { if (!(cause instanceof JobSearchError && cause.status === 502)) throw cause; }
      if (onPrepare) await processPendingJobPreparations(onPrepare, 5);
    }
    const saved = (await db.select().from(savedJobSearches).where(and(eq(savedJobSearches.workspaceId, workspaceId), eq(savedJobSearches.id, created.id))).limit(1))[0];
    return reply.code(201).send({ search: saved ?? created, refresh });
  });

  app.patch('/api/v1/job-searches/:id', async (request, reply) => {
    const input = parseInput(request.body, true);
    if (!input || !Object.keys(input).length) return error(reply, 'INVALID_INPUT', 400);
    const workspaceId = workspace(request); const { id } = request.params as { id: string };
    const existing = (await db.select().from(savedJobSearches).where(and(eq(savedJobSearches.workspaceId, workspaceId), eq(savedJobSearches.id, id))).limit(1))[0];
    if (!existing) return error(reply, 'NOT_FOUND', 404);
    const nextRole = input.role === undefined ? existing.role : input.role; const nextCompany = input.company === undefined ? existing.company : input.company;
    if (!nextRole && !nextCompany) return error(reply, 'INVALID_INPUT', 400);
    const nextEnabled = input.enabled ?? existing.enabled;
    const criteriaChanged = input.role !== undefined || input.company !== undefined || input.location !== undefined || input.workMode !== undefined;
    const shouldRefresh = nextEnabled && (criteriaChanged || input.autoPrepare === true && !existing.autoPrepare || input.enabled === true && !existing.enabled);
    const nextRunAt = !nextEnabled ? null : shouldRefresh ? new Date() : input.frequencyHours !== undefined ? new Date(Date.now() + input.frequencyHours * 3_600_000) : existing.nextRunAt;
    const updated = (await db.update(savedJobSearches).set({ ...input, nextRunAt, updatedAt: new Date() }).where(and(eq(savedJobSearches.workspaceId, workspaceId), eq(savedJobSearches.id, id))).returning())[0];
    let refresh = null;
    if (shouldRefresh) {
      try { refresh = await refreshSavedJobSearch(workspaceId, id, { initial: true }); }
      catch (cause) { if (!(cause instanceof JobSearchError && cause.status === 502)) throw cause; }
      if (onPrepare) await processPendingJobPreparations(onPrepare, 5);
    }
    return { search: updated, refresh };
  });

  app.post('/api/v1/job-searches/:id/refresh', async (request, reply) => {
    const workspaceId = workspace(request); const { id } = request.params as { id: string };
    try {
      const refreshed = await refreshSavedJobSearch(workspaceId, id);
      if (onPrepare) await processPendingJobPreparations(onPrepare, 5);
      return refreshed;
    }
    catch (cause) {
      if (cause instanceof JobSearchError) return error(reply, cause.message, cause.status);
      throw cause;
    }
  });

  app.get('/api/v1/job-searches/:id/results', async (request, reply) => {
    const workspaceId = workspace(request); const { id } = request.params as { id: string };
    const search = (await db.select().from(savedJobSearches).where(and(eq(savedJobSearches.workspaceId, workspaceId), eq(savedJobSearches.id, id))).limit(1))[0];
    if (!search) return error(reply, 'NOT_FOUND', 404);
    const rows = await db.select({ job: jobs, match: savedJobSearchMatches, source: jobSearchSources }).from(savedJobSearchMatches)
      .innerJoin(jobs, and(eq(jobs.id, savedJobSearchMatches.jobId), eq(jobs.workspaceId, savedJobSearchMatches.workspaceId)))
      .leftJoin(jobSearchSources, and(eq(jobSearchSources.jobId, jobs.id), eq(jobSearchSources.workspaceId, jobs.workspaceId)))
      .where(and(eq(savedJobSearchMatches.workspaceId, workspaceId), eq(savedJobSearchMatches.searchId, id)))
      .orderBy(desc(savedJobSearchMatches.lastMatchedAt), asc(jobs.company));
    const itemById = new Map<string, { job: typeof rows[number]['job']; match: typeof rows[number]['match']; matchedAt: Date; unknownLocation: boolean; sources: Array<{ provider: string; name: string; url: string; postedAt: Date | null }> }>();
    for (const { job, match, source } of rows) {
      const mode = source?.raw.__careerStackWorkMode;
      const workMode = mode === 'remote' || mode === 'hybrid' || mode === 'onsite' ? mode : 'unknown';
      const result = matchesSearch({ title: job.title, company: job.company, location: job.location, workMode } as Pick<PublicJob, 'title' | 'company' | 'location' | 'workMode'>, { role: search.role, company: search.company, location: search.location, workMode: search.workMode as SearchWorkMode });
      if (!result.matched) continue;
      const item = itemById.get(job.id) ?? { job, match, matchedAt: match.matchedAt, unknownLocation: result.unknownLocation, sources: [] };
      if (source && (source.provider === 'remotive' || source.provider === 'arbeitnow') && !item.sources.some((existing) => existing.provider === source.provider && existing.url === source.sourceUrl)) item.sources.push({ provider: source.provider, name: PROVIDERS[source.provider].name, url: source.sourceUrl, postedAt: source.postedAt });
      itemById.set(job.id, item);
    }
    const filtered = [...itemById.values()];
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit ?? '20', 10) || 20));
    const offset = Math.max(0, Number.parseInt(query.offset ?? '0', 10) || 0);
    return { items: filtered.slice(offset, offset + limit).map(({ job, match, matchedAt, unknownLocation, sources }) => ({ ...job, matchedAt, unknownLocation, sources, autoPreparedAt: match.autoPreparedAt, autoPrepareError: match.autoPrepareError })), total: filtered.length };
  });
}
