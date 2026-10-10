// pnpm run uninstall (ADR 020) against DISPOSABLE PostgreSQL databases and temporary installation folders, with
// fictional data. Every role and database it creates starts with career_ut_ and is dropped at the end. It never
// reads or writes the live installation: each case runs the real script with CAREER_ENV_FILE pointing at a
// temporary .env.
//
//   CAREER_UNINSTALL_TEST_ADMIN_URL=postgresql://$USER@127.0.0.1:5432/postgres pnpm run test:uninstall
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installMark, restoreMark } from '../lib/uninstall-core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const adminUrl = process.env.CAREER_UNINSTALL_TEST_ADMIN_URL;
const { Client } = createRequire(join(root, 'packages/db/package.json'))('pg');
const exists = async (path) => { try { await lstat(path); return true; } catch { return false; } };

describe('pnpm run uninstall (disposable databases)', { skip: !adminUrl && 'set CAREER_UNINSTALL_TEST_ADMIN_URL to run' }, () => {
  let admin;
  const folders = [];
  const prefix = `career_ut_${randomBytes(3).toString('hex')}`;
  let counter = 0;

  before(async () => {
    assert.ok(['127.0.0.1', 'localhost', '::1'].includes(new URL(adminUrl).hostname), 'fixture must use loopback');
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
  });
  after(async () => {
    const { rows: databases } = await admin.query('select datname from pg_database where datname like $1', [`${prefix}%`]);
    for (const { datname } of databases) await admin.query(`drop database if exists "${datname}" with (force)`).catch(() => undefined);
    const { rows: roles } = await admin.query('select rolname from pg_roles where rolname like $1', [`${prefix}%`]);
    for (const { rolname } of roles) await admin.query(`drop owned by "${rolname}"`).catch(() => undefined);
    for (const { rolname } of roles) await admin.query(`drop role if exists "${rolname}"`).catch(() => undefined);
    await admin.end();
    for (const folder of folders) await rm(folder, { recursive: true, force: true });
  });

  const url = (role, password, database) => { const u = new URL(adminUrl); u.username = role; u.password = password; u.pathname = `/${database}`; return u.toString(); };

  /** A bootstrap-like installation: marked role and database, a .env, data with fictional documents, and backups. */
  async function makeInstallation({ mode = 'created', creator = admin, data } = {}) {
    const id = `${prefix.slice('career_'.length)}_${counter += 1}`;
    const name = `career_${id}`;
    const password = randomBytes(12).toString('hex');
    await creator.query(`create role "${name}" login password '${password}'`);
    await creator.query(`comment on role "${name}" is '${installMark(id)}'`);
    if (creator !== admin) await creator.query(`grant "${name}" to current_user with set true, inherit false`);
    await creator.query(`create database "${name}" owner "${name}"`);
    const comment = `comment on database "${name}" is '${installMark(id)}'`;
    if (creator === admin) await admin.query(comment);
    else { await creator.query(`set role "${name}"`); await creator.query(comment); await creator.query('reset role'); }
    const folder = await mkdtemp(join(tmpdir(), 'career-uninstall-'));
    folders.push(folder);
    const dataDir = data ?? join(folder, 'data');
    await mkdir(join(folder, 'data', 'files', 'ws'), { recursive: true });
    await writeFile(join(folder, 'data', 'files', 'ws', 'resume.pdf'), '%PDF-1.4 fictional');
    await writeFile(join(folder, 'data', 'setup-token'), 'fictional-token');
    await mkdir(join(folder, 'backups'));
    await writeFile(join(folder, 'backups', 'career-backup-20261010T000000Z.tar.age'), 'age-encryption.org/v1\nfictional');
    await writeFile(join(folder, 'backups', 'career-key-0123456789abcdef.json'), '{}');
    const env = [
      `DATABASE_URL=${url(name, password, name)}`, `CAREER_INSTALL_ID=${id}`, `CAREER_DATABASE_MODE=${mode}`,
      `DATA_LOCAL_PATH=${dataDir}`, `FILES_LOCAL_PATH=${join(folder, 'data', 'files')}`, 'APP_ENCRYPTION_KEY=fictional-key-not-used-for-anything-0123456789',
    ].join('\n');
    await writeFile(join(folder, '.env'), `${env}\n`, { mode: 0o600 });
    return { id, name, password, folder };
  }

  /** A restored installation of `source`: its own marked database, owned by the source's role. */
  async function makeRestore(source) {
    const restoreId = randomBytes(5).toString('hex');
    const database = `${prefix}_r${counter += 1}`;
    await admin.query(`create database "${database}" owner "${source.name}"`);
    await admin.query(`comment on database "${database}" is '${restoreMark(restoreId)}'`);
    const folder = await mkdtemp(join(tmpdir(), 'career-restored-'));
    folders.push(folder);
    await mkdir(join(folder, 'data', 'files'), { recursive: true });
    await writeFile(join(folder, 'restore-report.json'), '{}');
    await writeFile(join(folder, '.env'), [
      `DATABASE_URL=${url(source.name, source.password, database)}`, `CAREER_RESTORE_ID=${restoreId}`,
      `DATA_LOCAL_PATH=${join(folder, 'data')}`, `FILES_LOCAL_PATH=${join(folder, 'data', 'files')}`,
    ].join('\n'), { mode: 0o600 });
    return { id: restoreId, database, folder };
  }

  const uninstall = (folder, args = [], adminOverride = adminUrl) => new Promise((done) => {
    execFile(process.execPath, [join(root, 'scripts/uninstall.mjs'), ...args], {
      cwd: root, env: { ...process.env, CAREER_ENV_FILE: join(folder, '.env'), CAREER_ADMIN_DATABASE_URL: adminOverride, CAREER_LANG: 'en' },
    }, (error, stdout, stderr) => done({ code: error ? error.code : 0, out: `${stdout}\n${stderr}` }));
  });
  const databaseExists = async (name) => (await admin.query('select 1 from pg_database where datname = $1', [name])).rowCount === 1;
  const roleExists = async (name) => (await admin.query('select 1 from pg_roles where rolname = $1', [name])).rowCount === 1;

  test('without --confirm it only shows the plan', async () => {
    const install = await makeInstallation();
    const result = await uninstall(install.folder);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, new RegExp(`Database "${install.name}"`));
    assert.match(result.out, /nothing has been changed/);
    assert.match(result.out, new RegExp(`--confirm ${install.id}`));
    assert.ok(await databaseExists(install.name));
    assert.ok(await exists(join(install.folder, 'data', 'files', 'ws', 'resume.pdf')));
  });

  test('a wrong --confirm changes nothing', async () => {
    const install = await makeInstallation();
    const result = await uninstall(install.folder, ['--confirm', 'someone_else']);
    assert.equal(result.code, 1);
    assert.match(result.out, /does not match/);
    assert.ok(await databaseExists(install.name));
    assert.ok(await exists(join(install.folder, '.env')));
  });

  test('a confirmed run drops this database and role, deletes data and .env, keeps backups and other databases', async () => {
    const install = await makeInstallation();
    const other = await makeInstallation();
    const result = await uninstall(install.folder, ['--confirm', install.id]);
    assert.equal(result.code, 0, result.out);
    assert.equal(await databaseExists(install.name), false);
    assert.equal(await roleExists(install.name), false);
    assert.equal(await exists(join(install.folder, 'data')), false);
    assert.equal(await exists(join(install.folder, '.env')), false);
    assert.equal(await exists(join(install.folder, '.uninstall-progress.json')), false);
    assert.deepEqual((await readdir(join(install.folder, 'backups'))).sort(), ['career-backup-20261010T000000Z.tar.age', 'career-key-0123456789abcdef.json']);
    assert.match(result.out, /backups in backups\/ are kept/);
    assert.ok(await databaseExists(other.name), 'Another installation on the same server is untouched');
    assert.ok(await roleExists(other.name));
  });

  test('--include-backups also deletes the backups and their key files', async () => {
    const install = await makeInstallation();
    const result = await uninstall(install.folder, ['--confirm', install.id, '--include-backups']);
    assert.equal(result.code, 0, result.out);
    assert.equal(await exists(join(install.folder, 'backups')), false);
  });

  test('a database or role without this installation\'s mark is never dropped', async () => {
    const install = await makeInstallation();
    await admin.query(`comment on database "${install.name}" is 'career-agent-stack install somebody_else'`);
    const result = await uninstall(install.folder, ['--confirm', install.id]);
    assert.equal(result.code, 1);
    assert.match(result.out, /does not carry this installation's mark/);
    assert.match(result.out, /No data was deleted or modified/);
    assert.ok(await databaseExists(install.name));
    assert.ok(await exists(join(install.folder, 'data')));

    const unmarkedRole = await makeInstallation();
    await admin.query(`comment on role "${unmarkedRole.name}" is null`);
    const second = await uninstall(unmarkedRole.folder, ['--confirm', unmarkedRole.id]);
    assert.equal(second.code, 1);
    assert.ok(await databaseExists(unmarkedRole.name), 'The marked database is not dropped either: the check runs before anything');
  });

  test('a provided database is refused unless --skip-database, which keeps it and deletes the rest', async () => {
    const install = await makeInstallation({ mode: 'provided' });
    const refused = await uninstall(install.folder, ['--confirm', install.id]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /cannot be proven/);
    const result = await uninstall(install.folder, ['--confirm', install.id, '--skip-database']);
    assert.equal(result.code, 0, result.out);
    assert.ok(await databaseExists(install.name));
    assert.ok(await roleExists(install.name));
    assert.equal(await exists(join(install.folder, 'data')), false);
    assert.equal(await exists(join(install.folder, '.env')), false);
  });

  test('it refuses while the API or web app runs, but not because PostgreSQL runs', async () => {
    const install = await makeInstallation();
    await mkdir(join(install.folder, 'data', 'run'));
    await writeFile(join(install.folder, 'data', 'run', 'postgres.json'), JSON.stringify({ name: 'postgres', pid: process.pid }));
    const plan = await uninstall(install.folder);
    assert.equal(plan.code, 0, plan.out);
    await writeFile(join(install.folder, 'data', 'run', 'api.json'), JSON.stringify({ name: 'api', pid: process.pid }));
    const result = await uninstall(install.folder, ['--confirm', install.id]);
    assert.equal(result.code, 1);
    assert.match(result.out, /still running \(api\)/);
    assert.ok(await databaseExists(install.name));
  });

  test('a data folder outside the installation is listed and left in place', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'career-uninstall-outside-'));
    folders.push(outside);
    await writeFile(join(outside, 'keep.txt'), 'fictional');
    const install = await makeInstallation({ data: outside });
    const result = await uninstall(install.folder, ['--confirm', install.id]);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /outside the installation folder/);
    assert.ok(await exists(join(outside, 'keep.txt')));
    assert.equal(await databaseExists(install.name), false);
  });

  test('a restored installation drops its own database and keeps the original role; the original then resumes', async () => {
    const original = await makeInstallation();
    const restored = await makeRestore(original);
    // The original cannot drop its role while it still owns the restored database: the run stops after the database.
    const first = await uninstall(original.folder, ['--confirm', original.id]);
    assert.equal(first.code, 1, first.out);
    assert.match(first.out, new RegExp(`still owns other databases.*${restored.database}`));
    assert.match(first.out, /Already done: database/);
    assert.doesNotMatch(first.out, /No data was deleted or modified/);
    assert.equal(await databaseExists(original.name), false);
    assert.ok(await roleExists(original.name));
    const progress = JSON.parse(await readFile(join(original.folder, '.uninstall-progress.json'), 'utf8'));
    assert.deepEqual(progress.done, ['database']);
    assert.equal(JSON.stringify(progress).includes(original.password), false, 'The progress file never holds the password');

    const wrongKind = await uninstall(restored.folder, ['--confirm', restored.id, '--include-backups']);
    assert.equal(wrongKind.code, 1, '--include-backups belongs to the checkout');
    const restoredRun = await uninstall(restored.folder, ['--confirm', restored.id]);
    assert.equal(restoredRun.code, 0, restoredRun.out);
    assert.equal(await databaseExists(restored.database), false);
    assert.ok(await roleExists(original.name), 'The original installation\'s role is never dropped by a restore');
    assert.equal(await exists(restored.folder), false, 'The emptied restore folder is removed');

    const resumed = await uninstall(original.folder, ['--confirm', original.id]);
    assert.equal(resumed.code, 0, resumed.out);
    assert.match(resumed.out, /Resuming an interrupted uninstall/);
    assert.equal(await roleExists(original.name), false);
    assert.equal(await exists(join(original.folder, '.env')), false);
  });

  test('without a progress file a missing database is not assumed to be ours', async () => {
    const install = await makeInstallation();
    await admin.query(`drop database "${install.name}"`);
    const result = await uninstall(install.folder, ['--confirm', install.id]);
    assert.equal(result.code, 1);
    assert.match(result.out, /does not exist; without a progress file/);
    assert.ok(await roleExists(install.name));
  });

  test('a failure while deleting data resumes on the next run', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'needs POSIX permissions and a non-root user' }, async () => {
    const install = await makeInstallation();
    const locked = join(install.folder, 'data', 'locked');
    await mkdir(locked);
    await writeFile(join(locked, 'file.txt'), 'fictional');
    await chmod(locked, 0o500);
    try {
      const first = await uninstall(install.folder, ['--confirm', install.id]);
      assert.equal(first.code, 1, first.out);
      assert.match(first.out, /Already done: database, role/);
    } finally { await chmod(locked, 0o700); }
    const resumed = await uninstall(install.folder, ['--confirm', install.id]);
    assert.equal(resumed.code, 0, resumed.out);
    assert.equal(await exists(join(install.folder, 'data')), false);
    assert.equal(await exists(join(install.folder, '.env')), false);
  });

  test('a run that lost .env finishes from the progress file, and only with the matching id', async () => {
    const install = await makeInstallation();
    await admin.query(`drop database "${install.name}"`);
    await admin.query(`drop role "${install.name}"`);
    await rm(join(install.folder, 'data'), { recursive: true });
    await rm(join(install.folder, '.env'));
    await writeFile(join(install.folder, '.uninstall-progress.json'), JSON.stringify({
      format: 'career-agent-stack-uninstall', version: 1, kind: 'install', id: install.id, folder: install.folder,
      database: { name: install.name, owner: install.name, server: '127.0.0.1:5432' }, role: install.name, paths: [], envFiles: [], refused: [],
      done: ['database', 'role', 'data', 'env'],
    }), { mode: 0o600 });
    const wrong = await uninstall(install.folder, ['--confirm', 'someone_else']);
    assert.equal(wrong.code, 1);
    const result = await uninstall(install.folder, ['--confirm', install.id]);
    assert.equal(result.code, 0, result.out);
    assert.equal(await exists(join(install.folder, '.uninstall-progress.json')), false);
  });

  test('a progress file can never make it delete a path outside the installation', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'career-uninstall-victim-'));
    folders.push(outside);
    await writeFile(join(outside, 'precious.txt'), 'fictional but precious');
    const install = await makeInstallation();
    const forged = (done) => JSON.stringify({
      format: 'career-agent-stack-uninstall', version: 1, kind: 'install', id: install.id, folder: install.folder, runDir: outside,
      database: { name: install.name, owner: install.name, server: '127.0.0.1:5432' }, role: install.name,
      paths: [outside], backups: outside, envFiles: [join(outside, 'precious.txt')], refused: [], done,
    });
    // With .env present, what to delete comes from .env; the forged paths are ignored.
    await writeFile(join(install.folder, '.uninstall-progress.json'), forged([]), { mode: 0o600 });
    const withEnv = await uninstall(install.folder, ['--confirm', install.id, '--include-backups']);
    assert.equal(withEnv.code, 0, withEnv.out);
    assert.ok(await exists(join(outside, 'precious.txt')), 'Nothing outside the installation is deleted');
    assert.equal(await exists(join(install.folder, 'backups')), false, 'Its own backups/ is what --include-backups deletes');

    // Without .env, a progress file that has not finished every destructive step deletes nothing at all.
    const other = await makeInstallation();
    await rm(join(other.folder, '.env'));
    await writeFile(join(other.folder, '.uninstall-progress.json'), forged([]).replaceAll(install.folder, other.folder).replaceAll(install.id, other.id).replaceAll(install.name, other.name), { mode: 0o600 });
    const withoutEnv = await uninstall(other.folder, ['--confirm', other.id]);
    assert.equal(withoutEnv.code, 1);
    assert.match(withoutEnv.out, /does not show every step finished/);
    assert.ok(await exists(join(outside, 'precious.txt')));
    assert.ok(await databaseExists(other.name));
    assert.ok(await exists(join(other.folder, 'data')));
  });

  test('steps a progress file marks as done are still checked and carried out while their resources exist', async () => {
    const forged = (install) => JSON.stringify({
      format: 'career-agent-stack-uninstall', version: 1, kind: 'install', id: install.id, folder: install.folder,
      database: { name: install.name, owner: install.name, server: '127.0.0.1:5432' }, role: install.name, done: ['database', 'role', 'data', 'env'],
    });
    // With .env: everything still present is verified and deleted, so success is never reported with data left.
    const install = await makeInstallation();
    await writeFile(join(install.folder, '.uninstall-progress.json'), forged(install), { mode: 0o600 });
    const result = await uninstall(install.folder, ['--confirm', install.id]);
    assert.equal(result.code, 0, result.out);
    assert.equal(await databaseExists(install.name), false);
    assert.equal(await roleExists(install.name), false);
    assert.equal(await exists(join(install.folder, 'data')), false);
    assert.equal(await exists(join(install.folder, '.env')), false);

    // "Done" does not skip the ownership check either: a database with a foreign mark is still refused.
    const foreign = await makeInstallation();
    await admin.query(`comment on database "${foreign.name}" is 'career-agent-stack install somebody_else'`);
    await writeFile(join(foreign.folder, '.uninstall-progress.json'), forged(foreign), { mode: 0o600 });
    const refused = await uninstall(foreign.folder, ['--confirm', foreign.id]);
    assert.equal(refused.code, 1);
    assert.match(refused.out, /does not carry this installation's mark/);
    assert.ok(await databaseExists(foreign.name));
    assert.ok(await exists(join(foreign.folder, 'data')));

    // Without .env: a progress file claiming the database and role are gone must be true, or nothing happens.
    const lost = await makeInstallation();
    await rm(join(lost.folder, '.env'));
    await writeFile(join(lost.folder, '.uninstall-progress.json'), forged(lost), { mode: 0o600 });
    const claimed = await uninstall(lost.folder, ['--confirm', lost.id]);
    assert.equal(claimed.code, 1);
    assert.match(claimed.out, /still exist/);
    assert.doesNotMatch(claimed.out, /uninstalled/);
    assert.ok(await databaseExists(lost.name));
    assert.ok(await exists(join(lost.folder, '.uninstall-progress.json')));
  });

  test('a progress file that describes another database is refused', async () => {
    const install = await makeInstallation();
    await writeFile(join(install.folder, '.uninstall-progress.json'), JSON.stringify({
      format: 'career-agent-stack-uninstall', version: 1, kind: 'install', id: install.id, folder: install.folder,
      database: { name: 'career_someone_else', owner: 'career_someone_else', server: '127.0.0.1:5432' }, role: 'career_someone_else', done: ['database'],
    }), { mode: 0o600 });
    const result = await uninstall(install.folder, ['--confirm', install.id]);
    assert.equal(result.code, 1);
    assert.match(result.out, /describes another database or role/);
    assert.ok(await databaseExists(install.name));
  });

  test('a non-superuser administrator that created the installation can uninstall it', async () => {
    const adminRole = `${prefix}_admin`;
    const adminPassword = randomBytes(12).toString('hex');
    await admin.query(`create role "${adminRole}" login createrole createdb password '${adminPassword}'`);
    const limitedUrl = url(adminRole, adminPassword, 'postgres');
    const limited = new Client({ connectionString: limitedUrl });
    await limited.connect();
    try {
      const install = await makeInstallation({ creator: limited });
      const result = await uninstall(install.folder, ['--confirm', install.id], limitedUrl);
      assert.equal(result.code, 0, result.out);
      assert.equal(await databaseExists(install.name), false);
      assert.equal(await roleExists(install.name), false);
    } finally { await limited.end(); }
  });
});
