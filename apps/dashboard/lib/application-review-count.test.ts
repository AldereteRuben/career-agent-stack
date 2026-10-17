import assert from 'node:assert/strict';
import test from 'node:test';
import { countReviewItems, unqueuedReviewableResumes, type PreparationReviewItem } from './application-review-count';

test('counts preparations needing attention and ready resumes not represented in that queue', () => {
  assert.equal(countReviewItems([
    { needsAttention: true, documentId: 'resume-in-queue' },
    { needsAttention: true, documentId: null },
    { needsAttention: false, documentId: 'completed' },
  ], [
    { id: 'resume-in-queue', name: 'Queued', approvalStatus: 'PENDING_REVIEW', reviewReady: true },
    { id: 'resume-without-preparation', name: 'Standalone', approvalStatus: 'PENDING_REVIEW', reviewReady: true },
    { id: 'stale-resume', name: 'Stale', approvalStatus: 'PENDING_REVIEW', reviewReady: false },
    { id: 'approved-resume', name: 'Approved', approvalStatus: 'USER_APPROVED', reviewReady: true },
  ]), 3);
  assert.deepEqual(unqueuedReviewableResumes([
    { needsAttention: true, documentId: 'resume-in-queue' },
    { needsAttention: true, documentId: null },
    { needsAttention: false, documentId: 'completed' },
  ], [
    { id: 'resume-in-queue', name: 'Queued', approvalStatus: 'PENDING_REVIEW', reviewReady: true },
    { id: 'resume-without-preparation', name: 'Standalone', approvalStatus: 'PENDING_REVIEW', reviewReady: true },
    { id: 'stale-resume', name: 'Stale', approvalStatus: 'PENDING_REVIEW', reviewReady: false },
    { id: 'approved-resume', name: 'Approved', approvalStatus: 'USER_APPROVED', reviewReady: true },
  ]).map(({ id, name }) => ({ id, name })), [{ id: 'resume-without-preparation', name: 'Standalone' }]);
});

test('removes a resume from the count as soon as it is approved', () => {
  const preparation: PreparationReviewItem[] = [];
  const pending = [{ id: 'resume', name: 'Resume', approvalStatus: 'PENDING_REVIEW', reviewReady: true }];
  assert.equal(countReviewItems(preparation, pending), 1);
  assert.equal(countReviewItems(preparation, [{ ...pending[0]!, approvalStatus: 'USER_APPROVED' }]), 0);
});
