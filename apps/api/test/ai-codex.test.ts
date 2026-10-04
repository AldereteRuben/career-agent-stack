import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { test } from 'node:test';
import { normalizeAiUsage, type AiSourceSnapshot } from '@career/domain';
import { CODEX_DEFAULT_MODEL, CodexExecutionError, createCodexOutputParser, executeCodex, type CodexDependencies } from '../src/ai/codex.js';
import { CODEX_PROTOCOL_VERSION, type CodexAccountObservation } from '../src/ai/codex-account.js';
import { AiProcessError, type AiProcessOptions } from '../src/ai/process.js';
import { hashAiInputContent } from '../src/ai/prompts.js';

const fingerprint = 'a'.repeat(64);
const salt = 'synthetic-installation-salt-000000000000';
const source = (): AiSourceSnapshot => ({
  schemaVersion: 1, snapshotId: 'snapshot-1', workspaceId: 'workspace-1', operation: 'SEARCH_DRAFT', locale: 'en',
  snapshotHash: 'b'.repeat(64), searchRequest: { text: 'Remote QA jobs', contentHash: 'c'.repeat(64) },
  job: null, question: null, facts: [], profileRevision: null, identityFingerprint: null,
});
const output = () => ({ schemaVersion: 1, operation: 'SEARCH_DRAFT', locale: 'en',
  criteria: { role: 'QA', company: null, location: null, workMode: 'remote' }, unsupportedConstraints: [], clarifications: [],
});
const signedIn = (): CodexAccountObservation => ({
  status: 'SIGNED_IN', version: CODEX_PROTOCOL_VERSION, billing: 'CHATGPT_PLAN', accountFingerprint: fingerprint,
  maskedIdentity: 's***@example.test', plan: 'plus', usage: normalizeAiUsage({ provider: 'codex', source: 'NONE', observedAt: null, windows: [], costUsd: null }, Date.now()),
});
const events = (raw: unknown = output()) => [
  { type: 'thread.started', thread_id: 'thread-synthetic' }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: JSON.stringify(raw) } },
  { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 5 } },
];
const emit = (options: AiProcessOptions, stream: unknown[] = events()) => {
  for (const event of stream) options.onLine?.(JSON.stringify(event));
  return { stdout: stream.map(event => JSON.stringify(event)).join('\n'), exitCode: 0 as const };
};
const deps = (patch: Partial<CodexDependencies> = {}): Partial<CodexDependencies> => ({
  platform: 'darwin', environment: { PATH: '/synthetic/bin', HOME: '/synthetic/home', CODEX_HOME: '/synthetic/home/.codex' },
  inspect: async () => signedIn(), resolveBinary: async () => '/synthetic/bin/codex', run: async options => emit(options), ...patch,
});
const code = (expected: string, dispatched?: string) => (error: unknown) => error instanceof CodexExecutionError
  && error.code === expected && error.message === expected && (dispatched === undefined || error.dispatched === dispatched);

test('executes one strictly configured task; private sources are stdin only and temp files are private and removed', async () => {
  let directory = ''; let inspections = 0; let mockFailure: unknown;
  const execution = executeCodex(source(), fingerprint, salt, undefined, CODEX_DEFAULT_MODEL, deps({
    inspect: async () => { inspections++; return signedIn(); },
    environment: { HOME: '/synthetic/home', CODEX_HOME: '/synthetic/home/.codex', PATH: '/synthetic/bin',
      OPENAI_API_KEY: 'secret-key', OPENAI_BASE_URL: 'https://evil.invalid', CODEX_API_KEY: 'secret-key', NODE_OPTIONS: 'evil', HTTPS_PROXY: 'https://evil.invalid',
    },
    run: async options => {
      try {
      directory = options.cwd;
      assert.equal(options.executable, '/synthetic/bin/codex');
      assert.ok(options.args.includes('--ignore-user-config'));
      assert.ok(options.args.includes('--ignore-rules'));
      assert.ok(options.args.includes('--ephemeral'));
      assert.ok(options.args.includes('--strict-config'));
      assert.ok(options.args.includes('--no-daemon'));
      assert.ok(options.args.includes('forced_login_method="chatgpt"'));
      assert.ok(options.args.includes('model_provider="openai"'));
      assert.ok(options.args.includes('skills.include_instructions=false'));
      assert.ok(options.args.includes('cloud.skills.enabled=false'));
      assert.ok(options.args.includes('tools.experimental_request_user_input.enabled=false'));
      assert.ok(options.args.includes('tools.update_plan.enabled=false'));
      assert.ok(options.args.includes('project_doc_max_bytes=0'));
      assert.equal(options.args.some(arg => arg.startsWith('model_providers.openai')), false);
      assert.equal(options.args.at(-1), '-');
      assert.equal(options.args.some(arg => arg.includes('Remote QA jobs')), false);
      assert.ok(options.input?.includes('Remote QA jobs'));
      assert.ok(options.input?.startsWith('<career_stack_untrusted_data>'));
      assert.equal(options.environment?.HOME, '/synthetic/home');
      assert.equal(options.environment?.CODEX_HOME, '/synthetic/home/.codex');
      for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'NODE_OPTIONS', 'HTTPS_PROXY']) assert.equal(options.environment?.[key], undefined);
      const instructionsArg = options.args.find(arg => arg.startsWith('model_instructions_file='))!;
      const instructionsPath = JSON.parse(instructionsArg.slice('model_instructions_file='.length)) as string;
      const instructions = await readFile(instructionsPath, 'utf8');
      assert.equal(instructions.includes('Remote QA jobs'), false);
      assert.ok(instructions.includes('Use only the supplied source data'));
      const instructionsStat = await stat(instructionsPath);
      assert.ok(instructionsStat.isFile());
      // This test simulates the macOS adapter on every CI host. Windows stat mode bits do not describe POSIX permissions.
      if (process.platform !== 'win32') assert.equal(instructionsStat.mode & 0o777, 0o600);
      const schemaPath = options.args[options.args.indexOf('--output-schema') + 1]!;
      const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as Record<string, unknown>;
      assert.equal(schema.additionalProperties, false);
      const schemaStat = await stat(schemaPath);
      assert.ok(schemaStat.isFile());
      if (process.platform !== 'win32') assert.equal(schemaStat.mode & 0o777, 0o600);
      return emit(options);
      } catch (error) { mockFailure = error; throw error; }
    },
  }));
  // Production deliberately hides subprocess internals; preserve synthetic assertion diagnostics in this test.
  const result = await execution.catch(error => { throw mockFailure ?? error; });
  assert.equal(inspections, 2);
  assert.deepEqual(result.output, output());
  assert.equal(result.inputContentHash, hashAiInputContent(source()));
  assert.deepEqual(result.usage, { inputTokens: 20, cachedInputTokens: 10, outputTokens: 5 });
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('unsupported OS/model, invalid identity and malformed snapshots fail before account or inference', async () => {
  let calls = 0;
  const dependencies = deps({ inspect: async () => { calls++; return signedIn(); }, run: async options => { calls++; return emit(options); } });
  await assert.rejects(executeCodex(source(), fingerprint, salt, undefined, CODEX_DEFAULT_MODEL, { ...dependencies, platform: 'win32' }), code('UNSUPPORTED_VERSION', 'NO'));
  await assert.rejects(executeCodex(source(), fingerprint, salt, undefined, 'unsupported' as typeof CODEX_DEFAULT_MODEL, dependencies), code('UNSUPPORTED_VERSION', 'NO'));
  await assert.rejects(executeCodex(source(), 'bad', salt, undefined, CODEX_DEFAULT_MODEL, dependencies), code('NOT_CONNECTED', 'NO'));
  await assert.rejects(executeCodex({ ...source(), locale: 'xx' } as unknown as AiSourceSnapshot, fingerprint, salt, undefined, CODEX_DEFAULT_MODEL, dependencies), code('INVALID_OUTPUT', 'NO'));
  assert.equal(calls, 0);
});

test('account version, route and fingerprint are checked before dispatch', async () => {
  for (const [patch, expected, invalidate] of [
    [{ status: 'SIGNED_OUT', accountFingerprint: null }, 'NOT_CONNECTED', true],
    [{ billing: 'SEPARATE_API' }, 'NOT_CONNECTED', true],
    [{ accountFingerprint: 'd'.repeat(64) }, 'ACCOUNT_CHANGED', true],
    [{ version: '0.161.0' }, 'UNSUPPORTED_VERSION', false],
    [{ status: 'UNAVAILABLE', accountFingerprint: null }, 'NOT_CONNECTED', false],
  ] as const) {
    let calls = 0;
    await assert.rejects(executeCodex(source(), fingerprint, salt, undefined, CODEX_DEFAULT_MODEL, deps({
      inspect: async () => ({ ...signedIn(), ...patch }), run: async options => { calls++; return emit(options); },
    })), error => {
      assert.ok(error instanceof CodexExecutionError); assert.equal(error.invalidateConnection,invalidate);
      return code(expected,'NO')(error);
    });
    assert.equal(calls, 0);
  }
});

test('account changes after a completed result discard it and never trigger retry', async () => {
  let reads = 0; let runs = 0;
  await assert.rejects(executeCodex(source(), fingerprint, salt, undefined, CODEX_DEFAULT_MODEL, deps({
    inspect: async () => ({ ...signedIn(), accountFingerprint: ++reads === 1 ? fingerprint : 'd'.repeat(64) }),
    run: async options => { runs++; return emit(options); },
  })), error => {
    assert.ok(error instanceof CodexExecutionError);assert.ok(error.usage);assert.equal(error.invalidateConnection,true);
    return code('ACCOUNT_CHANGED','YES')(error);
  });
  assert.equal(runs, 1);
});

test('explicit provider limit blocks dispatch but unavailable quota is not reported as zero', async () => {
  let calls = 0;
  const now = Date.now();
  await assert.rejects(executeCodex(source(), fingerprint, salt, undefined, CODEX_DEFAULT_MODEL, deps({
    inspect: async () => ({ ...signedIn(), usage: normalizeAiUsage({ provider: 'codex', source: 'PROVIDER_REPORTED', observedAt: new Date(now).toISOString(), costUsd: null,
      windows: [{ windowId: 'primary', usedPercent: 100, resetsAt: null, limitReached: true }] }, now) }),
    run: async options => { calls++; return emit(options); },
  })), code('PROVIDER_LIMIT_REACHED', 'NO'));
  assert.equal(calls, 0);
});

test('snapshot is copied before account await so caller mutation cannot alter a dispatched task', async () => {
  const snapshot = source(); let reads = 0;
  await executeCodex(snapshot, fingerprint, salt, undefined, CODEX_DEFAULT_MODEL, deps({
    inspect: async () => { if (++reads === 1) snapshot.searchRequest!.text = 'MUTATED PRIVATE SOURCE'; return signedIn(); },
    run: async options => { assert.ok(options.input?.includes('Remote QA jobs')); assert.equal(options.input?.includes('MUTATED'), false); return emit(options); },
  }));
});

test('strict domain/evidence validation rejects structurally valid output for the wrong locale or unsupported dropped salary', async () => {
  await assert.rejects(executeCodex(source(), fingerprint, salt, undefined, CODEX_DEFAULT_MODEL, deps({ run: async options => emit(options, events({ ...output(), locale: 'es' })) })), code('INVALID_OUTPUT', 'YES'));
  const snapshot = source(); snapshot.searchRequest!.text = 'QA jobs paying €50000';
  await assert.rejects(executeCodex(snapshot, fingerprint, salt, undefined, CODEX_DEFAULT_MODEL, deps()), code('INVALID_OUTPUT', 'YES'));
});

test('cancelled, timed out and invalid subprocesses have stable private errors and never retry', async () => {
  for (const [processCode, expected] of [['AI_TIMEOUT', 'TIMEOUT'], ['AI_CANCELLED', 'CANCELLED'], ['AI_INVALID_OUTPUT', 'INVALID_OUTPUT'], ['AI_PROCESS_FAILED', 'PROVIDER_ERROR']] as const) {
    let runs = 0; let directory = '';
    await assert.rejects(executeCodex(source(), fingerprint, salt, undefined, CODEX_DEFAULT_MODEL, deps({ run: async options => { runs++; directory = options.cwd; throw new AiProcessError(processCode); } })), code(expected, 'UNKNOWN'));
    assert.equal(runs, 1); await assert.rejects(stat(directory), { code: 'ENOENT' });
  }
});

test('cancellation before dispatch and after completion never returns a draft', async () => {
  const early = new AbortController(); early.abort();
  await assert.rejects(executeCodex(source(), fingerprint, salt, early.signal, CODEX_DEFAULT_MODEL, deps()), code('CANCELLED', 'NO'));
  const late = new AbortController();
  await assert.rejects(executeCodex(source(), fingerprint, salt, late.signal, CODEX_DEFAULT_MODEL, deps({ run: async options => { const result = emit(options); late.abort(); return result; } })), code('CANCELLED', 'YES'));
});

test('parser accepts exactly one final JSON message and observes optional usage without inventing it', () => {
  const parser = createCodexOutputParser();
  const stream = events(); stream[3] = { type: 'turn.completed' } as typeof stream[number];
  for (const event of stream) parser.onLine(JSON.stringify(event));
  assert.deepEqual(parser.finish(), { raw: output(), usage: { inputTokens: null, cachedInputTokens: null, outputTokens: null } });
});

test('parser permits only the exact code-mode isolation notice, once and before the turn', () => {
  const notice = { type: 'item.completed', item: { type: 'error', message: 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.' } };
  const parser = createCodexOutputParser();
  for (const event of [events()[0], notice, ...events().slice(1)]) parser.onLine(JSON.stringify(event));
  assert.deepEqual(parser.finish().raw, output());
  for (const stream of [
    [events()[0], notice, notice], [events()[0], events()[1], notice],
    [events()[0], { ...notice, item: { ...notice.item, message: notice.item.message + ' more instructions' } }],
    [events()[0], { ...notice, item: { ...notice.item, message: 'Authentication failed' } }],
  ]) {
    const invalid = createCodexOutputParser();
    assert.throws(() => { for (const event of stream) invalid.onLine(JSON.stringify(event)); }, code('INVALID_OUTPUT'));
  }
});

test('parser rejects tool calls, unknown events, commentary, duplicate finals and data after completion', () => {
  const cases: unknown[][] = [
    [...events().slice(0, 2), { type: 'item.started', item: { type: 'command_execution', command: 'private source' } }],
    [...events().slice(0, 2), { type: 'item.completed', item: { type: 'mcp_tool_call' } }],
    [...events().slice(0, 2), { type: 'item.completed', item: { type: 'agent_message', phase: 'commentary', text: '{}' } }],
    [...events().slice(0, 3), events()[2]], [...events(), events()[2]],
    [{ type: 'unknown' }], [{ type: 'turn.started' }], [{ type: 'thread.started', thread_id: 'x' }, { type: 'thread.started', thread_id: 'y' }],
  ];
  for (const stream of cases) {
    const parser = createCodexOutputParser();
    assert.throws(() => { for (const event of stream) parser.onLine(JSON.stringify(event)); }, code('INVALID_OUTPUT'));
  }
});

test('parser rejects malformed JSON, missing completion, fenced JSON and multiple output objects', () => {
  assert.throws(() => createCodexOutputParser().onLine('private non-JSON output'), code('INVALID_OUTPUT'));
  for (const text of ['```json\n{}\n```', '{}\n{}', '[]', 'null']) {
    const parser = createCodexOutputParser();
    for (const event of [events()[0], events()[1], { type: 'item.completed', item: { type: 'agent_message', text } }, events()[3]]) parser.onLine(JSON.stringify(event));
    assert.throws(() => parser.finish(), code('INVALID_OUTPUT'));
  }
  const incomplete = createCodexOutputParser();
  for (const event of events().slice(0, 3)) incomplete.onLine(JSON.stringify(event));
  assert.throws(() => incomplete.finish(), code('INVALID_OUTPUT'));
});
