import assert from 'node:assert/strict';
import test from 'node:test';
import { aiControlDay, checkAiReservation, checkAiStart, type AiQueueBudget } from '../src/ai-budget.js';

const nowMs = Date.parse('2026-10-04T23:59:59.000Z');
const budget: AiQueueBudget = { queuedManual: 0, queuedAutomatic: 0, automaticStarts: 0, startsDay: '2026-10-04' };
const reservation = { budget, origin: 'AUTOMATIC', operation: 'JOB_ANALYSIS', equivalentActive: false, automaticReservationsThisPass: 0, nowMs } as const;
const start = { budget, origin: 'AUTOMATIC', operation: 'JOB_ANALYSIS', workspaceRunning: 0, accountRunning: 0, nowMs } as const;

test('control days use UTC across month/year boundaries and equivalent local time zones', () => {
  assert.deepEqual(aiControlDay(nowMs), { day: '2026-10-04', resetsAt: '2026-10-05T00:00:00.000Z' });
  assert.deepEqual(aiControlDay(Date.parse('2026-10-05T01:59:59+02:00')), aiControlDay(nowMs));
  assert.equal(aiControlDay(Date.parse('2026-12-31T23:59:59Z')).resetsAt, '2027-01-01T00:00:00.000Z');
  assert.throws(() => aiControlDay(NaN), RangeError);
});

test('automatic admission bounds each pass, pending reservations and daily starts', () => {
  assert.equal(checkAiReservation(reservation).allowed, true);
  assert.deepEqual(checkAiReservation({ ...reservation, automaticReservationsThisPass: 5 }), { allowed: false, reason: 'PASS_LIMIT' });
  assert.deepEqual(checkAiReservation({ ...reservation, budget: { ...budget, automaticStarts: 8, queuedAutomatic: 2 } }), { allowed: false, reason: 'DAILY_LIMIT', resetsAt: '2026-10-05T00:00:00.000Z' });
  assert.equal(checkAiReservation({ ...reservation, budget: { ...budget, automaticStarts: 8, queuedAutomatic: 1 } }).allowed, true);
  assert.deepEqual(checkAiReservation({ ...reservation, operation: 'RESUME_DRAFT' }), { allowed: false, reason: 'AUTOMATION_NOT_SUPPORTED' });
});

test('manual requests have their own queue limit and do not inherit the automatic daily limit', () => {
  const manual = { ...reservation, origin: 'MANUAL' as const, operation: 'RESUME_DRAFT' as const, budget: { ...budget, automaticStarts: 10 } };
  assert.equal(checkAiReservation(manual).allowed, true);
  assert.deepEqual(checkAiReservation({ ...manual, budget: { ...manual.budget, queuedManual: 3 } }), { allowed: false, reason: 'MANUAL_QUEUE_FULL' });
  assert.deepEqual(checkAiReservation({ ...manual, budget: { ...budget, queuedAutomatic: 20 } }), { allowed: false, reason: 'QUEUE_FULL' });
  assert.deepEqual(checkAiReservation({ ...manual, equivalentActive: true }), { allowed: false, reason: 'EQUIVALENT_ACTIVE' });
});

test('midnight renews start allowance but keeps pending reservations and charges the dispatch day', () => {
  const nextDay = Date.parse('2026-10-05T00:00:00Z');
  const exhausted = { ...budget, automaticStarts: 10, queuedAutomatic: 1 };
  assert.equal(checkAiStart({ ...start, budget: exhausted }).allowed, false);
  assert.deepEqual(checkAiStart({ ...start, budget: exhausted, nowMs: nextDay }), { allowed: true, controlDay: '2026-10-05' });
  assert.equal(checkAiReservation({ ...reservation, budget: { ...exhausted, queuedAutomatic: 10 }, nowMs: nextDay }).allowed, false);
});

test('dispatch respects account and workspace exclusivity and lets waiting manual work go first', () => {
  assert.deepEqual(checkAiStart({ ...start, workspaceRunning: 1 }), { allowed: false, reason: 'WORKSPACE_BUSY' });
  assert.deepEqual(checkAiStart({ ...start, accountRunning: 1 }), { allowed: false, reason: 'ACCOUNT_BUSY' });
  assert.deepEqual(checkAiStart({ ...start, budget: { ...budget, queuedManual: 1 } }), { allowed: false, reason: 'MANUAL_FIRST' });
  assert.equal(checkAiStart({ ...start, origin: 'MANUAL', budget: { ...budget, automaticStarts: 10, queuedManual: 1 } }).allowed, true);
});

test('invalid counters, dates and a backwards system clock never renew the budget', () => {
  for (const invalid of [
    { ...budget, automaticStarts: -1 }, { ...budget, queuedManual: 0.5 }, { ...budget, queuedAutomatic: NaN },
    { ...budget, startsDay: '2026-02-30' }, { ...budget, startsDay: '2026-10-05' }, { ...budget, startsDay: 'tomorrow' },
  ]) {
    assert.deepEqual(checkAiReservation({ ...reservation, budget: invalid }), { allowed: false, reason: 'INVALID_STATE' });
    assert.deepEqual(checkAiStart({ ...start, budget: invalid }), { allowed: false, reason: 'INVALID_STATE' });
  }
});
