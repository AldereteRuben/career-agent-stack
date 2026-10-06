import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { listeningPid, processIdentity } from '../lib/local-env.mjs';

// Next.js renames its server process to "next-server (vX)". The nested parenthesis in that title makes lsof 4.99 skip the
// process entirely, so the launcher could not identify the web app it had started. This runs a real process with that title.
const supported = process.platform === 'linux' || process.platform === 'darwin';

test('a listening process is found even when its title contains parentheses', { skip: !supported }, async () => {
  const child = spawn(process.execPath, ['-e', `
    process.title = 'next-server (v16.3.8)';
    const server = require('node:net').createServer().listen(0, '127.0.0.1', () => console.log(server.address().port));
    setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const [chunk] = await once(child.stdout, 'data');
    const port = Number(chunk.toString().trim());
    assert.ok(port > 0, 'the fixture server must report its port');
    assert.equal(listeningPid(port), child.pid);
  } finally { child.kill(); }
});

test('a port nobody listens on has no process', { skip: !supported }, () => {
  assert.equal(listeningPid(1), null);
});

// `ps` derives the start time from the boot time with two one-second roundings, so it can be about two seconds off. The
// launcher compares it with the build time to say whether a service runs the current build, and it must not guess.
// The boot time (`btime`) is whole seconds, so the start can be up to one second early but never late, and it does not drift
// with suspend (unlike now - /proc/uptime), which is why the launcher keeps a one-second margin.
test('the start time of a process is within one second, and never later than the real start', { skip: process.platform !== 'linux' }, async () => {
  const before = Date.now();
  const child = spawn(process.execPath, ['-e', `console.log('up'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await once(child.stdout, 'data');
    const after = Date.now();
    const identity = await processIdentity(child.pid);
    assert.ok(identity, 'the identity must be readable');
    assert.ok(identity.startedAt >= before - 1_100 && identity.startedAt <= after + 100, `started at ${identity.startedAt - before} ms after launch, expected between -1000 and ${after - before}`);
  } finally { child.kill(); }
});
