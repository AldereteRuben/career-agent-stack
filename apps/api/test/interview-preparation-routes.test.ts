import { trackPgPoolCleanup } from './helpers/pg-pool-cleanup.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@career/db';
import { registerInterviewPreparationRoutes } from '../src/interview-preparation-routes.js';

const root = new URL('../../../', import.meta.url);
const { Client, Pool } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_INTERVIEW_PREPARATION_TEST_ADMIN_URL;

test('interview preparation plans keep references and hashes, flag stale evidence and delete cleanly within their workspace', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl!);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname), 'fixture must use loopback');
  assert.equal(maintenance.pathname, '/postgres', 'fixture URL must connect only through the maintenance database');
  const databaseName = `career_interview_prep_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: maintenance.toString() });
  const app = Fastify({ logger: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;
  let pool: InstanceType<typeof Pool> | undefined;
  let closePool: (() => Promise<void>) | undefined;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    maintenance.pathname = `/${databaseName}`;
    client = new Client({ connectionString: maintenance.toString() });
    await client.connect();
    for (const file of (await readdir(new URL('packages/db/migrations', root))).filter((entry) => /^\d{4}_.*\.sql$/.test(entry)).sort()) {
      for (const statement of (await readFile(new URL(`packages/db/migrations/${file}`, root), 'utf8')).split('--> statement-breakpoint').filter((part) => part.trim())) await client.query(statement);
    }
    pool = new Pool({ connectionString: maintenance.toString(), max: 5 });
    closePool = trackPgPoolCleanup(pool);
    const database = drizzle(pool, { schema });

    const owner = randomUUID(); const other = randomUUID();
    const [profileVersion, job, snapshot, otherSnapshot, resume, otherResume, fact, factTwo, suggested, application, otherApplication, foreignApplication, foreignFact] = Array.from({ length: 13 }, () => randomUUID());
    await client.query('INSERT INTO workspaces(id) VALUES($1),($2)', [owner, other]);
    await client.query("INSERT INTO profile_versions(id,workspace_id,revision,profile) VALUES($1,$2,1,'{}')", [profileVersion, owner]);
    await client.query("INSERT INTO profile_versions(id,workspace_id,revision,profile) VALUES($1,$2,1,'{}')", [foreignFact, other]);
    await client.query("INSERT INTO profile_facts(id,workspace_id,profile_version_id,kind,statement,approval_status) VALUES($1,$2,$3,'skill','Built synthetic dashboards','USER_APPROVED'),($4,$2,$3,'skill','Led a fictional migration','USER_APPROVED'),($5,$2,$3,'skill','Unreviewed suggestion','SUGGESTED')", [fact, owner, profileVersion, factTwo, suggested]);
    await client.query("INSERT INTO jobs(id,workspace_id,company,title) VALUES($1,$2,'Synthetic Co','Designer'),($3,$2,'Other Co','Engineer')", [job, owner, randomUUID()]);
    await client.query("INSERT INTO job_snapshots(id,workspace_id,job_id,title,snapshot_hash) VALUES($1,$2,$3,'Designer',$4)", [snapshot, owner, job, 'b'.repeat(64)]);
    const otherJob = (await client.query("SELECT id FROM jobs WHERE workspace_id=$1 AND company='Other Co'", [owner])).rows[0].id;
    await client.query("INSERT INTO job_snapshots(id,workspace_id,job_id,title,snapshot_hash) VALUES($1,$2,$3,'Engineer',$4)", [otherSnapshot, owner, otherJob, 'c'.repeat(64)]);
    await client.query("INSERT INTO document_versions(id,workspace_id,name,revision,media_type,storage_path,sha256,profile_revision_id) VALUES($1,$3,'Resume',1,'application/pdf',$4,$5,$6),($2,$3,'Other resume',2,'application/pdf',$7,$8,$6)", [resume, otherResume, owner, `${owner}/resume.pdf`, 'd'.repeat(64), profileVersion, `${owner}/other.pdf`, 'e'.repeat(64)]);
    await client.query("INSERT INTO applications(id,workspace_id,company,role,job_id,document_id) VALUES($1,$2,'Synthetic Co','Designer',$3,$4),($5,$2,'Synthetic Co','Sibling',NULL,NULL),($6,$7,'Foreign Co','Designer',NULL,NULL)", [application, owner, job, resume, otherApplication, foreignApplication, other]);

    const workspace = (request: { headers: Record<string, unknown> }) => request.headers['x-fixture-workspace'] === other ? other : owner;
    registerInterviewPreparationRoutes(app, workspace, database);
    const headers = { 'x-fixture-workspace': owner }; const foreignHeaders = { 'x-fixture-workspace': other };
    const list = (id: string) => `/api/v1/applications/${id}/interview-preparation`;
    const create = (id: string, payload: unknown, h = headers) => app.inject({ method: 'POST', url: list(id), headers: h, payload: payload as object });
    const count = async (table: string) => Number((await client.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

    // Input and ownership checks.
    assert.equal((await app.inject({ url: list(randomUUID()), headers })).statusCode, 404, 'unknown applications are not exposed');
    assert.equal((await app.inject({ url: list(foreignApplication), headers })).statusCode, 404, 'foreign applications are hidden');
    assert.equal((await app.inject({ url: '/api/v1/applications/not-a-uuid/interview-preparation', headers })).statusCode, 400);
    assert.equal((await create(application, { language: 'fr' })).statusCode, 400, 'unsupported languages are rejected');
    assert.equal((await create(application, { language: 'es', extra: true })).statusCode, 400, 'unexpected fields are rejected');
    assert.equal((await create(application, { language: 'es', evidence: [{ kind: 'SKILL', sourceId: fact }] })).statusCode, 400, 'unknown evidence kinds are rejected');
    assert.equal((await create(randomUUID(), { language: 'es' })).statusCode, 404, 'plans cannot be created for missing applications');
    assert.equal((await create(foreignApplication, { language: 'es' })).statusCode, 404, 'plans cannot be created for another workspace');
    assert.equal((await create(application, { language: 'es', evidence: [{ kind: 'APPROVED_FACT', sourceId: randomUUID() }] })).json().error, 'EVIDENCE_NOT_FOUND');
    assert.equal((await create(application, { language: 'es', evidence: [{ kind: 'APPROVED_FACT', sourceId: foreignFact }] })).json().error, 'EVIDENCE_NOT_FOUND', 'another workspace evidence is not visible');
    assert.equal((await create(application, { language: 'es', evidence: [{ kind: 'APPROVED_FACT', sourceId: suggested }] })).json().error, 'EVIDENCE_NOT_APPROVED', 'a suggested fact is not evidence');
    assert.equal((await create(application, { language: 'es', evidence: [{ kind: 'JOB_SNAPSHOT', sourceId: otherSnapshot }] })).json().error, 'EVIDENCE_NOT_FOR_APPLICATION', 'another job snapshot is rejected');
    assert.equal((await create(application, { language: 'es', evidence: [{ kind: 'RESUME_VERSION', sourceId: otherResume }] })).json().error, 'EVIDENCE_NOT_FOR_APPLICATION', 'only the resume of this application is evidence');
    assert.equal((await create(otherApplication, { language: 'es', evidence: [{ kind: 'JOB_SNAPSHOT', sourceId: snapshot }] })).json().error, 'EVIDENCE_NOT_FOR_APPLICATION', 'an application without a job cannot use a snapshot');
    assert.equal(await count('interview_preparation_plans'), 0, 'rejected requests leave nothing behind');

    // A plan stores references and hashes, never the text it was made from.
    const created = await create(application, { language: 'en', stage: 'INTERVIEW', evidence: [{ kind: 'JOB_SNAPSHOT', sourceId: snapshot }, { kind: 'RESUME_VERSION', sourceId: resume }, { kind: 'APPROVED_FACT', sourceId: fact }, { kind: 'APPROVED_FACT', sourceId: fact }, { kind: 'APPROVED_FACT', sourceId: factTwo }] });
    assert.equal(created.statusCode, 201, created.body);
    const plan = created.json().plan; assert.equal(plan.applicationId, application); assert.equal(plan.language, 'en'); assert.equal(plan.stage, 'INTERVIEW');
    assert.equal(plan.evidence.length, 4, 'a repeated reference is stored once');
    assert.deepEqual([...new Set(plan.evidence.map((row: { status: string }) => row.status))], ['CURRENT']); assert.equal(plan.needsReview, false);
    assert.ok(!JSON.stringify(created.json()).includes('Built synthetic dashboards'), 'the response carries no profile text');
    const stored = (await client.query('SELECT kind, content_sha256 FROM interview_preparation_evidence WHERE plan_id=$1 ORDER BY kind, source_id', [plan.id])).rows;
    assert.ok(stored.every((row: { content_sha256: string }) => /^[0-9a-f]{64}$/.test(row.content_sha256)));
    assert.equal(stored.find((row: { kind: string }) => row.kind === 'JOB_SNAPSHOT').content_sha256, 'b'.repeat(64));
    assert.equal(stored.find((row: { kind: string }) => row.kind === 'RESUME_VERSION').content_sha256, 'd'.repeat(64));
    const columns = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'interview_preparation_evidence'`)).rows.map((row: { column_name: string }) => row.column_name);
    assert.ok(!columns.includes('statement') && !columns.includes('content'), 'evidence rows keep no copy of the evidence');

    // Opening the plan recomputes currency against today's records.
    const status = async () => Object.fromEntries((await app.inject({ url: `/api/v1/interview-preparation/${plan.id}`, headers })).json().plan.evidence.map((row: { kind: string; sourceId: string; status: string }) => [`${row.kind}:${row.sourceId}`, row.status]));
    assert.equal((await status())[`APPROVED_FACT:${fact}`], 'CURRENT');
    await client.query("UPDATE profile_facts SET statement='Built synthetic dashboards, edited' WHERE id=$1", [fact]);
    await client.query("UPDATE profile_facts SET approval_status='REJECTED' WHERE id=$1", [factTwo]);
    await client.query("UPDATE job_snapshots SET snapshot_hash=$2 WHERE id=$1", [snapshot, 'f'.repeat(64)]);
    await client.query("UPDATE applications SET document_id=NULL WHERE id=$1", [application]);
    await client.query('DELETE FROM document_versions WHERE id=$1', [resume]);
    const after = await status();
    assert.equal(after[`APPROVED_FACT:${fact}`], 'STALE', 'edited fact text makes the evidence stale');
    assert.equal(after[`APPROVED_FACT:${factTwo}`], 'STALE', 'a withdrawn fact is stale');
    assert.equal(after[`JOB_SNAPSHOT:${snapshot}`], 'STALE', 'a changed offer is stale');
    assert.equal(after[`RESUME_VERSION:${resume}`], 'MISSING', 'a removed resume is missing');
    const reopened = (await app.inject({ url: list(application), headers })).json().plans;
    assert.equal(reopened.length, 1); assert.equal(reopened[0].needsReview, true);
    assert.equal((await app.inject({ url: list(otherApplication), headers })).json().plans.length, 0, 'another application has its own plans');
    assert.equal((await app.inject({ url: `/api/v1/interview-preparation/${plan.id}`, headers: foreignHeaders })).statusCode, 404, 'another workspace cannot read the plan');

    // Items and turns belong to a plan or session and go with it; sessions can be deleted on their own.
    // Starting and running a session belongs to the mock session routes, tested in interview-mock-session-routes.test.ts.
    const firstSession = randomUUID();
    await client.query("INSERT INTO interview_preparation_sessions(id,workspace_id,plan_id) VALUES($1,$3,$2),($4,$3,$2)", [firstSession, plan.id, owner, randomUUID()]);
    const first = { json: () => ({ session: { id: firstSession } }) };
    const evidenceId = plan.evidence[0].id;
    await client.query("INSERT INTO interview_preparation_items(workspace_id,plan_id,kind,origin,position,content,evidence_id) VALUES($1,$2,'REQUIREMENT','JOB_SNAPSHOT',0,'Fictional requirement',$3),($1,$2,'NOTE','USER_NOTE',1,'My own note',NULL)", [owner, plan.id, evidenceId]);
    await client.query("INSERT INTO interview_preparation_turns(workspace_id,session_id,position,question,answer,learning_items) VALUES($1,$2,0,'Fictional question','Fictional answer','[\"Review caching\"]')", [owner, first.json().session.id]);
    await assert.rejects(client.query("INSERT INTO interview_preparation_items(workspace_id,plan_id,kind,origin,position,content) VALUES($1,$2,'QUESTION','GUESSED',2,'x')", [owner, plan.id]), (error: { code?: string }) => error.code === '23514', 'only known origins are stored');
    await assert.rejects(client.query("INSERT INTO interview_preparation_plans(workspace_id,application_id,language) VALUES($1,$2,'es')", [other, application]), (error: { code?: string }) => error.code === '23503', 'a plan cannot point at another workspace application');
    const detail = (await app.inject({ url: `/api/v1/interview-preparation/${plan.id}`, headers })).json().plan;
    assert.deepEqual(detail.items.map((item: { origin: string }) => item.origin), ['JOB_SNAPSHOT', 'USER_NOTE']);
    assert.equal(detail.sessions.length, 2);
    assert.equal(detail.sessions.find((session: { id: string }) => session.id === first.json().session.id).turns[0].answer, 'Fictional answer');

    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/interview-preparation/sessions/${first.json().session.id}`, headers: foreignHeaders })).statusCode, 404, 'another workspace cannot delete a session');
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/interview-preparation/sessions/${first.json().session.id}`, headers })).statusCode, 200);
    assert.equal(await count('interview_preparation_turns'), 0, 'deleting a session removes its turns');
    assert.equal(await count('interview_preparation_sessions'), 1); assert.equal(await count('interview_preparation_items'), 2, 'the plan keeps its items');
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/interview-preparation/sessions/${first.json().session.id}`, headers })).statusCode, 404);

    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/interview-preparation/${plan.id}`, headers: foreignHeaders })).statusCode, 404, 'another workspace cannot delete the plan');
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/interview-preparation/${plan.id}`, headers })).statusCode, 200);
    for (const table of ['plans', 'evidence', 'items', 'sessions', 'turns']) assert.equal(await count(`interview_preparation_${table}`), 0, `deleting a plan removes its ${table}`);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM profile_facts WHERE workspace_id=$1', [owner])).rows[0].n, 3, 'deleting a plan never touches approved facts');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM job_snapshots WHERE workspace_id=$1', [owner])).rows[0].n, 2, 'deleting a plan never touches the offer');
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/interview-preparation/${plan.id}`, headers })).statusCode, 404);
  } finally {
    await app.close();
    await closePool?.();
    await client?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});

test('building a no-AI plan uses the saved offer, the stage and approved facts only, and people can add their own notes', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl!);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname), 'fixture must use loopback');
  assert.equal(maintenance.pathname, '/postgres', 'fixture URL must connect only through the maintenance database');
  const databaseName = `career_interview_plan_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: maintenance.toString() });
  const app = Fastify({ logger: false });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let client: any;
  let pool: InstanceType<typeof Pool> | undefined;
  let closePool: (() => Promise<void>) | undefined;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    maintenance.pathname = `/${databaseName}`;
    client = new Client({ connectionString: maintenance.toString() });
    await client.connect();
    for (const file of (await readdir(new URL('packages/db/migrations', root))).filter((entry) => /^\d{4}_.*\.sql$/.test(entry)).sort()) {
      for (const statement of (await readFile(new URL(`packages/db/migrations/${file}`, root), 'utf8')).split('--> statement-breakpoint').filter((part) => part.trim())) await client.query(statement);
    }
    pool = new Pool({ connectionString: maintenance.toString(), max: 5 });
    closePool = trackPgPoolCleanup(pool);
    const database = drizzle(pool, { schema });

    const owner = randomUUID(); const other = randomUUID();
    const [profileVersion, job, snapshot, resume, fact, suggested, application, bareApplication, foreignApplication] = Array.from({ length: 9 }, () => randomUUID());
    const factText = 'Built TypeScript services for a fictional shop';
    await client.query('INSERT INTO workspaces(id) VALUES($1),($2)', [owner, other]);
    await client.query("INSERT INTO profile_versions(id,workspace_id,revision,profile) VALUES($1,$2,1,'{}')", [profileVersion, owner]);
    await client.query(`INSERT INTO profile_facts(id,workspace_id,profile_version_id,kind,statement,tags,approval_status) VALUES($1,$3,$4,'skill',$5,'["typescript"]','USER_APPROVED'),($2,$3,$4,'skill','Used Docker once','["docker"]','SUGGESTED')`, [fact, suggested, owner, profileVersion, factText]);
    await client.query("INSERT INTO jobs(id,workspace_id,company,title) VALUES($1,$2,'Synthetic Co','QA Engineer')", [job, owner]);
    await client.query("INSERT INTO job_snapshots(id,workspace_id,job_id,title,description_text,snapshot_hash) VALUES($1,$2,$3,'QA Engineer',$4,$5)", [snapshot, owner, job, 'Requirements:\nTypeScript\nPlaywright\nNice to have:\nDocker', 'b'.repeat(64)]);
    await client.query("INSERT INTO document_versions(id,workspace_id,name,revision,media_type,storage_path,sha256,profile_revision_id) VALUES($1,$2,'Resume',1,'application/pdf',$3,$4,$5)", [resume, owner, `${owner}/resume.pdf`, 'd'.repeat(64), profileVersion]);
    await client.query("INSERT INTO applications(id,workspace_id,company,role,job_id,document_id,recruitment_stage) VALUES($1,$2,'Synthetic Co','QA Engineer',$3,$4,'INTERVIEW'),($5,$2,'Bare Co','Designer',NULL,NULL,'OFFER'),($6,$7,'Foreign Co','QA',NULL,NULL,'INTERVIEW')", [application, owner, job, resume, bareApplication, foreignApplication, other]);

    const workspace = (request: { headers: Record<string, unknown> }) => request.headers['x-fixture-workspace'] === other ? other : owner;
    registerInterviewPreparationRoutes(app, workspace, database);
    const headers = { 'x-fixture-workspace': owner }; const foreignHeaders = { 'x-fixture-workspace': other };
    const build = (id: string, payload: unknown, h = headers) => app.inject({ method: 'POST', url: `/api/v1/applications/${id}/interview-preparation/build`, headers: h, payload: payload as object });

    assert.equal((await build(application, { language: 'fr' })).statusCode, 400, 'unsupported languages are rejected');
    assert.equal((await build(application, { language: 'es', extra: 1 })).statusCode, 400, 'unexpected fields are rejected');
    assert.equal((await build(randomUUID(), { language: 'es' })).statusCode, 404);
    assert.equal((await build(foreignApplication, { language: 'es' })).statusCode, 404, 'another workspace application is hidden');
    assert.equal((await build(application, { language: 'es' }, foreignHeaders)).statusCode, 404);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM interview_preparation_plans')).rows[0].n, 0, 'rejected requests leave nothing behind');

    // The plan is made from the offer, the stage and the approved facts, with provenance on every item.
    const built = await build(application, { language: 'es' });
    assert.equal(built.statusCode, 201, built.body);
    const plan = built.json().plan;
    assert.equal(plan.language, 'es'); assert.equal(plan.stage, 'INTERVIEW', 'the stage comes from the application'); assert.equal(plan.needsReview, false);
    assert.deepEqual(plan.evidence.map((row: { kind: string }) => row.kind).sort(), ['APPROVED_FACT', 'JOB_SNAPSHOT', 'RESUME_VERSION'], 'the offer, the submitted resume and only the cited fact');
    assert.ok(!plan.evidence.some((row: { sourceId: string }) => row.sourceId === suggested), 'a suggested fact is never evidence');
    const requirement = (skill: string) => plan.items.find((item: { kind: string; content: string }) => item.kind === 'REQUIREMENT' && item.content === skill);
    assert.equal(requirement('typescript').support, 'SUPPORTED'); assert.deepEqual(requirement('typescript').factIds, [fact]);
    assert.equal(requirement('playwright').support, 'UNKNOWN'); assert.deepEqual(requirement('playwright').factIds, []);
    assert.equal(requirement('docker').support, 'UNKNOWN', 'a suggested fact does not back a requirement');
    const offerEvidence = plan.evidence.find((row: { kind: string }) => row.kind === 'JOB_SNAPSHOT').id;
    assert.equal(requirement('typescript').evidenceId, offerEvidence, 'a requirement points at the offer it came from');
    assert.ok(plan.items.every((item: { origin: string }) => ['JOB_SNAPSHOT', 'FIXED_TEMPLATE'].includes(item.origin)), 'the plan only holds offer and fixed template items');
    assert.deepEqual(plan.items.map((item: { position: number }) => item.position), plan.items.map((_: unknown, index: number) => index), 'items keep their reading order');
    assert.ok(plan.items.some((item: { kind: string; content: string }) => item.kind === 'STUDY' && /repasa playwright/.test(item.content)));
    assert.ok(plan.items.some((item: { kind: string }) => item.kind === 'QUESTION'));
    assert.ok(!JSON.stringify(built.json()).includes(factText), 'the response carries no profile text');
    assert.equal((await client.query("SELECT count(*)::int AS n FROM profile_facts WHERE workspace_id=$1 AND approval_status='USER_APPROVED'", [owner])).rows[0].n, 1, 'building a plan changes no fact');

    // A stage can be chosen; an application without an offer still gets a useful plan.
    const offerPlan = (await build(application, { language: 'en', stage: 'OFFER' })).json().plan;
    assert.equal(offerPlan.stage, 'OFFER');
    assert.ok(offerPlan.items.some((item: { content: string }) => /confirm about the offer/.test(item.content)));
    const bare = (await build(bareApplication, { language: 'en' })).json().plan;
    assert.equal(bare.stage, 'OFFER'); assert.deepEqual(bare.evidence, []);
    assert.ok(bare.items.some((item: { kind: string; content: string }) => item.kind === 'NOTE' && /no saved job/.test(item.content)));
    assert.equal(bare.items.filter((item: { kind: string }) => item.kind === 'REQUIREMENT').length, 0);

    // Evidence still ages: an edited fact makes the built plan stale when it is opened.
    await client.query('UPDATE profile_facts SET statement=$2 WHERE id=$1', [fact, 'Built TypeScript services, edited']);
    const reopened = (await app.inject({ url: `/api/v1/interview-preparation/${plan.id}`, headers })).json().plan;
    assert.equal(reopened.needsReview, true);
    assert.equal(reopened.evidence.find((row: { kind: string }) => row.kind === 'APPROVED_FACT').status, 'STALE');

    // People add their own notes and questions; generated items cannot be rewritten, only removed.
    const itemsUrl = `/api/v1/interview-preparation/${plan.id}/items`;
    const add = (payload: unknown, url = itemsUrl, h = headers) => app.inject({ method: 'POST', url, headers: h, payload: payload as object });
    assert.equal((await add({ kind: 'REQUIREMENT', content: 'x' })).statusCode, 400, 'people cannot add requirements');
    assert.equal((await add({ kind: 'NOTE', origin: 'ASSISTANT', content: 'x' })).statusCode, 400, 'people cannot claim another origin');
    assert.equal((await add({ kind: 'NOTE', content: '   ' })).statusCode, 400, 'empty text is rejected');
    assert.equal((await add({ kind: 'NOTE', content: 'x'.repeat(2001) })).statusCode, 400);
    assert.equal((await add({ kind: 'NOTE', content: 'x' }, itemsUrl, foreignHeaders)).statusCode, 404, 'another workspace cannot add to the plan');
    assert.equal((await add({ kind: 'NOTE', content: 'x' }, `/api/v1/interview-preparation/${randomUUID()}/items`)).statusCode, 404);
    const note = await add({ kind: 'NOTE', content: '  The team uses Playwright every day  ' });
    assert.equal(note.statusCode, 201, note.body);
    assert.deepEqual([note.json().item.kind, note.json().item.origin, note.json().item.content, note.json().item.position], ['NOTE', 'USER_NOTE', 'The team uses Playwright every day', plan.items.length]);
    const research = await add({ kind: 'QUESTION', origin: 'USER_RESEARCH', content: 'Ask about their release cadence' });
    assert.equal(research.json().item.origin, 'USER_RESEARCH');
    const parallel = await Promise.all(Array.from({ length: 5 }, (_, index) => add({ kind: 'NOTE', content: `Parallel ${index}` })));
    assert.ok(parallel.every((response) => response.statusCode === 201));
    const positions = (await client.query('SELECT position FROM interview_preparation_items WHERE plan_id=$1', [plan.id])).rows.map((row: { position: number }) => row.position);
    assert.equal(new Set(positions).size, positions.length, 'concurrent additions never share a position');

    const patch = (id: string, payload: unknown, h = headers) => app.inject({ method: 'PATCH', url: `/api/v1/interview-preparation/items/${id}`, headers: h, payload: payload as object });
    const edited = await patch(note.json().item.id, { content: 'The team uses Playwright and Cypress' });
    assert.equal(edited.statusCode, 200); assert.equal(edited.json().item.content, 'The team uses Playwright and Cypress');
    assert.equal((await patch(note.json().item.id, { content: 'x' }, foreignHeaders)).statusCode, 404, 'another workspace cannot edit');
    assert.equal((await patch(note.json().item.id, { content: '' })).statusCode, 400);
    assert.equal((await patch(note.json().item.id, { content: 'x', kind: 'STUDY' })).statusCode, 400, 'only the text can change');
    assert.equal((await patch(requirement('typescript').id, { content: 'I am an expert' })).json().error, 'ITEM_NOT_EDITABLE', 'a generated item cannot be rewritten');
    assert.equal((await patch(randomUUID(), { content: 'x' })).statusCode, 404);

    const remove = (id: string, h = headers) => app.inject({ method: 'DELETE', url: `/api/v1/interview-preparation/items/${id}`, headers: h });
    assert.equal((await remove(note.json().item.id, foreignHeaders)).statusCode, 404);
    assert.equal((await remove(note.json().item.id)).statusCode, 200);
    assert.equal((await remove(requirement('docker').id)).statusCode, 200, 'a generated item can be removed');
    assert.equal((await remove(requirement('docker').id)).statusCode, 404);
    assert.ok(!(await app.inject({ url: `/api/v1/interview-preparation/${plan.id}`, headers })).json().plan.items.some((item: { id: string }) => item.id === note.json().item.id));

    // A plan has a bounded size.
    const total = Number((await client.query('SELECT count(*)::int AS n FROM interview_preparation_items WHERE plan_id=$1', [plan.id])).rows[0].n);
    await client.query("INSERT INTO interview_preparation_items(workspace_id,plan_id,kind,origin,position,content) SELECT $1,$2,'NOTE','USER_NOTE',10000+g,'filler' FROM generate_series(1,$3::int) g", [owner, plan.id, 300 - total]);
    assert.equal((await add({ kind: 'NOTE', content: 'one too many' })).json().error, 'PLAN_FULL');
  } finally {
    await app.close();
    await closePool?.();
    await client?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});
