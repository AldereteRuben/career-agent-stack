import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { initialTheme, themeAttribute } from './theme';

const dashboard = join(dirname(fileURLToPath(import.meta.url)), '..');
const globals = readFileSync(join(dashboard, 'app/globals.css'), 'utf8');
const hex = /#[0-9a-fA-F]{3,8}\b/gu;

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? cssFiles(path) : entry.name.endsWith('.css') ? [path] : [];
  });
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//gu, '');

function tokenNames(block: string) {
  return new Set([...block.matchAll(/^\s*(--[a-z0-9-]+):/gmu)].map((match) => match[1]!));
}

const lightBlock = globals.slice(globals.indexOf(':root {'), globals.indexOf('\n}\n', globals.indexOf(':root {')));
const darkStart = globals.indexOf('@media (prefers-color-scheme: dark)');
const darkBlock = globals.slice(darkStart, globals.indexOf('\n}\n', darkStart));
const forcedStart = globals.indexOf(':root[data-theme="dark"] {');
const forcedBlock = globals.slice(forcedStart, globals.indexOf('\n}\n', forcedStart));
const declarations = (block: string) => [...block.matchAll(/^\s*((?:--[a-z0-9-]+|color-scheme):\s*[^;]+);/gmu)].map((match) => match[1]!);
const colourToken = (name: string, value: string) => /#[0-9a-fA-F]{3,8}\b|rgba?\(/u.test(value) && name !== '--shadow';

// Colours live in the tokens at the top of globals.css so the dark theme can redefine them in one place.
test('stylesheets use colour tokens instead of hex values', () => {
  for (const file of cssFiles(join(dashboard, 'app')).concat(cssFiles(join(dashboard, 'components')))) {
    // Comments mention issue numbers such as #109.
    let css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
    if (file.endsWith('globals.css')) css = css.replace(stripComments(lightBlock), '').replace(stripComments(darkBlock), '').replace(stripComments(forcedBlock), '');
    // The sign-in screen is deliberately dark navy in both themes.
    const found = (css.match(hex) ?? []).filter((value) => value.toLowerCase() !== '#25374a');
    assert.deepEqual(found, [], `${file.slice(dashboard.length + 1)} uses a hex colour; add or reuse a token in globals.css`);
  }
});

test('every colour token has a dark-theme value', () => {
  assert.ok(darkStart > 0, 'globals.css has a prefers-color-scheme: dark block');
  const values = new Map([...lightBlock.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gmu)].map((match) => [match[1]!, match[2]!]));
  const dark = tokenNames(darkBlock);
  const missing = [...values].filter(([name, value]) => colourToken(name, value) && !dark.has(name)).map(([name]) => name);
  assert.deepEqual(missing, [], 'colour tokens without a dark value');
  assert.match(darkBlock, /color-scheme:\s*dark/u, 'the dark theme also switches native controls and scrollbars');
});

// Settings can force a theme with data-theme on <html>; the forced dark block must match the system one.
test('the dark theme chosen in Settings matches the system dark theme', () => {
  assert.ok(forcedStart > 0, 'globals.css has a :root[data-theme="dark"] block');
  assert.match(darkBlock, /:root:not\(\[data-theme="light"\]\)/u, 'choosing the light theme overrides a dark system setting');
  assert.deepEqual(declarations(forcedBlock), declarations(darkBlock));
});

test('the theme cookie only accepts light or dark', () => {
  assert.equal(initialTheme('dark'), 'dark');
  assert.equal(initialTheme('light'), 'light');
  for (const value of [undefined, '', 'system', 'DARK', 'blue']) assert.equal(initialTheme(value), 'system');
  assert.equal(themeAttribute('system'), undefined);
  assert.equal(themeAttribute('dark'), 'dark');
});
