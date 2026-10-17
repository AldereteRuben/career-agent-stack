import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildApplicationCoverLetter,
  type ApplicationDocumentFact,
  type ApplicationDocumentOffer,
  type ApplicationDocumentSentence,
} from '../src/application-documents-builder.js';
import {
  validateApplicationDocumentAssistantProposal,
  validateApplicationDocumentSentence,
  saveApplicationDocumentSentenceEdit,
} from '../src/application-document-validation.js';

const workspaceId = 'workspace-a';
const offer: ApplicationDocumentOffer = {
  workspaceId, company: 'Acme Example', role: 'Product Designer', location: 'Berlin',
  snapshot: { id: 'snapshot-a', title: 'Designer', descriptionText: 'React and Python experience.' },
};
const facts: ApplicationDocumentFact[] = [
  { id: 'fact-supported', workspaceId, approval: 'USER_APPROVED', text: 'Led payments at Acme Example and used React.', tags: ['react'] },
  { id: 'fact-other', workspaceId: 'workspace-b', approval: 'USER_APPROVED', text: 'Expert in Python.', tags: ['python'] },
  { id: 'fact-suggested', workspaceId, approval: 'SUGGESTED', text: 'Expert in Python.', tags: ['python'] },
  { id: 'fact-rejected', workspaceId, approval: 'REJECTED', text: 'Expert in Python.', tags: ['python'] },
];

function claim(overrides: Partial<ApplicationDocumentSentence> = {}): ApplicationDocumentSentence {
  return {
    sentenceId: 'claim-1', text: 'Led payments at Acme Example and used React.', kind: 'CANDIDATE_CLAIM',
    origin: 'BUILDER', sourceFactIds: ['fact-supported'], ...overrides,
  };
}

test('accepts the exact fixed offer reference without citation and rejects a changed reference', () => {
  const draft = buildApplicationCoverLetter({ language: 'en', offer, facts });
  const exact = draft.sentences.find((sentence) => sentence.kind === 'OFFER_REFERENCE')!;
  assert.equal(validateApplicationDocumentSentence({ sentence: exact, workspaceId, facts, offer }).ok, true);
  const edited = { ...exact, text: `${exact.text} and I bring ten years of experience` };
  assert.deepEqual(validateApplicationDocumentSentence({ sentence: edited, workspaceId, facts, offer }), {
    ok: false, issue: { code: 'INVALID_OFFER_REFERENCE', sentenceId: exact.sentenceId },
  });
});

test('candidate claims need approved citations from the same workspace', () => {
  for (const factId of ['missing', 'fact-other', 'fact-suggested', 'fact-rejected']) {
    const result = validateApplicationDocumentSentence({ sentence: claim({ sourceFactIds: [factId] }), workspaceId, facts, offer });
    assert.deepEqual(result, { ok: false, issue: { code: 'FACT_NOT_APPROVED', sentenceId: 'claim-1', factId } });
  }
  assert.deepEqual(validateApplicationDocumentSentence({ sentence: claim({ sourceFactIds: [] }), workspaceId, facts, offer }), {
    ok: false, issue: { code: 'NO_CITATION', sentenceId: 'claim-1' },
  });
});

test('offer company, role and requirements never support a candidate claim on their own', () => {
  const onlyOffer = claim({ text: 'I worked at Acme Example as a Product Designer using Python.' });
  const result = validateApplicationDocumentSentence({ sentence: onlyOffer, workspaceId, facts: [facts[0]!], offer });
  assert.deepEqual(result, { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: 'claim-1', item: 'python' } });
  const supported = validateApplicationDocumentSentence({ sentence: claim(), workspaceId, facts, offer });
  assert.equal(supported.ok, true);
});

test('new skills, numbers, dates, credentials and named entities are rejected with the offending item', () => {
  const cases = [
    ['I used Python.', 'python'],
    ['I led a team of 10.', '10'],
    ['I joined in March 2020.', 'March 2020'],
    ['I hold a PMP certification.', 'PMP'],
    ['I worked at Globex Labs.', 'Globex Labs'],
  ];
  for (const [text, item] of cases) {
    const result = validateApplicationDocumentSentence({ sentence: claim({ text }), workspaceId, facts: [facts[0]!], offer });
    assert.deepEqual(result, { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: 'claim-1', item } }, text);
  }
});

test('edits follow supported, rejected or confirmed-unsupported outcomes', () => {
  const original = claim({ text: 'Worked with React.' });
  const supported = saveApplicationDocumentSentenceEdit({
    original, text: 'Built products using React.', sourceFactIds: ['fact-supported'], workspaceId, facts, offer,
  });
  assert.deepEqual(supported, { ok: true, sentence: { ...original, text: 'Built products using React.', origin: 'USER_EDITED' } });

  const rejected = saveApplicationDocumentSentenceEdit({
    original, text: 'Built products using Python.', sourceFactIds: ['fact-supported'], workspaceId, facts, offer,
  });
  assert.deepEqual(rejected, { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: 'claim-1', item: 'python' } });

  const confirmed = saveApplicationDocumentSentenceEdit({
    original, text: 'Built products using Python.', sourceFactIds: ['fact-supported'], confirmUnsupported: true, workspaceId, facts, offer,
  });
  assert.deepEqual(confirmed, { ok: true, sentence: { ...original, text: 'Built products using Python.', origin: 'USER_UNSUPPORTED' } });
});

test('an unsupported sentence edited back to supported becomes USER_EDITED', () => {
  const original = claim({ text: 'Built products using Python.', origin: 'USER_UNSUPPORTED', sourceFactIds: [] });
  const result = saveApplicationDocumentSentenceEdit({
    original, text: 'Built products using React.', sourceFactIds: ['fact-supported'], workspaceId, facts, offer,
  });
  assert.deepEqual(result, { ok: true, sentence: { ...original, text: 'Built products using React.', sourceFactIds: ['fact-supported'], origin: 'USER_EDITED' } });
});

test('editing builder or Codex claims changes origin; an unchanged sentence keeps origin', () => {
  for (const origin of ['BUILDER', 'CODEX'] as const) {
    const original = claim({ text: 'Used React.', origin });
    const changed = saveApplicationDocumentSentenceEdit({ original, text: 'Built products using React.', sourceFactIds: ['fact-supported'], workspaceId, facts, offer });
    assert.equal(changed.ok && changed.sentence.origin, 'USER_EDITED');
    const unchanged = saveApplicationDocumentSentenceEdit({ original, text: original.text, sourceFactIds: original.sourceFactIds, workspaceId, facts, offer });
    assert.deepEqual(unchanged, { ok: true, sentence: original });
  }
});

test('plain reworded boilerplate stays boilerplate; adding facts requires support or confirmation', () => {
  const original: ApplicationDocumentSentence = { sentenceId: 'closing', text: 'Atentamente,', kind: 'BOILERPLATE', origin: 'BUILDER', sourceFactIds: [] };
  const greeting = saveApplicationDocumentSentenceEdit({ original, text: 'Best regards,', sourceFactIds: [], workspaceId, facts, offer });
  assert.deepEqual(greeting, { ok: true, sentence: { ...original, text: 'Best regards,', origin: 'USER_EDITED' } });
  const withNumber = saveApplicationDocumentSentenceEdit({ original, text: 'Best regards, with 10 years of experience', sourceFactIds: [], workspaceId, facts, offer });
  assert.deepEqual(withNumber, { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: 'closing', item: '10' } });
  const confirmed = saveApplicationDocumentSentenceEdit({ original, text: 'Best regards, with Python experience', sourceFactIds: [], confirmUnsupported: true, workspaceId, facts, offer });
  assert.equal(confirmed.ok && confirmed.sentence.kind, 'CANDIDATE_CLAIM');
  assert.equal(confirmed.ok && confirmed.sentence.origin, 'USER_UNSUPPORTED');
});

test('assistant proposals must be claims and pass the same provenance checks', () => {
  const valid = validateApplicationDocumentAssistantProposal({ sentence: claim({ origin: 'CODEX' }), workspaceId, facts, offer });
  assert.equal(valid.ok, true);
  const unsupported = validateApplicationDocumentAssistantProposal({ sentence: claim({ origin: 'CODEX', text: 'Expert in Python.' }), workspaceId, facts: [facts[0]!], offer });
  assert.deepEqual(unsupported, { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: 'claim-1', item: 'python' } });
  const boilerplate = validateApplicationDocumentAssistantProposal({
    sentence: { sentenceId: 'salutation', text: 'Hello', kind: 'BOILERPLATE', origin: 'CODEX', sourceFactIds: [] }, workspaceId, facts, offer,
  });
  assert.deepEqual(boilerplate, { ok: false, issue: { code: 'INVALID_SENTENCE_KIND', sentenceId: 'salutation' } });
});
