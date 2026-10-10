// Verified, encrypted operational backup of the local workspace: PostgreSQL custom dump + generated documents +
// signed manifest in a tar, encrypted with age for an identity derived from APP_ENCRYPTION_KEY (ADR 019).
//
//   pnpm run backup                       write backups/career-backup-<UTC time>.tar.age and its .sha256
//   pnpm run backup --out-dir <dir>    write somewhere else (for example an encrypted external drive)
//   pnpm run backup --key-dir <dir>    write the separate key file somewhere else
//   pnpm run backup --env-file <path>  back up the installation described by another .env
//
// Consistency: the database is read inside one REPEATABLE READ snapshot (pg_export_snapshot + pg_dump --snapshot);
// the document list, row counts and migrations come from that same snapshot, and every document file is hashed
// while it is copied and must match the hash the snapshot recorded. The application can keep running.
// The plain tar only exists in a private temporary folder (see privateTempDir). The encrypted archive is decrypted
// again into another private folder and fully verified before the command reports success.
// Never included: .env, APP_SESSION_SECRET, sign-in tokens, logs, run records, browser state.
// APP_ENCRYPTION_KEY is written to a separate private key file (career-key-<fingerprint>.json), never into the archive;
// without that file the backup can be neither read nor restored.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { RecoveryError, describeDatabase, ok, printRecovery, projectRoot, say, step, warn } from './lib/local-env.mjs';
import { ArchiveError, assertSafeRelativePath, safeJoin, writeArchive, publishArchive } from './lib/backup-archive.mjs';
import {
  BACKUP_FORMAT, BACKUP_FORMAT_VERSION, DUMP_NAME, FILES_PREFIX, MANIFEST_MAC_NAME, MANIFEST_NAME, appliedMigrations, canonicalPath, connect,
  databaseLabel, documentRows, fix, hasTable, humanSize, keyFileContent, keyFingerprint, looseBits, manifestMac, projectPath, readEnvFile, readKeyFile,
  runPgTool, safeMessage, shown, tableCounts, toolVersion, writePrivateFile,
} from './lib/backup-core.mjs';
import { archiveRecovery, openArchive } from './lib/backup-verify.mjs';
import { ENCRYPTED_SUFFIX, ageIdentity, decryptFile, encryptFile, privateTempDir } from './lib/backup-crypto.mjs';

const usage = () => {
  say('Uso: pnpm run backup [--out-dir <carpeta>] [--key-dir <carpeta>] [--env-file <ruta>]', 'Usage: pnpm run backup [--out-dir <folder>] [--key-dir <folder>] [--env-file <path>]');
  say('  Crea una copia verificada (base de datos + documentos) y un archivo de clave aparte. Ver docs/operations/backup-restore.md', 'Creates a verified backup (database + documents) and a separate key file. See docs/operations/backup-restore.md');
};

function parseOptions() {
  try {
    // pnpm forwards the `--` of `pnpm run x -- --flag` literally.
    const args = process.argv.slice(2);
    if (args[0] === '--') args.shift();
    return parseArgs({
      args, options: { 'out-dir': { type: 'string' }, 'key-dir': { type: 'string' }, 'env-file': { type: 'string' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: false }).values;
  } catch (error) {
    throw new RecoveryError({ es: `Opción no válida: ${safeMessage(error)}`, en: `Invalid option: ${safeMessage(error)}`, fixes: [fix('Consulta: pnpm run backup --help', 'See: pnpm run backup --help')] });
  }
}

async function privateDir(path, label) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory()) throw new RecoveryError({ es: `${label.es} no es una carpeta: ${path}`, en: `${label.en} is not a folder: ${path}` });
  if (await looseBits(path)) warn(`La carpeta ${shown(path)} es accesible por otros usuarios; considera: chmod 700 "${shown(path)}"`, `Folder ${shown(path)} is accessible to other users; consider: chmod 700 "${shown(path)}"`);
}

async function hashFile(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

async function countFiles(root) {
  let count = 0;
  const visit = async (dir) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) await visit(join(dir, entry.name));
      else count += 1;
    }
  };
  await visit(root);
  return count;
}

async function main() {
  const options = parseOptions();
  if (options.help) return usage();

  const envFile = resolve(options['env-file'] ?? join(projectRoot, '.env'));
  const env = await readEnvFile(envFile);
  if (!env) throw new RecoveryError({ es: `No existe ${shown(envFile)}: no hay instalación que copiar.`, en: `${shown(envFile)} does not exist: there is no installation to back up.`, fixes: [fix('Prepara la instalación con pnpm run bootstrap.', 'Prepare the installation with pnpm run bootstrap.')] });
  const databaseUrl = env.DATABASE_URL ?? '';
  const database = describeDatabase(databaseUrl);
  if (!database) throw new RecoveryError({ es: 'DATABASE_URL no es una URL de PostgreSQL válida.', en: 'DATABASE_URL is not a valid PostgreSQL URL.' });
  const key = env.APP_ENCRYPTION_KEY ?? '';
  if (key.length < 32) throw new RecoveryError({
    es: 'Falta APP_ENCRYPTION_KEY en .env; sin ella la copia no se podría restaurar ni autenticar.', en: 'APP_ENCRYPTION_KEY is missing from .env; without it the backup could not be restored or authenticated.',
    fixes: [fix('No generes una clave nueva si ya hay datos: recupera la original.', 'Do not generate a new key if data already exists: recover the original one.')],
  });
  const filesRoot = projectPath(env.FILES_LOCAL_PATH || './data/files');
  const outDir = await canonicalPath(options['out-dir'] ?? join(projectRoot, 'backups'));
  const keyDir = await canonicalPath(options['key-dir'] ?? outDir);

  const pgDump = toolVersion('pg_dump');
  toolVersion('pg_restore');
  await privateDir(outDir, { es: 'El destino', en: 'The destination' });
  await privateDir(keyDir, { es: 'La carpeta de la clave', en: 'The key folder' });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const archiveName = `career-backup-${stamp}.tar${ENCRYPTED_SUFFIX}`;
  const archivePath = join(outDir, archiveName);
  try { await lstat(archivePath); throw new RecoveryError({ es: `Ya existe ${shown(archivePath)}; espera un segundo y repite.`, en: `${shown(archivePath)} already exists; wait a second and retry.` }); }
  catch (error) { if (error instanceof RecoveryError) throw error; }

  // The dump, the documents and the plain tar are personal data in clear: they only live in a private folder.
  const staging = await privateTempDir('.backup-staging-', { parent: outDir });
  const partial = join(outDir, `.${archiveName}.partial`);
  let client;
  try {
    step(`Leyendo una instantánea coherente de ${databaseLabel(databaseUrl)}…`, `Reading a consistent snapshot of ${databaseLabel(databaseUrl)}…`);
    client = await connect(databaseUrl, 'career-backup');
    const serverVersion = (await client.query('show server_version')).rows[0].server_version;
    const serverMajor = Math.floor(Number((await client.query('show server_version_num')).rows[0].server_version_num) / 10000);
    if (pgDump.major < serverMajor) throw new RecoveryError({
      es: `pg_dump ${pgDump.text} es más antiguo que el servidor PostgreSQL ${serverVersion}.`, en: `pg_dump ${pgDump.text} is older than the PostgreSQL server ${serverVersion}.`,
      fixes: [fix(`Instala las herramientas cliente ${serverMajor} o posteriores (brew install libpq) o usa CAREER_PG_BIN.`, `Install client tools ${serverMajor} or newer (brew install libpq) or set CAREER_PG_BIN.`)],
    });
    // Concurrency guard. One backup at a time per server (advisory lock), and document rows cannot change
    // from before the snapshot until every file has been copied and checked (SHARE lock, held to COMMIT).
    // LOCK runs before the first query, so the snapshot is taken with the lock already held.
    if (!(await client.query("select pg_try_advisory_lock(hashtext('career-agent-stack:backup')) as locked")).rows[0].locked) throw new RecoveryError({
      es: 'Ya hay otra copia de seguridad en curso para esta base de datos.', en: 'Another backup of this database is already running.',
      fixes: [fix('Espera a que termine y vuelve a intentarlo.', 'Wait for it to finish and try again.')],
    });
    const lockDocuments = await hasTable(client, 'public.document_versions');
    await client.query('begin isolation level repeatable read');
    await client.query("set local lock_timeout = '10s'");
    if (lockDocuments) {
      try { await client.query('lock table public.document_versions in share mode'); } catch (error) {
        throw new RecoveryError({
          es: `La aplicación está escribiendo documentos y no se pudo bloquear la tabla en 10 s (${safeMessage(error)}).`, en: `The application is writing documents and the table could not be locked within 10 s (${safeMessage(error)}).`,
          fixes: [fix('Espera a que termine la generación del documento y repite pnpm run backup.', 'Wait for document generation to finish and run pnpm run backup again.')],
        });
      }
    }
    const snapshot = (await client.query('select pg_export_snapshot() as id')).rows[0].id;
    const tables = await tableCounts(client);
    const migrations = await appliedMigrations(client);
    const documents = await documentRows(client);
    const dumpPath = join(staging, DUMP_NAME);
    const dump = runPgTool('pg_dump', ['--format=custom', `--snapshot=${snapshot}`, '--no-password', `--file=${dumpPath}`], databaseUrl);
    if (!dump.ok) throw new RecoveryError({ es: `pg_dump falló: ${dump.stderr}`, en: `pg_dump failed: ${dump.stderr}` });
    ok(`Base de datos volcada (${Object.keys(tables).length} tablas, ${humanSize((await stat(dumpPath)).size)})`, `Database dumped (${Object.keys(tables).length} tables, ${humanSize((await stat(dumpPath)).size)})`);

    // Documents referenced by the snapshot. Each must exist and match its recorded hash.
    const missing = [];
    const documentEntries = [];
    const manifestDocuments = [];
    for (const document of documents) {
      let filePath;
      try {
        assertSafeRelativePath(document.storagePath);
        filePath = safeJoin(filesRoot, document.storagePath);
      } catch (error) {
        if (error instanceof ArchiveError) throw new RecoveryError({ es: `El documento ${document.id} tiene una ruta no válida en la base de datos.`, en: `Document ${document.id} has an invalid path in the database.` });
        throw error;
      }
      let info;
      try { info = await lstat(filePath); } catch { info = null; }
      if (!info?.isFile()) { missing.push(document.id); continue; }
      const archivePath = `${FILES_PREFIX}${document.storagePath}`;
      documentEntries.push({ name: archivePath, path: filePath, sha256: document.sha256, size: info.size });
      manifestDocuments.push({ id: document.id, workspaceId: document.workspaceId, storagePath: document.storagePath, mediaType: document.mediaType, sha256: document.sha256, archivePath });
    }
    if (missing.length) throw new RecoveryError({
      es: `${missing.length} documento(s) registrados no están en ${shown(filesRoot)} (p. ej. ${missing[0]}). No se crea una copia incompleta.`,
      en: `${missing.length} recorded document(s) are missing from ${shown(filesRoot)} (e.g. ${missing[0]}). An incomplete backup is not created.`,
      fixes: [fix('Comprueba FILES_LOCAL_PATH en .env y que la carpeta de documentos está completa.', 'Check FILES_LOCAL_PATH in .env and that the documents folder is complete.')],
    });
    const orphanFiles = Math.max(0, (await countFiles(filesRoot)) - documentEntries.length);

    const dumpEntry = { path: DUMP_NAME, size: (await stat(dumpPath)).size, sha256: await hashFile(dumpPath) };
    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'));
    const manifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      app: { name: packageJson.name, version: packageJson.version },
      tools: { node: process.versions.node, pgDump: pgDump.text, pgDumpMajor: pgDump.major, server: serverVersion, serverMajor },
      source: { database: database.database },
      consistency: 'Single REPEATABLE READ snapshot (pg_export_snapshot + pg_dump --snapshot); documents verified against snapshot SHA-256.',
      tables,
      migrations,
      documents: manifestDocuments,
      entries: [dumpEntry, ...documentEntries.map(({ name, sha256, size }) => ({ path: name, size, sha256 }))],
      encryption: { keyFingerprint: keyFingerprint(key), keyIncluded: false, keyFile: `career-key-${keyFingerprint(key).slice(0, 12)}.json` },
      excluded: ['.env', 'APP_SESSION_SECRET', 'APP_ENCRYPTION_KEY (separate key file)', 'sign-in token', 'logs', 'process records', 'browser state', `${orphanFiles} unreferenced file(s) in the documents folder`],
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);

    step(`Escribiendo la copia cifrada con ${documentEntries.length} documento(s)…`, `Writing the encrypted backup with ${documentEntries.length} document(s)…`);
    const plainTar = join(staging, 'backup.tar');
    const written = await writeArchive(plainTar, [
      { name: MANIFEST_NAME, buffer: manifestBytes },
      { name: MANIFEST_MAC_NAME, buffer: Buffer.from(`${manifestMac(key, manifestBytes)}\n`) },
      { name: DUMP_NAME, path: dumpPath, sha256: dumpEntry.sha256 },
      ...documentEntries.map(({ name, path, sha256 }) => ({ name, path, sha256 })),
    ]);
    for (const entry of manifest.entries) {
      if (written.find((item) => item.name === entry.path)?.size !== entry.size) throw new RecoveryError({ es: `${entry.path} cambió durante la copia; repite el comando.`, en: `${entry.path} changed during the backup; run the command again.` });
    }
    // Every file is copied and matched against the snapshot: release the document lock.
    await client.query('commit');
    await client.end();
    client = null;
    await encryptFile(plainTar, partial, key);
    await rm(plainTar, { force: true });
    await publishArchive(partial, archivePath); // fails instead of overwriting if the name appeared meanwhile
    await unlink(partial);

    step('Verificando la copia escrita (descifrado, estructura, hashes, firma y volcado)…', 'Verifying the written backup (decryption, structure, hashes, signature and dump)…');
    const verifyDir = await privateTempDir('.backup-verify-', { parent: outDir });
    let verified;
    try {
      const decrypted = join(verifyDir, 'backup.tar');
      await decryptFile(archivePath, decrypted, key);
      verified = await openArchive(decrypted, await mkdtemp(join(verifyDir, 'entries-')), { key });
    }
    catch (error) {
      await rm(archivePath, { force: true });
      throw archiveRecovery(error);
    } finally { await rm(verifyDir, { recursive: true, force: true }); }

    const archiveHash = await hashFile(archivePath);
    await writePrivateFile(`${archivePath}.sha256`, `${archiveHash}  ${archiveName}\n`);

    const keyPath = join(keyDir, manifest.encryption.keyFile);
    let keyLine = ['creado (permisos 600)', 'created (permissions 600)'];
    if (await lstat(keyPath).then(() => true, () => false)) {
      // readKeyFile rejects anything that is not a valid key file; an existing file is never overwritten.
      if ((await readKeyFile(keyPath)).fingerprint !== keyFingerprint(key)) throw new RecoveryError({ es: `${shown(keyPath)} contiene otra clave; no se sobrescribe.`, en: `${shown(keyPath)} contains a different key; it is not overwritten.` });
      keyLine = ['ya existía con la misma clave; se reutiliza', 'already existed with the same key; reused'];
    } else {
      await writePrivateFile(keyPath, keyFileContent(key, ageIdentity(key)));
    }

    const archiveSize = (await stat(archivePath)).size;
    const rows = Object.values(tables).reduce((sum, count) => sum + count, 0);
    process.stdout.write('\n');
    ok(`Copia verificada: ${shown(archivePath)} (${humanSize(archiveSize)})`, `Verified backup: ${shown(archivePath)} (${humanSize(archiveSize)})`);
    say(`  ${Object.keys(tables).length} tablas, ${rows} filas, ${documentEntries.length} documento(s), ${verified.tocEntries} objetos en el volcado, ${migrations.length} migraciones.`,
      `${Object.keys(tables).length} tables, ${rows} rows, ${documentEntries.length} document(s), ${verified.tocEntries} dump objects, ${migrations.length} migrations.`);
    say(`  Suma SHA-256 del archivo: ${shown(archivePath)}.sha256`, `Archive SHA-256: ${shown(archivePath)}.sha256`);
    say(`  Archivo de clave: ${shown(keyPath)} — ${keyLine[0]}.`, `Key file: ${shown(keyPath)} — ${keyLine[1]}.`);
    if (orphanFiles) say(`  ${orphanFiles} archivo(s) sin registro en la base de datos no se incluyeron.`, `${orphanFiles} file(s) not recorded in the database were not included.`);
    process.stdout.write('\n');
    say('  Importante:', 'Important:');
    say('   – La copia está cifrada: sin el archivo de clave nadie puede leerla ni restaurarla, tampoco tú.', 'The backup is encrypted: without the key file nobody can read or restore it, including you.');
    say('   – Guarda el archivo de clave APARTE de las copias (gestor de contraseñas). Quien tenga los dos puede leer tus datos.', 'Keep the key file SEPARATE from the backups (password manager). Anyone with both can read your data.');
    say('   – Prueba la restauración: pnpm run restore --verify-only --archive <copia> --key-file <clave>', 'Test the restore: pnpm run restore --verify-only --archive <backup> --key-file <key>');
  } catch (error) {
    if (client) { await client.query('rollback').catch(() => {}); await client.end().catch(() => {}); }
    await rm(partial, { force: true });
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

try { await main(); }
catch (error) {
  printRecovery(archiveRecovery(error));
  process.exitCode = 1;
}
