// ADR 021 for Remotive and Arbeitnow: only a freshly downloaded, complete, non-suspicious public feed counts
// presence and absence, once per download, for every workspace. Fictional jobs and a disposable database.
//   CAREER_JOB_SEARCH_TEST_ADMIN_URL=postgresql://$USER@127.0.0.1:5432/postgres pnpm run test:searches
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, beforeEach, describe, test } from 'node:test';
import type { PublicJob } from '../src/job-search-sources.js';
import { trackPgPoolCleanup } from './helpers/pg-pool-cleanup.js';

const root = new URL('../../../', import.meta.url);
const { Client } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_JOB_SEARCH_TEST_ADMIN_URL;

const feedJob = (externalId: string) => ({ provider: 'remotive', externalId, title: 'QA Engineer', company: 'Fictional', location: 'Worldwide', url: `https://example.test/jobs/${externalId}`, description: 'Fictional', postedAt: null, workMode: 'remote', raw: {} }) as unknown as PublicJob;

describe('job availability from shared public feeds (disposable database)', { skip: !adminUrl && 'set CAREER_JOB_SEARCH_TEST_ADMIN_URL to run', concurrency: false }, () => {
  const name = `career_availability_${randomBytes(6).toString('hex')}`;
  let admin: InstanceType<typeof Client>; let client: InstanceType<typeof Client>;
  let search: typeof import('../src/job-search.js'); let closePool: (() => Promise<void>) | undefined;
  const workspaces = [randomUUID(), randomUUID()];
  const originalDatabase = process.env.DATABASE_URL;
  before(async () => {
    const url = new URL(adminUrl!);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname)); assert.equal(url.pathname, '/postgres');
    admin = new Client({ connectionString: url.toString() }); await admin.connect();
    await admin.query(`create database "${name}"`); url.pathname = `/${name}`; process.env.DATABASE_URL = url.toString();
    client = new Client({ connectionString: url.toString() }); await client.connect();
    for (const file of (await readdir(new URL('packages/db/migrations', root))).filter((f) => f.endsWith('.sql')).sort()) await client.query(await readFile(new URL(`packages/db/migrations/${file}`, root), 'utf8'));
    search = await import('../src/job-search.js');
    closePool = trackPgPoolCleanup((await import('@career/db')).pool);
  });
  after(async () => {
    await closePool?.(); await client?.end();
    if (admin) { await admin.query(`drop database if exists "${name}" with (force)`); await admin.end(); }
    if (originalDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabase;
  });
  // Each workspace knows two Remotive jobs; r1 is matched by two saved searches in the first workspace.
  beforeEach(async () => {
    await client.query('delete from workspaces'); await client.query('delete from job_search_provider_cache');
    for (const ws of workspaces) {
      await client.query('insert into workspaces(id) values ($1)', [ws]);
      for (const external of ['r1', 'r2']) {
        const job = (await client.query(`insert into jobs(workspace_id, title, company, canonical_url, availability) values ($1, 'QA Engineer', 'Fictional', $2, 'OPEN') returning id`, [ws, `https://example.test/jobs/${external}`])).rows[0].id;
        await client.query(`insert into job_search_sources(workspace_id, job_id, provider, external_id, source_url) values ($1, $2, 'remotive', $3, $4)`, [ws, job, external, `https://example.test/jobs/${external}`]);
      }
    }
    for (const role of ['QA', 'Quality']) {
      const saved = (await client.query(`insert into saved_job_searches(workspace_id, role) values ($1, $2) returning id`, [workspaces[0], role])).rows[0].id;
      const job = (await client.query(`select job_id from job_search_sources where workspace_id = $1 and external_id = 'r1'`, [workspaces[0]])).rows[0].job_id;
      await client.query('insert into saved_job_search_matches(workspace_id, search_id, job_id) values ($1, $2, $3)', [workspaces[0], saved, job]);
    }
  });
  const due = () => client.query(`update job_search_provider_cache set next_fetch_at = now() - interval '1 hour'`);
  const download = async (feed: { jobs: PublicJob[]; coverage: 'COMPLETE' | 'BOUNDED' } | Error) => {
    await due();
    return search.loadProviderFeed('remotive', async () => { if (feed instanceof Error) throw feed; return feed; });
  };
  const complete = (...ids: string[]) => ({ jobs: ids.map(feedJob), coverage: 'COMPLETE' as const });
  const state = async (external: string, ws = workspaces[0]) => (await client.query(`select s.missed_complete_reads as missed, s.last_seen_at, j.availability from job_search_sources s join jobs j on j.id = s.job_id where s.workspace_id = $1 and s.external_id = $2`, [ws, external])).rows[0];
  const events = async (ws: string) => (await client.query('select to_state, reason from job_availability_events where workspace_id = $1 order by created_at', [ws])).rows;

  test('three complete downloads without a job over 48 hours make it possibly closed in every workspace, once each', async () => {
    assert.equal((await download(complete('r1', 'r2'))).state, 'FRESH');
    await download(complete('r1')); await download(complete('r1'));
    assert.equal((await state('r2')).missed, 2);
    await client.query(`update job_search_sources set last_seen_at = now() - interval '50 hours' where external_id = 'r2'`);
    await download(complete('r1'));
    for (const ws of workspaces) {
      assert.equal((await state('r2', ws)).availability, 'POSSIBLY_CLOSED', 'Each workspace that knows the job');
      assert.deepEqual(await events(ws), [{ to_state: 'POSSIBLY_CLOSED', reason: 'ABSENT_FROM_SOURCES' }], 'One entry per workspace');
    }
    assert.equal((await state('r1')).availability, 'OPEN', 'The job two searches share stays open while listed');
    assert.equal((await state('r1')).missed, 0);
    await download(complete('r1', 'r2'));
    assert.equal((await state('r2')).availability, 'OPEN');
    assert.deepEqual((await events(workspaces[1])).map((event) => event.reason), ['ABSENT_FROM_SOURCES', 'SEEN_AGAIN']);
  });

  test('a job two saved searches matched gets one history entry', async () => {
    await download(complete('r1', 'r2'));
    await client.query(`update job_search_sources set last_seen_at = now() - interval '50 hours', missed_complete_reads = 2 where external_id = 'r1'`);
    await download(complete('r2'));
    assert.equal((await state('r1')).availability, 'POSSIBLY_CLOSED');
    assert.equal((await events(workspaces[0])).length, 1);
  });

  test('cached, bounded, failed and suspicious reads change nothing', async () => {
    await download(complete('r1', 'r2'));
    await client.query(`update job_search_sources set missed_complete_reads = 2, last_seen_at = now() - interval '50 hours' where external_id = 'r2'`);
    await client.query(`update jobs set availability = 'POSSIBLY_CLOSED' where id in (select job_id from job_search_sources where external_id = 'r1')`);
    const before = await state('r1');
    // Cached: within the cooldown the stored listing is returned, and it gives no presence.
    const cached = await search.loadProviderFeed('remotive', async () => { throw new Error('must not download'); });
    assert.equal(cached.state, 'CACHED');
    assert.equal((await state('r1')).availability, 'POSSIBLY_CLOSED', 'A cached feed does not reopen a job');
    assert.deepEqual((await state('r1')).last_seen_at, before.last_seen_at);
    await download({ jobs: [feedJob('r1')], coverage: 'BOUNDED' });
    assert.equal((await state('r2')).missed, 2, 'A bounded feed counts no absence');
    assert.equal((await state('r1')).availability, 'POSSIBLY_CLOSED', 'and gives no presence');
    const failed = await download(new Error('fictional outage'));
    assert.equal(failed.state, 'STALE'); assert.equal((await state('r2')).missed, 2, 'A failed download counts nothing');
    await download(complete());
    assert.equal((await state('r2')).missed, 2, 'An empty feed after a non-empty one is suspicious');
    assert.equal((await client.query(`select last_complete_count from job_search_provider_cache where provider = 'remotive'`)).rows[0].last_complete_count, 2, 'and does not replace the comparison count');
  });

  test('a job the person closed stays closed while the feed lists it', async () => {
    await client.query(`update jobs set availability = 'CLOSED', closed_by_user = true where id in (select job_id from job_search_sources where external_id = 'r1')`);
    await download(complete('r1', 'r2'));
    assert.equal((await state('r1')).availability, 'CLOSED');
    assert.deepEqual(await events(workspaces[0]), []);
  });
});
