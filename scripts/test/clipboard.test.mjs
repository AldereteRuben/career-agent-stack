import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clipboardTools, missingClipboardAdvice } from '../lib/clipboard.mjs';

const installed = (...tools) => (tool) => tools.includes(tool);

test('macOS always uses pbcopy and pbpaste', () => {
  assert.deepEqual(clipboardTools({ platform: 'darwin', env: {}, has: installed() }), { copy: ['pbcopy', []], paste: ['pbpaste', []] });
});

test('a Wayland session prefers wl-clipboard', () => {
  const tools = clipboardTools({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, has: installed('wl-copy', 'xclip') });
  assert.equal(tools.copy[0], 'wl-copy');
  assert.deepEqual(tools.paste, ['wl-paste', ['-n']]);
});

test('xclip serves X11 and Wayland sessions without wl-clipboard', () => {
  assert.equal(clipboardTools({ platform: 'linux', env: {}, has: installed('xclip') }).copy[0], 'xclip');
  assert.equal(clipboardTools({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, has: installed('xclip') }).copy[0], 'xclip');
});

test('wl-copy is ignored outside a Wayland session', () => {
  assert.equal(clipboardTools({ platform: 'linux', env: {}, has: installed('wl-copy') }), null);
});

test('no clipboard tool gives null', () => {
  assert.equal(clipboardTools({ platform: 'linux', env: {}, has: installed() }), null);
});

test('missing-tool advice names the token file and, on Linux, the package to install', () => {
  const wayland = missingClipboardAdvice({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, tokenPath: 'data/setup-token' });
  assert.match(wayland.en, /data\/setup-token/);
  assert.match(wayland.en, /sudo apt install wl-clipboard/);
  assert.match(wayland.es, /data\/setup-token/);
  assert.match(wayland.es, /instala wl-clipboard/);
  assert.match(missingClipboardAdvice({ platform: 'linux', env: {}, tokenPath: 't' }).en, /install xclip/);
});

test('missing-tool advice offers no package command on other systems', () => {
  const advice = missingClipboardAdvice({ platform: 'win32', env: {}, tokenPath: 'data\\setup-token' });
  assert.match(advice.en, /Open data\\setup-token/);
  assert.doesNotMatch(advice.en + advice.es, /apt/);
});
