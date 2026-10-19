import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compensationPeriod, firstJobCompensation, formatJobCompensation, jobCompensationFromSource } from '../src/job-compensation.js';

// Synthetic payloads shaped like each source's documented fields; none comes from a real posting.
test('Lever: reads salaryRange and keeps the interval and currency as written', () => {
  const payload = { salaryRange: { currency: 'usd', interval: 'per-year-salary', min: 90000, max: 120000 }, salaryDescriptionPlain: 'Base salary range' };
  assert.deepEqual(jobCompensationFromSource('lever', payload), { min: 90000, max: 120000, currency: 'USD', period: 'YEAR', text: null });
  assert.equal(jobCompensationFromSource('lever', { salaryRange: { currency: 'EUR', interval: 'per-hour-wage', min: 20, max: 20 } })?.period, 'HOUR');
});

// The description is usually a paragraph of legal text; without a range it is not pay.
test('Lever: a description without a range is not shown as pay', () => {
  assert.equal(jobCompensationFromSource('lever', { salaryDescriptionPlain: 'The salary range is determined by location, skills and experience. '.repeat(8) }), null);
});

test('Ashby: uses the Salary component, ignores equity and bonus', () => {
  const payload = { compensation: { scrapeableCompensationSalarySummary: '$81K - $87K', summaryComponents: [
    { compensationType: 'EquityPercentage', interval: 'NONE', currencyCode: null, minValue: 0.1, maxValue: 0.2 },
    { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 81000, maxValue: 87000 },
    { compensationType: 'Bonus', interval: '1 YEAR', currencyCode: 'USD', minValue: 5000, maxValue: 5000 },
  ] } };
  assert.deepEqual(jobCompensationFromSource('ashby', payload), { min: 81000, max: 87000, currency: 'USD', period: 'YEAR', text: '$81K - $87K' });
});

test('Ashby: the tier summary is never used as text because it also lists equity and bonus', () => {
  const tier = '€110K – €185K • Offers Equity • Offers Bonus';
  assert.equal(jobCompensationFromSource('ashby', { compensation: { compensationTierSummary: tier, summaryComponents: [{ compensationType: 'EquityPercentage', interval: 'NONE', currencyCode: null, minValue: null, maxValue: null }] } }), null);
  assert.deepEqual(jobCompensationFromSource('ashby', { compensation: { compensationTierSummary: tier, summaryComponents: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'EUR', minValue: 110000, maxValue: 185000 }] } }), { min: 110000, max: 185000, currency: 'EUR', period: 'YEAR', text: null });
});

test('Himalayas: numbers with a currency; a missing period is annual as documented, an unknown one is not guessed', () => {
  assert.deepEqual(jobCompensationFromSource('himalayas', { minSalary: 4000, maxSalary: 5000, currency: 'EUR', salaryPeriod: 'monthly' }), { min: 4000, max: 5000, currency: 'EUR', period: 'MONTH', text: null });
  assert.equal(jobCompensationFromSource('himalayas', { minSalary: 50000, maxSalary: null, currency: 'USD' })?.period, 'YEAR');
  assert.equal(jobCompensationFromSource('himalayas', { minSalary: 50000, currency: 'USD', salaryPeriod: 'per moon' })?.period, null);
});

test('Remotive keeps its free text and is never parsed into numbers', () => {
  assert.deepEqual(jobCompensationFromSource('remotive', { salary: '  $40,000 -  $50,000 ' }), { min: null, max: null, currency: null, period: null, text: '$40,000 - $50,000' });
});

test('sources without pay, and payloads of the wrong shape, give null', () => {
  assert.equal(jobCompensationFromSource('greenhouse', { id: 1, title: 'Engineer' }), null);
  assert.equal(jobCompensationFromSource('arbeitnow', { slug: 'a', title: 'b' }), null);
  assert.equal(jobCompensationFromSource('lever', { salaryRange: null }), null);
  assert.equal(jobCompensationFromSource('lever', null), null);
  assert.equal(jobCompensationFromSource('ashby', { compensation: { summaryComponents: 'none' } }), null);
  assert.equal(jobCompensationFromSource('remotive', { salary: '   ' }), null);
  assert.equal(jobCompensationFromSource('himalayas', { minSalary: null, maxSalary: null, currency: 'USD' }), null);
});

test('odd values: a contradictory range, negative or text numbers and a bad currency are dropped, not repaired', () => {
  assert.equal(jobCompensationFromSource('himalayas', { minSalary: 90000, maxSalary: 50000, currency: 'USD' }), null);
  assert.equal(jobCompensationFromSource('lever', { salaryRange: { currency: 'USD', interval: 'per-year-salary', min: '90000', max: -5 } }), null);
  assert.equal(jobCompensationFromSource('himalayas', { minSalary: 100, maxSalary: 200, currency: 'dollars' })?.currency, null);
  assert.equal(jobCompensationFromSource('remotive', { salary: 'x'.repeat(1000) })?.text?.length, 300);
});

test('the first source that states pay wins, in the order given', () => {
  const sources = [{ provider: 'arbeitnow', payload: {} }, { provider: 'remotive', payload: { salary: '$1' } }, { provider: 'himalayas', payload: { minSalary: 1, maxSalary: 2, currency: 'USD' } }];
  assert.equal(firstJobCompensation(sources)?.provider, 'remotive');
  assert.equal(firstJobCompensation([]), null);
});

test('maps interval words from every source and does not convert between them', () => {
  for (const [word, period] of [['per-year-salary', 'YEAR'], ['1 MONTH', 'MONTH'], ['weekly', 'WEEK'], ['fortnightly', 'FORTNIGHT'], ['daily', 'DAY'], ['per-hour-wage', 'HOUR'], ['annual', 'YEAR']] as const) assert.equal(compensationPeriod(word), period);
  assert.equal(compensationPeriod('NONE'), null);
  // A multiplier other than 1 is a different period: "2 WEEK" is not "per week" and "6 MONTH" is not "per month".
  for (const word of ['2 WEEK', '6 MONTH', '3 YEAR', '0 DAY']) assert.equal(compensationPeriod(word), null, word);
  assert.equal(jobCompensationFromSource('ashby', { compensation: { summaryComponents: [{ compensationType: 'Salary', interval: '6 MONTH', currencyCode: 'USD', minValue: 30000, maxValue: 40000 }] } })?.period, null);
  assert.equal(compensationPeriod('1 YEAR'), 'YEAR');
  assert.equal(compensationPeriod('hourly'), 'HOUR');
  assert.equal(compensationPeriod('monthly'), 'MONTH');
  assert.equal(compensationPeriod(5), null);
});

test('formats ranges, open ends and plain text in Spanish and English', () => {
  const range = { min: 45000, max: 55000, currency: 'EUR', period: 'YEAR' as const, text: null };
  assert.equal(formatJobCompensation(range, 'en'), '€45,000 – €55,000 per year');
  assert.match(formatJobCompensation(range, 'es'), /^45\.000,?\s?€ – 55\.000,?\s?€ al año$/u);
  assert.equal(formatJobCompensation({ ...range, max: null }, 'en'), 'From €45,000 per year');
  assert.equal(formatJobCompensation({ ...range, min: null }, 'es').startsWith('Hasta '), true);
  assert.equal(formatJobCompensation({ ...range, min: 20, max: 20, period: 'HOUR' }, 'en'), '€20 per hour');
  assert.equal(formatJobCompensation({ min: null, max: null, currency: null, period: null, text: '$40,000 - $50,000' }, 'en'), '$40,000 - $50,000');
  assert.equal(formatJobCompensation({ ...range, currency: null }, 'en'), '45,000 – 55,000 per year');
});
