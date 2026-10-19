import { trackPgPoolCleanup } from './helpers/pg-pool-cleanup.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@career/db';
import { registerApplicationResumeRoutes } from '../src/application-resume-routes.js';

const root = new URL('../../../', import.meta.url);
const { Client, Pool } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_APPLICATION_DOCUMENTS_TEST_ADMIN_URL;
const digest = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');

test('application resume routes build both drafts, save isolated revisions, restore baseline sentences, and clean race losers', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl!);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname), 'fixture must use loopback');
  assert.equal(maintenance.pathname, '/postgres', 'fixture URL must connect only through the maintenance database');
  const databaseName = `career_resume_routes_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: maintenance.toString() });
  const app = Fastify({ logger: false });
  let client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>; end: () => Promise<void> } | undefined;
  let pool: InstanceType<typeof Pool> | undefined;
  let closePool: (() => Promise<void>) | undefined;
  const filesRoot = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'career-resume-routes-')));
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    maintenance.pathname = `/${databaseName}`;
    client = new Client({ connectionString: maintenance.toString() });
    await client.connect();
    for (const file of (await readdir(new URL('packages/db/migrations', root))).filter((entry) => /^\d{4}_.*\.sql$/u.test(entry)).sort()) {
      const source = await readFile(new URL(`packages/db/migrations/${file}`, root), 'utf8');
      for (const statement of source.split('--> statement-breakpoint').filter((part) => part.trim())) await client.query(statement);
    }
    pool = new Pool({ connectionString: maintenance.toString(), max: 5 });
    closePool = trackPgPoolCleanup(pool);
    const database = drizzle(pool, { schema });
    const workspaceId = randomUUID(); const foreignWorkspaceId = randomUUID(); const jobId = randomUUID(); const snapshotlessJobId = randomUUID();
    const applicationId = randomUUID(); const joblessApplicationId = randomUUID(); const snapshotlessApplicationId = randomUUID(); const profileVersionId = randomUUID(); const foreignProfileVersionId = randomUUID(); const factId = randomUUID(); const suggestedFactId = randomUUID(); const foreignFactId = randomUUID();
    await client.query('INSERT INTO workspaces(id) VALUES($1),($2)', [workspaceId, foreignWorkspaceId]);
    await client.query("INSERT INTO jobs(id,workspace_id,company,title) VALUES($1,$2,'Synthetic Co','QA Engineer'),($3,$2,'Other Co','Designer')", [jobId, workspaceId, snapshotlessJobId]);
    await client.query("INSERT INTO applications(id,workspace_id,job_id,company,role,location) VALUES($1,$2,$3,'Synthetic Co','QA Engineer','Remote'),($4,$2,NULL,'Synthetic Co','Designer','Remote'),($5,$2,$6,'Other Co','Designer','Remote')", [applicationId, workspaceId, jobId, joblessApplicationId, snapshotlessApplicationId, snapshotlessJobId]);
    await client.query("INSERT INTO job_snapshots(id,workspace_id,job_id,title,description_text,snapshot_hash,fetched_at) VALUES($1,$2,$3,'QA Engineer','Required: Python.','snapshot-hash',NOW())", [randomUUID(), workspaceId, jobId]);
    await client.query("INSERT INTO profile_versions(id,workspace_id,revision,profile) VALUES($1,$2,1,$3)", [profileVersionId, workspaceId, { identity: { fullName: 'Synthetic Candidate', email: 'candidate@example.test', phone: '+34 600 000 000' } }]);
    await client.query("INSERT INTO profile_versions(id,workspace_id,revision,profile) VALUES($1,$2,1,'{}')", [foreignProfileVersionId, foreignWorkspaceId]);
    await client.query("INSERT INTO profile_facts(id,workspace_id,profile_version_id,kind,statement,tags,approval_status) VALUES($1,$2,$3,'skill_evidence','I use Python for test automation.','[\"python\"]','USER_APPROVED'),($4,$2,$3,'skill_evidence','I have Kubernetes experience.','[\"kubernetes\"]','SUGGESTED'),($5,$6,$7,'skill_evidence','I use Go in another workspace.','[\"go\"]','USER_APPROVED')", [factId, workspaceId, profileVersionId, suggestedFactId, foreignFactId, foreignWorkspaceId, foreignProfileVersionId]);
    const workspace = (request: { headers: Record<string, unknown> }) => request.headers['x-fixture-workspace'] === foreignWorkspaceId ? foreignWorkspaceId : workspaceId;
    let failRender = false;
    let renderPause: { entered: () => void; wait: Promise<void> } | undefined;
    registerApplicationResumeRoutes(app, workspace, {
      database,
      storageRoot: filesRoot,
      render: async ({ path, fullName, email, role, sentences }) => {
        if (failRender) throw new Error('synthetic renderer failure');
        if (renderPause) {
          const pause = renderPause;
          pause.entered();
          await pause.wait;
          renderPause = undefined;
        }
        assert.equal(fullName, 'Synthetic Candidate');
        assert.equal(email, 'candidate@example.test');
        assert.equal(role, 'QA Engineer');
        const pdf = Buffer.from(`%PDF-1.7\n${sentences.map((sentence) => sentence.text).join('\n')}\n`);
        await writeFile(path, pdf, { flag: 'wx', mode: 0o600 });
        return { absolutePath: path, sha256: digest(pdf), size: pdf.byteLength };
      },
    });
    const headers = { 'x-fixture-workspace': workspaceId };
    const pair = await app.inject({ url: `/api/v1/applications/${applicationId}/document-drafts?language=en`, headers });
    assert.equal(pair.statusCode, 200, pair.body);
    assert.ok(pair.json().resume.sentences.some((sentence: { text: string }) => sentence.text.includes('Python')));
    assert.ok(pair.json().coverLetter.sentences.length > 0);
    assert.ok(!JSON.stringify(pair.json()).includes('Kubernetes'), 'suggested facts never enter either draft');
    assert.equal((await app.inject({ url: `/api/v1/applications/${applicationId}/document-drafts`, headers: { 'x-fixture-workspace': foreignWorkspaceId } })).statusCode, 404);
    assert.equal((await app.inject({ url: `/api/v1/applications/${joblessApplicationId}/document-drafts`, headers })).json().error, 'APPLICATION_HAS_NO_OFFER');
    assert.equal((await app.inject({ url: `/api/v1/applications/${snapshotlessApplicationId}/document-drafts`, headers })).json().error, 'APPLICATION_HAS_NO_OFFER');

    const url = `/api/v1/applications/${applicationId}/resume/revisions`;
    for (const noOfferApplicationId of [joblessApplicationId, snapshotlessApplicationId]) {
      const refused = await app.inject({ method: 'POST', url: `/api/v1/applications/${noOfferApplicationId}/resume/revisions`, headers, payload: { language: 'en' } });
      assert.equal(refused.statusCode, 409);
      assert.equal(refused.json().error, 'APPLICATION_HAS_NO_OFFER');
    }
    assert.equal((await client.query('SELECT count(*)::int AS count FROM application_documents WHERE workspace_id=$1 AND application_id=ANY($2::uuid[])', [workspaceId, [joblessApplicationId, snapshotlessApplicationId]])).rows[0]!.count, 0);
    failRender = true;
    const failedRender = await app.inject({ method: 'POST', url, headers, payload: { language: 'en' } });
    failRender = false;
    assert.equal(failedRender.statusCode, 503);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM application_documents WHERE workspace_id=$1', [workspaceId])).rows[0]!.count, 0);
    const documentDirectories = await readdir(join(filesRoot, workspaceId, 'application-documents'));
    assert.deepEqual(await Promise.all(documentDirectories.map((directory) => readdir(join(filesRoot, workspaceId, 'application-documents', directory)))), documentDirectories.map(() => []), 'failed rendering leaves no document files');
    let markRenderEntered!: () => void;
    let releaseRender!: () => void;
    const renderEntered = new Promise<void>((resolve) => { markRenderEntered = resolve; });
    const renderWait = new Promise<void>((resolve) => { releaseRender = resolve; });
    renderPause = { entered: markRenderEntered, wait: renderWait };
    const staleIdentitySave = app.inject({ method: 'POST', url, headers, payload: { language: 'en' } });
    await renderEntered;
    await client.query('UPDATE profile_versions SET profile=$1 WHERE id=$2 AND workspace_id=$3', [{ identity: { fullName: 'Changed Candidate', email: 'changed@example.test' } }, profileVersionId, workspaceId]);
    releaseRender();
    const staleIdentity = await staleIdentitySave;
    assert.equal(staleIdentity.statusCode, 409);
    assert.equal(staleIdentity.json().error, 'APPLICATION_DOCUMENT_SOURCE_CHANGED');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM application_documents WHERE workspace_id=$1', [workspaceId])).rows[0]!.count, 0);
    const afterStaleIdentityDirectories = await readdir(join(filesRoot, workspaceId, 'application-documents'));
    assert.deepEqual(await Promise.all(afterStaleIdentityDirectories.map((directory) => readdir(join(filesRoot, workspaceId, 'application-documents', directory)))), afterStaleIdentityDirectories.map(() => []), 'a stale printed identity leaves no files');
    await client.query('UPDATE profile_versions SET profile=$1 WHERE id=$2 AND workspace_id=$3', [{ identity: { fullName: 'Synthetic Candidate', email: 'candidate@example.test', phone: '+34 600 000 000' } }, profileVersionId, workspaceId]);
    const first = await app.inject({ method: 'POST', url, headers, payload: { language: 'en' } });
    assert.equal(first.statusCode, 201, first.body);
    const firstBody = first.json();
    const originalClaims = firstBody.revision.claims as Array<{ sentenceId: string; text: string; sourceFactIds: string[] }>;
    const factSentence = originalClaims.find((sentence) => sentence.sourceFactIds.includes(factId));
    assert.ok(factSentence);
    const stored = (await client.query('SELECT * FROM application_document_revisions WHERE workspace_id=$1 AND id=$2', [workspaceId, firstBody.revision.id])).rows[0]!;
    assert.equal(await readFile(join(filesRoot, String(stored.text_storage_path)), 'utf8'), firstBody.text);
    assert.equal(digest(await readFile(join(filesRoot, String(stored.text_storage_path)))), stored.text_sha256);
    assert.equal(digest(await readFile(join(filesRoot, String(stored.pdf_storage_path)))), stored.pdf_sha256);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM application_document_revisions WHERE workspace_id=$1', [foreignWorkspaceId])).rows[0]!.count, 0);
    assert.equal((await app.inject({ url: `/api/v1/applications/${joblessApplicationId}/resume?language=en`, headers })).statusCode, 404, 'a different application in the same workspace cannot read this document');

    for (const unsupportedText of ['I shipped Kubernetes software.', 'I shipped 12 products.', 'I started working in 2020.']) {
      const unsupportedClaims = originalClaims.map((sentence) => ({ sentenceId: sentence.sentenceId, text: sentence.sentenceId === factSentence.sentenceId ? unsupportedText : sentence.text, sourceFactIds: sentence.sourceFactIds }));
      const unsupported = await app.inject({ method: 'POST', url, headers, payload: { language: 'en', parentRevisionId: firstBody.revision.id, sentences: unsupportedClaims } });
      assert.equal(unsupported.statusCode, 422);
      assert.equal(unsupported.json().error, 'UNSUPPORTED_CONTENT');
    }
    for (const rejectedFactId of [suggestedFactId, foreignFactId]) {
      const rejectedFact = await app.inject({ method: 'POST', url, headers, payload: { language: 'en', parentRevisionId: firstBody.revision.id, sentences: originalClaims.map((sentence) => ({ sentenceId: sentence.sentenceId, text: sentence.text, sourceFactIds: sentence.sentenceId === factSentence.sentenceId ? [rejectedFactId] : sentence.sourceFactIds })) } });
      assert.equal(rejectedFact.statusCode, 422);
      assert.equal(rejectedFact.json().error, 'UNSUPPORTED_CONTENT');
    }
    assert.equal((await client.query('SELECT count(*)::int AS count FROM application_document_revisions WHERE workspace_id=$1', [workspaceId])).rows[0]!.count, 1);
    const unsupportedClaims = originalClaims.map((sentence) => ({ sentenceId: sentence.sentenceId, text: sentence.sentenceId === factSentence.sentenceId ? 'I shipped Kubernetes for 12 years.' : sentence.text, sourceFactIds: sentence.sourceFactIds }));
    const confirmedUnsupported = await app.inject({ method: 'POST', url, headers, payload: { language: 'en', parentRevisionId: firstBody.revision.id, sentences: unsupportedClaims, confirmUnsupportedIds: [factSentence.sentenceId] } });
    assert.equal(confirmedUnsupported.statusCode, 201, confirmedUnsupported.body);
    assert.equal(confirmedUnsupported.json().revision.claims.find((sentence: { sentenceId: string }) => sentence.sentenceId === factSentence.sentenceId).origin, 'USER_UNSUPPORTED');

    const removed = await app.inject({ method: 'POST', url, headers, payload: {
      language: 'en', parentRevisionId: confirmedUnsupported.json().revision.id,
      sentences: [{ sentenceId: originalClaims[0]!.sentenceId, text: originalClaims[0]!.text, sourceFactIds: originalClaims[0]!.sourceFactIds }],
    } });
    assert.equal(removed.statusCode, 201, removed.body);
    assert.equal(removed.json().revision.claims.length, 1, 'omitting a sentence removes it from the new revision');

    const restored = await app.inject({ method: 'POST', url, headers, payload: {
      language: 'en', parentRevisionId: removed.json().revision.id,
      sentences: originalClaims.map((sentence) => ({ sentenceId: sentence.sentenceId, text: sentence.text, sourceFactIds: sentence.sourceFactIds })),
    } });
    assert.equal(restored.statusCode, 201, restored.body);
    assert.equal(restored.json().revision.claims.length, originalClaims.length, 'builder baseline sentences can be restored');
    const staleParent = await app.inject({ method: 'POST', url, headers, payload: { language: 'en', parentRevisionId: firstBody.revision.id } });
    assert.equal(staleParent.statusCode, 409);
    assert.equal(staleParent.json().error, 'APPLICATION_DOCUMENT_REVISION_CHANGED');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM application_document_revisions WHERE workspace_id=$1 AND document_id=$2', [workspaceId, firstBody.documentId])).rows[0]!.count, 4);

    const concurrent = await Promise.all([1, 2].map(() => app.inject({ method: 'POST', url, headers, payload: { language: 'en', parentRevisionId: restored.json().revision.id } })));
    assert.deepEqual(concurrent.map((response) => response.statusCode).sort(), [201, 409]);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM application_document_revisions WHERE workspace_id=$1 AND document_id=$2', [workspaceId, firstBody.documentId])).rows[0]!.count, 5);
    const files = await readdir(join(filesRoot, workspaceId, 'application-documents', firstBody.documentId));
    assert.equal(files.length, 10, 'failed, stale and losing saves leave no orphan files');
    const history = await app.inject({ url: `/api/v1/applications/${applicationId}/resume?language=en`, headers });
    assert.equal(history.statusCode, 200, history.body);
    assert.equal(history.json().revisions.length, 5);
    const largeApplicationId = randomUUID();
    await client.query("INSERT INTO applications(id,workspace_id,job_id,company,role,location,application_cycle) VALUES($1,$2,$3,'Synthetic Co','QA Engineer','Remote',2)", [largeApplicationId, workspaceId, jobId]);
    await client.query('UPDATE profile_facts SET statement=$1 WHERE id=$2 AND workspace_id=$3', [`I use Python. ${'Evidence '.repeat(5_000)}`, factId, workspaceId]);
    const tooLarge = await app.inject({ method: 'POST', url: `/api/v1/applications/${largeApplicationId}/resume/revisions`, headers, payload: { language: 'en' } });
    assert.equal(tooLarge.statusCode, 413);
    assert.equal(tooLarge.json().error, 'APPLICATION_DOCUMENT_SIZE_LIMIT');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM application_documents WHERE workspace_id=$1 AND application_id=$2', [workspaceId, largeApplicationId])).rows[0]!.count, 0);
  } finally {
    await app.close();
    await closePool?.();
    await client?.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
    await rm(filesRoot, { recursive: true, force: true });
  }
});

test('resume route refuses a symlinked directory before writing outside the files root', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl!);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname));
  assert.equal(maintenance.pathname, '/postgres');
  const databaseName = `career_resume_path_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: maintenance.toString() });
  const filesRoot = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'career-resume-path-')));
  const outside = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'career-resume-outside-')));
  const app = Fastify({ logger: false });
  let client: { end: () => Promise<void> } | undefined;
  let closePool: (() => Promise<void>) | undefined;
  try {
    await admin.connect(); await admin.query(`CREATE DATABASE "${databaseName}"`);
    maintenance.pathname = `/${databaseName}`; client = new Client({ connectionString: maintenance.toString() }); await client.connect();
    for (const file of (await readdir(new URL('packages/db/migrations', root))).filter((entry) => /^\d{4}_.*\.sql$/u.test(entry)).sort()) {
      const source = await readFile(new URL(`packages/db/migrations/${file}`, root), 'utf8');
      for (const statement of source.split('--> statement-breakpoint').filter((part) => part.trim())) await client.query(statement);
    }
    const pool = new Pool({ connectionString: maintenance.toString(), max: 2 }); closePool = trackPgPoolCleanup(pool);
    const database = drizzle(pool, { schema }); const workspaceId = randomUUID(); const jobId = randomUUID(); const applicationId = randomUUID();
    await client.query('INSERT INTO workspaces(id) VALUES($1)', [workspaceId]);
    await client.query("INSERT INTO jobs(id,workspace_id,company,title) VALUES($1,$2,'Synthetic Co','QA Engineer')", [jobId, workspaceId]);
    await client.query("INSERT INTO applications(id,workspace_id,job_id,company,role) VALUES($1,$2,$3,'Synthetic Co','QA Engineer')", [applicationId, workspaceId, jobId]);
    await client.query("INSERT INTO job_snapshots(workspace_id,job_id,title,description_text,snapshot_hash) VALUES($1,$2,'QA Engineer','Synthetic description','snapshot-hash')", [workspaceId, jobId]);
    await client.query("INSERT INTO profile_versions(workspace_id,revision,profile) VALUES($1,1,'{}')", [workspaceId]);
    await mkdir(join(filesRoot, workspaceId), { recursive: true });
    await symlink(outside, join(filesRoot, workspaceId, 'application-documents'));
    registerApplicationResumeRoutes(app, () => workspaceId, {
      database,
      storageRoot: filesRoot,
      render: async ({ path }) => { const pdf = Buffer.from('%PDF-1.7\n'); await writeFile(path, pdf); return { absolutePath: path, sha256: digest(pdf), size: pdf.byteLength }; },
    });
    const response = await app.inject({ method: 'POST', url: `/api/v1/applications/${applicationId}/resume/revisions`, payload: { language: 'en' } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'APPLICATION_DOCUMENT_RENDER_FAILED');
    assert.deepEqual(await readdir(outside), [], 'the route does not create a directory or file outside the configured root');
    assert.equal((await client.query('SELECT count(*)::int AS count FROM application_documents')).rows[0]!.count, 0);
  } finally {
    await app.close(); await closePool?.(); await client?.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {}); await admin.end().catch(() => {});
    await rm(filesRoot, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
  }
});
