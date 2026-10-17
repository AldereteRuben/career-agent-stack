import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activityWindow, localDayBounds, parseActivityDay, resolveTimeZone } from '../src/activity-days.js';

test('time zones: absent means UTC, real IANA names pass, anything else is rejected', () => {
  assert.equal(resolveTimeZone(undefined), 'UTC');
  assert.equal(resolveTimeZone(''), 'UTC');
  assert.equal(resolveTimeZone('Europe/Madrid'), 'Europe/Madrid');
  assert.equal(resolveTimeZone('America/Argentina/Buenos_Aires'), 'America/Argentina/Buenos_Aires');
  for (const bad of ['Not/AZone', "UTC'; DROP TABLE jobs;--", 'a'.repeat(65), 42, null, {}, ['UTC']]) assert.equal(resolveTimeZone(bad), null, String(bad));
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
