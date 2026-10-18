// "Delete all my data" (ADR 020, point 2). Fictional data only. The database part creates and drops its own
// disposable database: CAREER_DELETION_TEST_ADMIN_URL=postgresql://$USER@127.0.0.1:5432/postgres pnpm run test:deletion
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CLEARED_CACHES, DELETION_ORDER, KEPT_TABLES, deleteWorkspaceFiles, deleteWorkspaceRows, filesPathProblem } from '../src/workspace-deletion.js';

test('workspace deletion includes application contacts before removing their parent records', () => {
  assert.ok(DELETION_ORDER.includes('application_contacts'));
  assert.ok(DELETION_ORDER.includes('workspace_contacts'));
  assert.ok(DELETION_ORDER.indexOf('application_contacts') < DELETION_ORDER.indexOf('applications'));
  assert.ok(DELETION_ORDER.indexOf('workspace_contacts') < DELETION_ORDER.indexOf('applications'));
});

const root = new URL('../../../', import.meta.url);
const { Client, Pool } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_DELETION_TEST_ADMIN_URL;

test('the documents folder may not be or overlap the data folder\'s control files', () => {
  assert.equal(filesPathProblem('/srv/career/data/files', '/srv/career/data'), null, 'The default layout');
  assert.equal(filesPathProblem('/srv/documents', '/srv/career/data'), null, 'A separate folder');
  assert.match(filesPathProblem('/srv/career/data', '/srv/career/data') ?? '', /different folder/);
  for (const entry of ['run', 'backups', 'logs', 'tmp', 'setup-token']) assert.match(filesPathProblem(`/srv/career/data/${entry}`, '/srv/career/data') ?? '', /must not contain or be inside/, entry);
  assert.match(filesPathProblem('/srv/career/data/run/files', '/srv/career/data') ?? '', /must not contain or be inside/);
  assert.match(filesPathProblem('/srv/career', '/srv/career/data') ?? '', /must not contain/, 'A documents folder that contains the data folder');
});

test('deleting files empties documents, backups, logs and assistant prompts, keeps run/, and writes a new token', async () => {
  const base = await mkdtemp(join(tmpdir(), 'career-deletion-files-'));
  const outside = await mkdtemp(join(tmpdir(), 'career-deletion-outside-'));
  try {
    const data = join(base, 'data'); const files = join(data, 'files');
    for (const folder of [join(files, 'ws'), join(data, 'backups', 'b1', 'keys'), join(data, 'logs'), join(data, 'tmp', 'codex-task-1'), join(data, 'run')]) await mkdir(folder, { recursive: true });
    await writeFile(join(files, 'ws', 'resume.pdf'), '%PDF fictional');
    await writeFile(join(data, 'backups', 'b1', 'career-backup.tar.age'), 'fictional');
    await writeFile(join(data, 'logs', 'api.log'), 'fictional');
    await writeFile(join(data, 'tmp', 'codex-task-1', 'instructions.txt'), 'fictional prompt');
    await writeFile(join(data, 'run', 'api.json'), '{"name":"api"}');
    await writeFile(join(data, 'setup-token'), 'old-token');
    await writeFile(join(outside, 'keep.txt'), 'outside');
    if (process.platform !== 'win32') await symlink(outside, join(files, 'link'));
    const tokenPath = await deleteWorkspaceFiles({ filesRoot: files, dataRoot: data });
    for (const folder of [files, join(data, 'backups'), join(data, 'logs'), join(data, 'tmp')]) assert.deepEqual(await readdir(folder), [], folder);
    assert.deepEqual(await readdir(join(data, 'run')), ['api.json'], 'The launcher records stay');
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'outside', 'A link inside is removed, never followed');
    const token = await readFile(tokenPath, 'utf8');
    assert.notEqual(token, 'old-token');
    assert.ok(token.length >= 32);
    if (process.platform !== 'win32') assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
    await assert.rejects(deleteWorkspaceFiles({ filesRoot: data, dataRoot: data }), /different folder/);
  } finally { await rm(base, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('a session from an earlier generation stops working; cookies from before generations count as 0', async () => {
  process.env.DATABASE_URL ??= 'postgresql://fictional@127.0.0.1:1/fictional';
  process.env.APP_ENCRYPTION_KEY ??= 'fictional-encryption-key-0123456789abcdef';
  process.env.APP_SESSION_SECRET ??= 'fictional-session-secret-0123456789abcdef';
  const { issueSession, setSessionGeneration, workspaceFromRequest } = await import('../src/session.js');
  const { config } = await import('../src/config.js');
  const request = (cookie: string) => ({ headers: { cookie: `career_session=${cookie}` } }) as Parameters<typeof workspaceFromRequest>[0];
  const workspaceId = randomUUID();
  setSessionGeneration(0);
  const legacyPayload = Buffer.from(JSON.stringify({ workspaceId, exp: Date.now() + 60_000 })).toString('base64url');
  const legacy = `${legacyPayload}.${createHmac('sha256', config.APP_SESSION_SECRET).update(legacyPayload).digest('base64url')}`;
  const before = issueSession(workspaceId);
  assert.equal(workspaceFromRequest(request(before)), workspaceId);
  assert.equal(workspaceFromRequest(request(legacy)), workspaceId, 'Upgrading signs nobody out');
  setSessionGeneration(1);
  assert.equal(workspaceFromRequest(request(before)), null, 'Every older session stops working');
  assert.equal(workspaceFromRequest(request(legacy)), null);
  assert.equal(workspaceFromRequest(request(issueSession(workspaceId))), workspaceId, 'A new sign-in works');
});

test('deleting all data leaves nothing of one workspace and touches nothing of another', { skip: !adminUrl && 'set CAREER_DELETION_TEST_ADMIN_URL to run' }, async () => {
  const maintenance = new URL(adminUrl!);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname), 'fixture must use loopback');
  const name = `career_del_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: maintenance.toString() });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const target = new URL(maintenance); target.pathname = `/${name}`;
  const client = new Client({ connectionString: target.toString() });
  const pool = new Pool({ connectionString: target.toString(), max: 3 });
  let dataRoot: string | undefined;
  try {
    await client.connect();
    for (const file of (await readdir(new URL('packages/db/migrations', root))).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort()) {
      for (const statement of (await readFile(new URL(`packages/db/migrations/${file}`, root), 'utf8')).split('--> statement-breakpoint').filter((part) => part.trim())) await client.query(statement);
    }
    const q = (sql: string, values: unknown[] = []) => client.query(sql, values);

    // Every table is covered: deleted in order, cleared as a cache, or kept for a stated reason.
    const tables: string[] = (await q(`select relname from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace order by 1`)).rows.map((row: { relname: string }) => row.relname);
    assert.deepEqual([...DELETION_ORDER, ...CLEARED_CACHES, ...Object.keys(KEPT_TABLES)].sort(), tables, 'A table missing from the deletion order, the caches or the kept tables');
    // A foreign key that does not cascade needs its child deleted before its parent.
    const keys = (await q(`select conrelid::regclass::text as child, confrelid::regclass::text as parent, confdeltype from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace`)).rows as Array<{ child: string; parent: string; confdeltype: string }>;
    const position = (table: string) => (DELETION_ORDER as readonly string[]).indexOf(table);
    for (const key of keys) {
      if (key.confdeltype === 'c' || key.child === key.parent || position(key.parent) === -1) continue;
      assert.ok(position(key.child) < position(key.parent), `${key.child} must be deleted before ${key.parent}`);
    }

    // Two workspaces with the same fictional data in the tables whose foreign keys do not cascade, and more.
    const fill = async (ws: string) => {
      const id = () => randomUUID(); const fp = 'a'.repeat(64);
      await q(`insert into workspaces (id, name, timezone, discovery_enabled) values ($1, 'Fictional workspace', 'America/Mexico_City', true)`, [ws]);
      const [pv1, pv2, job, snapshot, doc, app, board, search, run, connection, consent, policy, aiRun, retry] = Array.from({ length: 14 }, id);
      await q(`insert into profile_versions (id, workspace_id, revision, profile) values ($1, $3, 1, '{}'), ($2, $3, 2, '{"identity":{"fullName":"Ana Fictional"}}')`, [pv1, pv2, ws]);
      await q(`insert into profile_facts (workspace_id, profile_version_id, kind, statement) values ($1, $2, 'skill', 'Fictional skill')`, [ws, pv2]);
      await q(`insert into answer_versions (workspace_id, semantic_key, jurisdiction, question_scope, strategy, revision) values ($1, 'salary', 'ES', 'fictional', 'MANUAL', 1)`, [ws]);
      await q(`insert into jobs (id, workspace_id, company, title) values ($1, $2, 'Fictional Co', 'Designer')`, [job, ws]);
      await q(`insert into job_snapshots (id, workspace_id, job_id, title, snapshot_hash) values ($1, $2, $3, 'Designer', $4)`, [snapshot, ws, job, 'b'.repeat(64)]);
      await q(`insert into job_occurrences (workspace_id, job_id, provider, region, tenant, external_job_id, job_url, source_payload) values ($1, $2, 'greenhouse', 'us', 'fictional', 'e1', 'https://example.test/j', '{}')`, [ws, job]);
      await q(`insert into job_search_sources (workspace_id, job_id, provider, external_id, source_url) values ($1, $2, 'remotive', 'e1', 'https://example.test/j')`, [ws, job]);
      await q(`insert into job_identity_members (workspace_id, job_id, identity_key, evidence) values ($1, $2, $3, '{}')`, [ws, job, `identity-${ws}`]);
      await q(`insert into job_availability_events (workspace_id, job_id, from_state, to_state, reason) values ($1, $2, 'OPEN', 'POSSIBLY_CLOSED', 'ABSENT_FROM_SOURCES')`, [ws, job]);
      await q(`insert into document_versions (id, workspace_id, name, revision, media_type, storage_path, sha256, profile_revision_id, job_snapshot_id) values ($1, $2, 'Resume', 1, 'application/pdf', $3, $4, $5, $6)`, [doc, ws, `${ws}/resume.pdf`, 'c'.repeat(64), pv2, snapshot]);
      await q(`insert into applications (id, workspace_id, company, role, job_id, document_id) values ($1, $2, 'Fictional Co', 'Designer', $3, $4)`, [app, ws, job, doc]);
      await q(`insert into application_events (workspace_id, application_id, event_type, aggregate_version) values ($1, $2, 'CREATED', 1)`, [ws, app]);
      await q(`insert into assisted_attempts (workspace_id, application_id, plan, digest, expires_at) values ($1, $2, '{}', $3, now())`, [ws, app, 'd'.repeat(64)]);
      await q(`insert into boards (id, workspace_id, provider, tenant, region, company_name, company_domain, careers_url) values ($1, $2, 'greenhouse', 'fictional', 'us', 'Fictional Co', 'example.test', 'https://example.test/careers')`, [board, ws]);
      await q(`insert into source_policy_reviews (workspace_id, board_id, capability, access_class, permission_status, api_host, adapter_version, reviewed_at) values ($1, $2, 'PUBLIC_JOB_READ', 'DOCUMENTED_PUBLIC_READ', 'APPROVED_FOR_SCOPE', 'boards-api.greenhouse.io', '0.2.0', now())`, [ws, board]);
      await q(`insert into search_profiles (workspace_id, name) values ($1, 'Fictional profile')`, [ws]);
      await q(`insert into saved_job_searches (id, workspace_id, role) values ($1, $2, 'Designer')`, [search, ws]);
      await q(`insert into search_runs (id, workspace_id, search_id, revision, criteria) values ($1, $2, $3, 1, '{}')`, [run, ws, search]);
      await q(`insert into search_run_sources (workspace_id, run_id, provider) values ($1, $2, 'remotive')`, [ws, run]);
      await q(`insert into search_run_results (workspace_id, run_id, search_id, job_id, score, location_status) values ($1, $2, $3, $4, 1, 'MATCH')`, [ws, run, search, job]);
      await q(`insert into saved_job_search_matches (workspace_id, search_id, job_id) values ($1, $2, $3)`, [ws, search, job]);
      await q(`insert into search_job_reviews (workspace_id, search_id, job_id) values ($1, $2, $3)`, [ws, search, job]);
      await q(`insert into search_preparation_budget (workspace_id, day) values ($1, current_date)`, [ws]);
      await q(`insert into ai_connections (id, workspace_id, provider, account_fingerprint, state) values ($1, $2, 'codex', $3, 'CONNECTED')`, [connection, ws, fp]);
      await q(`insert into ai_consents (id, workspace_id, connection_id, provider, account_fingerprint, connection_revision, revision, operation, data_categories, notice_version) values ($1, $2, $3, 'codex', $4, 1, 1, 'SEARCH_DRAFT', '["SEARCH_REQUEST"]', 'fixture')`, [consent, ws, connection, fp]);
      await q(`insert into ai_automation_policies (id, workspace_id, connection_id, consent_id, search_ids) values ($1, $2, $3, $4, '[]')`, [policy, ws, connection, consent]);
      for (const [runId, retryOf] of [[aiRun, null], [retry, aiRun]]) {
        await q(`insert into ai_runs (id, workspace_id, connection_id, consent_id, provider, connection_revision, consent_revision, account_fingerprint, operation, origin, status, idempotency_key, content_identity, account_lock_key, snapshot, snapshot_hash, input_versions, retry_of, search_id, automation_policy_id)
          values ($1, $2, $3, $4, 'codex', 1, 1, $5, 'SEARCH_DRAFT', 'AUTOMATIC', 'SUCCEEDED', $9, $5, $5, '{}', $5, '{}', $6, $7, $8)`, [runId, ws, connection, consent, fp, retryOf, search, policy, `key-${runId}`]);
      }
      await q(`insert into ai_document_reword_proposals (workspace_id, run_id, sentence_id, proposal_sha256) values ($1, $2, 'sentence-1', $3)`, [ws, aiRun, 'f'.repeat(64)]);
      const applicationDocument = id(); const revision = id();
      await q(`insert into application_documents (id, workspace_id, application_id, kind, language) values ($1, $2, $3, 'RESUME', 'en')`, [applicationDocument, ws, app]);
      await q(`insert into application_document_revisions (id, workspace_id, document_id, revision, claims, content_hash, offer_snapshot_id, offer_hash, facts_hash, paper_size, text_storage_path, text_sha256, pdf_storage_path, pdf_sha256)
        values ($1, $2, $3, 1, '[]', $4, $5, $6, $7, 'A4', $8, $9, $10, $11)`,
      [revision, ws, applicationDocument, '1'.repeat(64), snapshot, '2'.repeat(64), '3'.repeat(64), `${ws}/application-resume.txt`, '4'.repeat(64), `${ws}/application-resume.pdf`, '5'.repeat(64)]);
      await q(`insert into llm_usage (workspace_id, ai_run_id, provider, operation, status, availability) values ($1, $2, 'codex', 'fixture', 'SUCCEEDED', 'UNAVAILABLE')`, [ws, aiRun]);
      await q(`insert into ai_artifacts (workspace_id, run_id, schema_version, prompt_version, locale, output, sources, state) values ($1, $2, 1, 'fixture', 'en', '{}', '{}', 'PENDING_REVIEW')`, [ws, aiRun]);
      await q(`insert into ai_run_tombstones (workspace_id, run_id, consent_id, idempotency_hash) values ($1, $2, $3, $4)`, [ws, id(), consent, 'e'.repeat(64)]);
      await q(`insert into ai_daily_budgets (workspace_id, control_day) values ($1, current_date)`, [ws]);
      await q(`insert into ai_usage_snapshots (workspace_id, connection_id, availability, source, observed_at) values ($1, $2, 'UNAVAILABLE', 'fixture', now())`, [ws, connection]);
      await q(`insert into ai_account_leases (account_lock_key, run_id, workspace_id, lease_until) values ($1, $2, $3, now())`, [`lease-${ws}`.slice(0, 64), aiRun, ws]);
      await q(`insert into deletion_jobs (workspace_id, status) values ($1, 'COMPLETED')`, [ws]);
    };
    const [deleted, other] = [randomUUID(), randomUUID()];
    await fill(deleted); await fill(other);
    dataRoot = await mkdtemp(join(tmpdir(), 'career-deletion-retry-'));
    const filesRoot = join(dataRoot, 'files');
    await mkdir(join(filesRoot, deleted), { recursive: true });
    await mkdir(join(dataRoot, 'run'), { recursive: true });
    await writeFile(join(filesRoot, deleted, 'resume.pdf'), 'legacy linked resume');
    await writeFile(join(filesRoot, deleted, 'application-resume.txt'), 'synthetic approved draft text');
    await writeFile(join(filesRoot, deleted, 'application-resume.pdf'), 'synthetic application PDF');
    await writeFile(join(dataRoot, 'run', 'launcher-record.json'), '{"pid":123}');
    await q(`insert into search_query_cache (provider, query_hash) values ('remotive', $1)`, ['f'.repeat(64)]);
    await q(`insert into job_search_provider_cache (provider) values ('remotive')`);
    await q(`insert into search_provider_budget (provider, day) values ('remotive', current_date)`);
    const scoped = tables.filter((table) => !(CLEARED_CACHES as readonly string[]).includes(table) && table !== 'workspaces' && table !== 'search_provider_budget');
    const counts = async (ws: string) => Object.fromEntries(await Promise.all(scoped.map(async (table) => [table, Number((await q(`select count(*) from "${table}" where workspace_id = $1`, [ws])).rows[0].count)])));
    const otherBefore = await counts(other);
    const filled = Object.entries(await counts(deleted)).filter(([, count]) => count > 0).map(([table]) => table);
    assert.ok(filled.length >= 30, `The fixture fills most tables (${filled.length})`);

    const startedAt = Date.now();
    const result = await deleteWorkspaceRows(pool, deleted);
    assert.equal(result.generation, 1);
    assert.equal(await readFile(join(filesRoot, deleted, 'application-resume.pdf'), 'utf8'), 'synthetic application PDF', 'A crash after row commit leaves files for retry');

    const after = await counts(deleted);
    for (const table of scoped) {
      const expected = table === 'deletion_jobs' || table === 'profile_versions' ? 1 : 0;
      assert.equal(after[table], expected, `${table} still holds rows of the deleted workspace`);
    }
    const { rows: [job] } = await q('select * from deletion_jobs where workspace_id = $1', [deleted]);
    assert.deepEqual(Object.keys(job).sort(), ['completed_at', 'created_at', 'id', 'status', 'workspace_id'], 'The job holds no personal data');
    assert.equal(job.id, result.jobId);
    assert.equal(job.status, 'FILES_PENDING');
    const { pendingDeletionJobs, retryPendingDeletionFiles } = await import('../src/workspace-deletion.js');
    assert.deepEqual(await pendingDeletionJobs(pool, deleted), [result.jobId], 'A job whose files are pending is found on the next start');
    assert.deepEqual(await retryPendingDeletionFiles(pool, deleted, { filesRoot, dataRoot }), [{ jobId: result.jobId, completed: true }], 'Startup retry completes a deletion interrupted after its row commit');
    assert.deepEqual(await pendingDeletionJobs(pool, deleted), []);
    assert.deepEqual(await readdir(filesRoot), [], 'The retry removes every legacy, text and PDF file');
    assert.equal(await readFile(join(dataRoot, 'run', 'launcher-record.json'), 'utf8'), '{"pid":123}', 'Launcher control records survive');
    const { rows: [profile] } = await q('select revision, profile, locale from profile_versions where workspace_id = $1', [deleted]);
    assert.deepEqual(profile, { revision: 1, profile: {}, locale: 'en-GB' }, 'Only the empty profile every new installation starts with');
    // The workspace row: every column back to its default, except its id and the higher session generation.
    const { rows: [workspace] } = await q('select * from workspaces where id = $1', [deleted]);
    const defaults = (await q(`select column_name, column_default from information_schema.columns where table_name = 'workspaces' and column_name not in ('id', 'session_generation')`)).rows as Array<{ column_name: string; column_default: string | null }>;
    for (const { column_name: column, column_default: expression } of defaults) {
      const value = workspace[column];
      if (value instanceof Date) assert.ok(value.getTime() >= startedAt - 1000, `${column} was reset to now()`);
      else assert.deepEqual(value, (await q(`select ${expression} as value`)).rows[0].value, `${column} is back to its default`);
    }
    assert.equal(workspace.session_generation, 1);
    for (const cache of CLEARED_CACHES) assert.equal(Number((await q(`select count(*) from "${cache}"`)).rows[0].count), 0, cache);
    assert.equal(Number((await q('select count(*) from search_provider_budget')).rows[0].count), 1, 'Provider limits are kept');
    assert.equal(Number((await q('select count(*) from application_documents where workspace_id = $1', [deleted])).rows[0].count), 0);
    assert.equal(Number((await q('select count(*) from application_document_revisions where workspace_id = $1', [deleted])).rows[0].count), 0);
    assert.equal(Number((await q('select count(*) from ai_document_reword_proposals where workspace_id = $1', [deleted])).rows[0].count), 0);

    assert.deepEqual(await counts(other), otherBefore, 'The other workspace is untouched');
    assert.equal((await q('select name, discovery_enabled, session_generation from workspaces where id = $1', [other])).rows[0].session_generation, 0);

    const again = await deleteWorkspaceRows(pool, deleted);
    assert.equal(again.generation, 2, 'Deleting again works and raises the generation again');
    assert.equal(Number((await q('select count(*) from deletion_jobs where workspace_id = $1', [deleted])).rows[0].count), 1, 'Older deletion jobs are not kept');
  } finally {
    if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
    await pool.end().catch(() => undefined);
    await client.end().catch(() => undefined);
    await admin.query(`drop database if exists "${name}" with (force)`).catch(() => undefined);
    await admin.end();
  }
});

test('a symbolic link in place of the documents folder is refused, never emptied', { skip: process.platform === 'win32' && 'creating symbolic links needs extra rights on Windows' }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'career-deletion-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'career-deletion-outside-'));
  try {
    await mkdir(join(base, 'data'), { recursive: true });
    await writeFile(join(outside, 'keep.txt'), 'outside');
    await symlink(outside, join(base, 'data', 'files'));
    await assert.rejects(deleteWorkspaceFiles({ filesRoot: join(base, 'data', 'files'), dataRoot: join(base, 'data') }), /symbolic link/);
    assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'outside');
    assert.ok((await lstat(join(base, 'data', 'files'))).isSymbolicLink());
  } finally { await rm(base, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
