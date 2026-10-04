import assert from 'node:assert/strict';
import test from 'node:test';
import { helpHasFlag, normalizeAuthStatus, optionText, parseChoices, parseVersion, presentOverrides, runClaudeProbeCommand, sanitizedEnv } from '../ai/claude-capability-probe.mjs';

test('Claude probe recognizes actual flags rather than mentions inside descriptions', () => {
  const help = '  --safe-mode   Disable customizations.\n                Use --tools for another purpose.\n  -p, --print    Print a response.\n  --tools <tools...>  Choose tools.\n';
  assert.equal(helpHasFlag(help, '--print'), true);
  assert.equal(helpHasFlag(help, '--tools'), true);
  assert.equal(helpHasFlag('  --safe-mode  See --tools here.', '--tools'), false);
  assert.equal(helpHasFlag('  --tools-other  Unrelated.', '--tools'), false);
  assert.equal(optionText(help, '--safe-mode').includes('--print'), false);
});

test('Claude probe treats malformed and undocumented auth shapes as unverified', () => {
  for (const value of ['not json', 'null', '[]', '{}', '{"loggedIn":"yes","authMethod":"claude.ai"}']) {
    assert.equal(normalizeAuthStatus(value, 0).parsed, false);
  }
  const unknown = normalizeAuthStatus('{"loggedIn":true,"authMethod":"new_method"}', 0);
  assert.equal(unknown.method, 'unknown');
  assert.equal(unknown.subscriptionBilling, false);
  const failed = normalizeAuthStatus('{"loggedIn":true,"authMethod":"claude.ai"}', 1);
  assert.equal(failed.loggedIn, false);
});

test('Claude probe removes account identifiers, credentials and filesystem paths', () => {
  const raw = { loggedIn: true, authMethod: 'claude.ai', email: 'private@example.test', orgId: 'private-org', orgName: 'private-name', configDirectory: '/private-path', projectsDirectory: '/private-projects', accessToken: 'private-token', subscriptionType: 'pro' };
  const result = normalizeAuthStatus(JSON.stringify(raw), 0);
  assert.equal(result.loggedIn, true);
  assert.equal(result.identityPresent, true);
  assert.equal(result.organizationPresent, true);
  assert.equal(result.subscriptionBilling, true);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('Claude probe preserves official config context and Windows environment casing without billing overrides', () => {
  const result = sanitizedEnv({ Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', CLAUDE_CONFIG_DIR: '/official-config', ANTHROPIC_API_KEY: 'private-key', CLAUDE_CODE_OAUTH_TOKEN: 'private-token', NODE_OPTIONS: 'unsafe' });
  assert.equal(result.Path, 'C:\\Windows');
  assert.equal(result.SystemRoot, 'C:\\Windows');
  assert.equal(result.CLAUDE_CONFIG_DIR, '/official-config');
  assert.equal(result.ANTHROPIC_API_KEY, undefined);
  assert.equal(result.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(result.NODE_OPTIONS, undefined);
  const detected = presentOverrides({ ANTHROPIC_API_KEY: 'private-key' });
  assert.equal(detected.ANTHROPIC_API_KEY, true);
  assert.equal(JSON.stringify(detected).includes('private-key'), false);
  assert.equal(presentOverrides({ anthropic_api_key: 'private-key' }, 'win32').ANTHROPIC_API_KEY, true);
});

test('Claude diagnostic bounds a hung command without invoking a provider', { timeout: 5000 }, async () => {
  const result = await runClaudeProbeCommand(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 100);'], { timeoutMs: 150 });
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, true);
  assert.equal(result.stdout, '');
});

test('Claude diagnostic handles spawn failure and oversized or failed output without leaking stderr', { timeout: 5000 }, async () => {
  const invalid = await runClaudeProbeCommand(process.execPath, ['bad\0argument']);
  assert.deepEqual(invalid, { exitCode: null, timedOut: false, stdout: '' });
  const failed = await runClaudeProbeCommand(process.execPath, ['-e', 'process.stdout.write("private-output"); process.stderr.write("private-secret"); process.exit(1)']);
  assert.equal(failed.exitCode, 1);
  assert.equal(JSON.stringify(failed).includes('private'), false);
  const oversized = await runClaudeProbeCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(2 * 1024 * 1024));']);
  assert.equal(oversized.exitCode, null);
  assert.equal(oversized.stdout, '');
  assert.equal(oversized.timedOut, false);
});

test('Claude version and choices are only extracted from supported help shapes', () => {
  assert.equal(parseVersion('2.1.289 (Claude Code)\n'), '2.1.289');
  assert.equal(parseVersion('unrelated 2.1.289'), null);
  assert.deepEqual(parseChoices('  --output-format <format>  (choices: "text", "json", "stream-json")', '--output-format'), ['text', 'json', 'stream-json']);
  assert.deepEqual(parseChoices('something else', '--output-format'), []);
});
