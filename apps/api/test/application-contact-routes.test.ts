import assert from 'node:assert/strict';
import { test } from 'node:test';

const originalDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL ??= 'postgresql://fictional@127.0.0.1:1/fictional';
const { normalizeProfessionalProfileUrl } = await import('../src/application-contact-routes.js');
if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
else process.env.DATABASE_URL = originalDatabaseUrl;

test('professional profile URLs are normalized without credentials or fragments', () => {
  assert.equal(normalizeProfessionalProfileUrl(' HTTPS://Example.COM/profile/ '), 'https://example.com/profile');
  assert.equal(normalizeProfessionalProfileUrl('https://example.com/profile#contact'), 'https://example.com/profile');
  assert.equal(normalizeProfessionalProfileUrl(''), null);
  assert.equal(normalizeProfessionalProfileUrl(null), null);
});

test('professional profile URLs reject malformed schemes and embedded credentials', () => {
  assert.throws(() => normalizeProfessionalProfileUrl('javascript:alert(1)'), /INVALID_PROFILE_URL/);
  assert.throws(() => normalizeProfessionalProfileUrl('https://person:secret@example.com/profile'), /INVALID_PROFILE_URL/);
  assert.throws(() => normalizeProfessionalProfileUrl('not a URL'), /INVALID_PROFILE_URL/);
});
