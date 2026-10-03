import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const { Client } = createRequire(new URL('packages/db/package.json', root))('pg');
const adminUrl = process.env.CAREER_BACKUP_TEST_ADMIN_URL;

test('0.3.1 data survives the 0.4 migration and resume links enforce workspace ownership', { skip: !adminUrl }, async () => {
  const name = `career_v040_${randomBytes(6).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl }); await admin.connect();
  let client;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const target = new URL(adminUrl); target.pathname = `/${name}`;
    client = new Client({ connectionString: target.toString() }); await client.connect();
    const journal = JSON.parse(await readFile(new URL('packages/db/migrations/meta/_journal.json', root), 'utf8'));
    const apply = async (tag) => {
      const sql = await readFile(new URL(`packages/db/migrations/${tag}.sql`, root), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint').filter((item) => item.trim())) await client.query(statement);
    };
    for (const entry of journal.entries.filter((entry) => entry.idx < 5)) await apply(entry.tag);
    const workspace = randomUUID(); const profile = randomUUID(); const fact = randomUUID(); const doc = randomUUID(); const application = randomUUID();
    await client.query('INSERT INTO workspaces(id) VALUES ($1)', [workspace]);
    await client.query('INSERT INTO profile_versions(id, workspace_id, revision, profile) VALUES ($1,$2,1,$3)', [profile, workspace, { identity: { fullName: 'Fictional upgrade user' } }]);
    await client.query("INSERT INTO profile_facts(id,workspace_id,profile_version_id,kind,statement,approval_status) VALUES ($1,$2,$3,'experience',$4,'USER_APPROVED')", [fact, workspace, profile, 'Original · Employer\n01/2020 - Actualidad\nOriginal text']);
    await client.query("INSERT INTO document_versions(id,workspace_id,name,revision,profile_revision_id,media_type,storage_path,sha256,claims,approval_status) VALUES ($1,$2,'Existing PDF',1,$3,'application/pdf','fixture.pdf',$4,$5,'USER_APPROVED')", [doc, workspace, profile, 'a'.repeat(64), JSON.stringify([{ text: 'Original text', sourceFactIds: [fact] }])]);
    await client.query("INSERT INTO applications(id,workspace_id,company,role) VALUES ($1,$2,'Example','Designer')", [application, workspace]);
    const before = (await client.query('SELECT * FROM document_versions WHERE id=$1', [doc])).rows[0];
    await apply('0005_structured_profile_and_resume_link');
    assert.deepEqual((await client.query('SELECT * FROM document_versions WHERE id=$1', [doc])).rows[0], before);
    const entry = (await client.query('SELECT * FROM profile_facts WHERE id=$1', [fact])).rows[0];
    assert.equal(entry.details, null); assert.equal(entry.approval_status, 'USER_APPROVED'); assert.match(entry.statement, /Original text$/);
    assert.equal((await client.query('SELECT document_id FROM applications WHERE id=$1', [application])).rows[0].document_id, null);
    await client.query('UPDATE applications SET document_id=$1 WHERE id=$2', [doc, application]);
    const otherWorkspace = randomUUID(); const otherDoc = randomUUID();
    await client.query('INSERT INTO workspaces(id) VALUES ($1)', [otherWorkspace]);
    await client.query("INSERT INTO document_versions(id,workspace_id,name,revision,media_type,storage_path,sha256) VALUES ($1,$2,'Other',1,'application/pdf','other.pdf',$3)", [otherDoc, otherWorkspace, 'b'.repeat(64)]);
    await assert.rejects(client.query('UPDATE applications SET document_id=$1 WHERE id=$2', [otherDoc, application]), /applications_workspace_document_fk/);
    assert.equal((await client.query('SELECT document_id FROM applications WHERE id=$1', [application])).rows[0].document_id, doc);
  } finally {
    await client?.end(); await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end();
  }
});

