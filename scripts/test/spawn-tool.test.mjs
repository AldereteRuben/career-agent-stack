import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cmdWouldInterpret, runPnpm } from '../lib/local-env.mjs';

// On Windows pnpm is a pnpm.cmd shim, which Node cannot start without a shell. The launcher scripts must still find it.
test('pnpm is found on every platform', () => {
  const result = runPnpm(['--version'], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

// cmd.exe is only ever started with pnpm, so an argument it would interpret is refused before anything runs.
test('on Windows an argument that cmd.exe would interpret is refused', { skip: process.platform !== 'win32' }, () => {
  for (const argument of ['a b', 'a&b', 'a|b', 'a<b', 'a>b', 'a^b', '%PATH%', 'a!b', 'a"b', '(a)', '--version & calc']) {
    assert.throws(() => runPnpm([argument]), /cmd\.exe would interpret/, argument);
  }
});

// The same check runs on every platform, so a new pnpm call with an unsafe argument fails here before it reaches Windows.
test('every pnpm argument the launcher scripts use is safe for cmd.exe', () => {
  for (const args of [['--version'], ['install', '--frozen-lockfile'], ['run', '--silent', 'db:migrate'], ['run', 'build:shared'], ['--filter', '@career/api', 'build'], ['--filter', '@career/dashboard', 'build'], ['--filter', '@career/api', 'exec', 'playwright', 'install', 'chromium']]) {
    assert.deepEqual(args.filter(cmdWouldInterpret), [], args.join(' '));
  }
  for (const argument of ['a b', 'a&b', 'a|b', 'a<b', 'a>b', 'a^b', '%PATH%', 'a!b', 'a"b', '(a)']) assert.equal(cmdWouldInterpret(argument), true, argument);
});
