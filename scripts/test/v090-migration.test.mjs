// Builds a disposable local database from the checked-in migrations; it never reads the app DATABASE_URL.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const { Client } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_V090_MIGRATION_ADMIN_URL;

test('0010 adds workspace-scoped AI storage and preserves legacy document rows', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname), 'migration fixture must use loopback');
  assert.equal(maintenance.pathname, '/postgres', 'migration fixture URL must connect only through maintenance database');
  const database = `career_v090m_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: maintenance.toString() }); let client;
  try {
    await admin.connect(); await admin.query(`CREATE DATABASE "${database}"`);
    maintenance.pathname = `/${database}`; client = new Client({ connectionString: maintenance.toString() }); await client.connect();
    const migrations = (await readdir(new URL('packages/db/migrations', root))).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    for (const file of migrations.filter(file => file < '0010')) {
      const sql = await readFile(new URL(`packages/db/migrations/${file}`, root), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint').filter((part) => part.trim())) await client.query(statement);
    }
    const workspace = randomUUID(); const connection = randomUUID(); const consent = randomUUID();
    await client.query('INSERT INTO workspaces(id) VALUES($1)',[workspace]);
    await client.query(`INSERT INTO document_versions(workspace_id,name,revision,media_type,storage_path,sha256,claims) VALUES($1,'legacy',1,'application/pdf','/fixture/legacy.pdf',$2,'[]')`,[workspace,'a'.repeat(64)]);
    const before=(await client.query('SELECT * FROM document_versions WHERE workspace_id=$1',[workspace])).rows[0];
    const migration=await readFile(new URL('packages/db/migrations/0010_ai_persistence.sql',root),'utf8');
    for (const statement of migration.split('--> statement-breakpoint').filter(part=>part.trim())) await client.query(statement);
    const after=(await client.query('SELECT * FROM document_versions WHERE workspace_id=$1',[workspace])).rows[0];
    for (const field of Object.keys(before)) assert.deepEqual(after[field],before[field],`legacy field ${field} preserved`);
    const legacy=await client.query(`SELECT claims_contract_version,claims_basis,claims FROM document_versions WHERE workspace_id=$1`,[workspace]);
    assert.equal(legacy.rows[0].claims_contract_version,null); assert.equal(legacy.rows[0].claims_basis,null); assert.deepEqual(legacy.rows[0].claims,[]);
    await client.query(`INSERT INTO ai_connections(id,workspace_id,provider,account_fingerprint,state) VALUES($1,$2,'codex',$3,'CONNECTED')`,[connection,workspace,'b'.repeat(64)]);
    await client.query(`INSERT INTO ai_consents(id,workspace_id,connection_id,provider,account_fingerprint,connection_revision,revision,operation,data_categories,notice_version) VALUES($1,$2,$3,'codex',$4,1,1,'JOB_ANALYSIS','["JOB_POSTING"]','notice-v1')`,[consent,workspace,connection,'b'.repeat(64)]);
    const foreignWorkspace=randomUUID(); await client.query('INSERT INTO workspaces(id) VALUES($1)',[foreignWorkspace]);
    await assert.rejects(client.query(`INSERT INTO ai_consents(workspace_id,connection_id,provider,account_fingerprint,connection_revision,revision,operation,data_categories,notice_version) VALUES($1,$2,'codex',$3,1,1,'JOB_ANALYSIS','["JOB_POSTING"]','notice-v1')`,[foreignWorkspace,connection,'b'.repeat(64)]), /ai_consents_workspace_connection_fk/);
    const runId=randomUUID(); const snapshot={synthetic:true};
    await client.query(`INSERT INTO ai_runs(id,workspace_id,connection_id,consent_id,provider,connection_revision,consent_revision,account_fingerprint,operation,origin,idempotency_key,content_identity,account_lock_key,snapshot,snapshot_hash,input_versions) VALUES($1,$2,$3,$4,'codex',1,1,$5,'JOB_ANALYSIS','MANUAL','idempotency','c','d',$6,'e',$7)`,[runId,workspace,connection,consent,'b'.repeat(64),JSON.stringify(snapshot),'{}']);
    await assert.rejects(client.query('UPDATE ai_runs SET snapshot=$2 WHERE id=$1',[runId,'{"tampered":true}']), /immutable/);
    await client.query(`INSERT INTO ai_artifacts(workspace_id,run_id,schema_version,prompt_version,locale,output,sources) VALUES($1,$2,1,'prompt-v1','en','{}','{}')`,[workspace,runId]);
    const artifactId=(await client.query('SELECT id FROM ai_artifacts WHERE workspace_id=$1 AND run_id=$2',[workspace,runId])).rows[0].id;
    await assert.rejects(client.query('UPDATE ai_artifacts SET output=$2 WHERE id=$1',[artifactId,'{"tampered":true}']), /immutable/);
    assert.equal((await client.query('SELECT remembered FROM ai_consents WHERE id=$1',[consent])).rows[0].remembered,false);
    assert.equal((await client.query('SELECT revision FROM ai_artifacts WHERE id=$1',[artifactId])).rows[0].revision,1);
    await client.query(`INSERT INTO llm_usage(workspace_id,ai_run_id,provider,model,operation,status) VALUES($1,$2,'codex',NULL,'JOB_ANALYSIS','SUCCEEDED')`,[workspace,runId]);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM ai_runs WHERE workspace_id=$1`,[workspace])).rows[0].n,1);
  } finally {
    await client?.end().catch(() => {}); await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`).catch(() => {}); await admin.end();
  }
});
