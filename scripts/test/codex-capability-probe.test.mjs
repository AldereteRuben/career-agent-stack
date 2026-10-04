import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate } from 'node:timers';
import test from 'node:test';
import {
  MAX_OUTPUT_BYTES,
  normalizeAccount,
  normalizeRateLimits,
  presentOverrides,
  probe,
  readNativeAccount,
  resolveBinary,
  safeCodexEnv,
} from '../ai/codex-capability-probe.mjs';

class FakeChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  kills = [];

  constructor({ onLine = () => {}, onKill, failWrite = false, autoClose = false } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        if (failWrite) return callback(Object.assign(new Error('private EPIPE detail'), { code: 'EPIPE' }));
        try { onLine.call(this, String(chunk)); callback(); } catch (error) { callback(error); }
      },
      final: (callback) => {
        callback();
        if (autoClose) setImmediate(() => this.close(0));
      },
    });
    this.onKill = onKill;
  }

  kill(signal) {
    this.kills.push(signal);
    if (this.onKill) this.onKill(signal, this);
    else setImmediate(() => this.close(null, signal));
    return true;
  }

  unref() { this.unrefCalled = true; }

  close(code, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null || this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => {
      this.emit('exit', code, signal);
      this.emit('close', code, signal);
    });
  }

  sendJson(value) { this.stdout.write(`${JSON.stringify(value)}\n`); }
}

function protocolChild({ splitUtf8 = false, errorText, account = { type: 'chatgpt', email: 'private☃@example.test', accessToken: 'private-token' }, rateLimits } = {}) {
  return new FakeChild({
    autoClose: true,
    onLine(line) {
      const request = JSON.parse(line);
      if (request.id === undefined) return;
      if (request.method === 'initialize') {
        this.sendJson({ id: request.id, result: {} });
      } else if (request.method === 'account/read') {
        if (errorText) this.sendJson({ id: request.id, error: { code: -32000, message: errorText } });
        else {
          const bytes = Buffer.from(JSON.stringify({ id: request.id, result: { account, requiresOpenaiAuth: true } }) + '\n');
          const marker = Buffer.from('☃');
          const split = bytes.indexOf(marker) + 1;
          if (splitUtf8 && split > 0) {
            this.stdout.write(bytes.subarray(0, split));
            this.stdout.write(bytes.subarray(split));
          } else this.stdout.write(bytes);
        }
      } else if (request.method === 'account/rateLimits/read') {
        this.sendJson({ id: request.id, result: rateLimits ?? {
          ordinaryUsageAllowed: true,
          rateLimitsByLimitId: { codex: { primary: { usedPercent: 23, windowDurationMins: 60, resetsAt: 1234 }, rateLimitReachedType: null } },
        } });
      }
    },
  });
}

test('probe handles a missing executable without spawning or reading user context', async () => {
  const result = await probe({ source: { PATH: '' }, platform: 'linux', spawnImpl: () => { throw new Error('must not spawn'); } });
  assert.equal(result.binary.found, false);
  assert.equal(result.appServerAccountRead.readCompleted, false);
});

test('app-server that exits immediately returns unavailable and does not wait for an exit event twice', async () => {
  const child = new FakeChild();
  child.exitCode = 7;
  child.closed = true;
  const result = await readNativeAccount('/fake/codex', { spawnImpl: () => child, timeoutMs: 20 });
  assert.equal(result.readCompleted, false);
  assert.equal(result.rateLimits.available, false);
});

test('hung app-server protocol is bounded and terminates the child', async () => {
  const child = new FakeChild();
  const started = Date.now();
  const result = await readNativeAccount('/fake/codex', {
    spawnImpl: () => child,
    timeoutMs: 20,
    shutdownGraceMs: 20,
    hardShutdownMs: 20,
  });
  assert.equal(result.readCompleted, false);
  assert.ok(Date.now() - started < 250);
  assert.ok(child.kills.includes('SIGTERM'));
});

test('unresponsive app-server is hard-killed, its pipes are destroyed, and the child is unrefed', async () => {
  const child = new FakeChild({ onKill: () => {} });
  const started = Date.now();
  const result = await readNativeAccount('/fake/codex', {
    spawnImpl: () => child,
    timeoutMs: 10,
    shutdownGraceMs: 10,
    hardShutdownMs: 10,
  });
  assert.equal(result.readCompleted, false);
  assert.ok(Date.now() - started < 200);
  assert.ok(child.kills.includes('SIGTERM'));
  assert.ok(child.kills.includes('SIGKILL'));
  assert.equal(child.unrefCalled, true);
  assert.equal(child.stdin.destroyed, true);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
});

test('fragmented UTF-8 protocol data is decoded before JSON parsing and account data is redacted', async () => {
  const child = protocolChild({ splitUtf8: true });
  const result = await readNativeAccount('/fake/codex', { spawnImpl: () => child, timeoutMs: 50 });
  assert.equal(result.readCompleted, true);
  assert.equal(result.account.accountPresent, true);
  assert.equal(result.account.identityPresent, true);
  assert.equal(result.rateLimits.available, true);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('private'), false);
  assert.equal(serialized.includes('☃'), false);
});

test('stdout and stderr share a total output limit and overflow never reaches returned diagnostics', async () => {
  const child = new FakeChild({ onLine(_line) {
    this.stdout.write(Buffer.alloc(MAX_OUTPUT_BYTES + 4, 0x78));
    this.stderr.write('private-overflow-detail');
  } });
  const result = await readNativeAccount('/fake/codex', {
    spawnImpl: () => child,
    timeoutMs: 50,
    maxOutputBytes: 100,
    shutdownGraceMs: 20,
    hardShutdownMs: 20,
  });
  assert.equal(result.readCompleted, false);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.ok(child.kills.includes('SIGTERM'));
});

test('stuck version/help child is force-settled and detached after the hard shutdown deadline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-probe-hard-stop-'));
  let stuck;
  const spawnImpl = (_file, args) => {
    if (args[0] === '--version') {
      stuck = new FakeChild({ onKill: () => {} });
      return stuck;
    }
    if (args[0] === 'app-server' && args[1] === '--help') return commandChild('  --stdio  use stdio\n');
    return commandChild('');
  };
  try {
    const result = await probe({
      binary: '/fixture/codex', source: { PATH: '/fixture' }, tempRoot: root, spawnImpl,
      timeoutMs: 15, shutdownGraceMs: 10, hardShutdownMs: 10,
    });
    assert.equal(result.binary.version, null);
    assert.ok(stuck.kills.includes('SIGTERM'));
    assert.ok(stuck.kills.includes('SIGKILL'));
    assert.equal(stuck.unrefCalled, true);
    assert.equal(stuck.stdout.destroyed, true);
    assert.equal(stuck.stderr.destroyed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('spawn errors and stdin EPIPE become unavailable results without leaking error text', async () => {
  const spawnFailure = await readNativeAccount('/missing', { spawnImpl: () => { throw new Error('private spawn path'); } });
  assert.equal(spawnFailure.readCompleted, false);
  const epipeChild = new FakeChild({ failWrite: true });
  const epipe = await readNativeAccount('/fake/codex', { spawnImpl: () => epipeChild, timeoutMs: 50 });
  assert.equal(epipe.readCompleted, false);
  assert.equal(JSON.stringify(epipe).includes('private'), false);
  const rejectedResponse = await readNativeAccount('/fake/codex', {
    spawnImpl: () => protocolChild({ errorText: 'private service diagnostic' }),
    timeoutMs: 50,
  });
  assert.equal(rejectedResponse.readCompleted, false);
  assert.equal(JSON.stringify(rejectedResponse).includes('private'), false);
});

test('malformed account and rate-limit arrays or unknown usage stay unavailable', () => {
  assert.equal(normalizeAccount([]).available, false);
  assert.equal(normalizeAccount({ account: [], requiresOpenaiAuth: true }).available, false);
  assert.equal(normalizeAccount({ account: { type: [] }, requiresOpenaiAuth: true }).available, false);
  assert.equal(normalizeRateLimits([]).available, false);
  assert.equal(normalizeRateLimits({ rateLimitsByLimitId: [] }).available, false);
  assert.equal(normalizeRateLimits({ rateLimitsByLimitId: { codex: [] } }).available, false);
  assert.equal(normalizeRateLimits({ rateLimitsByLimitId: { codex: { primary: [] } } }).available, false);
  assert.equal(normalizeRateLimits({ rateLimitsByLimitId: { codex: { rateLimitReachedType: 'private-status' } } }).available, false);
  assert.equal(normalizeRateLimits({ ordinaryUsageAllowed: true }).available, false);
  const unknown = normalizeRateLimits({ rateLimitsByLimitId: { codex: { primary: { usedPercent: '23' } } } });
  assert.equal(unknown.available, false);
});

test('Windows environment lookup is case-insensitive and preserves actual key spelling', () => {
  const source = {
    pAtH: 'C:\\bin',
    systemroot: 'C:\\Windows',
    userProfile: 'C:\\Users\\fixture',
    openai_api_key: 'private-key',
    node_options: 'private-options',
  };
  const env = safeCodexEnv(source, 'win32');
  assert.deepEqual(env, { pAtH: 'C:\\bin', systemroot: 'C:\\Windows', userProfile: 'C:\\Users\\fixture' });
  assert.equal(presentOverrides(source, 'win32').OPENAI_API_KEY, true);
  assert.equal(JSON.stringify(env).includes('private'), false);

  const resolved = resolveBinary('codex', { Path: 'C:\\bin' }, 'win32', {
    statSync: () => ({ isFile: () => true }),
  });
  assert.equal(resolved, 'C:\\bin\\codex.exe');
});

test('legacy usage survives a null bucket map and absent limits stay unknown', () => {
  const result = normalizeRateLimits({ rateLimitsByLimitId: null, rateLimits: {
    primary: { usedPercent: 20, windowDurationMins: -5, resetsAt: -1 },
  } });
  assert.equal(result.available, true);
  assert.equal(result.buckets[0].primary.usedPercent, 20);
  assert.equal(result.buckets[0].primary.windowDurationMins, null);
  assert.equal(result.buckets[0].primary.resetsAt, null);
  assert.equal(result.buckets[0].reached, null);
  assert.equal(result.ordinaryUsageAllowed, null);
});

test('reaped app-server parents cannot leave inherited pipes attached to the probe', async () => {
  const child = new FakeChild();
  child.exitCode = 0;
  const result = await readNativeAccount('/fixture/codex', { spawnImpl: () => child, timeoutMs: 20 });
  assert.equal(result.readCompleted, false);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  assert.equal(child.unrefCalled, true);
  assert.deepEqual(child.kills, []);
});

test('version/help and app-server use a temporary cwd and sanitized environment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-probe-test-'));
  const calls = [];
  const source = {
    PATH: '/approved/bin', HOME: '/private/home', OPENAI_API_KEY: 'private-key',
    NODE_OPTIONS: '--require=/private/injected.js',
  };
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args, options });
    if (args[0] === '--version') return commandChild('codex-cli 0.160.0\n');
    if (args[0] === 'app-server' && args[1] === '--stdio') return protocolChild();
    if (args[0] === 'exec') return commandChild('  --ignore-user-config  no config\n  --ignore-rules  no rules\n  --ephemeral  no session\n  --output-schema <FILE>\n');
    return commandChild('  --stdio  use stdio\n');
  };
  try {
    const result = await probe({ binary: '/fixture/codex', source, tempRoot: root, spawnImpl, timeoutMs: 50 });
    assert.equal(result.binary.version, '0.160.0');
    assert.equal(result.appServerAccountRead.readCompleted, true);
    assert.equal(result.isolation.execCandidateFlagsPresent, true);
    assert.equal(calls.length, 4);
    for (const call of calls) {
      assert.notEqual(call.options.cwd, '/private/home');
      assert.ok(call.options.cwd.startsWith(root));
      assert.equal(call.options.env.OPENAI_API_KEY, undefined);
      assert.equal(call.options.env.NODE_OPTIONS, undefined);
    }
    assert.equal(JSON.stringify(result).includes('private-key'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function commandChild(output) {
  const child = new FakeChild();
  setImmediate(() => {
    child.stdout.write(output);
    child.close(0);
  });
  return child;
}
