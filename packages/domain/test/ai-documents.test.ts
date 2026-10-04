import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiSourceSnapshot, ResumeDraftOutput } from '../src/ai.js';
import {
  approveDerivedClaims, claimsFromResumeProposals, derivedClaimSchema, derivedClaimsBasisSchema, derivedClaimsCurrentness, documentClaimsContract,
  type CurrentFactState, type DerivedClaimsBasis, type DerivedClaimsState,
} from '../src/ai-documents.js';

const h = (char: string) => char.repeat(64);
const facts: Record<string, CurrentFactState> = {
  'fact-1': { factId: 'fact-1', workspaceId: 'ws-a', approvalStatus: 'USER_APPROVED', contentHash: h('c') },
  'fact-2': { factId: 'fact-2', workspaceId: 'ws-a', approvalStatus: 'USER_APPROVED', contentHash: h('d') },
};
const lookup = (overrides: Record<string, CurrentFactState | undefined> = {}) => (id: string) => (id in overrides ? overrides[id] : facts[id]);

const snapshot: AiSourceSnapshot = {
  schemaVersion: 1, snapshotId: 'snap-1', workspaceId: 'ws-a', operation: 'RESUME_DRAFT', locale: 'en', snapshotHash: h('a'), searchRequest: null,
  job: { jobId: 'job-1', canonicalIdentity: 'gh:1', normalizedText: 'Senior Designer. Lead the design system.', contentHash: h('b') }, question: null,
  facts: [
    { factId: 'fact-1', approvalStatus: 'USER_APPROVED', kind: 'experience', text: 'Led a design system.', contentHash: h('c') },
    { factId: 'fact-2', approvalStatus: 'USER_APPROVED', kind: 'skill', text: 'Figma.', contentHash: h('d') },
  ],
  profileRevision: 3, identityFingerprint: h('e'),
};
const output: ResumeDraftOutput = {
  schemaVersion: 1, operation: 'RESUME_DRAFT', locale: 'en', warnings: [],
  proposals: [
    { proposalKey: 'p1', section: 'experience', text: 'Led a design system adopted across teams.', sourceFactIds: ['fact-1'], changeExplanation: 'Emphasises the system.', warnings: [] },
    { proposalKey: 'p2', section: 'skill', text: 'Figma', sourceFactIds: ['fact-2'], changeExplanation: 'Unchanged.', warnings: [] },
  ],
};
const selections = [
  { proposalKey: 'p1', claimId: 'claim-1', finalText: 'Led a design system adopted across teams.', finalTextHash: h('1'), proposedTextHash: h('1') },
  { proposalKey: 'p2', claimId: 'claim-2', finalText: 'Figma (advanced)', finalTextHash: h('3'), proposedTextHash: h('2') },
];

function basis(): DerivedClaimsBasis {
  const result = claimsFromResumeProposals({ artifactId: 'art-1', workspaceId: 'ws-a', language: 'en', output, snapshot, selections, currentFact: lookup() });
  assert.ok(result.ok, JSON.stringify(result));
  return derivedClaimsBasisSchema.parse({
    claimsContractVersion: 1, workspaceId: 'ws-a', language: 'en', profileRevision: 3, identityFingerprint: h('e'),
    targetJob: { jobId: 'job-1', contentHash: h('b') }, claims: result.ok ? result.claims : [], approval: null,
  });
}
const state: DerivedClaimsState = { workspaceId: 'ws-a', identityFingerprint: h('e'), currentFact: lookup(), targetJobHash: h('b'), pdfHash: h('5') };

test('legacy documents keep their own contract', () => {
  assert.equal(documentClaimsContract({}), 'legacy');
  assert.equal(documentClaimsContract({ claimsContractVersion: null }), 'legacy');
  assert.equal(documentClaimsContract({ claimsContractVersion: 1 }), 'derived-v1');
  assert.equal(documentClaimsContract({ claimsContractVersion: 2 }), 'unsupported');
});

test('selected proposals keep their sources, snapshot fingerprints and record person edits', () => {
  const claims = basis().claims;
  assert.deepEqual(claims.map((claim) => [claim.claimId, claim.origin, claim.sourceFingerprints, claim.proposalKey]), [
    ['claim-1', 'AI', [{ factId: 'fact-1', contentHash: h('c') }], 'p1'],
    ['claim-2', 'AI_EDITED', [{ factId: 'fact-2', contentHash: h('d') }], 'p2'],
  ]);
  assert.equal(claims[1]?.text, 'Figma (advanced)');
});

test('proposals are not applied to profile data that changed after the snapshot', () => {
  const changed = claimsFromResumeProposals({ artifactId: 'art-1', workspaceId: 'ws-a', language: 'en', output, snapshot, selections, currentFact: lookup({ 'fact-1': { ...facts['fact-1']!, contentHash: h('9') } }) });
  assert.deepEqual(changed.ok ? [] : changed.issues, [{ code: 'SOURCE_CHANGED', proposalKey: 'p1', factId: 'fact-1' }]);
  const rejected = claimsFromResumeProposals({ artifactId: 'art-1', workspaceId: 'ws-a', language: 'en', output, snapshot, selections, currentFact: lookup({ 'fact-2': { ...facts['fact-2']!, approvalStatus: 'REJECTED' } }) });
  assert.equal(rejected.ok, false);
  const foreign = claimsFromResumeProposals({ artifactId: 'art-1', workspaceId: 'ws-b', language: 'en', output, snapshot, selections, currentFact: lookup() });
  assert.ok(!foreign.ok && foreign.issues.some((issue) => issue.code === 'WORKSPACE_MISMATCH'));
  const notInSnapshot = claimsFromResumeProposals({ artifactId: 'art-1', workspaceId: 'ws-a', language: 'en', snapshot, selections: selections.slice(0, 1), currentFact: lookup(),
    output: { ...output, proposals: [{ ...output.proposals[0]!, sourceFactIds: ['fact-other'] }] } });
  assert.deepEqual(notInSnapshot.ok ? [] : notInSnapshot.issues, [{ code: 'SOURCE_NOT_IN_SNAPSHOT', proposalKey: 'p1', factId: 'fact-other' }]);
  for (const bad of [[], [{ ...selections[0]!, proposalKey: 'nope' }], [selections[0]!, selections[0]!], [{ ...selections[0]!, finalText: '  ' }]]) {
    assert.equal(claimsFromResumeProposals({ artifactId: 'art-1', workspaceId: 'ws-a', language: 'en', output, snapshot, selections: bad, currentFact: lookup() }).ok, false);
  }
});

test('claims without sources or with inconsistent provenance are invalid', () => {
  const claim = basis().claims[0]!;
  assert.equal(derivedClaimSchema.safeParse({ ...claim, sourceFactIds: [], sourceFingerprints: [] }).success, false);
  assert.equal(derivedClaimSchema.safeParse({ ...claim, sourceFactIds: ['fact-1', 'fact-2'] }).success, false);
  assert.equal(derivedClaimSchema.safeParse({ ...claim, origin: 'MANUAL' }).success, false);
  assert.equal(derivedClaimSchema.safeParse({ ...claim, approved: true }).success, false);
  assert.equal(derivedClaimsBasisSchema.safeParse({ ...basis(), claims: [{ ...claim, language: 'es' }] }).success, false);
});

test('approval binds the exact texts and PDF; later edits require approval again', () => {
  const draft = basis();
  assert.equal(derivedClaimsCurrentness(draft, state).status, 'NEEDS_APPROVAL');
  const approved = approveDerivedClaims(draft, { expectedClaimTextHashes: [h('1'), h('3')], pdfHash: h('5'), approvedAt: '2026-10-04T12:00:00Z', state });
  assert.ok(approved.ok);
  if (!approved.ok) return;
  assert.deepEqual(derivedClaimsCurrentness(approved.basis, state), { status: 'CURRENT', issues: [] });
  assert.deepEqual(derivedClaimsCurrentness(approved.basis, { ...state, pdfHash: h('6') }).issues, [{ code: 'APPROVAL_PDF_CHANGED' }]);
  const edited = { ...approved.basis, claims: [{ ...approved.basis.claims[0]!, text: 'Led two design systems.', textHash: h('4') }, approved.basis.claims[1]!] };
  assert.deepEqual(derivedClaimsCurrentness(edited, state), { status: 'NEEDS_APPROVAL', issues: [{ code: 'APPROVAL_TEXT_CHANGED' }] });
  assert.deepEqual(approveDerivedClaims(draft, { expectedClaimTextHashes: [h('1')], pdfHash: h('5'), approvedAt: '2026-10-04T12:00:00Z', state }), { ok: false, reason: 'REVISION_CONFLICT', issues: [] });
  const stale = approveDerivedClaims(draft, { expectedClaimTextHashes: [h('1'), h('3')], pdfHash: h('5'), approvedAt: '2026-10-04T12:00:00Z', state: { ...state, currentFact: lookup({ 'fact-1': undefined }) } });
  assert.ok(!stale.ok && stale.reason === 'STALE');
});

test('identity, evidence and workspace changes make claims stale; a new posting needs adaptation review only', () => {
  const approved = approveDerivedClaims(basis(), { expectedClaimTextHashes: [h('1'), h('3')], pdfHash: h('5'), approvedAt: '2026-10-04T12:00:00Z', state });
  assert.ok(approved.ok);
  if (!approved.ok) return;
  const current = approved.basis;
  const codes = (patch: Partial<DerivedClaimsState>) => derivedClaimsCurrentness(current, { ...state, ...patch });
  assert.deepEqual(codes({ identityFingerprint: h('f') }), { status: 'STALE', issues: [{ code: 'IDENTITY_CHANGED' }] });
  assert.deepEqual(codes({ currentFact: lookup({ 'fact-2': { ...facts['fact-2']!, contentHash: h('8') } }) }).issues, [{ code: 'SOURCE_CHANGED', claimId: 'claim-2', factId: 'fact-2' }]);
  assert.deepEqual(codes({ currentFact: lookup({ 'fact-1': { ...facts['fact-1']!, approvalStatus: 'SUGGESTED' } }) }).issues, [{ code: 'SOURCE_NOT_APPROVED', claimId: 'claim-1', factId: 'fact-1' }]);
  assert.deepEqual(codes({ currentFact: lookup({ 'fact-1': { ...facts['fact-1']!, workspaceId: 'ws-b' } }) }).issues, [{ code: 'SOURCE_OTHER_WORKSPACE', claimId: 'claim-1', factId: 'fact-1' }]);
  assert.deepEqual(codes({ currentFact: lookup({ 'fact-1': undefined }) }).status, 'STALE');
  assert.deepEqual(codes({ workspaceId: 'ws-b' }).issues[0], { code: 'WORKSPACE_MISMATCH' });
  assert.deepEqual(codes({ targetJobHash: h('7') }), { status: 'NEEDS_ADAPTATION_REVIEW', issues: [{ code: 'TARGET_JOB_CHANGED' }] });
  assert.deepEqual(codes({ targetJobHash: null }).status, 'NEEDS_ADAPTATION_REVIEW');
  // Unrelated facts and preferences are not part of the basis, so their changes keep it current.
  assert.deepEqual(codes({ currentFact: lookup({ 'fact-3': { factId: 'fact-3', workspaceId: 'ws-a', approvalStatus: 'REJECTED', contentHash: h('0') } }) }).status, 'CURRENT');
});

test('approval rejects a different or missing preview PDF and invalid approval metadata', () => {
  const input = { expectedClaimTextHashes: [h('1'), h('3')], pdfHash: h('5'), approvedAt: '2026-10-04T12:00:00Z', state };
  assert.equal(approveDerivedClaims(basis(), { ...input, pdfHash: h('6') }).ok, false);
  assert.equal(approveDerivedClaims(basis(), { ...input, state: { ...state, pdfHash: null } }).ok, false);
  assert.equal(approveDerivedClaims(basis(), { ...input, approvedAt: 'invalid' }).ok, false);
});

test('claim identifiers are unique and the reviewed proposal language matches the snapshot', () => {
  const current = basis();
  assert.equal(derivedClaimsBasisSchema.safeParse({ ...current, claims: [current.claims[0], current.claims[0]] }).success, false);
  const result = claimsFromResumeProposals({ artifactId: 'art-1', workspaceId: 'ws-a', language: 'es', output, snapshot, selections, currentFact: lookup() });
  assert.ok(!result.ok && result.issues.some(issue => issue.code === 'LOCALE_MISMATCH'));
});
