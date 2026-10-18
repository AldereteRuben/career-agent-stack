import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobFeedbackMinimumSample, parseJobFeedback, summarizeJobFeedback } from '../src/job-match-feedback.js';

const now = new Date('2026-10-18T12:00:00.000Z');
const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);

test('explicit job feedback accepts only a rating and optional supported reason', () => {
  assert.deepEqual(parseJobFeedback({ rating: 'NOT_FOR_ME', reason: 'WORK_MODE' }), { rating: 'NOT_FOR_ME', reason: 'WORK_MODE' });
  assert.deepEqual(parseJobFeedback({ rating: 'INTERESTED' }), { rating: 'INTERESTED', reason: null });
  assert.equal(parseJobFeedback({ rating: 'SEEN' }), null);
  assert.equal(parseJobFeedback({ rating: 'INTERESTED', reason: 'SALARY' }), null);
  assert.equal(parseJobFeedback({ rating: 'INTERESTED', hidden: true }), null);
});

test('feedback summary is limited to 90 days and hides patterns below five explicit negative ratings', () => {
  const sparse = summarizeJobFeedback([
    ...Array.from({ length: jobFeedbackMinimumSample - 1 }, () => ({ rating: 'NOT_FOR_ME' as const, reason: 'LOCATION' as const, updatedAt: at(1) })),
    { rating: 'NOT_FOR_ME', reason: 'WORK_MODE', updatedAt: at(91) },
    { rating: 'INTERESTED', reason: null, updatedAt: at(2) },
  ], now);
  assert.equal(sparse.total, 5); assert.equal(sparse.notForMe, 4); assert.deepEqual(sparse.patterns, []);

  const enough = summarizeJobFeedback(Array.from({ length: jobFeedbackMinimumSample }, () => ({ rating: 'NOT_FOR_ME' as const, reason: 'LOCATION' as const, updatedAt: at(1) })), now);
  assert.equal(enough.notForMe, jobFeedbackMinimumSample);
  assert.deepEqual(enough.patterns, [{ reason: 'LOCATION', count: jobFeedbackMinimumSample }]);
  assert.equal(enough.windowDays, 90);
});

test('editing an old feedback record brings its current rating into the recent summary', () => {
  const edited = summarizeJobFeedback([
    { rating: 'NOT_FOR_ME', reason: 'LOCATION', createdAt: at(120), updatedAt: at(1) },
  ], now);
  assert.equal(edited.total, 1);
  assert.equal(edited.notForMe, 1);
  assert.deepEqual(edited.patterns, []);
});
