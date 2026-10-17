import {
  fixedApplicationDocumentPhraseLanguage,
  isExactBuiltApplicationOfferReference,
  type ApplicationDocumentFact,
  type ApplicationDocumentOffer,
  type ApplicationDocumentSentence,
} from './application-documents-builder.js';
import { containsTerm, extractKnownSkills } from './matching.js';

export type ApplicationDocumentValidationIssue =
  | { code: 'NO_CITATION'; sentenceId: string }
  | { code: 'DUPLICATE_CITATION'; sentenceId: string }
  | { code: 'FACT_NOT_APPROVED'; sentenceId: string; factId: string }
  | { code: 'UNSUPPORTED_CONTENT'; sentenceId: string; item: string }
  | { code: 'INVALID_SENTENCE_KIND'; sentenceId: string }
  | { code: 'INVALID_OFFER_REFERENCE'; sentenceId: string };

export type ApplicationDocumentValidationResult =
  | { ok: true; sentence: ApplicationDocumentSentence }
  | { ok: false; issue: ApplicationDocumentValidationIssue };

type Mention = { item: string; category: 'skill' | 'number' | 'date' | 'credential' | 'entity' };

function normalized(value: string) {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase('en').replace(/\s+/gu, ' ').trim();
}

function supportedByCitedFacts(item: string, citedFacts: string) {
  return containsTerm(citedFacts, item);
}

function cleanMention(value: string) {
  return value.replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '').trim();
}

function sentenceMentions(text: string, offer: ApplicationDocumentOffer): Mention[] {
  const mentions: Mention[] = [];
  for (const requirement of extractKnownSkills(text)) mentions.push({ item: requirement.text, category: 'skill' });

  const datePattern = /\b(?:\d{1,2}[./-]\d{1,2}[./-](?:19|20)?\d{2}|(?:19|20)\d{2}[./-]\d{1,2}(?:[./-]\d{1,2})?|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de)?\s+(?:\d{1,2}(?:,)?\s+)?(?:19|20)\d{2})\b/giu;
  const dateSpans: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(datePattern)) {
    if (!match[0]) continue;
    mentions.push({ item: match[0].trim(), category: 'date' });
    dateSpans.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  for (const match of text.matchAll(/\b\d+(?:[.,]\d+)?\b/gu)) {
    const start = match.index ?? 0;
    if (dateSpans.some((span) => start >= span.start && start < span.end)) continue;
    if (match[0]) mentions.push({ item: match[0], category: 'number' });
  }

  const credentialPattern = /\b(?:PMP|CPA|CFA|CISSP|TOEFL|IELTS|GED|PhD|MBA|(?:AWS\s+)?certified(?:\s+(?:in|as)\s+[\p{L}\p{N}+#.-]+){0,3}|certificaci[oó]n(?:\s+en\s+[\p{L}\p{N}+#.-]+){0,3}|certificad[oa](?:\s+en\s+[\p{L}\p{N}+#.-]+){0,3}|licen[cs]e(?:\s+in\s+[\p{L}\p{N}+#.-]+){0,3}|licencia(?:\s+en\s+[\p{L}\p{N}+#.-]+){0,3})\b/giu;
  for (const match of text.matchAll(credentialPattern)) if (match[0]) mentions.push({ item: match[0].trim(), category: 'credential' });

  for (const term of [offer.company, offer.role, offer.location, offer.snapshot.title]) {
    if (term?.trim() && containsTerm(text, term)) mentions.push({ item: term, category: 'entity' });
  }
  const properNamePattern = /\b(?:at|for|from|with|in|en|para|de|del|desde|con)\s+([\p{Lu}][\p{L}\p{N}&.'’+-]*(?:\s+(?:(?:de|del|la|the|of)\s+)?[\p{Lu}][\p{L}\p{N}&.'’+-]*){0,3})/gu;
  for (const match of text.matchAll(properNamePattern)) {
    const item = match[1] ? cleanMention(match[1]) : '';
    if (item) mentions.push({ item, category: 'entity' });
  }

  const unique = new Map<string, Mention>();
  for (const mention of mentions) unique.set(`${mention.category}:${normalized(mention.item)}`, mention);
  return [...unique.values()];
}

function unsupportedMentions(text: string, citedContent: string, offer: ApplicationDocumentOffer) {
  return sentenceMentions(text, offer).filter((mention) => !supportedByCitedFacts(mention.item, citedContent));
}

export function validateApplicationDocumentSentence(input: {
  sentence: ApplicationDocumentSentence;
  workspaceId: string;
  facts: ApplicationDocumentFact[];
  offer: ApplicationDocumentOffer;
}): ApplicationDocumentValidationResult {
  const sentenceValue = input.sentence;
  if (!['OFFER_REFERENCE', 'BOILERPLATE', 'CANDIDATE_CLAIM'].includes(sentenceValue.kind)
    || !['BUILDER', 'CODEX', 'USER_EDITED', 'USER_UNSUPPORTED'].includes(sentenceValue.origin)
    || (sentenceValue.origin === 'CODEX' && sentenceValue.kind !== 'CANDIDATE_CLAIM')
    || (sentenceValue.origin === 'USER_UNSUPPORTED' && sentenceValue.kind !== 'CANDIDATE_CLAIM')) {
    return { ok: false, issue: { code: 'INVALID_SENTENCE_KIND', sentenceId: sentenceValue.sentenceId } };
  }
  if (sentenceValue.kind === 'OFFER_REFERENCE') {
    return (sentenceValue.language === 'es' || sentenceValue.language === 'en')
      && isExactBuiltApplicationOfferReference(sentenceValue, sentenceValue.language, input.offer)
      ? { ok: true, sentence: sentenceValue }
      : { ok: false, issue: { code: 'INVALID_OFFER_REFERENCE', sentenceId: sentenceValue.sentenceId } };
  }
  if (sentenceValue.kind === 'BOILERPLATE') {
    const fixedLanguage = fixedApplicationDocumentPhraseLanguage(sentenceValue.text);
    if (sentenceValue.origin === 'CODEX' || sentenceValue.sourceFactIds.length || sentenceMentions(sentenceValue.text, input.offer).length
      || (fixedLanguage !== null && sentenceValue.language !== fixedLanguage)) {
      return { ok: false, issue: { code: 'INVALID_SENTENCE_KIND', sentenceId: sentenceValue.sentenceId } };
    }
    return { ok: true, sentence: sentenceValue };
  }
  if (new Set(sentenceValue.sourceFactIds).size !== sentenceValue.sourceFactIds.length) {
    return { ok: false, issue: { code: 'DUPLICATE_CITATION', sentenceId: sentenceValue.sentenceId } };
  }
  if (!sentenceValue.sourceFactIds.length) {
    return sentenceValue.origin === 'USER_UNSUPPORTED'
      ? { ok: true, sentence: sentenceValue }
      : { ok: false, issue: { code: 'NO_CITATION', sentenceId: sentenceValue.sentenceId } };
  }
  const sourceFacts = sentenceValue.sourceFactIds.map((id) => input.facts.find((fact) => fact.id === id));
  const badIndex = sourceFacts.findIndex((fact) => !fact || fact.workspaceId !== input.workspaceId || fact.approval !== 'USER_APPROVED');
  if (badIndex >= 0) {
    return { ok: false, issue: { code: 'FACT_NOT_APPROVED', sentenceId: sentenceValue.sentenceId, factId: sentenceValue.sourceFactIds[badIndex] ?? '' } };
  }
  const citedContent = sourceFacts.map((fact) => `${fact!.text} ${fact!.tags.join(' ')}`).join(' ');
  const unsupported = unsupportedMentions(sentenceValue.text, citedContent, input.offer)[0];
  return unsupported
    ? { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: sentenceValue.sentenceId, item: unsupported.item } }
    : { ok: true, sentence: sentenceValue };
}

/** Applies an edit without mutating its source; confirmation stores unsupported wording but never marks it approved. */
export function saveApplicationDocumentSentenceEdit(input: {
  original: ApplicationDocumentSentence;
  text: string;
  sourceFactIds: string[];
  confirmUnsupported?: boolean;
  workspaceId: string;
  facts: ApplicationDocumentFact[];
  offer: ApplicationDocumentOffer;
}): ApplicationDocumentValidationResult {
  const unchanged = input.text === input.original.text && input.sourceFactIds.length === input.original.sourceFactIds.length
    && input.sourceFactIds.every((id, index) => id === input.original.sourceFactIds[index]);
  if (unchanged) return validateApplicationDocumentSentence({ sentence: input.original, workspaceId: input.workspaceId, facts: input.facts, offer: input.offer });

  const draft: ApplicationDocumentSentence = {
    ...input.original,
    text: input.text,
    sourceFactIds: [...input.sourceFactIds],
    kind: input.original.kind === 'OFFER_REFERENCE' ? 'CANDIDATE_CLAIM' : input.original.kind,
    origin: input.original.origin,
  };
  const mentions = sentenceMentions(draft.text, input.offer);
  if (draft.kind === 'BOILERPLATE' && mentions.length) draft.kind = 'CANDIDATE_CLAIM';
  const validation = validateApplicationDocumentSentence({ sentence: draft, workspaceId: input.workspaceId, facts: input.facts, offer: input.offer });
  if (validation.ok) {
    return { ok: true, sentence: { ...draft, origin: 'USER_EDITED' } };
  }
  const noCitation = validation.issue.code === 'NO_CITATION';
  const unsupportedIssue = validation.issue.code === 'UNSUPPORTED_CONTENT' || noCitation;
  if (unsupportedIssue && input.confirmUnsupported) {
    return { ok: true, sentence: { ...draft, origin: 'USER_UNSUPPORTED' } };
  }
  if (noCitation) {
    const unsupported = unsupportedMentions(draft.text, '', input.offer)[0];
    return { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: draft.sentenceId, item: unsupported?.item ?? 'cita a un hecho aprobado' } };
  }
  return validation;
}

/** Assistant output may only reword an existing claim and must still be supported by approved same-workspace facts. */
export function validateApplicationDocumentAssistantProposal(input: {
  sentence: ApplicationDocumentSentence;
  workspaceId: string;
  facts: ApplicationDocumentFact[];
  offer: ApplicationDocumentOffer;
}): ApplicationDocumentValidationResult {
  if (input.sentence.kind !== 'CANDIDATE_CLAIM' || input.sentence.origin !== 'CODEX') {
    return { ok: false, issue: { code: 'INVALID_SENTENCE_KIND', sentenceId: input.sentence.sentenceId } };
  }
  return validateApplicationDocumentSentence(input);
}
