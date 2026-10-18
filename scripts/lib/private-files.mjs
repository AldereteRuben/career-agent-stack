import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

const windows = process.platform === 'win32';
const privateFailure = (path) => new Error(`No se pudo verificar que ${path} sea privado; se detuvo la operación. / Could not verify that ${path} is private; the operation was stopped.`);

function windowsUser(run = execFileSync) {
  const [name, sid] = run('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).trim().split('","').map((part) => part.replace(/"/g, ''));
  if (!name || !/^S-1-[\d-]+$/.test(sid ?? '')) throw new Error('Could not identify the current Windows user.');
  return { name, sid };
}

function icaclsEntries(output, path) {
  const lines = output.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  if (!lines.length || !lines[0].toLowerCase().startsWith(path.toLowerCase())) return [];
  lines[0] = lines[0].slice(path.length);
  // ACE lines contain the invariant `:(...)` syntax. Ignore localized status summaries by shape.
  return lines.map((line) => line.trim()).filter((line) => line.includes(':('));
}

export function parseIcacls(output, path) {
  return icaclsEntries(output, path).map((entry) => entry.slice(0, entry.indexOf(':(')));
}

export function restrictToCurrentUser(path, run = execFileSync, { file = false } = {}) {
  const user = windowsUser(run);
  const icacls = (...args) => run('icacls', [path, ...args], { encoding: 'utf8', windowsHide: true });
  const others = (listing) => parseIcacls(listing, path).filter((name) => name.toLowerCase() !== user.name.toLowerCase());
  icacls('/inheritance:r', '/grant:r', `*${user.sid}:${file ? '' : '(OI)(CI)'}F`);
  for (const other of others(icacls())) icacls('/remove:g', other);
  const listing = icacls();
  const principals = parseIcacls(listing, path);
  if (principals.length !== 1 || others(listing).length) {
    throw new Error(`The path could not be restricted to ${user.name} (found: ${principals.join(', ') || 'no entries'}).`);
  }
}

export async function isPrivate(path, run = execFileSync) {
  try {
    if (windows) {
      const user = windowsUser(run);
      const listing = run('icacls', [path], { encoding: 'utf8', windowsHide: true });
      const principals = parseIcacls(listing, path);
      const entries = icaclsEntries(listing, path);
      return principals.length === 1 && principals[0].toLowerCase() === user.name.toLowerCase()
        && entries.length === 1 && !/\(I\)/i.test(entries[0]) && /\(F\)/i.test(entries[0]);
    }
    return ((await stat(path)).mode & 0o077) === 0;
  } catch { return false; }
}

export async function ensurePrivateDir(path, run = execFileSync) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    if (windows) restrictToCurrentUser(path, run);
    else await chmod(path, 0o700);
    if (!(await isPrivate(path, run))) throw privateFailure(path);
  } catch (cause) {
    throw new Error(privateFailure(path).message, { cause });
  }
  return path;
}

/** Restrict an empty or existing regular file before a caller writes private contents to it. */
export async function ensurePrivateFile(path, { create = true, run = execFileSync } = {}) {
  try {
    let info;
    try { info = await lstat(path); }
    catch (error) {
      if (!create || error?.code !== 'ENOENT') throw error;
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      await handle.close();
      info = await lstat(path);
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected a regular file.');
    if (windows) restrictToCurrentUser(path, run, { file: true });
    else await chmod(path, 0o600);
    if (!(await isPrivate(path, run))) throw privateFailure(path);
  } catch (cause) {
    throw new Error(privateFailure(path).message, { cause });
  }
  return path;
}

export async function isPrivateTree(path, run = execFileSync) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !(await isPrivate(path, run))) return false;
    if (info.isDirectory()) {
      for (const entry of await readdir(path)) if (!(await isPrivateTree(join(path, entry), run))) return false;
      return true;
    }
    return info.isFile();
  } catch { return false; }
}

export async function ensurePrivateTree(path, run = execFileSync) {
  const info = await lstat(path).catch((error) => { if (error?.code === 'ENOENT') return null; throw error; });
  if (!info) return ensurePrivateDir(path, run);
  if (info.isSymbolicLink()) throw privateFailure(path);
  if (info.isDirectory()) {
    await ensurePrivateDir(path, run);
    for (const entry of await readdir(path)) await ensurePrivateTree(join(path, entry), run);
    return path;
  }
  if (!info.isFile()) throw privateFailure(path);
  return ensurePrivateFile(path, { create: false, run });
}
