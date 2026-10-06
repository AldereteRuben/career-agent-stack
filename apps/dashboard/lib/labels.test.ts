import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applicationEvents, factKinds, humanizeKey } from './labels';

const dashboard = join(dirname(fileURLToPath(import.meta.url)), '..');

// The app writes sentence case ("Candidatura creada"). `text-transform: capitalize` would turn every word into a capital
// ("Candidatura Creada"), including text the user or a form wrote ("Are You Authorized To Work In Spain?").
test('no style capitalizes every word', () => {
  const css = readFileSync(join(dashboard, 'app/globals.css'), 'utf8');
  assert.equal(css.match(/text-transform:\s*capitalize/g)?.length ?? 0, 0, 'remove text-transform: capitalize; write the capital letter in the text instead');
});

test('application history and fact kind labels start with a capital letter in both languages', () => {
  for (const [name, map] of Object.entries({ applicationEvents, factKinds })) {
    for (const [code, text] of Object.entries(map)) {
      for (const language of ['es', 'en'] as const) {
        assert.match(text[language], /^\p{Lu}/u, `${name}.${code} (${language}) must start with a capital letter: "${text[language]}"`);
      }
    }
  }
});

test('a saved answer without question text is named with only its first letter capitalized', () => {
  assert.equal(humanizeKey('notice.period'), 'Notice period');
  assert.equal(humanizeKey('work.authorization_status'), 'Work authorization status');
});
