import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateTrackingMetrics, parseTrackingPeriod, trackingMetricsStart } from '../src/tracking-metrics.js';

const now = new Date('2026-10-18T12:00:00Z');
const apps = [
  { id: 'interview', state: 'CONFIRMED', recruitmentStage: 'REJECTED' },
  { id: 'corrected', state: 'CONFIRMED', recruitmentStage: 'REJECTED' },
  { id: 'recent', state: 'CONFIRMED', recruitmentStage: 'NO_RESPONSE' },
  { id: 'old', state: 'CONFIRMED', recruitmentStage: 'NO_RESPONSE' },
  { id: 'cancelled', state: 'CANCELLED', recruitmentStage: 'NO_RESPONSE' },
  { id: 'draft', state: 'DRAFT', recruitmentStage: 'NO_RESPONSE' },
];
const events = [
  { applicationId: 'interview', eventType: 'MANUAL_APPLICATION_RECORDED', newState: 'CONFIRMED', createdAt: '2026-10-10T12:00:00Z' },
  { applicationId: 'interview', eventType: 'RECRUITMENT_STAGE_CHANGED', newState: 'INTERVIEW', createdAt: '2026-10-11T12:00:00Z' },
  { applicationId: 'interview', eventType: 'RECRUITMENT_STAGE_CHANGED', newState: 'REJECTED', createdAt: '2026-10-12T12:00:00Z' },
  { applicationId: 'corrected', eventType: 'MANUAL_APPLICATION_RECORDED', newState: 'CONFIRMED', createdAt: '2026-10-10T12:00:00Z' },
  { applicationId: 'corrected', eventType: 'RECRUITMENT_STAGE_CHANGED', newState: 'INTERVIEW', createdAt: '2026-10-11T12:00:00Z' },
  { applicationId: 'corrected', eventType: 'RECRUITMENT_STAGE_CORRECTED', newState: 'ASSESSMENT', createdAt: '2026-10-12T12:00:00Z' },
  { applicationId: 'corrected', eventType: 'RECRUITMENT_STAGE_CHANGED', newState: 'REJECTED', createdAt: '2026-10-13T12:00:00Z' },
  { applicationId: 'recent', eventType: 'APPLICATION_STATE_CHANGED', newState: 'CONFIRMED', createdAt: '2026-10-15T12:00:00Z' },
  { applicationId: 'old', eventType: 'ASSIST_SUBMISSION_CONFIRMED', newState: 'CONFIRMED', createdAt: '2026-10-01T12:00:00Z' },
  { applicationId: 'cancelled', eventType: 'MANUAL_APPLICATION_RECORDED', newState: 'CONFIRMED', createdAt: '2026-10-10T12:00:00Z' },
  { applicationId: 'draft', eventType: 'APPLICATION_CREATED', newState: 'DRAFT', createdAt: '2026-10-10T12:00:00Z' },
];

test('tracking metrics validate periods and use rolling UTC windows', () => {
  assert.equal(parseTrackingPeriod(undefined), '90d');
  assert.equal(parseTrackingPeriod('30d'), '30d');
  assert.equal(parseTrackingPeriod('all'), 'all');
  assert.equal(parseTrackingPeriod('7d'), null);
  assert.equal(trackingMetricsStart('30d', now)?.toISOString(), '2026-09-18T12:00:00.000Z');
  assert.equal(trackingMetricsStart('all', now), null);
});

test('tracking metrics require confirmation evidence, exclude cancellations, and respect corrected stages', () => {
  assert.deepEqual(calculateTrackingMetrics({ period: '30d', now, applications: apps, events }), {
    period: '30d', periodStart: '2026-09-18T12:00:00.000Z', confirmed: 4, interviewed: 1,
    interviewConversionPercent: 25, noResponseYet: 1, noResponseAfter14Days: 1, noResponseThresholdDays: 14,
  });
});

test('an interview stage corrected away is not counted even if a later event closes the application', () => {
  const inputEvents = events.filter((event) => event.applicationId === 'corrected');
  const result = calculateTrackingMetrics({ period: 'all', now, applications: [apps[1]!], events: inputEvents });
  assert.equal(result.interviewed, 0);
  assert.equal(result.interviewConversionPercent, 0);
});
