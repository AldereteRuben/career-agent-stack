import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { test } from 'node:test';
import { registerRestoreRoutes } from '../src/restore-routes.js';

const validSummary = {
  valid: true, encrypted: true, authenticated: true, createdAt: '2026-10-18T12:00:00.000Z', appVersion: '0.9.2',
  postgresVersion: '17', tableCount: 3, rowCount: 8, documentCount: 1, migrationCount: 4, pendingMigrations: 0,
};

test('restore uploads stream to private staging and verification is scoped to its workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-restore-routes-'));
  const data = join(root, 'data');
  const app = Fastify({ logger: false });
  const restores = registerRestoreRoutes(app, (request) => String(request.headers['x-workspace'] ?? 'default'), {
    root, data, appDatabase: 'postgresql://career@127.0.0.1:5432/career', maxUploadBytes: 64,
    run: async (args) => {
      assert.deepEqual(args.slice(0, 2), ['--verify-only', '--json']);
      return { stdout: `${JSON.stringify(validSummary)}\n`, stderr: '' };
    },
  });
  try {
    await app.ready();
    const created = await app.inject({ method: 'POST', url: '/api/v1/backups/restore', headers: { 'x-workspace': 'one' } });
    assert.equal(created.statusCode, 201);
    const id = created.json().id as string;
    assert.equal(restores.isRunning(), true);

    const archive = Buffer.from('synthetic encrypted backup');
    const firstUpload = await app.inject({ method: 'PUT', url: `/api/v1/backups/restore/${id}/archive`, headers: { 'x-workspace': 'one', 'content-type': 'application/octet-stream' }, payload: archive });
    assert.equal(firstUpload.statusCode, 201);
    const duplicate = await app.inject({ method: 'PUT', url: `/api/v1/backups/restore/${id}/archive`, headers: { 'x-workspace': 'one', 'content-type': 'application/octet-stream' }, payload: Buffer.from('replacement') });
    assert.equal(duplicate.statusCode, 409);
    assert.deepEqual(await readFile(join(data, 'restore-staging', id, 'backup.tar.age')), archive, 'a duplicate request must not delete the original staged file');

    const wrongWorkspace = await app.inject({ method: 'GET', url: '/api/v1/backups/restore/current', headers: { 'x-workspace': 'two' } });
    assert.equal(wrongWorkspace.json().state, 'idle');
    await app.inject({ method: 'PUT', url: `/api/v1/backups/restore/${id}/key`, headers: { 'x-workspace': 'one', 'content-type': 'application/octet-stream' }, payload: Buffer.from('synthetic recovery key') });
    const verify = await app.inject({ method: 'POST', url: `/api/v1/backups/restore/${id}/verify`, headers: { 'x-workspace': 'one' } });
    assert.equal(verify.statusCode, 202);
    let current = verify.json();
    for (let attempt = 0; attempt < 20 && current.state === 'verifying'; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      current = (await app.inject({ method: 'GET', url: '/api/v1/backups/restore/current', headers: { 'x-workspace': 'one' } })).json();
    }
    assert.equal(current.state, 'verified');
    assert.equal(current.canRestore, false, 'restore availability must not reveal or fabricate admin credentials');
    assert.deepEqual(current.summary, validSummary);
    assert.equal(restores.isRunning(), true);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('restore upload size is enforced while streaming and failed content is removed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-restore-size-'));
  const app = Fastify({ logger: false });
  registerRestoreRoutes(app, () => 'workspace', { root, data: join(root, 'data'), appDatabase: 'postgresql://career@127.0.0.1:5432/career', maxUploadBytes: 4, run: async () => ({ stdout: '', stderr: '' }) });
  try {
    await app.ready();
    const created = await app.inject({ method: 'POST', url: '/api/v1/backups/restore' });
    const id = created.json().id as string;
    const upload = await app.inject({ method: 'PUT', url: `/api/v1/backups/restore/${id}/archive`, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('too large') });
    assert.equal(upload.statusCode, 413);
    const current = await app.inject({ method: 'GET', url: '/api/v1/backups/restore/current' });
    assert.equal(current.json().archiveUploaded, false);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('restore accepts backups above Fastify default body limit and lets the workspace owner cancel staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-restore-large-'));
  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  registerRestoreRoutes(app, (request) => String(request.headers['x-workspace'] ?? 'default'), {
    root, data: join(root, 'data'), appDatabase: 'postgresql://career@127.0.0.1:5432/career', maxUploadBytes: 1_500_000,
    run: async () => ({ stdout: '', stderr: '' }),
  });
  try {
    await app.ready();
    const created = await app.inject({ method: 'POST', url: '/api/v1/backups/restore', headers: { 'x-workspace': 'owner' } });
    const id = created.json().id as string;
    const upload = await app.inject({ method: 'PUT', url: `/api/v1/backups/restore/${id}/archive`, headers: { 'x-workspace': 'owner', 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(1_000_100, 1) });
    assert.equal(upload.statusCode, 201);
    const otherWorkspace = await app.inject({ method: 'DELETE', url: `/api/v1/backups/restore/${id}`, headers: { 'x-workspace': 'other' } });
    assert.equal(otherWorkspace.statusCode, 409);
    const cancelled = await app.inject({ method: 'DELETE', url: `/api/v1/backups/restore/${id}`, headers: { 'x-workspace': 'owner' } });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().cancelled, true);
    const current = await app.inject({ method: 'GET', url: '/api/v1/backups/restore/current', headers: { 'x-workspace': 'owner' } });
    assert.equal(current.json().state, 'idle');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('restore creates a missing private destination parent before invoking the isolated restore tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-restore-parent-'));
  const data = join(root, 'data');
  const restoreHome = join(root, 'new-home');
  const app = Fastify({ logger: false });
  registerRestoreRoutes(app, () => 'workspace', {
    root, data, restoreParent: restoreHome, appDatabase: 'postgresql://career@127.0.0.1:5432/career', adminUrl: 'postgresql://admin@127.0.0.1:5432/postgres',
    run: async (args) => {
      if (args.includes('--verify-only')) return { stdout: `${JSON.stringify(validSummary)}\n`, stderr: '' };
      const parent = join(restoreHome, 'Career Stack Restored');
      const info = await stat(parent);
      if (process.platform !== 'win32') assert.equal(info.mode & 0o077, 0);
      return { stdout: '', stderr: '' };
    },
  });
  try {
    await app.ready();
    const created = await app.inject({ method: 'POST', url: '/api/v1/backups/restore' });
    const id = created.json().id as string;
    await app.inject({ method: 'PUT', url: `/api/v1/backups/restore/${id}/archive`, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('encrypted backup') });
    await app.inject({ method: 'PUT', url: `/api/v1/backups/restore/${id}/key`, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('recovery key') });
    await app.inject({ method: 'POST', url: `/api/v1/backups/restore/${id}/verify` });
    let current = (await app.inject({ method: 'GET', url: '/api/v1/backups/restore/current' })).json();
    for (let attempt = 0; attempt < 20 && current.state === 'verifying'; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      current = (await app.inject({ method: 'GET', url: '/api/v1/backups/restore/current' })).json();
    }
    assert.equal(current.state, 'verified');
    const restore = await app.inject({ method: 'POST', url: `/api/v1/backups/restore/${id}/restore`, payload: { confirmed: true } });
    assert.equal(restore.statusCode, 202);
    current = restore.json();
    for (let attempt = 0; attempt < 100 && current.state === 'restoring'; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      current = (await app.inject({ method: 'GET', url: '/api/v1/backups/restore/current' })).json();
    }
    assert.equal(current.state, 'restored');
    assert.equal(await stat(join(restoreHome, 'Career Stack Restored', id)).then((info) => info.isDirectory()), true);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
