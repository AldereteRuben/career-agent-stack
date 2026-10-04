import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { normalizeAiUsage } from '@career/domain';
import { CODEX_DEFAULT_MODEL, CodexExecutionError, type CodexExecutionResult } from '../src/ai/codex.js';
import { AI_PROMPT_VERSION, hashAiInputContent } from '../src/ai/prompts.js';
import type { AiPgClient, AiPgPool, AiQueue, AiQueueRun } from '../src/ai/queue.js';
import { buildAiSourceSnapshot } from '../src/ai/source-snapshot.js';
import { AI_WORKER_CONFIG_VERSION, createAiWorker, type AiWorkerDependencies, type AiWorkerEvent } from '../src/ai/worker.js';

const ws = '10000000-0000-4000-8000-000000000001';
const fingerprint = 'a'.repeat(64);
const salt = 'synthetic-worker-installation-salt-000000000000';
const snapshot = () => buildAiSourceSnapshot(ws, { operation: 'SEARCH_DRAFT', locale: 'en', searchRequest: 'Remote QA jobs' }, {});
const makeRun = (): AiQueueRun => {
  const source = snapshot();
  return { id: 'run-1', workspaceId: ws, connectionId: 'connection-1', consentId: 'consent-1', connectionRevision: 2,
    consentRevision: 3, provider: 'codex', accountFingerprint: fingerprint, model: CODEX_DEFAULT_MODEL,
    operation: 'SEARCH_DRAFT', origin: 'MANUAL', status: 'RUNNING', snapshot: source, snapshotHash: source.snapshotHash,
    inputVersions: { schemaVersion: 1, promptVersion: AI_PROMPT_VERSION, configVersion: AI_WORKER_CONFIG_VERSION, connectionRevision: 2, consentRevision: 3 },
    searchId: null, automationPolicyId: null, leaseToken: 'lease-1',
  };
};
const makeResult = (run: AiQueueRun): CodexExecutionResult => ({
  output: { schemaVersion: 1, operation: 'SEARCH_DRAFT', locale: 'en', criteria: { role: 'QA', company: null, location: null, workMode: 'remote' }, unsupportedConstraints: [], clarifications: [] },
  inputContentHash: hashAiInputContent(run.snapshot), model: CODEX_DEFAULT_MODEL, cliVersion: '0.160.0',
  usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 20 },
  account: { status: 'SIGNED_IN', version: '0.160.0', billing: 'CHATGPT_PLAN', accountFingerprint: fingerprint,
    maskedIdentity: 's***@example.test', plan: 'plus', usage: normalizeAiUsage({ provider: 'codex', source: 'NONE', observedAt: null, windows: [], costUsd: null }, Date.now()) },
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
async function until(predicate: () => boolean) {
  for (let index = 0; index < 30 && !predicate(); index++) await setImmediate();
  assert.ok(predicate(), 'Expected asynchronous worker state');
}

function fixture(run = makeRun()) {
  const calls = { claim: 0, heartbeat: 0, execute: 0, source: 0, finalize: 0, release: 0, revoke: 0 };
  const statements: string[] = [];
  const transactions = new Set<AiPgClient>();
  const events: AiWorkerEvent[] = [];
  const finishes: Array<Parameters<AiQueue['finish']>[2]> = [];
  const artifacts: Array<Parameters<AiQueue['finalize']>[2]['artifact']> = [];
  const usages: unknown[] = [];
  let claimed = false;
  let serial = 0;
  const timers = new Map<number, { callback: () => void; milliseconds: number }>();
  const newClient = (): AiPgClient => {
    const client: AiPgClient = {
      query: async sql => {
        statements.push(sql);
        if (sql.startsWith('BEGIN')) transactions.add(client);
        if (sql === 'COMMIT' || sql === 'ROLLBACK') transactions.delete(client);
        return { rows: [], rowCount: 0 };
      },
      release: () => { calls.release++; transactions.delete(client); },
    };
    return client;
  };
  const pool: AiPgPool = { connect: async () => newClient() };
  const queue = {
    claimNext: async () => { calls.claim++; if (claimed) return null; claimed = true; return run; },
    heartbeat: async () => { calls.heartbeat++; return true; },
    revokeConnection: async (workspaceId: string, connectionId: string) => {
      assert.equal(workspaceId, run.workspaceId); assert.equal(connectionId, run.connectionId); calls.revoke++; return 1;
    },
    finalize: async (_id: string, _token: string, input: Parameters<AiQueue['finalize']>[2]) => {
      calls.finalize++;
      const client = newClient();
      try {
        await client.query('BEGIN');
        const valid = await input.verifySources(client, run);
        if (!valid) return null;
        artifacts.push(structuredClone(input.artifact)); usages.push(input.usage);
        await client.query('COMMIT');
        return { runId: run.id, artifactId: 'artifact-1' };
      } finally { client.release(); }
    },
    finish: async (_id: string, _token: string, input: Parameters<AiQueue['finish']>[2]) => { finishes.push(input); return true; },
  } as unknown as AiQueue;
  const dependencies: AiWorkerDependencies = {
    platform: 'darwin', now: () => new Date('2026-10-04T12:00:00.000Z'),
    schedule: (callback, milliseconds) => { const id = ++serial; timers.set(id, { callback, milliseconds }); return id; },
    clearSchedule: handle => { timers.delete(handle as number); },
    checkSources: async client => { calls.source++; assert.ok(transactions.has(client)); return { ok: true, resolvedFacts: [] }; },
    execute: async () => { calls.execute++; assert.equal(transactions.size, 0, 'No transaction may be open during model work'); return makeResult(run); },
  };
  const options = { pool, queue, identitySalt: salt, enabled: true, onEvent: (event: AiWorkerEvent) => events.push(event) };
  const fire = (milliseconds: number) => {
    const entries = [...timers].filter(([, timer]) => timer.milliseconds === milliseconds);
    for (const [id, timer] of entries) { timers.delete(id); timer.callback(); }
    return entries.length;
  };
  return { run, calls, statements, transactions, events, finishes, artifacts, usages, queue, dependencies, options, timers, fire };
}

test('claims, checks current sources before execution and rechecks inside atomic finalization', async () => {
  const f = fixture();
  const worker = createAiWorker(f.options, f.dependencies);
  assert.equal(await worker.runOnce(), true);
  assert.equal(f.calls.claim, 1); assert.equal(f.calls.execute, 1); assert.equal(f.calls.source, 2); assert.equal(f.calls.finalize, 1);
  assert.equal(f.artifacts.length, 1); assert.equal(f.finishes.length, 0);
  assert.equal(f.artifacts[0]!.promptVersion, AI_PROMPT_VERSION);
  assert.deepEqual(f.usages, [{ availability: 'KNOWN', model: CODEX_DEFAULT_MODEL, inputTokens: 10, outputTokens: 20, costUsd: null }]);
  assert.ok(f.statements[0]?.startsWith('BEGIN ISOLATION LEVEL READ COMMITTED'));
  assert.ok(f.statements[1]?.includes('pg_advisory_xact_lock'));
  assert.equal(f.transactions.size, 0); assert.equal(f.timers.size, 0);
  assert.equal(await worker.runOnce(), false); assert.equal(f.calls.execute, 1);
});

test('disabled runtime gate and unsupported OS do not claim, inspect accounts or execute', async () => {
  for (const [enabled, platform] of [[false, 'darwin'], [true, 'win32'], [true, 'linux']] as const) {
    const f = fixture();
    const worker = createAiWorker({ ...f.options, enabled }, { ...f.dependencies, platform });
    worker.start(); assert.equal(await worker.runOnce(), false); await worker.stop();
    assert.equal(f.calls.claim, 0); assert.equal(f.timers.size, 0);
  }
});

test('missing/version-changed metadata and unsupported providers/models fail before execution', async () => {
  for (const patch of [{ inputVersions: {} }, { provider: 'claude-code' }, { model: 'another-model' }]) {
    const f = fixture({ ...makeRun(), ...patch } as AiQueueRun);
    await createAiWorker(f.options, f.dependencies).runOnce();
    assert.equal(f.calls.execute, 0); assert.equal(f.calls.finalize, 0);
    assert.deepEqual(f.finishes[0], { status: 'FAILED', error: { code: 'UNSUPPORTED_VERSION', dispatched: 'NO' } });
  }
});

test('source changes and tampered hashes never dispatch', async () => {
  for (const tamperHash of [false, true]) {
    const f = fixture(); if (tamperHash) f.run.snapshotHash = 'f'.repeat(64);
    if (!tamperHash) f.dependencies.checkSources = async () => ({ ok: false, code: 'AI_SOURCE_CHANGED' });
    await createAiWorker(f.options, f.dependencies).runOnce();
    assert.equal(f.calls.execute, 0);
    assert.deepEqual(f.finishes[0]?.error, { code: 'SOURCE_CHANGED', dispatched: 'NO' });
  }
});

test('source read failure rolls back, releases client and reports only stable error codes', async () => {
  const f = fixture(); f.dependencies.checkSources = async () => { throw new Error('PRIVATE DATA must not be logged'); };
  await createAiWorker(f.options, f.dependencies).runOnce();
  assert.ok(f.statements.includes('ROLLBACK')); assert.equal(f.calls.release, 1); assert.equal(f.calls.execute, 0);
  assert.deepEqual(f.events, ['SOURCE_UNAVAILABLE']);
  assert.deepEqual(f.finishes[0]?.error, { code: 'INTERNAL', dispatched: 'NO' });
});

test('finalization source check rejects a result that became stale while the model ran', async () => {
  const f = fixture();
  f.dependencies.checkSources = async () => ++f.calls.source === 1 ? { ok: true, resolvedFacts: [] } : { ok: false, code: 'AI_SOURCE_CHANGED' };
  await createAiWorker(f.options, f.dependencies).runOnce();
  assert.equal(f.calls.execute, 1); assert.equal(f.calls.finalize, 1); assert.equal(f.artifacts.length, 0);
  assert.equal(f.finishes.some(result => (result.status as string) === 'SUCCEEDED'), false);
});

test('lost lease/revocation heartbeat aborts ongoing execution and cannot publish its result', async () => {
  const f = fixture(); let aborted = false;
  f.queue.heartbeat = async () => ++f.calls.heartbeat === 1;
  f.dependencies.execute = async (_source, _fingerprint, _salt, signal) => {
    f.calls.execute++;
    await new Promise<void>(resolve => signal!.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
    return makeResult(f.run); // A late provider result must be discarded even if an adapter returns it.
  };
  const work = createAiWorker(f.options, f.dependencies).runOnce();
  await until(() => f.calls.execute === 1); assert.equal(f.fire(10_000), 1);
  await work;
  assert.equal(aborted, true); assert.equal(f.calls.finalize, 0); assert.equal(f.artifacts.length, 0);
  assert.equal(f.finishes[0]?.status, 'INTERRUPTED'); assert.equal(f.timers.size, 0);
});

test('cancelRun/cancelConnection abort locally immediately and are scoped to the current run/workspace', async () => {
  for (const connection of [false, true]) {
    const f = fixture(); let aborted = false;
    f.dependencies.execute = async (_source, _fingerprint, _salt, signal) => {
      f.calls.execute++;
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      throw new CodexExecutionError('CANCELLED', 'YES');
    };
    const worker = createAiWorker(f.options, f.dependencies); const pending = worker.runOnce();
    await until(() => f.calls.execute === 1);
    assert.equal(worker.cancelRun('another-run'), false);
    assert.equal(worker.cancelConnection('other-workspace', f.run.connectionId), false);
    assert.equal(connection ? worker.cancelConnection(ws, f.run.connectionId) : worker.cancelRun(f.run.id), true);
    await pending;
    assert.equal(aborted, true); assert.equal(f.calls.heartbeat, 1); assert.equal(f.calls.finalize, 0);
    assert.equal(f.finishes[0]?.error?.code, connection ? 'CONSENT_REVOKED' : 'CANCELLED');
  }
});

test('stop while a claim is in flight interrupts the eventual claim without dispatch', async () => {
  const f = fixture(); const claim = deferred<AiQueueRun | null>();
  f.queue.claimNext = async () => { f.calls.claim++; return claim.promise; };
  const worker = createAiWorker(f.options, f.dependencies);
  const run = worker.runOnce(); const stopping = worker.stop(); claim.resolve(f.run);
  await stopping; await run;
  assert.equal(f.calls.execute, 0); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.finishes[0], { status: 'INTERRUPTED', error: { code: 'CANCELLED', dispatched: 'NO' } });
});

test('start and runOnce never overlap; stop clears polling and does not fence other worker leases globally', async () => {
  const f = fixture(); const result = deferred<CodexExecutionResult>();
  f.dependencies.execute = async () => { f.calls.execute++; return result.promise; };
  const worker = createAiWorker(f.options, f.dependencies);
  worker.start(); worker.start(); assert.equal(await worker.runOnce(), false);
  await until(() => f.calls.execute === 1); assert.equal(f.calls.claim, 1);
  result.resolve(makeResult(f.run)); await until(() => f.calls.finalize === 1 && f.timers.size === 1);
  assert.equal(f.fire(2_000), 1); await until(() => f.calls.claim === 2);
  await worker.stop(); assert.equal(f.timers.size, 0); assert.equal(worker.isRunning(), false);
});

test('provider timeout is terminal and never retried automatically', async () => {
  const f = fixture(); f.dependencies.execute = async () => { f.calls.execute++; throw new CodexExecutionError('TIMEOUT', 'UNKNOWN'); };
  const worker = createAiWorker(f.options, f.dependencies);
  await worker.runOnce(); await worker.runOnce();
  assert.equal(f.calls.execute, 1); assert.equal(f.calls.finalize, 0);
  assert.deepEqual(f.finishes[0], { status: 'FAILED', error: { code: 'TIMEOUT', dispatched: 'UNKNOWN' } });
});

test('invalid adapter outputs, account identity and source hash are rejected before finalization', async () => {
  for (const category of ['output', 'account', 'hash']) {
    const f = fixture();
    f.dependencies.execute = async () => {
      const result = makeResult(f.run);
      if (category === 'output') result.output = { ...result.output, locale: 'es' };
      if (category === 'account') result.account.accountFingerprint = 'd'.repeat(64);
      if (category === 'hash') result.inputContentHash = 'e'.repeat(64);
      return result;
    };
    await createAiWorker(f.options, f.dependencies).runOnce();
    assert.equal(f.calls.finalize, 0); assert.equal(f.finishes[0]?.status, 'FAILED');
    assert.equal(f.finishes[0]?.error?.code, category === 'account' ? 'ACCOUNT_CHANGED' : 'INVALID_OUTPUT');
    assert.equal(f.calls.revoke, category === 'account' ? 1 : 0);
    assert.deepEqual(f.finishes[0]?.usage, { availability: 'KNOWN', model: CODEX_DEFAULT_MODEL, inputTokens: 10, outputTokens: 20, costUsd: null });
  }
});

test('authoritative account change/signout revokes only the app grant before finish; transient inspection errors preserve it', async () => {
  for (const [error, revoke] of [[new CodexExecutionError('ACCOUNT_CHANGED', 'YES'), true],
    [new CodexExecutionError('NOT_CONNECTED', 'NO', true), true], [new CodexExecutionError('NOT_CONNECTED', 'NO'), false],
    [new CodexExecutionError('PROVIDER_ERROR', 'UNKNOWN'), false]] as const) {
    const f=fixture(); f.dependencies.execute=async()=>{throw error;};
    const originalFinish=f.queue.finish;
    f.queue.finish=async(...args)=>{assert.equal(f.calls.revoke,revoke?1:0);return originalFinish(...args);};
    await createAiWorker(f.options,f.dependencies).runOnce();
    assert.equal(f.calls.revoke,revoke?1:0);assert.equal(f.finishes[0]?.error?.code,error.code);assert.equal(f.calls.finalize,0);
  }
});

test('completed numeric usage remains observed when the final account check rejects the result',async()=>{
  const f=fixture();f.dependencies.execute=async()=>{throw new CodexExecutionError('ACCOUNT_CHANGED','YES',true,{inputTokens:13,cachedInputTokens:2,outputTokens:8});};
  await createAiWorker(f.options,f.dependencies).runOnce();
  assert.equal(f.calls.finalize,0);assert.equal(f.calls.revoke,1);
  assert.deepEqual(f.finishes[0]?.usage,{availability:'KNOWN',model:CODEX_DEFAULT_MODEL,inputTokens:13,outputTokens:8,costUsd:null});
});

test('storage failures abort execution and never leak raw data or synthesize success', async () => {
  const f = fixture(); f.queue.claimNext = async () => { throw new Error('PRIVATE SQL'); };
  assert.equal(await createAiWorker(f.options, f.dependencies).runOnce(), false);
  assert.deepEqual(f.events, ['STORAGE_UNAVAILABLE']); assert.equal(f.calls.execute, 0);
});

test('invalid coordinator intervals fail early rather than permitting an expiring heartbeat', () => {
  const f = fixture();
  for (const patch of [{ heartbeatMs: 11_000 }, { leaseMs: 1_000 }, { pollMs: 0 }, { identitySalt: 'short' }]) {
    assert.throws(() => createAiWorker({ ...f.options, ...patch }, f.dependencies), { message: 'AI_WORKER_INVALID_CONFIG' });
  }
});
