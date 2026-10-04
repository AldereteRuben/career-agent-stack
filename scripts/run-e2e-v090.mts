#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createIsolatedStack, projectRoot } from '../apps/api/e2e/isolation.js';

// The helper forces CAREER_AI_ENABLED=false and fresh DB/files/ports. Browser responses alone
// simulate AI; this harness never creates a real AI connection or invokes a provider.
process.env.E2E_KEEP = '0';
const stack = await createIsolatedStack();
const artifacts = resolve(projectRoot, 'output/playwright', `v090-${stack.runId}`);
let child: ReturnType<typeof spawn> | undefined;
try {
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  child = spawn(process.execPath, [resolve(projectRoot, 'scripts/e2e-v090.mjs')], {
    cwd: projectRoot, stdio: 'inherit', env: { ...process.env, V090_ISOLATED: '1', V090_UI_URL: stack.uiUrl, V090_API_URL: stack.apiUrl, V090_TOKEN: await stack.readToken(), V090_ARTIFACTS: artifacts },
  });
  const code = await new Promise<number>((resolveExit, reject) => {
    child!.once('error', reject); child!.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
  assert.equal(code, 0, 'v0.9.0 isolated browser coverage failed');
  const connections = await stack.db.query<{ count: string }>('select count(*) from ai_connections');
  const runs = await stack.db.query<{ count: string }>('select count(*) from ai_runs');
  assert.equal(Number(connections.rows[0]?.count), 0, 'Browser fixtures must never create a real AI connection');
  assert.equal(Number(runs.rows[0]?.count), 0, 'Browser fixtures must never enqueue a real AI run');
  await stack.assertLiveUntouched();
  console.log(`✓ No actual AI connections/runs; live workspace unchanged. Screenshots: ${artifacts}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error)); console.error(await stack.tailLogs()); process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  await stack.teardown();
}
