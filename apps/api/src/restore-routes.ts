import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createServer } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ensurePrivateDir, ensurePrivateFile } from '../../../scripts/lib/private-files.mjs';
import { redactSecrets } from './backup-routes.js';

type RestoreState = 'awaiting-files' | 'verifying' | 'verified' | 'restoring' | 'restored' | 'opening' | 'opened' | 'failed';
type RestoreSummary = { valid: true; encrypted: boolean; authenticated: boolean; createdAt: string; appVersion: string | null; postgresVersion: string; tableCount: number; rowCount: number; documentCount: number; migrationCount: number; pendingMigrations: number };
type RestoreJob = { id: string; workspace: string; state: RestoreState; directory: string; archive?: string; key?: string; summary?: RestoreSummary; target?: string; webPort?: number; apiPort?: number; uploads?: number; createdAt: string };
type RestoreCommand = (args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal) => Promise<{ stdout: string; stderr: string }>;
type RestoreOptions = { root: string; data: string; appDatabase: string; adminUrl?: string | undefined; maxUploadBytes?: number; restoreParent?: string; run?: RestoreCommand };

const maxOutput = 8_000;
const trimOutput = (value: string) => value.length > maxOutput ? value.slice(-maxOutput) : value;
const isJobId = (value: string) => /^[0-9a-f-]{36}$/i.test(value);

function runCli(root: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'scripts/restore.mjs'), ...args], { cwd: root, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], signal, windowsHide: true });
    let stdout = ''; let stderr = ''; let startError: Error | undefined;
    child.stdout?.on('data', (chunk: Buffer) => { stdout = trimOutput(stdout + chunk.toString('utf8')); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = trimOutput(stderr + chunk.toString('utf8')); });
    child.once('error', (error) => { startError = error; });
    child.once('close', (code) => {
      if (!startError && code === 0) resolve({ stdout, stderr });
      else reject(new Error(startError ? 'Restore tool could not start.' : `Restore tool exited with code ${code}.`));
    });
  });
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export function registerRestoreRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, options: RestoreOptions) {
  let current: RestoreJob | undefined;
  let creating = false;
  let controller: AbortController | undefined;
  let task: Promise<void> | undefined;
  const maxUploadBytes = options.maxUploadBytes ?? 2 * 1024 * 1024 * 1024;
  const run = options.run ?? ((args, env, signal) => runCli(options.root, args, env, signal));
  const publicJob = (job: RestoreJob | undefined) => job ? {
    id: job.id, state: job.state, createdAt: job.createdAt, summary: job.summary,
    archiveUploaded: Boolean(job.archive), keyUploaded: Boolean(job.key),
    canRestore: Boolean(options.adminUrl),
    openUrl: job.state === 'opened' && job.webPort ? `http://127.0.0.1:${job.webPort}` : undefined,
  } : { state: 'idle', canRestore: Boolean(options.adminUrl) };
  const ownedJob = (request: FastifyRequest, id: string) => current?.id === id && current.workspace === workspace(request) ? current : undefined;
  const logError = (error: unknown, job: RestoreJob) => {
    const message = error instanceof Error ? error.message : String(error);
    app.log.warn({ reason: redactSecrets(message, [options.adminUrl ?? '', options.appDatabase, job.directory, job.target ?? '']) }, 'Restore operation failed');
  };

  // The route writes the raw stream to a private file; parsing the entire upload in memory is unsafe for large backups.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));

  app.get('/api/v1/backups/restore/current', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return publicJob(current?.workspace === workspace(request) ? current : undefined);
  });

  app.post('/api/v1/backups/restore', async (request, reply) => {
    if (creating || (current && ['awaiting-files', 'verifying', 'verified', 'restoring', 'opening'].includes(current.state))) return reply.code(409).send({ error: 'RESTORE_IN_PROGRESS' });
    creating = true;
    try {
      if (current) await rm(current.directory, { recursive: true, force: true }).catch(() => undefined);
      const id = randomUUID();
      const stagingRoot = join(options.data, 'restore-staging');
      await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      await chmod(stagingRoot, 0o700);
      await ensurePrivateDir(stagingRoot);
      const directory = join(stagingRoot, id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      await ensurePrivateDir(directory);
      current = { id, workspace: workspace(request), state: 'awaiting-files', directory, createdAt: new Date().toISOString() };
      return reply.code(201).send(publicJob(current));
    } finally { creating = false; }
  });

  app.delete('/api/v1/backups/restore/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = isJobId(id) ? ownedJob(request, id) : undefined;
    if (!job || !['awaiting-files', 'verified', 'failed'].includes(job.state) || (job.uploads ?? 0) > 0) return reply.code(409).send({ error: 'RESTORE_NOT_CANCELLABLE' });
    await rm(job.directory, { recursive: true, force: true });
    current = undefined;
    return { cancelled: true };
  });

  app.put('/api/v1/backups/restore/:id/:artifact', { bodyLimit: maxUploadBytes }, async (request, reply) => {
    const { id, artifact } = request.params as { id: string; artifact: string };
    const job = isJobId(id) ? ownedJob(request, id) : undefined;
    if (!job || job.state !== 'awaiting-files' || !['archive', 'key'].includes(artifact)) return reply.code(404).send({ error: 'RESTORE_NOT_AVAILABLE' });
    const path = join(job.directory, artifact === 'archive' ? 'backup.tar.age' : 'recovery-key.json');
    const source = request.body as Readable | undefined;
    if (!source || typeof source.pipe !== 'function') return reply.code(400).send({ error: 'RESTORE_FILE_REQUIRED' });
    let received = 0;
    let tooLarge = false;
    const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > maxUploadBytes) { tooLarge = true; callback(); return; }
      callback(null, chunk);
    } });
    let created = false;
    job.uploads = (job.uploads ?? 0) + 1;
    try {
      const handle = createWriteStream(path, { flags: 'wx', mode: 0o600 });
      handle.once('open', () => { created = true; });
      await pipeline(source, limit, handle);
      if (tooLarge) {
        await rm(path, { force: true });
        return reply.code(413).send({ error: 'RESTORE_FILE_TOO_LARGE' });
      }
      await ensurePrivateFile(path, { create: false });
      if (artifact === 'archive') job.archive = path;
      else job.key = path;
      return reply.code(201).send(publicJob(job));
    } catch (error) {
      if (created) await rm(path, { force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return reply.code(409).send({ error: 'RESTORE_FILE_ALREADY_UPLOADED' });
      logError(error, job);
      return reply.code(400).send({ error: 'RESTORE_UPLOAD_FAILED' });
    } finally {
      job.uploads = Math.max(0, (job.uploads ?? 1) - 1);
    }
  });

  app.post('/api/v1/backups/restore/:id/verify', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = isJobId(id) ? ownedJob(request, id) : undefined;
    if (!job || job.state !== 'awaiting-files' || !job.archive || !job.key) return reply.code(409).send({ error: 'RESTORE_FILES_REQUIRED' });
    job.state = 'verifying';
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 10 * 60_000); timeout.unref();
    task = (async () => {
      try {
        const result = await run(['--verify-only', '--json', '--archive', job.archive!, '--key-file', job.key!], process.env, controller!.signal);
        const summary = JSON.parse(result.stdout.trim()) as RestoreSummary;
        if (summary.valid !== true || summary.encrypted !== true || summary.authenticated !== true) throw new Error('The selected backup is not encrypted and authenticated.');
        job.summary = summary;
        job.state = 'verified';
      } catch (error) {
        job.state = 'failed'; logError(error, job);
        await rm(job.directory, { recursive: true, force: true }).catch(() => undefined);
      } finally { clearTimeout(timeout); }
    })();
    return reply.code(202).send(publicJob(job));
  });

  app.post('/api/v1/backups/restore/:id/restore', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = isJobId(id) ? ownedJob(request, id) : undefined;
    if (!job || job.state !== 'verified' || (request.body as { confirmed?: boolean } | undefined)?.confirmed !== true) return reply.code(409).send({ error: 'RESTORE_CONFIRMATION_REQUIRED' });
    if (!options.adminUrl) return reply.code(503).send({ error: 'RESTORE_NOT_CONFIGURED' });
    job.state = 'restoring';
    const restoreParent = join(options.restoreParent ?? homedir(), 'Career Stack Restored');
    job.target = join(restoreParent, job.id);
    job.webPort = await availablePort();
    do { job.apiPort = await availablePort(); } while (job.apiPort === job.webPort);
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 30 * 60_000); timeout.unref();
    task = (async () => {
      try {
        await ensurePrivateDir(restoreParent);
        const database = `career_restore_${randomBytes(6).toString('hex')}`;
        await run(['--archive', job.archive!, '--key-file', job.key!, '--target', job.target!, '--database', database, '--web-port', String(job.webPort), '--api-port', String(job.apiPort)], {
          ...process.env, CAREER_RESTORE_ADMIN_URL: options.adminUrl!, CAREER_RESTORE_APP_URL: options.appDatabase,
        }, controller!.signal);
        await ensurePrivateDir(job.target!);
        job.state = 'restored';
        await rm(job.directory, { recursive: true, force: true });
      } catch (error) {
        job.state = 'failed'; logError(error, job);
        await rm(job.directory, { recursive: true, force: true }).catch(() => undefined);
      } finally { clearTimeout(timeout); }
    })();
    return reply.code(202).send(publicJob(job));
  });

  app.post('/api/v1/backups/restore/:id/open', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = isJobId(id) ? ownedJob(request, id) : undefined;
    if (!job || job.state !== 'restored' || !job.target || !job.webPort) return reply.code(409).send({ error: 'RESTORE_NOT_READY' });
    job.state = 'opening';
    const envFile = join(job.target, '.env');
    try { if (!(await lstat(envFile)).isFile()) throw new Error('Missing restored environment.'); }
    catch { job.state = 'restored'; return reply.code(409).send({ error: 'RESTORE_NOT_READY' }); }
    const child = spawn(process.execPath, [join(options.root, 'scripts/launch.mjs'), '--copy-token'], {
      cwd: options.root, env: { ...process.env, CAREER_ENV_FILE: envFile }, shell: false, detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.once('error', (error) => { job.state = 'failed'; logError(error, job); });
    child.unref();
    controller = new AbortController();
    const openingSignal = controller.signal;
    task = (async () => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !openingSignal.aborted) {
        try {
          const response = await fetch(`http://127.0.0.1:${job.webPort}`);
          if (response.ok || response.status < 500) { job.state = 'opened'; return; }
        } catch { /* the launcher has not bound the dashboard yet */ }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
      }
      if (!openingSignal.aborted && job.state === 'opening') job.state = 'failed';
    })();
    return reply.code(202).send(publicJob(job));
  });

  app.addHook('onClose', async () => {
    controller?.abort();
    await task;
    if (current?.state !== 'restored' && current?.state !== 'opened') await rm(current?.directory ?? '', { recursive: true, force: true }).catch(() => undefined);
  });
  return {
    isRunning: () => Boolean(current && ['awaiting-files', 'verifying', 'verified', 'restoring', 'opening'].includes(current.state)),
    forget: async () => { if (current) await rm(current.directory, { recursive: true, force: true }).catch(() => undefined); current = undefined; },
  };
}
