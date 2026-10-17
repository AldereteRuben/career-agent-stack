import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityWindow, compareTimelineItems, localDayBounds, localToday, parseActivityDay, parseTimelineRange, parseTimelineTypes, resolveTimeZone, timelineBounds, timelineMaxDays, timelineTypes, type TimelineItem } from '../src/activity-days.js';

test('time zones: absent means UTC, real IANA names pass, anything else is rejected', () => {
  assert.equal(resolveTimeZone(undefined), 'UTC');
  assert.equal(resolveTimeZone(''), 'UTC');
  assert.equal(resolveTimeZone('Europe/Madrid'), 'Europe/Madrid');
  assert.equal(resolveTimeZone('America/Argentina/Buenos_Aires'), 'America/Argentina/Buenos_Aires');
  assert.equal(resolveTimeZone('Etc/GMT+5'), 'Etc/GMT+5');
  for (const bad of ['Not/AZone', "UTC'; DROP TABLE jobs;--", 'a'.repeat(65), '+05', '+0530', '-03:00', 42, null, {}, ['UTC']]) assert.equal(resolveTimeZone(bad), null, String(bad));
});

test('activity days: only real calendar days in YYYY-MM-DD form are accepted', () => {
  assert.equal(parseActivityDay('2026-10-16'), '2026-10-16');
  assert.equal(parseActivityDay('2028-02-29'), '2028-02-29');
  for (const bad of ['2026-02-30', '2027-02-29', '2026-13-01', '2026-1-1', 'tomorrow', '', undefined, 20261016]) assert.equal(parseActivityDay(bad), null, String(bad));
});

test('day bounds contain the local day in every zone from UTC-12 to UTC+14', () => {
  const { from, to } = localDayBounds('2026-10-16');
  const localStart = (offsetHours: number) => Date.UTC(2026, 9, 16) - offsetHours * 3_600_000;
  for (const offset of [-12, -5, 0, 2, 14]) {
    assert.ok(localStart(offset) >= from.getTime() && localStart(offset) + 86_400_000 <= to.getTime(), `UTC${offset >= 0 ? '+' : ''}${offset}`);
  }
});

test('the twelve month window reaches back to the first day of the oldest month and forward past the current month', () => {
  const { from, to } = activityWindow(new Date('2026-10-16T12:00:00Z'));
  assert.ok(from.getTime() <= Date.UTC(2025, 10, 1) && from.getTime() > Date.UTC(2025, 9, 30) - 86_400_000);
  assert.ok(to.getTime() >= Date.UTC(2026, 10, 1));
});

test('timeline types: absent means every type, a subset keeps canonical order, unknown or empty values are rejected', () => {
  assert.deepEqual(parseTimelineTypes(undefined), [...timelineTypes]);
  assert.deepEqual(parseTimelineTypes('FOLLOW_UP,INTERVIEW'), ['INTERVIEW', 'FOLLOW_UP']);
  assert.deepEqual(parseTimelineTypes('JOB_SAVED'), ['JOB_SAVED']);
  assert.deepEqual(parseTimelineTypes('JOB_FOUND'), ['JOB_FOUND']);
  for (const bad of ['', 'INTERVIEW,', 'NOT_A_TYPE', 'interview', 42, ['INTERVIEW'], 'A'.repeat(201)]) assert.equal(parseTimelineTypes(bad), null, String(bad));
});

test('timeline ranges are inclusive real days, ordered, and at most the maximum span', () => {
  assert.deepEqual(parseTimelineRange('2026-10-01', '2026-10-31'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(parseTimelineRange('2026-10-17', '2026-10-17'), { from: '2026-10-17', to: '2026-10-17' });
  const last = new Date(Date.UTC(2026, 0, 1) + (timelineMaxDays - 1) * 86_400_000).toISOString().slice(0, 10);
  assert.ok(parseTimelineRange('2026-01-01', last));
  assert.equal(parseTimelineRange('2026-01-01', new Date(Date.UTC(2026, 0, 1) + timelineMaxDays * 86_400_000).toISOString().slice(0, 10)), null);
  assert.equal(parseTimelineRange('2026-10-31', '2026-10-01'), null);
  assert.equal(parseTimelineRange('2026-02-30', '2026-03-01'), null);
  assert.equal(parseTimelineRange(undefined, '2026-03-01'), null);
});

test('timeline bounds contain the whole local range in every zone from UTC-12 to UTC+14', () => {
  const { start, end } = timelineBounds('2026-10-01', '2026-10-31');
  for (const offset of [-12, -4, 0, 2, 14]) {
    const localStart = Date.UTC(2026, 9, 1) - offset * 3_600_000; const localEnd = Date.UTC(2026, 10, 1) - offset * 3_600_000;
    assert.ok(localStart >= start.getTime() && localEnd <= end.getTime(), `UTC${offset}`);
  }
});

test('today is the viewer\'s calendar day, not the server\'s', () => {
  const now = new Date('2026-10-17T23:30:00Z');
  assert.equal(localToday(now, 'UTC'), '2026-10-17');
  assert.equal(localToday(now, 'Europe/Madrid'), '2026-10-18');
  assert.equal(localToday(new Date('2026-10-17T02:00:00Z'), 'America/New_York'), '2026-10-16');
});

test('timeline order: day first, date-only follow-ups lead the day, then timed records by instant', () => {
  const item = (id: string, day: string, at: string | null, type: TimelineItem['type'] = 'INTERVIEW'): TimelineItem => ({ id, day, at, type });
  const sorted = [item('c', '2026-10-02', '2026-10-02T09:00:00.000Z'), item('d', '2026-10-01', '2026-10-01T18:00:00.000Z'), item('b', '2026-10-02', null, 'FOLLOW_UP'), item('a', '2026-10-02', '2026-10-02T08:00:00.000Z', 'STAGE_CHANGED'), item('e', '2026-10-02', '2026-10-02T08:00:00.000Z', 'JOB_SAVED')].sort(compareTimelineItems);
  assert.deepEqual(sorted.map((entry) => entry.id), ['d', 'b', 'e', 'a', 'c']);
});
