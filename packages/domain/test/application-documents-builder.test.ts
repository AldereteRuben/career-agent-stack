import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildApplicationCoverLetter,
  classifyEditedApplicationSentence,
  validateApplicationCandidateClaim,
  type ApplicationDocumentFact,
  type ApplicationDocumentOffer,
} from '../src/application-documents-builder.js';

const workspaceId = 'workspace-a';
const offer: ApplicationDocumentOffer = {
  workspaceId,
  company: 'Acme Example',
  role: 'Product Designer',
  location: 'Berlin',
  snapshot: { id: 'snapshot-a', title: 'Designer', descriptionText: 'We need TypeScript and React experience.' },
};
const facts: ApplicationDocumentFact[] = [
  { id: 'fact-type', workspaceId, approval: 'USER_APPROVED', text: 'Built TypeScript services at Acme Example.', tags: ['typescript'] },
  { id: 'fact-design', workspaceId, approval: 'USER_APPROVED', text: 'Led product design research.', tags: ['design'] },
  { id: 'fact-suggested', workspaceId, approval: 'SUGGESTED', text: 'Expert in React.', tags: ['react'] },
  { id: 'fact-rejected', workspaceId, approval: 'REJECTED', text: 'Managed React teams.', tags: ['react'] },
  { id: 'fact-other-workspace', workspaceId: 'workspace-b', approval: 'USER_APPROVED', text: 'Expert in React at Acme Example.', tags: ['react'] },
];

test('builds deterministic Spanish and English drafts with fixed boilerplate and offer reference', () => {
  const spanish = buildApplicationCoverLetter({ language: 'es', offer, facts });
  const english = buildApplicationCoverLetter({ language: 'en', offer, facts: [...facts].reverse() });
  assert.equal(spanish.sentences[0]!.text, 'Hola,');
  assert.equal(spanish.sentences[0]!.kind, 'BOILERPLATE');
  assert.equal(spanish.sentences[1]!.text, 'Me postulo al puesto de Product Designer en Acme Example, en Berlin.');
  assert.equal(spanish.sentences[1]!.kind, 'OFFER_REFERENCE');
  assert.deepEqual(spanish.sentences[1]!.sourceFactIds, []);
  assert.equal(english.sentences[0]!.text, 'Hello,');
  assert.equal(english.sentences[1]!.text, 'I am applying for the Product Designer position at Acme Example, in Berlin.');
  assert.deepEqual(spanish.sentences, buildApplicationCoverLetter({ language: 'es', offer, facts: [...facts].reverse() }).sentences);
  assert.deepEqual(spanish.sentences.filter((row) => row.kind === 'CANDIDATE_CLAIM').map((row) => [row.text, row.sourceFactIds]), [
    ['Built TypeScript services at Acme Example.', ['fact-type']],
  ]);
  assert.deepEqual(spanish.unconfirmedRequirements.map((item) => item.text), ['react']);
  assert.equal(spanish.profileNotice, null);
  assert.equal(spanish.sentences.at(-1)!.text, 'Atentamente,');
  assert.equal(spanish.sentences.at(-1)!.kind, 'BOILERPLATE');
  assert.equal(english.sentences.at(-1)!.text, 'Sincerely,');
});

test('a thin profile gets a short draft, a localized notice and no unsupported claims', () => {
  const spanish = buildApplicationCoverLetter({ language: 'es', offer, facts: [] });
  const english = buildApplicationCoverLetter({ language: 'en', offer, facts: [] });
  assert.equal(spanish.sentences.length, 3);
  assert.equal(spanish.sentences.some((row) => row.kind === 'CANDIDATE_CLAIM'), false);
  assert.match(spanish.profileNotice ?? '', /pocos datos aprobados/);
  assert.match(english.profileNotice ?? '', /few approved facts/);
  assert.deepEqual(spanish.unconfirmedRequirements.map((item) => item.text), ['typescript', 'react']);
});

test('offer company and requirements never support a candidate claim by themselves', () => {
  const noCitation = validateApplicationCandidateClaim({ text: 'I led payments at Acme Example.', sourceFactIds: [], workspaceId, offer, facts });
  assert.deepEqual(noCitation, { valid: false, reason: 'NO_CITATION' });

  const onlyOfferSupport = validateApplicationCandidateClaim({
    text: 'I built a TypeScript product at Acme Example.', sourceFactIds: ['fact-design'], workspaceId, offer, facts,
  });
  assert.deepEqual(onlyOfferSupport, { valid: false, reason: 'UNSUPPORTED_OFFER_TERM', term: 'Acme Example' });

  const supportedByCitedFact = validateApplicationCandidateClaim({
    text: 'I built TypeScript services at Acme Example.', sourceFactIds: ['fact-type'], workspaceId, offer, facts,
  });
  assert.deepEqual(supportedByCitedFact, { valid: true });
});

test('citations must point to approved facts in the same workspace', () => {
  for (const sourceFactId of ['fact-suggested', 'fact-rejected', 'fact-other-workspace', 'missing']) {
    const result = validateApplicationCandidateClaim({ text: 'I have product experience.', sourceFactIds: [sourceFactId], workspaceId, offer, facts });
    assert.deepEqual(result, { valid: false, reason: 'FACT_NOT_APPROVED' }, sourceFactId);
  }
});

test('editing boilerplate keeps plain greetings boilerplate but classifies added facts as claims', () => {
  const classify = (text: string) => classifyEditedApplicationSentence({ originalKind: 'BOILERPLATE', originalText: 'Atentamente,', text, offer });
  assert.equal(classify('Best regards'), 'BOILERPLATE');
  assert.equal(classify('Best regards, with 10 years of experience'), 'CANDIDATE_CLAIM');
  assert.equal(classify('Best regards, skilled in Python'), 'CANDIDATE_CLAIM');
  assert.equal(classifyEditedApplicationSentence({ originalKind: 'OFFER_REFERENCE', originalText: 'I am applying for Product Designer at Acme Example.', text: 'I led teams at Acme Example.', offer }), 'CANDIDATE_CLAIM');
});
