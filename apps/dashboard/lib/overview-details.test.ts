import assert from 'node:assert/strict';
import { test } from 'node:test';
import { overviewDetailsOpen, type OverviewDetailsState } from './overview-details';

const empty: OverviewDetailsState = { pendingFacts: 0, unansweredItems: 0, needsReview: 0, pendingResumes: 0 };

test('overview details start closed when nothing needs review', () => {
  assert.equal(overviewDetailsOpen(empty), false);
});

test('overview details open for each kind of pending review', () => {
  for (const key of ['pendingFacts', 'unansweredItems', 'needsReview', 'pendingResumes'] as const) {
    assert.equal(overviewDetailsOpen({ ...empty, [key]: 1 }), true, key);
  }
});
