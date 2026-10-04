import assert from 'node:assert/strict';
import test from 'node:test';
import { createCodexLoginManager, permittedCodexLoginUrl } from '../src/ai/codex-login.js';
import type { AiRpcClient, withAiRpcProcess } from '../src/ai/rpc.js';
const workspace = 'workspace-a';
function fixture() {
  let listener: ((method: string, params: Record<string, unknown>) => void) | null = null;
  const methods: string[] = [];
  const controller = new AbortController();
  const rpc: typeof withAiRpcProcess = async (_options, action) => action({
    signal: controller.signal,
    request: async method => {
      methods.push(method);
      if (method === 'account/login/start') return { type: 'chatgpt', loginId: 'fixture-login', authUrl: 'https://auth.openai.com/oauth/authorize?state=synthetic' };
      if (method === 'account/login/cancel') listener?.('account/login/completed', { loginId: 'fixture-login', success: false });
      return {};
    },
    notify: async method => { methods.push(method); },
    onNotification: (callback: Parameters<AiRpcClient['onNotification']>[0]) => { listener = callback; return () => { listener = null; }; },
  });
  const manager = createCodexLoginManager({ resolveBinary: async () => process.execPath, run: async () => ({ stdout: 'codex-cli 0.160.0\n', exitCode: 0 }), rpc });
  return { manager, methods, complete: (success = true) => listener?.('account/login/completed', { loginId: 'fixture-login', success }) };
}
test('login URL accepts only official HTTPS origins and hides terminal attempt URLs', async () => {
  for (const value of ['javascript:alert(1)', 'https://auth.openai.com.evil.test', 'https://auth.openai.com:444/x', 'https://user:secret@auth.openai.com/x', 'http://chatgpt.com/x', 'https://chatgpt.com/x#secret']) assert.equal(permittedCodexLoginUrl(value), null);
  assert.ok(permittedCodexLoginUrl('https://auth.openai.com/oauth/authorize?state=fixture'));
  assert.ok(permittedCodexLoginUrl('https://chatgpt.com/oauth/authorize?state=fixture'));
  const f = fixture(); const started = await f.manager.start(workspace);
  assert.equal(started.state, 'WAITING'); assert.ok(started.url);
  f.complete(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.manager.read(workspace, started.id).state, 'COMPLETED');
  assert.equal(f.manager.read(workspace, started.id).url, undefined);
  assert.ok(!f.methods.some(method => /turn|thread|logout/.test(method)));
  await f.manager.close();
});
test('cross-workspace reads/cancels are rejected and concurrent login is fenced', async () => {
  const f = fixture(); const started = await f.manager.start(workspace);
  assert.throws(() => f.manager.read('workspace-b', started.id), { code: 'LOGIN_NOT_FOUND' });
  await assert.rejects(f.manager.cancel('workspace-b', started.id), { code: 'LOGIN_NOT_FOUND' });
  await assert.rejects(f.manager.start('workspace-b'), { code: 'LOGIN_BUSY' });
  assert.equal((await f.manager.start(workspace)).id, started.id);
  await f.manager.cancel(workspace, started.id);
  assert.equal(f.manager.read(workspace, started.id).state, 'CANCELLED');
  assert.ok(f.methods.includes('account/login/cancel'));
  f.complete(); assert.equal(f.manager.read(workspace, started.id).state, 'CANCELLED');
  await f.manager.close();
});
test('missing binary fails with a stable error and can be retried', async () => {
  const manager = createCodexLoginManager({ resolveBinary: async () => null });
  await assert.rejects(manager.start(workspace), { code: 'LOGIN_UNAVAILABLE' });
  await assert.rejects(manager.start(workspace), { code: 'LOGIN_UNAVAILABLE' });
  await manager.close();
});
