// Job evaluation reports (#109) and batches (#110) through the API: fictional profiles and jobs, a disposable database.
//   CAREER_JOB_REPORT_TEST_ADMIN_URL=postgresql://$USER@127.0.0.1:5432/postgres pnpm run test:job-reports
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { after, before, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import { trackPgPoolCleanup } from './helpers/pg-pool-cleanup.js';

const root = new URL('../../../', import.meta.url);
const { Client } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_JOB_REPORT_TEST_ADMIN_URL;

type Item = { jobId: string; position: number; company: string | null; title: string | null; status: string; verdict: string | null; errorCode: string | null; supportedCount: number | null; requirementCount: number | null };
type Batch = { id: string; status: string; total: number; counts: { pending: number; done: number; failed: number; skipped: number }; items: Item[] };

describe('job evaluation reports and batches (disposable database)', { skip: !adminUrl && 'set CAREER_JOB_REPORT_TEST_ADMIN_URL to run', concurrency: false }, () => {
  const name = `career_job_reports_${randomBytes(6).toString('hex')}`;
  let admin: InstanceType<typeof Client>; let client: InstanceType<typeof Client>; let closePool: (() => Promise<void>) | undefined;
  let routes: typeof import('../src/job-report-routes.js'); let domain: typeof import('@career/domain'); let dbmod: typeof import('@career/db');
  const [workspace, other] = [randomUUID(), randomUUID()];
  const originalDatabase = process.env.DATABASE_URL;
  before(async () => {
    const url = new URL(adminUrl!);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname)); assert.equal(url.pathname, '/postgres');
    admin = new Client({ connectionString: url.toString() }); await admin.connect();
    await admin.query(`create database "${name}"`); url.pathname = `/${name}`; process.env.DATABASE_URL = url.toString();
    client = new Client({ connectionString: url.toString() }); await client.connect();
    for (const file of (await readdir(new URL('packages/db/migrations', root))).filter((f) => f.endsWith('.sql')).sort()) await client.query(await readFile(new URL(`packages/db/migrations/${file}`, root), 'utf8'));
    [routes, domain, dbmod] = await Promise.all([import('../src/job-report-routes.js'), import('@career/domain'), import('@career/db')]);
    closePool = trackPgPoolCleanup(dbmod.pool);
  });
  after(async () => {
    await closePool?.(); await client?.end();
    if (admin) { await admin.query(`drop database if exists "${name}" with (force)`); await admin.end(); }
    if (originalDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabase;
  });

  // A fictional QA tester in Spain who wants remote work, with approved, suggested and rejected facts.
  const facts: Record<string, string> = {};
  beforeEach(async () => {
    await client.query('delete from workspaces');
    for (const ws of [workspace, other]) {
      await client.query('insert into workspaces(id) values ($1)', [ws]);
      const profile = { identity: { fullName: 'Alex Example', email: 'alex@example.test', country: 'ES' }, preferences: { targetTitles: ['QA Engineer'], workModes: ['remote'] } };
      const version = (await client.query('insert into profile_versions(workspace_id, revision, profile) values ($1, 1, $2) returning id', [ws, profile])).rows[0].id;
      for (const [key, statement, status] of [['playwright', 'Built a Playwright suite for Example Shop.', 'USER_APPROVED'], ['typescript', 'Wrote TypeScript helpers for Example Shop.', 'USER_APPROVED'], ['java', 'Java services at Fictional Bank.', 'SUGGESTED'], ['docker', 'Docker images at Fictional Bank.', 'REJECTED']] as const) {
        const id = (await client.query('insert into profile_facts(workspace_id, profile_version_id, kind, statement, approval_status) values ($1, $2, $3, $4, $5) returning id', [ws, version, 'achievement', statement, status])).rows[0].id;
        if (ws === workspace) facts[key] = id;
      }
    }
  });
  const addJob = async (ws: string, title: string, description: string | null, options: { location?: string | null; archived?: boolean; feed?: boolean } = {}) => {
    const id = (await client.query(`insert into jobs(workspace_id, title, company, location, canonical_url, shortlist_decision) values ($1, $2, 'Example Co', $3, $4, $5) returning id`,
      [ws, title, options.location === undefined ? 'Remote - Spain' : options.location, `https://example.test/jobs/${randomUUID()}`, options.archived ? 'ARCHIVED' : 'SHORTLISTED'])).rows[0].id as string;
    await client.query(`insert into job_snapshots(workspace_id, job_id, title, description_text, snapshot_hash) values ($1, $2, $3, $4, $5)`, [ws, id, title, description, randomBytes(32).toString('hex')]);
    if (options.feed) await client.query(`insert into job_search_sources(workspace_id, job_id, provider, external_id, source_url) values ($1, $2, 'remotive', $3, 'https://example.test/feed')`, [ws, id, randomUUID()]);
    return id;
  };
  const strong = 'Requirements: Playwright and TypeScript are required.\nSalary: 40.000 € gross.';
  const server = (build?: import('../src/job-report-routes.js').ReportBuilder) => { const app = Fastify(); routes.registerJobReportRoutes(app, () => workspace, { build }); return app; };
  const call = async <T>(app: ReturnType<typeof server>, method: 'GET' | 'POST', url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
    return { status: response.statusCode, body: response.json() as T };
  };
  const create = (app: ReturnType<typeof server>, jobIds: string[], idempotencyKey: string = randomUUID()) => call<Batch & { error?: string; detail?: string }>(app, 'POST', '/api/v1/job-report-batches', { jobIds, idempotencyKey });
  const advance = (app: ReturnType<typeof server>, id: string) => call<Batch>(app, 'POST', `/api/v1/job-report-batches/${id}/advance`);

  test('a job report quotes the posting and cites only approved facts, without any score', async () => {
    const app = server();
    const job = await addJob(workspace, 'QA Engineer', strong);
    const { status, body } = await call<{ jobId: string; report: import('@career/domain').JobReport }>(app, 'GET', `/api/v1/jobs/${job}/report`);
    assert.equal(status, 200);
    assert.equal(body.report.verdict, 'GOOD_OPTION');
    assert.deepEqual(body.report.supported.map((item) => [item.skill, item.facts.map((fact) => fact.factId)]), [['typescript', [facts.typescript]], ['playwright', [facts.playwright]]]);
    assert.equal(body.report.supported[0]?.jobExcerpt, 'Requirements: Playwright and TypeScript are required.');
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, new RegExp(`${facts.java}|${facts.docker}|Fictional Bank`), 'Suggested and rejected facts never appear');
    assert.doesNotMatch(text, /fitScore|probab/i);
  });

  test('a job without clear requirements, and a feed job written in HTML, are reported honestly and readably', async () => {
    const app = server();
    const vague = await addJob(workspace, 'QA Engineer', 'Join a friendly team.', { location: null });
    const report = (await call<{ report: import('@career/domain').JobReport }>(app, 'GET', `/api/v1/jobs/${vague}/report`)).body.report;
    assert.equal(report.verdict, 'REVIEW');
    assert.ok(report.unknowns.includes('NO_CLEAR_REQUIREMENTS') && report.unknowns.includes('LOCATION_NOT_STATED'));
    const feed = await addJob(workspace, 'QA Engineer', '<ul><li><strong>Playwright</strong> is required</li></ul>', { feed: true });
    const feedReport = (await call<{ report: import('@career/domain').JobReport }>(app, 'GET', `/api/v1/jobs/${feed}/report`)).body.report;
    assert.equal(feedReport.supported[0]?.jobExcerpt, 'Playwright is required');
  });

  test('reports of another workspace or of an unknown job are not found', async () => {
    const app = server();
    const foreign = await addJob(other, 'QA Engineer', strong);
    assert.equal((await call(app, 'GET', `/api/v1/jobs/${foreign}/report`)).status, 404);
    assert.equal((await call(app, 'GET', `/api/v1/jobs/${randomUUID()}/report`)).status, 404);
    assert.equal((await call(app, 'GET', '/api/v1/jobs/not-a-uuid/report')).status, 404);
  });

  test('a batch with valid, failing and archived jobs evaluates the valid ones, explains the others and sorts by conclusion', async () => {
    const app = server();
    const review = await addJob(workspace, 'QA Engineer', 'Join a friendly team.');
    const good = await addJob(workspace, 'QA Engineer', strong);
    const notFit = await addJob(workspace, 'Data Scientist', 'Python, SQL and AWS are required.');
    const archived = await addJob(workspace, 'QA Engineer', strong, { archived: true });
    const missing = randomUUID();
    const foreign = await addJob(other, 'Secret Role', strong);
    const created = await create(app, [review, good, notFit, archived, missing, foreign]);
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'RUNNING'); assert.equal(created.body.total, 6); assert.equal(created.body.counts.pending, 6);
    assert.equal(created.body.items.find((item) => item.jobId === foreign)?.company, null, 'Another workspace never lends its labels');
    const first = await advance(app, created.body.id);
    assert.equal(first.body.counts.pending, 1, 'At most five jobs per pass');
    assert.equal(first.body.status, 'RUNNING');
    const done = await advance(app, created.body.id);
    assert.equal(done.body.status, 'COMPLETED');
    assert.deepEqual(done.body.items.map((item) => [item.jobId, item.status, item.verdict ?? item.errorCode]), [
      [good, 'DONE', 'GOOD_OPTION'], [review, 'DONE', 'REVIEW'], [notFit, 'DONE', 'PROBABLY_NOT_A_FIT'],
      [missing, 'FAILED', 'JOB_NOT_FOUND'], [foreign, 'FAILED', 'JOB_NOT_FOUND'], [archived, 'SKIPPED', 'JOB_ARCHIVED'],
    ]);
    assert.deepEqual(done.body.counts, { pending: 0, done: 3, failed: 2, skipped: 1 });
    assert.deepEqual([done.body.items[0]?.supportedCount, done.body.items[0]?.requirementCount], [2, 2]);
    const stored = (await client.query('select report from job_report_batch_items where job_id = $1', [good])).rows[0].report;
    assert.equal(stored.verdict, 'GOOD_OPTION');
    // Advancing a completed batch changes nothing.
    assert.deepEqual((await advance(app, created.body.id)).body, done.body);
    assert.equal((await call<{ batch: Batch }>(app, 'GET', '/api/v1/job-report-batches/current')).body.batch?.id, created.body.id);
  });

  test('one failing report does not stop the others', async () => {
    const app = server((job, context) => { if (job.title === 'Broken') throw new Error('fictional failure'); return domain.buildJobReport(job, context); });
    const [a, broken, b] = [await addJob(workspace, 'QA Engineer', strong), await addJob(workspace, 'Broken', strong), await addJob(workspace, 'QA Engineer', strong)];
    const created = await create(app, [a, broken, b]);
    const done = await advance(app, created.body.id);
    assert.equal(done.body.status, 'COMPLETED');
    assert.deepEqual(done.body.items.map((item) => [item.jobId, item.status, item.errorCode]), [[a, 'DONE', null], [b, 'DONE', null], [broken, 'FAILED', 'REPORT_FAILED']]);
    assert.equal(done.body.items[2]?.title, 'Broken', 'The failed job can be recognised');
  });

  test('pausing stops passes, resuming continues them and nothing evaluated is lost', async () => {
    const app = server();
    const ids = []; for (let index = 0; index < 7; index++) ids.push(await addJob(workspace, 'QA Engineer', strong));
    const created = await create(app, ids);
    await advance(app, created.body.id);
    const paused = await call<Batch>(app, 'POST', `/api/v1/job-report-batches/${created.body.id}/pause`);
    assert.equal(paused.body.status, 'PAUSED'); assert.equal(paused.body.counts.done, 5);
    assert.equal((await call<Batch>(app, 'POST', `/api/v1/job-report-batches/${created.body.id}/pause`)).body.status, 'PAUSED', 'Pausing twice is harmless');
    assert.equal((await advance(app, created.body.id)).body.counts.done, 5, 'A paused batch does not advance');
    assert.equal((await create(app, [ids[0]!])).body.error, 'JOB_REPORT_BATCH_ACTIVE', 'A paused batch is still the active one');
    assert.equal((await call<Batch>(app, 'POST', `/api/v1/job-report-batches/${created.body.id}/resume`)).body.status, 'RUNNING');
    const done = await advance(app, created.body.id);
    assert.equal(done.body.status, 'COMPLETED'); assert.equal(done.body.counts.done, 7);
    const again = await call<{ error: string; detail: string }>(app, 'POST', `/api/v1/job-report-batches/${created.body.id}/pause`);
    assert.equal(again.status, 409); assert.equal(again.body.error, 'JOB_REPORT_BATCH_FINISHED');
  });

  test('cancelling keeps evaluated jobs, skips the rest and cannot be resumed', async () => {
    const app = server();
    const ids = []; for (let index = 0; index < 7; index++) ids.push(await addJob(workspace, 'QA Engineer', strong));
    const created = await create(app, ids);
    await advance(app, created.body.id);
    const cancelled = await call<Batch>(app, 'POST', `/api/v1/job-report-batches/${created.body.id}/cancel`);
    assert.equal(cancelled.body.status, 'CANCELLED');
    assert.deepEqual(cancelled.body.counts, { pending: 0, done: 5, failed: 0, skipped: 2 });
    assert.ok(cancelled.body.items.filter((item) => item.status === 'SKIPPED').every((item) => item.errorCode === 'CANCELLED'));
    assert.equal((await call<Batch>(app, 'POST', `/api/v1/job-report-batches/${created.body.id}/cancel`)).status, 200, 'Cancelling twice is harmless');
    assert.equal((await call(app, 'POST', `/api/v1/job-report-batches/${created.body.id}/resume`)).status, 409);
    assert.equal((await advance(app, created.body.id)).body.counts.done, 5);
    assert.equal((await create(app, [ids[0]!])).status, 201, 'A new batch can start after cancelling');
  });

  test('creating is idempotent per key, one batch is active at a time and input is bounded', async () => {
    const app = server();
    const [a, b] = [await addJob(workspace, 'QA Engineer', strong), await addJob(workspace, 'QA Engineer', strong)];
    const key = randomUUID();
    const first = await create(app, [a, b], key);
    const replay = await create(app, [b, a], key);
    assert.equal(replay.status, 200); assert.equal(replay.body.id, first.body.id);
    const conflict = await create(app, [a], key);
    assert.equal(conflict.status, 409); assert.equal(conflict.body.error, 'IDEMPOTENCY_CONFLICT');
    const active = await create(app, [a]);
    assert.equal(active.status, 409); assert.equal(active.body.error, 'JOB_REPORT_BATCH_ACTIVE'); assert.equal(active.body.detail, first.body.id);
    // Two different first clicks at once still create one batch.
    await call(app, 'POST', `/api/v1/job-report-batches/${first.body.id}/cancel`);
    const racing = await Promise.all([create(app, [a]), create(app, [b])]);
    assert.deepEqual(racing.map((result) => result.status).sort(), [201, 409]);
    assert.equal((await client.query(`select count(*)::int as n from job_report_batches where workspace_id = $1 and status in ('RUNNING', 'PAUSED')`, [workspace])).rows[0].n, 1);
    const tooMany = Array.from({ length: domain.JOB_REPORT_BATCH_LIMITS.maxJobs + 1 }, () => randomUUID());
    assert.equal((await create(app, tooMany)).status, 400);
    assert.equal((await create(app, [a, a])).status, 400);
    assert.equal((await create(app, [])).status, 400);
    assert.equal((await call(app, 'POST', '/api/v1/job-report-batches', { jobIds: [a] })).status, 400, 'An idempotency key is required');
  });

  test('concurrent passes evaluate every job exactly once', async () => {
    const calls = new Map<string, number>();
    const app = server((job, context) => { calls.set(job.title, (calls.get(job.title) ?? 0) + 1); return domain.buildJobReport(job, context); });
    const ids = []; for (let index = 0; index < 12; index++) ids.push(await addJob(workspace, `QA Engineer ${index}`, strong));
    const created = await create(app, ids);
    await Promise.all([advance(app, created.body.id), advance(app, created.body.id), advance(app, created.body.id), advance(app, created.body.id)]);
    const final = await call<Batch>(app, 'GET', `/api/v1/job-report-batches/${created.body.id}`);
    assert.equal(final.body.status, 'COMPLETED'); assert.equal(final.body.counts.done, 12);
    assert.equal(calls.size, 12); assert.ok([...calls.values()].every((count) => count === 1));
  });

  test('a batch of another workspace cannot be read, advanced, paused or cancelled', async () => {
    const otherApp = Fastify(); routes.registerJobReportRoutes(otherApp, () => other);
    const job = await addJob(other, 'QA Engineer', strong);
    const created = await create(otherApp, [job]);
    const app = server();
    for (const [method, path] of [['GET', ''], ['POST', '/advance'], ['POST', '/pause'], ['POST', '/resume'], ['POST', '/cancel']] as const) {
      assert.equal((await call(app, method, `/api/v1/job-report-batches/${created.body.id}${path}`)).status, 404, `${method} ${path}`);
    }
    assert.equal((await call<{ batch: null }>(app, 'GET', '/api/v1/job-report-batches/current')).body.batch, null);
    assert.equal((await client.query('select status from job_report_batches where id = $1', [created.body.id])).rows[0].status, 'RUNNING');
  });
});
