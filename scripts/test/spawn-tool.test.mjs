import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnTool } from '../lib/local-env.mjs';

// On Windows pnpm is a pnpm.cmd shim, which Node cannot start without a shell. The launcher scripts must still find it.
test('pnpm is found on every platform', () => {
  const result = spawnTool('pnpm', ['--version'], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('other commands run without a shell, so their arguments are never interpreted', () => {
  const result = spawnTool(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', 'a & b'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'a & b');
});
