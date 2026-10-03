import assert from 'node:assert/strict';
import { test } from 'node:test';
import { printedContentCurrent, type CurrentSource } from '../src/documents.js';
import { entryStatement, printedStatement, type StructuredEntry } from '../src/entries.js';
import { printedResumeIdentity } from '../src/profile.js';

// Fictional fixtures only.
const entry: StructuredEntry = { type: 'employment', title: 'Designer', organization: 'Example', startMonth: '2020-01', current: true, description: 'Texto original.', locale: 'es' };
const plain = { kind: 'achievement', statement: 'Fictional achievement' };
const structured = { kind: 'experience', statement: entryStatement(entry), details: entry };
const identity = { fullName: 'Fictional Candidate', email: 'candidate@example.test' };
const check = (overrides: Partial<Parameters<typeof printedContentCurrent>[0]> = {}) => printedContentCurrent({
  claims: [{ text: plain.statement, sourceFactIds: ['old-a'] }, { text: printedStatement(structured, 'en'), sourceFactIds: ['old-b'] }],
  language: 'en', sameRevision: false, basisIdentity: identity, currentIdentity: { ...identity },
  currentSource: (id) => ({ 'old-a': { fact: plain, direct: false }, 'old-b': { fact: structured, direct: false } } as Record<string, CurrentSource>)[id],
  ...overrides,
});

test('printed identity keeps only the name and email the renderer prints', () => {
  const profile = { identity: { fullName: ' Fictional ', email: 'candidate@example.test', country: 'ES' }, preferences: { targetTitles: ['QA'], workModes: ['remote'] } };
  assert.deepEqual(printedResumeIdentity(profile), { fullName: ' Fictional ', email: 'candidate@example.test' });
  assert.deepEqual(printedResumeIdentity({ ...profile, identity: { ...profile.identity, country: 'MX' }, preferences: {} }), printedResumeIdentity(profile));
  assert.equal(printedResumeIdentity({ identity: { fullName: 'x'.repeat(250) } }).fullName.length, 200);
  assert.deepEqual(printedResumeIdentity({}), { fullName: '', email: '' });
});

test('printed statements format structured entries in the PDF language and keep plain text verbatim', () => {
  assert.equal(printedStatement(plain, 'es'), plain.statement);
  assert.equal(printedStatement(structured, 'en'), 'Designer · Example\n01/2020 - Present\nTexto original.');
  assert.equal(printedStatement(structured, 'es'), 'Designer · Example\n01/2020 - Actualidad\nTexto original.');
});

test('a PDF stays current across revisions when only unprinted fields changed', () => {
  assert.equal(check(), true);
});

test('changes to printed identity, facts, evidence or text make a PDF stale', () => {
  assert.equal(check({ currentIdentity: { ...identity, fullName: 'Other Name' } }), false, 'name');
  assert.equal(check({ currentIdentity: { ...identity, email: 'other@example.test' } }), false, 'email');
  assert.equal(check({ basisIdentity: null }), false, 'unknown generation revision');
  assert.equal(check({ currentIdentity: null }), false, 'no current profile');
  assert.equal(check({ currentSource: (id) => id === 'old-a' ? { fact: plain, direct: false } : undefined }), false, 'edited, rejected or archived fact');
  assert.equal(check({ claims: [] }), false, 'no claims');
  assert.equal(check({ claims: [{ text: plain.statement, sourceFactIds: [] }] }), false, 'claim without evidence');
  assert.equal(check({ claims: [{ text: 'Different printed text', sourceFactIds: ['old-a'] }] }), false, 'different printed text');
  assert.equal(check({ language: 'es' }), false, 'structured text printed in another language');
  assert.equal(check({ claims: [{ text: plain.statement, sourceFactIds: ['old-a', 'old-b'] }] }), false, 'ambiguous multi-source claim');
});

test('the revision a PDF was generated from keeps the previous direct-fact rule', () => {
  const direct = (id: string) => id === 'a' ? { fact: plain, direct: true } : undefined;
  assert.equal(check({ sameRevision: true, basisIdentity: null, currentSource: direct, claims: [{ text: 'Rendered by an older version', sourceFactIds: ['a'] }] }), true);
  assert.equal(check({ sameRevision: true, currentSource: direct, claims: [{ text: plain.statement, sourceFactIds: ['missing'] }] }), false);
});

test('documents without a recorded language accept either rendering of the same fact', () => {
  assert.equal(check({ language: null }), true);
  assert.equal(check({ language: null, claims: [{ text: 'Unrelated', sourceFactIds: ['old-b'] }] }), false);
});
