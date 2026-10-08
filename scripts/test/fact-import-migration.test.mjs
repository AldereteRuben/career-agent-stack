// Builds a disposable local database from the checked-in migrations; it never reads the app DATABASE_URL.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const { Client } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_FACT_IMPORT_MIGRATION_ADMIN_URL;
const statements = (sql) => sql.split('--> statement-breakpoint').filter((part) => part.trim());

test('0011 adds a nullable import_id and leaves existing profile facts unchanged', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname), 'migration fixture must use loopback');
  assert.equal(maintenance.pathname, '/postgres', 'migration fixture URL must connect only through maintenance database');
  const database = `career_importm_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: maintenance.toString() }); let client;
  try {
    await admin.connect(); await admin.query(`CREATE DATABASE "${database}"`);
    maintenance.pathname = `/${database}`; client = new Client({ connectionString: maintenance.toString() }); await client.connect();
    const migrations = (await readdir(new URL('packages/db/migrations', root))).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    for (const file of migrations.filter((file) => file < '0011')) for (const statement of statements(await readFile(new URL(`packages/db/migrations/${file}`, root), 'utf8'))) await client.query(statement);

    const workspace = randomUUID(); const profile = randomUUID();
    await client.query('INSERT INTO workspaces(id) VALUES($1)', [workspace]);
    await client.query('INSERT INTO profile_versions(id,workspace_id,revision,profile) VALUES($1,$2,1,$3)', [profile, workspace, '{}']);
    await client.query("INSERT INTO profile_facts(workspace_id,profile_version_id,kind,statement,source,approval_status) VALUES($1,$2,'skill','Fictional skill','USER_ENTERED','USER_APPROVED'),($1,$2,'achievement','Fictional suggestion','IMPORTED_SUGGESTION','SUGGESTED')", [workspace, profile]);
    const before = (await client.query('SELECT * FROM profile_facts WHERE workspace_id=$1 ORDER BY statement', [workspace])).rows;

    for (const statement of statements(await readFile(new URL('packages/db/migrations/0011_fact_import.sql', root), 'utf8'))) await client.query(statement);

    const after = (await client.query('SELECT * FROM profile_facts WHERE workspace_id=$1 ORDER BY statement', [workspace])).rows;
    assert.equal(after.length, before.length);
    after.forEach((row, index) => {
      for (const field of Object.keys(before[index])) assert.deepEqual(row[field], before[index][field], `existing field ${field} preserved`);
      assert.equal(row.import_id, null, 'Existing facts have no import');
    });
    const column = (await client.query("SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name='profile_facts' AND column_name='import_id'")).rows[0];
    assert.deepEqual(column, { is_nullable: 'YES', data_type: 'uuid' });
    const index = (await client.query("SELECT indexdef FROM pg_indexes WHERE indexname='profile_facts_workspace_import_idx'")).rows[0];
    assert.match(index.indexdef, /\(workspace_id, import_id\) WHERE \(import_id IS NOT NULL\)/);

    const importId = randomUUID();
    await client.query("INSERT INTO profile_facts(workspace_id,profile_version_id,kind,statement,source,import_id) VALUES($1,$2,'skill','Imported fictional skill','IMPORTED_SUGGESTION',$3)", [workspace, profile, importId]);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM profile_facts WHERE workspace_id=$1 AND import_id=$2', [workspace, importId])).rows[0].n, 1);
  } finally {
    await client?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
});
