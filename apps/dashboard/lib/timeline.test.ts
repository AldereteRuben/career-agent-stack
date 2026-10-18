import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeItem, formatDay, formatItemTime, groupByDay, monthRange, parseMonth, typeLabel, typesParam, timelineTypes, type TimelineItem } from './timeline';

const item = (fields: Partial<TimelineItem> & Pick<TimelineItem, 'id' | 'type' | 'day'>): TimelineItem => ({ at: null, ...fields });

test('month ranges cover every calendar day, including leap years', () => {
  assert.deepEqual(monthRange(2026, 9), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(monthRange(2028, 1), { from: '2028-02-01', to: '2028-02-29' });
  assert.deepEqual(monthRange(2026, 12), { from: '2027-01-01', to: '2027-01-31' });
  assert.deepEqual(parseMonth('2026-10'), { year: 2026, monthIndex: 9 });
  for (const bad of ['2026-13', '2026-1', 'october', '', null, undefined]) assert.equal(parseMonth(bad), null, String(bad));
});

test('items group by day in the order the server sent them', () => {
  const groups = groupByDay([item({ id: 'a', type: 'FOLLOW_UP', day: '2026-10-02' }), item({ id: 'b', type: 'INTERVIEW', day: '2026-10-02' }), item({ id: 'c', type: 'JOB_SAVED', day: '2026-10-05' })]);
  assert.deepEqual(groups.map((group) => [group.day, group.items.map((entry) => entry.id)]), [['2026-10-02', ['a', 'b']], ['2026-10-05', ['c']]]);
});

test('the types query keeps the canonical order', () => {
  assert.equal(typesParam(['FOLLOW_UP', 'JOB_SAVED']), 'JOB_SAVED,FOLLOW_UP');
  assert.equal(typesParam([...timelineTypes].reverse()), timelineTypes.join(','));
});

test('dates never shift through a time zone, and interview times show their own zone when it differs', () => {
  // Exact punctuation varies between ICU versions; the day itself must not move in any zone.
  assert.match(formatDay('2026-10-01', 'en'), /^Thursday,? 1 October 2026$/);
  assert.match(formatDay('2026-10-01', 'es'), /^Jueves,? 1 de octubre de 2026$/);
  const interview = item({ id: 'i', type: 'INTERVIEW', day: '2026-10-21', at: '2026-10-20T23:30:00.000Z', interviewTimeZone: 'America/New_York' });
  assert.equal(formatItemTime(interview, 'Europe/Madrid', 'en'), '01:30 (19:30 in America/New_York)');
  assert.equal(formatItemTime(interview, 'America/New_York', 'es'), '19:30');
  assert.equal(formatItemTime(item({ id: 'f', type: 'FOLLOW_UP', day: '2026-10-10' }), 'Europe/Madrid', 'es'), 'Todo el día');
});

test('every type and record reads in Spanish and English', () => {
  for (const type of timelineTypes) { assert.ok(typeLabel(type, 'es')); assert.ok(typeLabel(type, 'en')); assert.notEqual(typeLabel(type, 'es'), typeLabel(type, 'en')); }
  const stage = item({ id: 's', type: 'STAGE_CHANGED', day: '2026-10-08', application: { id: 'app', role: 'QA Engineer', company: 'Fictional Labs' }, priorState: 'NO_RESPONSE', newState: 'INTERVIEW', correction: true });
  const english = describeItem(stage, 'en'); const spanish = describeItem(stage, 'es');
  assert.equal(english.href, '/applications?id=app'); assert.equal(english.title, 'QA Engineer');
  assert.match(english.label, /corrected/i); assert.match(spanish.label, /corregida/i);
  assert.notEqual(english.detail, spanish.detail);
  const foundAutomatically = describeItem(item({ id: 'found', type: 'JOB_FOUND', day: '2026-10-06', automatic: true, job: { id: 'found', title: 'Analyst', company: 'Fictional Labs' } }), 'en');
  const foundManually = describeItem(item({ id: 'manual', type: 'JOB_FOUND', day: '2026-10-06', automatic: false, job: { id: 'manual', title: 'Researcher', company: 'Fictional Labs' } }), 'es');
  assert.equal(foundAutomatically.label, 'Job found'); assert.equal(foundManually.label, 'Oferta añadida por ti');
  const saved = describeItem(item({ id: 'j', type: 'JOB_SAVED', day: '2026-10-03', job: { id: 'job', title: 'Tester', company: 'Fictional Labs' } }), 'es');
  assert.deepEqual(saved, { label: 'Oferta guardada', title: 'Tester', detail: 'Fictional Labs', href: '/jobs/job' });
  const followUp = describeItem(item({ id: 'f', type: 'FOLLOW_UP', day: '2026-10-10', application: { id: 'app', role: 'QA Engineer', company: 'Fictional Labs' }, nextStep: 'Email the recruiter' }), 'en');
  assert.equal(followUp.detail, 'Fictional Labs · Email the recruiter');
});
