import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Panels of the application detail are siblings, so each one needs its own key. Three of them once shared
// key={selected.id}; React then duplicated or dropped panels. A production build does not log that warning,
// so the end-to-end suite in CI cannot be relied on to notice.
test('the panels of the application detail do not share a key', () => {
  const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../app/applications/page.tsx'), 'utf8');
  const keys = [...page.matchAll(/<(\w+) key=\{(`[^`]*`|[\w.]+)\}/g)].map((match) => match[2]!);
  const detail = keys.filter((key) => key.includes('selected.id'));
  assert.equal(new Set(detail).size, detail.length, `duplicate keys: ${detail.join(' | ')}`);
});
