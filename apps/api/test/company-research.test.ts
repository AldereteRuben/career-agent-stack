import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, beforeEach, describe, test } from 'node:test';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { trackPgPoolCleanup } from './helpers/pg-pool-cleanup.js';

const root = new URL('../../../', import.meta.url);
const { Client } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_COMPANY_RESEARCH_TEST_ADMIN_URL;

describe('company research notes (disposable database)', { skip: !adminUrl && 'set CAREER_COMPANY_RESEARCH_TEST_ADMIN_URL to run', concurrency: false }, () => {
  const name = `career_company_research_${randomBytes(6).toString('hex')}`;
  let admin: InstanceType<typeof Client>; let client: InstanceType<typeof Client>; let closePool: (() => Promise<void>) | undefined;
  let route: typeof import('../src/company-research-routes.js'); let dbmod: typeof import('@career/db');
  const [workspace, otherWorkspace] = [randomUUID(), randomUUID()];
  const originalDatabase = process.env.DATABASE_URL;
  before(async () => {
    const url = new URL(adminUrl!);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname)); assert.equal(url.pathname, '/postgres');
    admin = new Client({ connectionString: url.toString() }); await admin.connect();
    await admin.query(`create database "${name}"`); url.pathname = `/${name}`; process.env.DATABASE_URL = url.toString();
    client = new Client({ connectionString: url.toString() }); await client.connect();
    for (const file of (await readdir(new URL('packages/db/migrations', root))).filter((entry) => entry.endsWith('.sql')).sort()) await client.query(await readFile(new URL(`packages/db/migrations/${file}`, root), 'utf8'));
    [route, dbmod] = await Promise.all([import('../src/company-research-routes.js'), import('@career/db')]);
    closePool = trackPgPoolCleanup(dbmod.pool);
  });
  after(async () => {
    await closePool?.(); await client?.end();
    if (admin) { await admin.query(`drop database if exists "${name}" with (force)`); await admin.end(); }
    if (originalDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabase;
  });
  beforeEach(async () => { await client.query('delete from workspaces'); });

  const app = () => { const instance = Fastify(); route.registerCompanyResearchRoutes(instance, () => workspace, dbmod.db); return instance; };
  const notes = { whatItDoes: 'Builds fictional inventory software.', howItMakesMoney: 'Subscription plans.', recentNews: 'Opened a Madrid office.', culture: 'Small research-led teams.', questionsToAsk: 'How does the team measure product quality?' };
  const addJob = async (ws: string) => (await client.query(`insert into jobs(workspace_id, title, company) values ($1, 'Product Designer', 'Example Co') returning id`, [ws])).rows[0]!.id as string;

  test('notes can be created and edited, and the current job record is exportable', async () => {
    await client.query('insert into workspaces(id) values ($1)', [workspace]);
    const job = await addJob(workspace); const instance = app();
    try {
      const first = await instance.inject({ method: 'PUT', url: `/api/v1/jobs/${job}/company-research`, payload: notes });
      assert.equal(first.statusCode, 200); assert.deepEqual(first.json().companyResearch, notes);
      const edited = { ...notes, recentNews: 'Published an accessibility report.' };
      const second = await instance.inject({ method: 'PUT', url: `/api/v1/jobs/${job}/company-research`, payload: edited });
      assert.equal(second.statusCode, 200); assert.deepEqual(second.json().companyResearch, edited);
      const exportedJob = (await dbmod.db.select().from(dbmod.jobs).where(eq(dbmod.jobs.id, job)))[0];
      assert.deepEqual(exportedJob?.companyResearch, edited);
    } finally { await instance.close(); }
  });

  test('notes reject unknown fields and cannot be written across workspaces', async () => {
    await client.query('insert into workspaces(id) values ($1), ($2)', [workspace, otherWorkspace]);
    const foreignJob = await addJob(otherWorkspace); const instance = app();
    try {
      assert.equal((await instance.inject({ method: 'PUT', url: `/api/v1/jobs/${foreignJob}/company-research`, payload: notes })).statusCode, 404);
      assert.equal((await instance.inject({ method: 'PUT', url: `/api/v1/jobs/${foreignJob}/company-research`, payload: { ...notes, contact: 'private' } })).statusCode, 400);
    } finally { await instance.close(); }
  });

  test('notes disappear with the workspace data', async () => {
    await client.query('insert into workspaces(id) values ($1)', [workspace]);
    const job = await addJob(workspace);
    await client.query('update jobs set company_research = $2 where id = $1', [job, notes]);
    await client.query('delete from workspaces where id = $1', [workspace]);
    assert.equal((await client.query('select id from jobs where id = $1', [job])).rowCount, 0);
  });
});
