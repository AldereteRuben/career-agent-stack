import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { test } from 'node:test';
import { ensurePrivateDir, ensurePrivateFile, ensurePrivateTree, isPrivate, isPrivateTree, readPrivateFile, readPrivateFileSync, restrictToCurrentUser, windowsTool } from '../lib/private-files.mjs';
import { writePrivateFileAtomic } from '../lib/local-env.mjs';

test('private directories and files are restricted and verified on the current platform', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-private-files-'));
  const directory = join(root, 'private');
  const file = join(directory, 'secret.txt');
  try {
    await ensurePrivateDir(directory);
    await ensurePrivateFile(file);
    assert.equal(await isPrivate(directory), true);
    assert.equal(await isPrivate(file), true);
    assert.equal(await readPrivateFile(file), '');
    if (process.platform !== 'win32') {
      assert.equal((await stat(directory)).mode & 0o077, 0);
      assert.equal((await stat(file)).mode & 0o077, 0);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a file replaced during ACL verification is not read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-private-race-'));
  const file = join(root, '.env');
  const displaced = join(root, '.env.original');
  try {
    await writeFile(file, 'APP_SESSION_SECRET=original', { mode: 0o600 });
    let replaced = false;
    await assert.rejects(readPrivateFile(file, {
      verifyPrivate: async () => {
        if (!replaced) {
          replaced = true;
          await rename(file, displaced);
          await writeFile(file, 'APP_SESSION_SECRET=replacement', { mode: 0o600 });
        }
        return true;
      },
    }), /Could not verify|No se pudo verificar/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the synchronous private-file reader rejects a path replacement during ACL verification', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-private-sync-race-'));
  const file = join(root, '.env');
  const displaced = join(root, '.env.original');
  try {
    writeFileSync(file, 'APP_SESSION_SECRET=original', { mode: 0o600 });
    let replaced = false;
    assert.throws(() => readPrivateFileSync(file, {
      verifyPrivate: () => {
        if (!replaced) {
          replaced = true;
          renameSync(file, displaced);
          writeFileSync(file, 'APP_SESSION_SECRET=replacement', { mode: 0o600 });
        }
        return true;
      },
    }), /Could not verify|No se pudo verificar/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('existing private trees are tightened recursively', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-private-tree-'));
  const data = join(root, 'data');
  const nested = join(data, 'files', 'workspace');
  const file = join(nested, 'resume.txt');
  try {
    await mkdir(nested, { recursive: true, mode: 0o777 });
    await writeFile(file, 'fictional resume', { mode: 0o666 });
    await ensurePrivateTree(data);
    assert.equal(await isPrivateTree(data), true);
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o077, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const isTool = (command, name) => win32.basename(command, '.exe').toLowerCase() === name;

// From Git Bash, a bare `whoami` is GNU coreutils' and rejects `/user`, so no file could be verified as private.
test('Windows system tools are called by absolute path and never looked up on PATH', () => {
  const commands = [];
  const path = 'C:\\Temp\\career-private';
  restrictToCurrentUser(path, (command, args) => {
    commands.push(command);
    if (isTool(command, 'whoami')) return '"DESKTOP-1\\ana","S-1-5-21-1-2-3-1001"\r\n';
    return args.length === 1 ? `${path} DESKTOP-1\\ana:(OI)(CI)(F)\r\n` : 'processed';
  });
  assert.ok(commands.length >= 3);
  for (const command of commands) assert.match(command, /^[A-Za-z]:\\.+\\System32\\(whoami|icacls)\.exe$/i, command);
  assert.equal(windowsTool('whoami').toLowerCase().endsWith('\\system32\\whoami.exe'), true);
});

test('a failed Windows ACL verification prevents secret content from being written', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-private-files-failure-'));
  const file = join(root, 'secret.txt');
  const run = (command, args) => isTool(command, 'whoami')
    ? '"tester","S-1-5-21-123"'
    : `${args[0]}\n  Everyone:(F)\n`;
  try {
    await assert.rejects(writePrivateFileAtomic(file, 'private secret', { run }), /Could not verify|No se pudo verificar/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
