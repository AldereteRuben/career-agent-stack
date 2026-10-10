import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export type BackupOptions = { root: string; data: string; files: string; database: string; key: string };
export type BackupRunner = (directory: string, signal: AbortSignal) => Promise<void>;
type Artifact = 'archive' | 'key' | 'checksum';
type Job = { id: string; workspace: string; createdAt: string; state: 'running' | 'ready' | 'failed'; directory: string; artifacts?: Record<Artifact, string> };

/** Run the already verified archive writer with this API's configuration, never the checkout's .env. */
export function backupRunner(options: BackupOptions): BackupRunner {
  return async (directory, signal) => {
    const envFile = join(directory, '.backup-env');
    const entries = { DATABASE_URL: options.database, APP_ENCRYPTION_KEY: options.key, FILES_LOCAL_PATH: options.files };
    if (Object.values(entries).some((value) => /[\r\n]/.test(value))) throw new Error('Unsupported configuration');
    try {
      await writeFile(envFile, Object.entries(entries).map(([key, value]) => `${key}="${value}"`).join('\n'), { mode: 0o600, flag: 'wx' });
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [join(options.root, 'scripts/backup.mjs'), '--env-file', envFile, '--out-dir', directory, '--key-dir', join(directory, 'keys')], {
          cwd: options.root, shell: false, stdio: 'ignore', signal,
        });
        let failed = false;
        child.once('error', () => { failed = true; });
        child.once('close', (code) => !failed && code === 0 ? resolve() : reject(new Error('Backup failed')));
      });
    } finally { await rm(envFile, { force: true }); }
  };
}

export function registerBackupRoutes(app: FastifyInstance, workspace: (request: FastifyRequest) => string, options: BackupOptions, run: BackupRunner = backupRunner(options)) {
  let current: Job | undefined;
  let controller: AbortController | undefined;
  let task: Promise<void> | undefined;
  const publicJob = (job: Job | undefined) => job ? { id: job.id, createdAt: job.createdAt, state: job.state } : { state: 'idle' };
  const execute = async (job: Job, signal: AbortSignal) => {
    try {
      await mkdir(job.directory, { recursive: true, mode: 0o700 });
      await chmod(job.directory, 0o700);
      await run(job.directory, signal);
      const files = await readdir(job.directory);
      const keys = await readdir(join(job.directory, 'keys'));
      // Backups are always encrypted (ADR 019); a plain tar here would mean an older writer, so it is not offered.
      const archive = files.find((name) => /^career-backup-[\w-]+\.tar\.age$/.test(name));
      const key = keys.find((name) => /^career-key-[a-f0-9]+\.json$/.test(name));
      if (!archive || !key || !files.includes(`${archive}.sha256`)) throw new Error('Missing artifacts');
      job.artifacts = { archive, key: `keys/${key}`, checksum: `${archive}.sha256` };
      for (const path of Object.values(job.artifacts)) {
        const file = join(job.directory, path);
        if (!(await lstat(file)).isFile()) throw new Error('Invalid artifact');
        await chmod(file, 0o600);
      }
      job.state = 'ready';
    } catch {
      job.state = 'failed';
      // Failed archives are not recoverable. Completed copies are retained until the user removes them.
      await rm(job.directory, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  app.get('/api/v1/backups/current', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return publicJob(current?.workspace === workspace(request) ? current : undefined);
  });
  app.post('/api/v1/backups', async (request, reply) => {
    if (current?.state === 'running') return reply.code(409).send({ error: 'BACKUP_IN_PROGRESS' });
    const id = randomUUID();
    current = { id, workspace: workspace(request), createdAt: new Date().toISOString(), state: 'running', directory: join(options.data, 'backups', id) };
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 5 * 60_000); timeout.unref();
    task = execute(current, controller.signal).finally(() => clearTimeout(timeout));
    return reply.code(202).send(publicJob(current));
  });
  app.get('/api/v1/backups/:id/:artifact', async (request, reply) => {
    const { id, artifact } = request.params as { id: string; artifact: string };
    if (!current || current.workspace !== workspace(request) || current.id !== id || current.state !== 'ready' || !['archive', 'key', 'checksum'].includes(artifact)) return reply.code(404).send({ error: 'BACKUP_NOT_AVAILABLE' });
    const relative = current.artifacts![artifact as Artifact];
    const path = join(current.directory, relative);
    try { if (!(await lstat(path)).isFile()) throw new Error('Missing file'); }
    catch { return reply.code(404).send({ error: 'BACKUP_NOT_AVAILABLE' }); }
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Disposition', `attachment; filename="${relative.split('/').at(-1)}"`);
    return reply.type('application/octet-stream').send(createReadStream(path));
  });
  app.addHook('onClose', async () => { controller?.abort(); await task; });
}
