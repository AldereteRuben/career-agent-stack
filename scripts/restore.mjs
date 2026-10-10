// Isolated restore of a verified backup into a NEW database and a NEW installation folder.
// The live workspace (its database, .env and data folder) is never written to.
//
//   pnpm run restore --verify-only --archive <backup.tar.age> --key-file <career-key-*.json>
//       Checks the archive without creating anything: decrypts it and proves the manifest is authentic.
//       Backups made before encryption (plain .tar) need --allow-unencrypted, and the key file is then optional.
//
//   CAREER_RESTORE_ADMIN_URL=postgresql://<admin>@127.0.0.1:5432/postgres \
//   pnpm run restore --archive <backup.tar.age> --key-file <career-key-*.json> --target <new folder>
//       [--database <new database name>] [--web-port 3100] [--api-port 3101] [--env-file <path>]
//
// Order: everything is verified first (archive, signature, dump, schema compatibility, names and folders);
// only then is the new database created. Restored data is sanitised (discovery boards disabled, source
// permissions reset to UNKNOWN, search schedules disabled), counted and hash-checked. The new installation gets
// a fresh APP_SESSION_SECRET and sign-in token, the original APP_ENCRYPTION_KEY, and all external writes off.
// If anything fails after creation, only the database and folder created by this run are removed.
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { RecoveryError, describeDatabase, ok, portIsOpen, printRecovery, projectRoot, say, step, warn } from './lib/local-env.mjs';
import { safeJoin } from './lib/backup-archive.mjs';
import {
  canonicalPath, connect, databaseLabel, documentRows, fix, hasTable, isInside, projectPath, readEnvFile, readKeyFile, repoMigrations,
  runPgTool, safeMessage, sameServer, shown, tableCounts, withDatabase, writePrivateFile,
} from './lib/backup-core.mjs';
import { archiveRecovery, openArchive } from './lib/backup-verify.mjs';
import { decryptFile, isAgeFile, privateTempDir } from './lib/backup-crypto.mjs';
import { disconnectRestoredAi } from './lib/ai-restore.mjs';

const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

const usage = () => {
  say('Uso:', 'Usage:');
  say('  pnpm run restore --verify-only --archive <copia.tar.age> --key-file <clave.json> [--allow-unencrypted]', 'pnpm run restore --verify-only --archive <backup.tar.age> --key-file <key.json> [--allow-unencrypted]');
  say('  CAREER_RESTORE_ADMIN_URL=postgresql://<admin>@127.0.0.1:5432/postgres pnpm run restore --archive <copia.tar.age> --key-file <clave.json> --target <carpeta nueva> [--database <nombre>] [--web-port 3100] [--api-port 3101]',
    'CAREER_RESTORE_ADMIN_URL=postgresql://<admin>@127.0.0.1:5432/postgres pnpm run restore --archive <backup.tar.age> --key-file <key.json> --target <new folder> [--database <name>] [--web-port 3100] [--api-port 3101]');
  say('  Siempre crea una base de datos y una carpeta NUEVAS; nunca toca la instalación activa. Ver docs/operations/backup-restore.md', 'Always creates a NEW database and folder; never touches the live installation. See docs/operations/backup-restore.md');
};

function parseOptions() {
  try {
    // pnpm forwards the `--` of `pnpm run x -- --flag` literally.
    const args = process.argv.slice(2);
    if (args[0] === '--') args.shift();
    return parseArgs({
      args,
      options: {
        archive: { type: 'string' }, 'key-file': { type: 'string' }, target: { type: 'string' }, database: { type: 'string' },
        'web-port': { type: 'string' }, 'api-port': { type: 'string' }, 'env-file': { type: 'string' }, 'verify-only': { type: 'boolean' }, 'allow-unencrypted': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new RecoveryError({ es: `Opción no válida: ${safeMessage(error)}`, en: `Invalid option: ${safeMessage(error)}`, fixes: [fix('Consulta: pnpm run restore --help', 'See: pnpm run restore --help')] });
  }
}

const required = (value, flag) => {
  if (value) return value;
  throw new RecoveryError({ es: `Falta ${flag}.`, en: `${flag} is required.`, fixes: [fix('Consulta: pnpm run restore --help', 'See: pnpm run restore --help')] });
};

function port(value, fallback, flag) {
  const number = Number(value ?? fallback);
  if (!Number.isInteger(number) || number < 1024 || number > 65535) throw new RecoveryError({ es: `${flag} debe ser un puerto entre 1024 y 65535.`, en: `${flag} must be a port between 1024 and 65535.` });
  return number;
}

async function hashFile(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

const exists = (path) => lstat(path).then(() => true, () => false);

function summarise(manifest) {
  const rows = Object.values(manifest.tables).reduce((sum, count) => sum + count, 0);
  say(`  Creada: ${manifest.createdAt} · aplicación ${manifest.app?.version ?? '?'} · PostgreSQL ${manifest.tools.server} · pg_dump ${manifest.tools.pgDump}`,
    `Created: ${manifest.createdAt} · app ${manifest.app?.version ?? '?'} · PostgreSQL ${manifest.tools.server} · pg_dump ${manifest.tools.pgDump}`);
  say(`  ${Object.keys(manifest.tables).length} tablas, ${rows} filas, ${manifest.documents.length} documento(s), ${manifest.migrations.length} migraciones.`,
    `${Object.keys(manifest.tables).length} tables, ${rows} rows, ${manifest.documents.length} document(s), ${manifest.migrations.length} migrations.`);
}

/** Backup migrations must be a prefix of this checkout's migrations; newer or different schemas are refused. */
async function checkSchema(manifest) {
  const known = await repoMigrations();
  manifest.migrations.forEach((migration, index) => {
    if (known[index]?.hash !== migration.hash) throw new RecoveryError({
      es: 'La copia tiene un esquema de base de datos que esta versión del proyecto no conoce (copia más nueva o de otra rama).',
      en: 'The backup has a database schema this version of the project does not know (newer backup or a different branch).',
      fixes: [fix('Restaura con una copia del proyecto de la misma versión que creó la copia, o más nueva.', 'Restore with a checkout of the same project version that created the backup, or newer.')],
    });
  });
  return known.length - manifest.migrations.length;
}

/**
 * Opens a backup for verification or restore (ADR 019). An encrypted backup (.tar.age) is decrypted with the key into
 * a private temporary folder, then verified as before; the decrypted tar is removed by `close`, also after a failure.
 * A plain tar from before encryption is refused unless --allow-unencrypted was given, and then a warning is shown.
 */
async function openBackup(archive, extractDir, { key, allowUnencrypted }) {
  if (await isAgeFile(archive)) {
    if (!key) throw new RecoveryError({
      es: 'Esta copia está cifrada: hace falta su archivo de clave para leerla.', en: 'This backup is encrypted: its key file is needed to read it.',
      fixes: [fix('Añade --key-file <career-key-*.json> (el archivo creado junto con la copia).', 'Add --key-file <career-key-*.json> (the file created with the backup).')],
    });
    const decryptDir = await privateTempDir('career-restore-');
    const close = () => rm(decryptDir, { recursive: true, force: true });
    try {
      const decrypted = join(decryptDir, 'backup.tar');
      try { await decryptFile(archive, decrypted, key); } catch {
        throw new RecoveryError({
          es: 'No se pudo descifrar la copia: el archivo de clave no es el de esta copia, o la copia está incompleta o modificada.',
          en: 'The backup could not be decrypted: the key file does not belong to this backup, or the backup is incomplete or modified.',
          fixes: [fix('Usa el archivo career-key-*.json creado junto con esta copia.', 'Use the career-key-*.json file created with this backup.'), fix('Si la copia viajó por red o USB, compárala con su archivo .sha256.', 'If the backup travelled over a network or USB drive, compare it with its .sha256 file.')],
        });
      }
      return { ...(await openArchive(decrypted, extractDir, { key })), encrypted: true, close };
    } catch (error) { await close(); throw error; }
  }
  if (!allowUnencrypted) throw new RecoveryError({
    es: 'Esta copia NO está cifrada: se hizo antes de que las copias se cifraran, y su contenido nunca estuvo protegido.',
    en: 'This backup is NOT encrypted: it was made before backups were encrypted, and its contents were never protected.',
    fixes: [fix('Si es tuya y confías en ella, repite el comando con --allow-unencrypted. Después, haz una copia nueva (cifrada) y borra esta.', 'If it is yours and you trust it, run the command again with --allow-unencrypted. Then make a new (encrypted) backup and delete this one.')],
  });
  warn('Copia sin cifrar (anterior al cifrado): su contenido nunca estuvo protegido. Haz una copia nueva y borra esta cuando termines.', 'Unencrypted backup (made before encryption): its contents were never protected. Make a new backup and delete this one when you are done.');
  return { ...(await openArchive(archive, extractDir, { key })), encrypted: false, close: async () => {} };
}

async function verifyOnly(options) {
  const archive = resolve(required(options.archive, '--archive'));
  const key = options['key-file'] ? (await readKeyFile(resolve(options['key-file']))).key : undefined;
  // Extracted entries are personal data in clear, so they go to a private folder too.
  const staging = await privateTempDir('career-verify-');
  try {
    step(`Verificando ${shown(archive)} sin crear nada…`, `Verifying ${shown(archive)} without creating anything…`);
    const result = await openBackup(archive, staging, { key, allowUnencrypted: options['allow-unencrypted'] });
    await result.close();
    const pending = await checkSchema(result.manifest);
    if (result.encrypted) ok('Copia descifrada con este archivo de clave.', 'Backup decrypted with this key file.');
    ok('Copia íntegra: estructura, tamaños, hashes SHA-256 y volcado de PostgreSQL correctos.', 'Backup intact: structure, sizes, SHA-256 hashes and PostgreSQL dump are correct.');
    if (result.authenticated) ok('Firma del manifiesto válida con este archivo de clave (copia auténtica).', 'Manifest signature valid with this key file (authentic backup).');
    else warn('Sin --key-file solo se comprueba la integridad, no la autenticidad, y no se sabe si tienes la clave correcta.', 'Without --key-file only integrity is checked, not authenticity, and it is unknown whether you hold the right key.');
    summarise(result.manifest);
    if (pending > 0) say(`  Esta versión del proyecto aplicará ${pending} migración(es) nuevas al iniciar la copia restaurada.`, `This project version will apply ${pending} newer migration(s) when the restored copy starts.`);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

function envText(template, values) {
  const quote = (value) => {
    if (/^[A-Za-z0-9_./:@%+,-]*$/.test(value)) return value;
    if (!/[\r\n']/.test(value)) return `'${value}'`;
    if (!/[\r\n"\\]/.test(value)) return `"${value}"`;
    throw new RecoveryError({ es: 'La ruta o configuración contiene una combinación de comillas o saltos de línea no admitida. Usa una carpeta con un nombre sencillo.', en: 'The path or configuration contains an unsupported combination of quotes or newlines. Choose a folder with a simple name.' });
  };
  const seen = new Set();
  const lines = template.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!match || !(match[1] in values)) return line;
    seen.add(match[1]);
    return `${match[1]}=${quote(values[match[1]])}`;
  });
  for (const [name, value] of Object.entries(values)) if (!seen.has(name)) lines.push(`${name}=${quote(value)}`);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

async function restore(options) {
  const archive = resolve(required(options.archive, '--archive'));
  const keyFile = resolve(required(options['key-file'], '--key-file'));
  const targetInput = required(options.target, '--target');
  const webPort = port(options['web-port'], 3100, '--web-port');
  const apiPort = port(options['api-port'], 3101, '--api-port');
  if (webPort === apiPort) throw new RecoveryError({ es: '--web-port y --api-port deben ser distintos.', en: '--web-port and --api-port must differ.' });

  // Live installation, used only to refuse collisions and to borrow the application role.
  const envFile = resolve(options['env-file'] ?? join(projectRoot, '.env'));
  const liveEnv = (await readEnvFile(envFile)) ?? {};
  const liveDatabase = describeDatabase(liveEnv.DATABASE_URL ?? '');
  const liveDataPaths = [projectPath(liveEnv.DATA_LOCAL_PATH || './data'), projectPath(liveEnv.FILES_LOCAL_PATH || './data/files')];

  const adminUrl = process.env.CAREER_RESTORE_ADMIN_URL ?? '';
  const appBaseUrl = process.env.CAREER_RESTORE_APP_URL || liveEnv.DATABASE_URL || '';
  const admin = describeDatabase(adminUrl);
  const app = describeDatabase(appBaseUrl);
  if (!admin) throw new RecoveryError({
    es: 'Falta CAREER_RESTORE_ADMIN_URL: una conexión de administrador de PostgreSQL que pueda crear bases de datos.',
    en: 'CAREER_RESTORE_ADMIN_URL is missing: a PostgreSQL administrator connection that can create databases.',
    fixes: [fix('Ejemplo (Homebrew): CAREER_RESTORE_ADMIN_URL=postgresql://$USER@127.0.0.1:5432/postgres pnpm run restore -- …', 'Example (Homebrew): CAREER_RESTORE_ADMIN_URL=postgresql://$USER@127.0.0.1:5432/postgres pnpm run restore -- …'),
      fix('Se lee de una variable de entorno para que la contraseña no quede en el historial de argumentos.', 'It is read from an environment variable so the password does not appear in process arguments.')],
  });
  if (!app || !new URL(appBaseUrl).username) throw new RecoveryError({
    es: 'No se sabe qué usuario de PostgreSQL será dueño de la base restaurada.', en: 'It is unknown which PostgreSQL role will own the restored database.',
    fixes: [fix('Define DATABASE_URL en .env o CAREER_RESTORE_APP_URL=postgresql://usuario:contraseña@127.0.0.1:5432/postgres', 'Set DATABASE_URL in .env or CAREER_RESTORE_APP_URL=postgresql://user:password@127.0.0.1:5432/postgres')],
  });
  if (!admin.loopback || !app.loopback) throw new RecoveryError({ es: 'La restauración solo se admite en un PostgreSQL local (127.0.0.1/localhost).', en: 'Restore is only supported on a local PostgreSQL (127.0.0.1/localhost).' });
  if (!sameServer(adminUrl, appBaseUrl)) throw new RecoveryError({ es: 'CAREER_RESTORE_ADMIN_URL y la conexión de la aplicación apuntan a servidores distintos.', en: 'CAREER_RESTORE_ADMIN_URL and the application connection point to different servers.' });
  const appRole = decodeURIComponent(new URL(appBaseUrl).username);

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const databaseName = options.database ?? `career_restore_${stamp}`;
  if (!DATABASE_NAME.test(databaseName)) throw new RecoveryError({ es: '--database solo admite minúsculas, dígitos y _ (máx. 63, sin empezar por dígito).', en: '--database accepts lowercase letters, digits and _ only (max 63, not starting with a digit).' });
  if (liveDatabase && databaseName === liveDatabase.database) throw new RecoveryError({ es: `"${databaseName}" es la base de datos activa; la restauración nunca la sobrescribe.`, en: `"${databaseName}" is the live database; restore never overwrites it.` });
  if (['postgres', 'template0', 'template1'].includes(databaseName)) throw new RecoveryError({ es: `"${databaseName}" es una base del sistema.`, en: `"${databaseName}" is a system database.` });

  const target = await canonicalPath(targetInput);
  if (await exists(target)) throw new RecoveryError({
    es: `La carpeta de destino ya existe: ${target}. La restauración solo escribe en una carpeta nueva.`, en: `The target folder already exists: ${target}. Restore only writes into a new folder.`,
    fixes: [fix('Elige un nombre nuevo, por ejemplo ~/career-restore-<fecha>.', 'Choose a new name, for example ~/career-restore-<date>.')],
  });
  if (!(await lstat(dirname(target)).then((info) => info.isDirectory(), () => false))) throw new RecoveryError({ es: `La carpeta superior no existe: ${dirname(target)}`, en: `The parent folder does not exist: ${dirname(target)}` });
  const live = [await canonicalPath(projectRoot), ...(await Promise.all(liveDataPaths.map(canonicalPath)))];
  if (live.some((path) => isInside(target, path) || isInside(path, target))) throw new RecoveryError({
    es: 'La carpeta de destino está dentro del proyecto o de sus datos activos.', en: 'The target folder is inside the project or its live data.',
    fixes: [fix('Usa una carpeta fuera del proyecto, por ejemplo ~/career-restore-<fecha>.', 'Use a folder outside the project, for example ~/career-restore-<date>.')],
  });
  for (const [value, flag] of [[webPort, '--web-port'], [apiPort, '--api-port']]) {
    if (await portIsOpen('127.0.0.1', value)) warn(`El puerto ${value} (${flag}) está en uso ahora; la copia restaurada no podrá iniciarse en él mientras siga ocupado.`, `Port ${value} (${flag}) is in use right now; the restored copy cannot start on it while it stays busy.`);
  }

  const { key, loose } = await readKeyFile(keyFile);
  if (loose) warn(`El archivo de clave es legible por otros usuarios: chmod 600 "${keyFile}"`, `The key file is readable by other users: chmod 600 "${keyFile}"`);

  let createdTarget = false;
  let createdDatabase = false;
  let adminClient;
  let appClient;
  try {
    await mkdir(target, { mode: 0o700 });
    createdTarget = true;
    await chmod(target, 0o700);
    const staging = await mkdtemp(join(target, '.staging-'));

    step(`Verificando ${shown(archive)} (estructura, hashes, firma, volcado)…`, `Verifying ${shown(archive)} (structure, hashes, signature, dump)…`);
    const opened = await openBackup(archive, staging, { key, allowUnencrypted: options['allow-unencrypted'] });
    await opened.close(); // the extracted entries in the private staging folder are all the restore needs
    const { manifest, dumpPath, files } = opened;
    const pendingMigrations = await checkSchema(manifest);
    ok('Copia íntegra y auténtica', 'Backup intact and authentic');
    summarise(manifest);
    if (manifest.source?.database === databaseName) throw new RecoveryError({ es: `"${databaseName}" es el nombre de la base de origen; elige otro.`, en: `"${databaseName}" is the source database name; choose another.` });

    adminClient = await connect(adminUrl, 'career-restore-admin');
    if ((await adminClient.query('select 1 from pg_database where datname = $1', [databaseName])).rowCount) throw new RecoveryError({
      es: `La base de datos "${databaseName}" ya existe; la restauración nunca escribe en una base existente.`, en: `Database "${databaseName}" already exists; restore never writes into an existing database.`,
      fixes: [fix('Elige otro nombre con --database o deja que se genere uno.', 'Choose another name with --database or let one be generated.')],
    });
    if (!(await adminClient.query('select 1 from pg_roles where rolname = $1', [appRole])).rowCount) throw new RecoveryError({ es: `No existe el usuario de PostgreSQL "${appRole}".`, en: `PostgreSQL role "${appRole}" does not exist.` });
    step(`Creando la base de datos nueva "${databaseName}" (propietario ${appRole})…`, `Creating the new database "${databaseName}" (owner ${appRole})…`);
    await adminClient.query(`create database ${adminClient.escapeIdentifier(databaseName)} owner ${adminClient.escapeIdentifier(appRole)} template template0 encoding 'UTF8'`);
    createdDatabase = true;

    const restoredUrl = withDatabase(appBaseUrl, databaseName);
    step('Restaurando el volcado en la base nueva (una sola transacción)…', 'Restoring the dump into the new database (single transaction)…');
    const restored = runPgTool('pg_restore', ['--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '--no-password', `--dbname=${databaseName}`, dumpPath], restoredUrl);
    if (!restored.ok) throw new RecoveryError({ es: `pg_restore falló: ${restored.stderr}`, en: `pg_restore failed: ${restored.stderr}` });

    appClient = await connect(restoredUrl, 'career-restore');
    // Safe defaults: nothing external runs until the user reviews it again in the restored copy.
    const sanitised = { boardsDisabled: 0, boardPermissionsReset: 0, reviewPermissionsReset: 0, searchProfilesDisabled: 0 };
    await appClient.query('begin');
    if (await hasTable(appClient, 'public.boards')) {
      sanitised.boardsDisabled = (await appClient.query('select count(*)::int as n from boards where enabled')).rows[0].n;
      sanitised.boardPermissionsReset = (await appClient.query(`select count(*)::int as n from boards where permission_status <> 'UNKNOWN'`)).rows[0].n;
      if ((await appClient.query("select 1 from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'discovery_enabled'")).rowCount) await appClient.query('update workspaces set discovery_enabled = false');
      await appClient.query(`update boards set enabled = false, permission_status = 'UNKNOWN', updated_at = now() where enabled or permission_status <> 'UNKNOWN'`);
    }
    if (await hasTable(appClient, 'public.source_policy_reviews')) {
      sanitised.reviewPermissionsReset = (await appClient.query(`update source_policy_reviews set permission_status = 'UNKNOWN' where permission_status <> 'UNKNOWN'`)).rowCount;
    }
    if (await hasTable(appClient, 'public.search_profiles')) {
      sanitised.searchProfilesDisabled = (await appClient.query('update search_profiles set enabled = false, updated_at = now() where enabled')).rowCount;
    }
    if (await hasTable(appClient, 'public.saved_job_searches')) {
      await appClient.query('update saved_job_searches set enabled = false, auto_prepare = false, updated_at = now()');
    }
    if (await hasTable(appClient, 'public.search_runs')) {
      await appClient.query("update search_runs set status=case when finished_at IS NULL then 'CANCELLED' else status end,finished_at=coalesce(finished_at,now()),owner=NULL,lease_until=NULL,manual=false");
      if (await hasTable(appClient, 'public.search_run_sources')) {
        await appClient.query("update search_run_sources set status='CANCELLED',next_fetch_at=NULL where status in ('QUEUED','RUNNING')");
      }
    }
    if (await hasTable(appClient, 'public.assisted_attempts')) {
      await appClient.query(`update assisted_attempts set status = case when status = 'PREPARED' then 'INVALIDATED' else 'UNKNOWN' end, updated_at = now(), result = result || '{"reason":"ASSIST_RESTORED_REQUIRES_REVIEW"}'::jsonb where status in ('PREPARED', 'STARTING', 'REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF')`);
      const pending = await appClient.query(`select count(*)::int as n from assisted_attempts where status in ('PREPARED', 'STARTING', 'REVIEW', 'HANDOFF_REQUIRED', 'HANDED_OFF')`);
      if (pending.rows[0].n !== 0) throw new RecoveryError({ es: 'Hay autorizaciones de navegador activas tras restaurar.', en: 'Active browser grants remain after restore.' });
    }
    sanitised.ai = await disconnectRestoredAi(appClient);
    await appClient.query('commit');

    step('Comprobando recuentos, documentos y valores seguros…', 'Checking row counts, documents and safe defaults…');
    const counts = await tableCounts(appClient);
    const expected = Object.entries(manifest.tables);
    const mismatched = expected.filter(([table, count]) => counts[table] !== count).map(([table]) => table);
    if (mismatched.length || Object.keys(counts).length !== expected.length) throw new RecoveryError({
      es: `Los recuentos restaurados no coinciden con el manifiesto (${mismatched.join(', ') || 'tablas distintas'}).`, en: `Restored row counts do not match the manifest (${mismatched.join(', ') || 'different tables'}).`,
    });
    const restoredDocuments = new Map((await documentRows(appClient)).map((row) => [row.id, row]));
    if (restoredDocuments.size !== manifest.documents.length || manifest.documents.some((document) => {
      const row = restoredDocuments.get(document.id);
      return !row || row.storagePath !== document.storagePath || row.sha256 !== document.sha256 || row.workspaceId !== document.workspaceId;
    })) throw new RecoveryError({ es: 'Las filas de documentos restauradas no coinciden con el manifiesto.', en: 'Restored document rows do not match the manifest.' });
    const unsafe = await appClient.query(`select
      (select count(*)::int from boards where enabled or permission_status <> 'UNKNOWN') as boards,
      (select count(*)::int from source_policy_reviews where permission_status <> 'UNKNOWN') as reviews,
      (select count(*)::int from search_profiles where enabled) as profiles`);
    if (Object.values(unsafe.rows[0]).some((value) => value !== 0)) throw new RecoveryError({ es: 'No se pudieron desactivar todos los tableros o permisos.', en: 'Not every board or permission could be disabled.' });
    const unresolved = (await hasTable(appClient, 'public.applications'))
      ? (await appClient.query(`select count(*)::int as n from applications where state in ('IN_PROGRESS', 'UNKNOWN')`)).rows[0].n : 0;
    await appClient.end();
    appClient = null;

    // New installation folder: data/files with the documents, verified again after they are moved in place.
    const dataDir = join(target, 'data');
    const filesDir = join(dataDir, 'files');
    await mkdir(filesDir, { recursive: true, mode: 0o700 });
    for (const document of manifest.documents) {
      const destination = safeJoin(filesDir, document.storagePath);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await rename(files.get(document.archivePath).path, destination);
      await chmod(destination, 0o600);
      if ((await hashFile(destination)) !== document.sha256) throw new RecoveryError({ es: `El documento ${document.id} no coincide tras copiarlo.`, en: `Document ${document.id} does not match after copying.` });
    }
    await rm(staging, { recursive: true, force: true });

    const template = await readFile(join(projectRoot, '.env.example'), 'utf8').catch(() => '');
    const sessionSecret = randomBytes(32).toString('base64');
    const header = [
      `# Restored Career Agent Stack installation · Instalación restaurada`,
      `# Created ${new Date().toISOString()} by pnpm run restore from ${basename(archive)}.`,
      '# Isolated copy: its own database and data folder, a NEW session secret, discovery boards disabled,',
      '# source permissions UNKNOWN, application writes/automation/e-mail/AI off. Review before enabling anything.',
      '',
    ].join('\n');
    await writePrivateFile(join(target, '.env'), header + envText(template, {
      NODE_ENV: 'development', WORKSPACE_MODE: 'local',
      WEB_HOST: '127.0.0.1', WEB_PORT: String(webPort), WEB_ORIGIN: `http://127.0.0.1:${webPort}`,
      API_HOST: '127.0.0.1', API_PORT: String(apiPort), API_BASE_URL: `http://127.0.0.1:${apiPort}`,
      DATABASE_URL: restoredUrl, APP_ENCRYPTION_KEY: key, APP_SESSION_SECRET: sessionSecret,
      AI_PROVIDER: 'none', AI_ALLOW_PAID_FALLBACK: 'false', APPLICATION_WRITES_ENABLED: 'false', AUTOMATION_SUBMIT_ENABLED: 'false',
      AUTOMATION_DAILY_SUBMIT_CAP: '0', EMAIL_INTEGRATION_ENABLED: 'false', DIAGNOSTICS_ENABLED: 'false',
      FILES_DRIVER: 'local', FILES_LOCAL_PATH: filesDir, DATA_LOCAL_PATH: dataDir,
    }));
    await writePrivateFile(join(dataDir, 'setup-token'), randomBytes(24).toString('base64url'));
    const report = {
      format: 'career-agent-stack-restore-report', restoredAt: new Date().toISOString(), archive: basename(archive),
      backupCreatedAt: manifest.createdAt, database: databaseLabel(restoredUrl), owner: appRole,
      rowCounts: counts, documentsVerified: manifest.documents.length, sanitised, unresolvedApplications: unresolved, pendingMigrations,
      session: 'new APP_SESSION_SECRET and single-use sign-in token; sessions from the original installation are not valid here',
    };
    await writePrivateFile(join(target, 'restore-report.json'), `${JSON.stringify(report, null, 2)}\n`);

    process.stdout.write('\n');
    ok(`Restauración aislada completada en ${target}`, `Isolated restore completed in ${target}`);
    say(`  Base de datos nueva: ${databaseLabel(restoredUrl)} · ${manifest.documents.length} documento(s) verificados · recuentos idénticos a la copia.`,
      `New database: ${databaseLabel(restoredUrl)} · ${manifest.documents.length} document(s) verified · row counts identical to the backup.`);
    say(`  Tableros desactivados: ${sanitised.boardsDisabled} · permisos a UNKNOWN: ${sanitised.boardPermissionsReset + sanitised.reviewPermissionsReset} · búsquedas desactivadas: ${sanitised.searchProfilesDisabled}.`,
      `Boards disabled: ${sanitised.boardsDisabled} · permissions reset to UNKNOWN: ${sanitised.boardPermissionsReset + sanitised.reviewPermissionsReset} · searches disabled: ${sanitised.searchProfilesDisabled}.`);
    if (unresolved) warn(`${unresolved} candidatura(s) en estado IN_PROGRESS/UNKNOWN: concílialas a mano; nada se reenvía.`, `${unresolved} application(s) in IN_PROGRESS/UNKNOWN: reconcile them by hand; nothing is resubmitted.`);
    if (pendingMigrations) say(`  Al iniciar se aplicarán ${pendingMigrations} migración(es) nuevas de esta versión.`, `${pendingMigrations} newer migration(s) of this version will be applied on start.`);
    process.stdout.write('\n');
    say('  Para abrirla (la instalación activa sigue intacta):', 'To open it (the live installation is untouched):');
    say('   1. En OTRA copia del código de la misma versión: git worktree add ../career-restored && cd ../career-restored && pnpm install --frozen-lockfile',
      'In ANOTHER checkout of the same version: git worktree add ../career-restored && cd ../career-restored && pnpm install --frozen-lockfile');
    say(`   2. Allí: CAREER_ENV_FILE="${join(target, '.env')}" pnpm start --copy-token`, `There: CAREER_ENV_FILE="${join(target, '.env')}" pnpm start --copy-token`);
    say(`   3. Se abre http://127.0.0.1:${webPort}; el token de un solo uso está en ${join(dataDir, 'setup-token')}. No copies este .env sobre el activo.`,
      `It opens http://127.0.0.1:${webPort}; the single-use token is in ${join(dataDir, 'setup-token')}. Never copy this .env over the live one.`);
    say('   4. Revisa cada tablero y su permiso antes de activarlo.', 'Review each board and its permission before enabling it.');
  } catch (error) {
    if (appClient) await appClient.end().catch(() => {});
    let cleaned = true;
    if (createdDatabase && adminClient) {
      try { await adminClient.query(`drop database if exists ${adminClient.escapeIdentifier(databaseName)}`); } catch { cleaned = false; }
    }
    if (createdTarget) await rm(target, { recursive: true, force: true }).catch(() => { cleaned = false; });
    if (createdTarget || createdDatabase) {
      if (cleaned && createdDatabase) say('  Se eliminaron la base de datos y la carpeta nuevas creadas por este intento.', 'The new database and folder created by this attempt were removed.', process.stderr);
      else if (cleaned) say('  Se eliminó la carpeta nueva creada por este intento; no se llegó a crear ninguna base de datos.', 'The new folder created by this attempt was removed; no database was created.', process.stderr);
      else say(`  Revisa y elimina a mano lo creado por este intento: ${createdDatabase ? `base "${databaseName}", ` : ''}${target}`, `Check and remove by hand what this attempt created: ${createdDatabase ? `database "${databaseName}", ` : ''}${target}`, process.stderr);
    }
    say('  La instalación activa (su base de datos, .env y datos) no se ha tocado.', 'The live installation (its database, .env and data) was not touched.', process.stderr);
    throw error;
  } finally {
    if (adminClient) await adminClient.end().catch(() => {});
  }
}

try {
  const options = parseOptions();
  if (options.help) usage();
  else if (options['verify-only']) await verifyOnly(options);
  else await restore(options);
} catch (error) {
  printRecovery(archiveRecovery(error));
  process.exitCode = 1;
}
