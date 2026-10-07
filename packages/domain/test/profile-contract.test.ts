import assert from 'node:assert/strict';
import { test } from 'node:test';
import { profileUpdateSchema } from '../src/contracts.js';
import { readIdentity, readPreferences } from '../src/profile.js';

const valid = (profile: unknown) => profileUpdateSchema.safeParse({ profile }).success;

test('the profile the dashboard saves is accepted and read back unchanged', () => {
  const profile = { identity: { fullName: 'Alex Example', email: 'alex@example.test', country: 'ES' }, preferences: { targetTitles: ['QA Engineer'], workModes: ['remote'] } };
  const parsed = profileUpdateSchema.parse({ profile, locale: 'es', expectedRevision: 2 });
  assert.deepEqual(parsed.profile, profile);
  assert.deepEqual(readIdentity(parsed.profile), { fullName: 'Alex Example', email: 'alex@example.test', country: 'ES' });
  assert.deepEqual(readPreferences(parsed.profile), { targetTitles: ['QA Engineer'], workModes: ['remote'] });
});

test('empty and partial profiles stay valid (first run and partial edits)', () => {
  assert.equal(valid({}), true);
  assert.equal(valid({ identity: { fullName: 'Alex Example', email: 'alex@example.test' } }), true);
  assert.equal(valid({ preferences: { targetTitles: [] } }), true);
});

test('keys the dashboard does not know are kept, so older profiles can still be saved', () => {
  const profile = { locale: 'en-GB', identity: { fullName: 'Alex Example', legacyNote: 'kept' }, preferences: { workModes: ['hybrid'], extra: 1 }, futureSection: { enabled: true } };
  assert.deepEqual(profileUpdateSchema.parse({ profile }).profile, profile);
});

test('identity and preference fields at the top level are rejected with their path (issue #75)', () => {
  const result = profileUpdateSchema.safeParse({ profile: { fullName: 'Ana', email: 'ana@example.test' } });
  assert.equal(result.success, false);
  assert.deepEqual(result.error?.issues.map((issue) => issue.path.join('.')).sort(), ['profile.email', 'profile.fullName']);
  for (const key of ['country', 'targetTitles', 'workModes']) assert.equal(valid({ identity: {}, [key]: key === 'country' ? 'ES' : [] }), false, `${key} at the top level`);
});

test('known fields must have their documented types', () => {
  assert.equal(valid({ identity: 'Ana' }), false);
  assert.equal(valid({ identity: null }), false);
  assert.equal(valid({ identity: { fullName: 42 } }), false);
  assert.equal(valid({ identity: { email: null } }), false);
  assert.equal(valid({ preferences: [] }), false);
  assert.equal(valid({ preferences: { targetTitles: 'QA Engineer' } }), false);
  assert.equal(valid({ preferences: { workModes: ['remote', 3] } }), false);
  assert.equal(valid([]), false);
  assert.equal(valid(null), false);
});
