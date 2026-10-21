import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interviewEvidenceStatus, interviewPlanNeedsReview } from '../src/interview-preparation.js';

const stored = 'a'.repeat(64);

test('evidence is current only while its hash is unchanged', () => {
  assert.equal(interviewEvidenceStatus(stored, { hash: stored }), 'CURRENT');
  assert.equal(interviewEvidenceStatus(stored, { hash: 'b'.repeat(64) }), 'STALE');
});

test('a record that no longer exists is missing, not stale', () => {
  assert.equal(interviewEvidenceStatus(stored, null), 'MISSING');
  assert.equal(interviewEvidenceStatus(stored, undefined), 'MISSING');
});

test('a withdrawn fact is stale even when its text is unchanged', () => {
  assert.equal(interviewEvidenceStatus(stored, { hash: stored, withdrawn: true }), 'STALE');
});

test('a plan needs review as soon as one piece of evidence is not current', () => {
  assert.equal(interviewPlanNeedsReview([]), false);
  assert.equal(interviewPlanNeedsReview(['CURRENT', 'CURRENT']), false);
  assert.equal(interviewPlanNeedsReview(['CURRENT', 'STALE']), true);
  assert.equal(interviewPlanNeedsReview(['MISSING']), true);
});
