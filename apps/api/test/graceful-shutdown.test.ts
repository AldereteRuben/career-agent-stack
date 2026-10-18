import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { attachGracefulShutdown, resolveLauncherStopFile } from '../src/graceful-shutdown.js';

function fakeProcess() {
  const listeners = new Map<string, () => void>();
  let finish!: (code: number | undefined) => void;
  const exited = new Promise<number | undefined>((resolveExit) => { finish = resolveExit; });
  return {
    listeners,
    exited,
    once(event: 'SIGINT' | 'SIGTERM', listener: () => void) { listeners.set(event, listener); return this; },
    exit(code?: number) { finish(code); return undefined; },
  };
}

test('accepts only a Windows stop signal directly under data/run with a launcher UUID name', () => {
  const dataRoot = resolve('/tmp/career-data');
  const signal = resolve(dataRoot, 'run', 'api-stop-12345678-1234-1234-1234-123456789abc.signal');
  assert.equal(resolveLauncherStopFile(dataRoot, signal, 'win32'), signal);
  assert.equal(resolveLauncherStopFile(dataRoot, resolve(dataRoot, 'api-stop-12345678-1234-1234-1234-123456789abc.signal'), 'win32'), null);
  assert.equal(resolveLauncherStopFile(dataRoot, resolve(dataRoot, 'run', 'arbitrary.signal'), 'win32'), null);
  assert.equal(resolveLauncherStopFile(dataRoot, signal, 'darwin'), null);
});

test('SIGINT and SIGTERM share one idempotent close path', async () => {
  const proc = fakeProcess();
  let appCloses = 0;
  let poolCloses = 0;
  attachGracefulShutdown({ close: async () => { appCloses += 1; } }, { end: async () => { poolCloses += 1; } }, { stopFile: null, processRef: proc });
  proc.listeners.get('SIGINT')?.();
  proc.listeners.get('SIGTERM')?.();
  assert.equal(await proc.exited, 0);
  assert.equal(appCloses, 1);
  assert.equal(poolCloses, 1);
});

test('a regular launcher stop file is removed and triggers the shared close path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-graceful-stop-'));
  const run = join(root, 'run');
  await mkdir(run);
  const stopFile = join(run, 'api-stop-12345678-1234-1234-1234-123456789abc.signal');
  const proc = fakeProcess();
  let appCloses = 0;
  let poolCloses = 0;
  try {
    attachGracefulShutdown({ close: async () => { appCloses += 1; } }, { end: async () => { poolCloses += 1; } }, { stopFile, processRef: proc });
    await writeFile(stopFile, 'stop', { flag: 'wx' });
    assert.equal(await proc.exited, 0);
    assert.equal(appCloses, 1);
    assert.equal(poolCloses, 1);
    await assert.rejects(import('node:fs/promises').then(({ access }) => access(stopFile)), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
