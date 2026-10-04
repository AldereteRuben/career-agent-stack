import assert from 'node:assert/strict';
import { test } from 'node:test';
import { disconnectRestoredAi } from '../lib/ai-restore.mjs';

test('legacy backups without AI tables perform no writes', async () => {
  const writes = [];
  const result = await disconnectRestoredAi({ query: async sql => { writes.push(sql); return { rowCount: 0 }; } }, async () => false);
  assert.equal(writes.length, 0);
  assert.deepEqual(result, { connections: 0, consents: 0, policies: 0, runs: 0 });
});
test('restores revoke and fence execution while retaining historical rows and spent budgets', async () => {
  const writes = [];
  const result = await disconnectRestoredAi({ query: async sql => { writes.push(sql); return { rowCount: 2 }; } }, async () => true);
  assert.equal(result.connections, 2); assert.equal(result.runs, 2);
  assert.ok(writes.some(sql => sql.includes('official_context_ref=NULL')));
  assert.ok(writes.some(sql => sql.includes('revoked_at=now()')));
  assert.ok(writes.some(sql => sql.includes('paused=true')));
  assert.ok(writes.some(sql => sql.includes("'INTERRUPTED'")));
  assert.ok(writes.some(sql => sql.includes('lease_token=NULL')));
  assert.ok(writes.some(sql => sql.includes('automatic_reserved=0')));
  assert.ok(writes.every(sql => !/delete|truncate|automatic_started=|document_versions|ai_artifacts/i.test(sql)));
});
test('sanitization failures propagate so restore transaction cannot commit a live grant', async () => {
  await assert.rejects(disconnectRestoredAi({ query: async () => { throw new Error('synthetic'); } }, async () => true), /synthetic/);
});
