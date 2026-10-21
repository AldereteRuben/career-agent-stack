import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrubExport } from '../src/export-scrub.js';

test('workspace export keeps interview sessions and removes credential fields recursively', () => {
  const sanitized = scrubExport({
    interviewPreparationSessions: [{ id: 'session-id', planId: 'plan-id', status: 'COMPLETED' }],
    interviewPreparationTurns: [{ id: 'turn-id', sessionId: 'session-id', answer: 'Fictional answer' }],
    assistant: { accessToken: 'secret-token', sessionSecret: 'secret-session', api_key: 'secret-api-key', 'X-API-Key': 'secret-header-key', cookie: 'secret-cookie', credential: 'secret-credential' },
  });

  assert.deepEqual(sanitized, {
    interviewPreparationSessions: [{ id: 'session-id', planId: 'plan-id', status: 'COMPLETED' }],
    interviewPreparationTurns: [{ id: 'turn-id', sessionId: 'session-id', answer: 'Fictional answer' }],
    assistant: {},
  });
});

test('workspace export retains ordinary keys ending in “key”', () => {
  assert.deepEqual(scrubExport({ idempotencyKey: 'fixture-id', monkey: 'fixture-value', apiKey: 'secret' }), {
    idempotencyKey: 'fixture-id', monkey: 'fixture-value',
  });
});
