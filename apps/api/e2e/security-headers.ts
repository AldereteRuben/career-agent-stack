import assert from 'node:assert/strict';
import { securityHeaders } from '@career/domain/security-headers';
import type { Scenario } from './scenarios.js';

// Issue #24: the dashboard and the API send the same browser security headers. The dashboard excludes /api from its
// own header rule, so the /api checks prove the API adds them itself, including on error responses.
export const securityHeaderScenarios: Scenario[] = [{
  name: 'security-headers-on-pages-api-and-errors',
  async run({ context, uiUrl, note }) {
    const targets = [
      ['dashboard page', '/login'],
      ['dashboard page with a session', '/searches'],
      ['API response', '/api/v1/session'],
      ['API error', '/api/v1/does-not-exist'],
    ] as const;
    for (const [label, path] of targets) {
      const response = await context.request.fetch(`${uiUrl}${path}`, { headers: { Origin: uiUrl }, maxRedirects: 0, maxRetries: 0 });
      const headers = response.headers();
      for (const { key, value } of securityHeaders) {
        assert.equal(headers[key.toLowerCase()], value, `${label} (${path}, ${response.status()}) must send ${key}: ${value}`);
      }
    }
    note('Pages, API responses and API errors send the shared security headers once, with the expected values.');
  },
}];
