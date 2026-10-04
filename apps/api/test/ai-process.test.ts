import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { aiProcessEnvironment, AiProcessError, runAiProcess } from '../src/ai/process.js';

const posixOnly = process.platform === 'win32' ? 'process groups are POSIX-only; Windows tree cleanup is not verified here' : false;
const run = (script: string, extra: Partial<Parameters<typeof runAiProcess>[0]> = {}) => runAiProcess({
  executable: process.execPath, args: ['-e', script], cwd: tmpdir(), timeoutMs: 3_000, killGraceMs: 100, ...extra,
});
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH'); return false; }
};
async function gone(pid: number) {
  for (let i = 0; i < 50; i++) { if (!alive(pid)) return true; await new Promise(resolve => setTimeout(resolve, 20)); }
  return false;
}
/** A descendant that ignores SIGTERM and reports its PID on the first stdout line. */
const stubbornChild = (stdio: string, detached = false) => `const c=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:${stdio},detached:${detached}});console.log(c.pid);c.unref();`;

test('environment excludes API keys, integration secrets and inherited agent instructions', () => {
  const result = aiProcessEnvironment({ PATH: '/bin', HOME: '/real-home', CODEX_HOME: '/official-context', OPENAI_API_KEY: 'secret', ANTHROPIC_API_KEY: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', APP_SESSION_SECRET: 'secret', DATABASE_URL: 'private', NODE_OPTIONS: '--require=untrusted', ORCA_TERMINAL_HANDLE: 'private' });
  assert.deepEqual(result, { PATH: '/bin', HOME: '/real-home', CODEX_HOME: '/official-context', NO_COLOR: '1' });
});

test('environment keeps Windows system keys in their original case and forces NO_COLOR', () => {
  const result = aiProcessEnvironment({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', PATHEXT: '.EXE', https_proxy: 'http://proxy', NO_COLOR: '0', ELECTRON_RUN_AS_NODE: '1', AWS_SECRET_ACCESS_KEY: 'secret', GH_TOKEN: 'secret' });
  assert.deepEqual(result, { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', PATHEXT: '.EXE', https_proxy: 'http://proxy', NO_COLOR: '1' });
});

test('the child sees only the filtered environment', async () => {
  const result = await run('console.log(JSON.stringify(Object.keys(process.env).sort()))', { environment: { PATH: process.env.PATH ?? '', OPENAI_API_KEY: 'secret', SECRET_TOKEN: 'secret' } });
  const keys = JSON.parse(result.stdout) as string[];
  assert.ok(!keys.includes('OPENAI_API_KEY') && !keys.includes('SECRET_TOKEN'));
  assert.ok(keys.includes('NO_COLOR'));
});

test('private input travels over stdin and Unicode lines are reconstructed', async () => {
  const lines: string[] = [];
  const result = await run("process.stdin.on('data', b => process.stdout.write(b));", { input: 'España\n第二行', onLine: line => lines.push(line) });
  assert.equal(result.stdout, 'España\n第二行');
  assert.deepEqual(lines, ['España', '第二行']);
});

test('a multi-byte character split between provider writes is preserved', async () => {
  const lines: string[] = [];
  const result = await run("process.stdout.write(Buffer.from([0xf0,0x9f]));setTimeout(()=>process.stdout.write(Buffer.from([0x98,0x80,10])),10)", { onLine: line => lines.push(line) });
  assert.equal(result.stdout, '😀\n');
  assert.deepEqual(lines, ['😀']);
});

test('nonzero exits report only a stable error, never raw provider output', async () => {
  await assert.rejects(run("process.stderr.write('credential=private');process.exit(7)"), (error: unknown) => {
    assert.ok(error instanceof AiProcessError);
    assert.equal(error.message, 'AI_PROCESS_FAILED');
    assert.ok(!JSON.stringify(error).includes('private'));
    return true;
  });
});

test('a provider that stops reading its input fails even when it exits successfully', async () => {
  await assert.rejects(run('process.stdin.destroy();setTimeout(()=>process.exit(0),50)', { input: 'x'.repeat(1_000_000) }), { code: 'AI_PROCESS_FAILED' });
});

test('output size is bounded across stdout and stderr', async () => {
  await assert.rejects(run("process.stdout.write('x'.repeat(2000));", { maxOutputBytes: 100 }), { code: 'AI_OUTPUT_TOO_LARGE' });
  await assert.rejects(run("process.stderr.write('x'.repeat(2000));", { maxOutputBytes: 100 }), { code: 'AI_OUTPUT_TOO_LARGE' });
  await assert.rejects(run("process.on('SIGTERM',()=>{});setInterval(()=>process.stdout.write('x'.repeat(1000)),5)", { maxOutputBytes: 100 }), { code: 'AI_OUTPUT_TOO_LARGE' });
});

test('output exactly at the limit is accepted', async () => {
  const result = await run("process.stdout.write('x'.repeat(100))", { maxOutputBytes: 100 });
  assert.equal(result.stdout.length, 100);
});

test('invalid protocol aborts with a normalized error and stops calling onLine', async () => {
  const seen: string[] = [];
  await assert.rejects(run("console.log('bad json\\nsecond');setInterval(()=>console.log('more'),5)", { onLine: line => { seen.push(line); JSON.parse(line); } }), { code: 'AI_INVALID_OUTPUT' });
  assert.deepEqual(seen, ['bad json']);
  await assert.rejects(run("process.stdout.write('unterminated')", { onLine: line => { JSON.parse(line); } }), { code: 'AI_INVALID_OUTPUT' });
});

test('timeout terminates a process which ignores SIGTERM', async () => {
  await assert.rejects(run("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)", { timeoutMs: 200 }), { code: 'AI_TIMEOUT' });
});

test('timeout also terminates descendants in the task process group', { skip: posixOnly }, async () => {
  let pid = 0;
  await assert.rejects(run(`${stubbornChild("'ignore'")}process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`, { timeoutMs: 300, onLine: line => { pid = Number(line); } }), { code: 'AI_TIMEOUT' });
  assert.ok(pid > 0);
  assert.equal(await gone(pid), true, 'the descendant must not outlive the task');
});

test('successful parent exit also cleans up its owned descendants', { skip: posixOnly }, async () => {
  const result = await run(stubbornChild("'ignore'"));
  const pid = Number(result.stdout.trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.equal(await gone(pid), true, 'the child process must not outlive the task');
});

test('a descendant holding stdout open does not turn a successful exit into a timeout', { skip: posixOnly }, async () => {
  const started = Date.now();
  const result = await run(stubbornChild("['ignore','inherit','ignore']"), { timeoutMs: 2_000 });
  const pid = Number(result.stdout.trim());
  assert.ok(Date.now() - started < 1_500);
  assert.equal(await gone(pid), true);
});

test('a process that escaped the task group is not killed, but cannot keep the task pending', { skip: posixOnly }, async () => {
  let pid = 0;
  const started = Date.now();
  try {
    await assert.rejects(run(stubbornChild("['ignore','inherit','ignore']", true), { timeoutMs: 2_000, onLine: line => { pid = Number(line); } }), { code: 'AI_PROCESS_FAILED' });
    assert.ok(Date.now() - started < 1_500, 'settles after the drain window, before the timeout');
    assert.ok(pid > 0 && alive(pid), 'a process outside the group created for this run is never signalled');
  } finally {
    if (pid > 0 && alive(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('cancellation never signals unrelated processes', { skip: posixOnly }, async () => {
  const bystander = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    const controller = new AbortController();
    const promise = run("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)", { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(promise, { code: 'AI_CANCELLED' });
    assert.ok(bystander.pid && alive(bystander.pid));
  } finally { bystander.kill('SIGKILL'); }
});

test('pre-aborted and running tasks cancel without leaving a pending promise', async () => {
  await assert.rejects(run("process.exit(0)", { signal: AbortSignal.abort() }), { code: 'AI_CANCELLED' });
  const controller = new AbortController();
  const promise = run("setInterval(()=>{},1000)", { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, { code: 'AI_CANCELLED' });
});

test('repeated aborts and a later timeout keep the first outcome', async () => {
  const controller = new AbortController();
  const promise = run("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)", { signal: controller.signal, timeoutMs: 150 });
  setTimeout(() => { controller.abort(); controller.abort(); }, 20);
  await assert.rejects(promise, { code: 'AI_CANCELLED' });
});

test('invalid options and spawn arguments are rejected with stable codes', async () => {
  await assert.rejects(run('0', { executable: 'node' }), { code: 'AI_PROCESS_FAILED' });
  await assert.rejects(run('0', { cwd: '.' }), { code: 'AI_PROCESS_FAILED' });
  await assert.rejects(run('0', { timeoutMs: 0 }), { code: 'AI_PROCESS_FAILED' });
  await assert.rejects(run('0', { killGraceMs: 10_000 }), { code: 'AI_PROCESS_FAILED' });
  await assert.rejects(run('0', { maxOutputBytes: 2_000_000 }), { code: 'AI_PROCESS_FAILED' });
  // Node throws synchronously for NUL bytes; the raw error would echo the argument.
  await assert.rejects(run('private\0argument'), (error: unknown) => error instanceof AiProcessError && error.code === 'AI_PROCESS_FAILED' && !error.message.includes('private'));
  await assert.rejects(run('0', { executable: '/career-stack-nonexistent-executable' }), { code: 'AI_EXECUTABLE_UNAVAILABLE' });
});
