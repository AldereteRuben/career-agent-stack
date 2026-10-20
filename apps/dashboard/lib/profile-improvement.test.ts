import assert from 'node:assert/strict';
import test from 'node:test';
import { buildProfileImprovement, formatImprovementCopy } from './profile-improvement.js';

const approved = {
  id: 'fact-1', kind: 'experience', statement: 'Automated regression tests for a payment platform.', tags: ['Playwright', 'payments'], approvalStatus: 'USER_APPROVED',
  details: { type: 'employment' as const, title: 'QA Engineer', organization: 'Example Co', startMonth: '2020-01', endMonth: '2022-12', current: false, description: 'Automated regression tests for a payment platform.', locale: 'en' as const },
};

test('profile pack cites approved facts and excludes pending facts', () => {
  const result = buildProfileImprovement([
    approved,
    { ...approved, id: 'fact-2', statement: 'Pending claim must not appear.', details: { ...approved.details, title: 'Director', organization: 'Future Co' }, approvalStatus: 'SUGGESTED' },
  ], 'en');

  assert.deepEqual(result.headlineVariants, [{ text: 'QA Engineer · Playwright · payments', evidence: [approved.statement] }]);
  assert.deepEqual(result.aboutDraft, [{ text: 'Experience in QA Engineer at Example Co.', evidence: [approved.statement] }]);
  assert.deepEqual(result.experienceBullets, [{ text: approved.statement, evidence: [approved.statement] }]);
  assert.doesNotMatch(JSON.stringify(result), /Pending claim|Director|Future Co/);
});

test('an approved summary remains verbatim and is its own evidence', () => {
  const summary = { ...approved, id: 'fact-summary', kind: 'summary', statement: 'I build reliable test automation.', details: null };
  const result = buildProfileImprovement([approved, summary], 'es');
  assert.deepEqual(result.aboutDraft, [{ text: summary.statement, evidence: [summary.statement] }]);
});

test('profile copy stays empty until approved experience or summary exists', () => {
  const result = buildProfileImprovement([{ ...approved, approvalStatus: 'SUGGESTED' }], 'es');
  assert.deepEqual(result, { headlineVariants: [], aboutDraft: [], experienceBullets: [] });
});

test('copied portfolio references are not labeled as approved profile evidence', () => {
  assert.equal(formatImprovementCopy('Portfolio idea', ['Quality role · Example Co'], 'Reference jobs'), 'Portfolio idea\n\nReference jobs:\n• Quality role · Example Co');
});
