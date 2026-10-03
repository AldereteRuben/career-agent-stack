import assert from 'node:assert/strict';
import { test } from 'node:test';
import { factSchema } from '../src/contracts.js';
import { entryStatement, legacyEmployment } from '../src/entries.js';

const employment = { role: 'Designer', company: 'Example', startMonth: '2020-01', current: true, locale: 'es' as const };
test('employment retains structured fields and a reviewable snapshot', () => {
  const fact = factSchema.parse({ kind: 'experience', statement: 'Diseñé un producto.', employment });
  assert.equal(fact.details?.organization, 'Example'); assert.equal(fact.details?.description, 'Diseñé un producto.');
  assert.equal(fact.statement, 'Designer · Example\n01/2020 - Actualidad\nDiseñé un producto.');
});
test('PDF language changes metadata without translating personal prose', () => {
  const fact = factSchema.parse({ kind: 'experience', statement: 'Texto original.', employment });
  assert.equal(entryStatement(fact.details!, 'en'), 'Designer · Example\n01/2020 - Present\nTexto original.');
});
test('education has institution and dates, and does not require invented achievements', () => {
  const fact = factSchema.parse({ kind: 'education', statement: '', education: { qualification: 'Design', institution: 'Example School', startMonth: '2022-09', current: true, locale: 'es' } });
  assert.equal(fact.details?.type, 'education'); assert.match(entryStatement(fact.details!, 'en'), /In progress$/);
});
test('structured date validation rejects missing, reversed and conflicting end dates', () => {
  for (const patch of [{ current: false }, { current: false, endMonth: '2019-12' }, { current: true, endMonth: '2024-01' }, { startMonth: '2020-13' }]) {
    assert.equal(factSchema.safeParse({ kind: 'experience', statement: 'Text', employment: { ...employment, ...patch } }).success, false);
  }
});
test('structured inputs cannot be smuggled into a different entry kind', () => {
  assert.equal(factSchema.safeParse({ kind: 'education', statement: 'Text', employment }).success, false);
  assert.equal(factSchema.safeParse({ kind: 'achievement', statement: '' }).success, false);
});
test('canonical legacy employment can be edited without guessing fields', () => {
  const statement = 'Designer · Example\n01/2020 - Actualidad\nOriginal description';
  const legacy = legacyEmployment('experience', statement);
  assert.equal(legacy?.startMonth, '2020-01'); assert.equal(legacy?.current, true); assert.equal(entryStatement(legacy!), statement);
});
test('ambiguous legacy text stays intact as text', () => {
  assert.equal(legacyEmployment('experience', 'I worked at Example for several years.'), null);
  assert.equal(legacyEmployment('experience', 'Designer · Lead · Example\n01/2020 - Actualidad\nDescription'), null);
  assert.equal(legacyEmployment('education', 'Designer · Example\n01/2020 - Actualidad\nDescription'), null);
});
