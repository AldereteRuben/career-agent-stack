// End-to-end backup/restore test against DISPOSABLE PostgreSQL databases with fictional data.
// It never reads or writes the live installation: the source installation is a temporary .env + folder,
// and every database/role it creates carries a random career_bkt_ prefix and is dropped at the end.
//
//   CAREER_BACKUP_TEST_ADMIN_URL=postgresql://$USER@127.0.0.1:5432/postgres \
//     node --test --test-concurrency=1 scripts/test/backup-restore.integration.test.mjs
//
// Optional: CAREER_BACKUP_TEST_APP_URL=postgresql://career:<password>@127.0.0.1:5432/postgres to own the test
// databases with an existing application role instead of a temporary one. CAREER_BACKUP_TEST_VERBOSE=1 prints CLI output;
// CAREER_BACKUP_TEST_KEEP=1 keeps the disposable databases and folder for manual inspection (drop them afterwards).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { after, before, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildHeader, extractArchive, writeArchive } from '../lib/backup-archive.mjs';
import { keyFileContent, manifestMac, withDatabase } from '../lib/backup-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const adminUrl = process.env.CAREER_BACKUP_TEST_ADMIN_URL;
const requireDb = createRequire(join(root, 'packages/db/package.json'));
const tag = `career_bkt_${randomBytes(4).toString('hex')}`;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mode = async (path) => (await stat(path)).mode & 0o777;

/** A small valid PDF with fictional text. */
function pdf(text) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 14 Tf 72 770 Td (${text}) Tj ET`;
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

function run(script, args, env = {}) {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root, env: { ...process.env, LANG: 'en_US.UTF-8', CAREER_LANG: '', ...env }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (process.env.CAREER_BACKUP_TEST_VERBOSE) process.stderr.write(`\n$ ${script} ${args.join(' ')}\n${stdout}${stderr}`);
        resolvePromise({ code: error ? error.code ?? 1 : 0, stdout, stderr, all: `${stdout}\n${stderr}` });
      });
  });
}

describe('backup and isolated restore (disposable databases)', { skip: !adminUrl && 'set CAREER_BACKUP_TEST_ADMIN_URL to run' }, () => {
  const { Client } = adminUrl ? requireDb('pg') : {};
  let admin;
  let work;
  let appUrl;
  let createdRole = null;
  const secrets = {};
  const databases = new Set();
  const sourceDb = `${tag}_src`;
  let envFile;
  let filesDir;
  let backupDir;
  let archive;
  let keyFile;
  const documents = [];

  const dbExists = async (name) => (await admin.query('select 1 from pg_database where datname = $1', [name])).rowCount === 1;
  const query = async (database, sql, params) => {
    const client = new Client({ connectionString: withDatabase(appUrl, database) });
    await client.connect();
    try { return await client.query(sql, params); } finally { await client.end(); }
  };
  const restoreEnv = () => ({ CAREER_RESTORE_ADMIN_URL: adminUrl, CAREER_RESTORE_APP_URL: appUrl });
  const assertNoSecrets = (output) => {
    for (const [name, value] of Object.entries(secrets)) assert.ok(!output.includes(value), `output leaked ${name}`);
  };

  before(async () => {
    work = await mkdtemp(join(tmpdir(), 'career-backup-it-'));
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    if (process.env.CAREER_BACKUP_TEST_APP_URL) {
      appUrl = process.env.CAREER_BACKUP_TEST_APP_URL;
    } else {
      createdRole = `${tag}_app`;
      const password = randomBytes(18).toString('base64url');
      await admin.query(`create role ${createdRole} login password '${password}'`);
      appUrl = new URL(adminUrl);
      appUrl.username = createdRole;
      appUrl.password = password;
      appUrl = appUrl.toString();
    }
    const appPassword = decodeURIComponent(new URL(appUrl).password);
    // A short password such as the example "career" also occurs in ordinary words; then look for the credential form.
    if (appPassword) secrets.databasePassword = appPassword.length >= 12 ? appPassword : `${new URL(appUrl).username}:${new URL(appUrl).password}@`;
    const owner = decodeURIComponent(new URL(appUrl).username);
    await admin.query(`create database ${sourceDb} owner ${admin.escapeIdentifier(owner)} template template0`);
    databases.add(sourceDb);

    // Real schema through the project's own drizzle migrations.
    const { drizzle } = requireDb('drizzle-orm/node-postgres');
    const { migrate } = requireDb('drizzle-orm/node-postgres/migrator');
    const client = new Client({ connectionString: withDatabase(appUrl, sourceDb) });
    await client.connect();
    await migrate(drizzle(client), { migrationsFolder: join(root, 'packages/db/migrations') });

    // Fictional data. Boards are ENABLED and APPROVED here so the restore has to switch them off.
    filesDir = join(work, 'source-install', 'data', 'files');
    await mkdir(filesDir, { recursive: true, mode: 0o700 });
    const ws = (await client.query(`insert into workspaces (name) values ('Ficticia · Ada Example') returning id`)).rows[0].id;
    const profile = (await client.query(`insert into profile_versions (workspace_id, revision, profile) values ($1, 1, '{"identity":{"fullName":"Ada Example"}}') returning id`, [ws])).rows[0].id;
    await client.query(`insert into profile_facts (workspace_id, profile_version_id, kind, statement, approval_status) values ($1, $2, 'skill', 'Builds fictional test fixtures', 'USER_APPROVED'), ($1, $2, 'role', 'Example Engineer at Nowhere Ltd', 'SUGGESTED')`, [ws, profile]);
    const board = (await client.query(`insert into boards (workspace_id, provider, tenant, region, company_name, company_domain, careers_url, permission_status, enabled) values ($1, 'greenhouse', 'fictional-co', 'global', 'Fictional Co', 'fictional.example.test', 'https://fictional.example.test/jobs', 'APPROVED_FOR_SCOPE', true) returning id`, [ws])).rows[0].id;
    await client.query(`insert into boards (workspace_id, provider, tenant, region, company_name, company_domain, careers_url, permission_status, enabled) values ($1, 'lever', 'imaginary', 'global', 'Imaginary Inc', 'imaginary.example.test', 'https://imaginary.example.test', 'UNKNOWN', false)`, [ws]);
    await client.query(`insert into source_policy_reviews (workspace_id, board_id, capability, access_class, permission_status, api_host, adapter_version, reviewed_at) values ($1, $2, 'discovery', 'public-api', 'APPROVED_FOR_SCOPE', 'boards-api.example.test', 'test-1', now())`, [ws, board]);
    await client.query('update workspaces set discovery_enabled = true where id = $1', [ws]);
    await client.query(`insert into search_profiles (workspace_id, name, enabled) values ($1, 'Fictional search', true)`, [ws]);
    const job = (await client.query(`insert into jobs (workspace_id, company, title) values ($1, 'Fictional Co', 'Example Engineer') returning id`, [ws])).rows[0].id;
    const snapshot = (await client.query(`insert into job_snapshots (workspace_id, job_id, title, snapshot_hash) values ($1, $2, 'Example Engineer', $3) returning id`, [ws, job, sha('Example Engineer')])).rows[0].id;
    const application = (await client.query(`insert into applications (workspace_id, job_id, company, role, state) values ($1, $2, 'Fictional Co', 'Example Engineer', 'IN_PROGRESS') returning id`, [ws, job])).rows[0].id;
    await client.query(`insert into application_events (workspace_id, application_id, event_type, aggregate_version) values ($1, $2, 'CREATED', 1)`, [ws, application]);
    for (const [index, text] of ['Ada Example - CV (ficticio)', 'Ada Example - Cover letter', 'Ada Example - CV v2'].entries()) {
      const id = randomUUID();
      const bytes = pdf(text);
      const storagePath = `${ws}/${id}.pdf`;
      await mkdir(join(filesDir, ws), { recursive: true, mode: 0o700 });
      await writeFile(join(filesDir, storagePath), bytes, { mode: 0o600 });
      await client.query(`insert into document_versions (id, workspace_id, name, revision, profile_revision_id, job_snapshot_id, media_type, storage_path, sha256, claims) values ($1, $2, $3, 1, $4, $5, 'application/pdf', $6, $7, '[]')`,
        [id, ws, `doc-${index}`, profile, index === 0 ? snapshot : null, storagePath, sha(bytes)]);
      documents.push({ id, storagePath, sha256: sha(bytes) });
    }
    await writeFile(join(filesDir, ws, 'orphan-render.pdf'), pdf('orphan, not referenced')); // must not be backed up
    await client.query(`insert into assisted_attempts(workspace_id, application_id, status, plan, digest, expires_at, consented_at) values ($1,$2,'HANDED_OFF','{}','test-digest',now()+interval '10 minutes',now())`,[ws,application]);
    await client.end();

    secrets.encryptionKey = randomBytes(32).toString('base64');
    secrets.sessionSecret = randomBytes(32).toString('base64');
    envFile = join(work, 'source-install', '.env');
    await writeFile(envFile, [
      `DATABASE_URL=${withDatabase(appUrl, sourceDb)}`, `APP_ENCRYPTION_KEY=${secrets.encryptionKey}`, `APP_SESSION_SECRET=${secrets.sessionSecret}`,
      `FILES_LOCAL_PATH=${filesDir}`, `DATA_LOCAL_PATH=${dirname(filesDir)}`, '',
    ].join('\n'), { mode: 0o600 });
    backupDir = join(work, 'backups');
  });

  after(async () => {
    if (!admin) return;
    if (process.env.CAREER_BACKUP_TEST_KEEP) {
      // Manual inspection only: leaves the disposable databases, role and folder in place and says where they are.
      process.stderr.write(`\nKept for inspection: folder ${work}; databases ${[...databases].join(', ')}${createdRole ? `; role ${createdRole}` : ''}\n`);
      await admin.end();
      return;
    }
    for (const name of databases) {
      if (!name.startsWith(tag)) continue; // only what this run created
      await admin.query(`drop database if exists ${admin.escapeIdentifier(name)} with (force)`).catch(() => {});
    }
    if (createdRole) await admin.query(`drop role if exists ${createdRole}`).catch(() => {});
    await admin.end();
    await rm(work, { recursive: true, force: true });
  });

  test('backup succeeds, is private, verified, and contains no secrets', async () => {
    const result = await run('backup.mjs', ['--env-file', envFile, '--out-dir', backupDir]);
    assert.equal(result.code, 0, result.all);
    assertNoSecrets(result.all);
    assert.match(result.stdout, /Verified backup/);
    const names = await readdir(backupDir);
    archive = join(backupDir, names.find((name) => name.endsWith('.tar')));
    keyFile = join(backupDir, names.find((name) => name.startsWith('career-key-')));
    assert.deepEqual(names.filter((name) => name.startsWith('.')), [], 'no staging leftovers');
    assert.equal(await mode(backupDir), 0o700);
    assert.equal(await mode(archive), 0o600);
    assert.equal(await mode(`${archive}.sha256`), 0o600);
    assert.equal(await mode(keyFile), 0o600);
    assert.equal(JSON.parse(await readFile(keyFile, 'utf8')).APP_ENCRYPTION_KEY, secrets.encryptionKey);
    const bytes = await readFile(archive);
    assertNoSecrets(bytes.toString('latin1'));
    assert.equal((await readFile(`${archive}.sha256`, 'utf8')).split(' ')[0], sha(bytes));
    const staged = await mkdtemp(join(work, 'inspect-'));
    const entries = await extractArchive(archive, staged);
    const manifest = JSON.parse(await readFile(entries.get('manifest.json').path, 'utf8'));
    assert.equal(manifest.documents.length, 3);
    assert.ok(![...entries.keys()].some((name) => name.includes('orphan')), 'unreferenced files are excluded');
    assert.equal(manifest.tables['public.boards'], 2);
    assert.equal(manifest.migrations.length, 8);
    // A second backup reuses the same key file instead of writing another one.
    await delay(1100); // archive names have one-second resolution
    const second = await run('backup.mjs', ['--env-file', envFile, '--out-dir', backupDir]);
    assert.equal(second.code, 0, second.all);
    assert.match(second.stdout, /already existed with the same key/);
    assert.equal((await readdir(backupDir)).filter((name) => name.startsWith('career-key-')).length, 1);
  });

  test('backup refuses while another backup holds the lock', async () => {
    const holder = new Client({ connectionString: withDatabase(appUrl, sourceDb) });
    await holder.connect();
    await holder.query("select pg_advisory_lock(hashtext('career-agent-stack:backup'))");
    try {
      const result = await run('backup.mjs', ['--env-file', envFile, '--out-dir', join(work, 'busy-1')]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Another backup of this database is already running/);
    } finally { await holder.end(); }
  });

  test('backup waits for in-flight document writes and fails clearly after 10 s', async () => {
    const writer = new Client({ connectionString: withDatabase(appUrl, sourceDb) });
    await writer.connect();
    await writer.query('begin');
    await writer.query('lock table document_versions in row exclusive mode'); // what an INSERT holds
    try {
      const result = await run('backup.mjs', ['--env-file', envFile, '--out-dir', join(work, 'busy-2')]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /could not be locked within 10 s/);
      assert.deepEqual((await readdir(join(work, 'busy-2'))).filter((name) => name.endsWith('.tar')), []);
    } finally { await writer.query('rollback'); await writer.end(); }
  });

  test('backup fails instead of producing an incomplete copy when a document file is missing or changed', async () => {
    const victim = join(filesDir, documents[2].storagePath);
    const original = await readFile(victim);
    await writeFile(victim, Buffer.concat([original, Buffer.from('tampered')]));
    try {
      const changed = await run('backup.mjs', ['--env-file', envFile, '--out-dir', join(work, 'bad-src')]);
      assert.equal(changed.code, 1);
      assert.match(changed.stderr, /does not match the hash recorded/);
      await rm(victim);
      const missing = await run('backup.mjs', ['--env-file', envFile, '--out-dir', join(work, 'bad-src')]);
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /recorded document\(s\) are missing/);
      assert.deepEqual((await readdir(join(work, 'bad-src'))).filter((name) => !name.startsWith('career-key-')), []);
    } finally { await writeFile(victim, original, { mode: 0o600 }); }
  });

  test('verify-only checks integrity, and authenticity with the key', async () => {
    const withKey = await run('restore.mjs', ['--verify-only', '--archive', archive, '--key-file', keyFile]);
    assert.equal(withKey.code, 0, withKey.all);
    assert.match(withKey.stdout, /authentic backup/);
    const withoutKey = await run('restore.mjs', ['--verify-only', '--archive', archive]);
    assert.equal(withoutKey.code, 0, withoutKey.all);
    assert.match(withoutKey.all, /only integrity is checked/);
  });

  test('isolated restore creates a new database and folder with safe defaults', async () => {
    const database = `${tag}_dst`;
    databases.add(database);
    const target = join(work, 'restored $workspace');
    const sourceBefore = (await query(sourceDb, 'select count(*)::int as n from boards where enabled')).rows[0].n;
    const result = await run('restore.mjs', ['--archive', archive, '--key-file', keyFile, '--target', target, '--database', database, '--web-port', '3190', '--api-port', '3191', '--env-file', envFile], restoreEnv());
    assert.equal(result.code, 0, result.all);
    assertNoSecrets(result.all);
    assert.match(result.stdout, /Isolated restore completed/);
    assert.match(result.all, /1 application\(s\) in IN_PROGRESS\/UNKNOWN/);

    // Source untouched.
    assert.equal((await query(sourceDb, 'select count(*)::int as n from boards where enabled')).rows[0].n, sourceBefore);
    assert.equal(sourceBefore, 1);
    // Same data, safe defaults.
    for (const table of ['workspaces', 'profile_facts', 'boards', 'jobs', 'applications', 'application_events', 'document_versions']) {
      assert.deepEqual((await query(database, `select count(*)::int as n from ${table}`)).rows, (await query(sourceDb, `select count(*)::int as n from ${table}`)).rows, table);
    }
    assert.equal((await query(database, `select count(*)::int as n from boards where enabled or permission_status <> 'UNKNOWN'`)).rows[0].n, 0);
    assert.equal((await query(database, `select count(*)::int as n from source_policy_reviews where permission_status <> 'UNKNOWN'`)).rows[0].n, 0);
    assert.equal((await query(database, 'select count(*)::int as n from workspaces where discovery_enabled')).rows[0].n, 0);
    assert.equal((await query(database, 'select count(*)::int as n from search_profiles where enabled')).rows[0].n, 0);
    assert.equal((await query(database, 'select count(*)::int as n from drizzle.__drizzle_migrations')).rows[0].n, 8);
    assert.equal((await query(database, `select statement from profile_facts where kind = 'skill'`)).rows[0].statement, 'Builds fictional test fixtures');

    assert.equal((await query(database, 'select status from assisted_attempts')).rows[0].status, 'UNKNOWN');
    assert.equal((await query(sourceDb, 'select status from assisted_attempts')).rows[0].status, 'HANDED_OFF');
    // New installation folder.
    assert.equal(await mode(target), 0o700);
    assert.equal(await mode(join(target, '.env')), 0o600);
    assert.equal(await mode(join(target, 'data')), 0o700);
    assert.equal(await mode(join(target, 'data', 'setup-token')), 0o600);
    const envBytes = await readFile(join(target, '.env'), 'utf8');
    const { parseEnv } = await import('../lib/local-env.mjs');
    const env = parseEnv(envBytes);
    const dotenv = createRequire(join(root, 'apps/api/package.json'))('dotenv');
    assert.equal(env.FILES_LOCAL_PATH, await realpath(join(target, 'data/files')));
    assert.equal(dotenv.parse(envBytes).FILES_LOCAL_PATH, env.FILES_LOCAL_PATH, 'Launcher and API read the same literal path');
    assert.equal(env.APP_ENCRYPTION_KEY, secrets.encryptionKey);
    assert.ok(env.APP_SESSION_SECRET.length >= 32 && env.APP_SESSION_SECRET !== secrets.sessionSecret, 'fresh session secret');
    assert.equal(new URL(env.DATABASE_URL).pathname, `/${database}`);
    assert.equal(env.WEB_ORIGIN, 'http://127.0.0.1:3190');
    assert.equal(env.API_PORT, '3191');
    for (const flag of ['APPLICATION_WRITES_ENABLED', 'AUTOMATION_SUBMIT_ENABLED', 'EMAIL_INTEGRATION_ENABLED']) assert.equal(env[flag], 'false');
    assert.equal(env.AI_PROVIDER, 'none');
    assert.equal(env.FILES_LOCAL_PATH, join(await realpath(target), 'data', 'files')); // symlinks resolved (macOS /var -> /private/var)
    for (const document of documents) {
      const file = join(target, 'data', 'files', document.storagePath);
      assert.equal(sha(await readFile(file)), document.sha256);
      assert.equal(await mode(file), 0o600);
    }
    assert.ok(!(await readdir(target)).some((name) => name.startsWith('.staging')));
    const report = JSON.parse(await readFile(join(target, 'restore-report.json'), 'utf8'));
    assert.equal(report.sanitised.boardsDisabled, 1);
    assert.equal(report.sanitised.reviewPermissionsReset, 1);
    assert.equal(report.documentsVerified, 3);
    assertNoSecrets(JSON.stringify(report));
  });

  describe('rejections leave nothing behind', () => {
    const attempt = async (archivePath, extra = [], { key = keyFile, env = restoreEnv() } = {}) => {
      const database = `${tag}_r${randomBytes(3).toString('hex')}`;
      databases.add(database);
      const target = join(work, `target-${randomBytes(3).toString('hex')}`);
      const result = await run('restore.mjs', ['--archive', archivePath, '--key-file', key, '--target', target, '--database', database, '--env-file', envFile, ...extra], env);
      assert.equal(result.code, 1, result.all);
      assertNoSecrets(result.all);
      assert.equal(await dbExists(database), false, 'no database left');
      await assert.rejects(stat(target), 'no folder left');
      return result;
    };
    const repack = async (name, change) => {
      const dir = await mkdtemp(join(work, 'repack-'));
      const entries = await extractArchive(archive, dir);
      const list = [];
      for (const [entryName, entry] of entries) list.push({ name: entryName, buffer: await readFile(entry.path) });
      await change(list);
      const out = join(work, name);
      await writeArchive(out, list);
      return out;
    };

    test('a modified document is rejected by checksum', async () => {
      const tampered = await repack('tampered-doc.tar', (list) => { const doc = list.find((entry) => entry.name.endsWith('.pdf')); doc.buffer[20] ^= 0xff; });
      const verify = await run('restore.mjs', ['--verify-only', '--archive', tampered]);
      assert.equal(verify.code, 1);
      assert.match(verify.stderr, /does not match the manifest/);
      assert.match((await attempt(tampered)).stderr, /does not match the manifest/);
    });
    test('a byte flipped in the raw archive is rejected', async () => {
      const bytes = await readFile(archive);
      bytes[bytes.indexOf('%PDF-1.4') + 30] ^= 0x01; // inside a document's data
      const flipped = join(work, 'flipped.tar');
      await writeFile(flipped, bytes);
      const result = await run('restore.mjs', ['--verify-only', '--archive', flipped, '--key-file', keyFile]);
      assert.equal(result.code, 1, result.all);
      assert.match(result.stderr, /Backup rejected/);
    });
    test('a rewritten manifest with recomputed hashes fails the HMAC', async () => {
      const forged = await repack('forged.tar', (list) => {
        const doc = list.find((entry) => entry.name.endsWith('.pdf'));
        doc.buffer = pdf('Forged content');
        const manifestEntry = list.find((entry) => entry.name === 'manifest.json');
        const manifest = JSON.parse(manifestEntry.buffer.toString('utf8'));
        const item = manifest.entries.find((entry) => entry.path === doc.name);
        item.sha256 = sha(doc.buffer);
        item.size = doc.buffer.length;
        manifest.documents.find((entry) => entry.archivePath === doc.name).sha256 = item.sha256;
        manifestEntry.buffer = Buffer.from(JSON.stringify(manifest, null, 2));
      });
      assert.equal((await run('restore.mjs', ['--verify-only', '--archive', forged])).code, 0, 'integrity alone cannot detect a forger who recomputes hashes');
      assert.match((await attempt(forged)).stderr, /invalid HMAC signature/);
    });
    test('a failure after the new database exists removes only that database and folder', async () => {
      // Correctly signed (we hold the key) but disagreeing with the dump: restore gets past CREATE DATABASE.
      const resigned = await repack('resigned.tar', (list) => {
        const manifestEntry = list.find((entry) => entry.name === 'manifest.json');
        const manifest = JSON.parse(manifestEntry.buffer.toString('utf8'));
        manifest.tables['public.workspaces'] += 1;
        manifestEntry.buffer = Buffer.from(JSON.stringify(manifest, null, 2));
        list.find((entry) => entry.name === 'manifest.hmac').buffer = Buffer.from(manifestMac(secrets.encryptionKey, manifestEntry.buffer));
      });
      const result = await attempt(resigned);
      assert.match(result.stderr, /Restored row counts do not match the manifest \(public\.workspaces\)/);
      assert.match(result.stderr, /new database and folder created by this attempt were removed/);
      assert.equal(await dbExists(`${tag}_dst`), true, 'the earlier restored database is untouched');
    });
    test('a different key is refused', async () => {
      const otherKey = join(work, 'other-key.json');
      await writeFile(otherKey, keyFileContent(randomBytes(32).toString('base64')), { mode: 0o600 });
      assert.match((await attempt(archive, [], { key: otherKey })).stderr, /not the key of the installation/);
    });
    test('path traversal and symlink entries are refused before anything is written', async () => {
      const good = await readFile(archive);
      const evil = Buffer.concat([buildHeader('career-backup/../../escaped.txt', 4), Buffer.from('evil'.padEnd(512, '\0')), good]);
      const evilPath = join(work, 'traversal.tar');
      await writeFile(evilPath, evil);
      assert.match((await attempt(evilPath)).stderr, /Path not allowed|escapes/);
      await assert.rejects(stat(join(work, 'escaped.txt')));
      await assert.rejects(stat(resolve(work, '..', 'escaped.txt')));
      const link = Buffer.concat([buildHeader('career-backup/files/x', 0, { type: '2', linkname: '/etc/passwd' }), good]);
      const linkPath = join(work, 'symlink.tar');
      await writeFile(linkPath, link);
      assert.match((await attempt(linkPath)).stderr, /symlink/);
    });
    test('a truncated archive is refused', async () => {
      const bytes = await readFile(archive);
      const cut = join(work, 'cut.tar');
      await writeFile(cut, bytes.subarray(0, Math.floor(bytes.length / 2 / 512) * 512));
      assert.match((await attempt(cut)).stderr, /incomplete/);
    });
    test('an existing database is never written to', async () => {
      const target = join(work, 'target-existing-db');
      const before = (await query(sourceDb, 'select count(*)::int as n from workspaces')).rows[0].n;
      const result = await run('restore.mjs', ['--archive', archive, '--key-file', keyFile, '--target', target, '--database', `${tag}_dst`, '--env-file', envFile], restoreEnv());
      assert.equal(result.code, 1);
      assert.match(result.stderr, /already exists; restore never writes into an existing database/);
      await assert.rejects(stat(target));
      assert.equal(await dbExists(`${tag}_dst`), true, 'the existing database was not dropped');
      assert.equal((await query(sourceDb, 'select count(*)::int as n from workspaces')).rows[0].n, before);
    });
    test('the live database name, an existing folder and a folder inside the project are refused', async () => {
      const live = await run('restore.mjs', ['--archive', archive, '--key-file', keyFile, '--target', join(work, 'x1'), '--database', sourceDb, '--env-file', envFile], restoreEnv());
      assert.equal(live.code, 1);
      assert.match(live.stderr, /is the live database/);
      const existing = await run('restore.mjs', ['--archive', archive, '--key-file', keyFile, '--target', backupDir, '--env-file', envFile], restoreEnv());
      assert.equal(existing.code, 1);
      assert.match(existing.stderr, /target folder already exists/);
      const inside = await run('restore.mjs', ['--archive', archive, '--key-file', keyFile, '--target', join(root, 'restore-here'), '--env-file', envFile], restoreEnv());
      assert.equal(inside.code, 1);
      assert.match(inside.stderr, /inside the project/);
      await assert.rejects(stat(join(root, 'restore-here')));
    });
    test('a missing admin connection is explained, not guessed', async () => {
      const result = await run('restore.mjs', ['--archive', archive, '--key-file', keyFile, '--target', join(work, 'x2'), '--env-file', envFile], { CAREER_RESTORE_ADMIN_URL: '', CAREER_RESTORE_APP_URL: appUrl });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /CAREER_RESTORE_ADMIN_URL is missing/);
    });
  });
});
