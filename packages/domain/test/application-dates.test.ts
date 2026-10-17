import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applicationFollowUpStatus, instantToLocalDateTime, isValidDateOnly, localDateTimeToInstant } from '../src/application-dates.js';

test('validates follow-up calendar dates instead of accepting impossible dates', () => {
  assert.equal(isValidDateOnly('2026-02-28'), true);
  assert.equal(isValidDateOnly('2026-02-29'), false);
  assert.equal(isValidDateOnly('2026-13-01'), false);
});

test('converts interview wall time using the selected IANA zone across standard and daylight time', () => {
  assert.equal(localDateTimeToInstant('2026-01-15T09:30', 'Europe/Madrid'), '2026-01-15T08:30:00.000Z');
  assert.equal(localDateTimeToInstant('2026-07-15T09:30', 'Europe/Madrid'), '2026-07-15T07:30:00.000Z');
  assert.equal(instantToLocalDateTime('2026-07-15T07:30:00.000Z', 'Europe/Madrid'), '2026-07-15T09:30');
});

test('rejects nonexistent and repeated interview times around daylight-saving changes', () => {
  assert.equal(localDateTimeToInstant('2026-03-29T02:30', 'Europe/Madrid'), null);
  assert.equal(localDateTimeToInstant('2026-10-25T02:30', 'Europe/Madrid'), null);
  assert.equal(localDateTimeToInstant('2026-10-25T02:30', 'Not/AZone'), null);
});

test('due follow-ups distinguish overdue, today, upcoming, and closed applications', () => {
  assert.equal(applicationFollowUpStatus('2026-10-16', '2026-10-17', false), 'overdue');
  assert.equal(applicationFollowUpStatus('2026-10-17', '2026-10-17', false), 'due-today');
  assert.equal(applicationFollowUpStatus('2026-10-18', '2026-10-17', false), 'upcoming');
  assert.equal(applicationFollowUpStatus('2026-10-16', '2026-10-17', true), 'none');
});
