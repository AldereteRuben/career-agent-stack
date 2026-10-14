import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ABSENCE_MIN_HOURS, ABSENCE_READS, absentFromSources, nextAvailability, suspiciousRead, type AvailabilitySource } from '../src/job-availability.js';

const now = new Date('2026-10-11T12:00:00Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
const board = (missed: number, seenHoursAgo: number | null): AvailabilitySource => ({ canGiveAbsence: true, missedCompleteReads: missed, lastSeenAt: seenHoursAgo === null ? null : hoursAgo(seenHoursAgo) });
const himalayas = (seenHoursAgo: number): AvailabilitySource => ({ canGiveAbsence: false, missedCompleteReads: 0, lastSeenAt: hoursAgo(seenHoursAgo) });
const next = (current: Parameters<typeof nextAvailability>[0]['current'], sources: AvailabilitySource[], closedByUser = false) => nextAvailability({ current, closedByUser, sources, now });

test('the thresholds are the ones ADR 021 records', () => {
  assert.equal(ABSENCE_READS, 3);
  assert.equal(ABSENCE_MIN_HOURS, 48);
});

test('three complete misses over two days make a job possibly closed', () => {
  assert.deepEqual(next('OPEN', [board(3, 50)]), { state: 'POSSIBLY_CLOSED', reason: 'ABSENT_FROM_SOURCES' });
});

test('boundaries: 2 vs 3 misses, 47 vs 48 hours', () => {
  assert.equal(next('OPEN', [board(2, 100)]), null, 'Two misses are not enough');
  assert.equal(next('OPEN', [board(3, 47)]), null, 'Forty-seven hours are not enough');
  assert.deepEqual(next('OPEN', [board(3, 48)])?.state, 'POSSIBLY_CLOSED', 'Exactly 48 hours are enough');
  assert.equal(next('OPEN', [board(3, 20)]), null, 'Three misses within a day are not enough');
});

test('every source able to show absence must agree', () => {
  assert.equal(next('OPEN', [board(3, 50), board(0, 2)]), null, 'Another source still lists it');
  assert.equal(next('OPEN', [board(3, 60), board(5, 60)])?.state, 'POSSIBLY_CLOSED');
});

test('Himalayas gives presence but never absence', () => {
  assert.equal(next('OPEN', [himalayas(3)]), null, 'A Himalayas-only job never closes');
  assert.equal(next('OPEN', [himalayas(500)]), null, 'Not even when Himalayas saw it long ago');
  assert.equal(next('OPEN', [board(3, 100), himalayas(10)]), null, 'A recent Himalayas sighting keeps it open');
  assert.equal(next('OPEN', [board(3, 100), himalayas(60)])?.state, 'POSSIBLY_CLOSED', 'An old Himalayas sighting does not');
});

test('a manual job with no source stays unknown', () => {
  assert.equal(next('UNKNOWN', []), null);
  assert.equal(absentFromSources([], now), false);
});

test('a manual job that a source lists becomes open', () => {
  assert.deepEqual(next('UNKNOWN', [board(0, 0)]), { state: 'OPEN', reason: 'SEEN_AGAIN' });
});

test('a possibly closed job reopens as soon as a source sees it again', () => {
  assert.deepEqual(next('POSSIBLY_CLOSED', [board(0, 0)]), { state: 'OPEN', reason: 'SEEN_AGAIN' });
  assert.equal(next('POSSIBLY_CLOSED', [board(4, 80)]), null, 'Still absent: nothing to change');
});

test('the person\'s decision wins over sources', () => {
  assert.equal(next('CLOSED', [board(0, 0)], true), null, 'A user-closed job stays closed while a source lists it');
  assert.deepEqual(next('OPEN', [board(0, 0)], true), { state: 'CLOSED', reason: 'CLOSED_BY_USER' });
  assert.equal(next('CLOSED', [board(9, 500)], false), null, 'CLOSED is never left or reached from sources alone');
});

test('a suspicious complete read gives no absence evidence', () => {
  assert.equal(suspiciousRead(10, null), false, 'The first complete read is never suspicious');
  assert.equal(suspiciousRead(0, 0), false, 'Empty after empty is not suspicious');
  assert.equal(suspiciousRead(0, 40), true, 'Suddenly empty');
  assert.equal(suspiciousRead(49, 100), true, '49% of the previous read');
  assert.equal(suspiciousRead(50, 100), false, 'Exactly half is not suspicious');
  assert.equal(suspiciousRead(300, 1000), true);
  assert.equal(suspiciousRead(120, 100), false, 'Growth is fine');
});
