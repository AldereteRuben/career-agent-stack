import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canGoBackInApp, localeWithoutProvider, statusPageText } from './status-pages';

test('every text of the not-found and error pages exists in both languages', () => {
  for (const [page, texts] of Object.entries(statusPageText)) {
    for (const [key, text] of Object.entries(texts)) {
      assert.ok(text.es.trim() && text.en.trim(), `${page}.${key} needs Spanish and English`);
    }
  }
  assert.notEqual(statusPageText.notFound.title.es, statusPageText.notFound.title.en);
  assert.notEqual(statusPageText.error.retry.es, statusPageText.error.retry.en);
});

test('the language without the provider follows the cookie, then the browser', () => {
  assert.equal(localeWithoutProvider('theme=dark; locale=en', 'es-MX'), 'en');
  assert.equal(localeWithoutProvider('locale=es', 'en-US'), 'es');
  assert.equal(localeWithoutProvider('', 'es-ES'), 'es');
  assert.equal(localeWithoutProvider('', 'en-GB'), 'en');
  assert.equal(localeWithoutProvider('locale=fr', 'fr-FR'), 'en', 'an unknown cookie value is ignored');
  assert.equal(localeWithoutProvider('mylocale=es', 'en-US'), 'en', 'a cookie that only ends in locale is not ours');
});

test('going back stays inside the app', () => {
  const origin = 'http://127.0.0.1:3000';
  const env = { origin, historyLength: 3, referrer: '' };
  assert.equal(canGoBackInApp({ ...env, historyLength: 1, previousEntryUrl: `${origin}/start` }), false, 'nothing to go back to');
  assert.equal(canGoBackInApp({ ...env, previousEntryUrl: `${origin}/start` }), true, 'the previous entry is an app page');
  assert.equal(canGoBackInApp({ ...env, previousEntryUrl: 'https://other.example/page' }), false, 'the previous entry is another site');
  assert.equal(canGoBackInApp({ ...env, previousEntryUrl: null }), false, 'no previous entry');
  assert.equal(canGoBackInApp({ ...env, previousEntryUrl: 'not a url' }), false);
  assert.equal(canGoBackInApp({ ...env, referrer: `${origin}/jobs` }), true, 'without the Navigation API, the referrer counts');
  assert.equal(canGoBackInApp({ ...env, referrer: 'https://other.example/' }), false);
  assert.equal(canGoBackInApp({ ...env, referrer: '' }), false);
});
