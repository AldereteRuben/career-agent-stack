import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const dashboard = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (['node_modules', '.next', 'public', 'dist'].includes(name)) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

// Codes the API sends as `fail(reply, status, 'CODE')` or `reply.code(n).send({ error: 'CODE' })` reach the screen. Each needs a
// message in the shared catalog (lib/i18n.tsx) or its own handling in a component. Codes thrown as errors and mapped elsewhere
// (for example INVALID_JOB_URL becomes JOB_URL_INVALID, and renderer failures arrive as DOCUMENT_RENDER_FAILED) are internal and
// not checked. Codes built from a variable cannot be found by reading the source, so they are outside this check.
test('every error code the API sends to the browser has a message or its own handling', () => {
  const sent = new Set<string>();
  for (const file of sourceFiles(join(dashboard, '../api/src'))) {
    const code = readFileSync(file, 'utf8');
    for (const match of code.matchAll(/\bfail\(\s*\w+\s*,\s*\d+\s*,\s*'([A-Z][A-Z0-9_]+)'/g)) sent.add(match[1]!);
    for (const match of code.matchAll(/\.send\(\{\s*error:\s*'([A-Z][A-Z0-9_]+)'/g)) sent.add(match[1]!);
  }
  assert.ok(sent.size > 40, `expected to find API error codes, found ${sent.size}; has the error pattern changed?`);
  const catalog = new Set([...readFileSync(join(dashboard, 'lib/i18n.tsx'), 'utf8').matchAll(/\b([A-Z][A-Z0-9_]+):\s*'/g)].map((match) => match[1]!));
  const components = sourceFiles(dashboard).filter((file) => !file.endsWith('lib/i18n.tsx')).map((file) => readFileSync(file, 'utf8')).join('\n');
  const unhandled = [...sent].filter((code) => !catalog.has(code) && !components.includes(code)).sort();
  assert.deepEqual(unhandled, [], 'add a Spanish and English message in lib/i18n.tsx, or handle the code in the component that shows it');
});
