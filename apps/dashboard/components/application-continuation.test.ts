import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gapContinuation, queueActions, type QueueItem } from './application-continuation';

const item = (patch: Partial<QueueItem>): QueueItem => ({ queueState: 'REVIEW_DOCUMENT', needsAttention: true, applicationId: 'app', documentId: 'doc', gaps: [], ...patch });
const primary = (value: QueueItem) => queueActions(value).filter((action) => action.primary).map((action) => action.kind);

test('missing identity leads before experience and job text', () => {
  assert.equal(gapContinuation(['RELEVANT_APPROVED_EVIDENCE_REQUIRED', 'FULL_NAME_REQUIRED', 'JOB_TEXT_UNAVAILABLE']), 'identity');
  assert.equal(gapContinuation(['JOB_TEXT_UNAVAILABLE', 'RELEVANT_APPROVED_EVIDENCE_REQUIRED']), 'experience');
  assert.equal(gapContinuation(['JOB_TEXT_UNAVAILABLE']), 'job-text');
  assert.equal(gapContinuation(['PREPARATION_OUTDATED']), null);
});

test('an approved resume continues the application; viewing the PDF is secondary', () => {
  assert.deepEqual(queueActions(item({ queueState: 'READY' })), [{ kind: 'continue', primary: true }, { kind: 'approved', primary: false }]);
});

test('a pending or outdated resume still leads to review', () => {
  assert.deepEqual(primary(item({})), ['review']);
  assert.deepEqual(primary(item({ queueState: 'STALE_DOCUMENT' })), ['update']);
  assert.deepEqual(queueActions(item({})).map((action) => action.kind), ['review', 'open']);
});

test('uncertain, closed and detail-blocked cards keep one valid action', () => {
  assert.deepEqual(queueActions(item({ queueState: 'UNCERTAIN' })), [{ kind: 'check', primary: true }]);
  assert.deepEqual(queueActions(item({ queueState: 'CLOSED', needsAttention: false })), [{ kind: 'open', primary: true }]);
  assert.deepEqual(primary(item({ queueState: 'NEEDS_DETAILS', documentId: null, gaps: ['EMAIL_REQUIRED'] })), [], 'The missing-details link is the only primary action');
  assert.deepEqual(queueActions(item({ queueState: 'JOB_CLOSED', needsAttention: false, applicationId: null, documentId: null })), []);
});
