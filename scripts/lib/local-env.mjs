// Shared helpers for the local launcher scripts. Nothing here prints secret values:
// connection strings are reduced to host/port/database before they reach the terminal.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { access, chmod, link, mkdir, open, readFile, readdir, readlink, rename, stat, unlink, utimes } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const checkoutEnvPath = resolve(projectRoot, '.env');

// CAREER_ENV_FILE selects another installation's configuration (for example a restored workspace) to run with
// this checkout's code: its database, keys, ports and data folder, with run records and logs in that data folder.
// The checkout's own .env is then never read for values, and nothing of the live installation is used.
export const alternateEnv = Boolean(process.env.CAREER_ENV_FILE);
export const envPath = alternateEnv ? resolve(process.env.CAREER_ENV_FILE) : checkoutEnvPath;

function readEnvSync(path) {
  try { return parseEnv(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Data folder of the selected installation: DATA_LOCAL_PATH resolved like the API does (relative to the checkout). */
export const dataRoot = resolve(projectRoot, (alternateEnv && readEnvSync(envPath)?.DATA_LOCAL_PATH) || './data');
export const runDir = resolve(dataRoot, 'run');
export const logDir = resolve(dataRoot, 'logs');
// Configuration of an installation whose bootstrap has not finished yet. It becomes .env (atomically) only
// once the database answers with its credentials and the migrations are applied, so a failed first run
// never leaves a .env that points at nothing. Re-running bootstrap resumes from it with the same keys.
export const pendingEnvPath = resolve(projectRoot, '.env.pending');
export const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const spanishFirst = /^es/i.test(process.env.CAREER_LANG || process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '');

/** Prints a message in both languages: the system language first, the other indented below. */
export function say(es, en, stream = process.stdout) {
  const [first, second] = spanishFirst ? [es, en] : [en, es];
  // The second language is dimmed so the two lines read as one message.
  const dim = stream.isTTY ? (text) => `\x1b[2m${text}\x1b[22m` : (text) => text;
  stream.write(`${first}\n${second && second !== first ? `  ${dim(second)}\n` : ''}`);
}

export const step = (es, en) => say(`• ${es}`, `• ${en}`);
export const ok = (es, en) => say(`✓ ${es}`, `✓ ${en}`);
export const warn = (es, en) => say(`! ${es}`, `! ${en}`, process.stderr);

/** A recoverable failure with a bilingual explanation and concrete next steps. */
export class RecoveryError extends Error {
  constructor({ es, en, fixes = [] }) {
    super(en);
    this.es = es;
    this.en = en;
    this.fixes = fixes;
  }
}

export function printRecovery(error) {
  process.stderr.write('\n');
  if (error instanceof RecoveryError) {
    say(`✗ ${error.es}`, error.en, process.stderr);
    if (error.fixes.length) {
      say('  Qué puedes hacer:', 'What you can do:', process.stderr);
      for (const fix of error.fixes) say(`   – ${fix.es}`, fix.en, process.stderr);
    }
  } else {
    say('✗ Error inesperado.', 'Unexpected error.', process.stderr);
    process.stderr.write(`  ${maskSecrets(error instanceof Error ? error.message : String(error))}\n`);
  }
  say('  No se ha borrado ni modificado ningún dato.', 'No data was deleted or modified.', process.stderr);
}

/** Removes credentials from connection strings and long base64-like values before printing. */
export function maskSecrets(text) {
  return String(text)
    .replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, '$1***@')
    .replace(/((?:SECRET|KEY|TOKEN|PASSWORD)[A-Z_]*\s*[=:]\s*)\S+/gi, '$1***');
}

export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

/** Parses .env (or another env file of this checkout) without loading it into process.env and without echoing values. */
export async function readLocalEnv(path = envPath) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch { return null; }
  return parseEnv(text);
}

/** Directory holding the sign-in token (DATA_LOCAL_PATH, default ./data), resolved like the API does. */
export function localDataPath(env) {
  return resolve(projectRoot, env?.DATA_LOCAL_PATH || process.env.DATA_LOCAL_PATH || './data');
}

// Variables that select a database, keys, ports or data paths. They are never inherited from the shell by the
// processes of an installation: its own .env decides, so a DATABASE_URL exported for another project (or another
// checkout) can never point this installation at someone else's data.
const installScoped = /^(DATABASE_URL|APP_[A-Z_]+|API_[A-Z_]+|WEB_[A-Z_]+|DATA_LOCAL_PATH|FILES_[A-Z_]+|PG[A-Z]+)$/;

/**
 * Environment for child processes of this installation: the shell minus install-scoped variables, plus its env file.
 * The API and drizzle also read the checkout's .env for variables that are not set; with CAREER_ENV_FILE every
 * key of that .env missing from the selected file is set to its .env.example default (or empty), so no live value
 * (a key, a path) can leak into the other installation.
 */
export function installEnv(values, extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!installScoped.test(key)) env[key] = value;
  const shield = {};
  if (alternateEnv && values) {
    const defaults = readEnvSync(resolve(projectRoot, '.env.example')) ?? {};
    for (const key of Object.keys(readEnvSync(checkoutEnvPath) ?? {})) if (!(key in values)) shield[key] = defaults[key] ?? '';
  }
  return { ...env, ...shield, ...values, ...extra };
}

/**
 * With CAREER_ENV_FILE, the selected installation must keep its data outside this checkout's data folder:
 * returns the problem (bilingual) or null.
 */
export function alternateEnvProblem(values) {
  if (!alternateEnv) return null;
  for (const key of ['DATA_LOCAL_PATH', 'FILES_LOCAL_PATH']) {
    const value = values?.[key];
    if (!value || !isAbsolute(value)) return { es: `${key} debe ser una ruta absoluta en ${envPath}.`, en: `${key} must be an absolute path in ${envPath}.` };
    const inside = resolve(value) === resolve(projectRoot, 'data') || resolve(value).startsWith(`${resolve(projectRoot, 'data')}/`);
    if (inside) return { es: `${key} apunta a la carpeta data/ de esta copia; usa la carpeta propia de esa instalación.`, en: `${key} points into this checkout's data/ folder; use that installation's own folder.` };
  }
  return null;
}

/** Writes a private (0600) file through a temporary sibling and a rename, so readers never see half a file. */
export async function writePrivateFileAtomic(path, content) {
  const temporary = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/** Moves `from` to `to` atomically without ever replacing an existing `to`. Returns false if `to` already exists. */
export async function promoteWithoutOverwrite(from, to) {
  try { await link(from, to); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  await unlink(from);
  return true;
}

/** True when nothing listens on 127.0.0.1:port and it can be bound. */
export function portIsFree(port) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', () => resolvePromise(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolvePromise(true)));
  });
}

/** The `pg` driver installed for packages/db (available after pnpm install). */
export function loadPg() {
  try { return createRequire(resolve(projectRoot, 'packages/db/package.json'))('pg'); }
  catch { return null; }
}

/** Host, port and database name only: never the user name or password. */
export function describeDatabase(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) return null;
    return { host: url.hostname, port: Number(url.port || 5432), database: url.pathname.replace(/^\//, ''), loopback: loopbackHosts.has(url.hostname) };
  } catch { return null; }
}

export function portIsOpen(host, port, timeoutMs = 800) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: host.replace(/^\[|\]$/g, ''), port });
    const done = (value) => { socket.destroy(); resolvePromise(value); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** GET without following redirects. Returns status 0 when nothing answers. */
export async function httpStatus(url, timeoutMs = 2_000) {
  try {
    const response = await globalThis.fetch(url, { redirect: 'manual', signal: globalThis.AbortSignal.timeout(timeoutMs) });
    let body = null;
    if ((response.headers.get('content-type') ?? '').includes('application/json')) body = await response.json().catch(() => null);
    else await response.body?.cancel();
    return { status: response.status, body };
  } catch { return { status: 0, body: null }; }
}

export async function waitFor(check, { timeoutMs, intervalMs = 500 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await delay(intervalMs);
  }
  return check();
}

/** Newest modification time below the given paths (files or directories), skipping build output. */
export async function newestMtime(paths) {
  let newest = 0;
  const visit = async (path) => {
    let info;
    try { info = await stat(path); } catch { return; }
    if (!info.isDirectory()) { newest = Math.max(newest, info.mtimeMs); return; }
    for (const entry of await readdir(path)) {
      if (['node_modules', 'dist', '.next', '.turbo'].includes(entry)) continue;
      await visit(join(path, entry));
    }
  };
  for (const path of paths) await visit(path);
  return newest;
}

export async function mtimeOf(path) {
  try { return (await stat(path)).mtimeMs; } catch { return 0; }
}

/**
 * Records that the installed dependencies match the lockfile, by touching pnpm's marker (node_modules/.modules.yaml). pnpm leaves
 * that file alone when an install has nothing to do, so after a `git pull` that changes pnpm-lock.yaml the lockfile would look
 * newer for good and `status` would keep warning. The marker is set to now, but never older than the lockfile (a millisecond
 * after it at least): file times keep finer detail than `Date.now()`, so "now" alone could land just below a lockfile written in
 * the same millisecond. Returns false when there is no marker to touch.
 */
export async function markDependenciesCurrent(marker, lockfile) {
  const lockfileTime = await mtimeOf(lockfile);
  const target = Math.max(Date.now(), lockfileTime ? lockfileTime + 1 : 0) / 1000; // seconds, with fractions, as utimes takes them
  try { await utimes(marker, target, target); return true; } catch { return false; }
}

/**
 * Start time of a Linux process in milliseconds, from the kernel's own clock ticks. `ps` derives it from the boot time with
 * two roundings to whole seconds and can be about two seconds off. /proc/uptime and the start ticks both count
 * suspended time (CLOCK_BOOTTIME), so the difference stays correct across suspend. Null when /proc cannot be read.
 */
function linuxStartMs(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]); // field 22; the command name in field 2 may contain spaces
    const uptime = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    const ticksPerSecond = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout) || 100;
    const started = Date.now() - uptime * 1000 + (ticks / ticksPerSecond) * 1000;
    return Number.isFinite(started) ? started : null;
  } catch { return null; }
}

/**
 * Identity of a running process: exact start time, process group, command line and working directory.
 * Returns null when any part cannot be read, so callers can fail closed.
 */
export async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const ps = spawnSync('ps', ['-o', 'pgid=,lstart=,args=', '-p', String(pid)], { encoding: 'utf8' });
  const match = ps.status === 0 ? ps.stdout.trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/) : null;
  if (!match) return null;
  let cwd;
  if (process.platform === 'linux') {
    try { cwd = await readlink(`/proc/${pid}/cwd`); } catch { cwd = null; }
  } else {
    const lsof = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
    cwd = lsof.status === 0 ? lsof.stdout.split('\n').find((line) => line.startsWith('n'))?.slice(1) ?? null : null;
  }
  if (!cwd) return null;
  const startedAt = (process.platform === 'linux' ? linuxStartMs(pid) : null) ?? Date.parse(match[2].replace(/\s+/g, ' '));
  if (Number.isNaN(startedAt)) return null;
  return { pid, pgid: Number(match[1]), lstart: match[2].replace(/\s+/g, ' '), startedAt, args: match[3], cwd };
}

/**
 * PID listening on a TCP port, or null when unknown. On Linux `ss` is asked first: lsof 4.99 skips a process whose title
 * contains nested parentheses, which is how Next.js renames its server ("next-server (v16.3.8)").
 */
export function listeningPid(port) {
  if (process.platform === 'linux') {
    const ss = spawnSync('ss', ['-H', '-ltnp', `sport = :${port}`], { encoding: 'utf8' });
    // Only a line for this port: if `ss` ignored the `sport` filter, another listener's pid must not be taken.
    const line = ss.stdout?.split('\n').find((candidate) => candidate.includes(`:${port} `) && candidate.includes('pid='));
    const found = Number(line?.match(/pid=(\d+)/)?.[1]);
    if (ss.status === 0 && Number.isInteger(found) && found > 0) return found;
  }
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  const pid = Number(lsof.stdout?.trim().split('\n')[0]);
  return lsof.status === 0 && Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function parentArgs(pid) {
  const ppid = Number(spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());
  if (!Number.isInteger(ppid) || ppid <= 1) return '';
  return spawnSync('ps', ['-o', 'args=', '-p', String(ppid)], { encoding: 'utf8' }).stdout.trim();
}

/** Records a service started by the local scripts in data/run/, so `pnpm run stop` can find it. */
export async function recordStarted(name, details) {
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await writePrivateFileAtomic(resolve(runDir, `${name}.json`), JSON.stringify({ name, startedAt: new Date().toISOString(), ...details }, null, 2));
}

const exists = async (path) => { try { await access(path); return true; } catch { return false; } };

/**
 * Starts the local PostgreSQL this machine already has: the Homebrew postgresql@17 cluster with pg_ctl, or,
 * failing that, Docker Compose (compose.yaml). Installs nothing and creates no cluster. Returns the method used, or null.
 */
export async function startLocalPostgres() {
  const brewPrefix = spawnSync('brew', ['--prefix'], { encoding: 'utf8' });
  const brewData = brewPrefix.status === 0 ? resolve(brewPrefix.stdout.trim(), 'var/postgresql@17') : null;
  const pgCtl = brewPrefix.status === 0 ? resolve(brewPrefix.stdout.trim(), 'opt/postgresql@17/bin/pg_ctl') : null;
  if (brewData && pgCtl && await exists(resolve(brewData, 'PG_VERSION')) && await exists(pgCtl)) {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const started = spawnSync(pgCtl, ['-D', brewData, '-l', resolve(dataRoot, 'postgres.log'), '-w', '-t', '30', 'start'], { stdio: 'ignore' });
    if (started.status === 0) {
      await recordStarted('postgres', { method: 'homebrew-pg_ctl', dataDir: brewData, pgCtl });
      return 'homebrew-pg_ctl';
    }
  }
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
    && spawnSync('docker', ['compose', 'up', '-d', '--wait', 'postgres'], { cwd: projectRoot, stdio: 'inherit' }).status === 0) {
    await recordStarted('postgres', { method: 'docker-compose' });
    return 'docker-compose';
  }
  return null;
}
