// pnpm run uninstall (ADR 020): which folders may be deleted, the progress file and the identity of an installation.
// Fictional temporary folders only; no database. Runs on Linux, macOS and Windows.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { parseIcacls } from '../lib/backup-crypto.mjs';
import { RESERVED, checkDeletablePath, identityOf, installMark, measure, progressPath, readProgress, restoreMark, writeProgress } from '../lib/uninstall-core.mjs';

async function installation(run) {
  const root = await mkdtemp(join(tmpdir(), 'career-uninstall-test-'));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('the identity comes from CAREER_RESTORE_ID or CAREER_INSTALL_ID, and only bootstrap-created databases are managed', () => {
  assert.deepEqual(identityOf({ CAREER_INSTALL_ID: 'abc123', CAREER_DATABASE_MODE: 'created' }), { kind: 'install', id: 'abc123', mark: installMark('abc123'), managed: true });
  assert.equal(identityOf({ CAREER_INSTALL_ID: 'abc123', CAREER_DATABASE_MODE: 'provided' }).managed, false);
  assert.equal(identityOf({ CAREER_INSTALL_ID: 'abc123' }).managed, false, 'Without a mode nothing proves bootstrap created the database');
  assert.deepEqual(identityOf({ CAREER_RESTORE_ID: 'r1', CAREER_INSTALL_ID: 'abc123' }), { kind: 'restore', id: 'r1', mark: restoreMark('r1'), managed: true });
  assert.equal(identityOf({}), null);
  assert.equal(identityOf({ CAREER_INSTALL_ID: 'Bad id; drop' }), null);
  assert.equal(installMark('abc123'), 'career-agent-stack install abc123', 'Same mark bootstrap writes');
});

test('data folders inside the installation are accepted, existing or not', () => installation(async (root) => {
  await mkdir(join(root, 'data', 'files'), { recursive: true });
  const data = await checkDeletablePath(join(root, 'data'), { root });
  assert.equal(data.ok, true);
  assert.equal(data.exists, true);
  assert.equal((await checkDeletablePath(join(root, 'data', 'files'), { root })).ok, true, 'Documents inside the data folder');
  assert.deepEqual((await checkDeletablePath(join(root, 'elsewhere'), { root })).exists, false);
}));

test('the installation folder, paths outside it, reserved paths and the backup folder are refused', () => installation(async (root) => {
  const refused = async (path, why) => assert.equal((await checkDeletablePath(path, { root })).ok, false, why);
  await refused(root, 'The installation folder itself');
  await refused(join(root, '..'), 'An ancestor');
  await refused(tmpdir(), 'Outside');
  for (const name of RESERVED) await refused(join(root, name), name);
  await refused(join(root, 'node_modules', 'data'), 'Inside a reserved path');
  await refused(join(root, 'backups', 'data'), 'Inside the backup folder');
  await refused(join(root, 'apps', '..', '..'), 'Escapes with ..');
  const custom = await checkDeletablePath(join(root, 'mydata'), { root, backupDir: join(root, 'mydata', 'copies') });
  assert.equal(custom.ok, false, 'A data folder that contains the backup folder');
}));

test('a symbolic link anywhere in the path is refused, including the configured path itself', { skip: process.platform === 'win32' && 'creating symbolic links needs extra rights on Windows' }, () => installation(async (root) => {
  const outside = await mkdtemp(join(tmpdir(), 'career-uninstall-outside-'));
  try {
    await symlink(outside, join(root, 'data'));
    assert.equal((await checkDeletablePath(join(root, 'data'), { root })).ok, false, 'The data folder is a link');
    await mkdir(join(root, 'real'));
    await symlink(outside, join(root, 'real', 'files'));
    assert.equal((await checkDeletablePath(join(root, 'real', 'files'), { root })).ok, false, 'The last component is a link');
    await symlink(join(root, 'real'), join(root, 'via'));
    assert.equal((await checkDeletablePath(join(root, 'via', 'files'), { root })).ok, false, 'A middle component is a link');
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

test('an installation folder reached through a link is compared by its real path', { skip: process.platform === 'win32' && 'creating symbolic links needs extra rights on Windows' }, () => installation(async (root) => {
  await mkdir(join(root, 'real', 'data'), { recursive: true });
  await symlink(join(root, 'real'), join(root, 'alias'));
  const checked = await checkDeletablePath(join(root, 'alias', 'data'), { root: join(root, 'alias') });
  assert.equal(checked.ok, true);
  assert.equal(checked.exists, true);
}));

test('sizes are measured without following links', () => installation(async (root) => {
  await mkdir(join(root, 'data', 'files'), { recursive: true });
  await writeFile(join(root, 'data', 'a.txt'), 'fictional');
  await writeFile(join(root, 'data', 'files', 'b.pdf'), Buffer.alloc(100));
  assert.deepEqual(await measure(join(root, 'data')), { files: 2, bytes: 109 });
  assert.deepEqual(await measure(join(root, 'missing')), { files: 0, bytes: 0 });
}));

test('the progress file is private, round-trips and refuses anything that is not ours', () => installation(async (root) => {
  assert.equal(await readProgress(root), null);
  const progress = { format: 'career-agent-stack-uninstall', version: 1, kind: 'install', id: 'abc123', folder: root, database: { name: 'career_abc123', owner: 'career_abc123', server: '127.0.0.1:5432' }, role: 'career_abc123', paths: [join(root, 'data')], envFiles: [], done: ['database'] };
  await writeProgress(root, progress);
  assert.deepEqual(await readProgress(root), progress);
  assert.equal((await readFile(progressPath(root), 'utf8')).includes('postgresql://'), false, 'No connection string');
  if (process.platform === 'win32') {
    const principals = parseIcacls(execFileSync('icacls', [progressPath(root)], { encoding: 'utf8' }), progressPath(root));
    assert.deepEqual(principals.map((name) => name.toLowerCase()), [execFileSync('whoami', { encoding: 'utf8' }).trim().toLowerCase()], 'Only the current user');
  } else {
    assert.equal((await stat(progressPath(root))).mode & 0o777, 0o600);
  }
  await writeFile(progressPath(root), JSON.stringify({ format: 'something-else', version: 1, kind: 'install', id: 'abc123', done: [] }));
  await assert.rejects(readProgress(root), /not a valid uninstall progress file/);
  await writeFile(progressPath(root), 'not json');
  await assert.rejects(readProgress(root), /not a valid uninstall progress file/);
}));
