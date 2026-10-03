import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@career/db/schema';
import { db, jobs, jobSearchProviderCache, jobSearchSources, jobSnapshots, pool, savedJobSearches, savedJobSearchMatches } from '@career/db';
import { JOB_SEARCH_INTERVAL_MS, JOB_SEARCH_PROVIDER_COOLDOWN_MS, JOB_SEARCH_FAILURE_MAX_MS } from './job-search-constants.js';
import { PROVIDERS, type JobSearchProvider, type PublicJob, type SearchWorkMode, ProviderReadError, readPublicFeed, type ProviderFeed } from './job-search-sources.js';

export type JobSearchInput = {
  role: string | null;
  company: string | null;
  location: string | null;
  workMode: SearchWorkMode;
  frequencyHours: 6 | 12 | 24;
  enabled: boolean;
  autoPrepare: boolean;
  language: 'en' | 'es';
};
export type OnPrepare = (workspaceId: string, jobId: string, locale: 'en' | 'es') => Promise<unknown>;
export type RefreshResult = { added: number; matched: number; coverage: 'COMPLETE' | 'PARTIAL' | 'BOUNDED' | 'CACHED' | 'STALE' | 'EMPTY' | 'FAILED'; coverageReason: 'NONE' | 'PAGE_LIMIT' | 'SOURCE_FAILURE' | 'STALE_CACHE'; providerCoverage: Record<JobSearchProvider, 'COMPLETE' | 'BOUNDED' | 'UNKNOWN'>; providers: Record<JobSearchProvider, 'FRESH' | 'CACHED' | 'STALE' | 'FAILED'>; fetchedAt: string };
export type FeedReader = (provider: JobSearchProvider) => Promise<PublicJob[] | ProviderFeed>;

export class JobSearchError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function normalize(value: string | null): string { return (value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }
export function matchesSearch(job: Pick<PublicJob, 'title' | 'company' | 'location' | 'workMode'>, search: Pick<JobSearchInput, 'role' | 'company' | 'location' | 'workMode'>): { matched: boolean; unknownLocation: boolean } {
  const role = normalize(search.role); const company = normalize(search.company); const wantedLocation = normalize(search.location);
  const title = normalize(job.title); const employer = normalize(job.company); const location = normalize(job.location);
  if (role && !role.split(/\s+/).filter(Boolean).every((word) => title.includes(word))) return { matched: false, unknownLocation: false };
  if (company && !company.split(/\s+/).filter(Boolean).every((word) => employer.includes(word))) return { matched: false, unknownLocation: false };
  if (search.workMode !== 'any' && job.workMode !== search.workMode) return { matched: false, unknownLocation: false };
  const aliases: Record<string, string[]> = {
    spain: ['espana', 'españa', 'spanish'], espana: ['spain', 'spanish'], germany: ['alemania', 'deutschland', 'german'], alemania: ['germany', 'deutschland'],
    'united kingdom': ['uk', 'britain', 'england'], uk: ['united kingdom', 'britain', 'england'], 'united states': ['usa', 'us'], usa: ['united states', 'us'],
  };
  const broadLocation = /\b(worldwide|anywhere|global|europe|european union|emea|multiple locations|various locations)\b/.test(location) || /^remote(?:\s+only)?$/.test(location);
  const locationAccepted = !wantedLocation || !location || broadLocation || location.includes(wantedLocation) || wantedLocation.split(/\s+/).some((word) => location.includes(word)) || (aliases[wantedLocation] ?? []).some((alias) => location.includes(alias));
  if (!locationAccepted) return { matched: false, unknownLocation: false };
  // Public feeds often omit the location; retain these results with an explicit review caveat.
  return { matched: true, unknownLocation: Boolean(wantedLocation && (!location || broadLocation)) };
}

type Feed = { jobs: PublicJob[]; state: 'FRESH' | 'CACHED' | 'STALE'; fetchedAt: Date | null; coverage: 'COMPLETE' | 'BOUNDED' };
const PROVIDER_IDS: JobSearchProvider[] = ['remotive', 'arbeitnow'];
function backoff(now: number, failures: number, retryAt = 0): number {
  const delay = Math.min(JOB_SEARCH_FAILURE_MAX_MS, JOB_SEARCH_INTERVAL_MS * 2 ** Math.min(Math.max(0, failures - 1), 3));
  return Math.max(now + delay, retryAt);
}

async function loadProviderFeed(provider: JobSearchProvider, reader: FeedReader): Promise<Feed> {
  const connection = await pool.connect(); const executor = drizzle(connection, { schema }); const lockId = `job-search-provider:${provider}`; let locked = false; let destroy = false;
  try {
    locked = (await connection.query<{ acquired: boolean }>('select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired', [lockId])).rows[0]?.acquired ?? false;
    let cached = (await executor.select().from(jobSearchProviderCache).where(eq(jobSearchProviderCache.provider, provider)).limit(1))[0];
    const now = new Date();
    if (!locked || (cached?.nextFetchAt && cached.nextFetchAt > now)) {
      const stale = !cached?.fetchedAt || now.getTime() - cached.fetchedAt.getTime() > JOB_SEARCH_PROVIDER_COOLDOWN_MS;
      return { jobs: (cached?.payload ?? []) as unknown as PublicJob[], state: stale ? 'STALE' : 'CACHED', fetchedAt: cached?.fetchedAt ?? null, coverage: cached?.coverage === 'BOUNDED' ? 'BOUNDED' : 'COMPLETE' };
    }
    // Reserve the shared provider cooldown before networking. This caps each provider at four reads/day,
    // even when several workspaces save or refresh searches concurrently.
    await executor.insert(jobSearchProviderCache).values({ provider, payload: [], nextFetchAt: new Date(now.getTime() + JOB_SEARCH_PROVIDER_COOLDOWN_MS) }).onConflictDoUpdate({ target: jobSearchProviderCache.provider, set: { nextFetchAt: new Date(now.getTime() + JOB_SEARCH_PROVIDER_COOLDOWN_MS), updatedAt: now } });
    cached = (await executor.select().from(jobSearchProviderCache).where(eq(jobSearchProviderCache.provider, provider)).limit(1))[0];
    try {
      const read = await reader(provider); const listing = Array.isArray(read) ? read : read.jobs; const coverage = Array.isArray(read) ? 'COMPLETE' : read.coverage;
      await executor.update(jobSearchProviderCache).set({ payload: listing as unknown as Record<string, unknown>[], coverage, fetchedAt: new Date(), nextFetchAt: new Date(Date.now() + JOB_SEARCH_PROVIDER_COOLDOWN_MS), failureCount: 0, lastError: null, updatedAt: new Date() }).where(eq(jobSearchProviderCache.provider, provider));
      return { jobs: listing, state: 'FRESH', fetchedAt: new Date(), coverage };
    } catch (error) {
      const failures = (cached?.failureCount ?? 0) + 1; const retryAt = error instanceof ProviderReadError ? error.retryAt : 0;
      const code = error instanceof ProviderReadError ? error.code : 'SOURCE_UNAVAILABLE';
      await executor.update(jobSearchProviderCache).set({ nextFetchAt: new Date(backoff(Date.now(), failures, retryAt)), failureCount: failures, lastError: code, updatedAt: new Date() }).where(eq(jobSearchProviderCache.provider, provider));
      if (cached?.fetchedAt && cached.payload) return { jobs: cached.payload as unknown as PublicJob[], state: 'STALE', fetchedAt: cached.fetchedAt, coverage: cached.coverage === 'BOUNDED' ? 'BOUNDED' : 'COMPLETE' };
      throw error;
    }
  } finally {
    try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockId]); }
    catch { destroy = true; }
    connection.release(destroy);
  }
}

function statusCoverage(states: Record<JobSearchProvider, Feed['state'] | 'FAILED'>, hasResults: boolean, bounded = false): RefreshResult['coverage'] {
  const values = Object.values(states); const failed = values.includes('FAILED');
  if (failed) return hasResults ? 'PARTIAL' : 'FAILED';
  if (bounded) return 'BOUNDED';
  if (!hasResults) return values.includes('STALE') ? 'STALE' : values.every((value) => value === 'CACHED') ? 'CACHED' : 'EMPTY';
  if (values.includes('STALE')) return 'STALE';
  return values.every((value) => value === 'CACHED') ? 'CACHED' : 'COMPLETE';
}

/** Refreshes one workspace's saved query; workspace-level locking prevents duplicate job rows across searches. */
export async function refreshSavedJobSearch(workspaceId: string, searchId: string, options: { automatic?: boolean; initial?: boolean; reader?: FeedReader } = {}): Promise<RefreshResult | null> {
  const connection = await pool.connect(); const executor = drizzle(connection, { schema }); const lockId = `job-search-workspace:${workspaceId}`; let locked = false; let destroy = false;
  try {
    locked = (await connection.query<{ acquired: boolean }>('select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired', [lockId])).rows[0]?.acquired ?? false;
    if (!locked) throw new JobSearchError('SEARCH_REFRESH_ALREADY_RUNNING', 409);
    const search = (await executor.select().from(savedJobSearches).where(and(eq(savedJobSearches.id, searchId), eq(savedJobSearches.workspaceId, workspaceId))).limit(1))[0];
    if (!search) throw new JobSearchError('NOT_FOUND', 404);
    if (!search.enabled) throw new JobSearchError('SEARCH_DISABLED', 409);
    const now = new Date();
    if (!options.initial && search.nextRunAt && search.nextRunAt > now) throw new JobSearchError('SEARCH_REFRESH_COOLDOWN', 429);
    const nextRunAt = new Date(now.getTime() + search.frequencyHours * 60 * 60 * 1000);
    await executor.update(savedJobSearches).set({ lastRunAt: now, lastRunStatus: 'RUNNING', lastError: null, nextRunAt, updatedAt: now }).where(and(eq(savedJobSearches.id, searchId), eq(savedJobSearches.workspaceId, workspaceId)));

    const reader = options.reader ?? ((provider: JobSearchProvider) => readPublicFeed(provider));
    const reads = await Promise.allSettled(PROVIDER_IDS.map((provider) => loadProviderFeed(provider, reader)));
    const feeds: Partial<Record<JobSearchProvider, Feed>> = {}; const providerStatuses = {} as RefreshResult['providers'];
    for (let i = 0; i < reads.length; i++) {
      const provider = PROVIDER_IDS[i]!; const result = reads[i]!;
      if (result.status === 'fulfilled') { feeds[provider] = result.value; providerStatuses[provider] = result.value.state; }
      else providerStatuses[provider] = 'FAILED';
    }
    const allJobs = PROVIDER_IDS.flatMap((provider) => (feeds[provider]?.jobs ?? []).map((job) => ({ provider, job })));
    const result = await executor.transaction(async (tx) => {
      const latest = (await tx.select().from(savedJobSearches).where(and(eq(savedJobSearches.id, searchId), eq(savedJobSearches.workspaceId, workspaceId))).limit(1))[0];
      if (!latest?.enabled && options.automatic) {
        await tx.update(savedJobSearches).set({ lastRunAt: new Date(), lastRunStatus: 'PAUSED', lastError: null, nextRunAt: null, updatedAt: new Date() }).where(eq(savedJobSearches.id, searchId));
        return { added: 0, matched: 0, coverage: 'CACHED' as const, coverageReason: 'NONE' as const };
      }
      const sources = await tx.select().from(jobSearchSources).where(eq(jobSearchSources.workspaceId, workspaceId));
      const sourceByExternal = new Map(sources.map((source) => [`${source.provider}:${source.externalId}`, source]));
      const existingMatches = await tx.select().from(savedJobSearchMatches).where(and(eq(savedJobSearchMatches.workspaceId, workspaceId), eq(savedJobSearchMatches.searchId, searchId)));
      const matchByJob = new Map(existingMatches.map((match) => [match.jobId, match]));
      const sourceUrls = [...new Set(allJobs.map(({ job }) => job.url))];
      const sourceJobIds = [...new Set(sources.map((source) => source.jobId))];
      const existingJobs = sourceUrls.length || sourceJobIds.length ? await tx.select().from(jobs).where(and(eq(jobs.workspaceId, workspaceId), or(sourceUrls.length ? inArray(jobs.canonicalUrl, sourceUrls) : sql`false`, sourceJobIds.length ? inArray(jobs.id, sourceJobIds) : sql`false`))) : [];
      const jobById = new Map(existingJobs.map((job) => [job.id, job]));
      const jobByUrl = new Map(existingJobs.map((job) => [job.canonicalUrl ?? '', job]));
      let added = 0; let matched = 0; const countedMatches = new Set<string>();
      const now = new Date();
      for (const { provider, job: item } of allJobs) {
        const outcome = matchesSearch(item, { role: latest?.role ?? null, company: latest?.company ?? null, location: latest?.location ?? null, workMode: (latest?.workMode ?? 'any') as SearchWorkMode });
        if (!outcome.matched) continue;
        let source = sourceByExternal.get(`${provider}:${item.externalId}`);
        let jobRow = source ? jobById.get(source.jobId) : jobByUrl.get(item.url);
        if (!jobRow) {
          const inserted = await tx.insert(jobs).values({ workspaceId, discoveredAt: now, company: item.company, title: item.title, location: item.location, canonicalUrl: item.url, availability: 'OPEN' }).returning();
          jobRow = inserted[0]; added++;
          if (item.description) {
            const hash = createHash('sha256').update(`${item.title}\n${item.description}`).digest('hex');
            await tx.insert(jobSnapshots).values({ workspaceId, jobId: jobRow!.id, title: item.title, descriptionText: item.description, snapshotHash: hash });
          }
          jobByUrl.set(item.url, jobRow!);
        }
        if (!jobRow) continue;
        const currentHash = item.description ? createHash('sha256').update(`${item.title}\n${item.description}`).digest('hex') : null;
        if (jobRow.title !== item.title || jobRow.company !== item.company || jobRow.location !== item.location || jobRow.canonicalUrl !== item.url) {
          await tx.update(jobs).set({ title: item.title, company: item.company, location: item.location, canonicalUrl: item.url, updatedAt: now }).where(and(eq(jobs.id, jobRow.id), eq(jobs.workspaceId, workspaceId)));
          jobRow = { ...jobRow, title: item.title, company: item.company, location: item.location, canonicalUrl: item.url, updatedAt: now };
          jobById.set(jobRow.id, jobRow);
          if (jobRow.canonicalUrl) jobByUrl.set(jobRow.canonicalUrl, jobRow);
        }
        if (currentHash) {
          const latestSnapshot = (await tx.select({ snapshotHash: jobSnapshots.snapshotHash }).from(jobSnapshots).where(and(eq(jobSnapshots.workspaceId, workspaceId), eq(jobSnapshots.jobId, jobRow.id))).orderBy(desc(jobSnapshots.fetchedAt)).limit(1))[0];
          if (latestSnapshot?.snapshotHash !== currentHash) await tx.insert(jobSnapshots).values({ workspaceId, jobId: jobRow.id, occurrenceId: null, title: item.title, descriptionText: item.description, snapshotHash: currentHash });
        }
        const postedAt = item.postedAt && Number.isFinite(Date.parse(item.postedAt)) ? new Date(item.postedAt) : null;
        if (source) await tx.update(jobSearchSources).set({ sourceUrl: item.url, postedAt, lastSeenAt: now, raw: { ...item.raw, __careerStackWorkMode: item.workMode } }).where(eq(jobSearchSources.id, source.id));
        else {
          const insertedSource = await tx.insert(jobSearchSources).values({ workspaceId, jobId: jobRow.id, provider, externalId: item.externalId, sourceUrl: item.url, postedAt, raw: { ...item.raw, __careerStackWorkMode: item.workMode } }).returning();
          source = insertedSource[0]; if (source) sourceByExternal.set(`${provider}:${item.externalId}`, source);
        }
        const priorMatch = matchByJob.get(jobRow.id);
        await tx.insert(savedJobSearchMatches).values({ workspaceId, searchId, jobId: jobRow.id, matchedAt: priorMatch?.matchedAt ?? now, lastMatchedAt: now }).onConflictDoUpdate({ target: [savedJobSearchMatches.workspaceId, savedJobSearchMatches.searchId, savedJobSearchMatches.jobId], set: { lastMatchedAt: now } });
        if (!countedMatches.has(jobRow.id)) { matched++; countedMatches.add(jobRow.id); }
      }
      const coverage = statusCoverage({ remotive: feeds.remotive?.state ?? 'FAILED', arbeitnow: feeds.arbeitnow?.state ?? 'FAILED' }, matched > 0, Object.values(feeds).some((feed) => feed?.coverage === 'BOUNDED'));
      const failed = ['PARTIAL', 'STALE', 'FAILED'].includes(coverage);
      const coverageReason: RefreshResult['coverageReason'] = coverage === 'BOUNDED' ? 'PAGE_LIMIT' : failed ? coverage === 'STALE' ? 'STALE_CACHE' : 'SOURCE_FAILURE' : 'NONE';
      const lastError = coverageReason === 'PAGE_LIMIT' ? 'SOURCE_PAGE_LIMIT' : coverageReason === 'SOURCE_FAILURE' ? 'SOURCE_PARTIAL_FAILURE' : coverageReason === 'STALE_CACHE' ? 'SOURCE_CACHE_STALE' : null;
      await tx.update(savedJobSearches).set({ lastRunAt: now, nextRunAt: new Date(now.getTime() + latest!.frequencyHours * 60 * 60 * 1000), lastRunStatus: coverage, lastResultCount: matched, lastNewCount: added, lastError, failureCount: failed ? latest!.failureCount + 1 : 0, updatedAt: now }).where(and(eq(savedJobSearches.id, searchId), eq(savedJobSearches.workspaceId, workspaceId)));
      return { added, matched, coverage, coverageReason };
    });
    const providerCoverage = { remotive: feeds.remotive?.coverage ?? 'UNKNOWN', arbeitnow: feeds.arbeitnow?.coverage ?? 'UNKNOWN' } as RefreshResult['providerCoverage'];
    return { ...result, providerCoverage, providers: providerStatuses, fetchedAt: new Date().toISOString() };
  } catch (error) {
    if (error instanceof JobSearchError) throw error;
    const search = (await executor.select().from(savedJobSearches).where(and(eq(savedJobSearches.id, searchId), eq(savedJobSearches.workspaceId, workspaceId))).limit(1)).at(0);
    if (search) {
      const failures = search.failureCount + 1; const retry = backoff(Date.now(), failures);
      await executor.update(savedJobSearches).set({ lastRunAt: new Date(), lastRunStatus: 'FAILED', lastError: 'SOURCE_READ_FAILED', failureCount: failures, nextRunAt: new Date(retry), updatedAt: new Date() }).where(and(eq(savedJobSearches.id, searchId), eq(savedJobSearches.workspaceId, workspaceId)));
    }
    throw new JobSearchError('SEARCH_REFRESH_FAILED', 502);
  } finally {
    try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockId]); }
    catch { destroy = true; }
    connection.release(destroy);
  }
}

export async function runJobSearchTick(onPrepare?: OnPrepare): Promise<void> {
  if (onPrepare) await processPendingJobPreparations(onPrepare, 5);
  const now = new Date();
  const due = await db.select({ id: savedJobSearches.id, workspaceId: savedJobSearches.workspaceId }).from(savedJobSearches)
    .where(and(eq(savedJobSearches.enabled, true), or(isNull(savedJobSearches.nextRunAt), sql`${savedJobSearches.nextRunAt} <= ${now}`)))
    .orderBy(asc(savedJobSearches.nextRunAt), savedJobSearches.id).limit(1);
  const search = due[0]; if (!search) return;
  try { await refreshSavedJobSearch(search.workspaceId, search.id, { automatic: true }); }
  catch (error) { if (!(error instanceof JobSearchError && ['SEARCH_REFRESH_ALREADY_RUNNING', 'SEARCH_REFRESH_COOLDOWN', 'SEARCH_DISABLED', 'NOT_FOUND', 'SEARCH_REFRESH_FAILED'].includes(error.message))) throw error; }
}

const preparationRetryAt = (attempt: number, now = Date.now()) => new Date(now + Math.min(24 * 60 * 60 * 1000, 60_000 * 2 ** Math.min(Math.max(0, attempt - 1), 10)));
/** Claims and attempts at most five opted-in, non-archived preparations per worker tick. */
export async function processPendingJobPreparations(onPrepare: OnPrepare, batchSize = 5): Promise<{ attempted: number; prepared: number; failed: number }> {
  const limit = Math.max(1, Math.min(5, Math.trunc(batchSize) || 5)); const now = new Date();
  const candidates = await db.select({ workspaceId: savedJobSearchMatches.workspaceId, searchId: savedJobSearchMatches.searchId, jobId: savedJobSearchMatches.jobId })
    .from(savedJobSearchMatches)
    .innerJoin(savedJobSearches, and(eq(savedJobSearches.id, savedJobSearchMatches.searchId), eq(savedJobSearches.workspaceId, savedJobSearchMatches.workspaceId)))
    .innerJoin(jobs, and(eq(jobs.id, savedJobSearchMatches.jobId), eq(jobs.workspaceId, savedJobSearchMatches.workspaceId)))
    .where(and(eq(savedJobSearches.enabled, true), eq(savedJobSearches.autoPrepare, true), isNull(savedJobSearchMatches.autoPreparedAt), or(isNull(savedJobSearchMatches.autoPrepareNextAttemptAt), lte(savedJobSearchMatches.autoPrepareNextAttemptAt, now)), sql`${jobs.shortlistDecision} <> 'ARCHIVED'`))
    .orderBy(asc(savedJobSearchMatches.autoPrepareNextAttemptAt), asc(savedJobSearchMatches.matchedAt)).limit(limit);
  let attempted = 0; let prepared = 0; let failed = 0;
  for (const candidate of candidates) {
    const connection = await pool.connect(); const executor = drizzle(connection, { schema });
    const lockId = `job-search-prepare:${candidate.workspaceId}:${candidate.searchId}:${candidate.jobId}`; let locked = false; let destroy = false;
    try {
      locked = (await connection.query<{ acquired: boolean }>('select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired', [lockId])).rows[0]?.acquired ?? false;
      if (!locked) continue;
      const pending = (await executor.select({ locale: savedJobSearches.language, attempts: savedJobSearchMatches.autoPrepareAttempts }).from(savedJobSearchMatches)
        .innerJoin(savedJobSearches, and(eq(savedJobSearches.id, savedJobSearchMatches.searchId), eq(savedJobSearches.workspaceId, savedJobSearchMatches.workspaceId)))
        .innerJoin(jobs, and(eq(jobs.id, savedJobSearchMatches.jobId), eq(jobs.workspaceId, savedJobSearchMatches.workspaceId)))
        .where(and(eq(savedJobSearchMatches.workspaceId, candidate.workspaceId), eq(savedJobSearchMatches.searchId, candidate.searchId), eq(savedJobSearchMatches.jobId, candidate.jobId), eq(savedJobSearches.enabled, true), eq(savedJobSearches.autoPrepare, true), isNull(savedJobSearchMatches.autoPreparedAt), or(isNull(savedJobSearchMatches.autoPrepareNextAttemptAt), lte(savedJobSearchMatches.autoPrepareNextAttemptAt, new Date())), sql`${jobs.shortlistDecision} <> 'ARCHIVED'`)).limit(1))[0];
      if (!pending) continue;
      await executor.update(savedJobSearchMatches).set({ autoPrepareError: 'PREPARING', autoPrepareNextAttemptAt: new Date(Date.now() + 5 * 60_000) }).where(and(eq(savedJobSearchMatches.workspaceId, candidate.workspaceId), eq(savedJobSearchMatches.searchId, candidate.searchId), eq(savedJobSearchMatches.jobId, candidate.jobId), isNull(savedJobSearchMatches.autoPreparedAt)));
      attempted++;
      try {
        await onPrepare(candidate.workspaceId, candidate.jobId, pending.locale === 'es' ? 'es' : 'en');
        await executor.update(savedJobSearchMatches).set({ autoPreparedAt: new Date(), autoPrepareError: null, autoPrepareNextAttemptAt: null }).where(and(eq(savedJobSearchMatches.workspaceId, candidate.workspaceId), eq(savedJobSearchMatches.searchId, candidate.searchId), eq(savedJobSearchMatches.jobId, candidate.jobId), isNull(savedJobSearchMatches.autoPreparedAt)));
        prepared++;
      } catch {
        const attempt = pending.attempts + 1;
        await executor.update(savedJobSearchMatches).set({ autoPrepareAttempts: attempt, autoPrepareError: 'PREPARATION_FAILED', autoPrepareNextAttemptAt: preparationRetryAt(attempt) }).where(and(eq(savedJobSearchMatches.workspaceId, candidate.workspaceId), eq(savedJobSearchMatches.searchId, candidate.searchId), eq(savedJobSearchMatches.jobId, candidate.jobId), isNull(savedJobSearchMatches.autoPreparedAt)));
        failed++;
      }
    } finally {
      try { if (locked) await connection.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockId]); }
      catch { destroy = true; }
      connection.release(destroy);
    }
  }
  return { attempted, prepared, failed };
}

export type JobSearchSourceInfo = { provider: JobSearchProvider; name: string; url: string; postedAt: Date | null };
/** Source attribution for existing jobs list/detail handlers; keys are job IDs from this workspace only. */
export async function getJobSearchSources(workspaceId: string, jobIds: string[]): Promise<Record<string, JobSearchSourceInfo[]>> {
  const result: Record<string, JobSearchSourceInfo[]> = {};
  for (const jobId of jobIds) result[jobId] = [];
  if (!jobIds.length) return result;
  const rows = await db.select({ jobId: jobSearchSources.jobId, provider: jobSearchSources.provider, url: jobSearchSources.sourceUrl, postedAt: jobSearchSources.postedAt }).from(jobSearchSources)
    .where(and(eq(jobSearchSources.workspaceId, workspaceId), inArray(jobSearchSources.jobId, jobIds)));
  for (const row of rows) {
    if (row.provider !== 'remotive' && row.provider !== 'arbeitnow') continue;
    result[row.jobId] ??= [];
    if (!result[row.jobId]!.some((source) => source.provider === row.provider && source.url === row.url)) result[row.jobId]!.push({ provider: row.provider, name: PROVIDERS[row.provider].name, url: row.url, postedAt: row.postedAt });
  }
  return result;
}

/** Recover abandoned RUNNING reservations conservatively, then schedule persisted due work. */
export function startJobSearchWorker(onError: (error: unknown) => void, onPrepare?: OnPrepare) {
  let stopped = false; let timer: ReturnType<typeof setTimeout>; let current: Promise<void> = Promise.resolve();
  const recover = db.update(savedJobSearches).set({ lastRunStatus: 'INTERRUPTED', nextRunAt: sql`now() + (${savedJobSearches.frequencyHours} * interval '1 hour')`, updatedAt: new Date() }).where(and(eq(savedJobSearches.lastRunStatus, 'RUNNING'), sql`${savedJobSearches.lastRunAt} < now() - interval '2 minutes'`)).then(() => undefined);
  const tick = () => {
    current = recover.then(() => runJobSearchTick(onPrepare)).catch(onError).finally(() => { if (!stopped) { timer = setTimeout(tick, 5_000); timer.unref(); } });
  };
  timer = setTimeout(tick, 1_000); timer.unref();
  return async () => { stopped = true; clearTimeout(timer); await current; };
}
