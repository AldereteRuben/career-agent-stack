// Shared helpers for the local launcher scripts. Nothing here prints secret values:
// connection strings are reduced to host/port/database before they reach the terminal.
import { spawnSync } from 'node:child_process';
import { readFile, readdir, readlink, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import process from 'node:process';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const runDir = resolve(projectRoot, 'data/run');
export const logDir = resolve(projectRoot, 'data/logs');
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

/** Parses .env without loading it into process.env and without echoing values. */
export async function readLocalEnv() {
  let text;
  try { text = await readFile(resolve(projectRoot, '.env'), 'utf8'); }
  catch { return null; }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

/** Directory holding the sign-in token (DATA_LOCAL_PATH, default ./data), resolved like the API does. */
export function localDataPath(env) {
  return resolve(projectRoot, process.env.DATA_LOCAL_PATH || env?.DATA_LOCAL_PATH || './data');
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
  const startedAt = Date.parse(match[2].replace(/\s+/g, ' '));
  if (Number.isNaN(startedAt)) return null;
  return { pid, pgid: Number(match[1]), lstart: match[2].replace(/\s+/g, ' '), startedAt, args: match[3], cwd };
}

/** PID listening on a loopback TCP port, or null when unknown. */
export function listeningPid(port) {
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  const pid = Number(lsof.stdout?.trim().split('\n')[0]);
  return lsof.status === 0 && Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function parentArgs(pid) {
  const ppid = Number(spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());
  if (!Number.isInteger(ppid) || ppid <= 1) return '';
  return spawnSync('ps', ['-o', 'args=', '-p', String(ppid)], { encoding: 'utf8' }).stdout.trim();
}
