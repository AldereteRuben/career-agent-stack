import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiOperationDataCategories, aiSnapshotDataCategories, aiSourceSnapshotSchema, validateAiOutput, checkAiConsent, type AiSourceSnapshot } from '../src/ai.js';

const workspaceId = 'workspace-1';
const hash = 'a'.repeat(64);
const snapshotWith = (interviewPrep: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, snapshotId: 'plan-1', workspaceId, operation: 'INTERVIEW_PREP', locale: 'en', snapshotHash: hash,
  searchRequest: null, job: null, question: null, facts: [], profileRevision: null, identityFingerprint: null,
  interviewPrep: {
    planId: 'plan-1', request: 'PRACTICE_QUESTIONS', stage: 'INTERVIEW',
    offer: { company: 'Synthetic Co', role: 'QA Engineer', location: null, title: 'QA Engineer', description: 'Requirements: TypeScript.' },
    resume: null, facts: [{ factId: 'fact-1', text: 'Built TypeScript services' }], notes: [],
    ...interviewPrep,
  },
  ...overrides,
});
const parse = (value: unknown) => aiSourceSnapshotSchema.safeParse(value);

test('an interview preparation snapshot carries only its own sources', () => {
  assert.equal(parse(snapshotWith()).success, true);
  assert.equal(parse(snapshotWith({}, { interviewPrep: undefined })).success, false, 'it needs its sources');
  for (const extra of [
    { searchRequest: { text: 'remote jobs', contentHash: hash } },
    { facts: [{ factId: 'x', approvalStatus: 'USER_APPROVED', kind: 'skill', text: 'a profile fact', contentHash: hash }], profileRevision: 1 },
    { identityFingerprint: hash },
    { resume: { text: 'whole resume text', contentHash: hash } },
  ]) assert.equal(parse(snapshotWith({}, extra)).success, false, 'no unrelated source can ride along');
  assert.equal(parse(snapshotWith({}, { operation: 'DOCUMENT_REWORD' })).success, false, 'its sources belong to its operation only');
});

test('duplicate facts or notes and unknown requests are rejected', () => {
  assert.equal(parse(snapshotWith({ facts: [{ factId: 'f', text: 'one' }, { factId: 'f', text: 'two' }] })).success, false);
  assert.equal(parse(snapshotWith({ notes: [{ noteId: 'n', text: 'one' }, { noteId: 'n', text: 'two' }] })).success, false);
  assert.equal(parse(snapshotWith({ request: 'LIVE_INTERVIEW_HELP' })).success, false);
});

test('the data categories shown to the person match what is included', () => {
  const only = parse(snapshotWith({ stage: null, facts: [] })).data as AiSourceSnapshot;
  assert.deepEqual(aiSnapshotDataCategories(only), ['JOB_POSTING']);
  const all = parse(snapshotWith({ resume: { text: 'Submitted resume text' }, notes: [{ noteId: 'n', text: 'My note' }] })).data as AiSourceSnapshot;
  assert.deepEqual([...aiSnapshotDataCategories(all)].sort(), ['APPROVED_FACTS', 'INTERVIEW_STAGE', 'JOB_POSTING', 'SUBMITTED_RESUME', 'USER_NOTES']);
  assert.deepEqual(aiOperationDataCategories.INTERVIEW_PREP, ['JOB_POSTING'], 'only the posting is always required');
});

test('a stored consent for another operation never covers interview preparation', () => {
  const consent = { consentId: 'c', workspaceId, connectionId: 'k', provider: 'codex' as const, accountFingerprint: hash, connectionRevision: 1, revision: 1, operation: 'JOB_ANALYSIS' as const,
    dataCategories: ['JOB_POSTING' as const, 'APPROVED_FACTS' as const], searchIds: null, noticeVersion: 'v', remembered: true, grantedAt: new Date().toISOString(), revokedAt: null };
  const result = checkAiConsent(consent as never, { workspaceId, connectionId: 'k', provider: 'codex', accountFingerprint: hash, connectionRevision: 1, operation: 'INTERVIEW_PREP', dataCategories: ['JOB_POSTING'], origin: 'MANUAL' });
  assert.equal(result.ok, false);
});

const output = (suggestions: unknown[], overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1, operation: 'INTERVIEW_PREP', locale: 'en', request: 'PRACTICE_QUESTIONS', suggestions, warnings: [], ...overrides });
const suggestion = (overrides: Record<string, unknown> = {}) => ({ key: 's1', kind: 'PRACTICE_QUESTION', text: 'Explain how you would test a login form.', hints: [], sourceFactIds: [], ...overrides });
const validate = (raw: unknown, request = 'PRACTICE_QUESTIONS') => validateAiOutput(raw, snapshotWith({ request }), { workspaceId, operation: 'INTERVIEW_PREP', locale: 'en' });

test('suggestions must match the request, cite only supplied facts and keep hints to coding problems', () => {
  assert.equal(validate(output([suggestion()])).ok, true);
  assert.equal(validate(output([suggestion({ sourceFactIds: ['fact-1'] })])).ok, true);
  assert.equal(validate(output([suggestion({ sourceFactIds: ['unrelated-fact'] })])).ok, false, 'a fact that was not supplied is unknown');
  assert.equal(validate(output([suggestion({ kind: 'STUDY_ITEM' })])).ok, false, 'one request, one kind');
  assert.equal(validate(output([suggestion()], { request: 'STUDY_ITEMS' })).ok, false, 'the output must echo the request made');
  assert.equal(validate(output([suggestion({ hints: ['a hint'] })])).ok, false, 'only coding hints carry hints');
  assert.equal(validate(output([suggestion({ kind: 'CODING_HINT', hints: [] })], { request: 'CODING_HINTS' }), 'CODING_HINTS').ok, false, 'a coding problem needs a hint');
  assert.equal(validate(output([suggestion({ kind: 'CODING_HINT', hints: ['Think about edge cases', 'Use a map'] })], { request: 'CODING_HINTS' }), 'CODING_HINTS').ok, true);
  assert.equal(validate(output([suggestion(), suggestion()])).ok, false, 'keys are unique');
  assert.equal(validate(output([])).ok, false, 'at least one suggestion');
  assert.equal(validate(output([suggestion()], { locale: 'es' })).ok, false, 'the language must match');
  assert.equal(validate({ ...output([suggestion()]), approved: true }).ok, false, 'no approval fields');
});
