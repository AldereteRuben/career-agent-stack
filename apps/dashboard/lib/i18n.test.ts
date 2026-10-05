import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { localizedError, translate } from './i18n';

const dashboard = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(dashboard, 'lib/i18n.tsx'), 'utf8');

// Symbols, units and the brand name read the same in both languages.
const sameInBothLanguages = new Set(['＋', '·', '⌑', '⌖', '/100', 'Career Stack']);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    if (['node_modules', '.next', 'public'].includes(name)) return [];
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

// Calls with a single text argument use the shared catalog. Calls with a second text argument (t(spanish, english))
// carry their own translation and are not checked here. A missing entry silently shows the source text.
const catalogCalls = /(?<![\w.])t\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`$]*)`)\s*[,)](?!\s*['"`])/g;

test('every catalog text used in the dashboard has a translation', () => {
  const missing = new Set<string>();
  let checked = 0;
  for (const file of sourceFiles(dashboard)) {
    for (const match of readFileSync(file, 'utf8').matchAll(catalogCalls)) {
      const text = (match[1] ?? match[2] ?? match[3]!).replace(/\\'/g, "'");
      const normalized = text.trim().replace(/\s+/g, ' ');
      checked++;
      if (sameInBothLanguages.has(normalized)) continue;
      if (translate('en', text).trim() === normalized && translate('es', text).trim() === normalized) missing.add(`${normalized}  (${file.slice(dashboard.length + 1)})`);
    }
  }
  assert.ok(checked > 30, `expected to find catalog calls, found ${checked}; has the t() pattern changed?`);
  assert.deepEqual([...missing], [], 'add these to the English or Spanish catalog in lib/i18n.tsx');
});

test('every localized error code has both a Spanish and an English message', () => {
  const block = (name: string) => {
    const start = source.indexOf(`const ${name}: Record<string, string> = {`);
    assert.ok(start >= 0, `could not find the ${name} error messages`);
    const body = source.slice(start, source.indexOf('\n  };', start));
    return new Set([...body.matchAll(/\b([A-Z][A-Z0-9_]+):\s*'/g)].map((match) => match[1]!));
  };
  const spanish = block('spanish');
  const english = block('english');
  assert.ok(spanish.size > 50, 'expected the Spanish error catalog');
  assert.deepEqual([...spanish].filter((code) => !english.has(code)), [], 'codes with a Spanish message but no English one');
  assert.deepEqual([...english].filter((code) => !spanish.has(code)), [], 'codes with an English message but no Spanish one');
  const generic = { es: localizedError('NO_SUCH_CODE', 'es'), en: localizedError('NO_SUCH_CODE', 'en') };
  for (const code of spanish) {
    assert.notEqual(localizedError(code, 'es'), generic.es, `${code} falls back to the generic Spanish message`);
    assert.notEqual(localizedError(code, 'en'), generic.en, `${code} falls back to the generic English message`);
  }
});
