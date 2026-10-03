import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationPreparationBlockReason, findPriorPreparationResult, preparationGaps, preparationKey, selectRelevantPreparationFacts } from '../src/preparation-domain.js';

const approved = { id: 'approved', kind: 'skill_evidence', statement: 'Built Java API tests using REST Assured.', tags: ['java', 'api-testing'], approvalStatus: 'USER_APPROVED' };

test('selects relevant approved evidence with deterministic explanations and excludes unapproved claims', () => {
  const selected = selectRelevantPreparationFacts([approved, { ...approved, id: 'suggested', approvalStatus: 'SUGGESTED', statement: 'Java API tests' }], 'Senior QA Engineer: Java API testing and automation');
  assert.deepEqual(selected.map(({ id }) => id), ['approved']);
  assert.match(selected[0]!.reason, /java|api/i);
});

test('does not select unrelated evidence and reports recoverable missing evidence gaps', () => {
  assert.deepEqual(selectRelevantPreparationFacts([approved], 'Finance director, audit and tax'), []);
  assert.deepEqual(preparationGaps({ profileExists: true, fullName: 'Candidate', email: 'candidate@example.test', factCount: 0, jobTextAvailable: true }), ['RELEVANT_APPROVED_EVIDENCE_REQUIRED']);
});

test('preparation key lookup returns the persisted result once for the same profile and snapshot', () => {
  const result = { status: 'PREPARED', applicationId: 'application-1' };
  const events = [{ preparationKey: 'prior-key', result }];
  assert.equal(findPriorPreparationResult(events, 'prior-key'), result);
  assert.equal(findPriorPreparationResult(events, 'different-key'), undefined);
});

test('preparation key is stable per complete input and changes with profile, facts, answers, and locale', () => {
  const input = {
    profileRevisionId: 'profile-1', snapshotId: 'snapshot-1', locale: 'en' as const,
    identity: { fullName: 'Candidate', email: 'candidate@example.test' },
    facts: [{ id: 'fact-1', kind: 'skill_evidence', printedText: 'Built Java APIs.', tags: ['java'] }],
    answers: [{ id: 'answer-1', semanticKey: 'work_authorization', jurisdiction: 'ES', questionScope: 'Spain', revision: 1, value: 'yes' }],
  };
  const key = preparationKey(input);
  assert.equal(preparationKey(input), key);
  assert.notEqual(preparationKey({ ...input, profileRevisionId: 'profile-2' }), key);
  assert.notEqual(preparationKey({ ...input, snapshotId: 'snapshot-2' }), key);
  assert.notEqual(preparationKey({ ...input, locale: 'es' }), key);
  assert.notEqual(preparationKey({ ...input, facts: [{ ...input.facts[0]!, printedText: 'Built Java APIs and tests.' }] }), key);
  assert.notEqual(preparationKey({ ...input, identity: { ...input.identity, email: 'new@example.test' } }), key);
  assert.notEqual(preparationKey({ ...input, answers: [{ ...input.answers[0]!, value: 'no' }] }), key);
});

test('preserves confirmed, unknown, closed, and user-selected application documents', () => {
  assert.equal(applicationPreparationBlockReason({ state: 'CONFIRMED', recruitmentStage: 'NO_RESPONSE', documentId: null }), 'APPLICATION_CLOSED_OR_UNCERTAIN');
  assert.equal(applicationPreparationBlockReason({ state: 'UNKNOWN', recruitmentStage: 'NO_RESPONSE', documentId: null }), 'APPLICATION_CLOSED_OR_UNCERTAIN');
  assert.equal(applicationPreparationBlockReason({ state: 'DRAFT', recruitmentStage: 'NO_RESPONSE', documentId: 'user-doc' }), 'USER_SELECTED_DOCUMENT_PRESERVED');
  assert.equal(applicationPreparationBlockReason({ state: 'REVIEW_REQUIRED', recruitmentStage: 'NO_RESPONSE', documentId: 'generated-doc' }, 'generated-doc'), null);
  assert.equal(applicationPreparationBlockReason({ state: 'DRAFT', recruitmentStage: 'NO_RESPONSE', documentId: null }), null);
});
