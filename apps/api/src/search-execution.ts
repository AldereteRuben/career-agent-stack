import { createHash, randomUUID } from 'node:crypto';
import { pool } from '@career/db';
type QueryClient = { query: typeof pool.query };
import { evaluateSearchMatch, providerSearchRole } from '@career/domain';
import { normalizeHimalayasCountry, readHimalayasSearch } from './himalayas-source.js';
import { loadProviderFeed, type OnPrepare } from './job-search.js';
import { readPublicFeed, type PublicJob, type SearchWorkMode, ProviderReadError } from './job-search-sources.js';
import { identityUrl, jobIdentity } from './job-identity.js';

export const SEARCH_PROVIDERS = ['remotive', 'arbeitnow', 'himalayas', 'boards'] as const;
export type SearchProvider = typeof SEARCH_PROVIDERS[number];
export type SearchCriteria = { role: string | null; company: string | null; location: string | null; workMode: SearchWorkMode; matcherVersion: number; includeRelated: boolean; providerIds: SearchProvider[]; language: 'en' | 'es'; frequencyHours: number };
type Run = { id: string; workspace_id: string; search_id: string; revision: number; criteria: SearchCriteria; manual: boolean; owner: string };
type SourceItem = PublicJob & { existingJobId?: string; sourceName?: string; checkedAt?: string | null };
type Feed = { jobs: SourceItem[]; state: string; coverage: 'COMPLETE' | 'BOUNDED' | 'PARTIAL'; fetchedAt: Date | null; nextFetchAt?: Date | null };
export type SearchReader = (provider: SearchProvider, criteria: SearchCriteria, workspaceId: string) => Promise<Feed>;
const DAY = 86_400_000;
const sourceName = (provider: string) => ({ remotive: 'Remotive', arbeitnow: 'Arbeitnow', himalayas: 'Himalayas', boards: 'Company website' })[provider] ?? provider;

export async function enqueueSearch(client: QueryClient, workspaceId: string, searchId: string, manual = false): Promise<string | null> {
  const { rows } = await client.query(`INSERT INTO search_runs(workspace_id,search_id,revision,criteria,manual)
    SELECT workspace_id,id,revision,jsonb_build_object('role',role,'company',company,'location',location,'workMode',work_mode,
    'matcherVersion',matcher_version,'includeRelated',include_related,'providerIds',provider_ids,'language',language,'frequencyHours',frequency_hours),$3
    FROM saved_job_searches WHERE workspace_id=$1 AND id=$2 AND matcher_version=2 AND (enabled OR $3)
    ON CONFLICT(workspace_id,search_id,revision) WHERE finished_at IS NULL DO UPDATE SET search_id=excluded.search_id RETURNING id`, [workspaceId, searchId, manual]);
  const id = rows[0]?.id as string | undefined;
  if (id) {
    await client.query(`INSERT INTO search_run_sources(workspace_id,run_id,provider) SELECT workspace_id,id,jsonb_array_elements_text(criteria->'providerIds') FROM search_runs WHERE id=$1 ON CONFLICT DO NOTHING`, [id]);
    await client.query(`UPDATE saved_job_searches SET last_run_status='QUEUED',updated_at=now() WHERE workspace_id=$1 AND id=$2`, [workspaceId, searchId]);
  }
  return id ?? null;
}

async function himalayasFeed(criteria: SearchCriteria): Promise<Feed> {
  const normalizeText = (value: string | null) => value?.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toLocaleLowerCase('en') || null;
  const role = normalizeText(providerSearchRole(criteria.role));
  const company = normalizeText(criteria.company);
  const location = normalizeHimalayasCountry(criteria.location);
  const query = { role, company, location };
  const key = createHash('sha256').update(JSON.stringify({ q: [role,company].filter(Boolean).join(' '), country: location })).digest('hex');
  const client = await pool.connect(); let locked = false;
  try {
    // A single host lock bounds requests across every search and query cache.
    locked = (await client.query(`SELECT pg_try_advisory_lock(hashtextextended('search-himalayas-host',0)) AS locked`)).rows[0]?.locked === true;
    const cached = (await client.query(`SELECT * FROM search_query_cache WHERE provider='himalayas' AND query_hash=$1`, [key])).rows[0];
    if (cached) await client.query(`UPDATE search_query_cache SET last_used_at=now() WHERE provider='himalayas' AND query_hash=$1`, [key]);
    if (!locked) {
      if (!cached?.fetched_at) throw new ProviderReadError('SOURCE_BUSY', Date.now() + 30_000);
      return { jobs: cached.payload, coverage: cached.coverage, fetchedAt: cached.fetched_at, nextFetchAt: cached.next_fetch_at, state: cached.error || Date.now() - cached.fetched_at.getTime() > DAY ? 'STALE' : 'CACHED' };
    }
    if (cached?.next_fetch_at > new Date()) {
      if (!cached?.fetched_at) throw new ProviderReadError(cached?.error ?? 'SOURCE_WAITING', cached?.next_fetch_at?.getTime() ?? Date.now() + DAY);
      return { jobs: cached.payload, coverage: cached.coverage, fetchedAt: cached.fetched_at, nextFetchAt: cached.next_fetch_at, state: cached.error || Date.now() - cached.fetched_at.getTime() > DAY ? 'STALE' : 'CACHED' };
    }
    const hostWait = (await client.query(`SELECT max(next_fetch_at) AS until FROM search_query_cache
      WHERE provider='himalayas' AND error IN ('SOURCE_HTTP_429','SOURCE_RETRY_AFTER') AND next_fetch_at>now()`)).rows[0]?.until as Date | null;
    if (hostWait) {
      if (cached?.fetched_at) return {jobs:cached.payload,state:'STALE',coverage:cached.coverage,fetchedAt:cached.fetched_at,nextFetchAt:hostWait};
      throw new ProviderReadError('SOURCE_WAITING',hostWait.getTime());
    }
    // Reserve the maximum requests before networking, including crashes or failed pages.
    const budget = await client.query(`INSERT INTO search_provider_budget(provider,day,requests) VALUES('himalayas',(now() AT TIME ZONE 'UTC')::date,3)
      ON CONFLICT(provider,day) DO UPDATE SET requests=search_provider_budget.requests+3 WHERE search_provider_budget.requests<=97 RETURNING requests`);
    if (!budget.rowCount) throw new ProviderReadError('SOURCE_DAILY_LIMIT', Date.now() + DAY);
    await client.query(`INSERT INTO search_query_cache(provider,query_hash,next_fetch_at) VALUES('himalayas',$1,now()+interval '24 hours')
      ON CONFLICT(provider,query_hash) DO UPDATE SET next_fetch_at=now()+interval '24 hours',last_used_at=now()`, [key]);
    try {
      const result = await readHimalayasSearch(query, { maxPages: 3 });
      const cooldown = new Date(Math.max(Date.now() + DAY, result.retryAt ?? 0));
      const stored = (await client.query(`UPDATE search_query_cache SET payload=$2::jsonb,coverage=$3,fetched_at=now(),next_fetch_at=$4,error=$5,failures=0 WHERE provider='himalayas' AND query_hash=$1 RETURNING *`, [key, JSON.stringify(result.jobs), result.coverage, cooldown,result.retryAt ? 'SOURCE_RETRY_AFTER' : null])).rows[0];
      return { jobs: result.jobs, state: 'FRESH', coverage: result.coverage, fetchedAt: stored.fetched_at, nextFetchAt: stored.next_fetch_at };
    } catch (error) {
      const retryAt = error instanceof ProviderReadError ? error.retryAt : 0;
      const retry = new Date(Math.max(Date.now() + DAY, retryAt));
      const code = error instanceof ProviderReadError ? error.code : 'SOURCE_UNAVAILABLE';
      await client.query(`UPDATE search_query_cache SET error=$2,failures=failures+1,next_fetch_at=$3 WHERE provider='himalayas' AND query_hash=$1`, [key, code, retry]);
      if (cached?.fetched_at) return { jobs: cached.payload, state: 'STALE', coverage: cached.coverage, fetchedAt: cached.fetched_at, nextFetchAt: retry };
      throw error;
    }
  } finally { if (locked) await client.query(`SELECT pg_advisory_unlock(hashtextextended('search-himalayas-host',0))`); client.release(); }
}

export const readSearchSource: SearchReader = async (provider, criteria, workspaceId) => {
  if (provider === 'himalayas') return himalayasFeed(criteria);
  if (provider !== 'boards') {
    const feed = await loadProviderFeed(provider, (id) => readPublicFeed(id));
    const next = (await pool.query('SELECT next_fetch_at FROM job_search_provider_cache WHERE provider=$1', [provider])).rows[0];
    return { ...feed, nextFetchAt: next?.next_fetch_at };
  }
  // Followed boards keep their own reader and permission gates. Search consumes their local snapshots only.
  const { rows } = await pool.query(`SELECT DISTINCT ON(j.id) j.*,o.external_job_id,o.job_url,o.source_posted_at,o.last_successful_refresh_at,o.source_payload,b.company_name,
    sn.description_text FROM jobs j JOIN job_occurrences o ON o.workspace_id=j.workspace_id AND o.job_id=j.id
    JOIN boards b ON b.workspace_id=o.workspace_id AND b.provider=o.provider AND b.region=o.region AND b.tenant=o.tenant
    LEFT JOIN LATERAL(SELECT description_text FROM job_snapshots WHERE workspace_id=j.workspace_id AND job_id=j.id ORDER BY fetched_at DESC LIMIT 1) sn ON true
    WHERE j.workspace_id=$1 AND b.enabled AND b.association_status='VERIFIED' AND b.permission_status='APPROVED_FOR_SCOPE'
    AND b.reviewed_at IS NOT NULL AND (b.review_due_at IS NULL OR b.review_due_at>now()) ORDER BY j.id,o.last_seen_at DESC LIMIT 10001`, [workspaceId]);
  const bounded = rows.length > 10000; const selected = rows.slice(0, 10000);
  return { state: selected.some((r) => !r.last_successful_refresh_at || Date.now() - r.last_successful_refresh_at.getTime() > DAY) ? 'STALE' : 'CACHED', coverage: bounded ? 'BOUNDED' : 'COMPLETE', fetchedAt: null,
    jobs: selected.map((r) => ({ existingJobId: r.id, sourceName: r.company_name, externalId: r.external_job_id, title: r.title, company: r.company, location: r.location, workMode: /hybrid|hibrid/i.test(r.location ?? '') ? 'hybrid' : /remote|remoto|teletrabajo/i.test(r.location ?? '') ? 'remote' : 'unknown', url: r.job_url, description: r.description_text, postedAt: r.source_posted_at?.toISOString() ?? null, checkedAt: r.last_successful_refresh_at?.toISOString() ?? null, raw: r.source_payload })) };
};

async function ingest(run: Run, provider: SearchProvider, feed: Feed): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`job-identity:${run.workspace_id}`]);
      const valid = await client.query(`SELECT r.id FROM search_runs r JOIN saved_job_searches s ON s.id=r.search_id AND s.workspace_id=r.workspace_id
      WHERE r.id=$1 AND r.owner=$2 AND r.lease_until>now() AND r.finished_at IS NULL AND s.revision=r.revision AND (s.enabled OR r.manual) FOR UPDATE OF r,s`, [run.id, run.owner]);
    if (!valid.rowCount) { await client.query('ROLLBACK'); return 0; }
    // A complete fresh/cached read replaces this provider's prior contribution in
    // the carried publication. Partial reads cannot establish that absent jobs ended.
    if (feed.coverage === 'COMPLETE' && (feed.state === 'FRESH' || feed.state === 'CACHED')) {
      await client.query(`UPDATE search_run_results r SET sources=coalesce((
        SELECT jsonb_agg(entry) FROM jsonb_array_elements(r.sources) AS entries(entry) WHERE entry->>'provider'<>$3
      ),'[]'::jsonb) WHERE r.run_id=$1 AND r.workspace_id=$2`, [run.id,run.workspace_id,provider]);
      await client.query(`DELETE FROM search_run_results WHERE run_id=$1 AND workspace_id=$2 AND sources='[]'::jsonb`, [run.id,run.workspace_id]);
    }
    let found = 0;
    for (const item of feed.jobs) {
      const outcome = evaluateSearchMatch({ ...item, ...(Array.isArray(item.raw.__careerStackCountries) ? {countries: item.raw.__careerStackCountries as string[]} : {}), worldwide: item.raw.__careerStackWorldwide === true }, run.criteria);
      if (!outcome.matched) continue;
      const url = identityUrl(item.url); const key = jobIdentity(url);
      const prior = (await client.query(`SELECT j.* FROM jobs j LEFT JOIN job_identity_members m ON m.workspace_id=j.workspace_id AND m.job_id=j.id
        WHERE j.workspace_id=$1 AND (j.id=$2::uuid OR m.identity_key=$3 OR j.canonical_url=$4 OR EXISTS(SELECT 1 FROM job_search_sources src WHERE src.workspace_id=j.workspace_id AND src.job_id=j.id AND src.provider=$5 AND src.external_id=$6))
        ORDER BY j.created_at,j.id LIMIT 1`, [run.workspace_id, item.existingJobId ?? null, key, url, provider, item.externalId])).rows[0];
      let jobId: string = prior?.id;
      if (!jobId) jobId = (await client.query(`INSERT INTO jobs(workspace_id,title,company,location,canonical_url,availability,discovered_at) VALUES($1,$2,$3,$4,$5,'OPEN',now()) RETURNING id`, [run.workspace_id,item.title,item.company,item.location,url])).rows[0].id;
      await client.query(`INSERT INTO job_identity_members(workspace_id,job_id,identity_key,evidence) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(workspace_id,job_id) DO NOTHING`, [run.workspace_id,jobId,key,JSON.stringify({ type: 'canonical-url', url })]);
      if (!prior || prior.canonical_url === url) {
        await client.query(`UPDATE jobs SET title=$3,company=$4,location=$5,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND (title,company,location) IS DISTINCT FROM ($3,$4,$5)`, [run.workspace_id,jobId,item.title,item.company,item.location]);
        if (item.description) {
          const hash = createHash('sha256').update(`${item.title}\n${item.description}`).digest('hex');
          await client.query(`INSERT INTO job_snapshots(workspace_id,job_id,title,description_text,snapshot_hash) SELECT $1,$2,$3,$4::text,$5::varchar(64) WHERE NOT EXISTS(SELECT 1 FROM job_snapshots WHERE workspace_id=$1 AND job_id=$2 AND snapshot_hash=$5::varchar(64))`, [run.workspace_id,jobId,item.title,item.description,hash]);
        }
      }
      const posted = item.postedAt && Number.isFinite(Date.parse(item.postedAt)) ? new Date(item.postedAt) : null;
      const attributionUrl = provider === 'himalayas' && typeof item.raw.__careerStackSourceUrl === 'string' ? item.raw.__careerStackSourceUrl : item.url;
      if (provider !== 'boards') await client.query(`INSERT INTO job_search_sources(workspace_id,job_id,provider,external_id,source_url,posted_at,raw) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
        ON CONFLICT(workspace_id,provider,external_id) DO UPDATE SET source_url=excluded.source_url,posted_at=excluded.posted_at,last_seen_at=now(),raw=excluded.raw`, [run.workspace_id,jobId,provider,item.externalId,attributionUrl,posted,JSON.stringify({ ...item.raw, __careerStackWorkMode: item.workMode })]);
      const attribution = { provider, name: item.sourceName ?? sourceName(provider), url: attributionUrl, postedAt: posted?.toISOString() ?? null, fetchedAt: item.checkedAt ?? feed.fetchedAt?.toISOString() ?? null };
      await client.query(`INSERT INTO search_run_results(workspace_id,run_id,search_id,job_id,score,reasons,location_status,unknown_location,posted_at,sources)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb) ON CONFLICT(workspace_id,run_id,job_id) DO UPDATE SET
        score=greatest(search_run_results.score,excluded.score),
        reasons=(CASE WHEN excluded.score>=search_run_results.score THEN excluded.reasons ELSE search_run_results.reasons END)||
          CASE WHEN search_run_results.unknown_location OR excluded.unknown_location THEN '["LOCATION_UNKNOWN"]'::jsonb ELSE '[]'::jsonb END,
        location_status=CASE WHEN search_run_results.unknown_location OR excluded.unknown_location THEN 'unknown'
          WHEN excluded.score>=search_run_results.score THEN excluded.location_status ELSE search_run_results.location_status END,
        unknown_location=search_run_results.unknown_location OR excluded.unknown_location,
        sources=search_run_results.sources||excluded.sources`, [run.workspace_id,run.id,run.search_id,jobId,outcome.score,JSON.stringify(outcome.reasons),outcome.locationStatus,outcome.unknownLocation,posted,JSON.stringify([attribution])]);
      await client.query(`INSERT INTO search_job_reviews(workspace_id,search_id,job_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [run.workspace_id,run.search_id,jobId]);
      await client.query(`INSERT INTO saved_job_search_matches(workspace_id,search_id,job_id) VALUES($1,$2,$3) ON CONFLICT(workspace_id,search_id,job_id) DO UPDATE SET last_matched_at=now()`, [run.workspace_id,run.search_id,jobId]);
      found++;
    }
    await client.query(`UPDATE search_run_sources SET status=$3,coverage=$4,fetched_at=$5,next_fetch_at=$6,found=$7,error=NULL WHERE run_id=$1 AND provider=$2`, [run.id,provider,feed.state,feed.coverage,feed.fetchedAt,feed.nextFetchAt ?? null,found]);
    await client.query(`UPDATE search_runs SET status='PARTIAL' WHERE id=$1 AND owner=$2 AND finished_at IS NULL`, [run.id,run.owner]);
    await client.query('COMMIT'); return found;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export async function runSearchExecutionTick(reader: SearchReader = readSearchSource): Promise<void> {
  // Fence obsolete work and recover expired claims. Reservations at providers survive these retries.
  await pool.query(`UPDATE search_runs r SET status='CANCELLED',finished_at=now(),owner=NULL,lease_until=NULL WHERE finished_at IS NULL
    AND EXISTS(SELECT 1 FROM saved_job_searches s WHERE s.id=r.search_id AND s.workspace_id=r.workspace_id AND (s.revision<>r.revision OR (NOT s.enabled AND NOT r.manual)))`);
  const due = (await pool.query(`SELECT id,workspace_id FROM saved_job_searches s WHERE matcher_version=2 AND enabled AND (next_run_at IS NULL OR next_run_at<=now())
    AND NOT EXISTS(SELECT 1 FROM search_runs r WHERE r.search_id=s.id AND r.finished_at IS NULL) ORDER BY next_run_at NULLS FIRST,id LIMIT 1`)).rows[0];
  if (due) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await enqueueSearch(client, due.workspace_id, due.id);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  const owner = randomUUID();
  const run = (await pool.query(`UPDATE search_runs SET status='RUNNING',owner=$1,lease_until=now()+interval '2 minutes',started_at=coalesce(started_at,now()) WHERE id=(
    SELECT r.id FROM search_runs r WHERE r.finished_at IS NULL AND (r.status='QUEUED' OR r.lease_until<now())
    AND NOT EXISTS(SELECT 1 FROM search_run_sources q WHERE q.run_id=r.id AND q.status='QUEUED' AND q.next_fetch_at>now())
    ORDER BY r.created_at,r.id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [owner])).rows[0] as Run | undefined;
  if (!run) return;
  // Repair an incomplete enqueue left by a prior process before reading any source.
  await pool.query(`INSERT INTO search_run_sources(workspace_id,run_id,provider)
    SELECT workspace_id,id,jsonb_array_elements_text(criteria->'providerIds') FROM search_runs
    WHERE id=$1 AND owner=$2 AND lease_until>now() AND finished_at IS NULL ON CONFLICT DO NOTHING`, [run.id,owner]);
  // Keep only unfinished provider contributions while this run refreshes sources.
  await pool.query(`WITH active AS (
      SELECT id,workspace_id,search_id,revision FROM search_runs WHERE id=$1 AND owner=$2 AND lease_until>now() AND finished_at IS NULL
    ), previous AS (
      SELECT p.id FROM search_runs p JOIN active a ON p.workspace_id=a.workspace_id AND p.search_id=a.search_id AND p.revision=a.revision
      WHERE p.id<>a.id AND p.status IN ('SUCCEEDED','PARTIAL') AND p.finished_at IS NOT NULL
        AND EXISTS(SELECT 1 FROM search_run_results old WHERE old.run_id=p.id)
      ORDER BY p.created_at DESC,p.id DESC LIMIT 1
    )
    INSERT INTO search_run_results(workspace_id,run_id,search_id,job_id,score,reasons,location_status,unknown_location,posted_at,sources)
    SELECT a.workspace_id,a.id,prior.search_id,prior.job_id,prior.score,prior.reasons,prior.location_status,prior.unknown_location,prior.posted_at,retained.sources
    FROM active a CROSS JOIN previous p JOIN search_run_results prior ON prior.run_id=p.id
    CROSS JOIN LATERAL (
      SELECT jsonb_agg(entry) AS sources FROM jsonb_array_elements(prior.sources) AS entries(entry)
      WHERE EXISTS(SELECT 1 FROM search_run_sources q WHERE q.run_id=a.id AND q.provider=entry->>'provider'
        AND q.status NOT IN ('FRESH','CACHED','STALE'))
    ) retained
    WHERE retained.sources IS NOT NULL AND retained.sources<>'[]'::jsonb
    ON CONFLICT(workspace_id,run_id,job_id) DO NOTHING`, [run.id,owner]);
  // Renew independently of provider latency. Every publication checks owner, lease and criteria revision.
  const heartbeat = setInterval(() => { void pool.query(`UPDATE search_runs SET lease_until=now()+interval '2 minutes' WHERE id=$1 AND owner=$2 AND finished_at IS NULL`, [run.id,owner]).catch(() => {}); }, 20_000); heartbeat.unref();
  let deferred = false;
  try {
    await Promise.all(run.criteria.providerIds.map(async (provider) => {
      const previous = (await pool.query(`SELECT status FROM search_run_sources WHERE run_id=$1 AND provider=$2`, [run.id,provider])).rows[0];
      if (previous && ['FRESH','CACHED','STALE'].includes(previous.status)) return;
      const started = await pool.query(`UPDATE search_run_sources q SET status='RUNNING' WHERE q.run_id=$1 AND q.provider=$2
        AND EXISTS(SELECT 1 FROM search_runs r JOIN saved_job_searches s ON s.workspace_id=r.workspace_id AND s.id=r.search_id
          WHERE r.id=q.run_id AND r.owner=$3 AND r.lease_until>now() AND r.finished_at IS NULL
            AND s.revision=r.revision AND (s.enabled OR r.manual))`, [run.id,provider,owner]);
      if (!started.rowCount) return;
      try { await ingest(run, provider, await reader(provider, run.criteria, run.workspace_id)); }
      catch (error) {
        const code = error instanceof ProviderReadError ? error.code : 'SOURCE_UNAVAILABLE';
        const retryAt = error instanceof ProviderReadError ? error.retryAt : 0;
        const waitForSource = error instanceof ProviderReadError && (['SOURCE_BUSY','SOURCE_WAITING','SOURCE_DAILY_LIMIT'].includes(error.code) || retryAt > Date.now());
        if (waitForSource) deferred = true;
        const nextFetchAt = waitForSource ? new Date(Math.max(Date.now() + 30_000,retryAt)) : retryAt ? new Date(retryAt) : null;
        await pool.query(`UPDATE search_run_sources SET status=$6,error=$3,next_fetch_at=$4 WHERE run_id=$1 AND provider=$2
          AND EXISTS(SELECT 1 FROM search_runs WHERE id=$1 AND owner=$5 AND lease_until>now() AND finished_at IS NULL)`, [run.id,provider,code,nextFetchAt,owner,waitForSource ? 'QUEUED' : 'FAILED']);
      }
    }));
    if (deferred) {
      await pool.query(`UPDATE search_runs SET status='QUEUED',owner=NULL,lease_until=NULL WHERE id=$1 AND owner=$2 AND lease_until>now() AND finished_at IS NULL`, [run.id,owner]);
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const valid = await client.query(`SELECT r.id FROM search_runs r JOIN saved_job_searches s ON s.id=r.search_id AND s.workspace_id=r.workspace_id
        WHERE r.id=$1 AND r.owner=$2 AND r.lease_until>now() AND r.finished_at IS NULL AND s.revision=r.revision AND (s.enabled OR r.manual) FOR UPDATE OF r,s`, [run.id,owner]);
      if (valid.rowCount) {
        const sources = (await client.query(`SELECT * FROM search_run_sources WHERE run_id=$1`, [run.id])).rows;
        const allFailed = sources.every((s) => s.status === 'FAILED');
        const partial = sources.some((s) => ['FAILED','STALE'].includes(s.status) || ['BOUNDED','PARTIAL'].includes(s.coverage));
        const status = allFailed ? 'FAILED' : partial ? 'PARTIAL' : 'SUCCEEDED';
        const count = (await client.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE v.seen_at IS NULL)::int AS fresh FROM search_run_results r
          JOIN search_job_reviews v USING(workspace_id,search_id,job_id) WHERE r.run_id=$1`, [run.id])).rows[0];
        await client.query(`UPDATE search_runs SET status=$3,error=$4,finished_at=now(),lease_until=NULL WHERE id=$1 AND owner=$2`, [run.id,owner,status,allFailed ? 'SOURCE_READ_FAILED' : partial ? 'SOURCE_PARTIAL_FAILURE' : null]);
        await client.query(`UPDATE saved_job_searches SET last_run_at=now(),last_run_status=$3,last_result_count=$4,last_new_count=$5,last_error=$6,
          next_run_at=CASE WHEN enabled THEN now()+frequency_hours*interval '1 hour' ELSE NULL END,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND revision=$7`, [run.workspace_id,run.search_id,status,count.total,count.fresh,allFailed ? 'SOURCE_READ_FAILED' : partial ? 'SOURCE_PARTIAL_FAILURE' : null,run.revision]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  } finally { clearInterval(heartbeat); }
}

export async function latestSearchRun(workspaceId: string, searchId: string) {
  const run = (await pool.query(`SELECT r.id,r.status,r.finished_at AS "finishedAt",r.error,r.created_at AS "createdAt",r.revision
    FROM search_runs r WHERE workspace_id=$1 AND search_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`, [workspaceId,searchId])).rows[0];
  if (!run) return null;
  const sources = (await pool.query(`SELECT provider,status,coverage,fetched_at AS "fetchedAt",next_fetch_at AS "nextFetchAt",error,found FROM search_run_sources WHERE workspace_id=$1 AND run_id=$2 ORDER BY provider`, [workspaceId,run.id])).rows;
  return { ...run, sources };
}

/** Backfill in bounded batches; never merge or delete old records or applications. */
export async function maintainSearchData(): Promise<void> {
  const rows = (await pool.query(`SELECT j.id,j.workspace_id,j.canonical_url FROM jobs j WHERE j.canonical_url IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM job_identity_members m WHERE m.workspace_id=j.workspace_id AND m.job_id=j.id) LIMIT 100`)).rows;
  for (const row of rows) {
    let identityKey: string; let evidence: { type: string; url: string };
    try {
      const url = identityUrl(row.canonical_url);
      identityKey = jobIdentity(url);
      evidence = { type:'canonical-url',url };
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof Error && error.message === 'INVALID_JOB_URL')) throw error;
      identityKey = createHash('sha256').update(`historical-invalid-url:${row.workspace_id}:${row.id}`).digest('hex');
      evidence = { type:'invalid-canonical-url',url:row.canonical_url };
    }
    await pool.query(`INSERT INTO job_identity_members(workspace_id,job_id,identity_key,evidence) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING`, [row.workspace_id,row.id,identityKey,JSON.stringify(evidence)]);
  }
  await pool.query(`DELETE FROM search_query_cache WHERE last_used_at<now()-interval '7 days'`);
  await pool.query(`DELETE FROM search_runs r WHERE finished_at<now()-interval '30 days'
    AND id NOT IN(SELECT DISTINCT ON(search_id) id FROM search_runs ORDER BY search_id,created_at DESC,id DESC)
    AND id NOT IN(SELECT DISTINCT ON(old.search_id) old.id FROM search_runs old
      WHERE old.status IN ('SUCCEEDED','PARTIAL') AND EXISTS(SELECT 1 FROM search_run_results rr WHERE rr.run_id=old.id)
      ORDER BY old.search_id,old.created_at DESC,old.id DESC)`);
}

export async function processV2Preparations(onPrepare: OnPrepare): Promise<void> {
  const candidates = (await pool.query(`SELECT m.workspace_id,m.search_id,m.job_id,s.language,s.revision FROM saved_job_search_matches m JOIN saved_job_searches s ON s.workspace_id=m.workspace_id AND s.id=m.search_id
    JOIN jobs j ON j.workspace_id=m.workspace_id AND j.id=m.job_id
    WHERE s.matcher_version=2 AND s.enabled AND s.auto_prepare AND m.auto_prepared_at IS NULL AND m.auto_prepare_error IS DISTINCT FROM 'EXISTING_APPLICATION' AND (m.auto_prepare_next_attempt_at IS NULL OR m.auto_prepare_next_attempt_at<=now()) AND j.shortlist_decision NOT IN ('ARCHIVED','SKIPPED')
    AND EXISTS(SELECT 1 FROM (
      SELECT x.id FROM search_runs x WHERE x.workspace_id=s.workspace_id AND x.search_id=s.id AND x.revision=s.revision
        AND x.criteria @> jsonb_build_object('role',s.role,'company',s.company,'location',s.location,'workMode',s.work_mode,
          'matcherVersion',s.matcher_version,'includeRelated',s.include_related,'providerIds',s.provider_ids)
        AND (x.status='SUCCEEDED' OR EXISTS(SELECT 1 FROM search_run_results any_result WHERE any_result.run_id=x.id))
      ORDER BY x.created_at DESC,x.id DESC LIMIT 1
    ) latest JOIN search_run_results r ON r.run_id=latest.id
      WHERE r.workspace_id=m.workspace_id AND r.search_id=m.search_id AND r.job_id=m.job_id
        AND NOT r.unknown_location AND NOT (r.reasons ? 'ROLE_RELATED')
        AND NOT (s.work_mode<>'any' AND r.reasons ? 'WORK_MODE_UNKNOWN'))
    AND EXISTS(SELECT 1 FROM job_snapshots snap WHERE snap.workspace_id=j.workspace_id AND snap.job_id=j.id AND length(trim(snap.description_text))>0)
    ORDER BY m.auto_prepare_next_attempt_at NULLS FIRST,m.matched_at,m.search_id LIMIT 5`)).rows;
  for (const c of candidates) {
    const client = await pool.connect(); let locked = false;
    try {
      const identity = (await client.query(`SELECT identity_key FROM job_identity_members WHERE workspace_id=$1 AND job_id=$2`, [c.workspace_id,c.job_id])).rows[0]?.identity_key ?? c.job_id;
      const lock = `search-preparation:${c.workspace_id}:${identity}`;
      locked = (await client.query(`SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked`, [lock])).rows[0]?.locked;
      if (!locked) continue;
      try {
        const allowed = (await client.query(`SELECT 1 FROM saved_job_searches WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND enabled AND auto_prepare`, [c.workspace_id,c.search_id,c.revision])).rowCount;
        if (!allowed) continue;
        const existing = (await client.query(`SELECT a.id FROM applications a LEFT JOIN job_identity_members im ON im.workspace_id=a.workspace_id AND im.job_id=a.job_id
          WHERE a.workspace_id=$1 AND (a.job_id=$2 OR im.identity_key=$3) LIMIT 1`, [c.workspace_id,c.job_id,identity])).rowCount;
        const alreadyPrepared = (await client.query(`SELECT 1 FROM saved_job_search_matches m LEFT JOIN job_identity_members im ON im.workspace_id=m.workspace_id AND im.job_id=m.job_id
          WHERE m.workspace_id=$1 AND m.auto_prepared_at IS NOT NULL AND (m.job_id=$2 OR im.identity_key=$3) LIMIT 1`, [c.workspace_id,c.job_id,identity])).rowCount;
        if (existing) {
          await client.query(`UPDATE saved_job_search_matches m SET auto_prepare_error='EXISTING_APPLICATION',auto_prepare_next_attempt_at=NULL
            WHERE m.workspace_id=$1 AND (m.job_id=$2 OR EXISTS(SELECT 1 FROM job_identity_members im WHERE im.workspace_id=m.workspace_id AND im.job_id=m.job_id AND im.identity_key=$3))`, [c.workspace_id,c.job_id,identity]);
          continue;
        }
        if (alreadyPrepared) {
          await client.query(`UPDATE saved_job_search_matches m SET auto_prepared_at=coalesce(m.auto_prepared_at,now()),auto_prepare_error=NULL,auto_prepare_next_attempt_at=NULL
            WHERE m.workspace_id=$1 AND (m.job_id=$2 OR EXISTS(SELECT 1 FROM job_identity_members im WHERE im.workspace_id=m.workspace_id AND im.job_id=m.job_id AND im.identity_key=$3))`, [c.workspace_id,c.job_id,identity]);
          continue;
        }
        // Reserve against a single installation-wide UTC-day cap. End this short
        // transaction before invoking application preparation (which may be slow).
        await client.query('BEGIN');
        try {
          await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('search-preparation-daily-installation',0))`);
          const current = await client.query(`SELECT 1 FROM saved_job_searches WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND enabled AND auto_prepare FOR SHARE`, [c.workspace_id,c.search_id,c.revision]);
          if (!current.rowCount) { await client.query('COMMIT'); continue; }
          const total = Number((await client.query(`SELECT coalesce(sum(attempted),0)::int AS total FROM search_preparation_budget WHERE day=(now() AT TIME ZONE 'UTC')::date`)).rows[0].total);
          if (total >= 10) { await client.query('COMMIT'); continue; }
          await client.query(`INSERT INTO search_preparation_budget(workspace_id,day,attempted) VALUES($1,(now() AT TIME ZONE 'UTC')::date,1)
            ON CONFLICT(workspace_id,day) DO UPDATE SET attempted=search_preparation_budget.attempted+1`, [c.workspace_id]);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        const preparing = await client.query(`UPDATE saved_job_search_matches m SET auto_prepare_next_attempt_at=now()+interval '24 hours',auto_prepare_error='PREPARING'
          WHERE m.workspace_id=$1 AND m.search_id=$2 AND m.job_id=$3 AND EXISTS(SELECT 1 FROM saved_job_searches s
            WHERE s.workspace_id=m.workspace_id AND s.id=m.search_id AND s.revision=$4 AND s.enabled AND s.auto_prepare) RETURNING m.job_id`, [c.workspace_id,c.search_id,c.job_id,c.revision]);
        if (!preparing.rowCount) continue;
        const stillCurrent = (await client.query(`SELECT 1 FROM saved_job_searches WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND enabled AND auto_prepare`, [c.workspace_id,c.search_id,c.revision])).rowCount;
        if (!stillCurrent) {
          await client.query(`UPDATE saved_job_search_matches SET auto_prepare_error=NULL,auto_prepare_next_attempt_at=NULL WHERE workspace_id=$1 AND search_id=$2 AND job_id=$3 AND auto_prepare_error='PREPARING'`, [c.workspace_id,c.search_id,c.job_id]);
          continue;
        }
        try {
          const outcome = await onPrepare(c.workspace_id,c.job_id,c.language);
          const state = outcome && typeof outcome === 'object' && 'status' in outcome ? (outcome as { status?: unknown }).status : null;
          if (state === 'NEEDS_REVIEW' || state === 'BLOCKED') {
            const reason = outcome && typeof outcome === 'object' && 'reason' in outcome && typeof (outcome as { reason?: unknown }).reason === 'string'
              ? (outcome as { reason: string }).reason : '';
            const safeReason = /^[A-Z0-9_:-]{1,80}$/.test(reason) ? reason : state === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : 'PREPARATION_BLOCKED';
            await client.query(`UPDATE saved_job_search_matches SET auto_prepare_error=$3,auto_prepare_attempts=auto_prepare_attempts+1,auto_prepare_next_attempt_at=now()+interval '24 hours' WHERE workspace_id=$1 AND job_id=$2`, [c.workspace_id,c.job_id,safeReason]);
            continue;
          }
          await client.query(`UPDATE saved_job_search_matches m SET auto_prepared_at=coalesce(m.auto_prepared_at,now()),auto_prepare_error=NULL,auto_prepare_next_attempt_at=NULL
            WHERE m.workspace_id=$1 AND (m.job_id=$2 OR EXISTS(SELECT 1 FROM job_identity_members im WHERE im.workspace_id=m.workspace_id AND im.job_id=m.job_id AND im.identity_key=$3))`, [c.workspace_id,c.job_id,identity]);
        } catch { await client.query(`UPDATE saved_job_search_matches SET auto_prepare_error='PREPARATION_FAILED',auto_prepare_attempts=auto_prepare_attempts+1 WHERE workspace_id=$1 AND job_id=$2`, [c.workspace_id,c.job_id]); }
      } finally { await client.query(`SELECT pg_advisory_unlock(hashtextextended($1,0))`, [lock]); locked = false; }
    } finally { client.release(locked); }
  }
}
