import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { withAiRpcProcess } from '../src/ai/rpc.js';

const fake = (body: string) => ({ executable: process.execPath, args: ['-e', `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);${body}});`], cwd: tmpdir(), timeoutMs: 1500, killGraceMs: 50 });
const reply = "if(m.id)console.log(JSON.stringify({id:m.id,result:{method:m.method}}));";
test('duplex RPC waits for each reply and completes on stdin EOF', async () => {
  const value = await withAiRpcProcess(fake(reply), async rpc => {
    assert.deepEqual(await rpc.request('initialize'), { method: 'initialize' });
    await rpc.notify('initialized');
    return rpc.request('account/read', { refreshToken: false });
  });
  assert.deepEqual(value, { method: 'account/read' });
});
test('notifications are delivered, response order is independent', async () => {
  const seen: string[] = [];
  await withAiRpcProcess(fake("console.log(JSON.stringify({method:'notice',params:{ok:true}}));" + reply), async rpc => {
    const remove = rpc.onNotification(method => { seen.push(method); });
    await Promise.all([rpc.request('one'), rpc.request('two')]); remove();
  });
  assert.deepEqual(seen, ['notice', 'notice']);
});
test('CLI errors are normalized without raw provider secrets', async () => {
  await assert.rejects(withAiRpcProcess(fake("console.log(JSON.stringify({id:m.id,error:{message:'private-token'}}))"), rpc => rpc.request('account/read')), { message: 'RPC_FAILED' });
});
test('a server tool request aborts and cannot execute on the host', async () => {
  await assert.rejects(withAiRpcProcess(fake("console.log(JSON.stringify({id:99,method:'item/tool/call',params:{}}));"), rpc => rpc.request('thread/start')));
});
test('malformed, unknown responses and early child exit reject promptly', async () => {
  for (const body of ["console.log('bad-json');", "console.log(JSON.stringify({id:999,result:{}}));", 'process.exit(0);']) {
    await assert.rejects(withAiRpcProcess(fake(body), rpc => rpc.request('test'), 200));
  }
});
test('timeout and cancellation never leave pending RPC promises', async () => {
  await assert.rejects(withAiRpcProcess(fake(''), rpc => rpc.request('test'), 30), { message: 'RPC_TIMEOUT' });
  const controller = new AbortController();
  const promise = withAiRpcProcess({ ...fake(''), signal: controller.signal }, rpc => rpc.request('test'));
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(promise);
});
test('duplex protocol and static input cannot be combined', async () => {
  const { runAiProcess } = await import('../src/ai/process.js');
  await assert.rejects(runAiProcess({ ...fake(reply), input: 'private', interact: async () => {} }), { code: 'AI_PROCESS_FAILED' });
});
