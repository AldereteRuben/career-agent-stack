import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notificationText } from '../src/desktop-notification-copy.js';

test('desktop alerts include only the count and use the selected language', () => {
  assert.equal(notificationText('es', 3), 'Nuevas ofertas encontradas: 3');
  assert.equal(notificationText('en', 1), 'New jobs found: 1');
  assert.doesNotMatch(notificationText('en', 2), /company|salary|https?:\/\//i);
});
