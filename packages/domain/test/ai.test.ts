import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  aiConsentSchema, aiOutputSchema, aiSourceSnapshotSchema, applyAiRunEvent, canAutoRetryAiRun, canonicalAiReuseKey, checkAiConsent, aiSnapshotDataCategories,
  decideAiArtifact, normalizeAiUsage, normalizeEvidenceText, validateAiOutput, type AiConsent, type AiRunRecord, type AiSourceSnapshot,
} from '../src/ai.js';

const h = (char: string) => char.repeat(64);
const jobText = 'Senior Designer at Example. You will lead the design system.\nRequired: 5 years of product design experience. Nice to have: Figma plugins.';
const snapshot = (patch: Partial<AiSourceSnapshot> = {}): AiSourceSnapshot => ({
  schemaVersion: 1, snapshotId: 'snap-1', workspaceId: 'ws-a', operation: 'JOB_ANALYSIS', locale: 'en', snapshotHash: h('a'),
  searchRequest: null, job: { jobId: 'job-1', canonicalIdentity: 'greenhouse:example:1', normalizedText: jobText, contentHash: h('b') },
  question: null, facts: [{ factId: 'fact-1', approvalStatus: 'USER_APPROVED', kind: 'experience', text: 'Led a design system used by 40 engineers.', contentHash: h('c') }],
  profileRevision: 3, identityFingerprint: h('d'), ...patch,
});
const analysis = (patch: Record<string, unknown> = {}) => ({
  schemaVersion: 1, operation: 'JOB_ANALYSIS', locale: 'en',
  summary: [{ text: 'Design system lead role.', citations: [{ quote: 'lead the   design system' }] }],
  requirements: [{ text: 'Five years of product design.', level: 'REQUIRED', citations: [{ quote: '5 years of product design experience' }] }],
  personalMatches: [{ text: 'You led a design system.', strength: 'STRONG', jobCitations: [{ quote: 'lead the design system' }], factIds: ['fact-1'] }],
  gaps: [], warnings: [], ...patch,
});
const expected = { workspaceId: 'ws-a', operation: 'JOB_ANALYSIS', locale: 'en' } as const;

test('a job analysis with citations in the posting and facts from the snapshot is accepted', () => {
  const result = validateAiOutput(analysis(), snapshot(), expected);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('quotes are matched against normalized source text, not paraphrases', () => {
  assert.equal(normalizeEvidenceText('  Lead THE\n design ’system’ '), "lead the design 'system'");
  const result = validateAiOutput(analysis({ summary: [{ text: 'x', citations: [{ quote: 'leads the design systems' }] }] }), snapshot(), expected);
  assert.deepEqual(result.ok ? [] : result.issues.map((issue) => [issue.code, issue.path.join('.')]), [['QUOTE_NOT_IN_SOURCE', 'summary.0.citations.0.quote']]);
});

test('fact IDs outside the snapshot are rejected, including valid IDs from another workspace', () => {
  const result = validateAiOutput(analysis({ personalMatches: [{ text: 'x', strength: 'PARTIAL', jobCitations: [{ quote: 'Figma plugins' }], factIds: ['fact-from-ws-b'] }] }), snapshot(), expected);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issues[0]?.code, 'UNKNOWN_FACT_ID');
});

test('a snapshot from another workspace or operation cannot validate an output', () => {
  const crossWorkspace = validateAiOutput(analysis(), snapshot({ workspaceId: 'ws-b' }), expected);
  assert.ok(!crossWorkspace.ok && crossWorkspace.issues.some((issue) => issue.code === 'WORKSPACE_MISMATCH'));
  const otherLocale = validateAiOutput(analysis({ locale: 'es' }), snapshot(), expected);
  assert.ok(!otherLocale.ok && otherLocale.issues.some((issue) => issue.code === 'LOCALE_MISMATCH'));
});

test('personal matches without a shared profile are not invented', () => {
  const result = validateAiOutput(analysis(), snapshot({ facts: [], profileRevision: null }), expected);
  assert.ok(!result.ok && result.issues.some((issue) => issue.code === 'PERSONAL_CLAIM_WITHOUT_PROFILE'));
  assert.ok(!result.ok && result.issues.some((issue) => issue.code === 'UNKNOWN_FACT_ID'));
});

test('malformed outputs, commands and approval fields are rejected by the strict schema', () => {
  for (const raw of [
    analysis({ command: 'rm -rf ~' }), analysis({ approved: true }), analysis({ tools: [{ name: 'shell' }] }),
    analysis({ summary: [] }), analysis({ schemaVersion: 2 }), { ...analysis(), operation: 'RESUME_DRAFT' }, '{"operation":"JOB_ANALYSIS"}', null,
    analysis({ personalMatches: [{ text: 'x', strength: 'STRONG', jobCitations: [{ quote: 'lead the design system' }], factIds: [] }] }),
    analysis({ requirements: [{ text: 'x', level: 'REQUIRED', citations: [{ quote: 'Figma plugins', approvalStatus: 'USER_APPROVED' }] }] }),
  ]) {
    const result = validateAiOutput(raw, snapshot(), expected);
    assert.ok(!result.ok && result.issues.every((issue) => issue.code === 'INVALID_OUTPUT'), JSON.stringify(raw));
  }
  const resume = { schemaVersion: 1, operation: 'RESUME_DRAFT', locale: 'en', warnings: [], proposals: [{ proposalKey: 'p1', section: 'experience', text: 'Led.', sourceFactIds: ['fact-1'], changeExplanation: 'Shorter.', warnings: [], approvalStatus: 'USER_APPROVED' }] };
  assert.equal(aiOutputSchema.safeParse(resume).success, false);
});

test('snapshots carry only approved facts and the inputs each operation needs', () => {
  assert.equal(aiSourceSnapshotSchema.safeParse(snapshot()).success, true);
  assert.equal(aiSourceSnapshotSchema.safeParse(snapshot({ facts: [{ ...snapshot().facts[0]!, approvalStatus: 'SUGGESTED' as 'USER_APPROVED' }] })).success, false);
  assert.equal(aiSourceSnapshotSchema.safeParse(snapshot({ job: null })).success, false);
  assert.equal(aiSourceSnapshotSchema.safeParse(snapshot({ snapshotHash: 'not-a-hash' })).success, false);
  assert.equal(aiSourceSnapshotSchema.safeParse(snapshot({ facts: [snapshot().facts[0]!, snapshot().facts[0]!] })).success, false);
  assert.equal(aiSourceSnapshotSchema.safeParse(snapshot({ operation: 'SEARCH_DRAFT', searchRequest: { text: 'designer', contentHash: h('e') } })).success, false);
});

test('search drafts keep supported filters and list unsupported constraints instead of dropping them', () => {
  const request = 'Remote product designer roles in Madrid paying at least 60k €, permanent contract';
  const searchSnapshot = snapshot({ operation: 'SEARCH_DRAFT', job: null, facts: [], profileRevision: null, searchRequest: { text: request, contentHash: h('e') } });
  const draft = (unsupportedConstraints: unknown[]) => ({
    schemaVersion: 1, operation: 'SEARCH_DRAFT', locale: 'en', criteria: { role: 'Product designer', company: null, location: 'Madrid', workMode: 'remote' },
    unsupportedConstraints, clarifications: [{ question: 'Is hybrid acceptable?' }],
  });
  const searchExpected = { workspaceId: 'ws-a', operation: 'SEARCH_DRAFT', locale: 'en' } as const;
  const complete = validateAiOutput(draft([
    { kind: 'SALARY', requestQuote: 'paying at least 60k €', explanation: 'Salary is not a supported filter.' },
    { kind: 'CONTRACT_TYPE', requestQuote: 'permanent contract', explanation: 'Contract type is not a supported filter.' },
  ]), searchSnapshot, searchExpected);
  assert.equal(complete.ok, true, JSON.stringify(complete));
  const dropped = validateAiOutput(draft([]), searchSnapshot, searchExpected);
  assert.ok(!dropped.ok && dropped.issues.some((issue) => issue.code === 'UNSUPPORTED_CONSTRAINT_DROPPED'));
  const invented = validateAiOutput(draft([{ kind: 'SALARY', requestQuote: 'at least 90k', explanation: 'x' }]), searchSnapshot, searchExpected);
  assert.ok(!invented.ok && invented.issues.some((issue) => issue.code === 'QUOTE_NOT_IN_SOURCE'));
  assert.equal(aiOutputSchema.safeParse({ ...draft([]), criteria: { role: 'x', company: null, location: null, workMode: 'remote', salaryMin: 60000 } }).success, false);
});

test('answers are either a request for the person or a draft with evidence', () => {
  const answerSnapshot = snapshot({ operation: 'ANSWER_DRAFT', job: null, question: { questionId: 'q-1', text: 'Describe a design system you led.', contentHash: h('f'), answerPolicy: 'EXPERIENCE_DRAFT' } });
  const answerExpected = { workspaceId: 'ws-a', operation: 'ANSWER_DRAFT', locale: 'en' } as const;
  const answer = (result: unknown, questionId = 'q-1') => ({ schemaVersion: 1, operation: 'ANSWER_DRAFT', locale: 'en', questionId, result });
  assert.equal(validateAiOutput(answer({ status: 'DRAFT', text: 'I led one.', evidence: [{ factId: 'fact-1', quote: 'used by 40 engineers' }] }), answerSnapshot, answerExpected).ok, true);
  assert.equal(validateAiOutput(answer({ status: 'NEEDS_USER_INPUT', reason: 'LEGAL_OR_SENSITIVE', explanation: 'Work permit status is yours to state.' }), answerSnapshot, answerExpected).ok, true);
  for (const bad of [{ status: 'DRAFT', text: 'I led one.', evidence: [] }, { status: 'NEEDS_USER_INPUT', explanation: 'No reason' }, { status: 'DRAFT', text: 'x', evidence: [{ factId: 'fact-1' }], approved: true }]) {
    assert.equal(validateAiOutput(answer(bad), answerSnapshot, answerExpected).ok, false);
  }
  const wrongQuestion = validateAiOutput(answer({ status: 'NEEDS_USER_INPUT', reason: 'MISSING_FACT', explanation: 'x' }, 'q-2'), answerSnapshot, answerExpected);
  assert.ok(!wrongQuestion.ok && wrongQuestion.issues.some((issue) => issue.code === 'QUESTION_MISMATCH'));
  const misquoted = validateAiOutput(answer({ status: 'DRAFT', text: 'x', evidence: [{ factId: 'fact-1', quote: 'used by 400 engineers' }] }), answerSnapshot, answerExpected);
  assert.ok(!misquoted.ok && misquoted.issues.some((issue) => issue.code === 'QUOTE_NOT_IN_SOURCE'));
});

const consent: AiConsent = aiConsentSchema.parse({
  consentId: 'c-1', workspaceId: 'ws-a', connectionId: 'conn-1', provider: 'codex', accountFingerprint: h('1'), connectionRevision: 2, revision: 1,
  operation: 'RESUME_DRAFT', dataCategories: ['JOB_POSTING', 'APPROVED_FACTS'], searchIds: null, noticeVersion: '2026-10', grantedAt: '2026-10-01T10:00:00Z', revokedAt: null,
});
const consentRequest = { workspaceId: 'ws-a', connectionId: 'conn-1', provider: 'codex', accountFingerprint: h('1'), connectionRevision: 2, operation: 'RESUME_DRAFT', origin: 'MANUAL', dataCategories: ['JOB_POSTING', 'APPROVED_FACTS'], expectedConsentRevision: 1 } as const;

test('consent covers one operation, its data categories, the account and the revision it was granted for', () => {
  assert.deepEqual(checkAiConsent(consent, consentRequest), { ok: true });
  const issues = (patch: object, base: AiConsent | null = consent) => { const result = checkAiConsent(base, { ...consentRequest, ...patch }); return result.ok ? [] : result.issues; };
  assert.deepEqual(issues({ accountFingerprint: h('2') }), ['ACCOUNT_CHANGED']);
  assert.deepEqual(issues({ provider: 'claude-code' }), ['PROVIDER_CHANGED']);
  assert.deepEqual(issues({ workspaceId: 'ws-b' }), ['WORKSPACE_MISMATCH']);
  assert.deepEqual(issues({ expectedConsentRevision: 2 }), ['CONSENT_REVISION_CHANGED']);
  assert.deepEqual(issues({ operation: 'ANSWER_DRAFT' }), ['OPERATION_NOT_COVERED', 'DATA_CATEGORY_NOT_COVERED']);
  assert.deepEqual(issues({}, { ...consent, revokedAt: '2026-10-02T10:00:00Z' }), ['REVOKED']);
  assert.deepEqual(issues({}, { ...consent, dataCategories: ['JOB_POSTING'] }), ['DATA_CATEGORY_NOT_COVERED']);
  assert.deepEqual(issues({ origin: 'AUTOMATIC', searchId: 's-1' }), ['SEARCH_NOT_COVERED', 'AUTOMATION_NOT_SUPPORTED']);
  assert.deepEqual(issues({ origin: 'AUTOMATIC', searchId: 's-1' }, { ...consent, searchIds: ['s-1'] }), ['AUTOMATION_NOT_SUPPORTED']);
  assert.deepEqual(issues({}, null), ['OPERATION_NOT_COVERED']);
  assert.equal(aiConsentSchema.safeParse({ ...consent, dataCategories: ['JOB_POSTING', 'JOB_POSTING'] }).success, false);
  assert.equal(aiConsentSchema.safeParse({ ...consent, accessToken: 'secret' }).success, false);
});

test('run transitions reject stale leases, never adopt results after cancel and mark restarts as interrupted', () => {
  const queued: AiRunRecord = { state: 'QUEUED', leaseToken: null, error: null };
  const claimed = applyAiRunEvent(queued, { type: 'CLAIM', leaseToken: 'lease-1' });
  assert.ok(claimed.ok && claimed.run.state === 'RUNNING');
  const running = claimed.ok ? claimed.run : queued;
  assert.deepEqual(applyAiRunEvent(running, { type: 'SUCCEED', leaseToken: 'lease-0' }), { ok: false, reason: 'STALE_LEASE' });
  assert.equal(applyAiRunEvent(running, { type: 'SUCCEED', leaseToken: 'lease-1' }).ok, true);
  assert.deepEqual(applyAiRunEvent(running, { type: 'CLAIM', leaseToken: 'lease-2' }), { ok: false, reason: 'INVALID_TRANSITION' });

  const cancelRequested = applyAiRunEvent(running, { type: 'REQUEST_CANCEL' });
  assert.ok(cancelRequested.ok && cancelRequested.run.state === 'CANCEL_REQUESTED');
  if (cancelRequested.ok) {
    assert.deepEqual(applyAiRunEvent(cancelRequested.run, { type: 'SUCCEED', leaseToken: 'lease-1' }), { ok: false, reason: 'INVALID_TRANSITION' });
    assert.deepEqual(applyAiRunEvent(cancelRequested.run, { type: 'REQUEST_CANCEL' }), { ok: true, changed: false, run: cancelRequested.run });
    const cancelled = applyAiRunEvent(cancelRequested.run, { type: 'CONFIRM_CANCELLED', leaseToken: 'lease-1' });
    assert.ok(cancelled.ok && cancelled.run.state === 'CANCELLED' && cancelled.run.error?.dispatched === 'UNKNOWN');
  }
  const cancelledQueued = applyAiRunEvent(queued, { type: 'REQUEST_CANCEL' });
  assert.ok(cancelledQueued.ok && cancelledQueued.run.state === 'CANCELLED' && cancelledQueued.run.error?.dispatched === 'NO');

  const interrupted = applyAiRunEvent(running, { type: 'INTERRUPT' });
  assert.ok(interrupted.ok && interrupted.run.state === 'INTERRUPTED');
  assert.deepEqual(applyAiRunEvent(queued, { type: 'INTERRUPT' }), { ok: false, reason: 'INVALID_TRANSITION' });
  if (interrupted.ok) assert.equal(canAutoRetryAiRun(interrupted.run, 0), false);
});

test('automatic retries only happen when the provider never received the request', () => {
  const failed = (dispatched: 'NO' | 'YES' | 'UNKNOWN', code: 'PROVIDER_ERROR' | 'INVALID_OUTPUT' = 'PROVIDER_ERROR'): AiRunRecord => ({ state: 'FAILED', leaseToken: null, error: { code, dispatched } });
  assert.equal(canAutoRetryAiRun(failed('NO'), 0), true);
  assert.equal(canAutoRetryAiRun(failed('NO'), 2), false);
  assert.equal(canAutoRetryAiRun(failed('UNKNOWN'), 0), false);
  assert.equal(canAutoRetryAiRun(failed('YES'), 0), false);
  assert.equal(canAutoRetryAiRun(failed('NO', 'INVALID_OUTPUT'), 0), false);
  for (const code of ['CONSENT_REVOKED', 'ACCOUNT_CHANGED', 'BUDGET_EXHAUSTED', 'PROVIDER_LIMIT_REACHED', 'SOURCE_CHANGED', 'CANCELLED', 'INTERNAL'] as const) {
    assert.equal(canAutoRetryAiRun({ state: 'FAILED', leaseToken: null, error: { code, dispatched: 'NO' } }, 0), false);
  }
  for (const attempt of [-1, 0.5, NaN, Infinity]) assert.equal(canAutoRetryAiRun(failed('NO'), attempt), false);
  for (const maximum of [0, -1, 0.5, 3, Infinity]) assert.equal(canAutoRetryAiRun(failed('NO'), 0, maximum), false);
});

test('artifacts are accepted only by a person, at the expected revision, with unchanged sources', () => {
  const pending = { workspaceId: 'ws-a', state: 'PENDING_REVIEW', revision: 1, snapshotHash: h('a') } as const;
  const accept = { type: 'ACCEPT', actor: 'USER', workspaceId: 'ws-a', expectedRevision: 1, currentSnapshotHash: h('a') } as const;
  const accepted = decideAiArtifact(pending, accept);
  assert.ok(accepted.ok && accepted.artifact.state === 'ACCEPTED' && accepted.artifact.revision === 2);
  assert.deepEqual(decideAiArtifact(pending, { ...accept, expectedRevision: 0 }), { ok: false, reason: 'REVISION_CONFLICT' });
  assert.deepEqual(decideAiArtifact(pending, { ...accept, workspaceId: 'ws-b' }), { ok: false, reason: 'WORKSPACE_MISMATCH' });
  assert.deepEqual(decideAiArtifact(pending, { ...accept, currentSnapshotHash: h('9') }), { ok: false, reason: 'SOURCE_CHANGED' });
  const stale = decideAiArtifact(pending, { type: 'MARK_STALE' });
  assert.ok(stale.ok);
  if (stale.ok) {
    assert.deepEqual(decideAiArtifact(stale.artifact, { ...accept, expectedRevision: 2 }), { ok: false, reason: 'INVALID_TRANSITION' });
    assert.equal(decideAiArtifact(stale.artifact, { type: 'DISMISS', actor: 'USER', workspaceId: 'ws-a', expectedRevision: 2 }).ok, true);
  }
});

test('usage keeps missing values as unavailable, clamps percentages and marks old readings stale', () => {
  const now = Date.parse('2026-10-04T12:00:00Z');
  const usage = normalizeAiUsage({ provider: 'codex', observedAt: '2026-10-04T11:58:00Z', source: 'PROVIDER_REPORTED', windows: [
    { windowId: 'five_hour', usedPercent: 140, resetsAt: '2026-10-04T15:00:00Z' }, { windowId: 'weekly', usedPercent: null },
  ] }, now);
  assert.equal(usage.availability, 'KNOWN');
  assert.deepEqual(usage.windows.map((window) => [window.usedPercent, window.remainingPercent, window.limitReached]), [[100, 0, null], [null, null, null]]);
  assert.deepEqual(usage.tokens, { input: null, output: null });
  assert.equal(usage.costUsd, null);
  assert.equal(usage.anyLimitReached, null);

  assert.equal(normalizeAiUsage({ provider: 'codex', observedAt: '2026-10-04T11:50:00Z', source: 'PROVIDER_REPORTED', windows: [{ windowId: 'w', usedPercent: 10 }] }, now).availability, 'STALE');
  const empty = normalizeAiUsage({ provider: 'claude-code', observedAt: null, source: 'NONE', windows: [] }, now);
  assert.equal(empty.availability, 'UNAVAILABLE');
  const noValues = normalizeAiUsage({ provider: 'claude-code', observedAt: '2026-10-04T11:59:00Z', source: 'PROVIDER_REPORTED', windows: [{ windowId: 'w' }] }, now);
  assert.equal(noValues.availability, 'UNAVAILABLE');
  const reached = normalizeAiUsage({ provider: 'claude-code', observedAt: '2026-10-04T11:59:00Z', source: 'RUN_EVENT', windows: [{ windowId: 'w', limitReached: true }], tokens: { input: 0, output: 12.7 }, costUsd: -1 }, now);
  assert.equal(reached.anyLimitReached, true);
  assert.equal(reached.availability, 'KNOWN');
  assert.deepEqual(reached.tokens, { input: 0, output: 12 });
  assert.equal(reached.costUsd, null);
});

test('the reuse key is canonical over evidence order and changes with any identity input', () => {
  const identity = { workspaceId: 'ws-a', operation: 'RESUME_DRAFT', connectionId: 'conn-1', accountFingerprint: h('1'), locale: 'en', inputContentHash: h('a'), jobIdentity: 'gh:1', jobContentHash: h('b'), evidenceHashes: [h('c'), h('e')], questionHash: null, promptVersion: 'p1', schemaVersion: 1, configVersion: 'c1' } as const;
  assert.equal(canonicalAiReuseKey(identity), canonicalAiReuseKey({ ...identity, evidenceHashes: [h('e'), h('c'), h('c')] }));
  assert.notEqual(canonicalAiReuseKey(identity), canonicalAiReuseKey({ ...identity, workspaceId: 'ws-b' }));
  assert.notEqual(canonicalAiReuseKey(identity), canonicalAiReuseKey({ ...identity, locale: 'es' }));
  assert.notEqual(canonicalAiReuseKey(identity), canonicalAiReuseKey({ ...identity, jobContentHash: h('9') }));
  assert.notEqual(canonicalAiReuseKey(identity), canonicalAiReuseKey({ ...identity, inputContentHash: h('8') }));
});

test('job summaries do not authorize sharing approved profile facts implicitly', () => {
  const categories = aiSnapshotDataCategories(snapshot());
  const summaryConsent = { ...consent, operation: 'JOB_ANALYSIS' as const, dataCategories: ['JOB_POSTING'] as const };
  const request = { ...consentRequest, operation: 'JOB_ANALYSIS' as const, dataCategories: categories };
  const limited = checkAiConsent({ ...summaryConsent, dataCategories: [...summaryConsent.dataCategories] }, request);
  assert.ok(!limited.ok && limited.issues.includes('DATA_CATEGORY_NOT_COVERED'));
  assert.equal(checkAiConsent({ ...summaryConsent, dataCategories: [...categories] }, request).ok, true);
  assert.deepEqual(aiSnapshotDataCategories(snapshot({ facts: [], profileRevision: null })), ['JOB_POSTING']);
});

test('sensitive and unknown questions cannot be answered by citing unrelated approved experience', () => {
  const input = snapshot({ operation: 'ANSWER_DRAFT', job: null, question: { questionId: 'permit', text: 'Are you authorized to work here?', contentHash: h('f'), answerPolicy: 'USER_ONLY' } });
  const result = validateAiOutput({ schemaVersion: 1, operation: 'ANSWER_DRAFT', locale: 'en', questionId: 'permit', result: { status: 'DRAFT', text: 'Yes', evidence: [{ factId: 'fact-1' }] } }, input, { workspaceId: 'ws-a', operation: 'ANSWER_DRAFT', locale: 'en' });
  assert.ok(!result.ok && result.issues.some(issue => issue.code === 'PERSONAL_ANSWER_REQUIRED'));
});

test('individually valid facts cannot bypass the composed input size limit', () => {
  const base = snapshot();
  const oversized = { ...base, facts: Array.from({ length: 11 }, (_, index) => ({
    ...base.facts[0], factId: `fact-${index}`, text: 'x'.repeat(8000),
  })) };
  assert.equal(aiSourceSnapshotSchema.safeParse(oversized).success, false);
  assert.equal(aiSourceSnapshotSchema.safeParse(base).success, true);
});
