// Repeatable clean-install smoke test (node scripts/test/setup-smoke.mjs).
//
// Copies this checkout's tracked and new files (as a fresh clone would have them: no .env, data/, node_modules
// or builds) into a private temporary directory and runs the real first-install path there:
// pnpm install → bootstrap (with an injected failure first, to prove it is atomic and resumable) → launch
// (migrations, build, start) → sign-in with the copy's single-use token → status, doctor and the macOS
// .command launcher in a Finder-like minimal shell → stop. Everything it created is removed at the end.
//
// Isolation: the copy gets its own database and role (career_smoke_<hex>, created through the admin connection
// and dropped afterwards), free ephemeral ports (never 3000/3001), its own .env, data and logs. It never reads
// this checkout's .env values, never connects to an existing workspace database, and checks before and after
// that the live .env, sign-in token, services on 3000/3001 and the server's database and role lists are unchanged.
//
//   SETUP_SMOKE_ADMIN_DATABASE_URL  loopback admin connection (default postgresql://<user>@127.0.0.1:5432/postgres)
//   SETUP_SMOKE_KEEP=1              keep the copy, database and role for debugging (removal commands are printed)
//   SETUP_SMOKE_REPORT=<path>       also write the evidence as JSON to this file
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { describeDatabase, listeningPid, loadPg, maskSecrets, parseEnv, projectRoot } from '../lib/local-env.mjs';

const keep = process.env.SETUP_SMOKE_KEEP === '1';
// The .command launchers are macOS zsh scripts. Their checks run only where zsh (and expect, for the terminal pause) exist;
// elsewhere they are skipped and recorded, never reported as passed.
const hasTool = (tool, flag) => spawnSync(tool, [flag], { stdio: 'ignore' }).status === 0;
const zshAvailable = hasTool('zsh', '--version');
const expectAvailable = hasTool('expect', '-v');
const adminUrl = process.env.SETUP_SMOKE_ADMIN_DATABASE_URL || `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`;
const runId = randomBytes(6).toString('hex');
const installId = `smoke_${runId}`;
const conflictId = `smoke_${runId}_c`;
const evidence = { runId, startedAt: new Date().toISOString(), steps: [], isolation: {}, limitations: [] };
const sha = (value) => value === null ? null : createHash('sha256').update(value).digest('hex').slice(0, 16);
const readOrNull = async (path) => { try { return await readFile(path); } catch { return null; } };
const modeOf = async (path) => { try { return ((await stat(path)).mode & 0o777).toString(8); } catch { return null; } };

class SmokeFailure extends Error {}
function expect(condition, message) { if (!condition) throw new SmokeFailure(message); }

// A skipped step is stored as `skipped: true` with no `ok`, so a consumer counting `steps[].ok` never counts it as a pass.
function record(name, ok, details = {}) {
  evidence.steps.push(details.skipped ? { name, ...details } : { name, ok, ...details });
  console.log(`${details.skipped ? '–' : ok ? '✓' : '✗'} ${name}${details.ms ? ` (${Math.round(details.ms / 1000)} s)` : ''}`);
}

// Child environment: nothing that could point the copy at live data or a live port is inherited.
const scoped = /^(DATABASE_URL|APP_[A-Z_]+|API_[A-Z_]+|WEB_[A-Z_]+|DATA_LOCAL_PATH|FILES_[A-Z_]+|PG[A-Z]+|CAREER_[A-Z_]+|E2E_[A-Z_]+|NODE_ENV)$/;
const baseEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !scoped.test(key)));

function run(cwd, command, args, { env = {}, timeoutMs = 600_000, input = '', clean = false } = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd, input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    env: clean ? env : { ...baseEnv(), CAREER_LANG: 'en', ...env },
  });
  const output = maskSecrets(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  return { status: result.status, output, ms: Date.now() - started };
}

const tail = (text, lines = 30) => text.split('\n').slice(-lines).join('\n');

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => { const { port } = server.address(); server.close(() => resolvePromise(port)); });
  });
}

async function admin(query, params = [], database = 'postgres') {
  const { Client } = loadPg();
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  const client = new Client({ connectionString: url.href, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try { return await client.query(query, params); } finally { await client.end(); }
}

// Disposable objects of this and the other test harnesses (E2E, backup tests) may come and go while this runs.
const disposable = /^career_(smoke|e2e|bkt)_/;

async function liveFingerprint() {
  const databases = (await admin('select datname from pg_database order by 1')).rows.map((row) => row.datname).filter((name) => !disposable.test(name));
  const roles = (await admin(`select rolname from pg_roles where rolname !~ '^pg_' order by 1`)).rows.map((row) => row.rolname).filter((name) => !disposable.test(name));
  return {
    env: sha(await readOrNull(resolve(projectRoot, '.env'))),
    setupToken: sha(await readOrNull(resolve(projectRoot, 'data/setup-token'))),
    listeners: { 3000: listeningPid(3000), 3001: listeningPid(3001) },
    databases, roles,
  };
}

/** A fresh clone's contents: tracked files plus new, not-ignored files; never .env, data/, node_modules or builds. */
async function cleanCopy(target) {
  const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: projectRoot, encoding: 'utf8' });
  expect(listed.status === 0, 'git ls-files failed');
  let copied = 0;
  for (const file of listed.stdout.split('\0').filter(Boolean)) {
    const source = resolve(projectRoot, file);
    try { await stat(source); } catch { continue; } // deleted in the working tree
    await mkdir(dirname(join(target, file)), { recursive: true });
    await cp(source, join(target, file), { preserveTimestamps: false });
    copied += 1;
  }
  return copied;
}

async function dropSmokeObjects() {
  for (const id of [installId, conflictId]) {
    const name = `career_${id}`;
    expect(/^career_smoke_[0-9a-f]{12}(_c)?$/.test(name), `refusing to drop unexpected name ${name}`);
    const db = await admin('select 1 from pg_database where datname = $1', [name]);
    if (db.rowCount) await admin(`drop database "${name}" with (force)`);
    const role = await admin('select 1 from pg_roles where rolname = $1', [name]);
    if (role.rowCount) await admin(`drop role "${name}"`);
  }
}

async function main() {
  expect(Number(process.versions.node.split('.')[0]) === 24, `Node 24 required (running ${process.versions.node})`);
  expect(loadPg(), 'run pnpm install in this checkout first (the smoke test uses its pg driver for the admin connection)');
  const adminTarget = describeDatabase(adminUrl);
  expect(adminTarget?.loopback, 'the admin connection must be a loopback PostgreSQL URL');
  const before = await liveFingerprint();
  evidence.isolation.before = before;

  const webPort = await freePort();
  const apiPort = await freePort();
  expect(![3000, 3001].includes(webPort) && ![3000, 3001].includes(apiPort) && webPort !== apiPort, 'could not get two distinct free ports outside 3000/3001');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'career-setup-smoke-')));
  await chmod(root, 0o700);
  const copy = join(root, 'career-agent-stack');
  evidence.isolation.copy = copy;
  evidence.isolation.ports = { web: webPort, api: apiPort };
  evidence.isolation.database = `career_${installId}`;
  let launched = false;
  let launchedAlternate = null;

  try {
    const files = await cleanCopy(copy);
    expect(!(await readOrNull(join(copy, '.env'))) && !(await readOrNull(join(copy, 'data/setup-token'))), 'the copy must start without .env or data');
    record('clean copy without .env, data/, node_modules or builds', true, { files });

    let step = run(copy, 'pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { timeoutMs: 900_000 });
    expect(step.status === 0, `pnpm install failed\n${tail(step.output)}`);
    record('pnpm install --frozen-lockfile', true, { ms: step.ms });

    const portsEnv = { CAREER_WEB_PORT: String(webPort), CAREER_API_PORT: String(apiPort), CAREER_ADMIN_DATABASE_URL: adminUrl };

    // 1. A server that answers but whose admin role cannot connect: plain ES/EN guidance, no .env.
    step = run(copy, process.execPath, ['scripts/bootstrap.mjs'], { env: { ...portsEnv, CAREER_INSTALL_ID: installId, CAREER_ADMIN_DATABASE_URL: `postgresql://career_smoke_no_such_admin@${adminTarget.host}:${adminTarget.port}/postgres`, CAREER_LANG: 'es' } });
    expect(step.status === 1, `bootstrap with an unusable admin should exit 1 (got ${step.status})\n${tail(step.output)}`);
    expect(/Hay un PostgreSQL en/.test(step.output) && /A PostgreSQL server answers on/.test(step.output), `expected a Spanish and English explanation\n${tail(step.output)}`);
    expect(!(await readOrNull(join(copy, '.env'))), 'a failed bootstrap must not leave .env');
    expect(await modeOf(join(copy, '.env.pending')) === '600', '.env.pending must exist with mode 600');
    const pending = parseEnv((await readFile(join(copy, '.env.pending'), 'utf8')));
    record('existing PostgreSQL, unusable admin: refused in ES/EN, no .env, private .env.pending kept', true, { message: step.output.split('\n').find((line) => line.includes('✗')) });

    // 2. A database of the same name that this installation did not create is never reused.
    const firstPending = await readFile(join(copy, '.env.pending'));
    await rm(join(copy, '.env.pending'));
    await admin(`create database "career_${conflictId}"`);
    step = run(copy, process.execPath, ['scripts/bootstrap.mjs'], { env: { ...portsEnv, CAREER_INSTALL_ID: conflictId } });
    expect(step.status === 1 && /already exists on the server and was not created by this installation/.test(step.output), `name conflict should be refused\n${tail(step.output)}`);
    expect(!(await readOrNull(join(copy, '.env'))), 'a refused bootstrap must not leave .env');
    const untouched = await admin(`select shobj_description(oid, 'pg_database') as mark from pg_database where datname = $1`, [`career_${conflictId}`]);
    expect(untouched.rows[0]?.mark === null, 'the foreign database must be left untouched');
    record('foreign database with the same name: refused and left untouched', true);

    // 3. Resume the first attempt (its .env.pending) with a working admin connection: same keys, own database.
    await writeFile(join(copy, '.env.pending'), firstPending, { mode: 0o600 });
    step = run(copy, process.execPath, ['scripts/bootstrap.mjs'], { env: { ...portsEnv, CAREER_INSTALL_ID: 'ignored_on_resume' } });
    expect(step.status === 0, `bootstrap resume failed\n${tail(step.output, 60)}`);
    expect(/Resuming the previous setup/.test(step.output), 'bootstrap should report that it resumed');
    const env = parseEnv(await readFile(join(copy, '.env'), 'utf8'));
    expect(await modeOf(join(copy, '.env')) === '600', '.env must be 0600');
    expect(!(await readOrNull(join(copy, '.env.pending'))), '.env.pending must be gone after success');
    expect(sha(env.APP_ENCRYPTION_KEY) === sha(pending.APP_ENCRYPTION_KEY) && sha(env.APP_SESSION_SECRET) === sha(pending.APP_SESSION_SECRET), 'resumed run must keep the pending keys');
    expect(describeDatabase(env.DATABASE_URL).database === `career_${installId}` && env.CAREER_INSTALL_ID === installId, 'the copy must use its own database');
    expect(env.WEB_PORT === String(webPort) && env.API_PORT === String(apiPort) && env.WEB_ORIGIN === `http://127.0.0.1:${webPort}`, 'the copy must use the free ports');
    for (const path of ['data', 'data/files', 'backups']) expect(await modeOf(join(copy, path)) === '700', `${path} must be 0700`);
    const mark = await admin(`select shobj_description(d.oid, 'pg_database') as mark, r.rolname as owner, has_database_privilege('public', d.datname, 'CONNECT') as public_connect
      from pg_database d join pg_roles r on r.oid = d.datdba where d.datname = $1`, [`career_${installId}`]);
    expect(mark.rows[0]?.mark === `career-agent-stack install ${installId}` && mark.rows[0].owner === `career_${installId}` && mark.rows[0].public_connect === false, 'database must be owned by its role, marked, and closed to PUBLIC');
    record('bootstrap resumed with the same keys: own role/database (no PUBLIC access), migrations, .env 0600, data 0700', true, { ms: step.ms });

    const envHash = sha(await readFile(join(copy, '.env')));
    step = run(copy, process.execPath, ['scripts/bootstrap.mjs']);
    expect(step.status === 0 && sha(await readFile(join(copy, '.env'))) === envHash, `second bootstrap must succeed and leave .env unchanged\n${tail(step.output)}`);
    record('bootstrap again: idempotent, .env unchanged', true, { ms: step.ms });

    // A DATABASE_URL exported in the shell must not redirect the installation.
    launched = true;
    step = run(copy, process.execPath, ['scripts/launch.mjs', '--no-open'], { env: { DATABASE_URL: 'postgresql://wrong:wrong@127.0.0.1:1/wrong' }, timeoutMs: 900_000 });
    expect(step.status === 0, `launch failed\n${tail(step.output, 60)}`);
    record('pnpm start equivalent: migrate, build API and web app, start on free ports (shell DATABASE_URL ignored)', true, { ms: step.ms });

    const web = `http://127.0.0.1:${webPort}`;
    const health = await (await globalThis.fetch(`http://127.0.0.1:${apiPort}/healthz`)).json();
    expect(health.database === 'ready', 'API health must report the database ready');
    const login = await globalThis.fetch(`${web}/login`);
    expect(login.status === 200, `/login answered ${login.status}`);
    const tokenPath = join(copy, 'data/setup-token');
    expect(await modeOf(tokenPath) === '600', 'the copy token must be 0600');
    const token = (await readFile(tokenPath, 'utf8')).trim();
    const signIn = await globalThis.fetch(`${web}/api/v1/session`, { method: 'POST', headers: { origin: web, 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: token }) });
    const cookie = signIn.headers.get('set-cookie')?.split(';')[0];
    expect(signIn.status === 200 && cookie, `sign-in answered ${signIn.status}`);
    const session = await (await globalThis.fetch(`${web}/api/v1/session`, { headers: { cookie } })).json();
    expect(session.authenticated === true, 'session must be authenticated after sign-in');
    expect(!(await readOrNull(tokenPath)), 'the single-use token must be consumed');
    const journal = JSON.parse(await readFile(join(copy, 'packages/db/migrations/meta/_journal.json'), 'utf8')).entries.length;
    const migrations = await admin('select count(*)::int as n from drizzle.__drizzle_migrations', [], `career_${installId}`);
    const workspaces = await admin('select count(*)::int as n from workspaces', [], `career_${installId}`);
    expect(migrations.rows[0].n === journal && workspaces.rows[0].n === 1, 'the copy database must hold every migration and the one workspace the copy API created');
    record('web /login 200, sign-in with the copy token through the web origin, session authenticated, token consumed', true);

    step = run(copy, process.execPath, ['scripts/reset-session.mjs']);
    expect(step.status === 0, 'isolated access-code recovery must succeed');
    const recoveredToken = (await readFile(tokenPath, 'utf8')).trim();
    expect(recoveredToken !== token && await modeOf(tokenPath) === '600', 'recovery creates a different private code');
    const recoveredLogin = await globalThis.fetch(`${web}/api/v1/session`, { method: 'POST', headers: { origin: web, 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: recoveredToken }) });
    expect(recoveredLogin.status === 200 && !(await readOrNull(tokenPath)), 'recovered code signs in exactly once');
    const originalSession = await (await globalThis.fetch(`${web}/api/v1/session`, { headers: { cookie } })).json();
    expect(originalSession.authenticated === true, 'recovering access preserves existing sessions');
    if (zshAvailable) expect(spawnSync('zsh', ['-n', join(copy, 'Recover Career Agent Stack.command')]).status === 0, 'recovery launcher parses');
    record(`access-code recovery: private new code accepted once, existing session preserved${zshAvailable ? ', recovery launcher parses' : ''}`, true);

    // Finder-like environment: minimal PATH, no shell profile, no inherited project variables.
    const finderEnv = { HOME: process.env.HOME, USER: process.env.USER, LOGNAME: process.env.USER, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'xterm-256color', TMPDIR: process.env.TMPDIR };
    const command = join(copy, 'Start Career Agent Stack.command');
    if (zshAvailable) {
      expect(spawnSync('zsh', ['-n', command]).status === 0, '.command must parse in zsh');
      step = run(dirname(copy), 'zsh', [command, '--check'], { env: finderEnv, clean: true });
      expect(step.status === 0 && !/read-only variable/.test(step.output) && /Everything is in order|Todo en orden/.test(step.output), `.command --check in a Finder-like shell failed (${step.status})\n${tail(step.output)}`);
      record('Start Career Agent Stack.command (zsh, Finder-like PATH): finds Node 24, status 0, no read-only variable error', true);

    } else {
      evidence.limitations.push('zsh is not installed: the .command launcher checks (Finder-like PATH) were skipped');
      record('Start Career Agent Stack.command (zsh, Finder-like PATH): skipped, zsh is not installed', undefined, { skipped: true });
    }

    step = run(copy, process.execPath, ['scripts/launch.mjs', '--check']);
    expect(step.status === 0, `status failed\n${tail(step.output)}`);
    step = run(copy, process.execPath, ['scripts/doctor.mjs']);
    expect(step.status === 0 && /Database of its own for this installation/.test(step.output) && /Migrations applied/.test(step.output), `doctor failed\n${tail(step.output)}`);
    record('pnpm run status and pnpm run doctor: all green', true);

    step = run(copy, process.execPath, ['scripts/stop.mjs']);
    expect(step.status === 0, `stop failed\n${tail(step.output)}`);
    launched = false;
    expect(!listeningPid(webPort) && !listeningPid(apiPort), 'ports must be free after stop');
    if (zshAvailable && expectAvailable) {
      // Under a pseudo-terminal (expect), as in Terminal.app, so the "Press Enter" pause is really exercised.
      const pause = `set timeout 120; spawn zsh $env(SMOKE_COMMAND) --check; expect "Press Enter to close" { send "\\r" }; expect eof; exit [lindex [wait] 3]`;
      step = run(dirname(copy), 'expect', ['-c', pause], { env: { ...finderEnv, SMOKE_COMMAND: command }, clean: true });
      expect(step.status === 1 && !/read-only variable/.test(step.output) && /need attention/.test(step.output) && /Press Enter to close/.test(step.output), `.command must report the failure and pause (${step.status})\n${tail(step.output)}`);
      record('pnpm run stop frees the ports; .command (in a terminal) reports the stopped stack, waits for Enter, exits 1', true);
    } else {
      evidence.limitations.push('zsh or expect is not installed: the .command terminal pause check was skipped');
      record('pnpm run stop frees the ports; .command pause check skipped (needs zsh and expect)', undefined, { skipped: true });
    }

    // CAREER_ENV_FILE: another installation's configuration (like a restored workspace: absolute data folder,
    // own ports and session secret) started with a separate checkout's code, without any .env in that checkout.
    const restored = join(root, 'restored');
    await mkdir(join(restored, 'data/files'), { recursive: true, mode: 0o700 });
    const altWeb = await freePort();
    const altApi = await freePort();
    expect(![3000, 3001, webPort, apiPort].includes(altWeb) && ![3000, 3001, webPort, apiPort].includes(altApi) && altWeb !== altApi, 'could not get free ports for the alternate installation');
    const altValues = { WEB_PORT: altWeb, WEB_ORIGIN: `http://127.0.0.1:${altWeb}`, API_PORT: altApi, API_BASE_URL: `http://127.0.0.1:${altApi}`,
      DATA_LOCAL_PATH: join(restored, 'data'), FILES_LOCAL_PATH: join(restored, 'data/files'), APP_SESSION_SECRET: randomBytes(32).toString('base64') };
    let altText = (await readFile(join(copy, '.env'), 'utf8')).replace(/^CAREER_INSTALL_ID=.*\n?/m, '').replace(/^CAREER_DATABASE_MODE=.*\n?/m, '');
    for (const [key, value] of Object.entries(altValues)) altText = altText.replace(new RegExp(`^${key}=.*$`, 'm'), () => `${key}=${value}`);
    if (!/^DATA_LOCAL_PATH=/m.test(altText)) altText += `DATA_LOCAL_PATH=${altValues.DATA_LOCAL_PATH}\n`;
    const altEnv = join(restored, '.env');
    await writeFile(altEnv, altText, { mode: 0o600 });

    const buildId = sha(await readFile(join(copy, 'apps/dashboard/.next/BUILD_ID')));
    step = run(copy, process.execPath, ['scripts/launch.mjs', '--no-open'], { env: { CAREER_ENV_FILE: altEnv } });
    expect(step.status === 1 && /not rebuilt for the CAREER_ENV_FILE configuration/.test(step.output), `a checkout with its own .env must refuse to rebuild its web app for CAREER_ENV_FILE\n${tail(step.output)}`);
    expect(sha(await readFile(join(copy, 'apps/dashboard/.next/BUILD_ID'))) === buildId && !listeningPid(altApi) && !listeningPid(altWeb), 'the refused run must not build or start anything');
    record('CAREER_ENV_FILE in a checkout that has its own installation: refused before starting anything, its web build untouched', true);

    const copy2 = join(root, 'code-for-restored');
    await cleanCopy(copy2);
    step = run(copy2, 'pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], { timeoutMs: 900_000 });
    expect(step.status === 0, `pnpm install (second checkout) failed\n${tail(step.output)}`);
    launchedAlternate = { cwd: copy2, env: altEnv };
    step = run(copy2, process.execPath, ['scripts/launch.mjs', '--no-open'], { env: { CAREER_ENV_FILE: altEnv }, timeoutMs: 900_000 });
    expect(step.status === 0, `CAREER_ENV_FILE launch failed\n${tail(step.output, 60)}`);
    const altOrigin = `http://127.0.0.1:${altWeb}`;
    const altToken = (await readFile(join(restored, 'data/setup-token'), 'utf8')).trim();
    const altSignIn = await globalThis.fetch(`${altOrigin}/api/v1/session`, { method: 'POST', headers: { origin: altOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: altToken }) });
    const altCookie = altSignIn.headers.get('set-cookie')?.split(';')[0];
    expect(altSignIn.status === 200 && altCookie && (await (await globalThis.fetch(`${altOrigin}/api/v1/session`, { headers: { cookie: altCookie } })).json()).authenticated === true, 'sign-in on the CAREER_ENV_FILE installation failed');
    for (const name of ['api', 'dashboard']) {
      expect(await readOrNull(join(restored, 'data/run', `${name}.json`)) && await readOrNull(join(restored, 'data/logs', `${name}.log`)), `${name} run record and log must be in the selected data folder`);
    }
    // The launcher's startup lock lives in the checkout's data/ folder and is removed afterwards, so the folder may remain empty.
    const strayData = await readdir(join(copy2, 'data')).catch(() => []);
    expect(!(await readOrNull(join(copy2, '.env'))) && strayData.every((name) => name === 'launcher.lock'), `the second checkout must get no .env and no installation data in data/ (found: ${strayData.join(', ') || 'nothing'})`);
    step = run(copy2, process.execPath, ['scripts/doctor.mjs'], { env: { CAREER_ENV_FILE: altEnv } });
    expect(step.status === 0 && /CAREER_ENV_FILE configuration/.test(step.output), `doctor with CAREER_ENV_FILE failed\n${tail(step.output)}`);
    step = run(copy2, process.execPath, ['scripts/stop.mjs'], { env: { CAREER_ENV_FILE: altEnv } });
    expect(step.status === 0 && !listeningPid(altApi) && !listeningPid(altWeb), `stop with CAREER_ENV_FILE failed\n${tail(step.output)}`);
    launchedAlternate = null;
    record('CAREER_ENV_FILE with a separate checkout: starts on its ports, sign-in with its token, run records/logs in its data folder, doctor, stop; no .env or data/ in the checkout', true);
  } finally {
    if (launched) run(copy, process.execPath, ['scripts/stop.mjs']);
    if (launchedAlternate) run(launchedAlternate.cwd, process.execPath, ['scripts/stop.mjs'], { env: { CAREER_ENV_FILE: launchedAlternate.env } });
    if (keep) {
      console.log(`Kept: ${root}\n  remove with: rm -rf '${root}'; dropdb career_${installId}; dropdb career_${conflictId}; dropuser career_${installId}; dropuser career_${conflictId}`);
    } else {
      await dropSmokeObjects();
      await rm(root, { recursive: true, force: true });
    }
  }

  const after = await liveFingerprint();
  evidence.isolation.after = after;
  expect(JSON.stringify(after) === JSON.stringify(before), `live fingerprint changed:\nbefore ${JSON.stringify(before)}\nafter  ${JSON.stringify(after)}`);
  const leftovers = (await admin(`select datname from pg_database where datname like 'career\\_smoke\\_%'`)).rowCount + (await admin(`select rolname from pg_roles where rolname like 'career\\_smoke\\_%'`)).rowCount;
  expect(keep || leftovers === 0, 'smoke databases or roles were left behind');
  record(`live .env, sign-in token, services on 3000/3001, databases and roles unchanged${keep ? '' : '; smoke database, role and copy removed'}`, true);
}

let exitCode = 0;
try { await main(); }
catch (error) {
  exitCode = 1;
  record('setup smoke', false, { error: maskSecrets(error instanceof Error ? error.message : String(error)) });
  console.error(maskSecrets(error instanceof Error ? error.message : String(error)));
}
evidence.finishedAt = new Date().toISOString();
if (process.env.SETUP_SMOKE_REPORT) await writeFile(process.env.SETUP_SMOKE_REPORT, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
console.log(exitCode ? '\nSetup smoke FAILED' : '\nSetup smoke passed');
process.exitCode = exitCode;
