// Disposable, isolated stack for browser E2E runs.
//
// Every run gets its own PostgreSQL database (career_e2e_<12 hex>), its own API process on a free port with
// fresh session/encryption keys, its own data directory (sign-in token) and files directory, and its own
// dashboard dev server running from a temporary directory with copied sources and private `.next`.
// Before any browser write happens the stack proves it is wired to the disposable resources and refuses to
// continue otherwise. The user's database, token file, files and the shared `.next` build are only read
// (fingerprinted), never written.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parse as parseEnv } from 'dotenv';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

type QueryResult<R> = { rows: R[] };
export type PgClient = {
  connect(): Promise<void>;
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
  end(): Promise<void>;
};
type PgModule = { Client: new (config: { connectionString: string; application_name?: string; options?: string }) => PgClient };
// `pg` is a dependency of @career/db; load it from there so the harness controls every connection string itself.
const pg = createRequire(resolve(projectRoot, 'packages/db/package.json'))('pg') as PgModule;

/** Raised when isolation cannot be proven. The run stops before any browser interaction. */
export class IsolationError extends Error {
  override name = 'IsolationError';
}

const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const disposableName = /^career_e2e_[0-9a-f]{12}$/;
const liveTables = ['workspaces', 'profile_versions', 'profile_facts', 'jobs', 'applications', 'application_events', 'document_versions', 'boards'];
const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
const withDatabase = (url: string, database: string) => { const copy = new URL(url); copy.pathname = `/${database}`; return copy.toString(); };
const log = (message: string) => console.log(`  · ${message}`);
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolvePort(address.port) : reject(new Error('No free port'))));
    });
  });
}

async function fingerprint(path: string): Promise<string> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      const entries: string[] = [];
      const walk = async (dir: string) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) await walk(full);
          else entries.push(`${relative(path, full)}:${(await stat(full)).size}:${(await stat(full)).mtimeMs}`);
        }
      };
      await walk(path);
      return createHash('sha256').update(entries.sort().join('\n')).digest('hex');
    }
    // The file content is hashed in memory only; it is never printed or stored.
    return createHash('sha256').update(`${info.mtimeMs}:`).update(await readFile(path)).digest('hex');
  } catch { return 'absent'; }
}

async function httpOk(url: string, accept: (status: number) => boolean = (status) => status === 200) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
    await response.body?.cancel();
    return accept(response.status);
  } catch { return false; }
}

async function waitUntil(label: string, check: () => Promise<boolean>, timeoutMs: number, child?: ChildProcess, logPath?: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && exited(child)) throw new Error(`${label}: process exited (${child.exitCode ?? child.signalCode}).\n${await tailLog(logPath)}`);
    if (await check()) return;
    await delay(500);
  }
  throw new Error(`${label}: not ready after ${Math.round(timeoutMs / 1000)} s.\n${await tailLog(logPath)}`);
}

async function tailLog(path?: string, lines = 40) {
  if (!path) return '';
  try { return (await readFile(path, 'utf8')).split('\n').slice(-lines).map((line) => line.replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, '$1***@')).join('\n'); }
  catch { return ''; }
}

/** Environment for child processes: inherited variables minus anything that could point at live resources. */
function childEnv(overrides: Record<string, string>) {
  const env: Record<string, string> = {};
  const blocked = /^(DATABASE_URL|E2E_ADMIN_DATABASE_URL|APP_ENCRYPTION_KEY|APP_SESSION_SECRET|DATA_LOCAL_PATH|FILES_LOCAL_PATH|API_PORT|API_HOST|API_BASE_URL|WEB_ORIGIN|WEB_PORT|PG[A-Z]*)$/;
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !blocked.test(key)) env[key] = value;
  return { ...env, ...overrides };
}

export type IsolatedStack = Awaited<ReturnType<typeof createIsolatedStack>>;

export async function createIsolatedStack() {
  const runId = randomBytes(6).toString('hex');
  const databaseName = `career_e2e_${runId}`;
  const keep = process.env.E2E_KEEP === '1';
  const liveEnv = parseEnv(await readFile(resolve(projectRoot, '.env'), 'utf8').catch(() => ''));
  const liveUrlRaw = liveEnv.DATABASE_URL;
  if (!liveUrlRaw) throw new IsolationError('DATABASE_URL is missing in .env; the harness needs the local PostgreSQL server to create a disposable database.');
  const liveUrl = new URL(liveUrlRaw);
  const liveDatabase = liveUrl.pathname.replace(/^\//, '');
  if (!loopback.has(liveUrl.hostname)) throw new IsolationError(`Refusing to create test databases on a non-loopback server (${liveUrl.hostname}).`);
  if (!disposableName.test(databaseName) || databaseName === liveDatabase) throw new IsolationError('Generated database name is not a disposable E2E name.');
  const disposableUrl = withDatabase(liveUrlRaw, databaseName);

  const liveData = resolve(projectRoot, liveEnv.DATA_LOCAL_PATH ?? './data');
  const liveFiles = resolve(projectRoot, liveEnv.FILES_LOCAL_PATH ?? './data/files');
  const liveTokenPath = resolve(liveData, 'setup-token');
  const sharedNextBuild = resolve(projectRoot, 'apps/dashboard/.next/BUILD_ID');
  const before = { token: await fingerprint(liveTokenPath), files: await fingerprint(liveFiles), nextBuild: await fingerprint(sharedNextBuild) };

  const children: Array<{ name: string; child: ChildProcess }> = [];
  const cleanup: Array<() => Promise<void>> = [];
  let tornDown = false;
  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    for (const { child } of children.reverse()) await stopChild(child);
    for (const task of cleanup.reverse()) await task().catch((error: unknown) => console.error(`  ! cleanup step failed: ${error instanceof Error ? error.message : String(error)}`));
  };

  try {
    // 1. Disposable database, created through a maintenance database (never through the live one) and owned
    // by the application role so the API runs with the same privileges as in normal use. When that role lacks
    // CREATEDB, E2E_ADMIN_DATABASE_URL may name a local administrative connection (only used to create/drop).
    const adminUrl = new URL(process.env.E2E_ADMIN_DATABASE_URL ?? withDatabase(liveUrlRaw, 'postgres'));
    if (!loopback.has(adminUrl.hostname) || adminUrl.port !== liveUrl.port) throw new IsolationError('E2E_ADMIN_DATABASE_URL must point at the same loopback PostgreSQL server as DATABASE_URL.');
    if (adminUrl.pathname.replace(/^\//, '') === liveDatabase) throw new IsolationError('E2E_ADMIN_DATABASE_URL must use a maintenance database (e.g. postgres), not the live database.');
    const admin = new pg.Client({ connectionString: adminUrl.toString(), application_name: 'career-e2e-admin' });
    await admin.connect().catch((error: unknown) => { throw new IsolationError(`Cannot reach PostgreSQL for the disposable database: ${error instanceof Error ? error.message : String(error)}`); });
    cleanup.push(() => admin.end());
    const owner = decodeURIComponent(liveUrl.username);
    await admin.query(`create database ${quoteIdent(databaseName)}${owner ? ` owner ${quoteIdent(owner)}` : ''}`).catch((error: unknown) => {
      throw new IsolationError(`Cannot create the disposable database: ${error instanceof Error ? error.message : String(error)}. The DATABASE_URL role needs CREATEDB, or set E2E_ADMIN_DATABASE_URL to a local admin connection, e.g. postgresql://$USER@127.0.0.1:5432/postgres on Homebrew.`);
    });
    cleanup.push(async () => {
      if (keep) { log(`E2E_KEEP=1: kept database ${databaseName}`); return; }
      if (!disposableName.test(databaseName) || databaseName === liveDatabase) throw new Error('Refusing to drop a non-disposable database');
      await admin.query(`drop database if exists ${quoteIdent(databaseName)} with (force)`);
    });
    const db = new pg.Client({ connectionString: disposableUrl, application_name: 'career-e2e' });
    await db.connect();
    cleanup.push(() => db.end());
    const current = (await db.query<{ name: string }>('select current_database() as name')).rows[0]?.name;
    const tableCount = Number((await db.query<{ count: string }>("select count(*) from information_schema.tables where table_schema = 'public'")).rows[0]?.count);
    if (current !== databaseName || tableCount !== 0) throw new IsolationError('Disposable database is not the fresh database that was just created.');
    await applyMigrations(db);
    log(`disposable database ${databaseName} migrated`);

    // 2. Private temporary directories for the token, generated files and logs.
    const tempRoot = await mkdtemp(join(tmpdir(), `career-e2e-${runId}-`));
    cleanup.push(async () => { if (!keep) await rm(tempRoot, { recursive: true, force: true }); else log(`E2E_KEEP=1: kept ${tempRoot}`); });
    const dataDir = join(tempRoot, 'data'); const filesDir = join(tempRoot, 'files'); const logsDir = join(tempRoot, 'logs');
    for (const dir of [dataDir, filesDir, logsDir]) await mkdir(dir, { recursive: true, mode: 0o700 });

    const apiPort = await freePort();
    let uiPort = await freePort();
    while (uiPort === apiPort) uiPort = await freePort();
    if ([3000, 3001].includes(apiPort) || [3000, 3001].includes(uiPort)) throw new IsolationError('Allocated a port reserved for the live workspace.');
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const uiUrl = `http://127.0.0.1:${uiPort}`;

    // 3. Isolated API with fresh keys. Without DATA_LOCAL_PATH support an API would read (or, if absent,
    // create) the live token file, so refuse before starting it rather than detect it afterwards.
    if (!await apiSupportsDataPath()) throw new IsolationError('apps/api/src does not read DATA_LOCAL_PATH yet; an isolated API would share the live sign-in token. Integrate the backend change first.');
    const apiLog = join(logsDir, 'api.log');
    const tsxCli = createRequire(resolve(projectRoot, 'apps/api/package.json')).resolve('tsx/cli');
    const api = await startChild('api', process.execPath, [tsxCli, 'src/server.ts'], resolve(projectRoot, 'apps/api'), apiLog, childEnv({
      NODE_ENV: 'test', LOG_LEVEL: 'warn', AI_PROVIDER: 'none',
      DATABASE_URL: disposableUrl, API_HOST: '127.0.0.1', API_PORT: String(apiPort), WEB_ORIGIN: uiUrl,
      DATA_LOCAL_PATH: dataDir, FILES_LOCAL_PATH: filesDir,
      APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_SESSION_SECRET: randomBytes(32).toString('base64'),
    }));
    children.push({ name: 'api', child: api });
    await waitUntil('Isolated API', () => httpOk(`${apiUrl}/healthz`), 90_000, api, apiLog);

    // 4. Prove the API uses the disposable resources before anything else talks to it.
    const isolatedTokenPath = join(dataDir, 'setup-token');
    const tokenWritten = await waitForFile(isolatedTokenPath, 5_000);
    if (!tokenWritten) throw new IsolationError('The API did not write its sign-in token to DATA_LOCAL_PATH. Without that support it would read and consume the live token, so the run stops here.');
    const workspaces = Number((await db.query<{ count: string }>('select count(*) from workspaces')).rows[0]?.count);
    if (workspaces !== 1) throw new IsolationError(`Expected the isolated API to create exactly one workspace in ${databaseName}; found ${workspaces}.`);
    if (await fingerprint(liveTokenPath) !== before.token) throw new IsolationError('The live sign-in token changed while the isolated API started.');
    log(`isolated API on ${apiUrl} uses ${databaseName} and a private data directory`);

    // 5. Dashboard dev server from a temporary directory. Sources are copied; `.next` is private to the run.
    const runsRoot = resolve(projectRoot, 'output/e2e-runs');
    const uiDir = resolve(runsRoot, runId, 'dashboard');
    await cloneDashboard(resolve(projectRoot, 'apps/dashboard'), uiDir);
    // `next dev` is started directly, so run the dashboard's PDF.js asset step here, inside the private copy.
    // A fresh checkout or worktree has no public/pdf-assets yet; the source tree is never written.
    execFileSync(process.execPath, ['prepare-pdf-assets.mjs'], { cwd: uiDir, stdio: 'ignore' });
    cleanup.push(async () => {
      const runDir = dirname(uiDir);
      if (!runDir.startsWith(`${runsRoot}${sep}`) || !runDir.endsWith(runId)) throw new Error('Refusing to remove an unexpected directory');
      if (!keep) await rm(runDir, { recursive: true, force: true });
    });
    const uiLog = join(logsDir, 'dashboard.log');
    const nextBin = resolve(projectRoot, 'apps/dashboard/node_modules/next/dist/bin/next');
    const ui = await startChild('dashboard', process.execPath, [nextBin, 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(uiPort)], uiDir, uiLog, childEnv({ API_BASE_URL: apiUrl, NEXT_TELEMETRY_DISABLED: '1' }));
    children.push({ name: 'dashboard', child: ui });
    await waitUntil('Isolated dashboard', () => httpOk(`${uiUrl}/login`), 240_000, ui, uiLog);
    await waitUntil('Dashboard proxy to the isolated API', () => httpOk(`${uiUrl}/api/v1/session`), 30_000, ui, uiLog);
    if (!(await lstat(join(uiDir, '.next')).then((info) => info.isDirectory() && !info.isSymbolicLink(), () => false))) throw new IsolationError('The dashboard dev server is not writing to its private .next directory.');
    log(`isolated dashboard on ${uiUrl} (private .next in output/e2e-runs/${runId})`);

    // Records written by the run carry this marker so the live database can be checked for leaks afterwards.
    const marker = `e2e-${runId}`;

    return {
      runId, marker, apiUrl, uiUrl, db, databaseName, logsDir,
      /** The isolated, single-use sign-in token. Only ever passed to the isolated UI. */
      readToken: async () => (await readFile(isolatedTokenPath, 'utf8')).trim(),
      /** Fails if the live token, live files or shared Next build changed, or if run markers reached the live database. */
      assertLiveUntouched: async () => {
        const problems: string[] = [];
        if (await fingerprint(liveTokenPath) !== before.token) problems.push('live sign-in token file changed');
        if (await fingerprint(liveFiles) !== before.files) problems.push('live files directory changed');
        if (await fingerprint(sharedNextBuild) !== before.nextBuild) problems.push('shared dashboard .next build changed');
        problems.push(...await checkLiveDatabase(liveUrlRaw, marker));
        if (problems.length) throw new IsolationError(`Live resources changed during the run: ${problems.join('; ')}. If you used the live app meanwhile, re-run; otherwise treat this as an isolation failure.`);
      },
      tailLogs: async () => `--- api ---\n${await tailLog(apiLog)}\n--- dashboard ---\n${await tailLog(uiLog)}`,
      teardown,
    };
  } catch (error) {
    await teardown();
    throw error;
  }
}

async function apiSupportsDataPath() {
  const sources = resolve(projectRoot, 'apps/api/src');
  for (const file of await readdir(sources)) {
    if (file.endsWith('.ts') && (await readFile(join(sources, file), 'utf8')).includes('DATA_LOCAL_PATH')) return true;
  }
  return false;
}

async function applyMigrations(db: PgClient) {
  const migrations = resolve(projectRoot, 'packages/db/migrations');
  const journal = JSON.parse(await readFile(join(migrations, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string }> };
  for (const entry of [...journal.entries].sort((a, b) => a.idx - b.idx)) {
    const sql = await readFile(join(migrations, `${entry.tag}.sql`), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) await db.query(statement);
  }
}

async function checkLiveDatabase(liveUrl: string, marker: string): Promise<string[]> {
  // Read-only session: the harness cannot write to the live database even by mistake.
  const live = new pg.Client({ connectionString: liveUrl, application_name: 'career-e2e-readonly-check', options: '-c default_transaction_read_only=on' });
  await live.connect();
  try {
    const leaks: string[] = [];
    const probes: Array<[string, string]> = [
      ['profile_facts', 'select count(*) from profile_facts where statement like $1'],
      ['jobs', 'select count(*) from jobs where company like $1 or title like $1'],
      ['applications', 'select count(*) from applications where company like $1 or role like $1'],
      ['document_versions', 'select count(*) from document_versions where name like $1'],
    ];
    for (const [table, query] of probes) {
      const count = Number((await live.query<{ count: string }>(query, [`%${marker}%`]).catch(() => ({ rows: [{ count: '0' }] }))).rows[0]?.count);
      if (count > 0) leaks.push(`${count} row(s) with the run marker in live ${table}`);
    }
    return leaks;
  } finally { await live.end(); }
}

/** Row counts of the live database, read-only. Used only for an informational before/after comparison. */
export async function liveRowCounts(): Promise<Record<string, number>> {
  const env = parseEnv(await readFile(resolve(projectRoot, '.env'), 'utf8'));
  const live = new pg.Client({ connectionString: env.DATABASE_URL ?? '', application_name: 'career-e2e-readonly-check', options: '-c default_transaction_read_only=on' });
  await live.connect();
  try {
    const counts: Record<string, number> = {};
    for (const table of liveTables) counts[table] = Number((await live.query<{ count: string }>(`select count(*) from ${quoteIdent(table)}`).catch(() => ({ rows: [{ count: '-1' }] }))).rows[0]?.count);
    return counts;
  } finally { await live.end(); }
}

async function cloneDashboard(source: string, target: string) {
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (['.next', '.turbo'].includes(entry.name) || entry.name.endsWith('.tsbuildinfo') || entry.name.startsWith('.env')) continue;
    const from = join(source, entry.name); const to = join(target, entry.name);
    // Next's route discovery does not reliably follow a symlinked app directory.
    // Copy source directories for a stable snapshot; share only installed dependencies.
    if (entry.name === 'node_modules') await symlink(from, to, 'dir');
    else if (entry.isDirectory()) await cp(from, to, { recursive: true });
    else if (entry.isFile()) await copyFile(from, to);
    else await cp(from, to);
  }
}

async function startChild(name: string, command: string, args: string[], cwd: string, logPath: string, env: Record<string, string>) {
  const handle = await open(logPath, 'a', 0o600);
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', handle.fd, handle.fd] });
  await handle.close();
  child.once('error', (error) => console.error(`  ! ${name} failed to start: ${error.message}`));
  return child;
}

async function stopChild(child: ChildProcess) {
  if (exited(child) || child.pid === undefined) return;
  const signal = (value: NodeJS.Signals) => { try { process.kill(-child.pid!, value); } catch { child.kill(value); } };
  signal('SIGTERM');
  for (let attempt = 0; attempt < 40 && !exited(child); attempt += 1) await delay(250);
  if (!exited(child)) signal('SIGKILL');
}

async function waitForFile(path: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await stat(path).then(() => true, () => false)) return true;
    await delay(200);
  }
  return false;
}
