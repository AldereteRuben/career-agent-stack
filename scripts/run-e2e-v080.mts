#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createIsolatedStack, projectRoot } from '../apps/api/e2e/isolation.js';

const parseEnv = createRequire(resolve(projectRoot, 'apps/api/package.json'))('dotenv').parse;
process.env.E2E_KEEP = '0';
const stack = await createIsolatedStack();
let exitCode: number;
let child;
const artifacts = resolve(projectRoot, 'output/playwright', `v080-${stack.runId}`);

try {
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const cachedJob = [{
    externalId: `v080-${stack.runId}`,
    title: 'T08 Cached Product Designer',
    company: stack.marker,
    location: 'Remote worldwide',
    workMode: 'remote',
    url: `https://remotive.com/remote-jobs/${stack.runId}`,
    postedAt: new Date(Date.now() - 86_400_000).toISOString(),
    description: 'Fictional E2E cache entry; no provider request is made.',
    raw: { id: `v080-${stack.runId}`, title: 'T08 Cached Product Designer', company_name: stack.marker },
  }];
  await stack.db.query(`INSERT INTO job_search_provider_cache(provider,payload,coverage,fetched_at,next_fetch_at)
    VALUES('remotive',$1::jsonb,'COMPLETE',now(),now()+interval '6 hours')
    ON CONFLICT(provider) DO UPDATE SET payload=excluded.payload,coverage=excluded.coverage,fetched_at=excluded.fetched_at,next_fetch_at=excluded.next_fetch_at,last_error=NULL`, [JSON.stringify(cachedJob)]);

  const script = resolve(projectRoot, 'scripts/e2e-v080.mjs');
  child = spawn(process.execPath, [script], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      V080_ISOLATED: '1',
      V080_UI_URL: stack.uiUrl,
      V080_API_URL: stack.apiUrl,
      V080_TOKEN: await stack.readToken(),
      V080_ARTIFACTS: artifacts,
      V080_REAL_MARKER: stack.marker,
    },
  });
  exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
  assert.equal(exitCode, 0, `T08 browser coverage exited with ${exitCode}`);
  await stack.assertLiveUntouched();
  console.log('✓ Isolation verified: live token/files/Next build unchanged and no run marker in live database.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(await stack.tailLogs());
  exitCode = 1;
} finally {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  await stack.teardown();
}

try {
  const env = parseEnv(await readFile(resolve(projectRoot, '.env'), 'utf8'));
  const adminUrl = new URL(process.env.E2E_ADMIN_DATABASE_URL ?? env.DATABASE_URL ?? '');
  if (!process.env.E2E_ADMIN_DATABASE_URL) adminUrl.pathname = '/postgres';
  const PgClient = createRequire(resolve(projectRoot, 'packages/db/package.json'))('pg').Client;
  const admin = new PgClient({ connectionString: adminUrl.toString(), application_name: 'career-e2e-cleanup-check', options: '-c default_transaction_read_only=on' });
  await admin.connect();
  const remains = (await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [stack.databaseName])).rowCount > 0;
  await admin.end();
  assert.equal(remains, false, `Disposable database ${stack.databaseName} was not removed`);
  await access(resolve(projectRoot, 'output/e2e-runs', stack.runId)).then(() => { throw new Error('Disposable dashboard directory was not removed'); }, () => undefined);
  console.log(`✓ Disposable database and dashboard copy removed; screenshots retained at ${artifacts}`);
} catch (error) {
  console.error(`Cleanup verification failed: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
}
process.exitCode = exitCode;
