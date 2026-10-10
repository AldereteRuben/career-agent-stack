// Building blocks of pnpm run uninstall (ADR 020): who owns a database, which folders may be deleted, and the
// progress file that lets an interrupted run resume. Nothing here deletes anything by itself except dropDatabase,
// dropRole and deletePath, which the caller runs only after every check has passed.
import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { allowAdminToUseRole, runAsRole } from './bootstrap-database.mjs';
import { restrictToCurrentUser } from './backup-crypto.mjs';
import { RecoveryError, writePrivateFileAtomic } from './local-env.mjs';

export const PROGRESS_NAME = '.uninstall-progress.json';
export const PROGRESS_FORMAT = 'career-agent-stack-uninstall';
/** Paths inside an installation folder that are never deleted as data, nor allowed to overlap a data folder. */
export const RESERVED = ['.git', 'node_modules', 'apps', 'packages', 'scripts', 'docs', '.github', 'backups'];
const ID = /^[a-z0-9_]{1,40}$/;

export const installMark = (id) => `career-agent-stack install ${id}`;
export const restoreMark = (id) => `career-agent-stack restore ${id}`;

/**
 * Who this installation is, from its .env: a restored installation (CAREER_RESTORE_ID, its own database, the
 * original installation's role) or one made by bootstrap (CAREER_INSTALL_ID). `managed` says whether bootstrap
 * created the database and role, so they carry its mark. Null when the .env has no usable id.
 */
export function identityOf(env) {
  if (env?.CAREER_RESTORE_ID) return ID.test(env.CAREER_RESTORE_ID) ? { kind: 'restore', id: env.CAREER_RESTORE_ID, mark: restoreMark(env.CAREER_RESTORE_ID), managed: true } : null;
  if (env?.CAREER_INSTALL_ID) return ID.test(env.CAREER_INSTALL_ID) ? { kind: 'install', id: env.CAREER_INSTALL_ID, mark: installMark(env.CAREER_INSTALL_ID), managed: env.CAREER_DATABASE_MODE === 'created' } : null;
  return null;
}

const inside = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};
const refuse = (es, en) => ({ ok: false, reason: { es, en } });

/**
 * Whether a configured data path may be deleted (ADR 020): it must be inside the installation folder and not the
 * folder itself, must neither be nor contain nor sit inside a reserved path or the backup folder, and no part of it
 * below the installation folder may be a symbolic link, the configured path itself included.
 * Returns { ok: true, path, exists } with the path below the real installation folder, or { ok: false, reason }.
 */
export async function checkDeletablePath(path, { root, backupDir = join(root, 'backups'), reserved = RESERVED }) {
  const rootReal = await realpath(root);
  const absolute = resolve(path);
  let rel;
  if (inside(absolute, root)) rel = relative(root, absolute);
  else if (inside(absolute, rootReal)) rel = relative(rootReal, absolute);
  else return refuse(`${path} está fuera de la carpeta de la instalación.`, `${path} is outside the installation folder.`);
  if (rel === '') return refuse(`${path} es la propia carpeta de la instalación.`, `${path} is the installation folder itself.`);
  const target = join(rootReal, rel);
  const backups = join(rootReal, relative(root, resolve(backupDir)));
  for (const name of [...reserved.map((entry) => join(rootReal, entry)), backups]) {
    if (inside(target, name) || inside(name, target)) return refuse(`${path} coincide con ${relative(rootReal, name) || name}, que no se borra como datos.`, `${path} overlaps ${relative(rootReal, name) || name}, which is never deleted as data.`);
  }
  let current = rootReal;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (error.code === 'ENOENT') return { ok: true, path: target, exists: false };
      throw error;
    }
    if (info.isSymbolicLink()) return refuse(`${path} pasa por un enlace simbólico (${relative(rootReal, current)}).`, `${path} goes through a symbolic link (${relative(rootReal, current)}).`);
  }
  return { ok: true, path: target, exists: true };
}

/** Number of files and bytes under a path, without following symbolic links. */
export async function measure(path) {
  let files = 0; let bytes = 0;
  const walk = async (current) => {
    let info;
    try { info = await lstat(current); } catch { return; }
    if (info.isDirectory()) { for (const entry of await readdir(current)) await walk(join(current, entry)); return; }
    files += 1; bytes += info.size;
  };
  await walk(path);
  return { files, bytes };
}

/** Deletes a file or folder. `rm` removes a symbolic link inside the folder, never what it points to. */
export async function deletePath(path) {
  await rm(path, { recursive: true, force: true });
}

export const progressPath = (folder) => join(folder, PROGRESS_NAME);

/** Steps the uninstaller records as done, in order. */
export const STEPS = ['database', 'role', 'data', 'backups', 'env'];
const NAME_PATTERN = /^[A-Za-z0-9_]{1,63}$/;
const NAME = { test: (value) => typeof value === 'string' && NAME_PATTERN.test(value) };
const isText = (value) => typeof value === 'string' && value.length > 0 && value.length < 4096;

/**
 * Whether a progress file has exactly the expected shape for this folder. Its contents are never trusted to say
 * WHAT to delete (the caller rebuilds that from .env); this only rejects files that are not ours or were edited.
 */
export function validProgress(progress, folder) {
  if (!progress || typeof progress !== 'object' || progress.format !== PROGRESS_FORMAT || progress.version !== 1) return false;
  if (!['install', 'restore'].includes(progress.kind) || typeof progress.id !== 'string' || !ID.test(progress.id) || progress.folder !== folder) return false;
  if (!Array.isArray(progress.done) || !progress.done.every((step) => STEPS.includes(step)) || new Set(progress.done).size !== progress.done.length) return false;
  // The database is either one this script manages (named, with its owner) or explicitly one it does not manage
  // (`unmanaged`, left in place with --skip-database). Missing names never mean "nothing to check".
  const managed = progress.database !== null;
  if (managed && !(progress.database && NAME.test(progress.database.name) && NAME.test(progress.database.owner) && isText(progress.database.server))) return false;
  if (!managed && !(isText(progress.unmanaged) && progress.unmanaged.length <= 63)) return false;
  if (managed && progress.unmanaged !== undefined && progress.unmanaged !== null) return false;
  // A bootstrap installation drops the database's own role; a restored one never drops a role.
  if (progress.kind === 'install' && managed && progress.role !== progress.database.owner) return false;
  if ((progress.kind === 'restore' || !managed) && progress.role !== null) return false;
  return true;
}

/** The progress of an interrupted uninstall in this folder, or null. A file that is not ours, or was edited, is refused. */
export async function readProgress(folder) {
  let text;
  try { text = await readFile(progressPath(folder), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let progress;
  try { progress = JSON.parse(text); } catch { progress = null; }
  if (!validProgress(progress, folder)) {
    throw new RecoveryError({
      es: `${progressPath(folder)} no es un archivo de progreso de desinstalación válido; no se toca nada.`,
      en: `${progressPath(folder)} is not a valid uninstall progress file; nothing is touched.`,
    });
  }
  return progress;
}

/** Writes the progress file privately: mode 0600, and on Windows an ACL for the current user only. */
export async function writeProgress(folder, progress) {
  const path = progressPath(folder);
  await writePrivateFileAtomic(path, `${JSON.stringify(progress, null, 2)}\n`);
  if (process.platform === 'win32') restrictToCurrentUser(path, undefined, { file: true });
}

// ---- PostgreSQL ----------------------------------------------------------------------------------------

/** Owner and mark of a database, or { exists: false }. Readable by any role, so no privilege is needed. */
export async function inspectDatabase(client, name) {
  const { rows } = await client.query(`select pg_get_userbyid(datdba) as owner, shobj_description(oid, 'pg_database') as mark from pg_database where datname = $1`, [name]);
  return rows.length ? { exists: true, owner: rows[0].owner, mark: rows[0].mark } : { exists: false };
}

/**
 * Mark of a role and what still depends on it: databases it owns, and objects or privileges in other databases
 * (pg_shdepend). Dropping a role with dependencies would fail, and `DROP OWNED` would delete other data, so the
 * uninstaller stops and lists them instead.
 */
export async function inspectRole(client, name) {
  const { rows: [role] } = await client.query(`select oid, shobj_description(oid, 'pg_authid') as mark from pg_roles where rolname = $1`, [name]);
  if (!role) return { exists: false };
  const owned = await client.query('select datname from pg_database where datdba = $1 order by datname', [role.oid]);
  const elsewhere = await client.query(
    `select coalesce(d.datname, '(shared)') as database, count(*)::int as count from pg_shdepend s left join pg_database d on d.oid = s.dbid
      where s.refclassid = 'pg_authid'::regclass and s.refobjid = $1 and s.deptype <> 'p' group by 1 order by 1`, [role.oid]);
  return { exists: true, mark: role.mark, ownedDatabases: owned.rows.map((row) => row.datname), dependencies: elsewhere.rows };
}

const isSuperuser = async (client) => (await client.query('select rolsuper from pg_roles where rolname = current_user')).rows[0]?.rolsuper === true;

/**
 * Drops a database the caller has verified. Only its owner (or a superuser) may drop it, so a CREATEROLE
 * administrator acts as the owner for that one statement, as bootstrap does to create it. A database still in use
 * is not forced: the error says so.
 */
export async function dropDatabase(client, name, owner) {
  const statement = () => client.query(`drop database ${client.escapeIdentifier(name)}`);
  try {
    if (await isSuperuser(client)) await statement();
    else { await allowAdminToUseRole(client, owner); await runAsRole(client, owner, statement); }
  } catch (error) {
    if (error?.code === '55006') throw new RecoveryError({
      es: `La base de datos «${name}» sigue en uso por otra conexión, así que no se borra.`, en: `Database "${name}" is still in use by another connection, so it is not dropped.`,
      fixes: [{ es: 'Cierra los programas conectados a ella (psql, un editor de bases de datos, la app) y vuelve a ejecutar el mismo comando.', en: 'Close the programs connected to it (psql, a database editor, the app) and run the same command again.' }],
    });
    throw error;
  }
}

/** Drops a role the caller has verified and found without dependencies. Never `DROP OWNED`. */
export async function dropRole(client, name) {
  await client.query(`drop role ${client.escapeIdentifier(name)}`);
}
