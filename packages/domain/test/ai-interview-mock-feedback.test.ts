import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiSnapshotDataCategories, aiSourceSnapshotSchema, validateAiOutput } from '../src/ai.js';

const workspaceId = 'workspace-fictional';
const answer = 'At Example Co, I built a Playwright suite and reduced release regressions.';
const snapshot = aiSourceSnapshotSchema.parse({
  schemaVersion: 1, snapshotId: 'turn-fictional', workspaceId, operation: 'INTERVIEW_MOCK_FEEDBACK', locale: 'en', snapshotHash: 'a'.repeat(64),
  searchRequest: null, job: null, question: null, facts: [{ factId: 'fact-fictional', approvalStatus: 'USER_APPROVED', kind: 'achievement', text: 'Built a Playwright suite at Example Co', contentHash: 'b'.repeat(64) }],
  profileRevision: 2, identityFingerprint: null,
  interviewMockFeedback: { planId: 'plan-fictional', sessionId: 'session-fictional', turnId: 'turn-fictional', question: 'Tell me about a testing improvement.', answer },
});
const output = {
  schemaVersion: 1, operation: 'INTERVIEW_MOCK_FEEDBACK', locale: 'en', summary: 'You described an action and result.',
  strengths: [{ answerQuote: 'I built a Playwright suite', note: 'This gives a concrete example.' }],
  improvements: ['Add a number that shows the change.'],
  claimsToVerify: [{ answerQuote: 'reduced release regressions', note: 'Be ready to explain how you measured this.' }],
  evidenceFactIds: ['fact-fictional'], warnings: [],
};

test('mock feedback snapshots contain only a selected practice answer and user-selected facts', () => {
  assert.deepEqual([...aiSnapshotDataCategories(snapshot)].sort(), ['APPROVED_FACTS', 'INTERVIEW_QUESTION', 'MOCK_ANSWER']);
  assert.equal(validateAiOutput(output, snapshot, { workspaceId, operation: 'INTERVIEW_MOCK_FEEDBACK', locale: 'en' }).ok, true);
});

test('mock feedback rejects invented quotes, unsent facts, and unrelated source data', () => {
  assert.equal(validateAiOutput({ ...output, strengths: [{ answerQuote: 'I led a team of forty people', note: 'Great work.' }] }, snapshot, { workspaceId, operation: 'INTERVIEW_MOCK_FEEDBACK', locale: 'en' }).ok, false);
  assert.equal(validateAiOutput({ ...output, evidenceFactIds: ['not-selected'] }, snapshot, { workspaceId, operation: 'INTERVIEW_MOCK_FEEDBACK', locale: 'en' }).ok, false);
  assert.equal(aiSourceSnapshotSchema.safeParse({ ...snapshot, job: { company: 'Fictional Co' } }).success, false);
  assert.equal(aiSourceSnapshotSchema.safeParse({ ...snapshot, interviewPrep: { planId: 'other' } }).success, false);
});
