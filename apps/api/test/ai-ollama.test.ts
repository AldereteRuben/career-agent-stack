import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiSourceSnapshot } from '@career/domain';
import { executeOllama, isOllamaCloudModel, listOllamaModels, OllamaExecutionError, validateOllamaBaseUrl } from '../src/ai/ollama.js';

const h = (char: string) => char.repeat(64);
const snapshot = (locale: 'es' | 'en' = 'en'): AiSourceSnapshot => ({
  schemaVersion: 1, snapshotId: 'snapshot-ollama-1', workspaceId: 'workspace-ollama-1', operation: 'JOB_ANALYSIS', locale,
  snapshotHash: h('a'), searchRequest: null,
  job: { jobId: 'job-ollama-1', canonicalIdentity: 'greenhouse:example:1', contentHash: h('b'), normalizedText: locale === 'es'
    ? 'Diseña sistemas de producto. Se requieren cinco años de experiencia.'
    : 'Design product systems. Five years of experience required.' },
  question: null, facts: [], profileRevision: 1, identityFingerprint: h('c'),
});
const baseUrl = 'http://127.0.0.1:11434';
const model = 'qwen2.5:latest';
const answer = (locale: 'es' | 'en') => JSON.stringify({ schemaVersion: 1, operation: 'JOB_ANALYSIS', locale,
  summary: [{ text: locale === 'es' ? 'Diseño de sistemas.' : 'Product systems design.', citations: [{ quote: locale === 'es' ? 'Diseña sistemas de producto' : 'Design product systems' }] }],
  requirements: [{ text: locale === 'es' ? 'Cinco años de experiencia.' : 'Five years of experience.', level: 'REQUIRED', citations: [{ quote: locale === 'es' ? 'cinco años de experiencia' : 'Five years of experience required' }] }],
  personalMatches: [], gaps: [], warnings: [],
});
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('Ollama URL accepts only the configured loopback origin', () => {
  assert.equal(validateOllamaBaseUrl(baseUrl), baseUrl);
  assert.equal(validateOllamaBaseUrl('http://[::1]:11434'), 'http://[::1]:11434');
  for (const value of ['http://localhost:11434', 'http://192.168.1.8:11434', 'https://127.0.0.1:11434', 'http://127.0.0.1', 'http://127.0.0.1:11434/api', 'http://127.0.0.1:11434?next=x']) {
    assert.throws(() => validateOllamaBaseUrl(value), /OLLAMA_URL_INVALID/u);
  }
});

test('model discovery uses the fixed local tags route and excludes cloud models', async () => {
  let requested = '';
  const models = await listOllamaModels(baseUrl, { fetch: async (input, init) => {
    requested = String(input);
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'error');
    return response({ models: [{ name: 'qwen2.5:latest', size: 42 }, { name: 'gpt-oss:cloud' }, { name: 'gpt-oss:120b-cloud' }, { name: '../bad' }, { name: 'llama3.2' }] });
  } });
  assert.equal(requested, `${baseUrl}/api/tags`);
  assert.deepEqual(models.map(item => item.name), ['llama3.2', 'qwen2.5:latest']);
  assert.equal(models[1]?.size, 42);
});

test('chat adapter sends a bounded, non-streaming structured request and validates ES/EN cited output', async () => {
  for (const locale of ['es', 'en'] as const) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await executeOllama(snapshot(locale), h('d'), baseUrl, model, undefined, { fetch: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return response({ model, done: true, prompt_eval_count: 13, eval_count: 8, message: { content: answer(locale) } });
    } });
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.url, `${baseUrl}/api/chat`);
    assert.equal(call.init?.redirect, 'error');
    const payload = JSON.parse(String(call.init?.body)) as { model: string; stream: boolean; format: unknown; messages: Array<{ role: string; content: string }> };
    assert.equal(payload.model, model);
    assert.equal(payload.stream, false);
    assert.ok(payload.format);
    assert.deepEqual(payload.messages.map(item => item.role), ['system', 'user']);
    assert.ok(payload.messages[0]?.content.includes(locale === 'es' ? 'Spanish' : 'English'));
    assert.equal(result.output.operation, 'JOB_ANALYSIS');
    assert.deepEqual(result.usage, { inputTokens: 13, outputTokens: 8 });
    assert.equal(result.account.accountFingerprint, h('d'));
  }
});

test('unavailable, cloud, and malformed provider responses never leak server details', async () => {
  await assert.rejects(() => executeOllama(snapshot(), h('d'), baseUrl, 'gpt-oss:cloud', undefined, { fetch: async () => { throw new Error('must not call'); } }),
    error => error instanceof OllamaExecutionError && error.code === 'NOT_CONNECTED' && error.dispatched === 'NO');
  assert.equal(isOllamaCloudModel('gpt-oss:120b-cloud'), true);
  assert.equal(isOllamaCloudModel('qwen2.5:latest'), false);
  await assert.rejects(() => executeOllama(snapshot(), h('d'), baseUrl, 'gpt-oss:120b-cloud', undefined, { fetch: async () => { throw new Error('must not call'); } }),
    error => error instanceof OllamaExecutionError && error.code === 'NOT_CONNECTED' && error.dispatched === 'NO');
  await assert.rejects(() => listOllamaModels(baseUrl, { fetch: async () => response({ error: 'private server path /home/user' }, 500) }),
    /OLLAMA_UNAVAILABLE/u);
  await assert.rejects(() => executeOllama(snapshot(), h('d'), baseUrl, model, undefined, { fetch: async () => response({ model, done: true, message: { content: '{broken' } }) }),
    error => error instanceof OllamaExecutionError && error.code === 'INVALID_OUTPUT' && error.dispatched === 'YES');
});
