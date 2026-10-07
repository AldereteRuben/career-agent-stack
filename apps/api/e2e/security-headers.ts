import assert from 'node:assert/strict';
import { securityHeaders } from '@career/domain/security-headers';
import type { Scenario } from './scenarios.js';

// Issue #24: the dashboard and the API send the same browser security headers. Pages get a full
// Content-Security-Policy with a per-request nonce from apps/dashboard/proxy.ts; the API and its errors get the
// framing-only policy. The /api checks prove the API sets its headers itself (the dashboard excludes /api).
const otherHeaders = securityHeaders.filter((header) => header.key !== 'Content-Security-Policy');
const framingOnly = securityHeaders.find((header) => header.key === 'Content-Security-Policy')!.value;

export const securityHeaderScenarios: Scenario[] = [{
  name: 'security-headers-on-pages-api-and-errors',
  async run({ page, context, uiUrl, note }) {
    const fetch = (path: string) => context.request.fetch(`${uiUrl}${path}`, { headers: { Origin: uiUrl }, maxRedirects: 0, maxRetries: 0 });
    const expectOthers = (label: string, headers: Record<string, string>) => {
      for (const { key, value } of otherHeaders) assert.equal(headers[key.toLowerCase()], value, `${label} must send ${key}: ${value}`);
    };

    const nonces: string[] = [];
    for (const path of ['/login', '/searches', '/searches']) {
      const response = await fetch(path);
      const headers = response.headers();
      expectOthers(`page ${path}`, headers);
      const policy = headers['content-security-policy'] ?? '';
      const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
      assert.ok(nonce, `page ${path} must send a CSP with a nonce: ${policy}`);
      nonces.push(nonce);
      const scriptSrc = policy.split(';').map((part) => part.trim()).find((part) => part.startsWith('script-src')) ?? '';
      assert.doesNotMatch(scriptSrc, /'unsafe-inline'/, 'Scripts must not be allowed inline without the nonce');
      for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "default-src 'self'"]) assert.ok(policy.includes(directive), `page ${path} CSP must include ${directive}`);
      // Every script Next.js renders carries this response's nonce.
      const html = await response.text();
      const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
      assert.ok(scripts.length > 0, `page ${path} should render scripts`);
      for (const tag of scripts) assert.ok(tag.includes(`nonce="${nonce}"`), `page ${path} script without the nonce: ${tag.slice(0, 120)}`);
    }
    assert.equal(new Set(nonces).size, nonces.length, 'Each page response must use a fresh nonce');

    for (const [label, path] of [['API response', '/api/v1/session'], ['API error', '/api/v1/does-not-exist']] as const) {
      const headers = (await fetch(path)).headers();
      expectOthers(`${label} (${path})`, headers);
      assert.equal(headers['content-security-policy'], framingOnly, `${label} (${path}) must send the framing-only CSP`);
    }

    // The policy must not break the app: the harness fails on any console error, including CSP violations.
    await page.goto(new URL('/searches', uiUrl).toString());
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    note('Pages send a per-request nonce CSP that every script carries; API responses and errors send the shared headers.');
  },
}];
