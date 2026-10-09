import assert from 'node:assert/strict';
import { test } from 'node:test';
import { profileDataSchema } from '../src/contracts.js';
import type { StructuredEntry } from '../src/entries.js';
import { applyProfileProposals, detectIdentity, profileProposals, suggestTargetTitles } from '../src/profile-import.js';

// Fictional resumes only.
const spanish = `ANA GARCÍA LÓPEZ
Diseñadora de producto
Madrid, España · ana.garcia@example.test · +34 600 000 000

EXPERIENCIA
Diseñadora sénior — Fictional Studio (2021–actualidad), proyectos en Alemania y Francia.`;

const english = `Curriculum Vitae
John A. Smith
Software engineer
London, United Kingdom
john.smith@example.test

Experience
Worked with teams in Canada.`;

test('a Spanish resume header gives name, email and country; later sections are ignored', () => {
  assert.deepEqual(detectIdentity(spanish), { email: 'ana.garcia@example.test', fullName: 'Ana García López', country: 'ES' });
});

test('an English resume header skips the document title and finds the country by its English name', () => {
  assert.deepEqual(detectIdentity(english), { email: 'john.smith@example.test', fullName: 'John A. Smith', country: 'GB' });
});

test('uncertain values are left out instead of guessed', () => {
  assert.deepEqual(detectIdentity('Profile\nAna García\nana@example.test'), { email: 'ana@example.test' }, 'A section heading first means there is no header');
  assert.equal(detectIdentity('Ana García\nSpain and Portugal\n\nExperience').country, undefined, 'Two countries in the header');
  assert.equal(detectIdentity('Senior engineer 2020\nana@example.test').fullName, undefined, 'Lines with digits are not names');
  assert.equal(detectIdentity('Ana\nExperience').fullName, undefined, 'A single word is not a full name');
  assert.deepEqual(detectIdentity(''), {});
  assert.equal(detectIdentity('Guinea-Bissau\n').country, 'GW', 'The longest country name wins over a shorter one inside it');
});

test('the phone number is never part of the detected identity', () => {
  assert.equal(Object.keys(detectIdentity(spanish)).some((key) => /phone|tel/i.test(key)), false);
});

const job = (title: string, startMonth: string, extra: Partial<StructuredEntry> = {}): StructuredEntry => ({ type: 'employment', title, organization: 'Fictional Co', startMonth, current: false, description: '', locale: 'es', ...extra });

test('up to three recent job titles are suggested, current jobs first, without repeating existing ones', () => {
  const entries = [
    job('Junior designer', '2015-01', { endMonth: '2017-06' }),
    job('Product designer', '2017-07', { endMonth: '2021-01' }),
    job('Diseñadora sénior', '2021-02', { current: true }),
    job('Design lead', '2019-01', { endMonth: '2020-12' }),
    { ...job('Máster en diseño', '2014-01'), type: 'education' as const },
  ];
  assert.deepEqual(suggestTargetTitles(entries, []), ['Diseñadora sénior', 'Product designer', 'Design lead']);
  assert.deepEqual(suggestTargetTitles(entries, ['diseñadora senior', 'Design Lead']), ['Product designer', 'Junior designer'], 'Existing titles are skipped ignoring case and accents');
  assert.deepEqual(suggestTargetTitles([job('Designer', '2020-01'), job('designer', '2019-01')], []), ['Designer'], 'Repeated titles appear once');
});

test('proposals list only what would change, with the current value for comparison', () => {
  const profile = { identity: { fullName: 'Ana Garcia Lopez', email: 'old@example.test' }, preferences: { targetTitles: ['Product designer'] } };
  const proposals = profileProposals(profile, { fullName: 'Ana García López', email: 'ana.garcia@example.test', country: 'ES' }, ['Product designer', 'Design lead']);
  assert.deepEqual(proposals.identity, [
    { field: 'email', current: 'old@example.test', proposed: 'ana.garcia@example.test' },
    { field: 'country', current: '', proposed: 'ES' },
  ], 'The name only differs in accents, so it is not proposed');
  assert.deepEqual(proposals.targetTitles, ['Design lead']);
});

test('applying keeps everything not chosen and never replaces existing target titles', () => {
  const profile = { locale: 'en-GB', identity: { fullName: 'Ana Garcia', email: 'old@example.test', extra: 'kept' }, preferences: { targetTitles: ['Product designer'], workModes: ['remote'] } };
  const next = applyProfileProposals(profile, { identity: { country: 'es' }, targetTitles: ['Design lead', 'product designer', ' '] });
  assert.deepEqual(next, { locale: 'en-GB', identity: { fullName: 'Ana Garcia', email: 'old@example.test', extra: 'kept', country: 'ES' }, preferences: { targetTitles: ['Product designer', 'Design lead'], workModes: ['remote'] } });
  assert.deepEqual(profile.preferences.targetTitles, ['Product designer'], 'The input profile is not mutated');
  assert.equal(profileDataSchema.safeParse(next).success, true, 'The result is a valid profile for PUT /profile');
});

test('applying nothing returns the profile unchanged, and target titles stay within the profile limit', () => {
  const profile = { identity: { fullName: 'Ana Garcia' } };
  assert.deepEqual(applyProfileProposals(profile, {}), profile);
  assert.deepEqual(applyProfileProposals({}, { targetTitles: [] }), {});
  const full = { preferences: { targetTitles: Array.from({ length: 29 }, (_, index) => `Title ${index}`) } };
  const capped = applyProfileProposals(full, { targetTitles: ['New one', 'Another'] });
  assert.equal((capped.preferences as { targetTitles: string[] }).targetTitles.length, 30);
});
