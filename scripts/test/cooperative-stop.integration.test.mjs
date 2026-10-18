import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { windowsProcessIdentity } from '../lib/windows-process.mjs';
import { ensurePrivateDir, ensurePrivateFile } from '../lib/private-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const worker = resolve(root, 'scripts/test/fixtures/cooperative-stop-worker.mjs');
const stopScript = resolve(root, 'scripts/stop.mjs');
const onWindows = process.platform === 'win32';

async function startWorker(temp, ignoreStop = false) {
  const dataRoot = join(temp, 'data');
  const runDir = join(dataRoot, 'run');
  await ensurePrivateDir(dataRoot);
  await ensurePrivateDir(runDir);
  const envFile = join(temp, '.env');
  await ensurePrivateFile(envFile);
  await writeFile(envFile, `DATA_LOCAL_PATH=${dataRoot.replaceAll('\\', '/')}`);
  const stopFile = join(runDir, 'api-stop-12345678-1234-1234-1234-123456789abc.signal');
  const marker = join(temp, 'closed.marker');
  const child = spawn(process.execPath, ['--import', 'tsx', worker, ...(ignoreStop ? ['--ignore-stop'] : [])], {
    cwd: resolve(root, 'apps/api'),
    env: { ...process.env, DATA_LOCAL_PATH: dataRoot, CAREER_STOP_FILE: stopFile, CAREER_TEST_CLOSED: marker },
    stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
  });
  let line = '';
  const ready = new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error('synthetic API did not become ready')), 15_000);
    child.once('error', (error) => { clearTimeout(timeout); rejectReady(error); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      line += chunk;
      const newline = line.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      try { resolveReady(JSON.parse(line.slice(0, newline))); } catch (error) { rejectReady(error); }
    });
  });
  const { port } = await ready;
  let identity = null;
  for (let attempt = 0; attempt < 20 && !identity; attempt += 1) {
    identity = windowsProcessIdentity(child.pid);
    if (!identity) await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assert.ok(identity, 'the synthetic API process identity must be readable');
  const record = {
    name: 'api', version: 2, projectRoot: root, pid: child.pid, pgid: child.pid,
    lstart: identity.lstart, cwd: null, entry: worker, titles: [], stopFile,
  };
  await writeFile(join(runDir, 'api.json'), JSON.stringify(record));
  return { child, dataRoot, envFile, marker, port, runDir, stopFile };
}

async function stopWorker({ envFile }) {
  const stopped = spawn(process.execPath, [stopScript], {
    env: { ...process.env, CAREER_ENV_FILE: envFile, CAREER_LANG: 'en' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  stopped.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  stopped.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(stopped, 'close');
  assert.equal(code, 0, stderr || stdout);
  return `${stdout}\n${stderr}`;
}

test('Windows stop asks the real process to shut down and waits for cleanup', { skip: !onWindows }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'career-stop-graceful-'));
  let service;
  try {
    service = await startWorker(temp);
    const output = await stopWorker(service);
    assert.match(output, /api: stopped|api: detenido/i);
    assert.doesNotMatch(output, /last resort|último recurso/i);
    assert.equal(await readFile(service.marker, 'utf8'), 'closed', 'the app close hook must finish before stop returns');
  } finally {
    if (service?.child.exitCode === null) service.child.kill();
    await rm(temp, { recursive: true, force: true });
  }
});

test('Windows stop force-stops an unresponsive process only after the 15-second grace period', { skip: !onWindows }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'career-stop-fallback-'));
  let service;
  try {
    service = await startWorker(temp, true);
    const startedAt = Date.now();
    const output = await stopWorker(service);
    assert.ok(Date.now() - startedAt >= 14_500, 'the graceful wait should last about 15 seconds');
    assert.match(output, /last resort|último recurso/i);
    await assert.rejects(readFile(service.marker), { code: 'ENOENT' }, 'the ignored signal must not claim graceful cleanup');
  } finally {
    if (service?.child.exitCode === null) service.child.kill();
    await rm(temp, { recursive: true, force: true });
  }
});

test('concurrent Windows stop requests both finish cleanly for the same API record', { skip: !onWindows }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'career-stop-concurrent-'));
  let service;
  try {
    service = await startWorker(temp);
    const outputs = await Promise.all([stopWorker(service), stopWorker(service)]);
    assert.ok(outputs.every((output) => /api: stopped|no services started by the launcher/i.test(output)));
    assert.equal(await readFile(service.marker, 'utf8'), 'closed');
  } finally {
    if (service?.child.exitCode === null) service.child.kill();
    await rm(temp, { recursive: true, force: true });
  }
});
