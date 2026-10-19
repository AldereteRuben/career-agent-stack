import { trackPgPoolCleanup } from './helpers/pg-pool-cleanup.js';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import Fastify from 'fastify';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@career/db';
import { registerApplicationFollowUpRoutes } from '../src/application-follow-up-routes.js';

const root = new URL('../../../', import.meta.url);
const { Client, Pool } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_APPLICATION_DOCUMENTS_TEST_ADMIN_URL;

test('follow-up draft routes support CRUD while scoping every operation to its workspace and application', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl!);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname), 'fixture must use loopback');
  assert.equal(maintenance.pathname, '/postgres', 'fixture URL must connect only through the maintenance database');
  const databaseName = `career_followup_api_${randomBytes(5).toString('hex')}`;
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
    const owner = randomUUID(); const otherWorkspace = randomUUID(); const applicationId = randomUUID(); const siblingApplicationId = randomUUID(); const foreignApplicationId = randomUUID();
    await client.query('INSERT INTO workspaces(id) VALUES($1),($2)', [owner, otherWorkspace]);
    await client.query("INSERT INTO applications(id,workspace_id,company,role,state) VALUES($1,$2,'Synthetic Co','Designer','IN_PROGRESS'),($3,$2,'Synthetic Co','Engineer','DRAFT'),($4,$5,'Other Co','Designer','DRAFT')", [applicationId, owner, siblingApplicationId, foreignApplicationId, otherWorkspace]);
    const workspace = (request: { headers: Record<string, unknown> }) => request.headers['x-fixture-workspace'] === otherWorkspace ? otherWorkspace : owner;
    registerApplicationFollowUpRoutes(app, workspace, database);
    const headers = { 'x-fixture-workspace': owner };
    const url = (id: string) => `/api/v1/applications/${id}/follow-up-draft`;
    const input = { language: 'es', subject: 'Seguimiento — Synthetic Co', body: 'Hola, escribo para consultar el estado de mi candidatura.' };

    assert.equal((await app.inject({ url: url(randomUUID()), headers })).statusCode, 404, 'unknown applications are not exposed');
    assert.equal((await app.inject({ url: '/api/v1/applications/not-a-uuid/follow-up-draft', headers })).statusCode, 400, 'malformed application identifiers are rejected');
    assert.equal((await app.inject({ url: url(foreignApplicationId), headers })).statusCode, 404, 'foreign applications are hidden');
    assert.equal((await app.inject({ method: 'POST', url: url(randomUUID()), headers, payload: input })).statusCode, 404, 'drafts cannot be created for missing applications');
    assert.equal((await app.inject({ method: 'POST', url: url(applicationId), headers, payload: { ...input, language: 'fr' } })).statusCode, 400, 'unsupported languages are rejected');
    assert.equal((await app.inject({ method: 'POST', url: url(applicationId), headers, payload: { ...input, extra: true } })).statusCode, 400, 'unexpected fields are rejected');

    const created = await app.inject({ method: 'POST', url: url(applicationId), headers, payload: input });
    assert.equal(created.statusCode, 201, created.body);
    assert.deepEqual(created.json().draft, { ...created.json().draft, workspaceId: owner, applicationId, ...input });
    assert.equal((await app.inject({ method: 'POST', url: url(applicationId), headers, payload: input })).statusCode, 409, 'a concurrent or repeated create is reported as a conflict');

    const fetched = await app.inject({ url: url(applicationId), headers });
    assert.equal(fetched.statusCode, 200); assert.deepEqual(fetched.json().draft, created.json().draft);
    assert.deepEqual((await app.inject({ url: url(siblingApplicationId), headers })).json(), { draft: null }, 'another application in the workspace has its own empty draft slot');
    const foreignHeaders = { 'x-fixture-workspace': otherWorkspace };
    assert.equal((await app.inject({ url: url(applicationId), headers: foreignHeaders })).statusCode, 404, 'another workspace cannot read the draft');
    assert.equal((await app.inject({ method: 'PUT', url: url(applicationId), headers: foreignHeaders, payload: input })).statusCode, 404, 'another workspace cannot edit the draft');
    assert.equal((await app.inject({ method: 'DELETE', url: url(applicationId), headers: foreignHeaders })).statusCode, 404, 'another workspace cannot delete the draft');
    assert.equal((await app.inject({ method: 'PUT', url: url(siblingApplicationId), headers, payload: input })).statusCode, 404, 'another application cannot overwrite the draft');
    assert.equal((await app.inject({ method: 'DELETE', url: url(siblingApplicationId), headers })).statusCode, 404, 'another application cannot delete the draft');

    const edited = { language: 'en', subject: 'Checking in about the Designer role', body: 'Hello, I am checking in on my application.' };
    const update = await app.inject({ method: 'PUT', url: url(applicationId), headers, payload: edited });
    assert.equal(update.statusCode, 200, update.body); assert.deepEqual({ language: update.json().draft.language, subject: update.json().draft.subject, body: update.json().draft.body }, edited);
    const beforeDelete = (await client.query('SELECT state, version FROM applications WHERE id=$1 AND workspace_id=$2', [applicationId, owner])).rows[0];
    const deleted = await app.inject({ method: 'DELETE', url: url(applicationId), headers });
    assert.equal(deleted.statusCode, 204);
    assert.deepEqual((await app.inject({ url: url(applicationId), headers })).json(), { draft: null });
    assert.deepEqual((await client.query('SELECT state, version FROM applications WHERE id=$1 AND workspace_id=$2', [applicationId, owner])).rows[0], beforeDelete, 'draft CRUD does not change application state or version');
    assert.equal((await client.query('SELECT count(*)::int AS n FROM application_events WHERE application_id=$1', [applicationId])).rows[0].n, 0, 'draft CRUD does not create application timeline events');
  } finally {
    await app.close();
    await closePool?.();
    await client?.end().catch(() => {});
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
    await admin.end().catch(() => {});
  }
});
