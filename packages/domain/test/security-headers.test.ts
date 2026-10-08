import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentSecurityPolicy, securityHeaders } from '../src/security-headers.js';

const nonce = Buffer.from('7f1c2e9a-4b6d-4c8e-9f0a-1b2c3d4e5f60').toString('base64');
const directives = (policy: string) => new Map(policy.split('; ').map((part) => { const [name, ...values] = part.split(' '); return [name!, values.join(' ')]; }));

test('production pages allow only nonce-carrying scripts and same-origin resources', () => {
  const policy = directives(contentSecurityPolicy(nonce));
  assert.equal(policy.get('script-src'), `'self' 'nonce-${nonce}' 'strict-dynamic'`);
  assert.equal(policy.get('style-src'), `'self' 'nonce-${nonce}'`);
  assert.equal(policy.get('default-src'), "'self'");
  assert.equal(policy.get('connect-src'), "'self'");
  assert.equal(policy.get('worker-src'), "'self' blob:");
  assert.equal(policy.get('object-src'), "'none'");
  assert.equal(policy.get('base-uri'), "'none'");
  assert.equal(policy.get('frame-ancestors'), "'none'");
  assert.ok(![...policy.values()].some((value) => value.includes('unsafe-eval')), 'No eval in production');
});

test('development adds only what Next.js needs for debugging and CSS reloading', () => {
  const policy = directives(contentSecurityPolicy(nonce, { development: true }));
  assert.equal(policy.get('script-src'), `'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`);
  assert.equal(policy.get('style-src'), "'self' 'unsafe-inline'");
  assert.doesNotMatch(policy.get('script-src')!, /'unsafe-inline'/);
});

test('a missing or malformed nonce is refused instead of producing a weak policy', () => {
  for (const bad of ['', 'short', "abc'; script-src *", 'x'.repeat(15)]) assert.throws(() => contentSecurityPolicy(bad), /nonce/);
});

test('API and asset headers keep forbidding frames', () => {
  assert.equal(securityHeaders.find((header) => header.key === 'Content-Security-Policy')?.value, "frame-ancestors 'none'");
  assert.equal(securityHeaders.find((header) => header.key === 'X-Frame-Options')?.value, 'DENY');
});
