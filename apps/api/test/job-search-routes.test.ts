import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const root = new URL('../../../', import.meta.url);
const { Client } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_JOB_SEARCH_TEST_ADMIN_URL;
const name = `career_job_search_${randomBytes(6).toString('hex')}`;
const fixture = { externalId: 'fictional-job-42', title: 'Product Designer', company: 'Fictional Studio', location: null, workMode: 'remote', url: 'https://remotive.com/remote-jobs/design/fictional-job-42', postedAt: '2026-10-01T00:00:00.000Z', description: 'Design accessible interfaces.', raw: { remote: true } };

describe('saved job searches with a disposable database and cached fictional feeds', { skip: !adminUrl, concurrency: false }, () => {
  let admin: InstanceType<typeof Client>; let client: InstanceType<typeof Client>; let pool: { end(): Promise<void> };
  let workspace: string; let module: typeof import('../src/job-search-routes.js'); let sources: typeof import('../src/job-search.js'); let dbmod: typeof import('@career/db');
  let calls: Array<{ workspaceId: string; jobId: string; locale: string }>; let failPrepare = false;
  const originalDatabase = process.env.DATABASE_URL;

  before(async () => {
    const url = new URL(adminUrl!);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.ok(['postgres', 'template1'].includes(url.pathname.slice(1)), 'maintenance database required');
    admin = new Client({ connectionString: url.toString() }); await admin.connect();
    await admin.query(`create database "${name}"`); url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString(); client = new Client({ connectionString: url.toString() }); await client.connect();
    for (const file of (await readdir(new URL('packages/db/migrations', root))).filter((f) => f.endsWith('.sql')).sort()) await client.query(await readFile(new URL(`packages/db/migrations/${file}`, root), 'utf8'));
    [module, sources, dbmod] = await Promise.all([import('../src/job-search-routes.js'), import('../src/job-search.js'), import('@career/db')]);
    pool = dbmod.pool;
  });
  after(async () => {
    await pool?.end(); await client?.end();
    if (admin) { await admin.query(`drop database if exists "${name}" with (force)`); await admin.end(); }
    if (originalDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabase;
  });
  beforeEach(async () => {
    await client.query('delete from workspaces'); await client.query('delete from job_search_provider_cache'); workspace = randomUUID(); calls = []; failPrepare = false;
    await client.query('insert into workspaces(id) values($1)', [workspace]);
    for (const provider of ['remotive', 'arbeitnow']) await client.query('insert into job_search_provider_cache(provider,payload,coverage,fetched_at,next_fetch_at) values($1,$2::jsonb,\'COMPLETE\',now(),now()+interval \'6 hours\')', [provider, JSON.stringify(provider === 'remotive' ? [fixture] : [])]);
  });
  const server = () => {
    const app = Fastify();
    module.registerJobSearchRoutes(app, () => workspace, async (workspaceId, jobId, locale) => {
      calls.push({ workspaceId, jobId, locale });
      if (failPrepare) { failPrepare = false; throw new Error('fictional preparation failure'); }
    });
    return app;
  };
  const payload = (patch: Record<string, unknown> = {}) => ({ role: 'designer', company: null, location: 'Spain', workMode: 'remote', frequencyHours: 12, enabled: true, autoPrepare: false, language: 'en', ...patch });

  test('rejects oversized criteria on create and edit without truncating or changing the search', async () => {
    const app = server();
    try {
      const created = await app.inject({ method: 'POST', url: '/api/v1/job-searches', payload: payload({ role: 'a'.repeat(200), enabled: false }) });
      assert.equal(created.statusCode, 201); const id = created.json().search.id;
      for (const field of ['role', 'company', 'location']) {
        const oversized = { [field]: 'b'.repeat(201) };
        assert.equal((await app.inject({ method: 'POST', url: '/api/v1/job-searches', payload: payload({ ...oversized, enabled: false }) })).statusCode, 400);
        assert.equal((await app.inject({ method: 'PATCH', url: `/api/v1/job-searches/${id}`, payload: oversized })).statusCode, 400);
      }
      const rows = (await app.inject('/api/v1/job-searches')).json().searches;
      assert.equal(rows.length, 1); assert.equal(rows[0].role, 'a'.repeat(200));
    } finally { await app.close(); }
  });

  test('role-only create accepts null optional fields, uses cached feeds, and preserves archive/seen state', async () => {
    const app = server();
    try {
      const response = await app.inject({ method: 'POST', url: '/api/v1/job-searches', payload: payload() });
      assert.equal(response.statusCode, 201); const created = response.json(); const id = created.search.id;
      assert.equal(created.refresh.matched, 1); assert.equal(created.search.lastRunStatus, 'CACHED'); assert.equal(calls.length, 0);
      const job = (await client.query('select id from jobs where workspace_id=$1', [workspace])).rows[0]!;
      await client.query("update jobs set shortlist_decision='ARCHIVED', seen_at=now() where id=$1", [job.id]);
      const result = await app.inject(`/api/v1/job-searches/${id}/results?limit=20&offset=0`);
      const body = result.json(); assert.equal(body.total, 1); assert.equal(body.items[0].shortlistDecision, 'ARCHIVED'); assert.ok(body.items[0].seenAt); assert.equal(body.items[0].unknownLocation, true);
      assert.equal(body.items[0].sources[0].name, 'Remotive'); assert.equal(body.items[0].sources[0].url, fixture.url);
      assert.equal(body.items[0].autoPreparedAt, null); assert.equal(body.items[0].autoPrepareError, null);
      assert.equal((await client.query('select count(*)::int as count from job_snapshots where job_id=$1', [job.id])).rows[0].count, 1);
      const revised = { ...fixture, title: 'Product Designer II', url: 'https://remotive.com/remote-jobs/design/fictional-job-42-v2', description: 'Design reliable, accessible interfaces.' };
      await client.query('update job_search_provider_cache set payload=$1::jsonb where provider=\'remotive\'', [JSON.stringify([revised])]);
      await client.query('update saved_job_searches set next_run_at=now()-interval \'1 second\' where id=$1', [id]);
      const refreshed = await app.inject({ method: 'POST', url: `/api/v1/job-searches/${id}/refresh` }); assert.equal(refreshed.statusCode, 200);
      const updatedJob = (await client.query('select * from jobs where workspace_id=$1', [workspace])).rows[0];
      assert.equal(updatedJob.id, job.id); assert.equal(updatedJob.canonical_url, revised.url); assert.equal(updatedJob.title, revised.title);
      assert.equal(updatedJob.shortlist_decision, 'ARCHIVED'); assert.ok(updatedJob.seen_at);
      assert.equal((await client.query('select count(*)::int as count from jobs where workspace_id=$1', [workspace])).rows[0].count, 1);
      assert.equal((await client.query('select count(*)::int as count from job_snapshots where job_id=$1', [job.id])).rows[0].count, 2);
    } finally { await app.close(); }
  });

  test('enabling auto-prepare after a cached match re-evaluates once and records success', async () => {
    const app = server();
    try {
      const created = (await app.inject({ method: 'POST', url: '/api/v1/job-searches', payload: payload() })).json();
      const id = created.search.id;
      const enabled = await app.inject({ method: 'PATCH', url: `/api/v1/job-searches/${id}`, payload: { autoPrepare: true } });
      assert.equal(enabled.statusCode, 200); assert.equal(calls.length, 1); assert.equal(calls[0]?.locale, 'en');
      await app.inject({ method: 'PATCH', url: `/api/v1/job-searches/${id}`, payload: { autoPrepare: true } });
      assert.equal(calls.length, 1);
      const status = (await client.query('select auto_prepared_at,auto_prepare_attempts from saved_job_search_matches where search_id=$1', [id])).rows[0];
      assert.ok(status.auto_prepared_at); assert.equal(status.auto_prepare_attempts, 0);
    } finally { await app.close(); }
  });

  test('failed preparation is recorded and retried on the next refresh', async () => {
    const app = server();
    try {
      failPrepare = true;
      const created = (await app.inject({ method: 'POST', url: '/api/v1/job-searches', payload: payload({ autoPrepare: true, language: 'es' }) })).json();
      const id = created.search.id;
      let status = (await client.query('select auto_prepared_at,auto_prepare_attempts,auto_prepare_error from saved_job_search_matches where search_id=$1', [id])).rows[0];
      assert.equal(status.auto_prepared_at, null); assert.equal(status.auto_prepare_attempts, 1); assert.equal(status.auto_prepare_error, 'PREPARATION_FAILED');
      await client.query('update saved_job_searches set next_run_at=now()-interval \'1 second\' where id=$1', [id]);
      await client.query('update saved_job_search_matches set auto_prepare_next_attempt_at=now()-interval \'1 second\' where search_id=$1', [id]);
      await app.inject({ method: 'POST', url: `/api/v1/job-searches/${id}/refresh` });
      status = (await client.query('select auto_prepared_at,auto_prepare_attempts,auto_prepare_error from saved_job_search_matches where search_id=$1', [id])).rows[0];
      assert.ok(status.auto_prepared_at); assert.equal(status.auto_prepare_attempts, 1); assert.equal(status.auto_prepare_error, null);
      assert.equal(calls.at(-1)?.locale, 'es');
    } finally { await app.close(); }
  });

  test('paused saved search persists without refresh reservation or provider request', async () => {
    const app = server();
    try {
      const response = await app.inject({ method: 'POST', url: '/api/v1/job-searches', payload: payload({ enabled: false }) });
      assert.equal(response.statusCode, 201); const search = response.json().search;
      assert.equal(search.enabled, false); assert.equal(search.lastRunAt, null); assert.equal(search.nextRunAt, null);
      assert.equal((await client.query('select count(*)::int as count from jobs where workspace_id=$1', [workspace])).rows[0].count, 0);
    } finally { await app.close(); }
  });

  test('results use real totals and limit/offset pagination', async () => {
    const app = server();
    try {
      const fixtures = Array.from({ length: 25 }, (_, index) => ({ ...fixture, externalId: `fictional-job-${index}`, title: `Product Designer ${index}`, url: `https://remotive.com/remote-jobs/design/fictional-job-${index}` }));
      await client.query('update job_search_provider_cache set payload=$1::jsonb where provider=\'remotive\'', [JSON.stringify(fixtures)]);
      const created = (await app.inject({ method: 'POST', url: '/api/v1/job-searches', payload: payload({ location: null }) })).json();
      const first = (await app.inject(`/api/v1/job-searches/${created.search.id}/results?limit=20&offset=0`)).json();
      const second = (await app.inject(`/api/v1/job-searches/${created.search.id}/results?limit=20&offset=20`)).json();
      assert.equal(first.total, 25); assert.equal(first.items.length, 20); assert.equal(second.total, 25); assert.equal(second.items.length, 5);
      assert.notEqual(first.items[0].id, second.items[0].id);
    } finally { await app.close(); }
  });

  test('duplicate feed entries reuse one inbox job and deduplicate identical source links', async () => {
    const app = server();
    try {
      const duplicates = [{ ...fixture, externalId: 'duplicate-a' }, { ...fixture, externalId: 'duplicate-b' }];
      await client.query('update job_search_provider_cache set payload=$1::jsonb where provider=\'remotive\'', [JSON.stringify(duplicates)]);
      const created = (await app.inject({ method: 'POST', url: '/api/v1/job-searches', payload: payload() })).json();
      const result = (await app.inject(`/api/v1/job-searches/${created.search.id}/results?limit=20&offset=0`)).json();
      assert.equal(created.refresh.matched, 1); assert.equal(created.search.lastResultCount, 1); assert.equal(result.total, 1); assert.equal(result.items[0].sources.length, 1);
      assert.equal((await client.query('select count(*)::int as count from job_search_sources where workspace_id=$1', [workspace])).rows[0].count, 2);
      assert.equal((await client.query('select count(*)::int as count from jobs where workspace_id=$1', [workspace])).rows[0].count, 1);
    } finally { await app.close(); }
  });

  test('bounded provider cache surfaces page-limit coverage rather than stale-data status', async () => {
    const app = server();
    try {
      await client.query("update job_search_provider_cache set coverage='BOUNDED' where provider='arbeitnow'");
      const created = (await app.inject({ method: 'POST', url: '/api/v1/job-searches', payload: payload() })).json();
      assert.equal(created.refresh.coverage, 'BOUNDED'); assert.equal(created.refresh.coverageReason, 'PAGE_LIMIT');
      assert.equal(created.search.lastError, 'SOURCE_PAGE_LIMIT');
    } finally { await app.close(); }
  });

  test('preparation is capped at five per tick, skips archived jobs, and drains while searches are not due', async () => {
    const app = server();
    try {
      const fixtures = Array.from({ length: 7 }, (_, index) => ({ ...fixture, externalId: `batch-job-${index}`, title: `Product Designer ${index}`, url: `https://remotive.com/remote-jobs/design/batch-job-${index}` }));
      await client.query('update job_search_provider_cache set payload=$1::jsonb where provider=\'remotive\'', [JSON.stringify(fixtures)]);
      const created = (await app.inject({ method: 'POST', url: '/api/v1/job-searches', payload: payload({ location: null }) })).json();
      const id = created.search.id;
      await client.query("update jobs set shortlist_decision='ARCHIVED' where canonical_url=$1", [fixtures[0]!.url]);
      const enabled = await app.inject({ method: 'PATCH', url: `/api/v1/job-searches/${id}`, payload: { autoPrepare: true } });
      assert.equal(enabled.statusCode, 200); assert.equal(calls.length, 5);
      const prepared = (await client.query('select count(*)::int as count from saved_job_search_matches where search_id=$1 and auto_prepared_at is not null', [id])).rows[0].count;
      const pending = (await client.query('select count(*)::int as count from saved_job_search_matches where search_id=$1 and auto_prepared_at is null', [id])).rows[0].count;
      assert.equal(prepared, 5); assert.equal(pending, 2);
      await sources.runJobSearchTick(async (workspaceId, jobId, locale) => { calls.push({ workspaceId, jobId, locale }); });
      assert.equal(calls.length, 6);
      assert.equal((await client.query('select count(*)::int as count from saved_job_search_matches m join jobs j on j.id=m.job_id where m.search_id=$1 and j.shortlist_decision=\'ARCHIVED\' and m.auto_prepared_at is not null', [id])).rows[0].count, 0);
      assert.ok((await client.query('select next_run_at from saved_job_searches where id=$1', [id])).rows[0].next_run_at > new Date());
    } finally { await app.close(); }
  });

  test('startup recovers abandoned reservations without immediately re-running them', async () => {
    const app = server();
    try {
      const created = (await app.inject({ method: 'POST', url: '/api/v1/job-searches', payload: payload() })).json();
      await client.query("update saved_job_searches set last_run_status='RUNNING',last_run_at=now()-interval '3 minutes',next_run_at=now()-interval '1 minute' where id=$1", [created.search.id]);
      const errors: unknown[] = [];
      const stop = sources.startJobSearchWorker((error) => errors.push(error));
      try { await new Promise((resolve) => setTimeout(resolve, 1200)); } finally { await stop(); }
      const recovered = (await client.query('select last_run_status,next_run_at from saved_job_searches where id=$1', [created.search.id])).rows[0];
      assert.equal(recovered.last_run_status, 'INTERRUPTED'); assert.ok(new Date(recovered.next_run_at).getTime() > Date.now()); assert.deepEqual(errors, []);
    } finally { await app.close(); }
  });

  test('source metadata helper is workspace scoped', async () => {
    const app = server();
    try {
      await app.inject({ method: 'POST', url: '/api/v1/job-searches', payload: payload() });
      const jobId = (await client.query('select id from jobs where workspace_id=$1', [workspace])).rows[0]!.id as string;
      const another = randomUUID(); await client.query('insert into workspaces(id) values($1)', [another]);
      const found = await sources.getJobSearchSources(workspace, [jobId]); const hidden = await sources.getJobSearchSources(another, [jobId]);
      assert.equal(found[jobId]?.[0]?.name, 'Remotive'); assert.deepEqual(hidden[jobId], []);
    } finally { await app.close(); }
  });
});
