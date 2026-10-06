// pnpm leaves node_modules/.modules.yaml untouched when an install has nothing to do. The launcher compares that file's date with
// pnpm-lock.yaml, so after a `git pull` that changes the lockfile `status` warned for good. markDependenciesCurrent fixes the date.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { markDependenciesCurrent, mtimeOf } from '../lib/local-env.mjs';

test('a lockfile newer than the install marker stops looking outdated once the marker is refreshed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-marker-'));
  try {
    await mkdir(join(root, 'node_modules'));
    const marker = join(root, 'node_modules/.modules.yaml'); const lockfile = join(root, 'pnpm-lock.yaml');
    await writeFile(marker, 'layoutVersion: 5\n'); await writeFile(lockfile, 'lockfileVersion: 9\n');
    const earlier = new Date(Date.now() - 3 * 60 * 60 * 1000); // installed three hours ago
    await utimes(marker, earlier, earlier);
    assert.ok(await mtimeOf(marker) < await mtimeOf(lockfile), 'before: the lockfile is newer, which is what status reads as outdated');
    assert.equal(await markDependenciesCurrent(marker), true);
    assert.ok(await mtimeOf(marker) >= await mtimeOf(lockfile), 'after: the install marker is not older than the lockfile');
    assert.equal((await stat(marker)).size, 'layoutVersion: 5\n'.length, 'only the date changes, never the contents');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('without a marker there is nothing to refresh and no error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'career-marker-'));
  try { assert.equal(await markDependenciesCurrent(join(root, 'node_modules/.modules.yaml')), false); }
  finally { await rm(root, { recursive: true, force: true }); }
});
