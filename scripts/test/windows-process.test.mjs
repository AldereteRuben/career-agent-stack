import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { parseProcessJson, windowsListeningPid, windowsProcessIdentity, windowsStopTree } from '../lib/windows-process.mjs';

test('parses the JSON that Get-CimInstance prints', () => {
  const parsed = parseProcessJson('{"ProcessId":4242,"ParentProcessId":10,"CommandLine":"node.exe C:\\\\app\\\\server.js","Created":1760000000123}');
  assert.deepEqual(parsed, { pid: 4242, ppid: 10, startedAt: 1760000000123, args: 'node.exe C:\\app\\server.js' });
});

test('refuses output that does not identify a process', () => {
  for (const text of ['', 'not json', '{}', '{"ProcessId":4242}', '{"ProcessId":1,"CommandLine":"x","Created":1}', '{"ProcessId":4242,"CommandLine":"","Created":1}']) {
    assert.equal(parseProcessJson(text), null, text);
  }
});

test('refuses PIDs that are not plain positive integers before anything reaches PowerShell', () => {
  for (const pid of [0, 1, -5, 1.5, NaN, '123', '1; calc', null, undefined]) {
    assert.equal(windowsProcessIdentity(pid), null);
    assert.equal(windowsStopTree(pid), false);
  }
  for (const port of [0, 70000, 1.5, '80; calc', NaN]) assert.equal(windowsListeningPid(port), null);
});

// The rest drives real Windows tools on a real process.
const onWindows = process.platform === 'win32';

test('identifies a running process, finds its port and ends its whole tree', { skip: !onWindows }, async () => {
  const child = spawn(process.execPath, ['-e', `
    const server = require('node:net').createServer().listen(0, '127.0.0.1', () => console.log('port ' + server.address().port));
    require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  `], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  try {
    const [chunk] = await once(child.stdout, 'data');
    const port = Number(String(chunk).match(/port (\d+)/)?.[1]);
    assert.ok(port > 0);
    const identity = windowsProcessIdentity(child.pid);
    assert.equal(identity?.pid, child.pid);
    assert.equal(identity.pgid, child.pid);
    assert.match(identity.args, /node/i);
    assert.ok(Math.abs(identity.startedAt - Date.now()) < 60_000, 'start time is recent');
    assert.equal(windowsListeningPid(port), child.pid);
    assert.equal(windowsStopTree(child.pid), true);
    await once(child, 'exit');
    assert.equal(windowsProcessIdentity(child.pid), null, 'an ended process has no identity');
  } finally { child.kill(); }
});
