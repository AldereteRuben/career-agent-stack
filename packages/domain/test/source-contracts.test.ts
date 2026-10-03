import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardSchema } from '../src/contracts.js';
const base = { tenant: 'example', companyName: 'Example', companyDomain: 'example.com', careersUrl: 'https://example.com/careers', associationStatus: 'UNVERIFIED', permissionStatus: 'UNKNOWN', enabled: false };
test('boards accept only supported provider/region combinations', () => {
  for (const provider of ['greenhouse', 'lever', 'ashby']) {
    assert.equal(boardSchema.safeParse({ ...base, provider, region: 'global' }).success, true);
    assert.equal(boardSchema.safeParse({ ...base, provider, region: 'eu' }).success, provider === 'lever');
    assert.equal(boardSchema.safeParse({ ...base, provider, region: 'apac' }).success, false);
  }
});
test('board tenants cannot contain paths or query fragments', () => {
  for (const tenant of ['../example', 'example/jobs', 'example?x=y', '']) assert.equal(boardSchema.safeParse({ ...base, provider: 'lever', region: 'global', tenant }).success, false);
});
