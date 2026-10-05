import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { performance } from 'node:perf_hooks';
import Fastify from 'fastify';

const root = new URL('../../../', import.meta.url);
const { Client } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_SEARCH_RESULTS_TEST_ADMIN_URL || process.env.CAREER_JOB_SEARCH_TEST_ADMIN_URL;
const databaseName = `career_searchres_${randomBytes(5).toString('hex')}`;

describe('search result SQL and local performance (disposable PostgreSQL)', { skip: !adminUrl, concurrency: false }, () => {
  let admin: import('pg').Client; let client: import('pg').Client; let database: typeof import('@career/db'); let routes: typeof import('../src/job-search-routes.js');
  let app: ReturnType<typeof Fastify>; let workspace: string; let performanceWorkspace: string; let activeWorkspace: string; let legacySearch: string; let resultSearch: string; let otherWorkspace: string;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const searchIds: string[] = [];
  const percentile95 = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1]!;

  before(async () => {
    const url = new URL(adminUrl!);
    assert.ok(['127.0.0.1', 'localhost', '::1'].includes(url.hostname), 'tests require loopback PostgreSQL');
    assert.equal(url.pathname, '/postgres', 'tests connect through the maintenance database only');
    admin = new Client({ connectionString: url.toString() }); await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`); url.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = url.toString();
    client = new Client({ connectionString: url.toString() }); await client.connect();
    for (const file of (await readdir(new URL('packages/db/migrations', root))).filter((name) => name.endsWith('.sql')).sort()) {
      await client.query(await readFile(new URL(`packages/db/migrations/${file}`, root), 'utf8'));
    }
    database = await import('@career/db'); routes = await import('../src/job-search-routes.js');
    app = Fastify();
    workspace = randomUUID(); performanceWorkspace = randomUUID(); otherWorkspace = randomUUID(); activeWorkspace = workspace;
    await client.query('INSERT INTO workspaces(id) VALUES($1),($2),($3)', [workspace, performanceWorkspace, otherWorkspace]);
    const created = (await client.query(`INSERT INTO saved_job_searches(workspace_id,role,enabled,auto_prepare,matcher_version,provider_ids)
      VALUES($1,'legacy QA',false,false,1,'["remotive","arbeitnow"]'::jsonb) RETURNING id`, [workspace])).rows[0];
    legacySearch = created.id; searchIds.push(legacySearch);
    const current = (await client.query(`INSERT INTO saved_job_searches(workspace_id,role,enabled,auto_prepare,matcher_version,provider_ids)
      VALUES($1,'QA engineer',false,false,2,'["remotive","arbeitnow"]'::jsonb) RETURNING id`, [performanceWorkspace])).rows[0];
    resultSearch = current.id; searchIds.push(resultSearch);
    for (let i = 0; i < 19; i += 1) {
      const extra = (await client.query(`INSERT INTO saved_job_searches(workspace_id,role,enabled,auto_prepare,matcher_version)
        VALUES($1,$2,false,false,2) RETURNING id`, [performanceWorkspace, `Synthetic role ${i}`])).rows[0];
      searchIds.push(extra.id);
    }

    await client.query(`INSERT INTO saved_job_searches(workspace_id,role,enabled,auto_prepare,matcher_version)
      VALUES($1,'private workspace job',false,false,2)`, [otherWorkspace]);
    const runId = randomUUID();
    await client.query(`INSERT INTO search_runs(id,workspace_id,search_id,revision,criteria,status,finished_at)
      VALUES($1,$2,$3,1,'{"role":"QA engineer","company":null,"location":null,"workMode":"any","includeRelated":false,"matcherVersion":2,"providerIds":["remotive","arbeitnow"]}','SUCCEEDED',now())`, [runId, performanceWorkspace, resultSearch]);
    const otherSearch = (await client.query(`SELECT id FROM saved_job_searches WHERE workspace_id=$1`, [otherWorkspace])).rows[0].id;
    await client.query(`INSERT INTO search_runs(workspace_id,search_id,revision,criteria,status,finished_at)
      VALUES($1,$2,1,'{"role":"private workspace job","company":null,"location":null,"workMode":"any","includeRelated":false,"matcherVersion":2,"providerIds":["remotive","arbeitnow"]}','SUCCEEDED',now())`, [otherWorkspace, otherSearch]);

    await client.query(`INSERT INTO jobs(workspace_id,company,title,location,canonical_url,availability,shortlist_decision,created_at)
      SELECT $1,'Synthetic Company '||(n%80),'QA Engineer '||n,'Remote — Spain',
        'https://jobs.example.test/v080/'||n,'OPEN',
        CASE n WHEN 10 THEN 'ARCHIVED'::shortlist_decision WHEN 11 THEN 'SHORTLISTED'::shortlist_decision
          WHEN 9997 THEN 'ARCHIVED'::shortlist_decision WHEN 9998 THEN 'SHORTLISTED'::shortlist_decision ELSE 'UNREVIEWED'::shortlist_decision END,
        now()-n*interval '1 minute'
      FROM generate_series(1,10000) n`, [performanceWorkspace]);
    await client.query(`INSERT INTO job_identity_members(workspace_id,job_id,identity_key,evidence)
      SELECT workspace_id,id,
        CASE WHEN canonical_url LIKE '%/9995' OR canonical_url LIKE '%/9996' THEN repeat('a',64)
             WHEN canonical_url LIKE '%/9997' OR canonical_url LIKE '%/9998' THEN repeat('b',64)
             ELSE md5(id::text) END,
        '{"type":"canonical-url","synthetic":true}'::jsonb FROM jobs WHERE workspace_id=$1`, [performanceWorkspace]);
    await client.query(`INSERT INTO search_run_results(workspace_id,run_id,search_id,job_id,score,reasons,location_status,unknown_location,posted_at,sources)
      SELECT $1,$2,$3,j.id,
        CASE WHEN j.canonical_url LIKE '%/9995' OR j.canonical_url LIKE '%/9996' OR j.canonical_url LIKE '%/9997' OR j.canonical_url LIKE '%/9998' THEN 100 ELSE (substring(j.canonical_url from '[0-9]+$')::int%100) END,
        '["ROLE_EXACT"]'::jsonb,'compatible',false,j.created_at,'[]'::jsonb FROM jobs j WHERE j.workspace_id=$1`, [performanceWorkspace, runId, resultSearch]);
    await client.query(`INSERT INTO search_job_reviews(workspace_id,search_id,job_id,seen_at)
      SELECT $1,$2,j.id,CASE WHEN substring(j.canonical_url from '[0-9]+$')::int%3=0 THEN now() ELSE NULL END FROM jobs j WHERE j.workspace_id=$1`, [performanceWorkspace, resultSearch]);
    await client.query(`INSERT INTO saved_job_search_matches(workspace_id,search_id,job_id)
      SELECT $1,$2,j.id FROM jobs j WHERE j.workspace_id=$1`, [performanceWorkspace, resultSearch]);
    await client.query(`INSERT INTO jobs(workspace_id,company,title,canonical_url,availability,shortlist_decision)
      VALUES($1,'Legacy Co','Archived legacy QA','https://jobs.example.test/v080/10','OPEN','ARCHIVED'),
        ($1,'Legacy Co','Saved legacy QA','https://jobs.example.test/v080/11','OPEN','SHORTLISTED'),
        ($1,'Legacy Co','New legacy QA','https://jobs.example.test/v080/12','OPEN','UNREVIEWED'),
        ($1,'Legacy Co','Seen legacy QA','https://jobs.example.test/v080/13','OPEN','UNREVIEWED'),
        ($1,'Legacy Co','Skipped legacy QA','https://jobs.example.test/v080/14','OPEN','SKIPPED')`, [workspace]);
    await client.query(`INSERT INTO saved_job_search_matches(workspace_id,search_id,job_id)
      SELECT $1,$2,id FROM jobs WHERE workspace_id=$1 AND canonical_url IN (
        'https://jobs.example.test/v080/10','https://jobs.example.test/v080/11','https://jobs.example.test/v080/12','https://jobs.example.test/v080/13','https://jobs.example.test/v080/14')`, [workspace, legacySearch]);
    await client.query(`INSERT INTO search_job_reviews(workspace_id,search_id,job_id,seen_at)
      SELECT $1,$2,id,now() FROM jobs WHERE workspace_id=$1 AND canonical_url='https://jobs.example.test/v080/13'`, [workspace, legacySearch]);
    const otherJob = (await client.query(`INSERT INTO jobs(workspace_id,company,title,availability) VALUES($1,'Other tenant','Private listing','OPEN') RETURNING id`, [otherWorkspace])).rows[0].id;
    const otherRun = (await client.query('SELECT id FROM search_runs WHERE workspace_id=$1', [otherWorkspace])).rows[0].id;
    await client.query(`INSERT INTO search_run_results(workspace_id,run_id,search_id,job_id,score,reasons,location_status)
      VALUES($1,$2,$3,$4,100,'["ROLE_EXACT"]','compatible')`, [otherWorkspace, otherRun, otherSearch, otherJob]);
    await client.query(`INSERT INTO search_job_reviews(workspace_id,search_id,job_id) VALUES($1,$2,$3)`, [otherWorkspace, otherSearch, otherJob]);
    const metadataJob = (await client.query(`SELECT id FROM jobs WHERE workspace_id=$1 AND canonical_url='https://jobs.example.test/v080/9996'`, [performanceWorkspace])).rows[0].id;
    await client.query(`INSERT INTO applications(workspace_id,job_id,company,role,state)
      VALUES($1,$2,'Synthetic Company 76','QA Engineer 9996','IN_PROGRESS')`, [performanceWorkspace, metadataJob]);
    routes.registerJobSearchRoutes(app, () => activeWorkspace);
  });

  after(async () => {
    await app?.close(); await database?.pool.end(); await client?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH(FORCE)`); await admin.end(); }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  test('legacy views, review state, and tenant scoping use persisted SQL rows', async () => {
    activeWorkspace = workspace;
    const request = async (view: string) => app.inject(`/api/v1/job-searches/${legacySearch}/results?view=${view}&limit=20`);
    const all = await request('all'); assert.equal(all.statusCode, 200); assert.equal(all.json().total, 4);
    assert.equal((await request('saved')).json().total, 1);
    assert.equal((await request('archived')).json().total, 1);
    assert.equal((await request('new')).json().total, 1);
    const freshJob = (await client.query(`SELECT id FROM jobs WHERE workspace_id=$1 AND canonical_url='https://jobs.example.test/v080/12'`, [workspace])).rows[0].id;
    const service = await import('../src/search-results.js');
    assert.equal(await service.reviewSearchResult(workspace, legacySearch, freshJob), true);
    assert.equal((await request('new')).json().total, 0);
    const isolated = await app.inject('/api/v1/job-searches/results?view=all&limit=20');
    assert.equal(isolated.statusCode, 200);
    assert.ok(!JSON.stringify(isolated.json()).includes('Private listing'));
    const inaccessible = await app.inject(`/api/v1/job-searches/${resultSearch}/results?view=all`);
    assert.equal(inaccessible.statusCode, 404, 'another workspace cannot open the synthetic result search');
    assert.equal((await service.searchResults(otherWorkspace, null, { limit: '20' })).total, 1);
  });

  test('strong identity duplicates group, but conflicting saved/archive decisions stay separate', async () => {
    activeWorkspace = performanceWorkspace;
    const initialStarted = performance.now();
    const page = await app.inject(`/api/v1/job-searches/${resultSearch}/results?view=all&limit=100`);
    const firstGroupQueryMs = performance.now() - initialStarted;
    assert.ok(firstGroupQueryMs < 3000, `Cold first result query took ${firstGroupQueryMs.toFixed(1)}ms`);
    assert.equal(page.statusCode, 200, page.body);
    const items = page.json().items as Array<{ groupId: string; duplicateCount: number; shortlistDecision: string; canonicalUrl: string; identityConflict: boolean; applicationId: string | null; applicationState: string | null; documentId: string | null; documentApprovalStatus: string | null }>;
    const strongGroup = items.filter((item) => item.canonicalUrl.endsWith('/9995') || item.canonicalUrl.endsWith('/9996'));
    assert.equal(strongGroup.length, 1);
    assert.equal(strongGroup[0]!.duplicateCount, 2);
    const conflictAll = items.filter((item) => item.canonicalUrl.endsWith('/9997') || item.canonicalUrl.endsWith('/9998'));
    const archivedPage = await app.inject(`/api/v1/job-searches/${resultSearch}/results?view=archived&limit=100`);
    const conflictArchived = archivedPage.json().items.filter((item: { canonicalUrl: string }) => item.canonicalUrl.endsWith('/9997') || item.canonicalUrl.endsWith('/9998'));
    assert.equal(conflictAll.length, 1); assert.equal(conflictAll[0]!.shortlistDecision, 'SHORTLISTED'); assert.equal(conflictAll[0]!.identityConflict, true);
    assert.equal(conflictArchived.length, 1); assert.equal(conflictArchived[0]!.shortlistDecision, 'ARCHIVED');
    assert.notEqual(conflictAll[0]!.groupId, conflictArchived[0]!.groupId, 'conflicting history remains in separate identity groups');
    const applicationResult = items.find((item) => item.canonicalUrl.endsWith('/9996'));
    assert.ok(applicationResult?.applicationId, 'result includes its optional latest application id');
    assert.equal(applicationResult?.applicationState, 'IN_PROGRESS');
    assert.equal(applicationResult?.documentId, null); assert.equal(applicationResult?.documentApprovalStatus, null);
    console.info(`Synthetic first grouped result query without manual ANALYZE: ${firstGroupQueryMs.toFixed(1)}ms`);
  });

  test('job summary badges stay scoped to the job and language, and dismissed artifacts are not ready', async () => {
    activeWorkspace = workspace;
    const result = await app.inject(`/api/v1/job-searches/${legacySearch}/results?view=all`);
    const jobId = result.json().items[0].id;
    const connection = (await client.query(`INSERT INTO ai_connections(workspace_id,provider,account_fingerprint,state) VALUES($1,'codex',$2,'UNAVAILABLE') RETURNING id`, [workspace, 'a'.repeat(64)])).rows[0].id;
    const consent = (await client.query(`INSERT INTO ai_consents(workspace_id,connection_id,provider,account_fingerprint,connection_revision,revision,operation,data_categories,notice_version) VALUES($1,$2,'codex',$3,1,1,'JOB_ANALYSIS','[]','test') RETURNING id`, [workspace,connection,'a'.repeat(64)])).rows[0].id;
    for (const locale of ['es','en']) {
      const run = (await client.query(`INSERT INTO ai_runs(workspace_id,connection_id,consent_id,provider,connection_revision,consent_revision,account_fingerprint,operation,origin,status,idempotency_key,content_identity,account_lock_key,snapshot,snapshot_hash,input_versions,reserved_day)
        VALUES($1,$2,$3,'codex',1,1,$4,'JOB_ANALYSIS','MANUAL',$5,$6,$4,$4,$7,$4,'{}',CURRENT_DATE) RETURNING id`, [workspace,connection,consent,'a'.repeat(64),locale === 'es' ? 'QUEUED' : 'SUCCEEDED',randomUUID(),JSON.stringify({locale,job:{jobId}})])).rows[0].id;
      if (locale === 'en') await client.query(`INSERT INTO ai_artifacts(workspace_id,run_id,schema_version,prompt_version,locale,output,sources) VALUES($1,$2,1,'test','en','{}','{}')`, [workspace,run]);
    }
    const read = async () => (await app.inject(`/api/v1/job-searches/${legacySearch}/results?view=all`)).json().items;
    const items = await read();
    assert.deepEqual(items.find((item: {id:string}) => item.id === jobId).aiSummaryStates, {es:'QUEUED',en:'SAVED'});
    assert.ok(items.filter((item: {id:string}) => item.id !== jobId).every((item: {aiSummaryStates:object}) => Object.keys(item.aiSummaryStates).length === 0));
    await client.query(`UPDATE ai_artifacts SET state='DISMISSED' WHERE workspace_id=$1`,[workspace]);
    assert.notEqual((await read()).find((item: {id:string}) => item.id === jobId).aiSummaryStates.en,'SAVED');
    await client.query('DELETE FROM ai_runs WHERE workspace_id=$1',[workspace]);
    await client.query('DELETE FROM ai_consents WHERE workspace_id=$1',[workspace]);
    await client.query('DELETE FROM ai_connections WHERE workspace_id=$1',[workspace]);
  });

  test('ranking pagination is stable and bounded to the requested page', async () => {
    activeWorkspace = performanceWorkspace;
    const first = await app.inject(`/api/v1/job-searches/${resultSearch}/results?view=all&limit=20&offset=0`);
    const second = await app.inject(`/api/v1/job-searches/${resultSearch}/results?view=all&limit=20&offset=20`);
    assert.equal(first.statusCode, 200); assert.equal(first.json().items.length, 20); assert.equal(second.json().items.length, 20);
    assert.equal(first.json().total, second.json().total);
    const firstIds = new Set(first.json().items.map((item: { id: string }) => item.id));
    assert.ok(second.json().items.every((item: { id: string }) => !firstIds.has(item.id)));
    const repeated = await app.inject(`/api/v1/job-searches/${resultSearch}/results?view=all&limit=20&offset=0`);
    assert.deepEqual(repeated.json().items.map((item: { id: string }) => item.id), first.json().items.map((item: { id: string }) => item.id));
  });

  test('save POST, unread-list GET, and first results page p95 stay under one second with 10,000 jobs and 20 searches', async () => {
    activeWorkspace = performanceWorkspace;
    assert.equal((await client.query('SELECT count(*)::int AS n FROM jobs WHERE workspace_id=$1', [performanceWorkspace])).rows[0].n, 10000);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM saved_job_searches WHERE workspace_id=$1', [performanceWorkspace])).rows[0].n, 20);
    const payload = () => ({ role: 'Synthetic engineer', company: null, location: null, workMode: 'any', frequencyHours: 24, enabled: false, autoPrepare: false, language: 'en', matcherVersion: 2, providerIds: ['remotive'], includeRelated: false, idempotencyKey: randomUUID() });
    const saveOne = async () => {
      const start = performance.now();
      const response = await app.inject({ method: 'POST', url: '/api/v1/job-searches', payload: payload() });
      const elapsed = performance.now() - start;
      assert.equal(response.statusCode, 201, response.body);
      await client.query('DELETE FROM saved_job_searches WHERE workspace_id=$1 AND id=$2', [performanceWorkspace, response.json().search.id]);
      return elapsed;
    };
    const firstPageOne = async () => {
      const start = performance.now();
      const response = await app.inject(`/api/v1/job-searches/${resultSearch}/results?view=all&limit=20&offset=0`);
      const elapsed = performance.now() - start;
      assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().items.length, 20);
      return elapsed;
    };
    const unreadListOne = async () => {
      const start = performance.now();
      const response = await app.inject('/api/v1/job-searches');
      const elapsed = performance.now() - start;
      assert.equal(response.statusCode, 200, response.body);
      const result = response.json().searches.find((search: { id: string }) => search.id === resultSearch);
      assert.ok(Number.isInteger(result?.lastNewCount), 'search-list GET includes its persisted unread count');
      return elapsed;
    };
    await saveOne(); await unreadListOne(); await firstPageOne(); // warm-up
    const saveTimes: number[] = []; const unreadTimes: number[] = []; const pageTimes: number[] = [];
    for (let i = 0; i < 30; i += 1) { saveTimes.push(await saveOne()); unreadTimes.push(await unreadListOne()); pageTimes.push(await firstPageOne()); }
    const saveP95 = percentile95(saveTimes); const unreadP95 = percentile95(unreadTimes); const pageP95 = percentile95(pageTimes);
    console.info(`Synthetic local benchmark (10,000 jobs, 20 searches, n=30): save POST p95=${saveP95.toFixed(1)}ms; unread-list GET p95=${unreadP95.toFixed(1)}ms; first-page p95=${pageP95.toFixed(1)}ms`);
    assert.ok(saveP95 < 1000, `POST p95 ${saveP95.toFixed(1)}ms is at or over 1s`);
    assert.ok(unreadP95 < 1000, `unread-list GET p95 ${unreadP95.toFixed(1)}ms is at or over 1s`);
    assert.ok(pageP95 < 1000, `first-page p95 ${pageP95.toFixed(1)}ms is at or over 1s`);
  });
});
