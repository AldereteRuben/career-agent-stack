import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensurePrivateDir, ensurePrivateFile, ensurePrivateTree, isPrivate, isPrivateTree } from '../lib/private-files.mjs';
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
    if (process.platform !== 'win32') {
      assert.equal((await stat(directory)).mode & 0o077, 0);
      assert.equal((await stat(file)).mode & 0o077, 0);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
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

test('a failed Windows ACL verification prevents secret content from being written', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-private-files-failure-'));
  const file = join(root, 'secret.txt');
  const run = (command, args) => command === 'whoami'
    ? '"tester","S-1-5-21-123"'
    : `${args[0]}\n  Everyone:(F)\n`;
  try {
    await assert.rejects(writePrivateFileAtomic(file, 'private secret', { run }), /Could not verify|No se pudo verificar/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
