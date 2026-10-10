// Encryption of operational backups with the age format (ADR 019). The age identity is derived from
// APP_ENCRYPTION_KEY, so restoring needs the same key file as before and no new secret. Files are encrypted and
// decrypted as streams, so a large backup is never held in memory. Plaintext only ever lands in a private
// temporary folder, which is removed when the caller is done or anything fails.
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { bech32 } from '@scure/base';
import { Decrypter, Encrypter, identityToRecipient } from 'age-encryption';
import { ageIdentityBytes } from './backup-core.mjs';

/** Every age file starts with this line (https://age-encryption.org/v1). */
export const AGE_HEADER = 'age-encryption.org/v1\n';
export const ENCRYPTED_SUFFIX = '.age';

/** The age X25519 identity (AGE-SECRET-KEY-1…) derived from APP_ENCRYPTION_KEY. */
export function ageIdentity(key) {
  return bech32.encode('age-secret-key-', bech32.toWords(ageIdentityBytes(key)), false).toUpperCase();
}

/** Whether the file starts with the age header; a plain tar backup (format version 1) does not. */
export async function isAgeFile(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(AGE_HEADER.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead === buffer.length && buffer.toString('latin1') === AGE_HEADER;
  } finally { await handle.close(); }
}

/** Encrypts `source` to `destination` (which must not exist) for the identity derived from `key`. */
export async function encryptFile(source, destination, key) {
  const encrypter = new Encrypter();
  encrypter.addRecipient(await identityToRecipient(ageIdentity(key)));
  await streamTo(destination, () => encrypter.encrypt(Readable.toWeb(createReadStream(source))));
}

/**
 * Decrypts `source` to `destination` (which must not exist) with the identity derived from `key`. A wrong key, a
 * truncated file or any alteration throws, and the partial plaintext is removed before the error propagates.
 */
export async function decryptFile(source, destination, key) {
  const decrypter = new Decrypter();
  decrypter.addIdentity(ageIdentity(key));
  await streamTo(destination, () => decrypter.decrypt(Readable.toWeb(createReadStream(source))));
}

/**
 * Writes a stream to a new private file. The file is created first ('wx': an existing file is never touched, 0o600 on
 * POSIX); only if a later step fails is that newly created, partial file removed.
 */
async function streamTo(destination, makeStream) {
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  await once(output, 'open');
  try {
    await pipeline(Readable.fromWeb(await makeStream()), output);
  } catch (error) {
    output.destroy();
    await rm(destination, { force: true });
    throw error;
  }
}

const windows = process.platform === 'win32';

/** The current Windows user as `DOMAIN\name` and its SID, from `whoami`. */
function windowsUser(run = execFileSync) {
  const [name, sid] = run('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).trim().split('","').map((part) => part.replace(/"/g, ''));
  if (!name || !/^S-1-[\d-]+$/.test(sid ?? '')) throw new Error('Could not identify the current Windows user.');
  return { name, sid };
}

/**
 * Access entries of a Windows path, parsed from `icacls` output: the first line starts with the path, each entry is
 * `PRINCIPAL:(flags)…`, and the output ends with a summary line.
 */
export function parseIcacls(output, path) {
  const lines = output.split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean).filter((line) => !/^Successfully processed|^Se procesaron/i.test(line));
  if (!lines.length || !lines[0].toLowerCase().startsWith(path.toLowerCase())) return [];
  lines[0] = lines[0].slice(path.length);
  return lines.map((line) => line.trim()).filter(Boolean).map((entry) => entry.slice(0, entry.indexOf(':(') === -1 ? undefined : entry.indexOf(':(')));
}

/**
 * Restricts a Windows folder to the current user: inheritance removed, full control for the user only. Throws unless
 * `icacls` then lists exactly that user, so a failure stops the caller before any plaintext is written.
 */
export function restrictToCurrentUser(path, run = execFileSync) {
  const user = windowsUser(run);
  run('icacls', [path, '/inheritance:r', '/grant:r', `*${user.sid}:(OI)(CI)F`], { encoding: 'utf8', windowsHide: true });
  const principals = parseIcacls(run('icacls', [path], { encoding: 'utf8', windowsHide: true }), path);
  if (principals.length !== 1 || principals[0].toLowerCase() !== user.name.toLowerCase()) {
    throw new Error(`The temporary folder could not be restricted to ${user.name} (found: ${principals.join(', ') || 'no entries'}).`);
  }
}

/**
 * A new, empty folder readable only by the current user, for decrypted backups (ADR 019): mode 0700 on macOS and
 * Linux, checked after creation; on Windows, created in the user's own temporary folder with a user-only ACL. If the
 * folder cannot be made private, it is removed and an error is thrown, so no plaintext is ever written to it.
 */
export async function privateTempDir(prefix, { parent = tmpdir() } = {}) {
  const folder = await mkdtemp(join(windows ? tmpdir() : parent, prefix));
  try {
    if (windows) restrictToCurrentUser(folder);
    else {
      await chmod(folder, 0o700);
      if ((await stat(folder)).mode & 0o077) throw new Error('The temporary folder is accessible to other users.');
    }
    return folder;
  } catch (error) {
    await rm(folder, { recursive: true, force: true });
    throw error;
  }
}
