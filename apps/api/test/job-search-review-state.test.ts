import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import Fastify from 'fastify';

const root = new URL('../../../', import.meta.url);
const { Client } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_JOB_SEARCH_TEST_ADMIN_URL;
const databaseName = `career_review_${randomBytes(5).toString('hex')}`;
const criteria = (role: string) => JSON.stringify({ role, company: null, location: null, workMode: 'any', includeRelated: false, matcherVersion: 2, providerIds: ['remotive', 'arbeitnow'] });

/** U02: one New definition across search inboxes (v1/v2, All), /jobs, summary labels and discovery counts. */
describe('consistent review state across surfaces (disposable PostgreSQL)', { skip: !adminUrl, concurrency: false }, () => {
  let admin: import('pg').Client; let client: import('pg').Client;
  let database: typeof import('@career/db'); let state: typeof import('../src/review-state.js'); let results: typeof import('../src/search-results.js');
  let app: ReturnType<typeof Fastify>; let activeWorkspace: string;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const ws = randomUUID(); const other = randomUUID();
  const search: Record<'a' | 'b' | 'legacy' | 'other', string> = { a: '', b: '', legacy: '', other: '' };
  const job: Record<string, string> = {};

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
    database = await import('@career/db'); state = await import('../src/review-state.js'); results = await import('../src/search-results.js');
    const routes = await import('../src/job-search-routes.js'); const discovery = await import('../src/discovery.js');
    await client.query('INSERT INTO workspaces(id) VALUES($1),($2)', [ws, other]);
    const addSearch = async (workspace: string, role: string, version: number) => (await client.query(`INSERT INTO saved_job_searches(workspace_id,role,enabled,auto_prepare,matcher_version,provider_ids)
      VALUES($1,$2,false,false,$3,'["remotive","arbeitnow"]'::jsonb) RETURNING id`, [workspace, role, version])).rows[0].id as string;
    search.a = await addSearch(ws, 'QA engineer', 2); search.b = await addSearch(ws, 'Test engineer', 2); search.legacy = await addSearch(ws, 'QA', 1); search.other = await addSearch(other, 'QA engineer', 2);
    const runs: Record<string, string> = {};
    for (const [key, workspace, role] of [['a', ws, 'QA engineer'], ['b', ws, 'Test engineer'], ['other', other, 'QA engineer']] as const) {
      runs[key] = (await client.query(`INSERT INTO search_runs(workspace_id,search_id,revision,criteria,status,finished_at) VALUES($1,$2,1,$3,'SUCCEEDED',now()) RETURNING id`, [workspace, search[key], criteria(role)])).rows[0].id;
    }
    const addJob = async (name: string, workspace = ws, decision = 'UNREVIEWED', identity = name) => {
      job[name] = (await client.query(`INSERT INTO jobs(workspace_id,company,title,canonical_url,availability,shortlist_decision,discovered_at)
        VALUES($1::uuid,'Synthetic Co','QA Engineer '||$2,'https://jobs.example.test/u02/'||$2||'/'||$1::text,'OPEN',$3,now()) RETURNING id`, [workspace, name, decision])).rows[0].id;
      await client.query(`INSERT INTO job_identity_members(workspace_id,job_id,identity_key,evidence) VALUES($1,$2,$3,'{"synthetic":true}')`, [workspace, job[name], identity.padEnd(64, '0').slice(0, 64)]);
    };
    const match = async (key: 'a' | 'b' | 'other', name: string, workspace = ws) => {
      await client.query(`INSERT INTO search_run_results(workspace_id,run_id,search_id,job_id,score,reasons,location_status) VALUES($1,$2,$3,$4,50,'[]','compatible')`, [workspace, runs[key], search[key], job[name]]);
      await client.query(`INSERT INTO search_job_reviews(workspace_id,search_id,job_id) VALUES($1,$2,$3)`, [workspace, search[key], job[name]]);
      await client.query(`INSERT INTO saved_job_search_matches(workspace_id,search_id,job_id) VALUES($1,$2,$3)`, [workspace, search[key], job[name]]);
    };
    for (const name of ['shared', 'searchOnly', 'globalOnly', 'save', 'archive', 'legacyReviewed']) await addJob(name);
    await addJob('dupA', ws, 'UNREVIEWED', 'dup'); await addJob('dupB', ws, 'UNREVIEWED', 'dup');
    await addJob('conflictSaved', ws, 'SHORTLISTED', 'conflict'); await addJob('conflictOpen', ws, 'UNREVIEWED', 'conflict');
    await addJob('foreign', other, 'UNREVIEWED', 'dup');
    for (const name of ['shared', 'searchOnly', 'globalOnly', 'save', 'archive', 'legacyReviewed', 'dupA', 'conflictSaved']) await match('a', name);
    for (const name of ['shared', 'legacyReviewed', 'dupB', 'conflictOpen']) await match('b', name);
    await match('other', 'foreign', other);
    await client.query(`INSERT INTO saved_job_search_matches(workspace_id,search_id,job_id) VALUES($1,$2,$3)`, [ws, search.legacy, job.shared]);
    // Pre-0.8.1 state: reviewed from search A only, so jobs.seen_at was never written.
    await client.query(`UPDATE search_job_reviews SET seen_at=now() WHERE workspace_id=$1 AND search_id=$2 AND job_id=$3`, [ws, search.a, job.legacyReviewed]);
    app = Fastify(); activeWorkspace = ws;
    routes.registerJobSearchRoutes(app, () => activeWorkspace); discovery.registerDiscoveryRoutes(app, () => activeWorkspace);
  });

  after(async () => {
    await app?.close(); await database?.pool.end(); await client?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH(FORCE)`); await admin.end(); }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  const names = (ids: string[]) => Object.entries(job).filter(([, id]) => ids.includes(id)).map(([name]) => name).sort();
  const searchView = async (id: string, view: string) => {
    const response = await app.inject(`/api/v1/job-searches/${id}/results?view=${view}&limit=100`); assert.equal(response.statusCode, 200, response.body);
    return response.json() as { total: number; resultVersion: string; items: Array<{ id: string; seenAt: string | null; shortlistDecision: string }> };
  };
  const newIn = async (id: string) => names((await searchView(id, 'new')).items.map((item) => item.id));
  const combinedNew = async () => names(((await app.inject('/api/v1/job-searches/results?view=new&limit=100')).json() as { items: Array<{ id: string }> }).items.map((item) => item.id));
  const unread = async () => Object.fromEntries((((await app.inject('/api/v1/job-searches')).json()) as { searches: Array<{ id: string; lastNewCount: number }> }).searches.map((row) => [row.id, row.lastNewCount]));
  // Same filter as GET /api/v1/jobs?scope=new in server.ts.
  const jobsNew = async () => {
    const { and, eq, sql } = await import('drizzle-orm');
    const rows = await database.db.select({ id: database.jobs.id }).from(database.jobs).where(and(eq(database.jobs.workspaceId, ws), sql`${database.jobs.discoveredAt} is not null`, state.isNewJob(ws)));
    return names(rows.map((row) => row.id));
  };
  const discoveryUnread = async () => ((await app.inject('/api/v1/discovery')).json() as { unreadCount: number }).unreadCount;
  const label = async (name: string) => {
    const { eq } = await import('drizzle-orm');
    const rows = await database.db.select().from(database.jobs).where(eq(database.jobs.id, job[name]!));
    return (await state.withEffectiveSeenAt(database.db, ws, rows))[0]!.seenAt;
  };
  const surfaces = async () => ({ a: await newIn(search.a), b: await newIn(search.b), legacy: await newIn(search.legacy), all: await combinedNew(), jobs: await jobsNew(), discovery: await discoveryUnread(), unread: await unread() });

  test('legacy per-search reviews and saved decisions are not NEW on any surface', async () => {
    const now = await surfaces();
    assert.deepEqual(now.a, ['archive', 'dupA', 'globalOnly', 'save', 'searchOnly', 'shared']);
    assert.deepEqual(now.b, ['conflictOpen', 'dupB', 'shared'], 'a job reviewed in search A before 0.8.1 is not NEW in search B');
    assert.deepEqual(now.legacy, ['shared']);
    assert.deepEqual(now.jobs, ['archive', 'conflictOpen', 'dupA', 'dupB', 'globalOnly', 'save', 'searchOnly', 'shared']);
    assert.equal(now.discovery, now.jobs.length, 'discovery unread count matches the /jobs New list it links to');
    assert.deepEqual(now.all, ['archive', 'conflictOpen', 'dupA', 'globalOnly', 'save', 'searchOnly', 'shared'], 'the strong duplicate appears once in All');
    assert.deepEqual([now.unread[search.a], now.unread[search.b], now.unread[search.legacy]], [6, 3, 1]);
    assert.ok(await label('legacyReviewed'), 'the /jobs NEW label uses the same reviewed state');
    assert.ok(await label('conflictSaved'), 'a saved job carries no NEW label');
  });

  test('reviewing from one search clears the job from every search, All, /jobs and counts', async () => {
    const before = (await searchView(search.b, 'all')).resultVersion;
    assert.equal(await results.reviewSearchResult(ws, search.a, job.shared!), true);
    const now = await surfaces();
    for (const surface of [now.a, now.b, now.legacy, now.all, now.jobs]) assert.ok(!surface.includes('shared'));
    assert.deepEqual([now.unread[search.a], now.unread[search.b], now.unread[search.legacy], now.discovery], [5, 2, 0, 7]);
    assert.notEqual((await searchView(search.b, 'all')).resultVersion, before, 'other search result versions change so open lists reload');
    assert.ok(await label('shared'));
    const listed = (await searchView(search.b, 'all')).items.find((item) => item.id === job.shared);
    assert.ok(listed?.seenAt, 'the job stays in All with a reviewed timestamp');
  });

  test('reviewing from /jobs clears the job from search inboxes', async () => {
    assert.equal(await state.reviewJob(ws, job.globalOnly!), true);
    const now = await surfaces();
    for (const surface of [now.a, now.all, now.jobs]) assert.ok(!surface.includes('globalOnly'));
    assert.equal(now.unread[search.a], 4);
    assert.equal((await client.query('SELECT seen_at FROM search_job_reviews WHERE search_id=$1 AND job_id=$2', [search.a, job.globalOnly])).rows[0].seen_at instanceof Date, true);
  });

  test('save, archive and restore leave New consistently; restore returns to All as reviewed', async () => {
    assert.equal((await state.decideJob(ws, job.save!, 'SHORTLISTED'))?.shortlistDecision, 'SHORTLISTED');
    assert.equal((await state.decideJob(ws, job.archive!, 'ARCHIVED'))?.shortlistDecision, 'ARCHIVED');
    let now = await surfaces();
    for (const surface of [now.a, now.all, now.jobs]) { assert.ok(!surface.includes('save')); assert.ok(!surface.includes('archive')); }
    assert.equal(now.unread[search.a], 2);
    assert.deepEqual(names((await searchView(search.a, 'saved')).items.map((item) => item.id)), ['conflictSaved', 'save']);
    assert.deepEqual(names((await searchView(search.a, 'archived')).items.map((item) => item.id)), ['archive']);
    const restored = await state.decideJob(ws, job.archive!, 'UNREVIEWED');
    assert.equal(restored?.shortlistDecision, 'UNREVIEWED'); assert.ok(restored?.seenAt, 'restore records the review');
    now = await surfaces();
    assert.ok(!now.a.includes('archive') && !now.jobs.includes('archive'), 'a restored job does not return to New');
    assert.ok((await searchView(search.a, 'all')).items.some((item) => item.id === job.archive), 'a restored job is back in All');
    assert.equal(now.unread[search.a], 2);
  });

  test('strong duplicates share review state; conflicting identities and other workspaces do not', async () => {
    assert.equal(await results.reviewSearchResult(ws, search.a, job.dupA!), true);
    let now = await surfaces();
    assert.ok(!now.b.includes('dupB') && !now.jobs.includes('dupB'), 'the same vacancy found by another search is reviewed too');
    assert.equal((await client.query('SELECT seen_at FROM jobs WHERE id=$1', [job.foreign])).rows[0].seen_at, null, 'same identity key in another workspace is untouched');
    assert.equal(await state.reviewJob(ws, job.conflictSaved!), true);
    now = await surfaces();
    assert.ok(now.b.includes('conflictOpen') && now.jobs.includes('conflictOpen'), 'conflicting decisions keep separate review state');
    assert.equal(await state.reviewJob(ws, job.foreign!), false, 'a job from another workspace cannot be reviewed');
    assert.equal(await results.reviewSearchResult(ws, null, job.foreign!), false);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/job-searches/${search.other}/results/${job.foreign}/review` })).statusCode, 404);
    activeWorkspace = other;
    assert.deepEqual((await searchView(search.other, 'new')).items.map((item) => item.id), [job.foreign]);
    activeWorkspace = ws;
  });

  test('the reviewed state survives a fresh connection (reload/restart)', async () => {
    const fresh = new Client({ connectionString: process.env.DATABASE_URL }); await fresh.connect();
    try {
      const rows = (await fresh.query(`SELECT j.id FROM jobs j WHERE j.workspace_id=$1 AND j.discovered_at IS NOT NULL AND ${state.isNewJobSql('j', '$1')}`, [ws])).rows;
      assert.deepEqual(names(rows.map((row) => row.id)), ['conflictOpen', 'searchOnly']);
    } finally { await fresh.end(); }
    const now = await surfaces();
    assert.deepEqual(now.all, ['conflictOpen', 'searchOnly']); assert.deepEqual(now.jobs, ['conflictOpen', 'searchOnly']);
    assert.equal(now.discovery, 2); assert.deepEqual([now.unread[search.a], now.unread[search.b], now.unread[search.legacy]], [1, 1, 0]);
  });
});
