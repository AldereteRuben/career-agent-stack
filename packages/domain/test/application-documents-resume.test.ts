import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildApplicationResumeDraft,
  type ApplicationDocumentFact,
  type ApplicationDocumentOffer,
} from '../src/application-documents-builder.js';

const offer: ApplicationDocumentOffer = {
  workspaceId: 'workspace-a',
  company: 'Acme Example',
  role: 'Product Designer',
  location: 'Berlin',
  snapshot: { id: 'snapshot-a', title: 'Designer', descriptionText: 'React, then TypeScript experience.' },
};

const facts: ApplicationDocumentFact[] = [
  { id: 'react-experience', workspaceId: 'workspace-a', approval: 'USER_APPROVED', text: 'Built reusable React interfaces.', tags: ['react'] },
  { id: 'typescript-experience', workspaceId: 'workspace-a', approval: 'USER_APPROVED', text: 'Maintained typed services with TypeScript.', tags: ['typescript'] },
  { id: 'suggested', workspaceId: 'workspace-a', approval: 'SUGGESTED', text: 'Expert in React.', tags: ['react'] },
  { id: 'foreign', workspaceId: 'workspace-b', approval: 'USER_APPROVED', text: 'Expert in TypeScript.', tags: ['typescript'] },
];

test('resume selection follows offer requirements and cites every candidate claim', () => {
  const draft = buildApplicationResumeDraft({ language: 'en', offer, facts });
  const offerReferences = draft.sentences.filter((row) => row.kind === 'OFFER_REFERENCE');
  const claims = draft.sentences.filter((row) => row.kind === 'CANDIDATE_CLAIM');

  assert.equal(offerReferences.length, 1);
  assert.equal(offerReferences[0]!.text, 'I am applying for the Product Designer position at Acme Example, in Berlin.');
  assert.deepEqual(offerReferences[0]!.sourceFactIds, []);
  assert.deepEqual(claims.map((row) => row.text), [
    'Maintained typed services with TypeScript.',
    'Built reusable React interfaces.',
  ]);
  assert.deepEqual(claims.map((row) => row.sourceFactIds), [['typescript-experience'], ['react-experience']]);
  assert.equal(claims.some((row) => /Acme Example|Product Designer|Berlin/u.test(row.text)), false);
  assert.deepEqual(draft.unconfirmedRequirements, []);
});

test('resume selection leaves unsupported offer requirements visible without inventing claims', () => {
  const unsupportedOffer = {
    ...offer,
    snapshot: { ...offer.snapshot, descriptionText: 'React and Python are required.' },
  };
  const draft = buildApplicationResumeDraft({ language: 'es', offer: unsupportedOffer, facts });

  assert.equal(draft.sentences[0]!.kind, 'OFFER_REFERENCE');
  assert.equal(draft.sentences[0]!.text, 'Me postulo al puesto de Product Designer en Acme Example, en Berlin.');
  assert.deepEqual(draft.sentences.filter((row) => row.kind === 'CANDIDATE_CLAIM').map((row) => row.sourceFactIds), [['react-experience']]);
  assert.deepEqual(draft.unconfirmedRequirements.map((requirement) => requirement.text), ['python']);
});
