import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { registerBackupRoutes, backupRunner, type BackupRunner } from '../src/backup-routes.js';

async function fixture(run: BackupRunner) {
  const data = await mkdtemp(join(tmpdir(), 'career-backup-api-'));
  const app = Fastify();
  app.addHook('onRequest', async (request, reply) => {
    if (!request.headers.authorization) return reply.code(401).send({ error: 'SESSION_REQUIRED' });
  });
  registerBackupRoutes(app, (request) => request.headers.authorization!, { root: data, data, files: join(data, 'files'), database: 'unused', key: 'unused' }, run);
  const request = (method: 'GET' | 'POST', url: string, workspace = 'one') => app.inject({ method, url, headers: { authorization: workspace } });
  const wait = async () => {
    for (let i = 0; i < 100; i++) {
      const job = (await request('GET', '/api/v1/backups/current')).json();
      if (job.state !== 'running') return job;
      await delay(10);
    }
    throw new Error('Backup did not finish');
  };
  return { app, data, request, wait, close: async () => { await app.close(); await rm(data, { recursive: true, force: true }); } };
}
const artifacts: BackupRunner = async (dir) => {
  await mkdir(join(dir, 'keys'));
  await writeFile(join(dir, 'career-backup-20261003T000000Z.tar.age'), 'archive-fixture');
  await writeFile(join(dir, 'career-backup-20261003T000000Z.tar.age.sha256'), 'checksum-fixture');
  await writeFile(join(dir, 'keys/career-key-abcdef123456.json'), 'key-fixture');
};

test('backup downloads are authenticated, workspace scoped, allowlisted and not cached', async () => {
  const f = await fixture(artifacts);
  try {
    assert.equal((await f.app.inject('/api/v1/backups/current')).statusCode, 401);
    const start = await f.request('POST', '/api/v1/backups'); assert.equal(start.statusCode, 202);
    const job = await f.wait(); assert.equal(job.state, 'ready'); assert.equal(job.directory, undefined); assert.equal(job.workspace, undefined);
    for (const artifact of ['archive', 'key', 'checksum']) {
      const result = await f.request('GET', `/api/v1/backups/${job.id}/${artifact}`);
      assert.equal(result.statusCode, 200); assert.equal(result.headers['cache-control'], 'no-store');
      assert.match(String(result.headers['content-disposition']), /^attachment;/);
      assert.equal((await f.request('GET', `/api/v1/backups/${job.id}/${artifact}`, 'other')).statusCode, 404);
    }
    assert.equal((await f.request('GET', '/api/v1/backups/current', 'other')).json().state, 'idle');
    for (const artifact of ['.backup-env', 'constructor', 'toString', '%2e%2e']) assert.equal((await f.request('GET', `/api/v1/backups/${job.id}/${artifact}`)).statusCode, 404);
    assert.equal((await f.request('GET', '/api/v1/backups/missing/archive')).statusCode, 404);
  } finally { await f.close(); }
});
test('only one backup runs at a time; navigating back can read progress', async () => {
  let finish!: () => void; const blocked = new Promise<void>((resolve) => { finish = resolve; });
  const f = await fixture(async (dir) => { await blocked; await artifacts(dir, new AbortController().signal); });
  try {
    await f.request('POST', '/api/v1/backups');
    assert.equal((await f.request('GET', '/api/v1/backups/current')).json().state, 'running');
    assert.equal((await f.request('POST', '/api/v1/backups')).statusCode, 409);
    finish(); assert.equal((await f.wait()).state, 'ready');
  } finally { finish(); await f.close(); }
});
test('failure never exposes credentials or partial artifacts and allows retry', async () => {
  let runs = 0;
  const f = await fixture(async (dir, signal) => { if (!runs++) throw new Error('secret-password'); await artifacts(dir, signal); });
  try {
    await f.request('POST', '/api/v1/backups'); const failed = await f.wait();
    assert.equal(failed.state, 'failed'); assert.ok(!JSON.stringify(failed).includes('secret-password'));
    assert.deepEqual(await readdir(join(f.data, 'backups')), []);
    assert.equal((await f.request('GET', `/api/v1/backups/${failed.id}/archive`)).statusCode, 404);
    await f.request('POST', '/api/v1/backups'); assert.equal((await f.wait()).state, 'ready');
  } finally { await f.close(); }
});
test('an unencrypted archive is never offered for download', async () => {
  const f = await fixture(async (dir) => {
    await mkdir(join(dir, 'keys'));
    await writeFile(join(dir, 'career-backup-20261003T000000Z.tar'), 'plain-archive-fixture');
    await writeFile(join(dir, 'career-backup-20261003T000000Z.tar.sha256'), 'checksum-fixture');
    await writeFile(join(dir, 'keys/career-key-abcdef123456.json'), 'key-fixture');
  });
  try {
    await f.request('POST', '/api/v1/backups'); const job = await f.wait();
    assert.equal(job.state, 'failed');
    assert.equal((await f.request('GET', `/api/v1/backups/${job.id}/archive`)).statusCode, 404);
  } finally { await f.close(); }
});
test('incomplete output is a failed backup', async () => {
  const f = await fixture(async () => {});
  try { await f.request('POST', '/api/v1/backups'); assert.equal((await f.wait()).state, 'failed'); }
  finally { await f.close(); }
});
test('runner uses explicit API configuration, separate key path, and removes temporary secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-backup-runner-')); const dir = join(root, 'output');
  try {
    await mkdir(join(root, 'scripts')); await mkdir(dir);
    await writeFile(join(root, '.env'), 'DATABASE_URL=WRONG_LIVE_DATABASE');
    await writeFile(join(root, 'scripts/backup.mjs'), `import {readFile,writeFile} from 'node:fs/promises'; const args=process.argv.slice(2); const text=await readFile(args[args.indexOf('--env-file')+1],'utf8'); if(!text.includes('isolated_database')||text.includes('WRONG_LIVE'))process.exit(2); await writeFile(args[args.indexOf('--out-dir')+1]+'/used-explicit-config','yes');`);
    await backupRunner({ root, data: root, files: join(root, 'isolated files'), database: 'postgresql://localhost/isolated_database', key: 'x'.repeat(32) })(dir, new AbortController().signal);
    assert.equal(await readFile(join(dir, 'used-explicit-config'), 'utf8'), 'yes');
    assert.ok(!(await readdir(dir)).includes('.backup-env'));
    await writeFile(join(root, 'scripts/backup.mjs'), 'process.exit(1)');
    await assert.rejects(backupRunner({ root, data: root, files: root, database: 'postgresql://localhost/isolated_database', key: 'x'.repeat(32) })(dir, new AbortController().signal));
    assert.ok(!(await readdir(dir)).includes('.backup-env'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('closing the API cancels the writer and cleans the unfinished backup', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const f = await fixture(async (_dir, signal) => {
    started();
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }));
  });
  try {
    await f.request('POST', '/api/v1/backups'); await ready;
    await f.app.close(); assert.deepEqual(await readdir(join(f.data, 'backups')), []);
  } finally { await f.close(); }
});
