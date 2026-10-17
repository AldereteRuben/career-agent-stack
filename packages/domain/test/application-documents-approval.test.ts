import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  applicationDocumentCurrentness,
  applicationDocumentHashes,
  applicationDocumentRevisionSelection,
  approveApplicationDocumentRevision,
  createApplicationDocumentRevision,
  isApplicationDocumentRevisionSuperseded,
  latestApplicationDocumentOffer,
  mixedLanguageSentenceIds,
  type ApplicationDocumentFactSnapshot,
  type ApplicationDocumentOfferSnapshot,
  type ApplicationDocumentRevision,
  type ApplicationDocumentRevisionClaim,
} from '../src/application-document-lifecycle.js';

const workspaceId = 'workspace-a';
const facts: ApplicationDocumentFactSnapshot[] = [
  { id: 'fact-1', workspaceId, approval: 'USER_APPROVED', text: 'Diseñé interfaces React.' },
];
const offer: ApplicationDocumentOfferSnapshot = {
  workspaceId,
  company: 'Acme',
  role: 'Diseñadora',
  location: 'Madrid',
  snapshot: { id: 'snapshot-1', title: 'Diseñadora de producto', descriptionText: '  Experiencia\r\n con React  ' },
};
const claim: ApplicationDocumentRevisionClaim = {
  sentenceId: 'claim-1',
  text: 'Diseñé interfaces React.',
  kind: 'CANDIDATE_CLAIM',
  origin: 'BUILDER',
  sourceFactIds: ['fact-1'],
  language: 'es',
};

async function createRevision(overrides: Partial<Parameters<typeof createApplicationDocumentRevision>[0]> = {}) {
  const result = await createApplicationDocumentRevision({
    id: 'revision-1', workspaceId, documentId: 'document-1', language: 'es', claims: [claim], facts, offer,
    paperSize: 'A4', textSha256: 'a'.repeat(64), pdfSha256: 'b'.repeat(64), ...overrides,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.code);
  return result.revision;
}

function approveInput(revision: ApplicationDocumentRevision, overrides: Partial<Parameters<typeof approveApplicationDocumentRevision>[0]> = {}) {
  return {
    revision,
    newestRevisionId: revision.id,
    facts,
    offer,
    expectedContentHash: revision.contentHash,
    expectedFactsHash: revision.factsHash,
    expectedOfferHash: revision.offerHash,
    expectedTextSha256: revision.textSha256,
    expectedPdfSha256: revision.pdfSha256,
    storedTextSha256: revision.textSha256,
    storedPdfSha256: revision.pdfSha256,
    confirmedUnsupportedIds: [],
    approvedAt: '2026-10-17T20:00:00.000Z',
    approvedBy: 'user-1',
    ...overrides,
  };
}

test('revision hashes are SHA-256 over explicit stable offer fields and canonicalized description', async () => {
  const first = await applicationDocumentHashes({ workspaceId, claims: [claim], facts, offer });
  const second = await applicationDocumentHashes({
    workspaceId,
    claims: [claim],
    facts,
    offer: { ...offer, snapshot: { ...offer.snapshot!, id: 'snapshot-2', descriptionText: 'Experiencia con React' } },
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!first.ok || !second.ok) return;
  for (const value of [first.contentHash, first.factsHash, first.offerHash]) assert.match(value, /^[a-f0-9]{64}$/u);
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.factsHash, second.factsHash);
  assert.equal(first.offerHash, second.offerHash);
  assert.notEqual(first.offerSnapshotId, second.offerSnapshotId);
  assert.equal(first.offerHash, createHash('sha256').update(JSON.stringify({
    company: 'Acme', role: 'Diseñadora', location: 'Madrid', title: 'Diseñadora de producto', description: 'Experiencia con React',
  })).digest('hex'));
  const changedDescription = await applicationDocumentHashes({
    workspaceId, claims: [claim], facts,
    offer: { ...offer, snapshot: { ...offer.snapshot!, descriptionText: 'React and design systems.' } },
  });
  assert.equal(changedDescription.ok, true);
  if (first.ok && changedDescription.ok) assert.notEqual(first.offerHash, changedDescription.offerHash);
});

test('fact changes affect factsHash and material offer changes affect offerHash', async () => {
  const baseline = await applicationDocumentHashes({ workspaceId, claims: [claim], facts, offer });
  const changedFact = await applicationDocumentHashes({ workspaceId, claims: [claim], facts: [{ ...facts[0]!, text: 'Trabajé con React.' }], offer });
  const changedTitle = await applicationDocumentHashes({ workspaceId, claims: [claim], facts, offer: { ...offer, snapshot: { ...offer.snapshot!, title: 'Senior Product Designer' } } });
  assert.equal(baseline.ok && changedFact.ok && changedTitle.ok, true);
  if (!baseline.ok || !changedFact.ok || !changedTitle.ok) return;
  assert.notEqual(baseline.factsHash, changedFact.factsHash);
  const changedTags = await applicationDocumentHashes({ workspaceId, claims: [claim], facts: [{ ...facts[0]!, tags: ['react', 'payments'] }], offer });
  assert.notEqual(baseline.factsHash, changedTags.factsHash);
  assert.notEqual(baseline.offerHash, changedTitle.offerHash);
  const changedApplicationFields = await applicationDocumentHashes({
    workspaceId,
    claims: [claim],
    facts,
    offer: { ...offer, company: 'Other Co', role: 'Other role', location: 'Valencia' },
  });
  assert.equal(changedApplicationFields.ok, true);
  if (baseline.ok && changedApplicationFields.ok) assert.notEqual(baseline.offerHash, changedApplicationFields.offerHash);
});

test('duplicate sentence ids are refused when creating a revision', async () => {
  const duplicate = await createApplicationDocumentRevision({
    id: 'revision-duplicate', workspaceId, documentId: 'document-1', language: 'es', claims: [claim, { ...claim, text: 'Otra frase.' }],
    facts, offer, paperSize: 'A4', textSha256: 'a'.repeat(64), pdfSha256: 'b'.repeat(64),
  });
  assert.deepEqual(duplicate, { ok: false, code: 'INVALID_CLAIM', issue: { code: 'DUPLICATE_SENTENCE_ID', sentenceId: claim.sentenceId } });
});

test('latest offer snapshot uses fetched time then id, and null description hashes like empty text', async () => {
  const selected = latestApplicationDocumentOffer({
    workspaceId, company: 'Application Co', role: 'Application Role', location: 'Madrid',
    snapshots: [
      { id: 'older', title: 'Old', descriptionText: 'old', fetchedAt: '2026-10-16T10:00:00.000Z' },
      { id: 'snapshot-a', title: 'Title', descriptionText: null, fetchedAt: '2026-10-17T10:00:00.000Z' },
      { id: 'snapshot-b', title: 'Title', descriptionText: '', fetchedAt: '2026-10-17T10:00:00.000Z' },
    ],
  });
  assert.equal(selected.company, 'Application Co');
  assert.equal(selected.role, 'Application Role');
  assert.equal(selected.snapshot?.id, 'snapshot-b');
  const nullDescription = await applicationDocumentHashes({ workspaceId, claims: [claim], facts, offer: { ...selected, snapshot: { id: 'null', title: 'Title', descriptionText: null } } });
  const emptyDescription = await applicationDocumentHashes({ workspaceId, claims: [claim], facts, offer: { ...selected, snapshot: { id: 'empty', title: 'Title', descriptionText: '' } } });
  assert.equal(nullDescription.ok && emptyDescription.ok, true);
  if (nullDescription.ok && emptyDescription.ok) assert.equal(nullDescription.offerHash, emptyDescription.offerHash);

  const mixedFormats = latestApplicationDocumentOffer({
    workspaceId, company: 'Company', role: 'Role', location: null,
    snapshots: [
      { id: 'whole-second', title: 'Whole', descriptionText: '', fetchedAt: '2026-10-17T10:00:00Z' },
      { id: 'fractional', title: 'Fractional', descriptionText: '', fetchedAt: '2026-10-17T10:00:00.500Z' },
      { id: 'offset', title: 'Offset', descriptionText: '', fetchedAt: '2026-10-17T11:30:00+02:00' },
    ],
  });
  assert.equal(mixedFormats.snapshot?.id, 'fractional');
});

test('replacing a snapshot with identical offer content does not change the offer hash', async () => {
  const before = await applicationDocumentHashes({ workspaceId, claims: [claim], facts, offer });
  const after = await applicationDocumentHashes({ workspaceId, claims: [claim], facts, offer: {
    ...offer,
    snapshot: { ...offer.snapshot!, id: 'new-snapshot', descriptionText: offer.snapshot!.descriptionText },
  } });
  assert.equal(before.ok && after.ok, true);
  if (before.ok && after.ok) assert.equal(before.offerHash, after.offerHash);
});

test('missing offer and mixed-language claims are refused before a revision is created', async () => {
  const noOffer = await createApplicationDocumentRevision({
    id: 'revision', workspaceId, documentId: 'document-1', language: 'es', claims: [claim], facts,
    offer: { ...offer, snapshot: null }, paperSize: 'A4', textSha256: 'a'.repeat(64), pdfSha256: 'b'.repeat(64),
  });
  assert.deepEqual(noOffer, { ok: false, code: 'APPLICATION_HAS_NO_OFFER' });
  const englishClaim = { ...claim, language: 'en' as const };
  assert.deepEqual(mixedLanguageSentenceIds('es', [claim, englishClaim]), ['claim-1']);
  const mixed = await createApplicationDocumentRevision({
    id: 'revision', workspaceId, documentId: 'document-1', language: 'es', claims: [englishClaim], facts, offer,
    paperSize: 'A4', textSha256: 'a'.repeat(64), pdfSha256: 'b'.repeat(64),
  });
  assert.deepEqual(mixed, { ok: false, code: 'LANGUAGE_MISMATCH', sentenceIds: ['claim-1'] });
});

test('an edit creates a child revision without changing the approved parent', async () => {
  const previous = { ...(await createRevision()), approvedAt: '2026-10-16T10:00:00.000Z', approvedBy: 'user-1' };
  const parentBefore = structuredClone(previous);
  const next = await createRevision({ id: 'revision-2', previousRevision: previous, paperSize: 'LETTER' });
  assert.equal(next.revision, previous.revision + 1);
  assert.equal(next.parentRevision, previous.revision);
  assert.equal(next.approvedAt, null);
  assert.deepEqual(previous, parentBefore);
});

test('approval binds exact preview digests and source hashes without rendering', async () => {
  const revision = await createRevision();
  let renderCalls = 0;
  let renderedBytes = 0;
  const renderer = () => {
    renderCalls += 1;
    renderedBytes += 1;
    return new TextEncoder().encode('render-' + renderedBytes);
  };
  const approved = await approveApplicationDocumentRevision({
    ...approveInput(revision),
    renderPreview: renderer,
  } as Parameters<typeof approveApplicationDocumentRevision>[0]);
  assert.equal(approved.ok, true);
  assert.equal(renderCalls, 0);
  if (approved.ok) {
    assert.equal(approved.revision.approvedAt, '2026-10-17T20:00:00.000Z');
    assert.equal(approved.revision.claims, revision.claims);
  }
  const tamperedPdf = await approveApplicationDocumentRevision(approveInput(revision, { storedPdfSha256: 'c'.repeat(64) }));
  assert.deepEqual(tamperedPdf, { ok: false, code: 'APPROVAL_STALE', reason: 'PREVIEW_DIGEST_MISMATCH' });
  const tamperedText = await approveApplicationDocumentRevision(approveInput(revision, { storedTextSha256: 'c'.repeat(64) }));
  assert.deepEqual(tamperedText, { ok: false, code: 'APPROVAL_STALE', reason: 'PREVIEW_DIGEST_MISMATCH' });
  const staleFact = await approveApplicationDocumentRevision(approveInput(revision, { facts: [{ ...facts[0]!, text: 'Texto editado.' }] }));
  assert.deepEqual(staleFact, { ok: false, code: 'APPROVAL_STALE', reason: 'FACTS_CHANGED' });
  const withdrawnFact = await approveApplicationDocumentRevision(approveInput(revision, { facts: [{ ...facts[0]!, approval: 'REJECTED' }] }));
  assert.deepEqual(withdrawnFact, { ok: false, code: 'FACT_NOT_APPROVED', sentenceId: 'claim-1', factId: 'fact-1' });
  const staleOffer = await approveApplicationDocumentRevision(approveInput(revision, { offer: { ...offer, role: 'Otro puesto' } }));
  assert.deepEqual(staleOffer, { ok: false, code: 'APPROVAL_STALE', reason: 'OFFER_CHANGED' });
  const submittedHashMismatch = await approveApplicationDocumentRevision(approveInput(revision, { expectedContentHash: 'c'.repeat(64) }));
  assert.deepEqual(submittedHashMismatch, { ok: false, code: 'APPROVAL_STALE', reason: 'SUBMITTED_HASH_MISMATCH' });
  const editedClaims = [{ ...claim, text: 'Diseñé sistemas de diseño React.' }];
  const editedRevision = await approveApplicationDocumentRevision(approveInput({ ...revision, claims: editedClaims }));
  assert.deepEqual(editedRevision, { ok: false, code: 'APPROVAL_STALE', reason: 'CONTENT_HASH_CHANGED' });
  const older = await approveApplicationDocumentRevision(approveInput(revision, { newestRevisionId: 'revision-2' }));
  assert.deepEqual(older, { ok: false, code: 'NOT_NEWEST' });
  const alreadyApproved = await approveApplicationDocumentRevision(approveInput({ ...revision, approvedAt: '2026-10-16T10:00:00.000Z', approvedBy: 'user-1' }));
  assert.deepEqual(alreadyApproved, { ok: false, code: 'NOT_PENDING' });
});

test('approval requires exactly the unsupported sentence ids shown at save', async () => {
  const unsupportedClaim = { ...claim, sentenceId: 'unsupported-1', origin: 'USER_UNSUPPORTED' as const, sourceFactIds: [] };
  const revision = await createRevision({ claims: [unsupportedClaim] });
  assert.deepEqual(revision.confirmedUnsupportedIds, []);
  const missing = await approveApplicationDocumentRevision(approveInput(revision));
  assert.deepEqual(missing, { ok: false, code: 'UNSUPPORTED_NOT_CONFIRMED' });
  const extra = await approveApplicationDocumentRevision(approveInput(revision, { confirmedUnsupportedIds: ['unsupported-1', 'extra'] }));
  assert.deepEqual(extra, { ok: false, code: 'UNSUPPORTED_NOT_CONFIRMED' });
  const accepted = await approveApplicationDocumentRevision(approveInput(revision, { confirmedUnsupportedIds: ['unsupported-1'] }));
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.deepEqual(accepted.revision.confirmedUnsupportedIds, ['unsupported-1']);
});

test('approval rechecks sentence language, kind, and normal-claim citations', async () => {
  const mixedLanguage = await approveApplicationDocumentRevision(approveInput({
    ...(await createRevision()), claims: [{ ...claim, language: 'en' }],
  }));
  assert.deepEqual(mixedLanguage, { ok: false, code: 'LANGUAGE_MISMATCH', sentenceIds: ['claim-1'] });

  const noCitationClaim = { ...claim, origin: 'USER_EDITED' as const, sourceFactIds: [] };
  const noCitation = await createApplicationDocumentRevision({
    id: 'revision-no-citation', workspaceId, documentId: 'document-1', language: 'es', claims: [noCitationClaim], facts, offer,
    paperSize: 'A4', textSha256: 'a'.repeat(64), pdfSha256: 'b'.repeat(64),
  });
  assert.deepEqual(noCitation, { ok: false, code: 'INVALID_CLAIM', issue: { code: 'NO_CITATION', sentenceId: 'claim-1' } });

  const invalidKind = { ...claim, kind: 'BOILERPLATE' as const, origin: 'USER_UNSUPPORTED' as const };
  const invalid = await createApplicationDocumentRevision({
    id: 'revision-invalid-kind', workspaceId, documentId: 'document-1', language: 'es', claims: [invalidKind], facts, offer,
    paperSize: 'A4', textSha256: 'a'.repeat(64), pdfSha256: 'b'.repeat(64),
  });
  assert.deepEqual(invalid, { ok: false, code: 'INVALID_CLAIM', issue: { code: 'INVALID_SENTENCE_KIND', sentenceId: 'claim-1' } });
});

test('an edited child revision remains approvable against its own preview digests', async () => {
  const parent = { ...(await createRevision()), approvedAt: '2026-10-16T10:00:00.000Z', approvedBy: 'user-1' };
  const child = await createRevision({ id: 'revision-2', previousRevision: parent, textSha256: 'c'.repeat(64), pdfSha256: 'd'.repeat(64) });
  const approved = await approveApplicationDocumentRevision(approveInput(child));
  assert.equal(approved.ok, true);
  if (approved.ok) assert.equal(approved.revision.id, 'revision-2');
});

test('read-time currentness marks withdrawn evidence and changed offer for review', async () => {
  const revision = await createRevision();
  const withdrawn = await applicationDocumentCurrentness({ revision, facts: [{ ...facts[0]!, approval: 'REJECTED' }], offer });
  assert.equal(withdrawn.status, 'NEEDS_REVIEW');
  assert.deepEqual(withdrawn.reasons, ['FACT_NOT_APPROVED', 'FACTS_CHANGED']);
  const changedOffer = await applicationDocumentCurrentness({ revision, facts, offer: { ...offer, company: 'Different Co' } });
  assert.deepEqual(changedOffer, { status: 'NEEDS_REVIEW', reasons: ['OFFER_CHANGED'] });
  const withDerivedSkills = (requirements: string[]) => ({
    ...offer,
    snapshot: { ...offer.snapshot!, derivedRequirements: requirements },
  });
  const stableOfferHash = await applicationDocumentHashes({ workspaceId, claims: revision.claims, facts, offer });
  const dictionaryVariantA = await applicationDocumentCurrentness({ revision, facts, offer: withDerivedSkills(['React']) });
  const dictionaryVariantB = await applicationDocumentCurrentness({ revision, facts, offer: withDerivedSkills(['Rust', 'Python']) });
  const derivedSkillsHashA = await applicationDocumentHashes({ workspaceId, claims: revision.claims, facts, offer: withDerivedSkills(['React']) });
  const derivedSkillsHashB = await applicationDocumentHashes({ workspaceId, claims: revision.claims, facts, offer: withDerivedSkills(['Rust', 'Python']) });
  assert.equal(stableOfferHash.ok && derivedSkillsHashA.ok && derivedSkillsHashB.ok, true);
  if (stableOfferHash.ok && derivedSkillsHashA.ok && derivedSkillsHashB.ok) {
    assert.equal(derivedSkillsHashA.offerHash, stableOfferHash.offerHash);
    assert.equal(derivedSkillsHashB.offerHash, stableOfferHash.offerHash);
  }
  assert.deepEqual(dictionaryVariantA, { status: 'CURRENT', reasons: [] });
  assert.deepEqual(dictionaryVariantB, dictionaryVariantA);
});

test('only the newest approved revision is selectable; a newer pending edit is only a warning', async () => {
  const old = { ...(await createRevision()), approvedAt: '2026-10-16T10:00:00.000Z', approvedBy: 'user-1' };
  const pending = await createRevision({ id: 'revision-2', previousRevision: old });
  const current = { status: 'CURRENT' as const, reasons: [] as const };
  assert.deepEqual(applicationDocumentRevisionSelection(old, [old, pending], current), {
    selectable: true, superseded: false, newerPendingRevisionId: 'revision-2',
  });
  const newerApproved = { ...pending, approvedAt: '2026-10-17T10:00:00.000Z', approvedBy: 'user-1' };
  assert.equal(isApplicationDocumentRevisionSuperseded(old, [old, newerApproved]), true);
  assert.deepEqual(applicationDocumentRevisionSelection(old, [old, newerApproved], current), {
    selectable: false, superseded: true, newerPendingRevisionId: null,
  });
});
