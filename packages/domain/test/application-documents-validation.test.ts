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
    ['Globex Labs employed me.', 'Globex Labs'],
    ['Globex employed me.', 'Globex'],
    ['I have ten years of experience.', 'ten'],
    ['I am a Senior Data Scientist.', 'Senior Data Scientist'],
    ['I hold a doctorate.', 'doctorate'],
    ['I hold a master’s degree.', 'master’s degree'],
    ['I hold a masters degree.', 'masters degree'],
    ["I have a master's in computer science from stanford.", "master's in computer science"],
    ['Tengo un máster en ciencia de datos.', 'máster'],
    ['Tengo una maestría en análisis.', 'maestría en análisis'],
    ['I hold a BS in physics.', 'BS'],
    ['I earned a certificate in data analytics.', 'certificate in data'],
    ['I earned a certification in data analytics.', 'certification in data'],
    ['I hold an AWS certification.', 'aws'],
    ['I worked at ebay using React.', 'ebay'],
    ['I worked at eBay using React.', 'eBay'],
    ['I tested Stripe payments.', 'Stripe'],
    ['Led Stripe payments testing.', 'Stripe'],
    ['My Stripe internship taught me React.', 'Stripe'],
    ['Probé pagos en mercadopago.', 'mercadopago'],
    ['I was head of engineering and used React.', 'head of engineering'],
    ['I worked as a team lead.', 'team lead'],
    ['I was promoted to VP of engineering.', 'VP of engineering'],
    ['I hold a master’s degree in physics.', 'master’s degree in physics'],
    ['I hold a Bachelor of Arts.', 'Bachelor of Arts'],
    ['Dirigí once equipos de pruebas.', 'once'],
    ['Automaticé veintidós pruebas.', 'veintidós'],
    ['I worked as a senior qa engineer.', 'senior qa engineer'],
    ['As sdet I tested checkout.', 'sdet'],
    ['Built test suites as qa lead.', 'qa lead'],
    ['I worked as engineering manager on QA.', 'engineering manager'],
    ['Managed a million-dollar budget with React.', 'million'],
    ['Built services with figma and terraform.', 'figma'],
  ];
  for (const [text, item] of cases) {
    const result = validateApplicationDocumentSentence({ sentence: claim({ text }), workspaceId, facts: [facts[0]!], offer });
    assert.deepEqual(result, { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: 'claim-1', item } }, text);
  }
});

test('only equivalent skill aliases support each other in approved evidence', () => {
  const postgresFact: ApplicationDocumentFact = {
    id: 'fact-postgres', workspaceId, approval: 'USER_APPROVED', text: 'Built database systems with PostgreSQL.', tags: ['sql'],
  };
  const result = validateApplicationDocumentSentence({
    sentence: claim({ text: 'Used PostgreSQL.', sourceFactIds: ['fact-postgres'] }), workspaceId, facts: [postgresFact], offer,
  });
  assert.equal(result.ok, true);
  const mysqlFact: ApplicationDocumentFact = {
    id: 'fact-mysql', workspaceId, approval: 'USER_APPROVED', text: 'Built services with MySQL.', tags: ['sql'],
  };
  const aliasLaundering = validateApplicationDocumentSentence({
    sentence: claim({ text: 'Built services with PostgreSQL.', sourceFactIds: ['fact-mysql'] }), workspaceId, facts: [mysqlFact], offer,
  });
  assert.deepEqual(aliasLaundering, { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: 'claim-1', item: 'postgresql' } });
  const sqlFact: ApplicationDocumentFact = {
    id: 'fact-sql', workspaceId, approval: 'USER_APPROVED', text: 'Wrote SQL queries.', tags: [],
  };
  assert.deepEqual(validateApplicationDocumentSentence({
    sentence: claim({ text: 'Wrote SQL and PostgreSQL queries.', sourceFactIds: ['fact-sql'] }), workspaceId, facts: [sqlFact], offer,
  }), { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: 'claim-1', item: 'postgresql' } });
  const agileFact: ApplicationDocumentFact = {
    id: 'fact-agile', workspaceId, approval: 'USER_APPROVED', text: 'Worked in Agile teams.', tags: [],
  };
  assert.deepEqual(validateApplicationDocumentSentence({
    sentence: claim({ text: 'Worked in Agile and Scrum teams.', sourceFactIds: ['fact-agile'] }), workspaceId, facts: [agileFact], offer,
  }), { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: 'claim-1', item: 'scrum' } });
  const awsFact: ApplicationDocumentFact = {
    id: 'fact-aws', workspaceId, approval: 'USER_APPROVED', text: 'Deployed on Amazon Web Services.', tags: ['aws'],
  };
  assert.equal(validateApplicationDocumentSentence({
    sentence: claim({ text: 'Used AWS.', sourceFactIds: ['fact-aws'] }), workspaceId, facts: [awsFact], offer,
  }).ok, true);
  const spanishResult = validateApplicationDocumentSentence({
    sentence: claim({ text: 'Usé React.' }), workspaceId, facts: [facts[0]!], offer,
  });
  assert.equal(spanishResult.ok, true);
});

test('edits follow supported, rejected or confirmed-unsupported outcomes', () => {
  const original = claim({ text: 'Worked with React.' });
  const supported = saveApplicationDocumentSentenceEdit({
    original, text: 'Built products using React.', sourceFactIds: ['fact-supported'], workspaceId, facts, offer,
  });
  assert.deepEqual(supported, { ok: true, sentence: { ...original, text: 'Built products using React.', origin: 'USER_EDITED' } });

  const unsupportedEdits = [
    ['Built products using Python.', 'python'],
    ['Led a team of 10 using React.', '10'],
    ['Used React since March 2020.', 'March 2020'],
  ];
  for (const [text, item] of unsupportedEdits) {
    const rejected = saveApplicationDocumentSentenceEdit({
      original, text, sourceFactIds: ['fact-supported'], workspaceId, facts, offer,
    });
    assert.deepEqual(rejected, { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: 'claim-1', item } }, text);
    const confirmed = saveApplicationDocumentSentenceEdit({
      original, text, sourceFactIds: ['fact-supported'], confirmUnsupported: true, workspaceId, facts, offer,
    });
    assert.deepEqual(confirmed, { ok: true, sentence: { ...original, text, origin: 'USER_UNSUPPORTED' } }, text);
  }
});

test('supported rewordings can start with verbs, connectors and articles in either language', () => {
  const supportedRewordings = [
    'Shipped payments at Acme Example with React.',
    'Spearheaded payments at Acme Example using React.',
    'Using React, I led payments at Acme Example.',
    'The payments work at Acme Example used React.',
    'Gestioné pagos en Acme Example con React.',
  ];
  for (const text of supportedRewordings) {
    const result = validateApplicationDocumentSentence({ sentence: claim({ text }), workspaceId, facts, offer });
    assert.equal(result.ok, true, text);
  }
  const seleniumFact: ApplicationDocumentFact = {
    id: 'fact-selenium', workspaceId, approval: 'USER_APPROVED', text: 'Wrote Selenium suites for checkout.', tags: ['selenium'],
  };
  const automated = validateApplicationDocumentSentence({
    sentence: claim({ text: 'Automated Selenium suites for checkout.', sourceFactIds: ['fact-selenium'] }), workspaceId, facts: [seleniumFact], offer,
  });
  assert.equal(automated.ok, true);
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
  const original: ApplicationDocumentSentence = { sentenceId: 'closing', text: 'Atentamente,', kind: 'BOILERPLATE', origin: 'BUILDER', sourceFactIds: [], language: 'es' };
  assert.equal(validateApplicationDocumentSentence({ sentence: original, workspaceId, facts, offer }).ok, true);
  for (const [text, language] of [['Saludos cordiales,', 'es'], ['Hello,', 'en']] as const) {
    assert.equal(validateApplicationDocumentSentence({ sentence: { ...original, text, language }, workspaceId, facts, offer }).ok, true);
  }
  for (const [text, language] of [
    ['Gracias,', 'es'], ['Muchas gracias,', 'es'], ['Dear Hiring Manager,', 'en'], ['Yours sincerely,', 'en'],
  ] as const) {
    assert.equal(validateApplicationDocumentSentence({ sentence: { ...original, text, language }, workspaceId, facts, offer }).ok, true, text);
    const edited = saveApplicationDocumentSentenceEdit({ original, text, sourceFactIds: [], workspaceId, facts, offer });
    assert.equal(edited.ok && edited.sentence.kind, 'BOILERPLATE', text);
  }
  assert.equal(validateApplicationDocumentSentence({
    sentence: { ...original, text: 'Saludos cordiales', language: 'en' }, workspaceId, facts, offer,
  }).ok, false);
  const translatedClosing = saveApplicationDocumentSentenceEdit({
    original: { ...original, text: 'Sincerely,', language: 'en' }, text: 'Saludos cordiales', sourceFactIds: [], workspaceId, facts, offer,
  });
  assert.deepEqual(translatedClosing, { ok: true, sentence: { ...original, text: 'Saludos cordiales', language: 'es', origin: 'USER_EDITED' } });
  const greeting = saveApplicationDocumentSentenceEdit({ original, text: 'Best regards,', sourceFactIds: [], workspaceId, facts, offer });
  assert.deepEqual(greeting, { ok: true, sentence: { ...original, text: 'Best regards,', language: 'en', origin: 'USER_EDITED' } });
  const titleCaseGreeting = saveApplicationDocumentSentenceEdit({ original, text: 'Best Regards,', sourceFactIds: [], workspaceId, facts, offer });
  assert.deepEqual(titleCaseGreeting, { ok: true, sentence: { ...original, text: 'Best Regards,', language: 'en', origin: 'USER_EDITED' } });
  const withNumber = saveApplicationDocumentSentenceEdit({ original, text: 'Best regards, with 10 years of experience', sourceFactIds: [], workspaceId, facts, offer });
  assert.deepEqual(withNumber, { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: 'closing', item: '10' } });
  const withCredential = saveApplicationDocumentSentenceEdit({ original, text: 'I hold a doctorate.', sourceFactIds: [], workspaceId, facts, offer });
  assert.deepEqual(withCredential, { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: 'closing', item: 'doctorate' } });
  const editedClaim = saveApplicationDocumentSentenceEdit({
    original, text: 'I am passionate about fintech and led teams for years.', sourceFactIds: [], workspaceId, facts, offer,
  });
  assert.deepEqual(editedClaim, { ok: false, issue: { code: 'NO_CITATION', sentenceId: 'closing' } });
  const confirmed = saveApplicationDocumentSentenceEdit({ original, text: 'Best regards, with Python experience', sourceFactIds: [], confirmUnsupported: true, workspaceId, facts, offer });
  assert.equal(confirmed.ok && confirmed.sentence.kind, 'CANDIDATE_CLAIM');
  assert.equal(confirmed.ok && confirmed.sentence.origin, 'USER_UNSUPPORTED');
  assert.deepEqual(saveApplicationDocumentSentenceEdit({
    original: claim({ text: 'Used React.' }), text: 'Used Python.', sourceFactIds: [], workspaceId, facts, offer,
  }), { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: 'claim-1', item: 'python' } });
  const noCitationConfirmed = saveApplicationDocumentSentenceEdit({
    original: claim({ text: 'Used React.' }), text: 'Used Python.', sourceFactIds: [], confirmUnsupported: true, workspaceId, facts, offer,
  });
  assert.equal(noCitationConfirmed.ok && noCitationConfirmed.sentence.origin, 'USER_UNSUPPORTED');
  assert.deepEqual(saveApplicationDocumentSentenceEdit({
    original: claim({ text: 'Used React.' }), text: 'I am enthusiastic.', sourceFactIds: [], workspaceId, facts, offer,
  }), { ok: false, issue: { code: 'NO_CITATION', sentenceId: 'claim-1' } });
});

test('editing an unsupported sentence needs fresh confirmation unless it is unchanged', () => {
  const original = claim({ text: 'Used Python.', origin: 'USER_UNSUPPORTED', sourceFactIds: [] });
  assert.deepEqual(saveApplicationDocumentSentenceEdit({
    original, text: 'Used Python professionally.', sourceFactIds: [], workspaceId, facts, offer,
  }), { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: 'claim-1', item: 'python' } });
  const confirmed = saveApplicationDocumentSentenceEdit({
    original, text: 'Used Python professionally.', sourceFactIds: [], confirmUnsupported: true, workspaceId, facts, offer,
  });
  assert.equal(confirmed.ok && confirmed.sentence.origin, 'USER_UNSUPPORTED');
  assert.deepEqual(saveApplicationDocumentSentenceEdit({
    original, text: original.text, sourceFactIds: original.sourceFactIds, workspaceId, facts, offer,
  }), { ok: true, sentence: original });
  const unsupportedWithCitation = claim({ text: 'Used Python.', origin: 'USER_UNSUPPORTED', sourceFactIds: ['fact-supported'] });
  assert.deepEqual(saveApplicationDocumentSentenceEdit({
    original: unsupportedWithCitation, text: unsupportedWithCitation.text, sourceFactIds: unsupportedWithCitation.sourceFactIds, workspaceId, facts, offer,
  }), { ok: true, sentence: unsupportedWithCitation });
});

test('assistant proposals must be claims and pass the same provenance checks', () => {
  const original = claim();
  const valid = validateApplicationDocumentAssistantProposal({ sentence: claim({ origin: 'CODEX' }), original, workspaceId, facts, offer });
  assert.equal(valid.ok, true);
  const unsupported = validateApplicationDocumentAssistantProposal({ sentence: claim({ origin: 'CODEX', text: 'Expert in Python.' }), original, workspaceId, facts: [facts[0]!], offer });
  assert.deepEqual(unsupported, { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: 'claim-1', item: 'python' } });
  const boilerplate = validateApplicationDocumentAssistantProposal({
    sentence: { sentenceId: 'salutation', text: 'Hello', kind: 'BOILERPLATE', origin: 'CODEX', sourceFactIds: [] }, original, workspaceId, facts, offer,
  });
  assert.deepEqual(boilerplate, { ok: false, issue: { code: 'INVALID_SENTENCE_KIND', sentenceId: 'salutation' } });
  const newClaim = validateApplicationDocumentAssistantProposal({
    sentence: claim({ sentenceId: 'new-claim', origin: 'CODEX' }), original, workspaceId, facts, offer,
  });
  assert.deepEqual(newClaim, { ok: false, issue: { code: 'INVALID_SENTENCE_KIND', sentenceId: 'new-claim' } });
  const changedLanguage = validateApplicationDocumentAssistantProposal({
    sentence: claim({ origin: 'CODEX', language: 'en' }), original, workspaceId, facts, offer,
  });
  assert.deepEqual(changedLanguage, { ok: false, issue: { code: 'INVALID_SENTENCE_KIND', sentenceId: 'claim-1' } });
});
