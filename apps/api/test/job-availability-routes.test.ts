// ADR 021, the person's side: closing and reopening a job, conflicts, workspace isolation, history and the
// "a source still lists it" note. Fictional jobs and a disposable database.
//   CAREER_JOB_SEARCH_TEST_ADMIN_URL=postgresql://$USER@127.0.0.1:5432/postgres pnpm run test:searches
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import { trackPgPoolCleanup } from './helpers/pg-pool-cleanup.js';

const root = new URL('../../../', import.meta.url);
const { Client } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_JOB_SEARCH_TEST_ADMIN_URL;

describe('closing and reopening jobs (disposable database)', { skip: !adminUrl && 'set CAREER_JOB_SEARCH_TEST_ADMIN_URL to run', concurrency: false }, () => {
  const name = `career_availability_routes_${randomBytes(6).toString('hex')}`;
  let admin: InstanceType<typeof Client>; let client: InstanceType<typeof Client>; let closePool: (() => Promise<void>) | undefined;
  let routes: typeof import('../src/job-availability-routes.js'); let availability: typeof import('../src/job-availability.js'); let dbmod: typeof import('@career/db');
  const [workspace, other] = [randomUUID(), randomUUID()];
  let job: string; let otherJob: string;
  const originalDatabase = process.env.DATABASE_URL;
  before(async () => {
    const url = new URL(adminUrl!);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname)); assert.equal(url.pathname, '/postgres');
    admin = new Client({ connectionString: url.toString() }); await admin.connect();
    await admin.query(`create database "${name}"`); url.pathname = `/${name}`; process.env.DATABASE_URL = url.toString();
    client = new Client({ connectionString: url.toString() }); await client.connect();
    for (const file of (await readdir(new URL('packages/db/migrations', root))).filter((f) => f.endsWith('.sql')).sort()) await client.query(await readFile(new URL(`packages/db/migrations/${file}`, root), 'utf8'));
    [routes, availability, dbmod] = await Promise.all([import('../src/job-availability-routes.js'), import('../src/job-availability.js'), import('@career/db')]);
    closePool = trackPgPoolCleanup(dbmod.pool);
  });
  after(async () => {
    await closePool?.(); await client?.end();
    if (admin) { await admin.query(`drop database if exists "${name}" with (force)`); await admin.end(); }
    if (originalDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabase;
  });
  // Each workspace knows one Remotive job, missed twice by complete downloads.
  beforeEach(async () => {
    await client.query('delete from workspaces');
    const ids: string[] = [];
    for (const ws of [workspace, other]) {
      await client.query('insert into workspaces(id) values ($1)', [ws]);
      const id = (await client.query(`insert into jobs(workspace_id, title, company, canonical_url, availability) values ($1, 'QA Engineer', 'Fictional', 'https://example.test/jobs/r1', 'OPEN') returning id`, [ws])).rows[0].id;
      await client.query(`insert into job_search_sources(workspace_id, job_id, provider, external_id, source_url, missed_complete_reads, last_seen_at) values ($1, $2, 'remotive', 'r1', 'https://example.test/jobs/r1', 2, now() - interval '30 hours')`, [ws, id]);
      ids.push(id);
    }
    [job, otherJob] = ids as [string, string];
  });
  const server = () => { const app = Fastify(); routes.registerJobAvailabilityRoutes(app, () => workspace); return app; };
  const post = (app: ReturnType<typeof server>, id: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/v1/jobs/${id}/availability`, payload: payload as object });
  const row = async (id: string) => (await client.query('select j.availability, j.closed_by_user, s.missed_complete_reads as missed from jobs j join job_search_sources s on s.job_id = j.id where j.id = $1', [id])).rows[0];
  const events = async (id: string) => (await client.query('select from_state, to_state, reason from job_availability_events where job_id = $1 order by created_at, id', [id])).rows;

  test('closing an open job records it and keeps it closed whatever sources report', async () => {
    const app = server();
    const closed = await post(app, job, { action: 'close', expectedAvailability: 'OPEN' });
    assert.equal(closed.statusCode, 200);
    assert.equal(closed.json().availability, 'CLOSED'); assert.equal(closed.json().closedByUser, true); assert.equal(closed.json().stillListedBySource, false);
    assert.deepEqual(await events(job), [{ from_state: 'OPEN', to_state: 'CLOSED', reason: 'CLOSED_BY_USER' }]);
    // A later complete download still lists it: the person's decision wins, and the page can say so.
    await client.query(`update job_search_sources set missed_complete_reads = 0, last_seen_at = now() + interval '1 minute' where job_id = $1`, [job]);
    assert.equal(await availability.reevaluateJobs(dbmod.pool, workspace, [job]), 0);
    assert.equal((await row(job)).availability, 'CLOSED');
    assert.equal((await routes.availabilityDetail(dbmod.pool, workspace, job)).stillListedBySource, true);
    assert.equal((await post(app, job, { action: 'close', expectedAvailability: 'CLOSED' })).json().error, 'JOB_ALREADY_CLOSED');
  });

  test('closing a job already CLOSED without the decision (older data) still records it', async () => {
    const app = server();
    await client.query(`update jobs set availability = 'CLOSED' where id = $1`, [job]);
    const closed = await post(app, job, { action: 'close', expectedAvailability: 'CLOSED' });
    assert.equal(closed.statusCode, 200); assert.equal(closed.json().closedByUser, true);
    assert.deepEqual(await events(job), [{ from_state: 'CLOSED', to_state: 'CLOSED', reason: 'CLOSED_BY_USER' }]);
    await client.query(`update job_search_sources set missed_complete_reads = 0, last_seen_at = now() + interval '1 minute' where job_id = $1`, [job]);
    assert.equal((await routes.availabilityDetail(dbmod.pool, workspace, job)).stillListedBySource, true);
  });

  test('reopening clears the decision, resets every absence count and needs three new misses', async () => {
    const app = server();
    await client.query(`update jobs set availability = 'POSSIBLY_CLOSED' where id = $1`, [job]);
    await client.query(`update job_search_sources set missed_complete_reads = 3, last_seen_at = now() - interval '50 hours' where job_id = $1`, [job]);
    const reopened = await post(app, job, { action: 'reopen', expectedAvailability: 'POSSIBLY_CLOSED' });
    assert.equal(reopened.statusCode, 200); assert.equal(reopened.json().availability, 'OPEN');
    assert.deepEqual(await row(job), { availability: 'OPEN', closed_by_user: false, missed: 0 });
    assert.equal(await availability.reevaluateJobs(dbmod.pool, workspace, [job]), 0, 'Not possibly closed again before new misses');
    // Close, then reopen from CLOSED: the history lists every change in order.
    await post(app, job, { action: 'close', expectedAvailability: 'OPEN' });
    await post(app, job, { action: 'reopen', expectedAvailability: 'CLOSED' });
    assert.deepEqual((await routes.availabilityDetail(dbmod.pool, workspace, job)).history.map((event) => event.reason), ['REOPENED_BY_USER', 'CLOSED_BY_USER', 'REOPENED_BY_USER']);
    assert.equal((await post(app, job, { action: 'reopen', expectedAvailability: 'OPEN' })).json().error, 'JOB_NOT_CLOSED');
  });

  test('availability changes leave a submitted application untouched', async () => {
    const app = server();
    const applicationId = randomUUID();
    await client.query(`insert into applications (id, workspace_id, company, role, job_id, state, recruitment_stage, version)
      values ($1, $2, 'Fictional', 'QA Engineer', $3, 'CONFIRMED', 'INTERVIEW', 7)`, [applicationId, workspace, job]);
    const application = async () => (await client.query('select state, recruitment_stage, version from applications where id = $1', [applicationId])).rows[0];
    const unchanged = { state: 'CONFIRMED', recruitment_stage: 'INTERVIEW', version: 7 };
    try {
      // A complete source read missed the job three times; the old sighting is beyond the 48-hour threshold.
      await client.query(`update job_search_sources set missed_complete_reads = 3, last_seen_at = now() - interval '50 hours' where job_id = $1`, [job]);
      assert.equal(await availability.reevaluateJobs(dbmod.pool, workspace, [job]), 1);
      assert.equal((await row(job)).availability, 'POSSIBLY_CLOSED');
      assert.deepEqual(await application(), unchanged);

      const closed = await post(app, job, { action: 'close', expectedAvailability: 'POSSIBLY_CLOSED' });
      assert.equal(closed.statusCode, 200); assert.equal(closed.json().availability, 'CLOSED');
      assert.deepEqual(await application(), unchanged);

      const reopened = await post(app, job, { action: 'reopen', expectedAvailability: 'CLOSED' });
      assert.equal(reopened.statusCode, 200); assert.equal(reopened.json().availability, 'OPEN');
      assert.deepEqual(await application(), unchanged);
    } finally { await app.close(); }
  });

  test('a stale request is refused with the current availability and changes nothing', async () => {
    const app = server();
    await client.query(`update jobs set availability = 'POSSIBLY_CLOSED' where id = $1`, [job]);
    const stale = await post(app, job, { action: 'close', expectedAvailability: 'OPEN' });
    assert.equal(stale.statusCode, 409);
    assert.deepEqual(stale.json(), { error: 'STALE_JOB_AVAILABILITY', availability: 'POSSIBLY_CLOSED' });
    assert.deepEqual(await row(job), { availability: 'POSSIBLY_CLOSED', closed_by_user: false, missed: 2 });
    assert.deepEqual(await events(job), []);
  });

  test("another workspace's job and invalid input are refused", async () => {
    const app = server();
    assert.equal((await post(app, otherJob, { action: 'close', expectedAvailability: 'OPEN' })).statusCode, 404);
    assert.deepEqual(await row(otherJob), { availability: 'OPEN', closed_by_user: false, missed: 2 });
    assert.equal((await post(app, 'not-a-job', { action: 'close', expectedAvailability: 'OPEN' })).statusCode, 404);
    assert.equal((await post(app, job, { action: 'archive', expectedAvailability: 'OPEN' })).statusCode, 400);
    assert.equal((await post(app, job, { action: 'close', expectedAvailability: 'GONE' })).statusCode, 400);
    assert.equal((await post(app, job, null)).statusCode, 400);
    assert.deepEqual(await events(otherJob), []);
  });
});
