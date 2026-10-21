// Creates a disposable loopback database and applies migrations in order to each target version.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const { Client } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_APPLICATION_DOCUMENTS_TEST_ADMIN_URL;
const migrationDir = new URL('packages/db/migrations/', root);
const applyMigration = async (client, file) => {
  const sql = await readFile(new URL(file, migrationDir), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint').filter((part) => part.trim())) await client.query(statement);
};
const foreignKey = (constraint) => (error) => error.code === '23503' && error.constraint === constraint;

test('0019 adds application documents without changing attached resumes and enforces workspace constraints', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname), 'migration fixture must use loopback');
  assert.equal(maintenance.pathname, '/postgres', 'migration fixture URL must connect only through maintenance database');
  const database = `career_appdocs_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: maintenance.toString() });
  let client; let files;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    maintenance.pathname = `/${database}`;
    client = new Client({ connectionString: maintenance.toString() });
    await client.connect();

    const migrations = (await readdir(migrationDir)).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort();
    const targetMigration = migrations.indexOf('0019_application_documents.sql');
    assert.notEqual(targetMigration, -1, '0019 application documents migration is present');
    for (const file of migrations.slice(0, targetMigration)) await applyMigration(client, file);

    // Seed a pre-existing application with its approved, linked general resume.
    const workspaceId = randomUUID(); const jobId = randomUUID(); const snapshotId = randomUUID();
    const applicationId = randomUUID(); const legacyDocumentId = randomUUID();
    files = await mkdtemp(join(tmpdir(), 'career-application-documents-migration-'));
    const legacyBytes = Buffer.from('synthetic approved resume bytes');
    const legacyPath = join(files, 'legacy-resume.pdf');
    await writeFile(legacyPath, legacyBytes);
    const legacyDigest = createHash('sha256').update(legacyBytes).digest('hex');
    await client.query('INSERT INTO workspaces(id) VALUES ($1)', [workspaceId]);
    await client.query('INSERT INTO jobs(id,workspace_id,company,title) VALUES ($1,$2,$3,$4)', [jobId, workspaceId, 'Example Co', 'Designer']);
    await client.query('INSERT INTO job_snapshots(id,workspace_id,job_id,title,description_text,snapshot_hash) VALUES ($1,$2,$3,$4,$5,$6)', [snapshotId, workspaceId, jobId, 'Designer', 'Synthetic offer', 'a'.repeat(64)]);
    await client.query('INSERT INTO applications(id,workspace_id,job_id,company,role,location) VALUES ($1,$2,$3,$4,$5,$6)', [applicationId, workspaceId, jobId, 'Example Co', 'Designer', 'Madrid']);
    await client.query(`INSERT INTO document_versions(id,workspace_id,name,revision,media_type,storage_path,sha256,approval_status)
      VALUES ($1,$2,'Attached resume',1,'application/pdf',$3,$4,'USER_APPROVED')`, [legacyDocumentId, workspaceId, legacyPath, legacyDigest]);
    await client.query('UPDATE applications SET document_id=$2 WHERE id=$1', [applicationId, legacyDocumentId]);
    const applicationBefore = (await client.query('SELECT * FROM applications WHERE id=$1', [applicationId])).rows[0];
    const resumeBefore = (await client.query('SELECT * FROM document_versions WHERE id=$1', [legacyDocumentId])).rows[0];

    await applyMigration(client, migrations[targetMigration]);
    const applicationAfter = (await client.query('SELECT * FROM applications WHERE id=$1', [applicationId])).rows[0];
    const resumeAfter = (await client.query('SELECT * FROM document_versions WHERE id=$1', [legacyDocumentId])).rows[0];
    assert.deepEqual(applicationAfter, applicationBefore, 'application row and legacy link are unchanged');
    assert.deepEqual(resumeAfter, resumeBefore, 'legacy approval, digest, and storage path are unchanged');
    assert.deepEqual(await readFile(legacyPath), legacyBytes, 'legacy file bytes are unchanged');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM application_documents')).rows[0].n, 0, 'no legacy documents are converted');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM application_document_revisions')).rows[0].n, 0);

    let applicationCycle = 2;
    const makeApplication = async (workspace, job, company = 'Example Co') => {
      const id = randomUUID();
      await client.query('INSERT INTO applications(id,workspace_id,job_id,application_cycle,company,role,location) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, workspace, job, applicationCycle++, company, 'Designer', 'Madrid']);
      return id;
    };
    const makeDocument = async (workspace, application, kind = 'RESUME') => {
      const id = randomUUID();
      await client.query('INSERT INTO application_documents(id,workspace_id,application_id,kind,language) VALUES ($1,$2,$3,$4,$5)', [id, workspace, application, kind, 'es']);
      return id;
    };
    const insertRevision = async ({ workspace = workspaceId, document, snapshot = snapshotId, revision = 1, offerSnapshot = snapshot } = {}) => {
      return client.query(`INSERT INTO application_document_revisions
        (workspace_id,document_id,revision,claims,content_hash,offer_snapshot_id,offer_hash,facts_hash,paper_size,text_storage_path,text_sha256,pdf_storage_path,pdf_sha256)
        VALUES ($1,$2,$3,'[]',$4,$5,$6,$7,'A4','synthetic.txt',$8,'synthetic.pdf',$9)`,
      [workspace, document, revision, 'b'.repeat(64), offerSnapshot, 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64), 'f'.repeat(64)]);
    };

    // Restrictive one-way references; deleting dependents first leaves unrelated applications intact.
    const appA = await makeApplication(workspaceId, jobId);
    const appB = await makeApplication(workspaceId, jobId);
    const docA = await makeDocument(workspaceId, appA);
    const docB = await makeDocument(workspaceId, appB, 'COVER_LETTER');
    await insertRevision({ document: docA });
    await insertRevision({ document: docB });
    await assert.rejects(client.query('DELETE FROM applications WHERE id=$1', [appA]), foreignKey('application_documents_workspace_application_fk'));
    await assert.rejects(client.query('DELETE FROM application_documents WHERE id=$1', [docA]), foreignKey('application_document_revisions_workspace_document_fk'));
    await assert.rejects(client.query('DELETE FROM job_snapshots WHERE id=$1', [snapshotId]), foreignKey('application_document_revisions_workspace_offer_snapshot_fk'));
    await client.query('DELETE FROM application_document_revisions WHERE document_id=$1', [docA]);
    await client.query('DELETE FROM application_documents WHERE id=$1', [docA]);
    await client.query('DELETE FROM applications WHERE id=$1', [appA]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM application_documents WHERE id=$1', [docB])).rows[0].n, 1);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM application_document_revisions WHERE document_id=$1', [docB])).rows[0].n, 1);

    const foreignWorkspace = randomUUID(); const foreignJob = randomUUID();
    await client.query('INSERT INTO workspaces(id) VALUES ($1)', [foreignWorkspace]);
    await client.query('INSERT INTO jobs(id,workspace_id,company,title) VALUES ($1,$2,$3,$4)', [foreignJob, foreignWorkspace, 'Other Co', 'Designer']);
    const foreignApp = await makeApplication(foreignWorkspace, foreignJob, 'Other Co');
    const foreignDoc = await makeDocument(foreignWorkspace, foreignApp);
    await assert.rejects(insertRevision({ workspace: workspaceId, document: foreignDoc }), foreignKey('application_document_revisions_workspace_document_fk'), 'cross-workspace document reference is rejected');
    await assert.rejects(insertRevision({ document: docB, offerSnapshot: null }), (error) => error.code === '23502' && error.column === 'offer_snapshot_id', 'offer snapshot is mandatory');

    const relationRows = (await client.query(`SELECT conrelid::regclass::text AS from_table, confrelid::regclass::text AS to_table
      FROM pg_constraint WHERE contype='f' AND conrelid IN ('applications'::regclass,'application_document_revisions'::regclass)`)).rows;
    assert.equal(relationRows.some((row) => row.from_table === 'applications' && row.to_table === 'application_documents'), false, 'applications do not reference offer documents');
    assert.equal(relationRows.some((row) => row.from_table === 'application_document_revisions' && row.to_table === 'application_document_revisions'), false, 'revision parent is not a self foreign key');

    // G1: preserve all existing AI operations, allow DOCUMENT_REWORD and reject any unknown operation.
    const connectionId = randomUUID(); const consentId = randomUUID(); const fingerprint = '1'.repeat(64);
    await client.query('INSERT INTO ai_connections(id,workspace_id,provider,account_fingerprint) VALUES ($1,$2,$3,$4)', [connectionId, workspaceId, 'codex', fingerprint]);
    await client.query(`INSERT INTO ai_consents(id,workspace_id,connection_id,provider,account_fingerprint,connection_revision,revision,operation,data_categories,notice_version)
      VALUES ($1,$2,$3,'codex',$4,1,1,'DOCUMENT_REWORD','["APPROVED_FACTS","JOB_POSTING"]','documents-v1')`, [consentId, workspaceId, connectionId, fingerprint]);
    const makeRun = async (operation) => {
      const id = randomUUID();
      await client.query(`INSERT INTO ai_runs(id,workspace_id,connection_id,consent_id,provider,connection_revision,consent_revision,account_fingerprint,
        operation,origin,status,idempotency_key,content_identity,account_lock_key,snapshot,snapshot_hash,input_versions)
        VALUES ($1,$2,$3,$4,'codex',1,1,$5,$6,'MANUAL','SUCCEEDED',$7,'content','account',$8,$9,'{}')`,
      [id, workspaceId, connectionId, consentId, fingerprint, operation, `idempotency-${id}`, JSON.stringify({ payloadSha256: 'a'.repeat(64) }), 'a'.repeat(64)]);
      return id;
    };
    for (const operation of ['SEARCH_DRAFT', 'JOB_ANALYSIS', 'RESUME_DRAFT', 'ANSWER_DRAFT', 'DOCUMENT_REWORD']) await makeRun(operation);
    await assert.rejects(makeRun('NOT_AN_OPERATION'), (error) => error.code === '23514' && error.constraint === 'ai_runs_operation_check');
    const documentRunId = await makeRun('DOCUMENT_REWORD');
    await assert.rejects(client.query('UPDATE ai_runs SET snapshot=$2 WHERE id=$1', [documentRunId, JSON.stringify({ tampered: true })]), /AI run identity and input are immutable/);

    // G5: proposal history contains hashes and identifiers only, is unique per sentence, and follows run deletion.
    const proposalColumns = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='ai_document_reword_proposals' ORDER BY ordinal_position`)).rows.map((row) => row.column_name);
    assert.deepEqual(proposalColumns, ['workspace_id', 'run_id', 'sentence_id', 'proposal_sha256']);
    const proposal = (sentenceId, runId = documentRunId, workspace = workspaceId) => client.query(`INSERT INTO ai_document_reword_proposals(workspace_id,run_id,sentence_id,proposal_sha256) VALUES($1,$2,$3,$4)`, [workspace, runId, sentenceId, '9'.repeat(64)]);
    await proposal('sentence-1');
    await assert.rejects(proposal('sentence-1'), (error) => error.code === '23505');
    await assert.rejects(proposal('sentence-cross-workspace', documentRunId, foreignWorkspace), foreignKey('ai_document_reword_proposals_workspace_run_fk'));
    await assert.rejects(proposal('sentence-missing-run', randomUUID()), foreignKey('ai_document_reword_proposals_workspace_run_fk'));
    await client.query('DELETE FROM ai_runs WHERE id=$1', [documentRunId]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM ai_document_reword_proposals WHERE run_id=$1', [documentRunId])).rows[0].n, 0, 'run deletion cascades only hash rows');
  } finally {
    await client?.end().catch(() => {});
    if (files) await rm(files, { recursive: true, force: true });
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

test('0029 adds one workspace-scoped follow-up draft per existing application without altering application data', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname), 'migration fixture must use loopback');
  assert.equal(maintenance.pathname, '/postgres', 'migration fixture URL must connect only through maintenance database');
  const database = `career_followup_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: maintenance.toString() });
  let client;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    maintenance.pathname = `/${database}`;
    client = new Client({ connectionString: maintenance.toString() });
    await client.connect();

    const migrations = (await readdir(migrationDir)).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort();
    const targetMigration = migrations.indexOf('0029_application_follow_up_drafts.sql');
    assert.notEqual(targetMigration, -1, '0029 follow-up draft migration is present');
    for (const file of migrations.slice(0, targetMigration)) await applyMigration(client, file);

    const workspaceId = randomUUID(); const applicationId = randomUUID();
    await client.query('INSERT INTO workspaces(id) VALUES ($1)', [workspaceId]);
    await client.query('INSERT INTO applications(id,workspace_id,company,role) VALUES ($1,$2,$3,$4)', [applicationId, workspaceId, 'Fictional Co', 'Designer']);
    const applicationBefore = (await client.query('SELECT * FROM applications WHERE id=$1', [applicationId])).rows[0];

    await applyMigration(client, migrations[targetMigration]);
    assert.deepEqual((await client.query('SELECT * FROM applications WHERE id=$1', [applicationId])).rows[0], applicationBefore, 'existing application data is unchanged');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM application_follow_up_drafts')).rows[0].n, 0, 'existing applications do not receive invented drafts');
    const columns = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='application_follow_up_drafts' ORDER BY ordinal_position`)).rows.map((row) => row.column_name);
    assert.deepEqual(columns, ['id', 'workspace_id', 'application_id', 'language', 'subject', 'body', 'created_at', 'updated_at']);

    const draftId = randomUUID();
    const insertDraft = (id, appId = applicationId, workspace = workspaceId, language = 'en') => client.query(
      'INSERT INTO application_follow_up_drafts(id,workspace_id,application_id,language,subject,body) VALUES($1,$2,$3,$4,$5,$6)',
      [id, workspace, appId, language, 'Fictional follow-up', 'Synthetic editable draft.']);
    await insertDraft(draftId);
    await assert.rejects(insertDraft(randomUUID()), (error) => error.code === '23505', 'only one draft is allowed per application');
    await assert.rejects(insertDraft(randomUUID(), applicationId, randomUUID()), foreignKey('application_follow_up_drafts_workspace_application_fk'), 'cross-workspace application references are rejected');
    await assert.rejects(insertDraft(randomUUID(), applicationId, workspaceId, 'fr'), (error) => error.code === '23514' && error.constraint === 'application_follow_up_drafts_language_check', 'only supported languages are stored');
    await assert.rejects(client.query('DELETE FROM applications WHERE id=$1', [applicationId]), foreignKey('application_follow_up_drafts_workspace_application_fk'), 'the draft restricts parent deletion until explicit child removal');
    await client.query('UPDATE application_follow_up_drafts SET subject=$2, body=$3 WHERE id=$1', [draftId, 'Edited subject', 'Edited synthetic draft.']);
    assert.deepEqual((await client.query('SELECT subject,body FROM application_follow_up_drafts WHERE id=$1', [draftId])).rows[0], { subject: 'Edited subject', body: 'Edited synthetic draft.' });
    await client.query('DELETE FROM application_follow_up_drafts WHERE id=$1', [draftId]);
    await client.query('DELETE FROM applications WHERE id=$1', [applicationId]);
  } finally {
    await client?.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

test('0030 adds workspace-scoped interview preparation tables without inventing data for existing applications', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname), 'migration fixture must use loopback');
  assert.equal(maintenance.pathname, '/postgres', 'migration fixture URL must connect only through maintenance database');
  const database = `career_interviewprep_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: maintenance.toString() });
  let client;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    maintenance.pathname = `/${database}`;
    client = new Client({ connectionString: maintenance.toString() });
    await client.connect();

    const migrations = (await readdir(migrationDir)).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort();
    const targetMigration = migrations.indexOf('0030_interview_preparation.sql');
    assert.notEqual(targetMigration, -1, '0030 interview preparation migration is present');
    for (const file of migrations.slice(0, targetMigration)) await applyMigration(client, file);

    const workspaceId = randomUUID(); const applicationId = randomUUID();
    await client.query('INSERT INTO workspaces(id) VALUES ($1)', [workspaceId]);
    await client.query('INSERT INTO applications(id,workspace_id,company,role) VALUES ($1,$2,$3,$4)', [applicationId, workspaceId, 'Fictional Co', 'Designer']);
    const applicationBefore = (await client.query('SELECT * FROM applications WHERE id=$1', [applicationId])).rows[0];

    await applyMigration(client, migrations[targetMigration]);
    assert.deepEqual((await client.query('SELECT * FROM applications WHERE id=$1', [applicationId])).rows[0], applicationBefore, 'existing application data is unchanged');
    for (const table of ['plans', 'evidence', 'items', 'sessions', 'turns']) {
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM interview_preparation_${table}`)).rows[0].n, 0, `existing applications do not receive invented ${table}`);
    }

    const planId = randomUUID();
    const insertPlan = (id, appId = applicationId, workspace = workspaceId, language = 'en') => client.query(
      'INSERT INTO interview_preparation_plans(id,workspace_id,application_id,language) VALUES($1,$2,$3,$4)', [id, workspace, appId, language]);
    await insertPlan(planId);
    await insertPlan(randomUUID());
    await assert.rejects(insertPlan(randomUUID(), applicationId, randomUUID()), foreignKey('interview_preparation_plans_workspace_application_fk'), 'cross-workspace application references are rejected');
    await assert.rejects(insertPlan(randomUUID(), applicationId, workspaceId, 'fr'), (error) => error.code === '23514' && error.constraint === 'interview_preparation_plans_language_check', 'only supported languages are stored');
    await assert.rejects(client.query('DELETE FROM applications WHERE id=$1', [applicationId]), foreignKey('interview_preparation_plans_workspace_application_fk'), 'plans restrict parent deletion until explicit removal');

    await assert.rejects(client.query("INSERT INTO interview_preparation_evidence(workspace_id,plan_id,kind,source_id,content_sha256) VALUES($1,$2,'APPROVED_FACT',$3,'not-a-hash')", [workspaceId, planId, randomUUID()]), (error) => error.code === '23514', 'evidence keeps only a hash');
    await assert.rejects(client.query("INSERT INTO interview_preparation_evidence(workspace_id,plan_id,kind,source_id,content_sha256) VALUES($1,$2,'APPROVED_FACT',$3,$4)", [workspaceId, randomUUID(), randomUUID(), 'a'.repeat(64)]), foreignKey('interview_preparation_evidence_workspace_plan_fk'), 'evidence needs a plan in the same workspace');
    await client.query("INSERT INTO interview_preparation_items(workspace_id,plan_id,kind,origin,position,content) VALUES($1,$2,'NOTE','USER_NOTE',0,'My own note')", [workspaceId, planId]);
    await assert.rejects(client.query("INSERT INTO interview_preparation_items(workspace_id,plan_id,kind,origin,position,content) VALUES($1,$2,'NOTE','USER_NOTE',0,'Duplicate position')", [workspaceId, planId]), (error) => error.code === '23505', 'positions are unique within a plan');
    await assert.rejects(client.query("INSERT INTO interview_preparation_sessions(workspace_id,plan_id,status) VALUES($1,$2,'COMPLETED')", [workspaceId, planId]), (error) => error.code === '23514', 'a completed session needs an end time');
    const session = (await client.query("INSERT INTO interview_preparation_sessions(workspace_id,plan_id) VALUES($1,$2) RETURNING id", [workspaceId, planId])).rows[0].id;
    await client.query("INSERT INTO interview_preparation_turns(workspace_id,session_id,position,question) VALUES($1,$2,0,'Fictional question')", [workspaceId, session]);

    await client.query('DELETE FROM interview_preparation_plans WHERE id=$1', [planId]);
    for (const table of ['evidence', 'items', 'sessions', 'turns']) {
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM interview_preparation_${table}`)).rows[0].n, 0, `deleting a plan removes its ${table}`);
    }
    await client.query('DELETE FROM interview_preparation_plans');
    await client.query('DELETE FROM applications WHERE id=$1', [applicationId]);
  } finally {
    await client?.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

test('0031 stores whether approved facts back a requirement, only on requirements, and keeps existing items', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname), 'migration fixture must use loopback');
  assert.equal(maintenance.pathname, '/postgres', 'migration fixture URL must connect only through maintenance database');
  const database = `career_interviewsupport_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: maintenance.toString() });
  let client;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    maintenance.pathname = `/${database}`;
    client = new Client({ connectionString: maintenance.toString() });
    await client.connect();

    const migrations = (await readdir(migrationDir)).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort();
    const targetMigration = migrations.indexOf('0031_interview_preparation_item_support.sql');
    assert.notEqual(targetMigration, -1, '0031 interview preparation support migration is present');
    for (const file of migrations.slice(0, targetMigration)) await applyMigration(client, file);

    const workspaceId = randomUUID(); const applicationId = randomUUID(); const planId = randomUUID();
    await client.query('INSERT INTO workspaces(id) VALUES ($1)', [workspaceId]);
    await client.query('INSERT INTO applications(id,workspace_id,company,role) VALUES ($1,$2,$3,$4)', [applicationId, workspaceId, 'Fictional Co', 'Designer']);
    await client.query("INSERT INTO interview_preparation_plans(id,workspace_id,application_id,language) VALUES($1,$2,$3,'en')", [planId, workspaceId, applicationId]);
    await client.query("INSERT INTO interview_preparation_items(workspace_id,plan_id,kind,origin,position,content) VALUES($1,$2,'NOTE','USER_NOTE',0,'Existing note')", [workspaceId, planId]);

    await applyMigration(client, migrations[targetMigration]);
    assert.deepEqual((await client.query('SELECT content, support, fact_ids FROM interview_preparation_items')).rows, [{ content: 'Existing note', support: null, fact_ids: [] }], 'existing items keep their data and gain empty support');
    const insert = (kind, support, position) => client.query('INSERT INTO interview_preparation_items(workspace_id,plan_id,kind,origin,position,content,support,fact_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [workspaceId, planId, kind, 'JOB_SNAPSHOT', position, 'typescript', support, JSON.stringify([randomUUID()])]);
    await insert('REQUIREMENT', 'SUPPORTED', 1);
    await insert('REQUIREMENT', 'UNKNOWN', 2);
    await assert.rejects(insert('REQUIREMENT', 'GUESSED', 3), (error) => error.code === '23514' && error.constraint === 'interview_preparation_items_support_check', 'only known support values are stored');
    await assert.rejects(insert('STUDY', 'SUPPORTED', 4), (error) => error.code === '23514' && error.constraint === 'interview_preparation_items_support_check', 'only requirements carry support');
  } finally {
    await client?.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

test('0032 allows interview preparation assistant runs and stores hints on items without touching existing items', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname), 'migration fixture must use loopback');
  assert.equal(maintenance.pathname, '/postgres', 'migration fixture URL must connect only through maintenance database');
  const database = `career_interviewai_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: maintenance.toString() });
  let client;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    maintenance.pathname = `/${database}`;
    client = new Client({ connectionString: maintenance.toString() });
    await client.connect();

    const migrations = (await readdir(migrationDir)).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort();
    const targetMigration = migrations.indexOf('0032_interview_preparation_assistant.sql');
    assert.notEqual(targetMigration, -1, '0032 interview preparation assistant migration is present');
    for (const file of migrations.slice(0, targetMigration)) await applyMigration(client, file);

    const workspaceId = randomUUID(); const applicationId = randomUUID(); const planId = randomUUID(); const connectionId = randomUUID();
    await client.query('INSERT INTO workspaces(id) VALUES ($1)', [workspaceId]);
    await client.query('INSERT INTO applications(id,workspace_id,company,role) VALUES ($1,$2,$3,$4)', [applicationId, workspaceId, 'Fictional Co', 'Designer']);
    await client.query("INSERT INTO interview_preparation_plans(id,workspace_id,application_id,language) VALUES($1,$2,$3,'en')", [planId, workspaceId, applicationId]);
    await client.query("INSERT INTO interview_preparation_items(workspace_id,plan_id,kind,origin,position,content) VALUES($1,$2,'NOTE','USER_NOTE',0,'Existing note')", [workspaceId, planId]);
    await client.query("INSERT INTO ai_connections(id,workspace_id,provider,account_fingerprint,revision,state,active) VALUES($1,$2,'codex',$3,1,'CONNECTED',true)", [connectionId, workspaceId, 'a'.repeat(64)]);
    const consent = (await client.query("INSERT INTO ai_consents(workspace_id,connection_id,provider,account_fingerprint,connection_revision,revision,operation,data_categories,notice_version,remembered) VALUES($1,$2,'codex',$3,1,1,'JOB_ANALYSIS','[\"JOB_POSTING\"]','v',false) RETURNING id", [workspaceId, connectionId, 'a'.repeat(64)])).rows[0].id;
    const insertRun = (operation) => client.query(
      `INSERT INTO ai_runs(workspace_id,connection_id,consent_id,provider,connection_revision,consent_revision,account_fingerprint,operation,origin,status,idempotency_key,content_identity,account_lock_key,snapshot,snapshot_hash,input_versions,reserved_day)
       VALUES($1,$2,$3,'codex',1,1,$4,$5,'MANUAL','SUCCEEDED',$6,$7,$4,'{}',$7,'{}',current_date)`, [workspaceId, connectionId, consent, 'a'.repeat(64), operation, randomUUID(), 'b'.repeat(64)]);
    await assert.rejects(insertRun('INTERVIEW_PREP'), (error) => error.code === '23514' && error.constraint === 'ai_runs_operation_check', 'the operation is new in 0032');

    await applyMigration(client, migrations[targetMigration]);
    await insertRun('INTERVIEW_PREP');
    await assert.rejects(insertRun('LIVE_INTERVIEW_HELP'), (error) => error.code === '23514' && error.constraint === 'ai_runs_operation_check', 'other operations are still refused');
    assert.deepEqual((await client.query('SELECT content, hints FROM interview_preparation_items')).rows, [{ content: 'Existing note', hints: [] }], 'existing items keep their data and gain empty hints');
    await client.query("INSERT INTO interview_preparation_items(workspace_id,plan_id,kind,origin,position,content,hints) VALUES($1,$2,'EXERCISE','ASSISTANT',1,'A coding problem','[\"A nudge\",\"A bigger hint\"]')", [workspaceId, planId]);
    assert.deepEqual((await client.query("SELECT hints FROM interview_preparation_items WHERE origin='ASSISTANT'")).rows[0].hints, ['A nudge', 'A bigger hint']);
  } finally {
    await client?.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});

test('0033 marks mock session turns as questions or follow-ups and keeps existing turns', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname), 'migration fixture must use loopback');
  assert.equal(maintenance.pathname, '/postgres', 'migration fixture URL must connect only through maintenance database');
  const database = `career_mockturns_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: maintenance.toString() });
  let client;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    maintenance.pathname = `/${database}`;
    client = new Client({ connectionString: maintenance.toString() });
    await client.connect();

    const migrations = (await readdir(migrationDir)).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort();
    const targetMigration = migrations.indexOf('0033_interview_preparation_mock_turns.sql');
    assert.notEqual(targetMigration, -1, '0033 mock session turns migration is present');
    for (const file of migrations.slice(0, targetMigration)) await applyMigration(client, file);

    const workspaceId = randomUUID(); const applicationId = randomUUID(); const planId = randomUUID(); const sessionId = randomUUID();
    await client.query('INSERT INTO workspaces(id) VALUES ($1)', [workspaceId]);
    await client.query('INSERT INTO applications(id,workspace_id,company,role) VALUES ($1,$2,$3,$4)', [applicationId, workspaceId, 'Fictional Co', 'Designer']);
    await client.query("INSERT INTO interview_preparation_plans(id,workspace_id,application_id,language) VALUES($1,$2,$3,'en')", [planId, workspaceId, applicationId]);
    await client.query('INSERT INTO interview_preparation_sessions(id,workspace_id,plan_id) VALUES($1,$2,$3)', [sessionId, workspaceId, planId]);
    await client.query("INSERT INTO interview_preparation_turns(workspace_id,session_id,position,question,answer) VALUES($1,$2,0,'Existing question','Existing answer')", [workspaceId, sessionId]);

    await applyMigration(client, migrations[targetMigration]);
    assert.deepEqual((await client.query('SELECT question, answer, kind, item_id FROM interview_preparation_turns')).rows, [{ question: 'Existing question', answer: 'Existing answer', kind: 'QUESTION', item_id: null }], 'existing turns keep their data and read as questions');
    const itemId = randomUUID();
    await client.query("INSERT INTO interview_preparation_turns(workspace_id,session_id,position,kind,item_id,question) VALUES($1,$2,1,'PROBE',$3,'A follow-up')", [workspaceId, sessionId, itemId]);
    await assert.rejects(client.query("INSERT INTO interview_preparation_turns(workspace_id,session_id,position,kind,question) VALUES($1,$2,2,'HINT','x')", [workspaceId, sessionId]), (error) => error.code === '23514' && error.constraint === 'interview_preparation_turns_kind_check', 'only questions and follow-ups exist');
  } finally {
    await client?.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
