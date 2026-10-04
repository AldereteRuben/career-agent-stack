import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCodexAccount, normalizeCodexUsage, inspectCodexAccount } from '../src/ai/codex-account.js';
const salt = 'synthetic-server-key'.repeat(3);
const now = Date.parse('2026-10-04T00:00:00Z');
const account = { requiresOpenaiAuth: true, account: { type: 'chatgpt', email: 'alex@example.test', planType: 'plus' } };
test('only an identifiable ChatGPT account can be selected; raw identity is not returned', () => {
  const result = normalizeCodexAccount(account, salt, now);
  assert.equal(result.status, 'SIGNED_IN');
  assert.equal(result.maskedIdentity, 'a***@example.test');
  assert.equal(result.accountFingerprint?.length, 64);
  assert.ok(!JSON.stringify(result).includes('alex@example.test'));
  assert.notEqual(result.accountFingerprint, normalizeCodexAccount({ ...account, account: { ...account.account, email: 'other@example.test' } }, salt, now).accountFingerprint);
  assert.notEqual(result.accountFingerprint, normalizeCodexAccount(account, 'other-key'.repeat(8), now).accountFingerprint);
});
test('missing identities, malformed accounts and API billing fail closed', () => {
  for (const raw of [{}, null, { account: {} }, { ...account, account: { type: 'chatgpt', email: null } }, { ...account, requiresOpenaiAuth: false }]) assert.notEqual(normalizeCodexAccount(raw, salt, now).status, 'SIGNED_IN');
  assert.equal(normalizeCodexAccount({ account: null }, salt, now).status, 'SIGNED_OUT');
  assert.equal(normalizeCodexAccount({ account: { type: 'apiKey' } }, salt, now).billing, 'SEPARATE_API');
  assert.equal(normalizeCodexAccount(account, 'short', now).status, 'UNAVAILABLE');
});
test('quotas prefer Codex bucket, clamp values and preserve unavailable cost', () => {
  const result = normalizeCodexUsage({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 105, resetsAt: now / 1000 + 60 }, secondary: { usedPercent: 20 } } }, rateLimits: { primary: { usedPercent: 1 } } }, now);
  assert.equal(result.availability, 'KNOWN');
  assert.deepEqual(result.windows.map(w => w.remainingPercent), [0, 80]);
  assert.equal(result.costUsd, null); assert.equal(result.tokens.input, null);
  assert.equal(normalizeCodexUsage({ rateLimitsByLimitId: { another: {} } }, now).availability, 'UNAVAILABLE');
  assert.equal(normalizeCodexUsage({}, now).availability, 'UNAVAILABLE');
});
test('inspection with missing binary has no account or inference side effects', async () => {
  const result = await inspectCodexAccount(salt, undefined, { resolveBinary: async () => null, now: () => now });
  assert.equal(result.status, 'NOT_INSTALLED');
});
test('unsupported binary versions do not query the account', async () => {
  let rpcCalled = false;
  const result = await inspectCodexAccount(salt, undefined, {
    resolveBinary: async () => process.execPath, now: () => now,
    run: async () => ({ stdout: 'codex-cli 0.999.0\n', exitCode: 0 }),
    rpc: async () => { rpcCalled = true; throw new Error('unexpected'); },
  });
  assert.equal(result.status, 'UNSUPPORTED'); assert.equal(rpcCalled, false);
});
