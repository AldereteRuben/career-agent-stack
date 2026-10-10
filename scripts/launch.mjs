// Local launcher: reuses services that are already healthy, starts the missing ones,
// waits until they answer and opens the workspace in the browser.
//
//   pnpm start            start or reuse everything and open the browser
//   pnpm start --no-open  same, without opening the browser
//   pnpm start --copy-token  also copy the pending single-use sign-in token to the clipboard (never printed)
//   pnpm run status       read-only report; starts, builds and migrates nothing; exits 1 when something needs attention
//
// It never seeds demo data or deletes workspace data, and never prints secrets.
// --recover-session explicitly replaces the local one-time sign-in code; existing sessions remain valid.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { access, chmod, mkdir, open, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import {
  RecoveryError, alternateEnv, alternateEnvProblem, describeDatabase, envPath, httpStatus, installEnv, listeningPid, localDataPath, logDir, maskSecrets, mtimeOf, newestMtime, ok, parentArgs,
  pendingEnvPath, portIsOpen, printRecovery, processIdentity, projectRoot, readLocalEnv, recordStarted, runDir, say, startLocalPostgres, step,
  spawnTool, waitFor, warn, writePrivateFileAtomic,
} from './lib/local-env.mjs';
import { clipboardTools, missingClipboardAdvice } from './lib/clipboard.mjs';

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const openBrowser = !args.has('--no-open') && !checkOnly;
const copyToken = (args.has('--copy-token') || args.has('--recover-session')) && !checkOnly;

// Things that need the user's attention. `pnpm run status` exits non-zero when there is any.
let attention = 0;
const problem = (es, en) => { attention += 1; warn(es, en); };
const at = (...parts) => resolve(projectRoot, ...parts);

const fix = (es, en) => ({ es, en });
const run = (command, commandArgs, options = {}) => spawnTool(command, commandArgs, { cwd: projectRoot, stdio: 'inherit', ...options });
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };

// One launcher per checkout: migrations, dependency installation and .next are shared,
// even when CAREER_ENV_FILE selects a different installation. Never steal a lock:
// a compiler child can still be running after its launcher has been interrupted.
async function lockStartup() {
  const lockPath = at('data/launcher.lock');
  await mkdir(at('data'), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 300_000;
  let announced = false;
  while (true) {
    let handle;
    try { handle = openSync(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!announced) {
        step('Otro inicio está en curso; esperando a que termine…', 'Another startup is in progress; waiting for it to finish…');
        announced = true;
      }
      if (Date.now() >= deadline) throw new RecoveryError({
        es: 'El otro inicio no terminó en 5 minutos.', en: 'The other startup did not finish within 5 minutes.',
        fixes: [fix('Revisa el otro terminal. Si se interrumpió, comprueba que no queden procesos de inicio o compilación antes de retirar data/launcher.lock y repetir el inicio.', 'Check the other terminal. If it was interrupted, confirm no startup or build processes remain before removing data/launcher.lock and starting again.')],
      });
      await delay(1_000);
      continue;
    }
    const release = () => {
      if (handle === undefined) return;
      closeSync(handle);
      handle = undefined;
      unlinkSync(lockPath);
      process.off('exit', release);
    };
    process.once('exit', release);
    try { writeFileSync(handle, `${process.pid}\n`); }
    catch (error) { release(); throw error; }
    return release;
  }
}

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major === 24) return ok(`Node ${process.versions.node}`, `Node ${process.versions.node}`);
  throw new RecoveryError({
    es: `Se necesita Node.js 24; este terminal usa ${process.versions.node}.`,
    en: `Node.js 24 is required; this terminal uses ${process.versions.node}.`,
    fixes: [
      fix('Con fnm: fnm install 24 && fnm use 24', 'With fnm: fnm install 24 && fnm use 24'),
      fix('Con nvm: nvm install 24 && nvm use 24', 'With nvm: nvm install 24 && nvm use 24'),
      fix('O instala Node 24 LTS desde https://nodejs.org', 'Or install Node 24 LTS from https://nodejs.org'),
    ],
  });
}

async function checkDependencies() {
  const pnpm = spawnTool('pnpm', ['--version'], { encoding: 'utf8' });
  if (pnpm.error || pnpm.status !== 0) throw new RecoveryError({
    es: 'No se encontró pnpm.', en: 'pnpm was not found.',
    fixes: [fix('Actívalo con: corepack enable', 'Enable it with: corepack enable'), fix('O instálalo: npm install -g pnpm@11', 'Or install it: npm install -g pnpm@11')],
  });
  const installed = await mtimeOf(at('node_modules/.modules.yaml'));
  const lockfile = await mtimeOf(at('pnpm-lock.yaml'));
  if (installed && installed >= lockfile) return ok('Dependencias instaladas', 'Dependencies installed');
  if (checkOnly) return problem('Faltan dependencias o están desactualizadas (pnpm install --frozen-lockfile)', 'Dependencies missing or outdated (pnpm install --frozen-lockfile)');
  step('Instalando dependencias…', 'Installing dependencies…');
  if (run('pnpm', ['install', '--frozen-lockfile']).status !== 0) throw new RecoveryError({
    es: 'No se pudieron instalar las dependencias.', en: 'Dependencies could not be installed.',
    fixes: [fix('Comprueba tu conexión y ejecuta: pnpm install --frozen-lockfile', 'Check your connection and run: pnpm install --frozen-lockfile')],
  });
}

async function loadEnvironment() {
  let env = await readLocalEnv();
  if (!env && alternateEnv) throw new RecoveryError({
    es: `No existe el archivo de configuración indicado en CAREER_ENV_FILE (${envPath}).`, en: `The configuration file given in CAREER_ENV_FILE does not exist (${envPath}).`,
    fixes: [fix('Comprueba la ruta (por ejemplo, el .env de la carpeta restaurada). Con CAREER_ENV_FILE no se prepara nada nuevo.', 'Check the path (for example the .env of the restored folder). With CAREER_ENV_FILE nothing new is set up.')],
  });
  if (!env) {
    if (checkOnly) throw new RecoveryError({
      es: 'Falta el archivo privado .env: este equipo aún no está preparado.', en: 'The private .env file is missing: this machine is not set up yet.',
      fixes: [fix('Ejecuta: pnpm run bootstrap (o pnpm start, que lo hace por ti)', 'Run: pnpm run bootstrap (or pnpm start, which does it for you)')],
    });
    if (await exists(pendingEnvPath)) step('La preparación inicial no terminó la última vez; se retoma donde se quedó…', 'Initial setup did not finish last time; resuming where it stopped…');
    else step('Primera ejecución: preparando la configuración privada…', 'First run: preparing the private configuration…');
    if (run(process.execPath, ['scripts/bootstrap.mjs']).status !== 0) throw new RecoveryError({
      es: 'La preparación inicial no terminó.', en: 'Initial setup did not finish.',
      fixes: [fix('Lee el mensaje anterior y vuelve a ejecutar: pnpm run bootstrap', 'Read the message above and run again: pnpm run bootstrap')],
    });
    env = await readLocalEnv();
  }
  const database = describeDatabase(env?.DATABASE_URL ?? '');
  const secretsReady = (env?.APP_ENCRYPTION_KEY ?? '').length >= 32 && (env?.APP_SESSION_SECRET ?? '').length >= 32;
  if (!database || !secretsReady) throw new RecoveryError({
    es: '.env existe pero está incompleto (DATABASE_URL o claves locales).', en: '.env exists but is incomplete (DATABASE_URL or local keys).',
    fixes: [
      fix('Revisa: pnpm run doctor', 'Check: pnpm run doctor'),
      fix('No borres .env: contiene la clave que protege tus datos. Compáralo con .env.example.', 'Do not delete .env: it holds the key that protects your data. Compare it with .env.example.'),
    ],
  });
  const apiPort = Number(env.API_PORT || 3001);
  const webPort = Number(env.WEB_PORT || 3000);
  const apiBase = env.API_BASE_URL || `http://127.0.0.1:${apiPort}`;
  const webOrigin = env.WEB_ORIGIN || `http://127.0.0.1:${webPort}`;
  if (new URL(webOrigin).port !== String(webPort)) warn(`WEB_ORIGIN (${webOrigin}) no usa WEB_PORT=${webPort}; las escrituras serán rechazadas.`, `WEB_ORIGIN (${webOrigin}) does not use WEB_PORT=${webPort}; writes will be rejected.`);
  const outside = alternateEnvProblem(env);
  if (outside) throw new RecoveryError({ ...outside, fixes: [fix('Corrige ese archivo; los datos de esta copia no se usan para otra instalación.', 'Fix that file; this checkout\'s data is never used for another installation.')] });
  if (alternateEnv) ok(`Configuración seleccionada con CAREER_ENV_FILE: ${envPath} (datos, registros y procesos en su carpeta de datos)`, `Configuration selected with CAREER_ENV_FILE: ${envPath} (data, logs and process records in its data folder)`);
  else ok('Configuración privada presente (no se muestra)', 'Private configuration present (not shown)');
  // Child processes get this installation's .env values, never DATABASE_URL, keys or ports exported in the shell.
  return { database, apiPort, webPort, apiBase, webOrigin, childEnv: installEnv(env) };
}

/**
 * The web app build bakes API_BASE_URL into its /api rewrite. A checkout that has its own installation (.env) must
 * never have its build replaced for another installation selected with CAREER_ENV_FILE: that would silently point
 * the live web app at the other API. Checked before anything is started.
 */
async function guardSharedBuild({ apiBase }) {
  if (!alternateEnv || !(await exists(at('.env'))) || checkOnly || !(await dashboardNeedsBuild(apiBase, { strict: true }))) return;
  throw new RecoveryError({
    es: 'Esta copia del proyecto tiene su propia instalación (.env) y su compilación web es para otra API; no se recompila para la configuración de CAREER_ENV_FILE.',
    en: 'This checkout has its own installation (.env) and its web build targets another API; it is not rebuilt for the CAREER_ENV_FILE configuration.',
    fixes: [
      fix('Usa otra copia del código de la misma versión: git worktree add ../career-restored && cd ../career-restored && pnpm install --frozen-lockfile', 'Use another checkout of the same version: git worktree add ../career-restored && cd ../career-restored && pnpm install --frozen-lockfile'),
      fix(`Y allí: CAREER_ENV_FILE="${envPath}" pnpm start`, `Then there: CAREER_ENV_FILE="${envPath}" pnpm start`),
    ],
  });
}

async function ensureDatabase({ database }) {
  const label = `${database.host}:${database.port}/${database.database}`;
  if (await portIsOpen(database.host, database.port)) return ok(`PostgreSQL responde en ${label}`, `PostgreSQL answers on ${label}`);
  const fixes = [
    fix('Si usas Homebrew: brew services start postgresql@17', 'If you use Homebrew: brew services start postgresql@17'),
    fix('Si usas Docker: abre Docker Desktop y ejecuta docker compose up -d --wait postgres', 'If you use Docker: open Docker Desktop and run docker compose up -d --wait postgres'),
    fix('O apunta DATABASE_URL en .env a un PostgreSQL 17 accesible', 'Or point DATABASE_URL in .env at a reachable PostgreSQL 17'),
  ];
  if (!database.loopback) throw new RecoveryError({ es: `La base de datos remota ${label} no responde.`, en: `The remote database ${label} does not answer.`, fixes: fixes.slice(2) });
  if (checkOnly) return problem(`PostgreSQL no responde en ${label}`, `PostgreSQL does not answer on ${label}`);

  step('Iniciando PostgreSQL local…', 'Starting local PostgreSQL…');
  const method = await startLocalPostgres();
  if (!method || !(await waitFor(() => portIsOpen(database.host, database.port), { timeoutMs: 30_000 }))) {
    throw new RecoveryError({ es: `No se pudo iniciar PostgreSQL en ${label}.`, en: `PostgreSQL could not be started on ${label}.`, fixes });
  }
  ok(`PostgreSQL iniciado (${method})`, `PostgreSQL started (${method})`);
}

function runQuiet(command, commandArgs, env) {
  const result = spawnTool(command, commandArgs, { cwd: projectRoot, encoding: 'utf8', env });
  if (result.status !== 0) process.stderr.write(maskSecrets(`${result.stdout ?? ''}\n${result.stderr ?? ''}`).split('\n').slice(-25).join('\n') + '\n');
  return result.status === 0;
}

async function apiNeedsBuild() {
  const built = await mtimeOf(at('apps/api/dist/server.js'));
  const shared = Math.min(await mtimeOf(at('packages/db/dist/index.js')), await mtimeOf(at('packages/domain/dist/index.js')));
  const sources = await newestMtime([at('apps/api/src'), at('packages/db/src'), at('packages/domain/src'), at('packages/db/migrations')]);
  return !built || !shared || sources > Math.min(built, shared);
}

// The dashboard's /api rewrite to API_BASE_URL is fixed at build time, so a build made for another API port is stale.
const dashboardStamp = at('apps/dashboard/.next/career-api-base');

async function dashboardNeedsBuild(apiBase, { strict = false } = {}) {
  const built = await mtimeOf(at('apps/dashboard/.next/BUILD_ID'));
  const sources = await newestMtime(['app', 'components', 'lib', 'next.config.ts', 'package.json'].map((part) => at('apps/dashboard', part)));
  let builtFor = null;
  try { builtFor = (await readFile(dashboardStamp, 'utf8')).trim(); } catch { /* builds from older launchers carry no stamp */ }
  // strict: a build without a stamp counts as made for another API (used before building for CAREER_ENV_FILE).
  return !built || sources > built || (builtFor !== null && builtFor !== apiBase) || (strict && builtFor === null);
}

/**
 * Starts a service in its own process group and records its exact identity (PID, process group, start time,
 * working directory and absolute entry point). `pnpm run stop` only signals a process that still matches it.
 */
async function startDetached(name, command, commandArgs, { cwd, env, entry, titles = [] }) {
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  const logPath = resolve(logDir, `${name}.log`);
  const log = await open(logPath, 'a', 0o600);
  await chmod(logPath, 0o600);
  const child = spawn(command, commandArgs, { cwd, env, detached: true, stdio: ['ignore', log.fd, log.fd] });
  child.unref();
  await log.close();
  let identity = null;
  for (let attempt = 0; attempt < 10 && !identity; attempt += 1) {
    identity = await processIdentity(child.pid);
    if (!identity) await new Promise((done) => globalThis.setTimeout(done, 200));
  }
  if (!identity) warn(`No se pudo registrar la identidad del proceso ${name}; pnpm run stop no lo detendrá.`, `Could not record the identity of the ${name} process; pnpm run stop will not stop it.`);
  await recordStarted(name, {
    version: 2, projectRoot, pid: child.pid, pgid: identity?.pgid ?? null, lstart: identity?.lstart ?? null,
    cwd: identity?.cwd ?? null, entry, titles, log: logPath,
  });
  return logPath;
}

/**
 * Whether a reused service runs the current code. Never restarts anything: it only reports.
 * Dev servers (tsx watch / next dev) reload by themselves and count as current.
 */
async function reportFreshness(name, labels, { port, buildMtime, needsBuild, isDev }) {
  const pid = listeningPid(port);
  const identity = pid ? await processIdentity(pid) : null;
  if (!identity) return problem(`${labels.es}: no se pudo comprobar qué versión está en marcha (puede no ser la última).`, `${labels.en}: could not verify which version is running (it may not be the latest).`);
  if (isDev(identity)) return ok(`${labels.es}: modo desarrollo, recarga los cambios solo`, `${labels.en}: development mode, reloads changes by itself`);
  let ownRecord = null;
  try { ownRecord = JSON.parse(await readFile(resolve(runDir, `${name}.json`), 'utf8')); } catch { /* not started by the launcher */ }
  const ours = ownRecord?.pid === identity.pid || (ownRecord?.pgid && ownRecord.pgid === identity.pgid);
  const restart = ours
    ? fix('Reinicia: pnpm run stop y después pnpm start', 'Restart: pnpm run stop, then pnpm start')
    : fix(`Este proceso (PID ${identity.pid}) no lo inició el lanzador: detenlo donde lo arrancaste y ejecuta pnpm start`, `This process (PID ${identity.pid}) was not started by the launcher: stop it where you started it, then run pnpm start`);
  if (needsBuild) {
    problem(`${labels.es} en marcha, pero el código cambió después de la última compilación: NO es la versión más reciente. Hace falta reiniciar.`, `${labels.en} is running, but the code changed after the last build: it is NOT the latest version. A restart is required.`);
    return say(`    – ${restart.es}`, `    – ${restart.en}`, process.stderr);
  }
  // `ps` start times have one-second resolution.
  if (buildMtime > identity.startedAt + 1_000) {
    problem(`${labels.es} en marcha desde antes de la compilación actual: NO usa la versión más reciente. Hace falta reiniciar.`, `${labels.en} has been running since before the current build: it is NOT using the latest version. A restart is required.`);
    return say(`    – ${restart.es}`, `    – ${restart.en}`, process.stderr);
  }
  ok(`${labels.es}: ejecuta la compilación actual`, `${labels.en}: running the current build`);
}

async function tail(path, lines = 20) {
  try { return maskSecrets((await readFile(path, 'utf8')).split('\n').slice(-lines).join('\n')); } catch { return ''; }
}

const apiHealthy = async (apiBase) => {
  const health = await httpStatus(`${apiBase}/healthz`);
  return health.status === 200 && health.body?.database === 'ready';
};

async function ensureApi({ apiBase, apiPort, childEnv }) {
  if (await apiHealthy(apiBase)) {
    ok(`API en marcha y sana (${apiBase})${checkOnly ? '' : '; se reutiliza'}`, `API running and healthy (${apiBase})${checkOnly ? '' : '; reusing it'}`);
    return reportFreshness('api', { es: 'API', en: 'API' }, {
      port: apiPort, buildMtime: await mtimeOf(at('apps/api/dist/server.js')), needsBuild: await apiNeedsBuild(),
      isDev: (identity) => /\btsx\b/.test(identity.args) || /\btsx\b.*\bwatch\b/.test(parentArgs(identity.pid)),
    });
  }
  if (await portIsOpen('127.0.0.1', apiPort)) throw new RecoveryError({
    es: `El puerto ${apiPort} está ocupado pero la API no responde como sana.`, en: `Port ${apiPort} is busy but the API does not report healthy.`,
    fixes: [
      fix('Si lo inició este lanzador: pnpm run stop y vuelve a probar', 'If this launcher started it: pnpm run stop and try again'),
      fix(`Para ver quién lo usa: lsof -nP -iTCP:${apiPort} -sTCP:LISTEN`, `To see what uses it: lsof -nP -iTCP:${apiPort} -sTCP:LISTEN`),
      fix('Si la API responde pero la base de datos no, inicia PostgreSQL primero', 'If the API answers but the database does not, start PostgreSQL first'),
    ],
  });
  const needsBuild = await apiNeedsBuild();
  if (checkOnly) return problem(`API detenida${needsBuild ? ' (necesita compilarse)' : ''}`, `API stopped${needsBuild ? ' (needs a build)' : ''}`);

  step('Aplicando migraciones pendientes de la base de datos (no borra datos existentes)…', 'Applying pending database migrations (existing data is kept)…');
  if (!runQuiet('pnpm', ['run', '--silent', 'db:migrate'], childEnv)) throw new RecoveryError({
    es: 'No se pudieron aplicar las migraciones.', en: 'Database migrations could not be applied.',
    fixes: [fix('Comprueba que PostgreSQL acepta las credenciales de .env: pnpm run doctor', 'Check that PostgreSQL accepts the .env credentials: pnpm run doctor')],
  });
  if (needsBuild) {
    step('Compilando la API…', 'Building the API…');
    if (run('pnpm', ['run', 'build:shared'], { env: childEnv }).status !== 0 || run('pnpm', ['--filter', '@career/api', 'build'], { env: childEnv }).status !== 0) throw new RecoveryError({
      es: 'La API no compila.', en: 'The API does not build.', fixes: [fix('Revisa el error anterior o ejecuta: pnpm run typecheck', 'Review the error above or run: pnpm run typecheck')],
    });
  }
  step('Iniciando la API…', 'Starting the API…');
  const entry = at('apps/api/dist/server.js');
  const logPath = await startDetached('api', process.execPath, [entry], { cwd: at('apps/api'), env: childEnv, entry });
  if (!(await waitFor(() => apiHealthy(apiBase), { timeoutMs: 60_000 }))) {
    process.stderr.write(`${await tail(logPath)}\n`);
    throw new RecoveryError({
      es: 'La API no quedó lista en 60 s.', en: 'The API was not ready within 60 s.',
      fixes: [fix(`Registro: ${logPath}`, `Log: ${logPath}`), fix('Comprueba la configuración: pnpm run doctor', 'Check the configuration: pnpm run doctor')],
    });
  }
  ok(`API lista en ${apiBase}`, `API ready on ${apiBase}`);
}

async function ensureDashboard({ webOrigin, webPort, apiBase }) {
  const login = await httpStatus(`${webOrigin}/login`, 5_000);
  if (login.status >= 200 && login.status < 400) {
    ok(`Aplicación web en marcha (${webOrigin})${checkOnly ? '' : '; se reutiliza'}`, `Web app running (${webOrigin})${checkOnly ? '' : '; reusing it'}`);
    return reportFreshness('dashboard', { es: 'Aplicación web', en: 'Web app' }, {
      port: webPort, buildMtime: await mtimeOf(at('apps/dashboard/.next/BUILD_ID')), needsBuild: await dashboardNeedsBuild(apiBase),
      isDev: (identity) => /\bnext\b.*\bdev\b/.test(identity.args) || /\bnext\b.*\bdev\b|\bnext dev\b/.test(parentArgs(identity.pid)),
    });
  }
  if (await portIsOpen('127.0.0.1', webPort)) throw new RecoveryError({
    es: `El puerto ${webPort} está ocupado por otra cosa.`, en: `Port ${webPort} is used by something else.`,
    fixes: [
      fix('Si lo inició este lanzador: pnpm run stop', 'If this launcher started it: pnpm run stop'),
      fix(`Para ver quién lo usa: lsof -nP -iTCP:${webPort} -sTCP:LISTEN`, `To see what uses it: lsof -nP -iTCP:${webPort} -sTCP:LISTEN`),
    ],
  });
  const needsBuild = await dashboardNeedsBuild(apiBase);
  if (checkOnly) return problem(`Aplicación web detenida${needsBuild ? ' (necesita compilarse)' : ''}`, `Web app stopped${needsBuild ? ' (needs a build)' : ''}`);
  // Only what the web app needs: the .env values (NODE_ENV=development among them) would break `next build`.
  const env = installEnv({}, { API_BASE_URL: apiBase, NEXT_TELEMETRY_DISABLED: '1' });
  if (needsBuild) {
    step('Compilando la aplicación web (la primera vez tarda unos minutos)…', 'Building the web app (the first time takes a few minutes)…');
    if (run('pnpm', ['--filter', '@career/dashboard', 'build'], { env }).status !== 0) throw new RecoveryError({
      es: 'La aplicación web no compila.', en: 'The web app does not build.', fixes: [fix('Revisa el error anterior o ejecuta: pnpm run typecheck', 'Review the error above or run: pnpm run typecheck')],
    });
    await writePrivateFileAtomic(dashboardStamp, `${apiBase}\n`);
  }
  step('Iniciando la aplicación web…', 'Starting the web app…');
  const nextBin = at('apps/dashboard/node_modules/next/dist/bin/next');
  // Next renames its process to "next-server (vX)", so that title is accepted alongside the entry path.
  const logPath = await startDetached('dashboard', process.execPath, [nextBin, 'start', '--hostname', '127.0.0.1', '--port', String(webPort)], { cwd: at('apps/dashboard'), env, entry: nextBin, titles: ['next-server'] });
  const ready = await waitFor(async () => { const status = (await httpStatus(`${webOrigin}/login`, 5_000)).status; return status >= 200 && status < 400; }, { timeoutMs: 90_000, intervalMs: 1_000 });
  if (!ready) {
    process.stderr.write(`${await tail(logPath)}\n`);
    throw new RecoveryError({ es: 'La aplicación web no quedó lista en 90 s.', en: 'The web app was not ready within 90 s.', fixes: [fix(`Registro: ${logPath}`, `Log: ${logPath}`)] });
  }
  ok(`Aplicación web lista en ${webOrigin}`, `Web app ready on ${webOrigin}`);
}

const availableClipboardTools = () => clipboardTools({ has: (tool) => spawnSync('which', [tool], { stdio: 'ignore' }).status === 0 });

// Runs detached after the launcher exits: clears the clipboard only if it still holds the token.
// It receives a SHA-256 of the token, never the token itself, so nothing secret appears in `ps`.
const clearClipboardLater = `
const { spawnSync } = require('node:child_process'); const { createHash } = require('node:crypto');
const [hash, seconds, tools] = process.argv.slice(1); const { copy, paste } = JSON.parse(tools);
setTimeout(() => {
  const current = spawnSync(paste[0], paste[1], { encoding: 'utf8' }).stdout ?? '';
  if (createHash('sha256').update(current.trim()).digest('hex') === hash) spawnSync(copy[0], copy[1], { input: '' });
}, Number(seconds) * 1000);`;

/**
 * Copies the single-use sign-in token to the clipboard without printing it, putting it in a URL or logging it,
 * and clears the clipboard two minutes later if it still holds the token.
 */
async function copyTokenToClipboard(tokenPath) {
  const tools = availableClipboardTools();
  if (!tools) {
    const advice = missingClipboardAdvice({ tokenPath: relative(projectRoot, tokenPath).startsWith('..') ? tokenPath : relative(projectRoot, tokenPath) });
    return warn(`No hay herramienta de portapapeles disponible. ${advice.es}`, `No clipboard tool available. ${advice.en}`);
  }
  const token = (await readFile(tokenPath, 'utf8')).trim();
  const copied = spawnSync(tools.copy[0], tools.copy[1], { input: token, stdio: ['pipe', 'ignore', 'ignore'] });
  if (copied.status !== 0) return warn('No se pudo copiar el token al portapapeles.', 'Could not copy the token to the clipboard.');
  const hash = createHash('sha256').update(token).digest('hex');
  spawn(process.execPath, ['-e', clearClipboardLater, hash, '120', JSON.stringify(tools)], { detached: true, stdio: 'ignore' }).unref();
  ok('Token de acceso copiado al portapapeles (no se muestra). Pégalo en la pantalla de acceso: sirve una sola vez.', 'Sign-in token copied to the clipboard (not shown). Paste it on the sign-in screen: it works once.');
  say('  Se borrará del portapapeles en 2 minutos si sigue ahí. Si usas un gestor de portapapeles con historial, puede guardar una copia.', 'It will be cleared from the clipboard in 2 minutes if still there. A clipboard manager with history may keep a copy.');
}

async function signInHint() {
  const tokenPath = resolve(localDataPath(await readLocalEnv()), 'setup-token');
  const shown = relative(projectRoot, tokenPath).startsWith('..') ? tokenPath : relative(projectRoot, tokenPath);
  if (await exists(tokenPath)) {
    if (copyToken) return copyTokenToClipboard(tokenPath);
    say(`  Si la pantalla pide un token de acceso, está guardado (sin mostrarse aquí) en ${shown}.`, `If the screen asks for a sign-in token, it is stored (not shown here) in ${shown}.`);
    say('  Para copiarlo al portapapeles sin verlo: pnpm start --copy-token   (se usa una sola vez)', 'To copy it to the clipboard without seeing it: pnpm start --copy-token   (single use)');
  } else {
    say('  No hay token pendiente: si ya iniciaste sesión en este navegador, no hace falta.', 'No pending token: if you already signed in on this browser, none is needed.');
    say('  Si la pantalla pide un token: pnpm run reset:session (no borra datos) y luego pnpm start --copy-token.', 'If the screen asks for a token: pnpm run reset:session (keeps your data), then pnpm start --copy-token.');
  }
}

async function main() {
  say(checkOnly ? 'Career Agent Stack · estado (solo lectura)' : 'Career Agent Stack · inicio local', checkOnly ? 'Career Agent Stack · status (read-only)' : 'Career Agent Stack · local start');
  checkNode();
  await checkDependencies();
  const settings = await loadEnvironment();
  await guardSharedBuild(settings);
  await ensureDatabase(settings);
  await ensureApi(settings);
  await ensureDashboard(settings);
  process.stdout.write('\n');
  if (checkOnly) {
    if (!attention) return ok('Todo en orden.', 'Everything is in order.');
    say(`✗ ${attention} aviso(s) requieren atención (ver arriba).`, `✗ ${attention} warning(s) need attention (see above).`, process.stderr);
    process.exitCode = 1;
    return;
  }
  if (attention) say(`! Listo, con ${attention} aviso(s): ${settings.webOrigin} puede no ejecutar la última versión (ver arriba).`, `! Ready with ${attention} warning(s): ${settings.webOrigin} may not run the latest version (see above).`);
  else ok(`Listo: ${settings.webOrigin}`, `Ready: ${settings.webOrigin}`);
  if (args.has('--recover-session')) {
    const recovery = run(process.execPath, [at('scripts/reset-session.mjs')]);
    if (recovery.status !== 0) throw new Error('Could not create a new sign-in code.');
  }
  await signInHint();
  say('  Para detener solo lo que inició este lanzador: pnpm run stop', 'To stop only what this launcher started: pnpm run stop');
  if (openBrowser) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    if (spawnSync(opener, [`${settings.webOrigin}/`], { stdio: 'ignore' }).status !== 0) say(`  Abre ${settings.webOrigin} en tu navegador.`, `Open ${settings.webOrigin} in your browser.`);
  }
}

let releaseStartup;
try {
  if (!checkOnly) releaseStartup = await lockStartup();
  await main();
} catch (error) { printRecovery(error); process.exitCode = 1; }
finally { releaseStartup?.(); }
