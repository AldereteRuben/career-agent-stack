// Minimal, strict tar (ustar) writer and reader for operational backups.
// The writer only produces regular files with safe relative names. The reader accepts nothing else:
// links, directories, devices, pax/GNU extensions, absolute paths, "..", duplicates, bad header
// checksums, truncated data and trailing garbage are rejected before anything leaves the staging folder.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const BLOCK = 512;
const CHUNK = 1024 * 1024;
export const ARCHIVE_ROOT = 'career-backup';
export const MAX_ENTRIES = 200_000;
// One safe path segment: starts with a letter or digit, then letters, digits, dot, underscore or dash.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** An archive that must not be trusted. `code` is stable for tests; messages are bilingual. */
export class ArchiveError extends Error {
  constructor(code, es, en) {
    super(en);
    this.code = code;
    this.es = es;
    this.en = en;
  }
}

/** Throws unless `name` is a relative path made only of safe segments (no "..", no absolute path, no backslash). */
export function assertSafeRelativePath(name, { maxLength = 255 } = {}) {
  const bad = (why) => new ArchiveError('UNSAFE_PATH', `Ruta no permitida en la copia (${why}): ${JSON.stringify(String(name).slice(0, 120))}`, `Path not allowed in the backup (${why}): ${JSON.stringify(String(name).slice(0, 120))}`);
  if (typeof name !== 'string' || !name.length) throw bad('vacía / empty');
  if (name.length > maxLength) throw bad('demasiado larga / too long');
  if (name.includes('\0') || name.includes('\\')) throw bad('carácter no permitido / forbidden character');
  if (name.startsWith('/') || isAbsolute(name) || /^[A-Za-z]:/.test(name)) throw bad('absoluta / absolute');
  const segments = name.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '.') throw bad('sale de la carpeta / escapes the folder');
    if (!SEGMENT.test(segment)) throw bad('nombre no permitido / name not allowed');
  }
  return segments;
}

/** Joins a validated relative path under `root` and proves the result is still inside `root`. */
export function safeJoin(root, name) {
  const segments = assertSafeRelativePath(name);
  const target = resolve(root, ...segments);
  const rel = relative(resolve(root), target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ArchiveError('UNSAFE_PATH', `La ruta sale de la carpeta de destino: ${name}`, `The path escapes the destination folder: ${name}`);
  }
  return target;
}

function octal(value, length) {
  const text = value.toString(8);
  if (text.length > length - 1) throw new Error(`Value too large for tar field: ${value}`);
  return `${text.padStart(length - 1, '0')}\0`;
}

/** Builds one ustar header. Exported for tests that need to craft hostile archives. */
export function buildHeader(name, size, { type = '0', mode = 0o600, mtime = 0, linkname = '' } = {}) {
  const header = Buffer.alloc(BLOCK);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw new Error(`Name too long for ustar: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  header.write(base, 0, 100, 'utf8');
  header.write(octal(mode, 8), 100, 8, 'ascii');
  header.write(octal(0, 8), 108, 8, 'ascii');
  header.write(octal(0, 8), 116, 8, 'ascii');
  header.write(octal(size, 12), 124, 12, 'ascii');
  header.write(octal(mtime, 12), 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write(type, 156, 1, 'ascii');
  header.write(linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

const padding = (size) => (BLOCK - (size % BLOCK)) % BLOCK;

/**
 * Writes a new archive (fails if `outPath` exists). Each entry is { name, buffer } or { name, path, sha256? }.
 * File entries are hashed while copied; when `sha256` is given the copy must match it exactly
 * (a file that changes or shrinks during the copy fails the backup instead of producing a silent mismatch).
 * Returns [{ name, size, sha256 }].
 */
export async function writeArchive(outPath, entries) {
  const out = await open(outPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  const written = [];
  const seen = new Set();
  try {
    for (const entry of entries) {
      const name = `${ARCHIVE_ROOT}/${entry.name}`;
      assertSafeRelativePath(name);
      if (seen.has(name.toLowerCase())) throw new Error(`Duplicate archive entry: ${entry.name}`);
      seen.add(name.toLowerCase());
      const hash = createHash('sha256');
      if (entry.buffer) {
        await out.write(buildHeader(name, entry.buffer.length));
        await out.write(entry.buffer);
        hash.update(entry.buffer);
        if (padding(entry.buffer.length)) await out.write(Buffer.alloc(padding(entry.buffer.length)));
        written.push({ name: entry.name, size: entry.buffer.length, sha256: hash.digest('hex') });
        continue;
      }
      const source = await open(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await source.stat();
        if (!info.isFile()) throw new Error(`Not a regular file: ${entry.name}`);
        const size = info.size;
        await out.write(buildHeader(name, size));
        const buffer = Buffer.alloc(Math.min(CHUNK, Math.max(size, 1)));
        let copied = 0;
        while (copied < size) {
          const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, size - copied), copied);
          if (bytesRead === 0) throw new Error(`File shrank while copying: ${entry.name}`);
          hash.update(buffer.subarray(0, bytesRead));
          await out.write(buffer, 0, bytesRead);
          copied += bytesRead;
        }
        if (padding(size)) await out.write(Buffer.alloc(padding(size)));
        const sha256 = hash.digest('hex');
        if (entry.sha256 && entry.sha256 !== sha256) {
          throw new ArchiveError('SOURCE_HASH_MISMATCH', `El archivo ${entry.name} no coincide con el hash registrado en la base de datos.`, `File ${entry.name} does not match the hash recorded in the database.`);
        }
        written.push({ name: entry.name, size, sha256 });
      } finally { await source.close(); }
    }
    await out.write(Buffer.alloc(BLOCK * 2));
    await out.sync();
  } finally { await out.close(); }
  return written;
}

function field(header, start, length) {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

function parseOctal(header, start, length, what) {
  if (header[start] & 0x80) throw new ArchiveError('BAD_HEADER', `Campo ${what} con formato no admitido.`, `Unsupported ${what} field encoding.`);
  const text = field(header, start, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new ArchiveError('BAD_HEADER', `Campo ${what} no válido en la copia.`, `Invalid ${what} field in the backup.`);
  return Number.parseInt(text, 8);
}

const TYPE_NAMES = { '1': 'hard link', '2': 'symlink', '3': 'character device', '4': 'block device', '5': 'directory', '6': 'FIFO', '7': 'contiguous file', g: 'pax global header', x: 'pax header', L: 'GNU long name', K: 'GNU long link' };

/**
 * Extracts every entry of `archivePath` into `destDir` (which must be a new, private, empty folder that only
 * this process writes to). Entry names must start with ARCHIVE_ROOT/ and be accepted by `allowName(innerName)`.
 * Returns a Map innerName -> { size, sha256, path }.
 */
export async function extractArchive(archivePath, destDir, { allowName = () => true, maxEntries = MAX_ENTRIES } = {}) {
  const input = await open(archivePath, constants.O_RDONLY);
  const entries = new Map();
  const seen = new Set();
  try {
    const { size: total } = await input.stat();
    if (total < BLOCK * 2 || total % BLOCK !== 0) throw new ArchiveError('TRUNCATED', 'La copia está incompleta o dañada (tamaño no válido).', 'The backup is incomplete or damaged (invalid size).');
    const header = Buffer.alloc(BLOCK);
    let offset = 0;
    let ended = false;
    while (offset + BLOCK <= total) {
      await input.read(header, 0, BLOCK, offset);
      if (header.every((byte) => byte === 0)) { ended = true; offset += BLOCK; break; }
      let sum = 0;
      for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 32 : header[index];
      if (parseOctal(header, 148, 8, 'checksum') !== sum) throw new ArchiveError('BAD_HEADER', 'Cabecera dañada en la copia (suma de control).', 'Damaged header in the backup (checksum).');
      if (header.toString('ascii', 257, 263) !== 'ustar\0' || header.toString('ascii', 263, 265) !== '00') throw new ArchiveError('BAD_HEADER', 'Formato de archivo no reconocido.', 'Unrecognised archive format.');
      const type = String.fromCharCode(header[156]);
      if (type !== '0' && header[156] !== 0) {
        throw new ArchiveError('UNSUPPORTED_ENTRY', `La copia contiene una entrada no permitida (${TYPE_NAMES[type] ?? `tipo ${type}`}).`, `The backup contains an entry that is not allowed (${TYPE_NAMES[type] ?? `type ${type}`}).`);
      }
      const prefix = field(header, 345, 155);
      const fullName = prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100);
      assertSafeRelativePath(fullName);
      if (!fullName.startsWith(`${ARCHIVE_ROOT}/`)) throw new ArchiveError('UNSAFE_PATH', `Entrada fuera de ${ARCHIVE_ROOT}/: ${fullName}`, `Entry outside ${ARCHIVE_ROOT}/: ${fullName}`);
      const name = fullName.slice(ARCHIVE_ROOT.length + 1);
      if (!allowName(name)) throw new ArchiveError('UNEXPECTED_ENTRY', `Entrada inesperada en la copia: ${name}`, `Unexpected entry in the backup: ${name}`);
      if (seen.has(name.toLowerCase())) throw new ArchiveError('DUPLICATE_ENTRY', `Entrada repetida en la copia: ${name}`, `Duplicate entry in the backup: ${name}`);
      seen.add(name.toLowerCase());
      if (entries.size >= maxEntries) throw new ArchiveError('TOO_MANY_ENTRIES', 'La copia tiene demasiadas entradas.', 'The backup has too many entries.');
      const size = parseOctal(header, 124, 12, 'size');
      const dataStart = offset + BLOCK;
      if (dataStart + size + padding(size) > total) throw new ArchiveError('TRUNCATED', 'La copia está incompleta (datos cortados).', 'The backup is incomplete (data cut short).');

      const target = safeJoin(destDir, name);
      await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
      const output = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      const hash = createHash('sha256');
      try {
        const buffer = Buffer.alloc(Math.min(CHUNK, Math.max(size, 1)));
        let copied = 0;
        while (copied < size) {
          const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - copied), dataStart + copied);
          if (bytesRead === 0) throw new ArchiveError('TRUNCATED', 'La copia está incompleta.', 'The backup is incomplete.');
          hash.update(buffer.subarray(0, bytesRead));
          await output.write(buffer, 0, bytesRead);
          copied += bytesRead;
        }
        await output.sync();
      } finally { await output.close(); }
      entries.set(name, { size, sha256: hash.digest('hex'), path: target });
      offset = dataStart + size + padding(size);
    }
    if (!ended) throw new ArchiveError('TRUNCATED', 'La copia está incompleta (falta el final del archivo).', 'The backup is incomplete (end-of-archive marker missing).');
    // Only zero padding may follow the end marker.
    const rest = Buffer.alloc(BLOCK);
    for (; offset < total; offset += BLOCK) {
      await input.read(rest, 0, BLOCK, offset);
      if (!rest.every((byte) => byte === 0)) throw new ArchiveError('TRAILING_DATA', 'Hay datos añadidos después del final de la copia.', 'Data was appended after the end of the backup.');
    }
  } finally { await input.close(); }
  return entries;
}

/** Publish without replacing any existing destination, including on drives without hard links.
 * The caller verifies the destination archive before reporting success.
 */
export async function publishArchive(source, destination, { linkFile = link, copy = copyFile } = {}) {
  try { await linkFile(source, destination); }
  catch (error) {
    if (!['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM'].includes(error.code)) throw error;
    await copy(source, destination, constants.COPYFILE_EXCL);
    const file = await open(destination, 'r+');
    try { await file.sync(); } finally { await file.close(); }
  }
}
