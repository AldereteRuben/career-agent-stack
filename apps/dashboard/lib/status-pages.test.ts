import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localeWithoutProvider, statusPageText } from './status-pages';

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
