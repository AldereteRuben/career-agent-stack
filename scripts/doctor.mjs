// Read-only diagnosis of this installation (pnpm run doctor). Changes nothing, starts nothing, prints no secrets.
// Exits 1 when something blocks a start, with the next step for each problem in Spanish and English.
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { alternateEnv, alternateEnvProblem, describeDatabase, envPath, loadPg, mtimeOf, pendingEnvPath, portIsFree, portIsOpen, projectRoot, readLocalEnv, say } from './lib/local-env.mjs';

let failed = 0;
const pass = (es, en) => say(`✓ ${es}`, `✓ ${en}`);
const note = (es, en) => say(`! ${es}`, `! ${en}`);
const fail = (es, en, nextEs, nextEn) => { failed += 1; say(`✗ ${es}`, `✗ ${en}`, process.stderr); if (nextEs) say(`    → ${nextEs}`, `→ ${nextEn}`, process.stderr); };
const at = (path) => resolve(projectRoot, path);

async function main() {
  say('Career Agent Stack · diagnóstico (solo lectura)', 'Career Agent Stack · diagnosis (read-only)');
  const node = Number(process.versions.node.split('.')[0]);
  if (node === 24) pass(`Node ${process.versions.node}`, `Node ${process.versions.node}`);
  else fail(`Node ${process.versions.node}: se necesita 24.x`, `Node ${process.versions.node}: 24.x is required`, 'fnm install 24 && fnm use 24', 'fnm install 24 && fnm use 24');

  const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8' });
  if (pnpm.status === 0 && pnpm.stdout.trim().startsWith('11.')) pass(`pnpm ${pnpm.stdout.trim()}`, `pnpm ${pnpm.stdout.trim()}`);
  else fail('pnpm 11 no encontrado', 'pnpm 11 not found', 'corepack enable', 'corepack enable');

  const installed = await mtimeOf(at('node_modules/.modules.yaml'));
  if (installed && installed >= await mtimeOf(at('pnpm-lock.yaml'))) pass('Dependencias instaladas', 'Dependencies installed');
  else fail('Dependencias ausentes o desactualizadas', 'Dependencies missing or outdated', 'pnpm start (instala lo que falte y deja el aviso al día)', 'pnpm start (installs what is missing and clears the warning)');

  const env = await readLocalEnv();
  if (!env && alternateEnv) return fail(`No existe ${envPath} (CAREER_ENV_FILE)`, `${envPath} (CAREER_ENV_FILE) does not exist`);
  if (alternateEnv) {
    const problem = alternateEnvProblem(env);
    if (problem) fail(problem.es, problem.en);
    else pass(`Configuración de CAREER_ENV_FILE: ${envPath}`, `CAREER_ENV_FILE configuration: ${envPath}`);
  }
  if (!env) {
    const pending = await readLocalEnv(pendingEnvPath);
    if (pending) fail('La preparación inicial no terminó (.env.pending existe, .env todavía no)', 'Initial setup did not finish (.env.pending exists, .env does not yet)', 'pnpm run bootstrap (retoma con las mismas claves)', 'pnpm run bootstrap (resumes with the same keys)');
    else fail('Falta .env: este equipo aún no está preparado', '.env is missing: this machine is not set up yet', 'pnpm run bootstrap', 'pnpm run bootstrap');
    return;
  }
  if (((await stat(envPath)).mode & 0o077) === 0) pass('.env existe y es privado (0600)', '.env exists and is private (0600)');
  else fail('.env es legible por otros usuarios del equipo', '.env is readable by other users of this machine', 'chmod 600 .env', 'chmod 600 .env');
  if ((env.APP_ENCRYPTION_KEY ?? '').length >= 32 && (env.APP_SESSION_SECRET ?? '').length >= 32) pass('Claves locales configuradas (no se muestran)', 'Local keys configured (not shown)');
  else fail('Faltan claves locales en .env', 'Local keys are missing from .env', 'No borres .env; compáralo con .env.example', 'Do not delete .env; compare it with .env.example');

  const database = describeDatabase(env.DATABASE_URL ?? '');
  if (!database) fail('DATABASE_URL no es una URL de PostgreSQL válida', 'DATABASE_URL is not a valid PostgreSQL URL');
  else {
    const label = `${database.host}:${database.port}/${database.database}`;
    if (alternateEnv) pass(`Base de datos de esa instalación: ${database.database}`, `That installation's database: ${database.database}`);
    else if (env.CAREER_INSTALL_ID) pass(`Base de datos propia de esta instalación: ${database.database}`, `Database of its own for this installation: ${database.database}`);
    else note(`Instalación anterior a v0.2: usa ${database.database}; no se cambia (otras copias del proyecto pueden compartirla si apuntan al mismo nombre)`, `Installation from before v0.2: it uses ${database.database}; left as is (other checkouts may share it if they point at the same name)`);
    if (!(await portIsOpen(database.host, database.port))) fail(`PostgreSQL no responde en ${label}`, `PostgreSQL does not answer on ${label}`, 'brew services start postgresql@17, y después pnpm start', 'brew services start postgresql@17, then pnpm start');
    else await checkDatabase(env, label, database.port);
  }

  const ports = [['WEB_PORT', env.WEB_PORT || '3000', env.WEB_ORIGIN], ['API_PORT', env.API_PORT || '3001', env.API_BASE_URL]];
  for (const [key, port, url] of ports) {
    if (url && new URL(url).port !== String(port)) fail(`${key}=${port} no coincide con ${url}`, `${key}=${port} does not match ${url}`, 'Corrige .env para que el puerto y la URL coincidan', 'Fix .env so the port and the URL agree');
    else pass(`${key}=${port} (${await portIsFree(Number(port)) ? 'libre' : 'en uso'})`, `${key}=${port} (${await portIsFree(Number(port)) ? 'free' : 'in use'})`);
  }
  say(`AI_PROVIDER=${env.AI_PROVIDER || 'none'}; las escrituras en sitios externos no están disponibles en esta versión.`, `AI_PROVIDER=${env.AI_PROVIDER || 'none'}; writes to external sites are unavailable in this version.`);
}

/** Signs in with the .env credentials (read-only transaction) and compares applied migrations with the repository. */
async function checkDatabase(env, label, port) {
  const pg = loadPg();
  if (!pg) return note('No se puede comprobar el acceso a la base de datos sin dependencias', 'Database access cannot be checked without dependencies');
  const client = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query('set default_transaction_read_only = on');
    pass(`PostgreSQL acepta las credenciales de .env (${label})`, `PostgreSQL accepts the .env credentials (${label})`);
    const journal = JSON.parse(await readFile(at('packages/db/migrations/meta/_journal.json'), 'utf8')).entries.length;
    let applied = 0;
    try { applied = Number((await client.query('select count(*) from drizzle.__drizzle_migrations')).rows[0].count); } catch { /* not migrated yet */ }
    if (applied >= journal) pass(`Migraciones aplicadas (${applied}/${journal})`, `Migrations applied (${applied}/${journal})`);
    else fail(`Faltan migraciones (${applied}/${journal})`, `Migrations pending (${applied}/${journal})`, 'pnpm start (las aplica sin borrar datos) o pnpm run bootstrap', 'pnpm start (applies them without deleting data) or pnpm run bootstrap');
  } catch (error) {
    fail(`PostgreSQL responde en ${label} pero rechaza las credenciales de .env (${error.code ?? 'error'})`, `PostgreSQL answers on ${label} but refuses the .env credentials (${error.code ?? 'error'})`,
      `Comprueba que es el servidor correcto: lsof -nP -iTCP:${port} -sTCP:LISTEN. No borres .env.`,
      `Check it is the right server: lsof -nP -iTCP:${port} -sTCP:LISTEN. Do not delete .env.`);
  } finally { await client.end().catch(() => undefined); }
}

await main();
if (failed) process.exitCode = 1;
