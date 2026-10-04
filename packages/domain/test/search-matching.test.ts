import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateSearchMatch } from '../src/search-matching.js';

type EvaluationCase = { id: string; split: 'train' | 'holdout'; family: string; role: string; title: string; relevant: boolean; includeRelated: boolean };
const cases = JSON.parse(readFileSync(new URL('./fixtures/search-relevance.json', import.meta.url), 'utf8')) as EvaluationCase[];
const job = (overrides: Partial<{ title: string; company: string; location: string | null; workMode: string; countries: string[]; worldwide: boolean }> = {}) => ({
  title: 'Software Engineer', company: 'Northwind Studio', location: null, workMode: 'unknown', ...overrides,
});
const criteria = (overrides: Partial<{ role: string | null; company: string | null; location: string | null; workMode: string; includeRelated: boolean; matcherVersion: number }> = {}) => ({
  role: null, company: null, location: null, workMode: 'any', ...overrides,
});

function legacyBaseline(title: string, role: string): boolean {
  const normalize = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  return normalize(role).split(/\s+/).filter(Boolean).every((word) => normalize(title).includes(word));
}

const metrics = (predicted: boolean[], expected: boolean[]) => {
  let tp = 0; let fp = 0; let fn = 0;
  for (let i = 0; i < expected.length; i += 1) {
    if (predicted[i] && expected[i]) tp += 1;
    else if (predicted[i]) fp += 1;
    else if (expected[i]) fn += 1;
  }
  return { precision: tp / (tp + fp || 1), recall: tp / (tp + fn || 1), tp, fp, fn };
};

test('evaluates the labeled synthetic development corpus across six role families', () => {
  assert.ok(cases.length >= 120);
  assert.ok(cases.filter((item) => item.split === 'holdout').length >= 40);
  assert.deepEqual(new Set(cases.map((item) => item.family)), new Set(['quality', 'development', 'design', 'support', 'marketing', 'administration']));
  const holdout = cases.filter((item) => item.split === 'holdout');
  const baselinePredictions = holdout.map((item) => legacyBaseline(item.title, item.role));
  const newPredictions = holdout.map((item) => evaluateSearchMatch(job({ title: item.title }), criteria({ role: item.role, includeRelated: item.includeRelated })).matched);
  const expected = holdout.map((item) => item.relevant);
  const baseline = metrics(baselinePredictions, expected);
  const current = metrics(newPredictions, expected);
  const falsePositives = holdout.filter((item, index) => newPredictions[index] && !item.relevant).map((item) => `${item.id}:${item.role}→${item.title}`);
  // The original split labels remain for reproducibility. Both partitions informed
  // development, so these figures are regression evidence, not an independent holdout.
  console.info(`Search relevance synthetic regression subset n=${holdout.length}: v0.7.2 precision=${baseline.precision.toFixed(3)} recall=${baseline.recall.toFixed(3)}; v2 precision=${current.precision.toFixed(3)} recall=${current.recall.toFixed(3)} (TP=${current.tp}, FP=${current.fp}, FN=${current.fn}; false positives=${falsePositives.join('; ') || 'none'})`);
  assert.ok(current.precision >= 0.8, `holdout precision ${(current.precision * 100).toFixed(1)}% is below 80%`);
  assert.ok(current.recall >= 0.9, `holdout equivalence/related recall ${(current.recall * 100).toFixed(1)}% is below 90%`);
  for (const family of new Set(holdout.map((item) => item.family))) {
    const members = holdout.filter((item) => item.family === family);
    const result = metrics(members.map((item) => evaluateSearchMatch(job({ title: item.title }), criteria({ role: item.role, includeRelated: item.includeRelated })).matched), members.map((item) => item.relevant));
    assert.ok(result.precision >= 0.7, `${family} precision ${(result.precision * 100).toFixed(1)}% is below 70%`);
  }
});

test('keeps legacy v1 substring behavior available separately from v2', () => {
  const javaScript = job({ title: 'JavaScript Engineer' });
  assert.equal(evaluateSearchMatch(javaScript, criteria({ role: 'Java', matcherVersion: 1 })).matched, true);
  assert.equal(evaluateSearchMatch(javaScript, criteria({ role: 'Java', matcherVersion: 2 })).matched, false);
  assert.equal(evaluateSearchMatch(job({ title: 'Senior Product Designer', location: 'Europe', workMode: 'remote' }), criteria({ role: 'product designer', location: 'Spain', workMode: 'remote', matcherVersion: 1 })).unknownLocation, true);
  assert.throws(() => evaluateSearchMatch(javaScript, criteria({ matcherVersion: 3 })), RangeError);
});

test('uses whole technical tokens and preserves punctuation-sensitive technologies', () => {
  assert.equal(evaluateSearchMatch(job({ title: 'JavaScript Developer' }), criteria({ role: 'Java' })).matched, false);
  assert.equal(evaluateSearchMatch(job({ title: 'Java Engineer' }), criteria({ role: 'Java' })).matched, true);
  for (const technology of ['C++', 'C#', '.NET']) assert.equal(evaluateSearchMatch(job({ title: `${technology} Developer` }), criteria({ role: technology })).matched, true, technology);
  assert.equal(evaluateSearchMatch(job({ title: 'C Developer' }), criteria({ role: 'C++' })).matched, false);
  assert.equal(evaluateSearchMatch(job({ title: 'C# Developer' }), criteria({ role: 'C' })).matched, false);
  assert.equal(evaluateSearchMatch(job({ title: 'Manager, Project' }), criteria({ role: 'Project Manager' })).matched, false);
});

test('supports Spanish accents, exact and equivalent roles, and opt-in related suggestions', () => {
  const equivalent = evaluateSearchMatch(job({ title: 'Ingeniera de software' }), criteria({ role: 'software developer' }));
  assert.equal(equivalent.roleMatch, 'equivalent'); assert.equal(equivalent.matched, true);
  const relatedOff = evaluateSearchMatch(job({ title: 'SEO Specialist' }), criteria({ role: 'digital marketing specialist' }));
  const relatedOn = evaluateSearchMatch(job({ title: 'SEO Specialist' }), criteria({ role: 'digital marketing specialist', includeRelated: true }));
  assert.equal(relatedOff.roleMatch, 'related'); assert.equal(relatedOff.matched, false);
  assert.ok(relatedOff.reasons.includes('ROLE_RELATED'));
  assert.equal(relatedOn.roleMatch, 'related'); assert.equal(relatedOn.matched, true);
  assert.ok(relatedOn.reasons.includes('ROLE_RELATED'));
  assert.equal(evaluateSearchMatch(job({ title: 'Senior QA Engineer' }), criteria({ role: 'Junior QA Engineer' })).matched, false);
  assert.equal(evaluateSearchMatch(job({ title: 'Test Automation Engineer' }), criteria({ role: 'QA', includeRelated: true })).roleMatch, 'related');
  assert.equal(evaluateSearchMatch(job({ title: 'Digital Marketing Specialist' }), criteria({ role: 'Marketing Specialist', includeRelated: false })).roleMatch, 'related');
  assert.equal(evaluateSearchMatch(job({ title: 'Digital Marketing Specialist' }), criteria({ role: 'Marketing Specialist', includeRelated: false })).matched, false);
});

test('keeps SDET, UX, and adjacent titles related to broader roles, with opt-in matching', () => {
  for (const [role, title] of [['QA Engineer', 'SDET'], ['QA', 'Software Development Engineer in Test'], ['SDET', 'QA Engineer'], ['Product Designer', 'UX Designer'], ['UX Designer', 'Product Designer']]) {
    const excluded = evaluateSearchMatch(job({ title }), criteria({ role, includeRelated: false }));
    const included = evaluateSearchMatch(job({ title }), criteria({ role, includeRelated: true }));
    assert.equal(excluded.roleMatch, 'related', `${role} -> ${title}`);
    assert.equal(excluded.matched, false, `${role} -> ${title}`);
    assert.equal(included.matched, true, `${role} -> ${title}`);
    assert.ok(excluded.reasons.includes('ROLE_RELATED'));
  }
  assert.equal(evaluateSearchMatch(job({ title: 'Senior Software Engineer' }), criteria({ role: 'Junior Software Engineer' })).matched, false);
  assert.equal(evaluateSearchMatch(job({ title: 'Software Engineer' }), criteria({ role: 'Senior Software Engineer' })).matched, false);
  assert.equal(evaluateSearchMatch(job({ title: 'Junior Software Developer' }), criteria({ role: 'Senior Software Engineer' })).roleMatch, 'none');
});

test('matches companies on whole tokens rather than partial names', () => {
  assert.equal(evaluateSearchMatch(job({ company: 'Digital Ventures' }), criteria({ company: 'Digital' })).matched, true);
  assert.equal(evaluateSearchMatch(job({ company: 'Digital Ventures' }), criteria({ company: 'Digit' })).matched, false);
  assert.equal(evaluateSearchMatch(job({ company: 'Northwind Labs' }), criteria({ company: 'Northwind Studio' })).matched, false);
});

test('distinguishes explicit country compatibility, exclusion, worldwide, and unknown location', () => {
  const forSpain = criteria({ role: null, location: 'ES' });
  assert.equal(evaluateSearchMatch(job({ location: null }), forSpain).locationStatus, 'unknown');
  assert.equal(evaluateSearchMatch(job({ location: 'Remote — Europe', workMode: 'remote' }), forSpain).locationStatus, 'unknown');
  assert.equal(evaluateSearchMatch(job({ location: 'Remote — Spain', workMode: 'remote' }), forSpain).locationStatus, 'compatible');
  assert.equal(evaluateSearchMatch(job({ countries: ['US'], location: 'Remote', worldwide: true }), forSpain).locationStatus, 'incompatible');
  assert.equal(evaluateSearchMatch(job({ countries: ['ES', 'PT'], location: 'Remote' }), forSpain).locationStatus, 'compatible');
  assert.equal(evaluateSearchMatch(job({ worldwide: true }), forSpain).locationStatus, 'compatible');
  const rejected = evaluateSearchMatch(job({ countries: ['US'] }), forSpain);
  assert.equal(rejected.matched, false); assert.ok(rejected.reasons.includes('LOCATION_INCOMPATIBLE'));
  assert.equal(evaluateSearchMatch(job({ location: 'Madrid, Spain' }), criteria({ location: 'Madrid' })).locationStatus, 'compatible');
  assert.equal(evaluateSearchMatch(job({ location: 'Berlin, Germany' }), criteria({ location: 'Spain' })).locationStatus, 'incompatible');
  assert.equal(evaluateSearchMatch(job({ location: 'Remote — United States and Spain teams' }), forSpain).locationStatus, 'compatible');
  assert.equal(evaluateSearchMatch(job({ location: 'Remote — US and Canada only' }), forSpain).locationStatus, 'incompatible');
  assert.equal(evaluateSearchMatch(job({ location: 'Remote — United States and Canada operations' }), forSpain).locationStatus, 'unknown');
  assert.equal(evaluateSearchMatch(job({ location: 'Remote — serving US customers' }), forSpain).locationStatus, 'unknown');
  assert.equal(evaluateSearchMatch(job({ worldwide: true, location: 'Remote — US only' }), forSpain).locationStatus, 'unknown');
  assert.equal(evaluateSearchMatch(job({ location: 'Remote — worldwide' }), forSpain).locationStatus, 'compatible');
});

test('applies only explicitly requested work modes and leaves absent location criteria unfiltered', () => {
  assert.equal(evaluateSearchMatch(job({ workMode: 'unknown' }), criteria({ workMode: 'any' })).matched, true);
  const modeUnknown = evaluateSearchMatch(job({ workMode: 'unknown' }), criteria({ workMode: 'remote' }));
  assert.equal(modeUnknown.matched, true); assert.ok(modeUnknown.reasons.includes('WORK_MODE_UNKNOWN'));
  const modeMismatch = evaluateSearchMatch(job({ workMode: 'hybrid' }), criteria({ workMode: 'remote' }));
  assert.equal(modeMismatch.matched, false); assert.ok(modeMismatch.reasons.includes('WORK_MODE_MISMATCH'));
  const unrestricted = evaluateSearchMatch(job({ location: null }), criteria({ role: null }));
  assert.equal(unrestricted.matched, true); assert.equal(unrestricted.locationStatus, 'not_requested'); assert.equal(unrestricted.unknownLocation, false);
});


test('structured ISO countries outside the alias dictionary still exclude incompatible countries', () => {
  assert.equal(evaluateSearchMatch(job({countries:['JP'],worldwide:false}),criteria({location:'US'})).matched,false);
  assert.equal(evaluateSearchMatch(job({countries:['JP'],worldwide:false}),criteria({location:'JP'})).locationStatus,'compatible');
});

test('equivalences retain explicit technology and specialization modifiers', () => {
  assert.equal(evaluateSearchMatch(job({title:'Python Frontend Developer'}),criteria({role:'Java software engineer',includeRelated:true})).matched,false);
  assert.equal(evaluateSearchMatch(job({title:'Java Frontend Developer'}),criteria({role:'Java software engineer',includeRelated:true})).matched,true);
  assert.equal(evaluateSearchMatch(job({title:'Python Software Engineer'}),criteria({role:'Java software engineer'})).matched,false);
  assert.equal(evaluateSearchMatch(job({title:'Java Software Developer'}),criteria({role:'Java ingeniero de software'})).matched,true);
  assert.equal(evaluateSearchMatch(job({title:'Software Engineer'}),criteria({role:'Cloud software engineer'})).matched,false);
});
