import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followUpEmailText } from './application-follow-up-draft.js';

test('follow-up email copy includes the localized subject and editable body', () => {
  assert.equal(followUpEmailText('es', 'Seguimiento', 'Hola, ¿hay novedades?'), 'Asunto: Seguimiento\n\nHola, ¿hay novedades?');
  assert.equal(followUpEmailText('en', 'Checking in', 'Hello, any updates?'), 'Subject: Checking in\n\nHello, any updates?');
});
