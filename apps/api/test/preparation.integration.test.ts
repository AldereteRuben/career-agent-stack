import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const root = new URL('../../../', import.meta.url);
const { Client } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_PREPARATION_TEST_ADMIN_URL ?? process.env.CAREER_DISCOVERY_TEST_ADMIN_URL;

describe('evidence-based application preparation with a disposable database', { skip: !adminUrl, concurrency: false }, () => {
  const dbName = `career_preparation_${randomBytes(6).toString('hex')}`;
  let admin: InstanceType<typeof Client>; let client: InstanceType<typeof Client>;
  let module: typeof import('../src/application-preparation.js'); let pool: { end(): Promise<void> };
  let workspace: string; let otherWorkspace: string; let jobId: string; let filesPath: string;
  const originalDatabase = process.env.DATABASE_URL; const originalFilesPath = process.env.FILES_LOCAL_PATH;
  const originalEncryption = process.env.APP_ENCRYPTION_KEY; const originalSession = process.env.APP_SESSION_SECRET;

  before(async () => {
    const url = new URL(adminUrl!);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'test database must be local');
    assert.ok(['postgres', 'template1'].includes(url.pathname.slice(1)), 'maintenance database required');
    admin = new Client({ connectionString: url.toString() }); await admin.connect();
    await admin.query(`create database "${dbName}"`); url.pathname = `/${dbName}`;
    process.env.DATABASE_URL = url.toString();
    process.env.APP_ENCRYPTION_KEY = 'fictional-preparation-encryption-key-for-tests-only';
    process.env.APP_SESSION_SECRET = 'fictional-preparation-session-secret-for-tests-only';
    filesPath = await mkdtemp(join(tmpdir(), 'career-preparation-files-')); process.env.FILES_LOCAL_PATH = filesPath;
    client = new Client({ connectionString: url.toString() }); await client.connect();
    for (const file of (await readdir(new URL('packages/db/migrations', root))).filter((entry) => entry.endsWith('.sql')).sort()) await client.query(await readFile(new URL(`packages/db/migrations/${file}`, root), 'utf8'));
    module = await import('../src/application-preparation.js'); pool = (await import('@career/db')).pool;
  });
  after(async () => {
    await pool?.end(); await client?.end();
    if (admin) { await admin.query(`drop database if exists "${dbName}" with (force)`); await admin.end(); }
    if (filesPath) await rm(filesPath, { recursive: true, force: true });
    if (originalDatabase === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabase;
    if (originalFilesPath === undefined) delete process.env.FILES_LOCAL_PATH; else process.env.FILES_LOCAL_PATH = originalFilesPath;
    if (originalEncryption === undefined) delete process.env.APP_ENCRYPTION_KEY; else process.env.APP_ENCRYPTION_KEY = originalEncryption;
    if (originalSession === undefined) delete process.env.APP_SESSION_SECRET; else process.env.APP_SESSION_SECRET = originalSession;
  });
  beforeEach(async () => {
    await client.query('delete from workspaces'); workspace = randomUUID(); otherWorkspace = randomUUID(); jobId = randomUUID();
    await client.query('insert into workspaces(id) values($1),($2)', [workspace, otherWorkspace]);
    await client.query("insert into jobs(id,workspace_id,company,title,availability) values($1,$2,'Fictional Labs','Java QA Engineer','OPEN')", [jobId, workspace]);
    await client.query("insert into job_snapshots(workspace_id,job_id,title,description_text,snapshot_hash) values($1,$2,'Java QA Engineer','Build Java API tests and maintain automated testing.','fixture-hash')", [workspace, jobId]);
  });

  test('route retries a missing profile and same-revision fact approval, fingerprints changes and locale, and reuses one application', async () => {
    const app = Fastify(); module.registerPreparationRoutes(app, (request) => String(request.headers['x-workspace'] ?? workspace));
    try {
      const post = (locale = 'en') => app.inject({ method: 'POST', url: '/api/v1/preparations', headers: { 'x-workspace': workspace }, payload: { jobId, locale } });
      const missingProfile = await post(); assert.equal(missingProfile.statusCode, 200); assert.equal(missingProfile.json().status, 'NEEDS_REVIEW'); assert.ok(missingProfile.json().gaps.includes('PROFILE_REQUIRED'));
      const applicationId = missingProfile.json().applicationId as string;
      const queueItem = async () => (await app.inject({ url: '/api/v1/preparations', headers: { 'x-workspace': workspace } })).json()[0];
      assert.equal((await queueItem()).queueState, 'NEEDS_DETAILS');
      await client.query("insert into profile_versions(id,workspace_id,revision,locale,profile) values($1,$2,1,'en-GB',$3)", [randomUUID(), workspace, { identity: { fullName: 'Fictional Candidate', email: 'candidate@example.test' } }]);
      const profileId = (await client.query('select id from profile_versions where workspace_id = $1', [workspace])).rows[0].id as string;
      await client.query("insert into answer_versions(workspace_id,semantic_key,jurisdiction,question_scope,question_text,value,strategy,approval_status,revision) values($1,'java_experience','ES','java.api_testing','Have you tested Java APIs?',$2,'stored','USER_APPROVED',1)", [workspace, JSON.stringify('yes')]);
      const factId = randomUUID();
      await client.query("insert into profile_facts(id,workspace_id,profile_version_id,kind,statement,tags,approval_status) values($1,$2,$3,'skill_evidence','Built Java API tests using REST Assured.',$4,'SUGGESTED')", [factId, workspace, profileId, JSON.stringify(['java', 'api-testing'])]);
      const unapproved = await post(); assert.equal(unapproved.json().status, 'NEEDS_REVIEW'); assert.equal(unapproved.json().applicationId, applicationId);
      await client.query("update profile_facts set approval_status = 'USER_APPROVED', approved_at = now() where id = $1", [factId]);
      const preparedResponse = await post(); const prepared = preparedResponse.json(); assert.equal(prepared.status, 'PREPARED'); assert.equal(prepared.applicationId, applicationId); assert.ok(prepared.documentId);
      const firstDocument = prepared.documentId as string;
      const aliasId = randomUUID(); const aliasIdentity = 'f'.repeat(64);
      await client.query("insert into jobs(id,workspace_id,company,title,availability) values($1,$2,'Fictional Labs','Java QA Engineer','OPEN')", [aliasId, workspace]);
      await client.query("insert into job_identity_members(workspace_id,job_id,identity_key,evidence) values($1,$2,$4,'{}'),($1,$3,$4,'{}')", [workspace, jobId, aliasId, aliasIdentity]);
      const resumeApp = Fastify();
      (await import('../src/resume-journey.js')).registerResumeJourney(resumeApp, () => workspace);
      try {
        const attempts = await Promise.all([1, 2].map(() => resumeApp.inject({ method: 'POST', url: '/api/v1/applications/with-resume', payload: { jobId: aliasId, documentId: firstDocument } })));
        for (const attempt of attempts) { assert.equal(attempt.statusCode, 409); assert.equal(attempt.json().error, 'APPLICATION_ALREADY_EXISTS'); assert.equal(attempt.json().applicationId, applicationId); }
        assert.equal((await client.query('select count(*)::int as n from applications where workspace_id=$1', [workspace])).rows[0].n, 1);
      } finally { await resumeApp.close(); }

      assert.equal((await queueItem()).queueState, 'REVIEW_DOCUMENT');
      assert.equal(prepared.answerSuggestions[0].provenance.startsWith('Approved stored answer'), true);
      const repeated = (await post()).json(); assert.equal(repeated.documentId, firstDocument); assert.equal(repeated.applicationId, applicationId);
      assert.equal((await client.query('select count(*)::int as n from applications where workspace_id = $1 and job_id = $2', [workspace, jobId])).rows[0].n, 1);
      assert.equal((await client.query('select count(*)::int as n from document_versions where workspace_id = $1', [workspace])).rows[0].n, 1);

      await client.query("update profile_facts set statement = 'Built Java API tests and automated release checks.' where id = $1", [factId]);
      const changed = (await post()).json(); assert.equal(changed.applicationId, applicationId); assert.notEqual(changed.documentId, firstDocument);
      assert.equal((await client.query('select count(*)::int as n from document_versions where workspace_id = $1', [workspace])).rows[0].n, 2);
      assert.equal((await client.query('select application_cycle from applications where id = $1', [applicationId])).rows[0].application_cycle, 1);

      let spanish = (await post('es')).json(); assert.equal(spanish.applicationId, applicationId); assert.notEqual(spanish.documentId, changed.documentId);
      assert.match(spanish.selectedFacts[0].reason, /^Coincide con el anuncio:/);
      assert.match(spanish.answerSuggestions[0].provenance, /^Respuesta aprobada/);
      assert.equal(spanish.answerSuggestions[0].provenance.includes('Approved'), false);
      assert.equal((await client.query('select language from document_versions where id = $1', [spanish.documentId])).rows[0].language, 'es');
      assert.equal((await app.inject({ url: '/api/v1/preparations', headers: { 'x-workspace': workspace } })).json()[0].status, 'PREPARED');

      const englishAgain = (await post('en')).json();
      assert.equal((await client.query('select document_id from applications where id=$1', [applicationId])).rows[0].document_id, englishAgain.documentId, 'Returning to a previous locale keeps the returned PDF linked to the application');
      assert.equal((await app.inject({ url: '/api/v1/preparations', headers: { 'x-workspace': workspace } })).json()[0].documentId, englishAgain.documentId, 'The queue shows the latest preparation');
      spanish = (await post('es')).json();

      for (const state of ['CONFIRMED', 'UNKNOWN', 'CANCELLED']) {
        await client.query('update applications set state = $1 where id = $2', [state, applicationId]);
        const current = await queueItem();
        assert.equal(current.queueState, state === 'CONFIRMED' ? 'SUBMITTED' : state === 'UNKNOWN' ? 'UNCERTAIN' : 'CLOSED');
        assert.equal(current.needsAttention, state === 'UNKNOWN'); assert.equal(current.canPrepare, false);
        const protectedResult = (await post('es')).json(); assert.equal(protectedResult.status, 'BLOCKED'); assert.equal(protectedResult.reason, 'APPLICATION_CLOSED_OR_UNCERTAIN');
      }
      await client.query("update applications set state = 'REVIEW_REQUIRED' where id = $1", [applicationId]);
      await client.query("update document_versions set approval_status = 'USER_APPROVED' where id = $1", [spanish.documentId]);
      assert.equal((await queueItem()).queueState, 'READY');
      const preserved = (await post('en')).json(); assert.equal(preserved.status, 'BLOCKED'); assert.equal(preserved.reason, 'USER_SELECTED_DOCUMENT_PRESERVED'); assert.equal(preserved.applicationId, applicationId);
    } finally { await app.close(); }
  });

  test('scopes jobs to the workspace and rejects malformed job ids at the route', async () => {
    const app = Fastify(); module.registerPreparationRoutes(app, (request) => String(request.headers['x-workspace'] ?? workspace));
    try {
      const foreign = await module.prepareApplication(otherWorkspace, jobId, 'en'); assert.equal(foreign.status, 'BLOCKED'); assert.equal(foreign.reason, 'JOB_NOT_FOUND');
      const invalid = await app.inject({ method: 'POST', url: '/api/v1/preparations', payload: { jobId: 'not-a-uuid', locale: 'en' } });
      assert.equal(invalid.statusCode, 400); assert.equal(invalid.json().error, 'INVALID_PREPARATION_REQUEST');
    } finally { await app.close(); }
  });
});
