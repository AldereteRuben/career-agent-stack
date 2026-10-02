// Local launcher: reuses services that are already healthy, starts the missing ones,
// waits until they answer and opens the workspace in the browser.
//
//   pnpm start            start or reuse everything and open the browser
//   pnpm start --no-open  same, without opening the browser
//   pnpm start --copy-token  also copy the pending single-use sign-in token to the clipboard (never printed)
//   pnpm run status       read-only report; starts, builds and migrates nothing; exits 1 when something needs attention
//
// It never seeds demo data, never resets or deletes data, and never prints secrets.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import process from 'node:process';
import {
  RecoveryError, describeDatabase, httpStatus, listeningPid, localDataPath, logDir, maskSecrets, mtimeOf, newestMtime, ok, parentArgs,
  portIsOpen, printRecovery, processIdentity, projectRoot, readLocalEnv, runDir, say, step, waitFor, warn,
} from './lib/local-env.mjs';

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const openBrowser = !args.has('--no-open') && !checkOnly;
const copyToken = args.has('--copy-token') && !checkOnly;

// Things that need the user's attention. `pnpm run status` exits non-zero when there is any.
let attention = 0;
const problem = (es, en) => { attention += 1; warn(es, en); };
const at = (...parts) => resolve(projectRoot, ...parts);

const fix = (es, en) => ({ es, en });
const run = (command, commandArgs, options = {}) => spawnSync(command, commandArgs, { cwd: projectRoot, stdio: 'inherit', ...options });
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };

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
  const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8' });
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
  if (!env) {
    if (checkOnly) throw new RecoveryError({
      es: 'Falta el archivo privado .env: este equipo aún no está preparado.', en: 'The private .env file is missing: this machine is not set up yet.',
      fixes: [fix('Ejecuta: pnpm run bootstrap (o pnpm start, que lo hace por ti)', 'Run: pnpm run bootstrap (or pnpm start, which does it for you)')],
    });
    step('Primera ejecución: preparando la configuración privada…', 'First run: preparing the private configuration…');
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
  ok('Configuración privada presente (no se muestra)', 'Private configuration present (not shown)');
  return { database, apiPort, webPort, apiBase, webOrigin };
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
  const brewPrefix = spawnSync('brew', ['--prefix'], { encoding: 'utf8' });
  const brewData = brewPrefix.status === 0 ? resolve(brewPrefix.stdout.trim(), 'var/postgresql@17') : null;
  const pgCtl = brewPrefix.status === 0 ? resolve(brewPrefix.stdout.trim(), 'opt/postgresql@17/bin/pg_ctl') : null;
  let method = null;
  if (brewData && pgCtl && await exists(resolve(brewData, 'PG_VERSION')) && await exists(pgCtl)) {
    await mkdir(at('data'), { recursive: true, mode: 0o700 });
    const started = run(pgCtl, ['-D', brewData, '-l', at('data/postgres.log'), '-w', '-t', '30', 'start'], { stdio: 'ignore' });
    if (started.status === 0) method = 'homebrew-pg_ctl';
  }
  if (!method && spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0) {
    if (run('docker', ['compose', 'up', '-d', '--wait', 'postgres']).status === 0) method = 'docker-compose';
  }
  if (!method || !(await waitFor(() => portIsOpen(database.host, database.port), { timeoutMs: 30_000 }))) {
    throw new RecoveryError({ es: `No se pudo iniciar PostgreSQL en ${label}.`, en: `PostgreSQL could not be started on ${label}.`, fixes });
  }
  await recordStarted('postgres', method === 'homebrew-pg_ctl' ? { method, dataDir: brewData, pgCtl } : { method });
  ok(`PostgreSQL iniciado (${method})`, `PostgreSQL started (${method})`);
}

function runQuiet(command, commandArgs, env) {
  const result = spawnSync(command, commandArgs, { cwd: projectRoot, encoding: 'utf8', env: { ...process.env, ...env } });
  if (result.status !== 0) process.stderr.write(maskSecrets(`${result.stdout ?? ''}\n${result.stderr ?? ''}`).split('\n').slice(-25).join('\n') + '\n');
  return result.status === 0;
}

async function apiNeedsBuild() {
  const built = await mtimeOf(at('apps/api/dist/server.js'));
  const shared = Math.min(await mtimeOf(at('packages/db/dist/index.js')), await mtimeOf(at('packages/domain/dist/index.js')));
  const sources = await newestMtime([at('apps/api/src'), at('packages/db/src'), at('packages/domain/src'), at('packages/db/migrations')]);
  return !built || !shared || sources > Math.min(built, shared);
}

async function dashboardNeedsBuild() {
  const built = await mtimeOf(at('apps/dashboard/.next/BUILD_ID'));
  const sources = await newestMtime(['app', 'components', 'lib', 'next.config.ts', 'package.json'].map((part) => at('apps/dashboard', part)));
  return !built || sources > built;
}

async function recordStarted(name, details) {
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await writeFile(resolve(runDir, `${name}.json`), JSON.stringify({ name, startedAt: new Date().toISOString(), ...details }, null, 2), { mode: 0o600 });
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
  const child = spawn(command, commandArgs, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', log.fd, log.fd] });
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

async function ensureApi({ apiBase, apiPort }) {
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
  if (!runQuiet('pnpm', ['run', '--silent', 'db:migrate'])) throw new RecoveryError({
    es: 'No se pudieron aplicar las migraciones.', en: 'Database migrations could not be applied.',
    fixes: [fix('Comprueba que PostgreSQL acepta las credenciales de .env: pnpm run doctor', 'Check that PostgreSQL accepts the .env credentials: pnpm run doctor')],
  });
  if (needsBuild) {
    step('Compilando la API…', 'Building the API…');
    if (run('pnpm', ['run', 'build:shared']).status !== 0 || run('pnpm', ['--filter', '@career/api', 'build']).status !== 0) throw new RecoveryError({
      es: 'La API no compila.', en: 'The API does not build.', fixes: [fix('Revisa el error anterior o ejecuta: pnpm run typecheck', 'Review the error above or run: pnpm run typecheck')],
    });
  }
  step('Iniciando la API…', 'Starting the API…');
  const entry = at('apps/api/dist/server.js');
  const logPath = await startDetached('api', process.execPath, [entry], { cwd: at('apps/api'), env: {}, entry });
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
      port: webPort, buildMtime: await mtimeOf(at('apps/dashboard/.next/BUILD_ID')), needsBuild: await dashboardNeedsBuild(),
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
  const needsBuild = await dashboardNeedsBuild();
  if (checkOnly) return problem(`Aplicación web detenida${needsBuild ? ' (necesita compilarse)' : ''}`, `Web app stopped${needsBuild ? ' (needs a build)' : ''}`);
  const env = { API_BASE_URL: apiBase, NEXT_TELEMETRY_DISABLED: '1' };
  if (needsBuild) {
    step('Compilando la aplicación web (la primera vez tarda unos minutos)…', 'Building the web app (the first time takes a few minutes)…');
    if (run('pnpm', ['--filter', '@career/dashboard', 'build'], { env: { ...process.env, ...env } }).status !== 0) throw new RecoveryError({
      es: 'La aplicación web no compila.', en: 'The web app does not build.', fixes: [fix('Revisa el error anterior o ejecuta: pnpm run typecheck', 'Review the error above or run: pnpm run typecheck')],
    });
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

const clipboardTools = () => {
  const has = (tool) => spawnSync('which', [tool], { stdio: 'ignore' }).status === 0;
  if (process.platform === 'darwin') return { copy: ['pbcopy', []], paste: ['pbpaste', []] };
  if (process.env.WAYLAND_DISPLAY && has('wl-copy')) return { copy: ['wl-copy', []], paste: ['wl-paste', ['-n']] };
  if (has('xclip')) return { copy: ['xclip', ['-selection', 'clipboard']], paste: ['xclip', ['-selection', 'clipboard', '-o']] };
  return null;
};

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
  const tools = clipboardTools();
  if (!tools) return warn('No hay herramienta de portapapeles disponible; abre el archivo del token manualmente.', 'No clipboard tool available; open the token file manually.');
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
  await signInHint();
  say('  Para detener solo lo que inició este lanzador: pnpm run stop', 'To stop only what this launcher started: pnpm run stop');
  if (openBrowser) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    if (spawnSync(opener, [`${settings.webOrigin}/`], { stdio: 'ignore' }).status !== 0) say(`  Abre ${settings.webOrigin} en tu navegador.`, `Open ${settings.webOrigin} in your browser.`);
  }
}

try { await main(); }
catch (error) { printRecovery(error); process.exitCode = 1; }
