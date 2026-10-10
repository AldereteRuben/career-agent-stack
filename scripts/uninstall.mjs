// Removes this installation (ADR 020): its database and role, its data and documents, optionally its backups, and
// finally its .env. By default it only shows what it would do.
//
//   pnpm run uninstall                                   show the plan; changes nothing
//   pnpm run uninstall --confirm <id>                    delete; <id> is CAREER_INSTALL_ID (or CAREER_RESTORE_ID)
//        [--include-backups]                             also delete the backups/ folder and its key files
//        [--skip-database]                               leave a database the script cannot prove is ours
//   CAREER_ENV_FILE=/path/to/restored/.env pnpm run uninstall …    a restored installation instead of this checkout
//
// Safety: it refuses while the API or web app runs; it drops a database and role only when they carry this
// installation's mark (and never the original installation's role for a restored one); it deletes only data folders
// inside the installation folder, away from reserved paths and the backup folder, with no symbolic links; and it
// keeps a progress file, so a failed run resumes. The checkout's code, node_modules, the PostgreSQL server, the
// Playwright browsers and the Codex or Claude configuration are never touched.
import { lstat, readFile, readdir, rmdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { connect, databaseLabel, humanSize, isInside, projectPath, safeMessage, sameServer, shown } from './lib/backup-core.mjs';
import { RecoveryError, alternateEnv, envPath, ok, pendingEnvPath, printRecovery, projectRoot, readLocalEnv, say, step, warn } from './lib/local-env.mjs';
import {
  checkDeletablePath, deletePath, dropDatabase, dropRole, identityOf, inspectDatabase, inspectRole, measure, PROGRESS_FORMAT,
  progressPath, readProgress, writeProgress,
} from './lib/uninstall-core.mjs';

const fix = (es, en) => ({ es, en });
const folder = alternateEnv ? dirname(envPath) : projectRoot;
const exists = async (path) => { try { await lstat(path); return true; } catch { return false; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const adminUrl = () => process.env.CAREER_ADMIN_DATABASE_URL || `postgresql://${encodeURIComponent(process.env.USER || process.env.USERNAME || 'postgres')}@127.0.0.1:5432/postgres`;

function options() {
  const { values } = parseArgs({ options: { confirm: { type: 'string' }, 'include-backups': { type: 'boolean' }, 'skip-database': { type: 'boolean' }, help: { type: 'boolean' } } });
  return values;
}

/**
 * The launcher's run records of THIS installation: the checkout's data/run, or the run/ folder of a restored
 * installation's data folder. Derived from its own .env (or progress file), never from another installation's
 * defaults: without them, a missing .env would point at the checkout's live records.
 */
const runDirOf = (env) => (alternateEnv ? join(projectPath(env.DATA_LOCAL_PATH || './data'), 'run') : join(projectRoot, 'data', 'run'));

/** Services of this installation that the launcher recorded and that are still alive. PostgreSQL may keep running. */
async function runningServices(runDir) {
  if (!runDir) return [];
  let files;
  try { files = (await readdir(runDir)).filter((file) => file.endsWith('.json')); } catch { return []; }
  const running = [];
  for (const file of files) {
    let record;
    try { record = JSON.parse(await readFile(join(runDir, file), 'utf8')); } catch { continue; }
    if (record.name !== 'postgres' && Number.isInteger(record.pid) && alive(record.pid)) running.push(record.name);
  }
  return running;
}

/** The pg_ctl command that stops a PostgreSQL the launcher started, for the message before run/ is deleted. */
async function launcherPostgres(runDir) {
  if (!runDir) return null;
  try {
    const record = JSON.parse(await readFile(join(runDir, 'postgres.json'), 'utf8'));
    return record.method === 'homebrew-pg_ctl' && record.pgCtl && record.dataDir ? `"${record.pgCtl}" -D "${record.dataDir}" -m fast stop` : null;
  } catch { return null; }
}

/** Everything the plan needs from .env: the database and role, the data folders, backups and the env files. */
async function buildPlan(env, identity, flags) {
  const plan = { format: PROGRESS_FORMAT, version: 1, kind: identity.kind, id: identity.id, folder, runDir: runDirOf(env), database: null, role: null, paths: [], backups: null, envFiles: [], done: [], refused: [] };
  let url = null;
  try { url = new URL(env.DATABASE_URL); } catch { /* checked below */ }
  const databaseName = url ? decodeURIComponent(url.pathname.slice(1)) : '';
  const roleName = url ? decodeURIComponent(url.username) : '';
  if (!identity.managed || !databaseName || !roleName) {
    plan.unmanaged = databaseName || '(?)';
  } else {
    plan.database = { name: databaseName, owner: roleName, server: databaseLabel(env.DATABASE_URL) };
    if (identity.kind === 'install') plan.role = roleName;
  }
  const data = projectPath(env.DATA_LOCAL_PATH || './data');
  const files = projectPath(env.FILES_LOCAL_PATH || './data/files');
  const candidates = [data, ...(isInside(files, data) ? [] : [files])];
  if (identity.kind === 'restore') candidates.push(join(folder, 'restore-report.json'));
  for (const path of candidates) {
    const checked = await checkDeletablePath(path, { root: folder });
    if (checked.ok) { if (checked.exists) plan.paths.push(checked.path); } else plan.refused.push({ path, reason: checked.reason });
  }
  const backupDir = join(folder, 'backups');
  if (flags['include-backups']) {
    if (identity.kind !== 'install') throw new RecoveryError({
      es: '--include-backups solo se admite al desinstalar la instalación del checkout: la carpeta backups/ es suya.', en: '--include-backups is only accepted for the checkout\'s installation: the backups/ folder belongs to it.',
    });
    if (await exists(backupDir)) plan.backups = backupDir;
  }
  if (!alternateEnv && await exists(pendingEnvPath)) plan.envFiles.push(pendingEnvPath);
  if (await exists(envPath)) plan.envFiles.push(envPath);
  return plan;
}

/** Checks that the database and role really belong to this installation. Returns the reasons it cannot proceed. */
async function verifyDatabase(client, plan, identity, resuming, databaseUrl) {
  const problems = [];
  if (!plan.database) return problems;
  if (databaseUrl && !sameServer(adminUrl(), databaseUrl)) problems.push(fix('CAREER_ADMIN_DATABASE_URL apunta a otro servidor que DATABASE_URL.', 'CAREER_ADMIN_DATABASE_URL points at another server than DATABASE_URL.'));
  if (!plan.done.includes('database')) {
    const database = await inspectDatabase(client, plan.database.name);
    if (!database.exists && !resuming) problems.push(fix(`La base «${plan.database.name}» no existe; sin un archivo de progreso no se da por borrada por este script.`, `Database "${plan.database.name}" does not exist; without a progress file it is not assumed to have been dropped by this script.`));
    if (database.exists && (database.mark !== identity.mark || database.owner !== plan.database.owner)) problems.push(fix(`La base «${plan.database.name}» no lleva la marca de esta instalación (o su propietario no es ${plan.database.owner}).`, `Database "${plan.database.name}" does not carry this installation's mark (or is not owned by ${plan.database.owner}).`));
  }
  if (plan.role && !plan.done.includes('role')) {
    const role = await inspectRole(client, plan.role);
    if (!role.exists && !resuming) problems.push(fix(`El usuario «${plan.role}» no existe; sin un archivo de progreso no se da por borrado por este script.`, `Role "${plan.role}" does not exist; without a progress file it is not assumed to have been dropped by this script.`));
    if (role.exists && role.mark !== identity.mark) problems.push(fix(`El usuario «${plan.role}» no lleva la marca de esta instalación.`, `Role "${plan.role}" does not carry this installation's mark.`));
  }
  return problems;
}

function printPlan(plan, sizes, confirmed) {
  say(confirmed ? 'Se borrará, en este orden:' : 'Esto es lo que se borraría (no se ha cambiado nada):', confirmed ? 'Will be deleted, in this order:' : 'This is what would be deleted (nothing has been changed):');
  if (plan.database) say(`  – Base de datos «${plan.database.name}» en ${plan.database.server}`, `– Database "${plan.database.name}" on ${plan.database.server}`);
  if (plan.role) say(`  – Usuario de PostgreSQL «${plan.role}»`, `– PostgreSQL role "${plan.role}"`);
  for (const path of plan.paths) say(`  – ${shown(path)} (${sizes.get(path)})`, `– ${shown(path)} (${sizes.get(path)})`);
  if (plan.backups) say(`  – Copias de seguridad y sus archivos de clave: ${shown(plan.backups)} (${sizes.get(plan.backups)})`, `– Backups and their key files: ${shown(plan.backups)} (${sizes.get(plan.backups)})`);
  for (const path of plan.envFiles) say(`  – ${shown(path)} (claves de esta instalación)`, `– ${shown(path)} (this installation's keys)`);
  say('Se conserva:', 'Kept:');
  if (plan.unmanaged) say(`  – La base de datos «${plan.unmanaged}» y su usuario: no los creó bootstrap, así que se borran a mano (docs/operations/uninstall.md).`, `– Database "${plan.unmanaged}" and its role: bootstrap did not create them, so remove them by hand (docs/operations/uninstall.md).`);
  if (plan.kind === 'restore' && plan.database) say(`  – El usuario «${plan.database.owner}»: pertenece a la instalación original.`, `– Role "${plan.database.owner}": it belongs to the original installation.`);
  if (!plan.backups && plan.kind === 'install') say('  – La carpeta backups/ y sus archivos de clave (añade --include-backups para borrarlos). Cada copia necesita su archivo de clave para restaurarse.', 'The backups/ folder and its key files (add --include-backups to delete them). Each backup needs its key file to be restored.');
  say('  – El código del checkout y node_modules (borra la carpeta tú), el servidor PostgreSQL y sus demás bases, los navegadores de Playwright, la configuración de Codex o Claude, y las copias o datos que ya estén fuera de la instalación.',
    'The checkout\'s code and node_modules (delete the folder yourself), the PostgreSQL server and its other databases, the Playwright browsers, the Codex or Claude configuration, and any copies or data already outside the installation.');
  for (const { path, reason } of plan.refused) warn(`No se borrará ${path}: ${reason.es} Bórralo a mano si corresponde.`, `${path} will not be deleted: ${reason.en} Delete it by hand if appropriate.`);
}

async function main() {
  const flags = options();
  if (flags.help) { say('Uso: pnpm run uninstall [--confirm <id>] [--include-backups] [--skip-database]', 'Usage: pnpm run uninstall [--confirm <id>] [--include-backups] [--skip-database]'); return; }
  let env = await readLocalEnv(envPath);
  if (!env && !alternateEnv) env = await readLocalEnv(pendingEnvPath);
  const progress = await readProgress(folder);
  if (!env && !progress) { say(`No hay ninguna instalación que desinstalar en ${folder}.`, `There is no installation to uninstall in ${folder}.`); return; }
  const identity = env ? identityOf(env) : { kind: progress.kind, id: progress.id, mark: progress.kind === 'restore' ? `career-agent-stack restore ${progress.id}` : `career-agent-stack install ${progress.id}`, managed: true };
  if (!identity) throw new RecoveryError({
    es: 'El .env no tiene CAREER_INSTALL_ID (ni CAREER_RESTORE_ID), así que no se puede comprobar qué base de datos es de esta instalación.', en: 'The .env has no CAREER_INSTALL_ID (or CAREER_RESTORE_ID), so it cannot be proven which database belongs to this installation.',
    fixes: [fix('Sigue los pasos manuales de docs/operations/uninstall.md.', 'Follow the manual steps in docs/operations/uninstall.md.')],
  });
  if (progress && (progress.id !== identity.id || progress.kind !== identity.kind)) throw new RecoveryError({
    es: `${shown(progressPath(folder))} es de otra instalación (${progress.id}); no se toca nada.`, en: `${shown(progressPath(folder))} belongs to another installation (${progress.id}); nothing is touched.`,
  });
  if (flags.confirm !== undefined && flags.confirm !== identity.id) throw new RecoveryError({
    es: `--confirm no coincide con el id de esta instalación (${identity.id}).`, en: `--confirm does not match this installation's id (${identity.id}).`,
    fixes: [fix(`Comprueba que es la instalación que quieres borrar y usa: pnpm run uninstall --confirm ${identity.id}`, `Check that this is the installation you want to remove, then use: pnpm run uninstall --confirm ${identity.id}`)],
  });
  const confirmed = flags.confirm === identity.id;

  const runDir = env ? runDirOf(env) : progress?.runDir;
  const running = await runningServices(runDir);
  if (running.length) throw new RecoveryError({
    es: `La app sigue en marcha (${running.join(', ')}).`, en: `The app is still running (${running.join(', ')}).`,
    fixes: [fix('Detenla con: pnpm run stop   (PostgreSQL puede seguir en marcha). Si los registros son antiguos: pnpm run stop --forget', 'Stop it with: pnpm run stop   (PostgreSQL may keep running). If the records are stale: pnpm run stop --forget')],
  });

  const plan = progress ?? await buildPlan(env, identity, flags);
  if (progress) say('Se retoma una desinstalación interrumpida.', 'Resuming an interrupted uninstall.');
  if (!progress && plan.unmanaged && !flags['skip-database']) throw new RecoveryError({
    es: `No se puede comprobar que la base de datos «${plan.unmanaged}» sea de esta instalación (no la creó bootstrap o no lleva su marca), así que no se toca nada.`,
    en: `It cannot be proven that database "${plan.unmanaged}" belongs to this installation (bootstrap did not create it, or it is not marked), so nothing is touched.`,
    fixes: [fix('Bórrala a mano siguiendo docs/operations/uninstall.md y vuelve a ejecutar con --skip-database para borrar lo demás.', 'Remove it by hand following docs/operations/uninstall.md, then run again with --skip-database to delete the rest.')],
  });

  let client = null;
  try {
    if (plan.database && !(plan.done.includes('database') && (!plan.role || plan.done.includes('role')))) {
      try { client = await connect(adminUrl(), 'career-uninstall'); } catch (error) {
        if (confirmed) throw new RecoveryError({
          es: `No se pudo conectar como administrador de PostgreSQL: ${safeMessage(error)}`, en: `Could not connect as the PostgreSQL administrator: ${safeMessage(error)}`,
          fixes: [fix('Indica un administrador: CAREER_ADMIN_DATABASE_URL=postgresql://USUARIO:CLAVE@127.0.0.1:5432/postgres (el mismo que usó bootstrap)', 'Give an administrator: CAREER_ADMIN_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/postgres (the one bootstrap used)')],
        });
        warn('No se pudo conectar como administrador de PostgreSQL, así que la base y el usuario no se han comprobado todavía.', 'Could not connect as the PostgreSQL administrator, so the database and role are not checked yet.');
      }
      if (client) {
        const problems = await verifyDatabase(client, plan, identity, Boolean(progress), env?.DATABASE_URL);
        if (problems.length) throw new RecoveryError({
          es: 'La base de datos o el usuario no se pueden atribuir con seguridad a esta instalación, así que no se borra nada.', en: 'The database or role cannot safely be attributed to this installation, so nothing is deleted.',
          fixes: [...problems, fix('Si sabes que son tuyos y no los usa nada más, sigue los pasos manuales de docs/operations/uninstall.md.', 'If you know they are yours and nothing else uses them, follow the manual steps in docs/operations/uninstall.md.')],
        });
      }
    }
    for (const path of plan.paths ?? []) {
      const checked = await checkDeletablePath(path, { root: folder });
      if (!checked.ok) throw new RecoveryError({ es: `No se borra ${path}: ${checked.reason.es}`, en: `${path} is not deleted: ${checked.reason.en}` });
    }

    const sizes = new Map();
    for (const path of [...(plan.paths ?? []), ...(plan.backups ? [plan.backups] : [])]) { const { files, bytes } = await measure(path); sizes.set(path, `${files} archivos/files, ${humanSize(bytes)}`); }
    printPlan(plan, sizes, confirmed);
    if (!confirmed) {
      say(`Para borrarlo: pnpm run uninstall --confirm ${identity.id}${flags['include-backups'] ? ' --include-backups' : ''}${flags['skip-database'] ? ' --skip-database' : ''}`, `To delete it: pnpm run uninstall --confirm ${identity.id}${flags['include-backups'] ? ' --include-backups' : ''}${flags['skip-database'] ? ' --skip-database' : ''}`);
      return;
    }

    // From here on things are deleted, so a failure must not claim that nothing changed.
    // The progress file holds names, paths and ids only: never DATABASE_URL, which contains the password.
    const record = { ...plan, refused: plan.refused ?? [] };
    const save = () => writeProgress(folder, record);
    const done = async (name) => { record.done.push(name); await save(); };
    await save();
    try {
      if (plan.database && !record.done.includes('database')) {
        if ((await inspectDatabase(client, plan.database.name)).exists) {
          step(`Borrando la base de datos «${plan.database.name}»…`, `Dropping database "${plan.database.name}"…`);
          await dropDatabase(client, plan.database.name, plan.database.owner);
        }
        await done('database');
      }
      if (plan.role && !record.done.includes('role')) {
        const role = await inspectRole(client, plan.role);
        if (role.exists) {
          if (role.ownedDatabases.length || role.dependencies.length) throw new RecoveryError({
            es: `El usuario «${plan.role}» todavía es propietario de otras bases o tiene objetos o permisos en ellas: ${[...role.ownedDatabases, ...role.dependencies.map((entry) => `${entry.database} (${entry.count})`)].join(', ')}. No se borra.`,
            en: `Role "${plan.role}" still owns other databases or holds objects or privileges in them: ${[...role.ownedDatabases, ...role.dependencies.map((entry) => `${entry.database} (${entry.count})`)].join(', ')}. It is not dropped.`,
            fixes: [fix('Si son instalaciones restauradas, desinstálalas antes con CAREER_ENV_FILE=<su .env> pnpm run uninstall. Después vuelve a ejecutar este comando: retoma donde se quedó.', 'If they are restored installations, uninstall them first with CAREER_ENV_FILE=<their .env> pnpm run uninstall. Then run this command again: it resumes where it stopped.')],
          });
          step(`Borrando el usuario de PostgreSQL «${plan.role}»…`, `Dropping PostgreSQL role "${plan.role}"…`);
          await dropRole(client, plan.role);
        }
        await done('role');
      }
      if (!record.done.includes('data')) {
        const stopCommand = await launcherPostgres(plan.runDir);
        if (stopCommand) say(`  PostgreSQL lo inició el lanzador y sigue en marcha; para detenerlo: ${stopCommand}  (escribirá en su log borrado hasta que se reinicie).`, `PostgreSQL was started by the launcher and keeps running; to stop it: ${stopCommand}  (it writes to its deleted log until it restarts).`);
        for (const path of plan.paths) {
          const checked = await checkDeletablePath(path, { root: folder });
          if (!checked.ok) throw new RecoveryError({ es: `No se borra ${path}: ${checked.reason.es}`, en: `${path} is not deleted: ${checked.reason.en}` });
          step(`Borrando ${shown(path)}…`, `Deleting ${shown(path)}…`);
          await deletePath(checked.path);
        }
        await done('data');
      }
      if (plan.backups && !record.done.includes('backups')) {
        step(`Borrando las copias de seguridad de ${shown(plan.backups)}…`, `Deleting the backups in ${shown(plan.backups)}…`);
        await deletePath(plan.backups);
        await done('backups');
      }
      if (!record.done.includes('env')) {
        for (const path of plan.envFiles) await deletePath(path);
        await done('env');
      }
      await deletePath(progressPath(folder));
      if (plan.kind === 'restore') await rmdir(folder).catch(() => undefined);
    } catch (error) {
      printRecovery(error instanceof RecoveryError ? error : new RecoveryError({ es: `Falló un paso: ${safeMessage(error)}`, en: `A step failed: ${safeMessage(error)}` }), { untouched: false });
      say(`  Ya está hecho: ${record.done.join(', ') || 'nada'}. Corrige lo anterior y ejecuta otra vez: pnpm run uninstall --confirm ${identity.id}  (retoma donde se quedó).`,
        `Already done: ${record.done.join(', ') || 'nothing'}. Fix the above and run again: pnpm run uninstall --confirm ${identity.id}  (it resumes where it stopped).`, process.stderr);
      process.exitCode = 1;
      return;
    }
    ok(`Instalación ${identity.id} desinstalada.`, `Installation ${identity.id} uninstalled.`);
    if (!plan.backups && plan.kind === 'install') say('  Las copias de backups/ se conservan; guárdalas junto a su archivo de clave o bórralas cuando ya no las necesites.', 'The backups in backups/ are kept; store them with their key file, or delete them once you no longer need them.');
    if (plan.kind === 'install' && !alternateEnv) say(`  Para terminar, borra la carpeta del código: ${basename(projectRoot)}`, `To finish, delete the code folder: ${basename(projectRoot)}`);
  } finally {
    await client?.end().catch(() => undefined);
  }
}

try {
  await main();
} catch (error) {
  printRecovery(error);
  process.exitCode = 1;
}
