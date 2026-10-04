// Upgrade fixture from the schema at v0.7.2 (migrations 0000..0008) to 0009.
// Uses only a throwaway database on the loopback maintenance server.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const { Client } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_V080_MIGRATION_ADMIN_URL || process.env.CAREER_BACKUP_TEST_ADMIN_URL;

test('v0.7.2 schema upgrades to 0009 without changing legacy search or job decisions', { skip: !adminUrl }, async () => {
  const maintenance = new URL(adminUrl);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(maintenance.hostname), 'admin database must be loopback');
  assert.equal(maintenance.pathname, '/postgres', 'connect only through the maintenance database');
  const name = `career_v080m_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: maintenance.toString() });
  let client;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    maintenance.pathname = `/${name}`;
    client = new Client({ connectionString: maintenance.toString() });
    await client.connect();
    const apply = async (tag) => {
      const sql = await readFile(new URL(`packages/db/migrations/${tag}.sql`, root), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint').filter((part) => part.trim())) await client.query(statement);
    };
    const migrationFiles = (await readdir(new URL('packages/db/migrations', root)))
      .filter((file) => /^000[0-8]_.*\.sql$/.test(file)).sort();
    assert.equal(migrationFiles.length, 9, 'fixtures start after v0.7.2 migrations 0000..0008');
    for (const file of migrationFiles) await apply(file.replace(/\.sql$/, ''));

    const workspaceId = randomUUID(); const searchId = randomUUID(); const jobId = randomUUID();
    const matchAt = '2026-09-10T12:34:56.000Z';
    await client.query('INSERT INTO workspaces(id) VALUES($1)', [workspaceId]);
    await client.query(`INSERT INTO saved_job_searches(id,workspace_id,role,location,work_mode,frequency_hours,enabled,auto_prepare,language,next_run_at,last_run_status,last_result_count)
      VALUES($1,$2,'QA engineer','Spain','remote',6,true,true,'es',$3,'SUCCEEDED',7)`, [searchId, workspaceId, matchAt]);
    await client.query(`INSERT INTO jobs(id,workspace_id,company,title,location,canonical_url,availability,shortlist_decision)
      VALUES($1,$2,'Fictional employer','QA Engineer','Remote — Spain','https://fictional.example.test/jobs/old','OPEN','ARCHIVED')`, [jobId, workspaceId]);
    await client.query(`INSERT INTO job_search_sources(workspace_id,job_id,provider,external_id,source_url,raw)
      VALUES($1,$2,'remotive','old-remotive-id','https://remotive.com/jobs/old','{"fixture":"legacy"}')`, [workspaceId, jobId]);
    await client.query(`INSERT INTO saved_job_search_matches(workspace_id,search_id,job_id,matched_at,last_matched_at,auto_prepared_at,auto_prepare_attempts,auto_prepare_error)
      VALUES($1,$2,$3,$4,$4,$4,2,'ALREADY_PREPARED')`, [workspaceId, searchId, jobId, matchAt]);

    // This is the exact v0.7.2 schema state before the additive migration.
    const before = (await client.query(`SELECT s.id,s.role,s.location,s.work_mode,s.frequency_hours,s.enabled,s.auto_prepare,s.language,s.next_run_at,s.last_run_status,s.last_result_count,
      j.shortlist_decision,m.matched_at,m.auto_prepared_at,m.auto_prepare_attempts,m.auto_prepare_error,src.id AS source_id,src.external_id,src.provider
      FROM saved_job_searches s JOIN jobs j ON j.workspace_id=s.workspace_id JOIN saved_job_search_matches m ON m.workspace_id=s.workspace_id AND m.search_id=s.id AND m.job_id=j.id
      JOIN job_search_sources src ON src.workspace_id=j.workspace_id AND src.job_id=j.id WHERE s.id=$1`, [searchId])).rows[0];
    assert.equal(before.id, searchId);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name='search_runs'`)).rows[0].n, 0);

    await apply('0009_search_execution');
    const after = (await client.query(`SELECT s.id,s.role,s.location,s.work_mode,s.frequency_hours,s.enabled,s.auto_prepare,s.language,s.next_run_at,s.last_run_status,s.last_result_count,
      s.revision,s.matcher_version,s.provider_ids,s.include_related,j.shortlist_decision,m.matched_at,m.auto_prepared_at,m.auto_prepare_attempts,m.auto_prepare_error,src.id AS source_id,src.external_id,src.provider
      FROM saved_job_searches s JOIN jobs j ON j.workspace_id=s.workspace_id JOIN saved_job_search_matches m ON m.workspace_id=s.workspace_id AND m.search_id=s.id AND m.job_id=j.id
      JOIN job_search_sources src ON src.workspace_id=j.workspace_id AND src.job_id=j.id WHERE s.id=$1`, [searchId])).rows[0];
    for (const column of ['id','role','location','work_mode','frequency_hours','enabled','auto_prepare','language','next_run_at','last_run_status','last_result_count','shortlist_decision','matched_at','auto_prepared_at','auto_prepare_attempts','auto_prepare_error','source_id','external_id','provider']) {
      assert.deepEqual(after[column], before[column], `${column} survives 0009`);
    }
    assert.equal(after.revision, 1);
    assert.equal(after.matcher_version, 1, 'upgraded searches keep legacy matcher semantics');
    assert.deepEqual(after.provider_ids, ['remotive','arbeitnow']);
    assert.equal(after.include_related, false);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM search_runs')).rows[0].n, 0);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM search_run_results')).rows[0].n, 0);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM search_job_reviews')).rows[0].n, 0);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM job_identity_members')).rows[0].n, 0);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM search_preparation_budget')).rows[0].n, 0);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM search_query_cache')).rows[0].n, 0);
  } finally {
    await client?.end().catch(() => {});
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  }
});
