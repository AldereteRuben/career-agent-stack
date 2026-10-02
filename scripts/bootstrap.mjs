// One-time preparation of a local installation. Safe to re-run:
// - creates .env with fresh local keys only when .env does not exist (an existing .env is never overwritten),
// - reuses a PostgreSQL that already answers on DATABASE_URL, otherwise tries Docker Compose for a loopback URL,
// - applies pending migrations (existing data is kept) and installs the Chromium used for local PDF rendering.
// It does not seed demo data and does not print secrets.
import { copyFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import { RecoveryError, describeDatabase, ok, portIsOpen, printRecovery, projectRoot, say, step } from './lib/local-env.mjs';

const at = (path) => resolve(projectRoot, path);
const run = (command, args) => spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit' });

async function main() {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new RecoveryError({
    es: `Se necesita Node.js 24; este terminal usa ${process.versions.node}.`, en: `Node.js 24 is required; this terminal uses ${process.versions.node}.`,
    fixes: [{ es: 'fnm use 24 o nvm use 24', en: 'fnm use 24 or nvm use 24' }],
  });

  try {
    await readFile(at('.env'));
    ok('.env ya existe; no se modifica', '.env already exists; left unchanged');
  } catch {
    await copyFile(at('.env.example'), at('.env'));
    const env = (await readFile(at('.env'), 'utf8'))
      .replace(/^APP_ENCRYPTION_KEY=.*$/m, `APP_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`)
      .replace(/^APP_SESSION_SECRET=.*$/m, `APP_SESSION_SECRET=${randomBytes(32).toString('base64')}`);
    await writeFile(at('.env'), env, { mode: 0o600 });
    ok('.env creado con claves locales nuevas (no se muestran)', '.env created with new local keys (not shown)');
  }
  await chmod(at('.env'), 0o600);
  await mkdir(at('data/files'), { recursive: true, mode: 0o700 });
  await mkdir(at('backups'), { recursive: true, mode: 0o700 });

  const env = await readFile(at('.env'), 'utf8');
  const database = describeDatabase(env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim() ?? '');
  if (!database) throw new RecoveryError({ es: 'DATABASE_URL en .env no es una URL de PostgreSQL válida.', en: 'DATABASE_URL in .env is not a valid PostgreSQL URL.' });
  const label = `${database.host}:${database.port}/${database.database}`;
  if (await portIsOpen(database.host, database.port)) {
    ok(`PostgreSQL ya responde en ${label}; se reutiliza`, `PostgreSQL already answers on ${label}; reusing it`);
  } else if (database.loopback) {
    step('Iniciando PostgreSQL con Docker Compose…', 'Starting PostgreSQL with Docker Compose…');
    const compose = run('docker', ['compose', 'up', '-d', '--wait', 'postgres']);
    if (compose.error || compose.status !== 0) throw new RecoveryError({
      es: `PostgreSQL no responde en ${label} y Docker no pudo iniciarlo.`, en: `PostgreSQL does not answer on ${label} and Docker could not start it.`,
      fixes: [
        { es: 'Abre Docker Desktop y vuelve a ejecutar pnpm run bootstrap', en: 'Open Docker Desktop and run pnpm run bootstrap again' },
        { es: 'O instala PostgreSQL 17 (brew install postgresql@17 && brew services start postgresql@17) y crea el usuario y la base de DATABASE_URL', en: 'Or install PostgreSQL 17 (brew install postgresql@17 && brew services start postgresql@17) and create the DATABASE_URL user and database' },
      ],
    });
  } else {
    throw new RecoveryError({ es: `La base de datos remota ${label} no responde.`, en: `The remote database ${label} does not answer.` });
  }

  for (const [es, en, command, args] of [
    ['Aplicando migraciones pendientes (los datos existentes se conservan)…', 'Applying pending migrations (existing data is kept)…', 'pnpm', ['run', 'db:migrate']],
    ['Instalando Chromium para generar PDF localmente…', 'Installing Chromium for local PDF rendering…', 'pnpm', ['--filter', '@career/api', 'exec', 'playwright', 'install', 'chromium']],
  ]) {
    step(es, en);
    const result = run(command, args);
    if (result.error || result.status !== 0) throw new RecoveryError({ es: `Falló el paso: ${command} ${args.join(' ')}`, en: `Step failed: ${command} ${args.join(' ')}`, fixes: [{ es: 'Revisa el mensaje anterior y vuelve a ejecutar pnpm run bootstrap (es seguro repetirlo).', en: 'Review the message above and run pnpm run bootstrap again (it is safe to repeat).' }] });
  }
  say('Instalación local preparada. Inicia con: pnpm start', 'Local installation ready. Start with: pnpm start');
}

try { await main(); }
catch (error) { printRecovery(error); process.exitCode = 1; }
