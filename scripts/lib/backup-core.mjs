// Shared pieces of `pnpm run backup` and `pnpm run restore`.
// Secrets handled here (database passwords, APP_ENCRYPTION_KEY) are passed to child processes through the
// environment, written only to 0600 files, and never printed. Connection strings are described as host:port/db.
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { lstat, open, readFile, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { RecoveryError, describeDatabase, loopbackHosts, projectRoot } from './local-env.mjs';
import { ArchiveError, assertSafeRelativePath } from './backup-archive.mjs';

export const BACKUP_FORMAT = 'career-agent-stack-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const KEY_FORMAT = 'career-agent-stack-key';
export const MANIFEST_NAME = 'manifest.json';
export const MANIFEST_MAC_NAME = 'manifest.hmac';
export const DUMP_NAME = 'database.pgdump';
export const FILES_PREFIX = 'files/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export const fix = (es, en) => ({ es, en });

/** Parses a .env file without loading it into process.env and without echoing values. Null when missing. */
export async function readEnvFile(path) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch { return null; }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

/** Paths in .env are relative to the project root, exactly as the API resolves them. */
export const projectPath = (value) => resolve(projectRoot, value);

/** "host:port/database" without user name or password. */
export function databaseLabel(rawUrl) {
  const described = describeDatabase(rawUrl);
  return described ? `${described.host}:${described.port}/${described.database}` : '(URL no válida / invalid URL)';
}

/** libpq variables for a child process; inherited PG* variables are dropped so they cannot redirect it. */
export function libpqEnv(rawUrl, overrides = {}) {
  const url = new URL(rawUrl);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
  env.PGHOST = url.hostname.replace(/^\[|\]$/g, '');
  env.PGPORT = url.port || '5432';
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  env.PGDATABASE = decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres';
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  env.PGCONNECT_TIMEOUT = '10';
  env.PGAPPNAME = 'career-backup';
  return { ...env, ...overrides };
}

export function withDatabase(rawUrl, database) {
  const url = new URL(rawUrl);
  url.pathname = `/${encodeURIComponent(database)}`;
  return url.toString();
}

export function sameServer(urlA, urlB) {
  const a = new URL(urlA);
  const b = new URL(urlB);
  const host = (url) => (loopbackHosts.has(url.hostname) ? 'loopback' : url.hostname.toLowerCase());
  return host(a) === host(b) && (a.port || '5432') === (b.port || '5432');
}

/** The `pg` driver installed for @career/db (the project root has no runtime dependencies of its own). */
export function loadPg() {
  try {
    return createRequire(join(projectRoot, 'packages/db/package.json'))('pg');
  } catch {
    throw new RecoveryError({
      es: 'No se encontró el controlador de PostgreSQL (pg) de packages/db.', en: 'The PostgreSQL driver (pg) from packages/db was not found.',
      fixes: [fix('Instala las dependencias: pnpm install --frozen-lockfile', 'Install dependencies: pnpm install --frozen-lockfile')],
    });
  }
}

export async function connect(rawUrl, applicationName) {
  const { Client } = loadPg();
  const client = new Client({ connectionString: rawUrl, application_name: applicationName, connectionTimeoutMillis: 10_000 });
  try { await client.connect(); } catch (error) {
    throw new RecoveryError({
      es: `No se pudo conectar a PostgreSQL en ${databaseLabel(rawUrl)}: ${safeMessage(error)}`,
      en: `Could not connect to PostgreSQL at ${databaseLabel(rawUrl)}: ${safeMessage(error)}`,
      fixes: [fix('Comprueba que PostgreSQL está en marcha (pnpm run status) y que el usuario y la contraseña son correctos.', 'Check that PostgreSQL is running (pnpm run status) and that the user name and password are correct.')],
    });
  }
  return client;
}

/** Error text with anything that looks like a credential removed. */
export function safeMessage(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/(postgres(?:ql)?:\/\/)[^@\s/]+@/gi, '$1***@')
    .replace(/((?:SECRET|KEY|TOKEN|PASSWORD)[A-Z_]*\s*[=:]\s*)\S+/gi, '$1***')
    .slice(0, 600);
}

/** Explicit directory, then PATH, then the usual Homebrew locations (Finder has a minimal PATH). */
const toolPaths = new Map();
export function pgTool(name) {
  if (process.env.CAREER_PG_BIN) return join(process.env.CAREER_PG_BIN, name);
  if (toolPaths.has(name)) return toolPaths.get(name);
  if (spawnSync(name, ['--version'], { encoding: 'utf8' }).status === 0) { toolPaths.set(name, name); return name; }
  for (const prefix of ['/opt/homebrew', '/usr/local']) {
    for (const formula of ['postgresql@17', 'libpq']) {
      const candidate = join(prefix, 'opt', formula, 'bin', name);
      if (existsSync(candidate) && spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0) { toolPaths.set(name, candidate); return candidate; }
    }
  }
  return name;
}

/** Major.minor of a PostgreSQL client tool, or a recovery error explaining how to install it. */
export function toolVersion(name) {
  const result = spawnSync(pgTool(name), ['--version'], { encoding: 'utf8' });
  const match = result.status === 0 ? result.stdout.match(/(\d+)(?:\.(\d+))?/) : null;
  if (!match) throw new RecoveryError({
    es: `No se encontró ${name} (herramientas cliente de PostgreSQL).`, en: `${name} (PostgreSQL client tools) was not found.`,
    fixes: [
      fix('macOS: brew install libpq y añade $(brew --prefix libpq)/bin al PATH', 'macOS: brew install libpq and add $(brew --prefix libpq)/bin to PATH'),
      fix('O indica la carpeta con CAREER_PG_BIN=/ruta/a/bin', 'Or point CAREER_PG_BIN=/path/to/bin at the folder'),
    ],
  });
  return { text: `${match[1]}${match[2] ? `.${match[2]}` : ''}`, major: Number(match[1]) };
}

/** Runs a PostgreSQL client tool with credentials in the environment only. stdout/stderr are captured, never echoed raw. */
export function runPgTool(name, args, rawUrl, { envOverrides = {} } = {}) {
  const result = spawnSync(pgTool(name), args, { env: libpqEnv(rawUrl, envOverrides), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? '', stderr: safeMessage(result.stderr || result.error?.message || '') };
}

/** Throws unless the path is a regular file (not a symlink) readable by this user. */
export async function assertRegularFile(path, what) {
  let info;
  try { info = await lstat(path); } catch {
    throw new RecoveryError({ es: `No existe ${what}: ${path}`, en: `${what} does not exist: ${path}` });
  }
  if (!info.isFile()) throw new RecoveryError({ es: `${what} no es un archivo normal: ${path}`, en: `${what} is not a regular file: ${path}` });
  return info;
}

/** Group/other permission bits set on a file or folder (0 when private). */
export async function looseBits(path) {
  try { return (await stat(path)).mode & 0o077; } catch { return 0; }
}

/** Resolves symlinks of the longest existing ancestor, so a not-yet-created path can be compared safely. */
export async function canonicalPath(path) {
  const absolute = resolve(path);
  let existing = absolute;
  const rest = [];
  for (;;) {
    try { return join(await realpath(existing), ...rest.reverse()); } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      rest.push(basename(existing));
      existing = parent;
    }
  }
}

export function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

// ---- Encryption key, fingerprint and manifest authentication ----------------------------------------

function derive(key, info, length) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(key, 'utf8'), Buffer.from('career-agent-stack'), Buffer.from(info), length));
}

/** Public identifier of APP_ENCRYPTION_KEY. Derived one-way, so it reveals nothing about the key. */
export const keyFingerprint = (key) => derive(key, 'backup-key-fingerprint-v1', 16).toString('hex');

export const manifestMac = (key, manifestBytes) => createHmac('sha256', derive(key, 'backup-manifest-hmac-v1', 32)).update(manifestBytes).digest('hex');

export function verifyManifestMac(key, manifestBytes, macText) {
  const expected = Buffer.from(manifestMac(key, manifestBytes), 'hex');
  const actual = Buffer.from(String(macText).trim(), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function keyFileContent(key) {
  return `${JSON.stringify({
    format: KEY_FORMAT, formatVersion: 1, fingerprint: keyFingerprint(key), createdAt: new Date().toISOString(),
    warning: 'APP_ENCRYPTION_KEY of a Career Agent Stack installation. Anyone holding this file and a backup can read and authenticate that backup. Store it separately from the backups (password manager or encrypted drive).',
    aviso: 'APP_ENCRYPTION_KEY de una instalación de Career Agent Stack. Guárdalo aparte de las copias (gestor de contraseñas o disco cifrado).',
    APP_ENCRYPTION_KEY: key,
  }, null, 2)}\n`;
}

/** Reads and validates a key file; returns { key, fingerprint }. */
export async function readKeyFile(path) {
  await assertRegularFile(path, 'El archivo de clave / The key file');
  let parsed;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); } catch { parsed = null; }
  const key = parsed?.APP_ENCRYPTION_KEY;
  if (parsed?.format !== KEY_FORMAT || typeof key !== 'string' || key.length < 32) throw new RecoveryError({
    es: 'El archivo de clave no tiene el formato esperado.', en: 'The key file does not have the expected format.',
    fixes: [fix('Usa el archivo career-key-*.json creado por pnpm run backup.', 'Use the career-key-*.json file created by pnpm run backup.')],
  });
  if (parsed.fingerprint !== keyFingerprint(key)) throw new RecoveryError({ es: 'El archivo de clave está dañado (la huella no coincide).', en: 'The key file is damaged (fingerprint mismatch).' });
  return { key, fingerprint: parsed.fingerprint, loose: await looseBits(path) };
}

// ---- Manifest validation ---------------------------------------------------------------------------

const bad = (es, en) => new ArchiveError('BAD_MANIFEST', `Manifiesto no válido: ${es}`, `Invalid manifest: ${en}`);

/** Names allowed inside the archive (relative to its root folder). */
export function allowedArchiveName(name) {
  if (name === MANIFEST_NAME || name === MANIFEST_MAC_NAME || name === DUMP_NAME) return true;
  return name.startsWith(FILES_PREFIX) && name.length > FILES_PREFIX.length;
}

/** Strict structural check of a parsed manifest. Returns it unchanged when valid. */
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw bad('no es un objeto', 'not an object');
  if (manifest.format !== BACKUP_FORMAT) throw bad('formato desconocido', 'unknown format');
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) throw bad(`versión ${manifest.formatVersion} no admitida`, `version ${manifest.formatVersion} is not supported`);
  if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.documents)) throw bad('faltan listas', 'missing lists');
  const names = new Set();
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.path !== 'string' || !allowedArchiveName(entry.path) || entry.path === MANIFEST_NAME || entry.path === MANIFEST_MAC_NAME) throw bad('entrada no permitida', 'entry not allowed');
    assertSafeRelativePath(entry.path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !SHA256.test(entry.sha256 ?? '')) throw bad(`entrada ${entry.path}`, `entry ${entry.path}`);
    if (names.has(entry.path.toLowerCase())) throw bad('entrada repetida', 'duplicate entry');
    names.add(entry.path.toLowerCase());
  }
  if (!names.has(DUMP_NAME)) throw bad('falta el volcado de la base de datos', 'database dump missing');
  const ids = new Set();
  for (const document of manifest.documents) {
    if (!document || !UUID.test(document.id ?? '') || !UUID.test(document.workspaceId ?? '') || !SHA256.test(document.sha256 ?? '')) throw bad('documento', 'document');
    assertSafeRelativePath(document.storagePath);
    if (document.archivePath !== `${FILES_PREFIX}${document.storagePath}` || !names.has(document.archivePath.toLowerCase())) throw bad(`documento ${document.id}`, `document ${document.id}`);
    if (ids.has(document.id)) throw bad('documento repetido', 'duplicate document');
    ids.add(document.id);
  }
  if (names.size !== manifest.documents.length + 1) throw bad('entradas sin documento', 'entries without a document');
  if (!manifest.encryption || typeof manifest.encryption.keyFingerprint !== 'string') throw bad('falta la huella de la clave', 'key fingerprint missing');
  if (!manifest.tables || typeof manifest.tables !== 'object') throw bad('faltan los recuentos', 'row counts missing');
  for (const [table, count] of Object.entries(manifest.tables)) {
    if (!/^(public|drizzle)\.[a-z_][a-z0-9_]{0,62}$/.test(table) || !Number.isSafeInteger(count) || count < 0) throw bad(`recuento ${table}`, `row count ${table}`);
  }
  if (!Array.isArray(manifest.migrations) || manifest.migrations.some((item) => !SHA256.test(item?.hash ?? ''))) throw bad('migraciones', 'migrations');
  if (typeof manifest.tools?.pgDumpMajor !== 'number') throw bad('versión de pg_dump', 'pg_dump version');
  return manifest;
}

/** Migrations known to this checkout, with the same hash drizzle stores in drizzle.__drizzle_migrations. */
export async function repoMigrations() {
  const folder = join(projectRoot, 'packages/db/migrations');
  const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8'));
  const list = [];
  for (const entry of journal.entries) list.push({ tag: entry.tag, createdAt: String(entry.when), hash: sha256(await readFile(join(folder, `${entry.tag}.sql`), 'utf8')) });
  return list;
}

// ---- Database inspection (inside a caller-controlled transaction) ----------------------------------

/** Exact row counts of every table in the application schemas. */
export async function tableCounts(client) {
  const { rows } = await client.query(`select n.nspname as schema, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and n.nspname in ('public', 'drizzle') order by 1, 2`);
  const counts = {};
  for (const { schema, name } of rows) {
    const result = await client.query(`select count(*)::bigint as count from ${client.escapeIdentifier(schema)}.${client.escapeIdentifier(name)}`);
    counts[`${schema}.${name}`] = Number(result.rows[0].count);
  }
  return counts;
}

export async function hasTable(client, qualified) {
  return (await client.query('select to_regclass($1) is not null as present', [qualified])).rows[0].present;
}

export async function appliedMigrations(client) {
  if (!(await hasTable(client, 'drizzle.__drizzle_migrations'))) return [];
  const { rows } = await client.query('select hash, created_at::text as "createdAt" from drizzle.__drizzle_migrations order by id');
  return rows;
}

export async function documentRows(client) {
  if (!(await hasTable(client, 'public.document_versions'))) return [];
  const { rows } = await client.query('select id::text, workspace_id::text as "workspaceId", storage_path as "storagePath", sha256, media_type as "mediaType" from document_versions order by id');
  return rows;
}

/** Opens a file for exclusive creation with private permissions and writes text to it. */
export async function writePrivateFile(path, text) {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
}

export const humanSize = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`);

/** Shows a path relative to the project when it is inside it. */
export function shown(path) {
  const rel = relative(projectRoot, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
}
