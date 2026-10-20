import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApplicationFollowUpTemplate } from '../src/application-follow-up-template.js';

test('English follow-up template uses only supplied application details and fixed wording', () => {
  const draft = buildApplicationFollowUpTemplate({
    language: 'en', company: 'MILES Mobility', role: 'Product Manager', applicationDate: '2026-10-14', candidateName: 'Ruben Alderete',
  });
  assert.equal(draft.subject, 'Following up on my application: Product Manager at MILES Mobility');
  assert.match(draft.body, /^Hello Ruben Alderete,/);
  assert.match(draft.body, /my application for the Product Manager position at MILES Mobility/);
  assert.match(draft.body, /I submitted it on 14 October 2026\./);
  assert.doesNotMatch(draft.body, /interview|offer|excited|experience|available/u);
  assert.equal(draft.language, 'en');
});

test('Spanish template supports sparse context without inventing a contact or candidate name', () => {
  const draft = buildApplicationFollowUpTemplate({ language: 'es' });
  assert.equal(draft.subject, 'Seguimiento de mi candidatura');
  assert.match(draft.body, /^Hola,/);
  assert.match(draft.body, /novedad sobre mi candidatura\./);
  assert.doesNotMatch(draft.body, /\[|\]|empresa|puesto|entrevista|oferta/u);
  assert.equal(draft.language, 'es');
});

test('follow-up template normalizes line breaks in supplied fields and validates application dates', () => {
  const draft = buildApplicationFollowUpTemplate({ language: 'es', company: 'Acme\nHiring Team', role: 'Engineer\tII' });
  assert.equal(draft.subject, 'Seguimiento de mi candidatura: Engineer II en Acme Hiring Team');
  assert.doesNotMatch(draft.body, /\r|\t/u);
  assert.throws(() => buildApplicationFollowUpTemplate({ language: 'en', applicationDate: '2026-02-30' }), { message: 'INVALID_APPLICATION_DATE' });
});
