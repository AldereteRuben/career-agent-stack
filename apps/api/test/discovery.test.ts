import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { before, after, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import { readBoardWithReport, SourceHttpError, type BoardReadReport } from '../src/sources.js';
import { trackPgPoolCleanup } from './helpers/pg-pool-cleanup.js';

const root = new URL('../../../', import.meta.url);
const { Client } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_DISCOVERY_TEST_ADMIN_URL;
const hour = 3_600_000;
const report = (count = 1, skipped = 0): BoardReadReport => ({ host: 'api.lever.co', url: 'https://api.lever.co/v0/postings/fixture', bytes: 100, received: count + skipped, skipped, unlisted: 0, skipReasons: {}, jobs: Array.from({ length: count }, (_, i) => ({ externalId: `fictional-${i}`, title: i ? 'Writer' : 'Designer', location: 'Spain', description: 'Design', jobUrl: `https://example.test/job/${i}`, applyUrl: null, postedAt: null, updatedAt: null, raw: {} })) });

describe('automatic discovery with a disposable database and fictional sources', { skip: !adminUrl, concurrency: false }, () => {
  const name = `career_discovery_${randomBytes(6).toString('hex')}`;
  let admin: InstanceType<typeof Client>; let client: InstanceType<typeof Client>;
  let module: typeof import('../src/discovery.js'); let pool: { end(): Promise<void> };
  let closePool: (() => Promise<void>) | undefined;
  let workspace: string; let board: string;
  const originalDatabase = process.env.DATABASE_URL;
  before(async () => {
    const url = new URL(adminUrl!);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.ok(['postgres', 'template1'].includes(url.pathname.slice(1)), 'maintenance database required');
    admin = new Client({ connectionString: url.toString() }); await admin.connect();
    await admin.query(`create database "${name}"`); url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString(); client = new Client({ connectionString: url.toString() }); await client.connect();
    for (const file of (await readdir(new URL('packages/db/migrations', root))).filter((f) => f.endsWith('.sql')).sort()) await client.query(await readFile(new URL(`packages/db/migrations/${file}`, root), 'utf8'));
    module = await import('../src/discovery.js'); pool = (await import('@career/db')).pool; closePool = trackPgPoolCleanup(pool);
  });
  after(async () => {
    await closePool?.(); await client?.end();
    if (admin) { await admin.query(`drop database if exists "${name}" with (force)`); await admin.end(); }
    if (originalDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabase;
  });
  beforeEach(async () => {
    await client.query('delete from workspaces'); workspace = randomUUID(); board = randomUUID();
    await client.query('insert into workspaces(id) values($1)', [workspace]);
    await client.query("insert into boards(id,workspace_id,provider,tenant,region,company_name,company_domain,careers_url,enabled,association_status,permission_status) values($1,$2,'lever','fixture','global','Fictional Company','example.test','https://example.test/careers',true,'VERIFIED','APPROVED_FOR_SCOPE')", [board, workspace]);
  });
  const enable = () => client.query('update workspaces set discovery_enabled = true');
  const due = () => client.query("update boards set next_run_at = now() - interval '1 hour', last_successful_refresh_at = now() - interval '7 hours'");
  const row = async () => (await client.query('select * from boards where id = $1', [board])).rows[0];
  test('upgrade/default stays paused; enabled tick imports, ranks, then waits', async () => {
    let calls = 0; const read = async () => { calls++; return report(); };
    await module.runDiscoveryTick(read); assert.equal(calls, 0);
    await enable(); await module.runDiscoveryTick(read); await module.runDiscoveryTick(read);
    assert.equal(calls, 1); assert.equal((await row()).last_run_status, 'COMPLETE');
    const job = (await client.query('select * from jobs')).rows[0];
    assert.ok(job.discovered_at); assert.equal(job.seen_at, null); assert.ok(job.reasons.length); assert.equal((await row()).last_new_count, 1);
  });
  test('manual and automatic runs share locks and cooldown', async () => {
    let release!: () => void; let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; }); const blocked = new Promise<void>((resolve) => { release = resolve; });
    const first = module.refreshBoard(workspace, board, false, async () => { started(); await blocked; return report(); });
    await ready;
    try { await assert.rejects(module.refreshBoard(workspace, board, false, async () => report()), /BOARD_REFRESH_ALREADY_RUNNING/); }
    finally { release(); await first; }
    await assert.rejects(module.refreshBoard(workspace, board, false, async () => report()), /BOARD_REFRESH_COOLDOWN/);
  });
  test('repeated discoveries preserve reviewed/favorite jobs and immutable snapshots', async () => {
    await enable(); await module.runDiscoveryTick(async () => report());
    await client.query("update jobs set seen_at = now(), shortlist_decision = 'SHORTLISTED'");
    await due(); await module.runDiscoveryTick(async () => report());
    assert.equal((await client.query('select count(*)::int as n from jobs')).rows[0].n, 1);
    assert.equal((await client.query('select count(*)::int as n from job_snapshots')).rows[0].n, 1);
    const job = (await client.query('select * from jobs')).rows[0]; assert.ok(job.seen_at); assert.equal(job.shortlist_decision, 'SHORTLISTED'); assert.equal((await row()).last_new_count, 0);
  });
  test('different provider records for the same URL are deduplicated within a feed', async () => {
    const feed = report(2); feed.jobs[1] = { ...feed.jobs[0]!, externalId: 'second-id' };
    await module.refreshBoard(workspace, board, false, async () => feed);
    assert.equal((await client.query('select count(*)::int as n from jobs')).rows[0].n, 1);
    assert.equal((await client.query('select count(*)::int as n from job_occurrences')).rows[0].n, 2);
    assert.equal((await row()).last_new_count, 1);
  });
  test('worker startup executes due work and stop waits for completion; restart uses persisted state', async () => {
    await enable(); let calls = 0; const errors: unknown[] = [];
    const read = async () => { calls++; return report(); };
    const stop = module.startDiscoveryWorker((error) => errors.push(error), read);
    try { await new Promise((resolve) => setTimeout(resolve, 1300)); } finally { await stop(); }
    assert.equal(calls, 1); assert.equal((await row()).last_run_status, 'COMPLETE');
    const stopAgain = module.startDiscoveryWorker((error) => errors.push(error), read);
    try { await new Promise((resolve) => setTimeout(resolve, 1300)); } finally { await stopAgain(); }
    assert.equal(calls, 1); assert.deepEqual(errors, []);
  });
  test('pause survives another tick and resume catches up only once', async () => {
    await enable(); await module.runDiscoveryTick(async () => report()); await due();
    await client.query('update workspaces set discovery_enabled = false'); let calls = 0;
    const read = async () => { calls++; return report(); };
    await module.runDiscoveryTick(read); assert.equal(calls, 0);
    await enable(); await module.runDiscoveryTick(read); await module.runDiscoveryTick(read); assert.equal(calls, 1);
  });
  test('disabled, expired and unconfirmed companies never trigger networking', async () => {
    await enable(); let calls = 0;
    for (const clause of ["enabled = false", "enabled = true, permission_status = 'UNKNOWN'", "permission_status = 'APPROVED_FOR_SCOPE', association_status = 'UNVERIFIED'", "association_status = 'VERIFIED', review_due_at = now() - interval '1 day'"]) {
      await client.query(`update boards set ${clause}`);
      await module.runDiscoveryTick(async () => { calls++; return report(); });
      await assert.rejects(module.refreshBoard(workspace, board, false, async () => { calls++; return report(); }), /BOARD_NOT_APPROVED_FOR_DISCOVERY/);
    }
    assert.equal(calls, 0);
  });
  test('partial and empty feeds never close existing jobs', async () => {
    await module.refreshBoard(workspace, board, false, async () => report(2)); await due();
    await module.refreshBoard(workspace, board, false, async () => report(1, 1)); assert.equal((await row()).last_run_status, 'PARTIAL');
    await due(); await module.refreshBoard(workspace, board, false, async () => report(0));
    assert.equal((await client.query("select count(*)::int as n from jobs where availability = 'OPEN'")).rows[0].n, 2);
  });
  test('failure persists backoff and Retry-After without leaking source error details', async () => {
    await enable(); const retry = Date.now() + 24 * hour;
    await module.runDiscoveryTick(async () => { throw new SourceHttpError(429, new Date(retry).toUTCString()); });
    const failed = await row(); assert.equal(failed.last_error, 'SOURCE_HTTP_429'); assert.equal(failed.failure_count, 1); assert.ok(failed.next_run_at.getTime() >= retry - 1000);
    let calls = 0; await module.runDiscoveryTick(async () => { calls++; return report(); }); assert.equal(calls, 0);
    await due(); await module.runDiscoveryTick(async () => { throw new Error('secret remote payload'); });
    assert.equal((await row()).last_error, 'SOURCE_READ_FAILED'); assert.ok((await row()).next_run_at.getTime() >= Date.now() + 11 * hour);
  });
  test('successful retry resets failure count and reuses stored schedule after restart', async () => {
    await client.query("update boards set failure_count = 3, last_run_status = 'RUNNING', last_run_at = now() - interval '7 hours'");
    await enable(); await due(); await module.runDiscoveryTick(async () => report());
    assert.equal((await row()).failure_count, 0); assert.equal((await row()).last_run_status, 'COMPLETE');
  });
  test('routes validate activation, expose schedule and scope results to workspace', async () => {
    const app = Fastify(); module.registerDiscoveryRoutes(app, (request) => String(request.headers['x-workspace'] ?? workspace));
    try {
      assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/discovery', payload: { enabled: 'yes' } })).statusCode, 400);
      await client.query('update boards set enabled = false');
      assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/discovery', payload: { enabled: true } })).statusCode, 409);
      await client.query('update boards set enabled = true');
      assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/discovery', payload: { enabled: true } })).statusCode, 200);
      await module.runDiscoveryTick(async () => report(2));
      const status = (await app.inject('/api/v1/discovery')).json(); assert.equal(status.enabled, true); assert.equal(status.unreadCount, 2); assert.ok(status.boards[0].nextRunAt);
      const other = randomUUID(); await client.query('insert into workspaces(id) values($1)', [other]);
      const isolated = (await app.inject({ url: '/api/v1/discovery', headers: { 'x-workspace': other } })).json(); assert.equal(isolated.unreadCount, 0); assert.deepEqual(isolated.boards, []);
      await app.inject({ method: 'PUT', url: '/api/v1/discovery', payload: { enabled: false } });
      assert.equal((await app.inject('/api/v1/discovery')).json().boards[0].nextRunAt, null);
    } finally { await app.close(); }
  });
  test('the source transport preserves Retry-After on provider failures', async () => {
    await assert.rejects(readBoardWithReport({ provider: 'lever', tenant: 'fixture', region: 'global' }, { fetch: async () => new Response('{}', { status: 429, headers: { 'retry-after': '86400', 'content-type': 'application/json' } }) }), (error: unknown) => error instanceof SourceHttpError && error.retryAfter >= Date.now() + 23 * hour);
  });
  test('backoff is bounded; valid HTTP dates and seconds are honored', () => {
    const now = Date.now();
    assert.equal(module.nextAttempt(now, 1).getTime(), now + 6 * hour);
    assert.equal(module.nextAttempt(now, 9).getTime(), now + 48 * hour);
    assert.equal(new SourceHttpError(503, '7200', now).retryAfter, now + 2 * hour);
    assert.equal(new SourceHttpError(503, 'invalid', now).retryAfter, 0);
  });
});
