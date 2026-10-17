import assert from 'node:assert/strict';
import test from 'node:test';
import { countReviewItems, type PreparationReviewItem } from './application-review-count';

test('counts preparations needing attention and ready resumes not represented in that queue', () => {
  assert.equal(countReviewItems([
    { needsAttention: true, documentId: 'resume-in-queue' },
    { needsAttention: true, documentId: null },
    { needsAttention: false, documentId: 'completed' },
  ], [
    { id: 'resume-in-queue', approvalStatus: 'PENDING_REVIEW', reviewReady: true },
    { id: 'resume-without-preparation', approvalStatus: 'PENDING_REVIEW', reviewReady: true },
    { id: 'stale-resume', approvalStatus: 'PENDING_REVIEW', reviewReady: false },
    { id: 'approved-resume', approvalStatus: 'USER_APPROVED', reviewReady: true },
  ]), 3);
});

test('removes a resume from the count as soon as it is approved', () => {
  const preparation: PreparationReviewItem[] = [];
  const pending = [{ id: 'resume', approvalStatus: 'PENDING_REVIEW', reviewReady: true }];
  assert.equal(countReviewItems(preparation, pending), 1);
  assert.equal(countReviewItems(preparation, [{ ...pending[0]!, approvalStatus: 'USER_APPROVED' }]), 0);
});
