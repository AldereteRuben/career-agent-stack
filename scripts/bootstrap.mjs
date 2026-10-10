// Preparation of a local installation (first install), safe to re-run at any point:
//
//   node scripts/bootstrap.mjs   (or pnpm run bootstrap once dependencies are installed)
//
// First install, in this order. Every step can be repeated, and a failed run resumes where it stopped:
//   1. checks Node 24 and pnpm 11 and installs dependencies when they are missing or older than the lockfile;
//   2. writes the private configuration to .env.pending (0600): new local keys, a database and role of its own
//      named career_<install id>, and free ports (3000/3001 when free). Re-runs reuse the same file and keys;
//   3. creates that role and database in the local PostgreSQL through an administrator connection, and never
//      touches any other database on the server (an existing "career" database of another checkout is left alone);
//   4. applies the migrations, creates the private data folders and installs the Chromium used for PDFs;
//   5. only then turns .env.pending into .env, atomically. A failed run therefore never leaves a .env that
//      points at a database that does not work.
// An existing .env is never modified: bootstrap only checks it, applies pending migrations and finishes the setup.
// It does not seed demo data and does not print secrets.
//
// Options (environment variables; all optional):
//   CAREER_ADMIN_DATABASE_URL  administrator connection used once to create the role and database
//                              (default: postgresql://<macOS user>@127.0.0.1:5432/postgres, the Homebrew default)
//   CAREER_DATABASE_URL        use this existing, empty database instead of creating one (nothing is created)
//   CAREER_WEB_PORT / CAREER_API_PORT   ports for this installation (default: 3000/3001, or the next free pair)
//   CAREER_INSTALL_ID          name suffix for the database and role (default: random)
//   CAREER_SKIP_BROWSER_INSTALL=1       skip the Chromium download (PDF export then fails until it is installed)
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process';
import {
  RecoveryError, alternateEnv, alternateEnvProblem, describeDatabase, envPath, installEnv, loadPg, loopbackHosts, mtimeOf, ok, parseEnv, pendingEnvPath, portIsFree, portIsOpen,
  printRecovery, projectRoot, promoteWithoutOverwrite, say, spawnTool, startLocalPostgres, step, waitFor, warn, writePrivateFileAtomic,
} from './lib/local-env.mjs';
import { allowAdminToUseRole, releaseAdminFromRole, runAsRole } from './lib/bootstrap-database.mjs';

const at = (path) => resolve(projectRoot, path);
const fix = (es, en) => ({ es, en });
const run = (command, args, env = process.env) => spawnTool(command, args, { cwd: projectRoot, stdio: 'inherit', env });
const readText = async (path) => { try { return await readFile(path, 'utf8'); } catch { return null; } };
// Written on the role and database this script creates, so a re-run can tell them apart from anything else.
const ownerMark = (id) => `career-agent-stack install ${id}`;
const rerun = fix('Corrige lo indicado y vuelve a ejecutar: pnpm run bootstrap (retoma donde se quedó, con las mismas claves).', 'Fix the above and run again: pnpm run bootstrap (it resumes where it stopped, with the same keys).');

function checkTools() {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new RecoveryError({
    es: `Se necesita Node.js 24; este terminal usa ${process.versions.node}.`, en: `Node.js 24 is required; this terminal uses ${process.versions.node}.`,
    fixes: [fix('fnm install 24 && fnm use 24  (o nvm install 24 && nvm use 24)', 'fnm install 24 && fnm use 24  (or nvm install 24 && nvm use 24)')],
  });
  const pnpm = spawnTool('pnpm', ['--version'], { encoding: 'utf8' });
  const major = Number(pnpm.stdout?.trim().split('.')[0]);
  if (pnpm.error || pnpm.status !== 0 || major !== 11) throw new RecoveryError({
    es: pnpm.status === 0 ? `Se necesita pnpm 11; está instalado ${pnpm.stdout.trim()}.` : 'No se encontró pnpm.',
    en: pnpm.status === 0 ? `pnpm 11 is required; ${pnpm.stdout.trim()} is installed.` : 'pnpm was not found.',
    fixes: [fix('corepack enable  (usa la versión fijada en package.json)', 'corepack enable  (uses the version pinned in package.json)'), fix('O: npm install -g pnpm@11', 'Or: npm install -g pnpm@11')],
  });
  ok(`Node ${process.versions.node} y pnpm ${pnpm.stdout.trim()}`, `Node ${process.versions.node} and pnpm ${pnpm.stdout.trim()}`);
}

async function ensureDependencies() {
  const installed = await mtimeOf(at('node_modules/.modules.yaml'));
  if (installed && installed >= await mtimeOf(at('pnpm-lock.yaml')) && loadPg()) return ok('Dependencias instaladas', 'Dependencies installed');
  step('Instalando dependencias (pnpm install --frozen-lockfile)…', 'Installing dependencies (pnpm install --frozen-lockfile)…');
  if (run('pnpm', ['install', '--frozen-lockfile']).status !== 0 || !loadPg()) throw new RecoveryError({
    es: 'No se pudieron instalar las dependencias.', en: 'Dependencies could not be installed.',
    fixes: [fix('Comprueba la conexión y ejecuta: pnpm install --frozen-lockfile', 'Check the connection and run: pnpm install --frozen-lockfile'), rerun],
  });
}

async function choosePorts() {
  const requested = (name) => {
    if (!process.env[name]) return null;
    const port = Number(process.env[name]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new RecoveryError({ es: `${name} debe ser un puerto entre 1024 y 65535.`, en: `${name} must be a port between 1024 and 65535.` });
    return port;
  };
  const web = requested('CAREER_WEB_PORT');
  const api = requested('CAREER_API_PORT');
  if (web && api) {
    for (const port of [web, api]) if (!(await portIsFree(port))) throw new RecoveryError({
      es: `El puerto ${port} pedido para esta instalación está ocupado.`, en: `Port ${port} requested for this installation is busy.`,
      fixes: [fix(`Mira quién lo usa: lsof -nP -iTCP:${port} -sTCP:LISTEN, o elige otro`, `See what uses it: lsof -nP -iTCP:${port} -sTCP:LISTEN, or choose another`)],
    });
    return { web, api };
  }
  // Another checkout (or another program) may already be on 3000/3001: take the first free pair instead.
  for (const candidate of [3000, ...Array.from({ length: 90 }, (_, index) => 3100 + index * 10)]) {
    if (await portIsFree(candidate) && await portIsFree(candidate + 1)) return { web: candidate, api: candidate + 1 };
  }
  throw new RecoveryError({ es: 'No hay puertos libres entre 3000 y 4000.', en: 'No free ports between 3000 and 4000.', fixes: [fix('Indica CAREER_WEB_PORT y CAREER_API_PORT', 'Set CAREER_WEB_PORT and CAREER_API_PORT')] });
}

/** Creates .env.pending on the first run; later runs resume from it unchanged (same keys, database and ports). */
async function pendingConfiguration() {
  const existing = await readText(pendingEnvPath);
  if (existing !== null) {
    await writePrivateFileAtomic(pendingEnvPath, existing);
    ok('Se retoma la preparación anterior (.env.pending, mismas claves)', 'Resuming the previous setup (.env.pending, same keys)');
    return parseEnv(existing);
  }
  const id = (process.env.CAREER_INSTALL_ID || randomBytes(6).toString('hex')).toLowerCase();
  if (!/^[a-z0-9_]{1,40}$/.test(id)) throw new RecoveryError({ es: 'CAREER_INSTALL_ID solo admite a-z, 0-9 y _ (máx. 40).', en: 'CAREER_INSTALL_ID only allows a-z, 0-9 and _ (max 40).' });
  let databaseUrl = process.env.CAREER_DATABASE_URL;
  let mode = 'provided';
  if (databaseUrl) {
    if (!describeDatabase(databaseUrl)) throw new RecoveryError({ es: 'CAREER_DATABASE_URL no es una URL de PostgreSQL válida.', en: 'CAREER_DATABASE_URL is not a valid PostgreSQL URL.' });
  } else {
    mode = 'created';
    const admin = describeDatabase(adminUrl()) ?? { host: '127.0.0.1', port: 5432 };
    const host = admin.host.includes(':') && !admin.host.startsWith('[') ? `[${admin.host}]` : admin.host;
    databaseUrl = `postgresql://career_${id}:${randomBytes(24).toString('hex')}@${host}:${admin.port}/career_${id}`;
  }
  const ports = await choosePorts();
  const values = {
    DATABASE_URL: databaseUrl,
    APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), APP_SESSION_SECRET: randomBytes(32).toString('base64'),
    WEB_PORT: String(ports.web), WEB_ORIGIN: `http://127.0.0.1:${ports.web}`, API_PORT: String(ports.api), API_BASE_URL: `http://127.0.0.1:${ports.api}`,
    CAREER_INSTALL_ID: id, CAREER_DATABASE_MODE: mode,
  };
  let text = await readFile(at('.env.example'), 'utf8');
  for (const [key, value] of Object.entries(values)) {
    const line = new RegExp(`^${key}=.*$`, 'm');
    text = line.test(text) ? text.replace(line, () => `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
  }
  text = `# Private configuration of this installation, created by scripts/bootstrap.mjs. Never share or commit it.\n# APP_ENCRYPTION_KEY authenticates your backups and is needed to restore them; it does not encrypt stored data. Keep it, and keep the key file that pnpm run backup creates.\n${text}`;
  await writePrivateFileAtomic(pendingEnvPath, text);
  ok(`Configuración privada preparada en .env.pending (puertos ${ports.web}/${ports.api}; las claves no se muestran)`, `Private configuration prepared in .env.pending (ports ${ports.web}/${ports.api}; keys not shown)`);
  return parseEnv(text);
}

/**
 * True when the database port is published by this checkout's own Docker Compose "postgres" service
 * (compose.yaml), whose administrator is career/career. Anything else on the port is not assumed to be ours.
 */
function composeOwnsPort(port = 5432) {
  const id = spawnSync('docker', ['compose', 'ps', '--status', 'running', '-q', 'postgres'], { cwd: projectRoot, encoding: 'utf8', timeout: 15_000 });
  const container = id.status === 0 ? id.stdout.trim().split('\n')[0] : '';
  if (!container) return false;
  const published = spawnSync('docker', ['port', container, '5432/tcp'], { encoding: 'utf8', timeout: 15_000 });
  return published.status === 0 && published.stdout.split('\n').some((line) => line.trim() === `127.0.0.1:${port}`);
}

let defaultAdmin = null;

/** Explicit CAREER_ADMIN_DATABASE_URL first; then the bundled Compose administrator, only if that container owns the port; then the macOS user (Homebrew). */
function adminUrl() {
  if (process.env.CAREER_ADMIN_DATABASE_URL) return process.env.CAREER_ADMIN_DATABASE_URL;
  defaultAdmin ??= composeOwnsPort()
    ? 'postgresql://career:career@127.0.0.1:5432/postgres'
    : `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`;
  return defaultAdmin;
}

/** Makes sure something answers on the database port, starting the local PostgreSQL this Mac already has if needed. */
async function ensureServer(database) {
  const label = `${database.host}:${database.port}`;
  if (await portIsOpen(database.host, database.port)) return ok(`PostgreSQL responde en ${label}`, `PostgreSQL answers on ${label}`);
  const fixes = [
    ...(process.platform === 'win32' ? [fix('En Windows, con el servicio de PostgreSQL 17 (terminal como administrador): Start-Service postgresql-x64-17', 'On Windows, with the PostgreSQL 17 service (terminal as administrator): Start-Service postgresql-x64-17')] : []),
    fix('Con Homebrew: brew install postgresql@17 && brew services start postgresql@17', 'With Homebrew: brew install postgresql@17 && brew services start postgresql@17'),
    fix('O con Docker Desktop abierto: docker compose up -d --wait postgres, y CAREER_ADMIN_DATABASE_URL=postgresql://career:career@127.0.0.1:5432/postgres', 'Or with Docker Desktop open: docker compose up -d --wait postgres, and CAREER_ADMIN_DATABASE_URL=postgresql://career:career@127.0.0.1:5432/postgres'),
    rerun,
  ];
  if (!loopbackHosts.has(database.host)) throw new RecoveryError({ es: `El servidor PostgreSQL ${label} no responde.`, en: `The PostgreSQL server ${label} does not answer.`, fixes: [rerun] });
  step(`PostgreSQL no responde en ${label}; se intenta iniciar el de este equipo…`, `PostgreSQL does not answer on ${label}; trying to start this machine's server…`);
  const method = await startLocalPostgres();
  if (!method || !(await waitFor(() => portIsOpen(database.host, database.port), { timeoutMs: 30_000 }))) throw new RecoveryError({
    es: `No hay ningún PostgreSQL en ${label} y no se pudo iniciar uno (no se instala nada automáticamente).`,
    en: `There is no PostgreSQL on ${label} and none could be started (nothing is installed automatically).`, fixes,
  });
  defaultAdmin = null; // decide again now that a server (perhaps the bundled container) is running
  ok(`PostgreSQL iniciado (${method})`, `PostgreSQL started (${method})`);
}

async function connect(url) {
  const { Client } = loadPg();
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 8_000 });
  await client.connect();
  return client;
}

const describeFailure = (error) => ({
  '28P01': 'password rejected', '28000': 'role not allowed or does not exist', '3D000': 'database does not exist', '42501': 'insufficient privilege',
  ECONNREFUSED: 'connection refused', ETIMEDOUT: 'timed out',
})[error?.code] ?? error?.code ?? 'connection failed';

/**
 * Creates this installation's own role and database (both named career_<id>) and keeps other local roles out of it.
 * Idempotent: objects that carry this installation's mark are reused; anything else with the same name is refused.
 */
async function createOwnDatabase(values) {
  const target = new URL(values.DATABASE_URL);
  const name = decodeURIComponent(target.username);
  const admin = describeDatabase(adminUrl());
  if (!admin) throw new RecoveryError({ es: 'CAREER_ADMIN_DATABASE_URL no es una URL de PostgreSQL válida.', en: 'CAREER_ADMIN_DATABASE_URL is not a valid PostgreSQL URL.' });
  const adminUser = decodeURIComponent(new URL(adminUrl()).username) || userInfo().username;
  const mark = ownerMark(values.CAREER_INSTALL_ID);
  let client;
  try { client = await connect(adminUrl()); }
  catch (error) {
    throw new RecoveryError({
      es: `Hay un PostgreSQL en ${admin.host}:${admin.port}, pero el usuario administrador «${adminUser}» no puede conectarse (${describeFailure(error)}), así que no se puede crear la base de datos privada de esta instalación.`,
      en: `A PostgreSQL server answers on ${admin.host}:${admin.port}, but the administrator "${adminUser}" cannot connect (${describeFailure(error)}), so this installation's private database cannot be created.`,
      fixes: [
        fix('Indica un usuario con permiso CREATEROLE y CREATEDB: CAREER_ADMIN_DATABASE_URL=postgresql://USUARIO:CLAVE@127.0.0.1:5432/postgres pnpm run bootstrap', 'Give a user with CREATEROLE and CREATEDB: CAREER_ADMIN_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/postgres pnpm run bootstrap'),
        fix('O crea tú una base vacía, borra .env.pending y ejecuta: CAREER_DATABASE_URL=postgresql://... pnpm run bootstrap', 'Or create an empty database yourself, delete .env.pending, then: CAREER_DATABASE_URL=postgresql://... pnpm run bootstrap'),
        fix('Si ese servidor no es el tuyo (por ejemplo otro programa en el puerto 5432), detenlo o usa otro puerto en la URL.', 'If that server is not yours (for example another program on port 5432), stop it or use another port in the URL.'),
        rerun,
      ],
    });
  }
  try {
    const { rows: [me] } = await client.query('select rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = current_user');
    if (!me?.rolsuper && !(me?.rolcreaterole && me?.rolcreatedb)) throw new RecoveryError({
      es: `El usuario «${adminUser}» no puede crear usuarios y bases de datos en ${admin.host}:${admin.port}.`, en: `User "${adminUser}" cannot create roles and databases on ${admin.host}:${admin.port}.`,
      fixes: [fix('Usa un administrador en CAREER_ADMIN_DATABASE_URL', 'Use an administrator in CAREER_ADMIN_DATABASE_URL'), rerun],
    });
    const conflict = (kind) => new RecoveryError({
      es: `Ya existe ${kind === 'role' ? 'un usuario' : 'una base de datos'} «${name}» en el servidor que no creó esta instalación; no se toca.`,
      en: `A ${kind} named "${name}" already exists on the server and was not created by this installation; it is left untouched.`,
      fixes: [fix('Borra .env.pending y vuelve a ejecutar pnpm run bootstrap (elegirá otro nombre)', 'Delete .env.pending and run pnpm run bootstrap again (it picks another name)')],
    });
    const role = await client.query(`select shobj_description(oid, 'pg_authid') as mark from pg_roles where rolname = $1`, [name]);
    if (role.rowCount && role.rows[0].mark !== mark) throw conflict('role');
    const password = client.escapeLiteral(decodeURIComponent(target.password));
    if (role.rowCount) await client.query(`alter role ${client.escapeIdentifier(name)} with login password ${password}`);
    else await client.query(`create role ${client.escapeIdentifier(name)} with login password ${password}`);
    await client.query(`comment on role ${client.escapeIdentifier(name)} is ${client.escapeLiteral(mark)}`);
    let granted;
    try { granted = await allowAdminToUseRole(client, name); }
    catch (error) {
      if (error?.code !== '42501') throw error;
      const grantee = client.escapeIdentifier(name), member = client.escapeIdentifier(adminUser);
      throw new RecoveryError({
        es: `El usuario «${adminUser}» no puede actuar como el usuario nuevo «${name}», necesario para crear su base de datos.`,
        en: `User "${adminUser}" cannot act as the new role "${name}", which is needed to create its database.`,
        fixes: [fix(`Como superusuario de PostgreSQL: GRANT ${grantee} TO ${member} WITH SET TRUE, INHERIT FALSE; y vuelve a ejecutar`, `As a PostgreSQL superuser: GRANT ${grantee} TO ${member} WITH SET TRUE, INHERIT FALSE; then run again`), rerun],
      });
    }
    const database = decodeURIComponent(target.pathname.slice(1));
    const existing = await client.query(`select shobj_description(oid, 'pg_database') as mark from pg_database where datname = $1`, [database]);
    if (existing.rowCount && existing.rows[0].mark !== mark) throw conflict('database');
    if (!existing.rowCount) await client.query(`create database ${client.escapeIdentifier(database)} owner ${client.escapeIdentifier(name)} encoding 'UTF8' template template0`);
    const protect = async () => {
      await client.query(`comment on database ${client.escapeIdentifier(database)} is ${client.escapeLiteral(mark)}`);
      await client.query(`revoke all on database ${client.escapeIdentifier(database)} from public`);
    };
    // Both statements check ownership; the grant above is SET only, so become the owner just for them.
    if (granted) { await runAsRole(client, name, protect); await releaseAdminFromRole(client, name); } else await protect();
    ok(`Base de datos propia lista: ${database} (usuario ${name}, sin acceso para otros usuarios locales)`, `Own database ready: ${database} (role ${name}, no access for other local roles)`);
  } finally { await client.end().catch(() => undefined); }
}

/** Connects with the installation's own credentials, exactly as the API will. */
async function checkCredentials(values, origin) {
  const database = describeDatabase(values.DATABASE_URL);
  let client;
  try {
    client = await connect(values.DATABASE_URL);
    await client.query('select 1');
  } catch (error) {
    throw new RecoveryError({
      es: `PostgreSQL responde en ${database.host}:${database.port}, pero rechaza la conexión de ${origin} a «${database.database}» (${describeFailure(error)}).`,
      en: `PostgreSQL answers on ${database.host}:${database.port}, but refuses ${origin}'s connection to "${database.database}" (${describeFailure(error)}).`,
      fixes: origin === '.env' ? [
        fix('Puede que ese puerto lo ocupe otro PostgreSQL distinto del que usaba esta instalación (lsof -nP -iTCP:5432 -sTCP:LISTEN).', 'Another PostgreSQL than the one this installation used may own that port (lsof -nP -iTCP:5432 -sTCP:LISTEN).'),
        fix('No borres .env: contiene la clave que protege tus datos. Arranca el servidor correcto y repite.', 'Do not delete .env: it holds the key that protects your data. Start the right server and retry.'),
      ] : [rerun],
    });
  } finally { await client?.end().catch(() => undefined); }
  ok(`Conexión a ${database.database} comprobada`, `Connection to ${database.database} verified`);
}

function migrate(values) {
  step('Aplicando migraciones pendientes (los datos existentes se conservan)…', 'Applying pending migrations (existing data is kept)…');
  if (run('pnpm', ['run', '--silent', 'db:migrate'], installEnv(values)).status !== 0) throw new RecoveryError({
    es: 'Las migraciones no se aplicaron.', en: 'The migrations were not applied.', fixes: [rerun],
  });
}

function installBrowser() {
  if (process.env.CAREER_SKIP_BROWSER_INSTALL === '1') return warn('Chromium no se instaló (CAREER_SKIP_BROWSER_INSTALL=1): exportar PDF fallará hasta instalarlo.', 'Chromium was not installed (CAREER_SKIP_BROWSER_INSTALL=1): PDF export fails until it is.');
  step('Instalando Chromium para generar PDF localmente…', 'Installing Chromium for local PDF rendering…');
  if (run('pnpm', ['--filter', '@career/api', 'exec', 'playwright', 'install', 'chromium']).status !== 0) warn(
    'Chromium no se pudo instalar: la aplicación funciona, pero exportar PDF fallará. Reinténtalo con: pnpm --filter @career/api exec playwright install chromium',
    'Chromium could not be installed: the app works, but PDF export will fail. Retry with: pnpm --filter @career/api exec playwright install chromium',
  );
}

async function privateFolders(values) {
  for (const path of [values.DATA_LOCAL_PATH || './data', values.FILES_LOCAL_PATH || './data/files', ...(alternateEnv ? [] : ['backups'])]) {
    await mkdir(resolve(projectRoot, path), { recursive: true, mode: 0o700 });
  }
}

async function main() {
  say('Career Agent Stack · preparación local', 'Career Agent Stack · local setup');
  checkTools();
  await ensureDependencies();

  const current = await readText(envPath);
  if (alternateEnv && current === null) throw new RecoveryError({
    es: `No existe ${envPath} (CAREER_ENV_FILE). Con CAREER_ENV_FILE solo se comprueba una instalación existente; no se crea ninguna.`,
    en: `${envPath} (CAREER_ENV_FILE) does not exist. CAREER_ENV_FILE only checks an existing installation; none is created.`,
  });
  if (alternateEnv && alternateEnvProblem(parseEnv(current))) throw new RecoveryError(alternateEnvProblem(parseEnv(current)));
  if (current !== null) {
    if (((await stat(envPath)).mode & 0o077) !== 0) warn('.env es legible por otros usuarios de este equipo; corrígelo con: chmod 600 .env', '.env is readable by other users of this machine; fix it with: chmod 600 .env');
    ok('.env ya existe; no se modifica', '.env already exists; left unchanged');
    const values = parseEnv(current);
    const database = describeDatabase(values.DATABASE_URL ?? '');
    if (!database || (values.APP_ENCRYPTION_KEY ?? '').length < 32 || (values.APP_SESSION_SECRET ?? '').length < 32) throw new RecoveryError({
      es: '.env existe pero está incompleto (DATABASE_URL o claves locales).', en: '.env exists but is incomplete (DATABASE_URL or local keys).',
      fixes: [fix('Revisa: pnpm run doctor. No borres .env: contiene la clave que protege tus datos.', 'Check: pnpm run doctor. Do not delete .env: it holds the key that protects your data.')],
    });
    if (await readText(pendingEnvPath) !== null) warn('Hay un .env.pending de una preparación anterior; se ignora porque .env ya existe.', 'A .env.pending from an earlier setup is ignored because .env already exists.');
    await ensureServer(database);
    await checkCredentials(values, '.env');
    migrate(values);
    await privateFolders(values);
    installBrowser();
    say('✓ Instalación lista. Inicia con: pnpm start', '✓ Installation ready. Start with: pnpm start');
    return;
  }

  const values = await pendingConfiguration();
  const database = describeDatabase(values.DATABASE_URL ?? '');
  await ensureServer(database);
  if (values.CAREER_DATABASE_MODE === 'created') await createOwnDatabase(values);
  await checkCredentials(values, 'esta instalación / this installation');
  migrate(values);
  await privateFolders(values);
  installBrowser();
  if (!(await promoteWithoutOverwrite(pendingEnvPath, envPath))) throw new RecoveryError({
    es: 'Otro proceso creó .env mientras tanto; no se sobrescribe.', en: 'Another process created .env meanwhile; it is not overwritten.', fixes: [rerun],
  });
  ok('.env creado (privado, 0600). Contiene la clave que protege tus datos: no lo borres.', '.env created (private, 0600). It holds the key that protects your data: do not delete it.');
  say(`✓ Instalación lista en ${values.WEB_ORIGIN}. Inicia con: pnpm start (o doble clic en Start Career Agent Stack.command)`, `✓ Installation ready on ${values.WEB_ORIGIN}. Start with: pnpm start (or double-click Start Career Agent Stack.command)`);
}

try { await main(); }
catch (error) { printRecovery(error); process.exitCode = 1; }
