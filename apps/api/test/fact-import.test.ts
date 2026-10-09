import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, after, describe, test } from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { trackPgPoolCleanup } from './helpers/pg-pool-cleanup.js';

// Resume import (ADR 018, task T1) against a disposable database. Fictional data only.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const requireDb = createRequire(join(root, 'packages/db/package.json'));
const adminUrl = process.env.CAREER_FACT_IMPORT_TEST_ADMIN_URL;

describe('resume import with a disposable database', { skip: !adminUrl && 'set CAREER_FACT_IMPORT_TEST_ADMIN_URL', concurrency: false }, () => {
  type Client = { connect(): Promise<void>; end(): Promise<void>; query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };
  const { Client: PgClient } = requireDb('pg') as { Client: new (options: { connectionString: string }) => Client };
  const name = `career_import_${randomBytes(6).toString('hex')}`;
  let admin: Client; let sql: Client; let directory: string; let app: FastifyInstance;
  let closePool: (() => Promise<void>) | undefined;
  let workspace = ''; let rescores = 0; const envBefore = { ...process.env };

  before(async () => {
    const url = new URL(adminUrl!);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.ok(['postgres', 'template1'].includes(url.pathname.slice(1)), 'use maintenance DB only');
    admin = new PgClient({ connectionString: url.toString() }); await admin.connect();
    await admin.query(`create database "${name}"`);
    url.pathname = `/${name}`; directory = await mkdtemp(join(tmpdir(), 'career-import-'));
    process.env.DATABASE_URL = url.toString(); process.env.APP_ENCRYPTION_KEY = randomBytes(32).toString('hex'); process.env.APP_SESSION_SECRET = randomBytes(32).toString('hex');
    process.env.DATA_LOCAL_PATH = directory; process.env.FILES_LOCAL_PATH = directory; process.env.NODE_ENV = 'test';
    sql = new PgClient({ connectionString: url.toString() }); await sql.connect();
    for (const file of (await readdir(join(root, 'packages/db/migrations'))).filter((n) => n.endsWith('.sql')).sort()) await sql.query(await readFile(join(root, 'packages/db/migrations', file), 'utf8'));
    closePool = trackPgPoolCleanup((await import('@career/db')).pool);
    app = Fastify();
    (await import('../src/fact-import-routes.js')).registerFactImportRoutes(app, () => workspace, { rescore: async () => { rescores++; } });
  });
  after(async () => {
    await app?.close(); await closePool?.(); await sql?.end();
    if (admin) { await admin.query(`drop database if exists "${name}" with (force)`); await admin.end(); }
    if (directory) await rm(directory, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in envBefore)) delete process.env[key];
    Object.assign(process.env, envBefore);
  });

  async function fixture() {
    workspace = randomUUID(); const profile = randomUUID(); const existing = randomUUID();
    await sql.query('insert into workspaces(id,name) values($1,$2)', [workspace, 'Fictional']);
    await sql.query('insert into profile_versions(id,workspace_id,revision,profile) values($1,$2,1,$3)', [profile, workspace, JSON.stringify({ identity: { fullName: 'Fictional Candidate', email: 'candidate@example.test' } })]);
    await sql.query("insert into profile_facts(id,workspace_id,profile_version_id,kind,statement,approval_status) values($1,$2,$3,'skill','TypeScript','USER_APPROVED')", [existing, workspace, profile]);
    return { profile, existing };
  }
  const post = (payload: unknown) => app.inject({ method: 'POST', url: '/api/v1/profile/facts/import', payload: payload as object });
  const facts = async () => (await sql.query('select id,kind,statement,source,approval_status,import_id,profile_version_id from profile_facts where workspace_id=$1 order by created_at, statement', [workspace])).rows;

  test('stores every entry as an unconfirmed imported suggestion on the current revision, in one import', async () => {
    const { profile, existing } = await fixture(); const importId = randomUUID();
    const response = await post({ importId, facts: [
      { kind: 'skill', statement: 'typescript' },
      { kind: 'achievement', statement: 'Shipped a fictional app.', source: 'USER_ENTERED', approvalStatus: 'USER_APPROVED' },
      { kind: 'achievement', statement: 'shipped a  fictional app.' },
      { kind: 'experience', statement: 'Built fictional tools.', employment: { role: 'Engineer', company: 'Fictional Co', startMonth: '2020-01', current: true, locale: 'en' } },
    ] });
    assert.equal(response.statusCode, 201, response.body);
    const body = response.json() as { importId: string; facts: Array<{ id: string; source: string; approvalStatus: string; importId: string; duplicateOf: string | null; details: unknown }> };
    assert.equal(body.importId, importId);
    assert.equal(body.facts.length, 4);
    for (const fact of body.facts) { assert.equal(fact.source, 'IMPORTED_SUGGESTION'); assert.equal(fact.approvalStatus, 'SUGGESTED', 'A claimed approval is ignored'); assert.equal(fact.importId, importId); }
    assert.deepEqual(body.facts.map((fact) => fact.duplicateOf), [existing, null, body.facts[1]!.id, null], 'Duplicates are flagged, not dropped');
    assert.ok(body.facts[3]!.details, 'Structured entries keep their details');
    const stored = await facts();
    assert.equal(stored.length, 5);
    assert.ok(stored.filter((row) => row.import_id === importId).every((row) => row.profile_version_id === profile && row.approval_status === 'SUGGESTED'));
    assert.equal(stored.find((row) => row.id === existing)!.import_id, null, 'Facts entered by hand keep a null import_id');
  });

  test('a retried request returns the stored import instead of creating it twice', async () => {
    await fixture(); const importId = randomUUID(); const payload = { importId, facts: [{ kind: 'achievement', statement: 'Led a fictional migration.' }] };
    assert.equal((await post(payload)).statusCode, 201);
    const retry = await post(payload);
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal((retry.json() as { facts: unknown[] }).facts.length, 1);
    assert.equal((await facts()).filter((row) => row.import_id === importId).length, 1);
  });

  test('an invalid batch stores nothing', async () => {
    await fixture();
    const tooMany = await post({ importId: randomUUID(), facts: Array.from({ length: 101 }, (_, index) => ({ kind: 'skill', statement: `Skill ${index}` })) });
    assert.equal(tooMany.statusCode, 400); assert.equal((tooMany.json() as { error: string }).error, 'INVALID_INPUT');
    const oneBad = await post({ importId: randomUUID(), facts: [{ kind: 'skill', statement: 'Fine' }, { kind: 'skill', statement: 'x'.repeat(4001) }] });
    assert.equal(oneBad.statusCode, 400);
    assert.equal((await post({ facts: [{ kind: 'skill', statement: 'No import id' }] })).statusCode, 400);
    assert.equal((await facts()).length, 1, 'Only the fixture fact remains');
  });

  test('imports are scoped to the workspace', async () => {
    const importId = randomUUID();
    await fixture(); const first = workspace;
    assert.equal((await post({ importId, facts: [{ kind: 'skill', statement: 'Fictional skill' }] })).statusCode, 201);
    await fixture();
    const other = await post({ importId, facts: [{ kind: 'skill', statement: 'Fictional skill' }] });
    assert.equal(other.statusCode, 201, 'The same import id in another workspace is a new import');
    assert.equal((other.json() as { facts: Array<{ duplicateOf: string | null }> }).facts[0]!.duplicateOf, null, 'Duplicates are never matched across workspaces');
    assert.equal((await sql.query('select count(*)::int as n from profile_facts where import_id=$1 and workspace_id=$2', [importId, first])).rows[0]!.n, 1);
  });

  const approve = (factIds: string[]) => app.inject({ method: 'POST', url: '/api/v1/profile/facts/approve', payload: { factIds } });
  const statuses = async () => Object.fromEntries((await sql.query('select id, approval_status from profile_facts where workspace_id=$1', [workspace])).rows.map((row) => [row.id, row.approval_status]));
  async function suggestions(count: number) {
    const response = await post({ importId: randomUUID(), facts: Array.from({ length: count }, (_, index) => ({ kind: 'achievement', statement: `Fictional achievement ${index}` })) });
    return (response.json() as { facts: Array<{ id: string }> }).facts.map((fact) => fact.id);
  }

  test('approves every listed suggestion at once and rescores a single time', async () => {
    const { existing } = await fixture(); const ids = await suggestions(3); rescores = 0;
    const response = await approve([...ids, existing]);
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as { approved: number; facts: Array<{ id: string; approvalStatus: string; approvedAt: string | null }> };
    assert.equal(body.approved, 3, 'The already approved fact is not counted again');
    assert.deepEqual(body.facts.map((fact) => fact.id), [...ids, existing], 'Facts come back in the requested order');
    assert.ok(body.facts.every((fact) => fact.approvalStatus === 'USER_APPROVED'));
    assert.ok(body.facts.filter((fact) => ids.includes(fact.id)).every((fact) => fact.approvedAt), 'Newly approved entries record when');
    assert.equal(rescores, 1, 'Jobs are rescored once per batch');
    const retry = await approve(ids);
    assert.equal(retry.statusCode, 200); assert.equal((retry.json() as { approved: number }).approved, 0);
    assert.equal(rescores, 1, 'A retry that changes nothing does not rescore');
  });

  test('approves nothing when any id is missing, foreign, archived or from an older revision', async () => {
    const { profile } = await fixture(); const ids = await suggestions(2); rescores = 0;
    const before = await statuses();
    assert.equal((await approve([...ids, randomUUID()])).statusCode, 404, 'Unknown id');
    const mine = workspace;
    await fixture(); const foreign = await suggestions(1); workspace = mine;
    assert.equal((await approve([...ids, foreign[0]!])).statusCode, 404, 'Another workspace');
    const archived = randomUUID();
    await sql.query("insert into profile_facts(id,workspace_id,profile_version_id,kind,statement,approval_status) values($1,$2,$3,'skill','Archived fictional skill','REJECTED')", [archived, workspace, profile]);
    const archivedResponse = await approve([...ids, archived]);
    assert.equal(archivedResponse.statusCode, 409); assert.equal((archivedResponse.json() as { error: string }).error, 'FACT_ARCHIVED');
    await sql.query('insert into profile_versions(workspace_id,revision,profile) values($1,2,$2)', [workspace, '{}']);
    const stale = await approve(ids);
    assert.equal(stale.statusCode, 409); assert.equal((stale.json() as { error: string }).error, 'FACT_NOT_IN_CURRENT_REVISION');
    assert.deepEqual(Object.fromEntries(Object.entries(await statuses()).filter(([id]) => id in before)), before, 'Nothing changed');
    assert.equal(rescores, 0);
    assert.equal((await approve([ids[0]!, ids[0]!])).statusCode, 400, 'Duplicate ids');
  });

  const undo = (importId: string, expectedPending: number, expectedConfirmed: number) => app.inject({ method: 'POST', url: `/api/v1/profile/imports/${importId}/undo`, payload: { expectedPending, expectedConfirmed } });
  const summaryOf = async (importId: string) => (await app.inject({ method: 'GET', url: `/api/v1/profile/imports/${importId}` }));
  async function importOf(count: number) {
    const importId = randomUUID();
    const ids = ((await post({ importId, facts: Array.from({ length: count }, (_, index) => ({ kind: 'achievement', statement: `Undo fictional ${index}` })) })).json() as { facts: Array<{ id: string }> }).facts.map((fact) => fact.id);
    return { importId, ids };
  }

  test('undoing an import discards pending suggestions and archives confirmed entries, deleting nothing', async () => {
    const { existing } = await fixture(); const { importId, ids } = await importOf(4);
    assert.equal((await approve([ids[0]!, ids[1]!])).statusCode, 200);
    const shown = await summaryOf(importId);
    assert.equal(shown.statusCode, 200, shown.body);
    assert.deepEqual(shown.json(), { importId, pending: 2, confirmed: 2, inactive: 0 });
    rescores = 0;
    const response = await undo(importId, 2, 2);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { importId, discarded: 2, archived: 2 });
    assert.equal(rescores, 1, 'Archiving confirmed entries rescores once');
    const status = await statuses();
    assert.ok(ids.every((id) => status[id] === 'REJECTED'), 'Every entry of the import is discarded or archived');
    assert.equal(status[existing], 'USER_APPROVED', 'Entries outside the import are untouched');
    assert.equal(Object.keys(status).length, 5, 'Nothing is deleted');
    assert.deepEqual((await summaryOf(importId)).json(), { importId, pending: 0, confirmed: 0, inactive: 4 });
    const again = await undo(importId, 0, 0);
    assert.equal(again.statusCode, 200); assert.deepEqual(again.json(), { importId, discarded: 0, archived: 0 });
    assert.equal(rescores, 1, 'Undoing again changes nothing and does not rescore');
  });

  test('an undo with only pending suggestions does not rescore', async () => {
    await fixture(); const { importId } = await importOf(2); rescores = 0;
    assert.equal((await undo(importId, 2, 0)).statusCode, 200);
    assert.equal(rescores, 0);
  });

  test('an undo changes nothing when the import changed since it was confirmed', async () => {
    await fixture(); const { importId, ids } = await importOf(3); rescores = 0;
    assert.equal((await approve([ids[0]!])).statusCode, 200);
    const before = await statuses();
    const stale = await undo(importId, 3, 0);
    assert.equal(stale.statusCode, 409);
    assert.deepEqual(stale.json(), { error: 'IMPORT_CHANGED', pending: 2, confirmed: 1, inactive: 0 }, 'The current counts come back for a new confirmation');
    assert.deepEqual(await statuses(), before);
    assert.equal(rescores, 1, 'Only the approval rescored');
  });

  test('unknown, malformed or foreign imports are not found, and corrected entries stay in their import', async () => {
    const { profile } = await fixture(); const { importId } = await importOf(1);
    assert.equal((await undo(randomUUID(), 0, 0)).statusCode, 404);
    assert.equal((await undo('not-a-uuid', 0, 0)).statusCode, 404);
    assert.equal((await summaryOf(randomUUID())).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/profile/imports/${importId}/undo`, payload: { expectedPending: 1 } })).statusCode, 400);
    const mine = workspace; await fixture();
    assert.equal((await undo(importId, 1, 0)).statusCode, 404, 'Another workspace cannot see the import');
    workspace = mine;
    // A corrected entry carries the import id on the current revision (see the correction route), so undo reaches it.
    await sql.query("insert into profile_facts(workspace_id,profile_version_id,kind,statement,source,approval_status,import_id) values($1,$2,'skill','Corrected fictional skill','USER_ENTERED','SUGGESTED',$3)", [workspace, profile, importId]);
    assert.deepEqual((await summaryOf(importId)).json(), { importId, pending: 2, confirmed: 0, inactive: 0 });
    assert.equal((await undo(importId, 2, 0)).statusCode, 200);
  });
});
