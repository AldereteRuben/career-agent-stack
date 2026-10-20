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
    const first = await app.inject({ method: 'POST', url: `/api/v1/interview-preparation/${plan.id}/sessions`, headers });
    const second = await app.inject({ method: 'POST', url: `/api/v1/interview-preparation/${plan.id}/sessions`, headers });
    assert.equal(first.statusCode, 201); assert.equal(first.json().session.status, 'IN_PROGRESS');
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/interview-preparation/${plan.id}/sessions`, headers: foreignHeaders })).statusCode, 404, 'another workspace cannot start a session');
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
    void second;
  } finally {
    await app.close();
    await closePool?.();
    await client?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
});
