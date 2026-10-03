// Opens a backup archive into a private staging folder and proves it is complete and unmodified:
// strict tar parsing (see backup-archive.mjs), manifest structure, per-entry size and SHA-256,
// no unlisted entries, manifest HMAC with the installation key (when the key is provided),
// and a readable PostgreSQL custom-format dump.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { RecoveryError } from './local-env.mjs';
import { ArchiveError, extractArchive } from './backup-archive.mjs';
import {
  DUMP_NAME, MANIFEST_MAC_NAME, MANIFEST_NAME, allowedArchiveName, assertRegularFile, fix, keyFingerprint, pgTool, safeMessage,
  toolVersion, validateManifest, verifyManifestMac,
} from './backup-core.mjs';

const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

/**
 * @param {string} archivePath
 * @param {string} stagingDir new private folder; extracted entries are left there for the caller
 * @param {{ key?: string }} options without a key the archive is checked for integrity only, not authenticity
 * @returns {Promise<{ manifest: any, authenticated: boolean, dumpPath: string, files: Map<string, { size: number, sha256: string, path: string }>, tocEntries: number }>}
 */
export async function openArchive(archivePath, stagingDir, { key } = {}) {
  await assertRegularFile(archivePath, 'La copia / The backup');
  const files = await extractArchive(archivePath, stagingDir, { allowName: allowedArchiveName });
  const manifestFile = files.get(MANIFEST_NAME);
  const macFile = files.get(MANIFEST_MAC_NAME);
  if (!manifestFile || !macFile) throw new ArchiveError('BAD_MANIFEST', 'La copia no contiene manifiesto firmado.', 'The backup does not contain a signed manifest.');
  if (manifestFile.size > MAX_MANIFEST_BYTES) throw new ArchiveError('BAD_MANIFEST', 'El manifiesto es demasiado grande.', 'The manifest is too large.');
  const manifestBytes = await readFile(manifestFile.path);
  let parsed;
  try { parsed = JSON.parse(manifestBytes.toString('utf8')); } catch {
    throw new ArchiveError('BAD_MANIFEST', 'El manifiesto no es JSON válido.', 'The manifest is not valid JSON.');
  }

  let authenticated = false;
  if (key) {
    // Checked first only to give a clearer message; the HMAC below is what proves authenticity.
    if (parsed?.encryption?.keyFingerprint !== keyFingerprint(key)) throw new ArchiveError('KEY_MISMATCH',
      'La clave indicada no es la de la instalación que creó esta copia.', 'The key provided is not the key of the installation that created this backup.');
    if (!verifyManifestMac(key, manifestBytes, await readFile(macFile.path, 'utf8'))) throw new ArchiveError('MAC_MISMATCH',
      'El manifiesto de la copia fue modificado (firma HMAC no válida).', 'The backup manifest was modified (invalid HMAC signature).');
    authenticated = true;
  }
  const manifest = validateManifest(parsed);

  const listed = new Set([MANIFEST_NAME, MANIFEST_MAC_NAME]);
  for (const entry of manifest.entries) {
    listed.add(entry.path);
    const actual = files.get(entry.path);
    if (!actual) throw new ArchiveError('MISSING_ENTRY', `Falta en la copia: ${entry.path}`, `Missing from the backup: ${entry.path}`);
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) throw new ArchiveError('CHECKSUM_MISMATCH',
      `El contenido de ${entry.path} no coincide con el manifiesto (copia dañada o modificada).`, `The content of ${entry.path} does not match the manifest (damaged or modified backup).`);
  }
  for (const name of files.keys()) {
    if (!listed.has(name)) throw new ArchiveError('UNEXPECTED_ENTRY', `Entrada no declarada en el manifiesto: ${name}`, `Entry not declared in the manifest: ${name}`);
  }

  const pgRestore = toolVersion('pg_restore');
  if (pgRestore.major < manifest.tools.pgDumpMajor) throw new RecoveryError({
    es: `Esta copia se creó con pg_dump ${manifest.tools.pgDump}; pg_restore ${pgRestore.text} es demasiado antiguo para leerla.`,
    en: `This backup was created with pg_dump ${manifest.tools.pgDump}; pg_restore ${pgRestore.text} is too old to read it.`,
    fixes: [fix(`Instala las herramientas cliente de PostgreSQL ${manifest.tools.pgDumpMajor} o posterior (brew install libpq).`, `Install PostgreSQL client tools ${manifest.tools.pgDumpMajor} or newer (brew install libpq).`)],
  });
  const dumpPath = files.get(DUMP_NAME).path;
  // --list reads the archive's table of contents without connecting to any database.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PG')));
  const list = spawnSync(pgTool('pg_restore'), ['--list', dumpPath], { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (list.error || list.status !== 0) throw new ArchiveError('BAD_DUMP',
    `pg_restore no puede leer el volcado: ${safeMessage(list.stderr || list.error?.message)}`, `pg_restore cannot read the dump: ${safeMessage(list.stderr || list.error?.message)}`);
  const tocEntries = list.stdout.split('\n').filter((line) => /^\d+;/.test(line)).length;
  return { manifest, authenticated, dumpPath, files, tocEntries };
}

/** Converts an ArchiveError into the bilingual recovery format used by every script. */
export function archiveRecovery(error) {
  if (!(error instanceof ArchiveError)) return error;
  return new RecoveryError({
    es: `Copia rechazada: ${error.es}`, en: `Backup rejected: ${error.en}`,
    fixes: [
      fix('No uses esta copia. Prueba con otra copia o crea una nueva con pnpm run backup.', 'Do not use this backup. Try another backup or create a new one with pnpm run backup.'),
      fix('Si la copia viajó por red o USB, vuelve a copiarla desde el original y compárala con su archivo .sha256.', 'If the backup travelled over a network or USB drive, copy it again from the original and compare it with its .sha256 file.'),
    ],
  });
}
