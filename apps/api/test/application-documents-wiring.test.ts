import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

test('application-document API test runner starts in the API workspace', async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { name?: string };
  assert.equal(manifest.name, '@career/api');
});
