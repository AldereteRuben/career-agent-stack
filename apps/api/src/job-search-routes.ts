import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { pool, db, jobs, jobSearchProviderCache, jobSearchSources, savedJobSearches, savedJobSearchMatches } from '@career/db';
import { type JobSearchInput, type OnPrepare, JobSearchError, matchesSearch, processPendingJobPreparations, refreshSavedJobSearch } from './job-search.js';
import { MAX_ARBEITNOW_PAGES, PROVIDERS, type PublicJob, type SearchWorkMode } from './job-search-sources.js';

import { enqueueSearch, latestSearchRun, SEARCH_PROVIDERS } from './search-execution.js';
import { searchResults, searchUnreadCounts, reviewSearchResult, type ResultQuery } from './search-results.js';
import { withEffectiveSeenAt } from './review-state.js';

type SearchInput = JobSearchInput & { matcherVersion: number; providerIds: string[]; includeRelated: boolean; idempotencyKey: string; expectedRevision: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const modes: SearchWorkMode[] = ['any', 'remote', 'hybrid', 'onsite'];
const frequencies = [6, 12, 24] as const;

function parseInput(value: unknown, partial = false): Partial<SearchInput> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>; const result: Partial<SearchInput> = {};
  const stringFields = ['role', 'company', 'location'] as const;
  for (const key of stringFields) {
    if (!(key in body) && partial) continue;
    const entry = body[key];
    if (entry === null) result[key] = null;
    else if (typeof entry === 'string' && entry.trim().length <= 200) result[key] = entry.trim() || null;
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
  if ('matcherVersion' in body) { if (body.matcherVersion !== 1 && body.matcherVersion !== 2) return null; result.matcherVersion = body.matcherVersion; }
  if ('providerIds' in body) { if (!Array.isArray(body.providerIds) || !body.providerIds.length || body.providerIds.length > 4 || body.providerIds.some((p) => !SEARCH_PROVIDERS.includes(p))) return null; result.providerIds = [...new Set(body.providerIds)]; }
  if ('includeRelated' in body) { if (typeof body.includeRelated !== 'boolean') return null; result.includeRelated = body.includeRelated; }
  if ('expectedRevision' in body) { if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) return null; result.expectedRevision = Number(body.expectedRevision); }
  if ('idempotencyKey' in body) { if (typeof body.idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.idempotencyKey)) return null; result.idempotencyKey = body.idempotencyKey; }
  if (!partial && !result.role && !result.company) return null;
  return result;
}

function error(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, reason: string, status: number) {
  return reply.code(status).send({ error: reason });
}

export function registerJobSearchRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, onPrepare?: OnPrepare) {
  app.get('/api/v1/job-searches', async (request) => {
    const workspaceId = workspace(request);
    const [unread, rows, feeds] = await Promise.all([
      searchUnreadCounts(workspaceId),
      db.select().from(savedJobSearches).where(eq(savedJobSearches.workspaceId, workspaceId)).orderBy(asc(savedJobSearches.createdAt)),
      db.select({ provider: jobSearchProviderCache.provider, listings: sql<number>`jsonb_array_length(${jobSearchProviderCache.payload})`, coverage: jobSearchProviderCache.coverage, fetchedAt: jobSearchProviderCache.fetchedAt, lastError: jobSearchProviderCache.lastError }).from(jobSearchProviderCache),
    ]);
    return { searches: await Promise.all(rows.map(async (row) => ({ ...row, lastNewCount: unread.get(row.id) ?? 0, latestRun: row.matcherVersion === 2 ? await latestSearchRun(workspaceId,row.id) : null }))), coverage: { providers: {...PROVIDERS,himalayas:{name:'Himalayas',attribution:'https://himalayas.app',cacheHours:24,maxPages:3,maxRequestsPerDay:100},boards:{name:'Followed companies',localSnapshotsOnly:true}}, feeds, maxRefreshesPerProviderPerDay: 4, remotiveMaxRequestsPerDay: 4, arbeitnowMaxPagesPerRefresh: MAX_ARBEITNOW_PAGES, cacheHours: 6, sources: 'Public listings from Remotive, Arbeitnow and Himalayas, plus local snapshots from confirmed followed companies; no API keys are required.' } };
  });

  app.post('/api/v1/job-searches', async (request, reply) => {
    const input = parseInput(request.body);
    if (!input) return error(reply, 'INVALID_INPUT', 400);
    const workspaceId = workspace(request);
    if (input.matcherVersion === 2) {
      if (!input.idempotencyKey || !input.providerIds?.length) return error(reply,'INVALID_INPUT',400);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const created = (await client.query(`INSERT INTO saved_job_searches(workspace_id,role,company,location,work_mode,frequency_hours,enabled,auto_prepare,language,matcher_version,provider_ids,include_related,idempotency_key,next_run_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,2,$10::jsonb,$11,$12,CASE WHEN $7 THEN now() ELSE NULL END)
          ON CONFLICT(workspace_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
          [workspaceId,input.role,input.company,input.location,input.workMode,input.frequencyHours,input.enabled,input.autoPrepare,input.language,JSON.stringify(input.providerIds),input.includeRelated ?? false,input.idempotencyKey])).rows[0];
        const prior = created ?? (await client.query('SELECT * FROM saved_job_searches WHERE workspace_id=$1 AND idempotency_key=$2',[workspaceId,input.idempotencyKey])).rows[0];
        if (!created) {
          const same = prior.role===input.role && prior.company===input.company && prior.location===input.location && prior.work_mode===input.workMode
            && prior.frequency_hours===input.frequencyHours && prior.enabled===input.enabled && prior.auto_prepare===input.autoPrepare
            && prior.language===input.language && prior.include_related===(input.includeRelated ?? false)
            && JSON.stringify([...prior.provider_ids].sort())===JSON.stringify([...input.providerIds].sort());
          if (!same) { await client.query('ROLLBACK'); return error(reply,'IDEMPOTENCY_CONFLICT',409); }
        }
        const runId = created && input.enabled ? await enqueueSearch(client,workspaceId,prior.id) : (await client.query('SELECT id FROM search_runs WHERE workspace_id=$1 AND search_id=$2 ORDER BY created_at DESC LIMIT 1',[workspaceId,prior.id])).rows[0]?.id ?? null;
        await client.query('COMMIT');
        const search = (await db.select().from(savedJobSearches).where(and(eq(savedJobSearches.workspaceId,workspaceId),eq(savedJobSearches.id,prior.id))))[0];
        return reply.code(201).send({search,runId,refresh:null});
      } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
    }
    if (input.includeRelated === true || input.providerIds?.some(provider => !['remotive','arbeitnow'].includes(provider))) return error(reply,'INVALID_INPUT',400);
    const legacyInput = {...input}; delete legacyInput.expectedRevision; delete legacyInput.idempotencyKey;
    const created = (await db.insert(savedJobSearches).values({ workspaceId, ...legacyInput, nextRunAt: input.enabled ? new Date() : null }).returning())[0];
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
    if (!uuid.test(id)) return error(reply,'NOT_FOUND',404);
    const existing = (await db.select().from(savedJobSearches).where(and(eq(savedJobSearches.workspaceId, workspaceId), eq(savedJobSearches.id, id))).limit(1))[0];
    if (!existing) return error(reply, 'NOT_FOUND', 404);
    if (existing.matcherVersion === 2 || input.matcherVersion === 2) {
      if (input.matcherVersion === 1 || input.expectedRevision !== existing.revision) return error(reply,'REVISION_CONFLICT',409);
      const merged = { ...existing, ...input };
      if ((!merged.role && !merged.company) || !merged.providerIds.length) return error(reply,'INVALID_INPUT',400);
      // Changing criteria never silently expands previously granted automatic preparation.
      const criteriaChanged = ['role','company','location','workMode','providerIds','includeRelated','matcherVersion'].some((key) => key in input && JSON.stringify(input[key as keyof SearchInput]) !== JSON.stringify(existing[key as keyof typeof existing]));
      const autoPrepare = criteriaChanged && input.autoPrepare !== true ? false : merged.autoPrepare;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const changed = await client.query(`UPDATE saved_job_searches SET role=$4,company=$5,location=$6,work_mode=$7,frequency_hours=$8,enabled=$9,auto_prepare=$10,language=$11,
          matcher_version=2,provider_ids=$12::jsonb,include_related=$13,revision=revision+1,next_run_at=CASE WHEN $9 THEN now() ELSE NULL END,updated_at=now()
          WHERE workspace_id=$1 AND id=$2 AND revision=$3 RETURNING id`,[workspaceId,id,input.expectedRevision,merged.role,merged.company,merged.location,merged.workMode,merged.frequencyHours,merged.enabled,autoPrepare,merged.language,JSON.stringify(merged.providerIds),merged.includeRelated]);
        if (!changed.rowCount) { await client.query('ROLLBACK'); return error(reply,'REVISION_CONFLICT',409); }
        await client.query(`UPDATE search_runs SET status='CANCELLED',finished_at=now(),owner=NULL,lease_until=NULL WHERE workspace_id=$1 AND search_id=$2 AND finished_at IS NULL`,[workspaceId,id]);
        const runId = merged.enabled ? await enqueueSearch(client,workspaceId,id) : null;
        await client.query('COMMIT');
        const search = (await db.select().from(savedJobSearches).where(and(eq(savedJobSearches.workspaceId,workspaceId),eq(savedJobSearches.id,id))))[0];
        return {search,runId,refresh:null};
      } catch (cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
    }
    if (input.includeRelated === true || input.providerIds && JSON.stringify([...input.providerIds].sort()) !== JSON.stringify([...existing.providerIds].sort())) return error(reply,'INVALID_INPUT',400);
    const expectedRevision=input.expectedRevision;
    if (expectedRevision !== undefined && expectedRevision !== existing.revision) return error(reply,'REVISION_CONFLICT',409);
    delete input.expectedRevision; delete input.idempotencyKey;
    const nextRole = input.role === undefined ? existing.role : input.role; const nextCompany = input.company === undefined ? existing.company : input.company;
    if (!nextRole && !nextCompany) return error(reply, 'INVALID_INPUT', 400);
    const nextEnabled = input.enabled ?? existing.enabled;
    const criteriaChanged = input.role !== undefined || input.company !== undefined || input.location !== undefined || input.workMode !== undefined;
    const shouldRefresh = nextEnabled && (criteriaChanged || input.autoPrepare === true && !existing.autoPrepare || input.enabled === true && !existing.enabled);
    const nextRunAt = !nextEnabled ? null : shouldRefresh ? new Date() : input.frequencyHours !== undefined ? new Date(Date.now() + input.frequencyHours * 3_600_000) : existing.nextRunAt;
    const updated = (await db.update(savedJobSearches).set({ ...input, nextRunAt, revision: sql`${savedJobSearches.revision}+1`, updatedAt: new Date() }).where(and(eq(savedJobSearches.workspaceId, workspaceId), eq(savedJobSearches.id, id), eq(savedJobSearches.revision,existing.revision))).returning())[0];
    if (!updated) return error(reply,'REVISION_CONFLICT',409);
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
    if (!uuid.test(id)) return error(reply,'NOT_FOUND',404);
    const search = (await db.select().from(savedJobSearches).where(and(eq(savedJobSearches.workspaceId,workspaceId),eq(savedJobSearches.id,id))))[0];
    if (search?.matcherVersion === 2) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const runId=await enqueueSearch(client,workspaceId,id,true); await client.query('COMMIT'); return reply.code(202).send({runId}); }
      catch(cause) { await client.query('ROLLBACK'); throw cause; } finally { client.release(); }
    }
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

  app.get('/api/v1/job-searches/results', async (request) => searchResults(workspace(request),null,request.query as ResultQuery));
  app.post('/api/v1/job-searches/:id/results/:jobId/review', async (request,reply) => {
    const {id,jobId}=request.params as {id:string;jobId:string};
    if ((id!=='all' && !uuid.test(id)) || !uuid.test(jobId)) return error(reply,'NOT_FOUND',404);
    return await reviewSearchResult(workspace(request),id==='all'?null:id,jobId) ? {ok:true} : error(reply,'NOT_FOUND',404);
  });
  app.get('/api/v1/job-searches/:id/results', async (request, reply) => {
    const workspaceId = workspace(request); const { id } = request.params as { id: string };
    if (!uuid.test(id)) return error(reply,'NOT_FOUND',404);
    const search = (await db.select().from(savedJobSearches).where(and(eq(savedJobSearches.workspaceId, workspaceId), eq(savedJobSearches.id, id))).limit(1))[0];
    if (!search) return error(reply, 'NOT_FOUND', 404);
    if (search.matcherVersion === 2 || 'view' in (request.query as object) || 'sort' in (request.query as object)) return searchResults(workspaceId,id,request.query as ResultQuery);
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
    const page = filtered.slice(offset, offset + limit);
    const reviewed = new Map((await withEffectiveSeenAt(db, workspaceId, page.map(({ job }) => job))).map((job) => [job.id, job.seenAt]));
    return { items: page.map(({ job, match, matchedAt, unknownLocation, sources }) => ({ ...job, seenAt: reviewed.get(job.id) ?? null, matchedAt, unknownLocation, sources, autoPreparedAt: match.autoPreparedAt, autoPrepareError: match.autoPrepareError })), total: filtered.length };
  });
}
