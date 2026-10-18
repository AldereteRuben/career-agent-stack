import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateJobFilters, parseJobFilterPreferences } from '../src/job-filter-routes.js';

test('filter preferences accept bounded lists and normalize duplicate entries', () => {
  assert.deepEqual(parseJobFilterPreferences({ excludedCompanies: ['  Café Co ', 'cafe co'], requiredTerms: ['QA'], excludedTerms: [] }), {
    excludedCompanies: ['Café Co'], requiredTerms: ['QA'], excludedTerms: [],
  });
  assert.equal(parseJobFilterPreferences({ excludedCompanies: new Array(51).fill('Acme') }), null);
  assert.equal(parseJobFilterPreferences({ requiredTerms: ['x'.repeat(101)] }), null);
  assert.equal(parseJobFilterPreferences({ unexpected: [] }), null);
});

test('explicit job filters use exact company names, required AND and excluded OR with normalized phrases', () => {
  const preferences = { excludedCompanies: ['Café Co'], requiredTerms: ['quality assurance', 'typescript'], excludedTerms: ['crypto', 'gambling'] };
  assert.deepEqual(evaluateJobFilters({ company: 'Cafe Co', title: 'Quality Assurance Engineer', description: 'TypeScript role' }, preferences), {
    excluded: true,
    reasons: { excludedCompany: 'Café Co', missingRequiredTerms: [], matchedExcludedTerms: [] },
  });
  assert.deepEqual(evaluateJobFilters({ company: 'Safe Co', title: 'Quality Assurance Engineer', description: 'TypeScript role' }, preferences), {
    excluded: false,
    reasons: { excludedCompany: null, missingRequiredTerms: [], matchedExcludedTerms: [] },
  });
  const missing = evaluateJobFilters({ company: 'Safe Co', title: 'Quality Assurance Engineer', description: 'Python role' }, preferences);
  assert.deepEqual(missing.reasons.missingRequiredTerms, ['typescript']);
  assert.deepEqual(evaluateJobFilters({ company: 'Safe Co', title: 'Quality Assurance Engineer', description: 'TypeScript and crypto role' }, preferences).reasons.matchedExcludedTerms, ['crypto']);
  assert.equal(evaluateJobFilters({ company: 'Safe Co', title: 'Quality Assurance Engineer', description: 'TypeScript role' }, { ...preferences, excludedTerms: ['type'] }).excluded, false, 'short substrings do not match inside a word');
});
