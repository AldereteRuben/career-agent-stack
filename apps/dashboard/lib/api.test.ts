import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from './api.js';

test('api accepts successful 204 responses without trying to parse JSON', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 204 });
  try {
    assert.equal(await api<void>('/empty', { method: 'DELETE' }), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
