import { extractKnownSkills, factCoversRequirement, type CandidateEvidence, type Requirement } from './matching.js';

export type ApplicationDocumentLanguage = 'es' | 'en';
export type ApplicationDocumentSentenceKind = 'OFFER_REFERENCE' | 'BOILERPLATE' | 'CANDIDATE_CLAIM';
export type ApplicationDocumentSentenceOrigin = 'BUILDER';

export type ApplicationDocumentFact = CandidateEvidence & { workspaceId: string };

export type ApplicationDocumentOffer = {
  workspaceId: string;
  company: string;
  role: string;
  location: string | null;
  snapshot: { id: string; title: string; descriptionText: string | null };
};

export type ApplicationDocumentSentence = {
  sentenceId: string;
  text: string;
  kind: ApplicationDocumentSentenceKind;
  origin: ApplicationDocumentSentenceOrigin;
  sourceFactIds: string[];
};

export type ApplicationCoverLetterDraft = {
  language: ApplicationDocumentLanguage;
  sentences: ApplicationDocumentSentence[];
  unconfirmedRequirements: Requirement[];
  profileNotice: string | null;
};

export type ApplicationResumeDraft = {
  language: ApplicationDocumentLanguage;
  sentences: ApplicationDocumentSentence[];
  unconfirmedRequirements: Requirement[];
};

const phraseTables = {
  es: {
    salutation: 'Hola,',
    offerReference: (role: string, company: string, location: string | null) => `Me postulo al puesto de ${role} en ${company}${location ? `, en ${location}` : ''}.`,
    closing: 'Atentamente,',
    thinProfile: 'Tu perfil tiene pocos datos aprobados; por eso esta carta es breve y no añade afirmaciones sin respaldo.',
  },
  en: {
    salutation: 'Hello,',
    offerReference: (role: string, company: string, location: string | null) => `I am applying for the ${role} position at ${company}${location ? `, in ${location}` : ''}.`,
    closing: 'Sincerely,',
    thinProfile: 'Your profile has few approved facts, so this letter stays short and avoids unsupported claims.',
  },
} as const;

const MAX_CANDIDATE_CLAIMS = 5;

function sentence(sentenceId: string, text: string, kind: ApplicationDocumentSentenceKind, sourceFactIds: string[] = []): ApplicationDocumentSentence {
  return { sentenceId, text, kind, origin: 'BUILDER', sourceFactIds };
}

function normalized(text: string) {
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function containsTerm(text: string, term: string) {
  const haystack = ` ${normalized(text)} `;
  const needle = normalized(term);
  return needle.length > 0 && haystack.includes(` ${needle} `);
}

function selectedFactsForRequirements(facts: ApplicationDocumentFact[], requirements: Requirement[]) {
  if (!requirements.length) return facts.slice(0, 3);
  const selected = new Map<string, ApplicationDocumentFact>();
  for (const requirement of requirements) {
    const supporting = facts.find((fact) => factCoversRequirement(fact, requirement));
    if (supporting) selected.set(supporting.id, supporting);
    if (selected.size >= MAX_CANDIDATE_CLAIMS) break;
  }
  return [...selected.values()];
}

function offerReferenceSentence(language: ApplicationDocumentLanguage, offer: ApplicationDocumentOffer) {
  return sentence('offer-reference', phraseTables[language].offerReference(offer.role, offer.company, offer.location), 'OFFER_REFERENCE');
}

function approvedFactsForOffer(facts: ApplicationDocumentFact[], offer: ApplicationDocumentOffer) {
  return facts
    .filter((fact) => fact.workspaceId === offer.workspaceId && fact.approval === 'USER_APPROVED' && fact.text.trim())
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Deterministic, local-only cover letter baseline. Only approved same-workspace fact text becomes a claim. */
export function buildApplicationCoverLetter(input: {
  language: ApplicationDocumentLanguage;
  offer: ApplicationDocumentOffer;
  facts: ApplicationDocumentFact[];
}): ApplicationCoverLetterDraft {
  const phrases = phraseTables[input.language];
  const approvedFacts = approvedFactsForOffer(input.facts, input.offer);
  const requirements = extractKnownSkills(input.offer.snapshot.descriptionText);
  const unconfirmedRequirements = requirements.filter((requirement) => !approvedFacts.some((fact) => factCoversRequirement(fact, requirement)));
  const selectedFacts = selectedFactsForRequirements(approvedFacts, requirements);
  const sentences = [
    sentence('salutation', phrases.salutation, 'BOILERPLATE'),
    offerReferenceSentence(input.language, input.offer),
    ...selectedFacts.map((fact) => sentence(`fact-${fact.id}`, fact.text.trim(), 'CANDIDATE_CLAIM', [fact.id])),
    sentence('closing', phrases.closing, 'BOILERPLATE'),
  ];
  const profileNotice = approvedFacts.length < 2 ? phrases.thinProfile : null;
  return { language: input.language, sentences, unconfirmedRequirements, profileNotice };
}

/** Deterministic offer-specific resume selection. Candidate claims reuse approved fact text and retain its source id. */
export function buildApplicationResumeDraft(input: {
  language: ApplicationDocumentLanguage;
  offer: ApplicationDocumentOffer;
  facts: ApplicationDocumentFact[];
}): ApplicationResumeDraft {
  const approvedFacts = approvedFactsForOffer(input.facts, input.offer);
  const requirements = extractKnownSkills(input.offer.snapshot.descriptionText);
  const unconfirmedRequirements = requirements.filter((requirement) => !approvedFacts.some((fact) => factCoversRequirement(fact, requirement)));
  const selectedFacts = selectedFactsForRequirements(approvedFacts, requirements);
  return {
    language: input.language,
    sentences: [
      offerReferenceSentence(input.language, input.offer),
      ...selectedFacts.map((fact) => sentence(`fact-${fact.id}`, fact.text.trim(), 'CANDIDATE_CLAIM', [fact.id])),
    ],
    unconfirmedRequirements,
  };
}

/** The offer may supply fixed reference text, but never counts as evidence for a candidate claim. */
export function validateApplicationCandidateClaim(input: {
  text: string;
  sourceFactIds: string[];
  workspaceId: string;
  offer: ApplicationDocumentOffer;
  facts: ApplicationDocumentFact[];
}): { valid: true } | { valid: false; reason: 'EMPTY_CLAIM' | 'NO_CITATION' | 'FACT_NOT_APPROVED' | 'UNSUPPORTED_OFFER_TERM'; term?: string } {
  if (!input.text.trim()) return { valid: false, reason: 'EMPTY_CLAIM' };
  if (!input.sourceFactIds.length) return { valid: false, reason: 'NO_CITATION' };
  const cited = input.sourceFactIds.map((id) => input.facts.find((fact) => fact.id === id));
  if (cited.some((fact) => !fact || fact.workspaceId !== input.workspaceId || fact.approval !== 'USER_APPROVED')) {
    return { valid: false, reason: 'FACT_NOT_APPROVED' };
  }
  const citedContent = cited.map((fact) => `${fact!.text} ${fact!.tags.join(' ')}`).join(' ');
  const offerTerms = [input.offer.company, input.offer.role, input.offer.location, input.offer.snapshot.title, ...extractKnownSkills(input.offer.snapshot.descriptionText).map((requirement) => requirement.text)]
    .filter((term): term is string => Boolean(term?.trim()));
  const unsupported = offerTerms.find((term) => containsTerm(input.text, term) && !containsTerm(citedContent, term));
  return unsupported ? { valid: false, reason: 'UNSUPPORTED_OFFER_TERM', term: unsupported } : { valid: true };
}

/** Reclassifies edited boilerplate; offer references cannot retain their special kind after text changes. */
export function classifyEditedApplicationSentence(input: {
  originalKind: ApplicationDocumentSentenceKind;
  originalText: string;
  text: string;
  offer: ApplicationDocumentOffer;
}): ApplicationDocumentSentenceKind {
  if (input.text.trim() === input.originalText.trim()) return input.originalKind;
  if (input.originalKind === 'CANDIDATE_CLAIM' || input.originalKind === 'OFFER_REFERENCE') return 'CANDIDATE_CLAIM';
  const addedTerm = [input.offer.company, input.offer.role, input.offer.location, input.offer.snapshot.title]
    .some((term) => Boolean(term?.trim() && containsTerm(input.text, term)));
  const addsKnownSkill = extractKnownSkills(input.text).length > 0;
  const addsNumberOrDate = /\b\d+(?:[.,/]\d+)*\b/u.test(input.text);
  return addedTerm || addsKnownSkill || addsNumberOrDate ? 'CANDIDATE_CLAIM' : 'BOILERPLATE';
}
