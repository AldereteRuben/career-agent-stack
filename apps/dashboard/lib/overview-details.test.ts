import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overviewDetailsOpen, type OverviewDetailsState } from './overview-details';

const empty: OverviewDetailsState = { totalJobs: 0, totalApplications: 0, pendingFacts: 0, unansweredItems: 0, needsReview: 0, pendingResumes: 0 };

test('overview details start closed for a new workspace with nothing to review', () => {
  assert.equal(overviewDetailsOpen(empty), false);
});

test('overview details open for each kind of pending review, even with no jobs or applications', () => {
  for (const key of ['pendingFacts', 'unansweredItems', 'needsReview', 'pendingResumes'] as const) {
    assert.equal(overviewDetailsOpen({ ...empty, [key]: 1 }), true, key);
  }
});

test('overview details open once there are jobs or applications to look at', () => {
  assert.equal(overviewDetailsOpen({ ...empty, totalJobs: 3 }), true);
  assert.equal(overviewDetailsOpen({ ...empty, totalApplications: 1 }), true);
});
