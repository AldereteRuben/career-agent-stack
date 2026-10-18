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

describe('company research notes (disposable database)', { skip: !adminUrl && 'set CAREER_JOB_SEARCH_TEST_ADMIN_URL to run', concurrency: false }, () => {
  const name = `career_research_notes_${randomBytes(6).toString('hex')}`;
  let admin: InstanceType<typeof Client>; let client: InstanceType<typeof Client>; let closePool: (() => Promise<void>) | undefined;
  let routes: typeof import('../src/job-research-routes.js'); let dbmod: typeof import('@career/db');
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
    [routes, dbmod] = await Promise.all([import('../src/job-research-routes.js'), import('@career/db')]);
    closePool = trackPgPoolCleanup(dbmod.pool);
  });
  after(async () => {
    await closePool?.(); await client?.end();
    if (admin) { await admin.query(`drop database if exists "${name}" with (force)`); await admin.end(); }
    if (originalDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabase;
  });
  beforeEach(async () => {
    await client.query('delete from workspaces');
    const ids: string[] = [];
    for (const ws of [workspace, other]) {
      await client.query('insert into workspaces(id) values ($1)', [ws]);
      ids.push((await client.query(`insert into jobs(workspace_id, title, company) values ($1, 'QA Engineer', 'Fictional') returning id`, [ws])).rows[0].id);
    }
    [job, otherJob] = ids as [string, string];
  });
  const server = () => { const app = Fastify(); routes.registerJobResearchRoutes(app, () => workspace); return app; };
  const request = (app: ReturnType<typeof server>, method: 'GET' | 'PUT' | 'DELETE', id: string, payload?: object) => app.inject({ method, url: `/api/v1/jobs/${id}/research-notes`, payload });
  const notes = { business: 'Builds fictional tools', model: '', news: '', culture: '', questions: 'How does the team work?' };

  test('saves, reads, clears, and prevents stale writes after a clear', async () => {
    const app = server();
    try {
      const initial = await request(app, 'GET', job); assert.equal(initial.statusCode, 200); assert.equal(initial.json().revision, null);
      const saved = await request(app, 'PUT', job, { notes, expectedRevision: null }); assert.equal(saved.statusCode, 200); assert.equal(saved.json().revision, 1);
      const stale = await request(app, 'PUT', job, { notes: { ...notes, business: 'stale' }, expectedRevision: null });
      assert.equal(stale.statusCode, 409);
      const cleared = await request(app, 'DELETE', job, { expectedRevision: 1 }); assert.equal(cleared.statusCode, 200); assert.equal(cleared.json().revision, 2);
      const recreated = await request(app, 'PUT', job, { notes, expectedRevision: 2 }); assert.equal(recreated.statusCode, 200); assert.equal(recreated.json().revision, 3);
      const oldTab = await request(app, 'PUT', job, { notes: { ...notes, business: 'stale after clear' }, expectedRevision: 1 }); assert.equal(oldTab.statusCode, 409);
      const current = await request(app, 'GET', job); assert.equal(current.json().notes.business, notes.business); assert.equal(current.json().revision, 3);
    } finally { await app.close(); }
  });

  test('does not expose or mutate another workspace job and rejects invalid notes', async () => {
    const app = server();
    try {
      assert.equal((await request(app, 'GET', otherJob)).statusCode, 404);
      assert.equal((await request(app, 'PUT', otherJob, { notes, expectedRevision: null })).statusCode, 404);
      assert.equal((await request(app, 'DELETE', otherJob, { expectedRevision: null })).statusCode, 404);
      assert.equal((await request(app, 'PUT', job, { notes: { ...notes, business: 'x'.repeat(4_001) }, expectedRevision: null })).statusCode, 400);
      assert.equal((await client.query('select count(*)::int as count from job_research_notes where job_id = $1', [otherJob])).rows[0].count, 0);
    } finally { await app.close(); }
  });
});
