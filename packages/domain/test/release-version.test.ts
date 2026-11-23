import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { RELEASE_VERSION } from '../src/version.js';

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

// The dashboard footer, the sign-in page and the API all show RELEASE_VERSION. v0.10.0 shipped still saying v0.9.2
// because the release only updated the RELEASE_VERSION file and the package manifests.
test('the version shown in the app is the released version', () => {
  const released = read('RELEASE_VERSION').trim();
  assert.match(released, /^\d+\.\d+\.\d+$/u);
  assert.equal(RELEASE_VERSION, `v${released}`);
  for (const manifest of ['package.json', 'apps/api/package.json', 'apps/dashboard/package.json', 'packages/db/package.json', 'packages/domain/package.json']) {
    assert.equal((JSON.parse(read(manifest)) as { version: string }).version, released, manifest);
  }
});
