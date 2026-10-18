import {
  fixedApplicationDocumentPhraseLanguage,
  isExactBuiltApplicationOfferReference,
  type ApplicationDocumentFact,
  type ApplicationDocumentOffer,
  type ApplicationDocumentSentence,
} from './application-documents-builder.js';
import { containsTerm, extractKnownSkills, type Requirement } from './matching.js';

export type ApplicationDocumentValidationIssue =
  | { code: 'NO_CITATION'; sentenceId: string }
  | { code: 'DUPLICATE_CITATION'; sentenceId: string }
  | { code: 'DUPLICATE_SENTENCE_ID'; sentenceId: string }
  | { code: 'FACT_NOT_APPROVED'; sentenceId: string; factId: string }
  | { code: 'UNSUPPORTED_CONTENT'; sentenceId: string; item: string }
  | { code: 'INVALID_SENTENCE_KIND'; sentenceId: string }
  | { code: 'INVALID_OFFER_REFERENCE'; sentenceId: string };

export type ApplicationDocumentValidationResult =
  | { ok: true; sentence: ApplicationDocumentSentence }
  | { ok: false; issue: ApplicationDocumentValidationIssue };

type Mention = { item: string; category: 'skill' | 'number' | 'date' | 'credential' | 'entity' | 'qualitative'; requirement?: Requirement };

function normalized(value: string) {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase('en').replace(/\s+/gu, ' ').trim();
}

const skillAliasesByCanonical: Record<string, string[]> = {
  java: ['java'],
  kotlin: ['kotlin'],
  python: ['python'],
  typescript: ['typescript'],
  javascript: ['javascript'],
  sql: ['sql', 'postgresql', 'mysql'],
  'rest-assured': ['rest assured', 'rest-assured'],
  'api-testing': ['api testing', 'api test'],
  playwright: ['playwright'],
  cypress: ['cypress'],
  selenium: ['selenium'],
  jenkins: ['jenkins'],
  'ci-cd': ['ci/cd'],
  'continuous integration': ['continuous integration', 'integración continua'],
  'continuous delivery': ['continuous delivery', 'entrega continua'],
  'continuous deployment': ['continuous deployment', 'despliegue continuo'],
  docker: ['docker'],
  kubernetes: ['kubernetes'],
  aws: ['aws', 'amazon web services'],
  azure: ['azure'],
  gcp: ['gcp', 'google cloud'],
  git: ['git'],
  agile: ['agile', 'scrum'],
  linux: ['linux'],
  graphql: ['graphql'],
  react: ['react'],
  'node.js': ['node.js', 'nodejs'],
  figma: ['figma'],
  terraform: ['terraform'],
};

const equivalentSkillAliases: Record<string, string[]> = {
  aws: ['aws', 'amazon web services'],
  'amazon web services': ['aws', 'amazon web services'],
  gcp: ['gcp', 'google cloud'],
  'google cloud': ['gcp', 'google cloud'],
  'rest assured': ['rest assured', 'rest-assured'],
  'rest-assured': ['rest assured', 'rest-assured'],
  'api testing': ['api testing', 'api test'],
  'api test': ['api testing', 'api test'],
  'node.js': ['node.js', 'nodejs'],
  nodejs: ['node.js', 'nodejs'],
  'continuous integration': ['continuous integration', 'integración continua'],
  'integración continua': ['continuous integration', 'integración continua'],
  'continuous delivery': ['continuous delivery', 'entrega continua'],
  'entrega continua': ['continuous delivery', 'entrega continua'],
  'continuous deployment': ['continuous deployment', 'despliegue continuo'],
  'despliegue continuo': ['continuous deployment', 'despliegue continuo'],
};

const qualitativeClaims = [
  'adaptable', 'ambitious', 'analytical', 'collaborative', 'communicative', 'creative', 'curious', 'dedicated',
  'detail-oriented', 'effective', 'empathetic', 'exceptional', 'hardworking', 'innovative', 'motivated', 'organized',
  'passionate', 'proactive', 'reliable', 'resilient', 'strategic', 'versatile', 'motivado', 'motivada', 'colaborativo',
  'colaborativa', 'comunicativo', 'comunicativa', 'creativo', 'creativa', 'dedicado', 'dedicada', 'detallista',
  'eficaz', 'empatico', 'empatica', 'excepcional', 'innovador', 'innovadora', 'organizado', 'organizada', 'apasionado',
  'apasionada', 'proactivo', 'proactiva', 'confiable', 'resiliente', 'estrategico', 'estrategica', 'versatil', 'curioso',
  'curiosa', 'ambicioso', 'ambiciosa',
];

const firstPersonSelfDescriptions = ['fast learner', 'quick learner', 'lifelong learner', 'self-starter', 'natural leader', 'team player'];

function plainBoilerplateLanguage(text: string): 'es' | 'en' | null {
  const fixedLanguage = fixedApplicationDocumentPhraseLanguage(text);
  if (fixedLanguage !== null) return fixedLanguage;
  const value = normalized(text).replace(/[.!?,:;]+$/u, '').trim();
  if (/^(?:gracias|muchas gracias|saludos|saludos cordiales|atentamente|cordialmente|con gratitud)$/u.test(value)) return 'es';
  if (/^(?:hello|hi|dear hiring manager|dear recruiter|dear hiring team|greetings|best regards|kind regards|warm regards|regards|sincerely|yours sincerely|yours faithfully)$/u.test(value)) return 'en';
  return null;
}

function plainBoilerplate(text: string) {
  return plainBoilerplateLanguage(text) !== null;
}

function skillMentions(text: string): Mention[] {
  const mentions: Mention[] = [];
  for (const requirement of extractKnownSkills(text)) {
    const aliases = skillAliasesByCanonical[normalized(requirement.text)] ?? [requirement.text];
    for (const item of aliases.filter((alias) => containsTerm(text, alias))) {
      mentions.push({ item: cleanMention(item), category: 'skill', requirement });
    }
  }
  return mentions;
}

function supportedByCitedFacts(mention: Mention, citedFacts: ApplicationDocumentFact[]) {
  if (mention.category === 'skill' && mention.requirement) {
    // CI, CD and combined CI/CD are related, but one does not prove another.
    if (normalized(mention.requirement.text) === 'ci-cd') {
      return citedFacts.some((fact) => containsTerm(`${fact.text} ${fact.tags.join(' ')}`, mention.item));
    }
    const aliases = equivalentSkillAliases[normalized(mention.item)] ?? [mention.item];
    return citedFacts.some((fact) => aliases.some((alias) =>
      fact.tags.some((tag) => normalized(tag) === normalized(alias))
      || containsTerm(`${fact.text} ${fact.tags.join(' ')}`, alias)));
  }
  const citedContent = citedFacts.map((fact) => `${fact.text} ${fact.tags.join(' ')}`).join(' ');
  if (mention.category === 'number' && /\p{N}/u.test(mention.item)) {
    // Preserve currency, percentage, multiplier, unit and ordinal markers. The generic
    // normalizer strips several of these, which could otherwise equate e.g. €2M and $2M.
    const escape = mention.item.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\s+/gu, '\\s+');
    return new RegExp(`(?<![\\p{L}\\p{N}])${escape}(?![\\p{L}\\p{N}])`, 'iu').test(citedContent);
  }
  return containsTerm(citedContent, mention.item);
}

function cleanMention(value: string) {
  let start = 0;
  let end = value.length;
  while (start < end) {
    const character = String.fromCodePoint(value.codePointAt(start)!);
    if (!/[\s\p{P}]/u.test(character)) break;
    start += character.length;
  }
  while (end > start) {
    let index = end - 1;
    const lastCodeUnit = value.charCodeAt(index);
    if (lastCodeUnit >= 0xdc00 && lastCodeUnit <= 0xdfff && index > start) index -= 1;
    const character = value.slice(index, end);
    if (!/[\s\p{P}]/u.test(character)) break;
    end = index;
  }
  return value.slice(start, end).trim();
}

function sentenceMentions(text: string, offer: ApplicationDocumentOffer): Mention[] {
  const mentions: Mention[] = skillMentions(text);

  for (const item of qualitativeClaims) {
    const escaped = item.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\s+/gu, '\\s+');
    const firstPersonTrait = new RegExp(
      `\\b(?:i am|i'm|i feel|i consider myself|i see myself as|soy|me siento|me considero)\\s+(?:(?:a|an|very|highly|deeply|extremely|really|incredibly|muy|altamente|bastante|sumamente|un|una)\\s+)*(?:[\\p{L}-]+\\s+(?:and|or|y|o)\\s+)?${escaped}(?![\\p{L}])`,
      'iu',
    );
    if (firstPersonTrait.test(text)) mentions.push({ item, category: 'qualitative' });
  }
  for (const item of firstPersonSelfDescriptions) {
    const escaped = item.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\s+/gu, '\\s+');
    if (new RegExp(`\\b(?:i am|i'm|soy|me considero|me siento)\\s+(?:a|an|un|una)?\\s*${escaped}(?![\\p{L}])`, 'iu').test(text)) {
      mentions.push({ item, category: 'qualitative' });
    }
  }

  const datePattern = /\b(?:\d{1,2}[./-]\d{1,2}[./-](?:19|20)?\d{2}|(?:19|20)\d{2}[./-]\d{1,2}(?:[./-]\d{1,2})?|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de)?\s+(?:\d{1,2}(?:,)?\s+)?(?:19|20)\d{2})\b/giu;
  const dateSpans: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(datePattern)) {
    if (!match[0]) continue;
    mentions.push({ item: match[0].trim(), category: 'date' });
    dateSpans.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  const numericClaimPattern = /(?<![\p{L}\p{N}])(?:x\s*)?(?:[$€£]\s*)?\d+(?:[.,]\d+)*(?:\s?(?:k|m|b|x|%|percent|percentage|st|nd|rd|th|er|º|ª|ms|gb|mb|kb|s|sec|seconds?|minutes?|hours?|days?|years?))?(?![\p{L}\p{N}])/giu;
  for (const match of text.matchAll(numericClaimPattern)) {
    const start = match.index ?? 0;
    if (dateSpans.some((span) => start >= span.start && start < span.end)) continue;
    if (match[0]) mentions.push({ item: match[0], category: 'number' });
  }

  const numberWords = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|hundreds|thousand|thousands|million|millions|billion|billions|dozen|dozens|tens|scores|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|cero|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce|trece|catorce|quince|diecis[eé]is|diecisiete|dieciocho|diecinueve|veinte|veinti[a-záéíóúñ]+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|cientos|decena|decenas|centena|centenas|centenares|millares|doscient[oa]s|trescient[oa]s|cuatrocient[oa]s|quinient[oa]s|seiscient[oa]s|setecient[oa]s|ochocient[oa]s|novecient[oa]s|mil|miles|mill[oó]n|millones|bill[oó]n|billones|docena|docenas|primer[oa]?s?|segund[oa]s?|tercer[oa]s?|cuart[oa]s?|quint[oa]s?|sext[oa]s?|s[eé]ptim[oa]s?|octav[oa]s?|noven[oa]s?|d[eé]cim[oa]s?)\b/giu;
  for (const match of text.matchAll(numberWords)) if (match[0]) mentions.push({ item: match[0], category: 'number' });
  // "Once" is a Spanish cardinal in phrases such as "once equipos", but an English
  // temporal adverb in "I once led". Require nearby Spanish grammar to classify it.
  const spanishOncePattern = /\b(?:dirig[ií]|lider[eé]|gestion[eé]|constru[ií]|fund[eé]|desarroll[eé]|automatic[eé])\s+once\s+(?:equipos?|personas?|usuarios?|clientes?|pagos?|pruebas?|proyectos?|a[nñ]os?|meses?|soluciones?|productos?)\b/giu;
  for (const match of text.matchAll(spanishOncePattern)) if (match[0]) mentions.push({ item: 'once', category: 'number' });

  const credentialPattern = /\b(?:PMP|CPA|CFA|CISSP|TOEFL|IELTS|GED|PhD|MBA|doctorate|doctorado|(?:master(?:s|[’']s)?|bachelor(?:s|[’']s)?)(?:\s+degree)?(?:\s+(?:in|of)\s+[\p{L}\p{N}+#.-]+(?:\s+(?!(?:from|at|by|con|en|de|del|para)\b)[\p{L}\p{N}+#.-]+){0,2})?|BS|BA|MS|MA|BSc|MSc|m[aá]ster|maestr[ií]a(?:\s+en\s+[\p{L}\p{N}+#.-]+){0,3}|licenciatura(?:\s+en\s+[\p{L}\p{N}+#.-]+){0,3}|certificate(?:\s+(?:in|of)\s+[\p{L}\p{N}+#.-]+){0,3}|certification(?:\s+(?:in|of)\s+[\p{L}\p{N}+#.-]+){0,3}|certificado(?:\s+en\s+[\p{L}\p{N}+#.-]+){0,3}|certificada(?:\s+en\s+[\p{L}\p{N}+#.-]+){0,3}|certificaci[oó]n(?:\s+en\s+[\p{L}\p{N}+#.-]+){0,3}|(?:AWS\s+)?certified(?:\s+(?:in|as)\s+[\p{L}\p{N}+#.-]+){0,3}|licen[cs]e(?:\s+in\s+[\p{L}\p{N}+#.-]+){0,3}|licencia(?:\s+en\s+[\p{L}\p{N}+#.-]+){0,3})\b/giu;
  for (const match of text.matchAll(credentialPattern)) if (match[0]) mentions.push({ item: match[0].trim(), category: 'credential' });

  for (const term of [offer.company, offer.role, offer.location, offer.snapshot.title]) {
    if (term?.trim() && containsTerm(text, term)) mentions.push({ item: term, category: 'entity' });
  }
  const properNamePattern = /\b(?:at|for|from|with|in|en|para|de|del|desde|con)\s+([\p{Lu}][\p{L}\p{N}&.'’+-]*(?:\s+(?:(?:de|del|la|the|of)\s+)?[\p{Lu}][\p{L}\p{N}&.'’+-]*){0,3})/gu;
  for (const match of text.matchAll(properNamePattern)) {
    const item = match[1] ? cleanMention(match[1]) : '';
    if (item) mentions.push({ item, category: 'entity' });
  }
  const capitalizedEntityPattern = /(?<![\p{L}\p{N}])([\p{Lu}][\p{L}\p{N}&.'’+-]*(?:\s+[\p{Lu}][\p{L}\p{N}&.'’+-]*){1,3})(?![\p{L}\p{N}])/gu;
  const sentenceStarterWords = new Set(['i', 'we', 'my', 'our', 'used', 'built', 'worked', 'led', 'created', 'designed', 'developed', 'managed', 'implemented', 'use', 'using', 'shipped', 'spearheaded', 'automated', 'automating', 'introduced', 'architected', 'launched', 'delivered', 'improved', 'drove', 'owned', 'mentored', 'optimized', 'integrated', 'tested', 'founded', 'joined', 'acquired', 'the', 'this', 'these', 'those', 'cree', 'atentamente', 'saludo', 'saludos', 'hello', 'hola', 'dear', 'yours', 'estimado', 'estimada', 'estimados', 'estimadas', 'cordialmente', 'tengo', 'soy', 'probe', 'trabaje', 'disene', 'desarrolle', 'lidere', 'dirigi', 'analice', 'automatice', 'escribi', 'implemente', 'gestione', 'funde', 'construi', 'integre', 'best', 'kind', 'warm', 'regards', 'sincerely', 'all', 'thank', 'thanks', 'cheers']);
  const capitalizedEntitySpans: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(capitalizedEntityPattern)) {
    const item = match[1] ? cleanMention(match[1]) : '';
    const firstWord = normalized(item.split(/\s+/u)[0] ?? '');
    if (item && !sentenceStarterWords.has(firstWord)
      && !['best regards', 'kind regards', 'warm regards'].includes(normalized(item))) {
      mentions.push({ item, category: 'entity' });
      capitalizedEntitySpans.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    }
  }
  const camelCaseEntityPattern = /\b[\p{Ll}][\p{Lu}][\p{L}\p{N}&.'’+-]*/gu;
  const recognizedSkills = new Set(mentions.filter((mention) => mention.category === 'skill').map((mention) => normalized(mention.item)));
  for (const match of text.matchAll(camelCaseEntityPattern)) {
    const item = cleanMention(match[0]);
    if (item && !recognizedSkills.has(normalized(item))) mentions.push({ item, category: 'entity' });
  }
  const capitalizedTokenPattern = /(?<![\p{L}\p{N}])[\p{Lu}][\p{L}\p{N}&.'’+-]{1,}(?![\p{L}\p{N}])/gu;
  for (const match of text.matchAll(capitalizedTokenPattern)) {
    const item = cleanMention(match[0]);
    const start = match.index ?? 0;
    if (!item || capitalizedEntitySpans.some((span) => start >= span.start && start < span.end)
      || recognizedSkills.has(normalized(item)) || sentenceStarterWords.has(normalized(item))) continue;
    mentions.push({ item, category: 'entity' });
  }
  const lowercaseEmployerPattern = /\b(?:at|for|from|with|joined|employed by|hired by|en|para|desde|con|de|a)\s+([\p{Ll}][\p{L}\p{N}&.'’+-]{2,})/giu;
  const lowercaseCompanyAfterVerbPattern = /(?<![\p{L}\p{N}])(?:led|managed|founded|joined|built|acquired|integrated|tested|fund[eé]|constru[ií]|lider[eé]|dirig[ií]|gestion[eé]|prob[eé])\s+([\p{Ll}][\p{L}\p{N}&.'’+-]{2,})/giu;
  const lowercaseEntityStopWords = new Set(['the', 'and', 'for', 'from', 'with', 'work', 'home', 'school', 'college', 'university', 'office', 'scale', 'pace', 'team', 'teams', 'company', 'business', 'startup', 'startups', 'users', 'clients', 'customers', 'stakeholders', 'years', 'year', 'months', 'month', 'experience', 'engineering', 'marketing', 'sales', 'finance', 'product', 'products', 'software', 'data', 'services', 'service', 'projects', 'project', 'payments', 'payment', 'testing', 'tests', 'apps', 'applications', 'platforms', 'systems', 'solutions', 'features', 'interfaces', 'products', 'teams', 'datos', 'pagos', 'pruebas', 'experiencia', 'trabajo', 'equipo', 'empresa', 'compañia', 'compania', 'reusable', 'automated', 'automating', 'automatically', 'integrated', 'continuous', 'automatable', 'scalable', 'reliable', 'modern', 'multiple', 'complex', 'custom', 'internal', 'external', 'checkout']);
  for (const match of text.matchAll(lowercaseEmployerPattern)) {
    const item = cleanMention(match[1] ?? '');
    if (item && !lowercaseEntityStopWords.has(normalized(item)) && !recognizedSkills.has(normalized(item))) mentions.push({ item, category: 'entity' });
  }
  for (const match of text.matchAll(lowercaseCompanyAfterVerbPattern)) {
    const item = cleanMention(match[1] ?? '');
    if (item && !lowercaseEntityStopWords.has(normalized(item)) && !recognizedSkills.has(normalized(item))) mentions.push({ item, category: 'entity' });
  }
  const leadingEmployerPattern = /^\s*([\p{Lu}][\p{L}\p{N}&.'’+-]{2,})\s+(?:employed|hired|acquired|merged|laid\s+off|promoted|recruited)\b/u;
  const leadingEmployer = text.match(leadingEmployerPattern)?.[1];
  if (leadingEmployer) mentions.push({ item: cleanMention(leadingEmployer), category: 'entity' });

  const jobTitlePattern = /\b(?:(?:senior|junior|lead|principal|staff|s[eé]nior|j[uú]nior|l[ií]der|especialista|responsable)\s+)?(?:product|software|data|ux|ui|platform|frontend|front-end|backend|back-end|cloud|machine learning|producto|datos|dise[nñ]o|plataforma|desarrollo|anal[ií]tica|qa|quality assurance|test|testing|sdet|automation|engineering|ingenier[ií]a|calidad|automatizaci[oó]n)\s+(?:engineer|developer|designer|analyst|manager|architect|scientist|researcher|director|lead|ingeniero|desarrollador|dise[nñ]ador|analista|gerente|arquitecto|cient[ií]fico|responsable|l[ií]der)\b/giu;
  for (const match of text.matchAll(jobTitlePattern)) if (match[0]) mentions.push({ item: match[0].trim(), category: 'entity' });
  const genericJobTitlePattern = /\b(?:(?:senior|junior|principal|staff|lead|s[eé]nior|j[uú]nior|l[ií]der|especialista|responsable)\s+)?(?:engineer|developer|designer|analyst|manager|architect|scientist|researcher|director|tester|consultant|investigator|ingenier[oa]|desarrollador(?:a)?|dise[nñ]ador(?:a)?|analista|gerente|arquitect[oa]|cient[ií]fic[oa]|investigador(?:a|es)?|directora?|responsable)(?:\s+(?:(?:of|in|de|del|en)\s+)?(?:software|engineering|datos|sistemas|calidad|automatizaci[oó]n|pruebas?|testing|backend|frontend|plataforma|ciencia|investigaci[oó]n|producto|data))?\b/giu;
  for (const match of text.matchAll(genericJobTitlePattern)) if (match[0]) mentions.push({ item: cleanMention(match[0]), category: 'entity' });
  const standaloneTitlePattern = /\b(?:sdet|qa|quality assurance|test engineer|testing engineer|automation engineer)\b/giu;
  for (const match of text.matchAll(standaloneTitlePattern)) if (match[0]) mentions.push({ item: cleanMention(match[0]), category: 'entity' });
  const leadershipTitlePattern = /\b(?:head\s+of\s+[\p{L}-]+|team\s+lead|tech(?:nical)?\s+lead|engineering\s+lead|vp\s+of\s+[\p{L}-]+|vice\s+president\s+of\s+[\p{L}-]+|chief\s+[\p{L}-]+\s+officer)\b/giu;
  for (const match of text.matchAll(leadershipTitlePattern)) if (match[0]) mentions.push({ item: cleanMention(match[0]), category: 'entity' });

  const unique = new Map<string, Mention>();
  for (const mention of mentions) unique.set(`${mention.category}:${normalized(mention.item)}`, mention);
  return [...unique.values()];
}

function unsupportedMentions(text: string, citedFacts: ApplicationDocumentFact[], offer: ApplicationDocumentOffer) {
  const categoryOrder: Record<Mention['category'], number> = { skill: 0, qualitative: 0, number: 1, date: 1, credential: 1, entity: 2 };
  return sentenceMentions(text, offer)
    .filter((mention) => !supportedByCitedFacts(mention, citedFacts))
    .map((mention, index) => ({ mention, index }))
    .sort((left, right) => categoryOrder[left.mention.category] - categoryOrder[right.mention.category]
      || (left.mention.category === 'entity' && right.mention.category === 'entity'
        ? right.mention.item.length - left.mention.item.length
        : left.index - right.index))
    .map(({ mention }) => mention);
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
    const fixedLanguage = plainBoilerplateLanguage(sentenceValue.text);
    if (sentenceValue.origin === 'CODEX' || sentenceValue.sourceFactIds.length || !plainBoilerplate(sentenceValue.text)
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
  const unsupported = unsupportedMentions(sentenceValue.text, sourceFacts as ApplicationDocumentFact[], input.offer)[0];
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
  if (unchanged && input.original.origin === 'USER_UNSUPPORTED') {
    if (input.original.kind !== 'CANDIDATE_CLAIM') {
      return { ok: false, issue: { code: 'INVALID_SENTENCE_KIND', sentenceId: input.original.sentenceId } };
    }
    if (new Set(input.original.sourceFactIds).size !== input.original.sourceFactIds.length) {
      return { ok: false, issue: { code: 'DUPLICATE_CITATION', sentenceId: input.original.sentenceId } };
    }
    for (const factId of input.original.sourceFactIds) {
      const fact = input.facts.find((candidate) => candidate.id === factId);
      if (!fact || fact.workspaceId !== input.workspaceId || fact.approval !== 'USER_APPROVED') {
        return { ok: false, issue: { code: 'FACT_NOT_APPROVED', sentenceId: input.original.sentenceId, factId } };
      }
    }
    return { ok: true, sentence: input.original };
  }
  if (unchanged) return validateApplicationDocumentSentence({ sentence: input.original, workspaceId: input.workspaceId, facts: input.facts, offer: input.offer });

  const draft: ApplicationDocumentSentence = {
    ...input.original,
    text: input.text,
    sourceFactIds: [...input.sourceFactIds],
    kind: input.original.kind === 'OFFER_REFERENCE' ? 'CANDIDATE_CLAIM' : input.original.kind,
    origin: input.original.origin,
  };
  if (draft.kind === 'BOILERPLATE') {
    const boilerplateLanguage = plainBoilerplateLanguage(draft.text);
    if (boilerplateLanguage === null) draft.kind = 'CANDIDATE_CLAIM';
    else draft.language = boilerplateLanguage;
  }
  if (draft.kind === 'CANDIDATE_CLAIM' && !draft.sourceFactIds.length && !input.confirmUnsupported) {
    const unsupported = unsupportedMentions(draft.text, [], input.offer)[0];
    return unsupported
      ? { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: draft.sentenceId, item: unsupported.item } }
      : { ok: false, issue: { code: 'NO_CITATION', sentenceId: draft.sentenceId } };
  }
  if (draft.kind === 'CANDIDATE_CLAIM' && !draft.sourceFactIds.length && input.confirmUnsupported) {
    return { ok: true, sentence: { ...draft, origin: 'USER_UNSUPPORTED' } };
  }
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
    const unsupported = unsupportedMentions(draft.text, [], input.offer)[0];
    return unsupported
      ? { ok: false, issue: { code: 'UNSUPPORTED_CONTENT', sentenceId: draft.sentenceId, item: unsupported.item } }
      : { ok: false, issue: { code: 'NO_CITATION', sentenceId: draft.sentenceId } };
  }
  return validation;
}

/** Assistant output may only reword an existing claim and must still be supported by approved same-workspace facts. */
export function validateApplicationDocumentAssistantProposal(input: {
  sentence: ApplicationDocumentSentence;
  original: ApplicationDocumentSentence;
  workspaceId: string;
  facts: ApplicationDocumentFact[];
  offer: ApplicationDocumentOffer;
}): ApplicationDocumentValidationResult {
  if (input.sentence.kind !== 'CANDIDATE_CLAIM' || input.sentence.origin !== 'CODEX'
    || input.original.kind !== 'CANDIDATE_CLAIM' || input.original.origin === 'USER_UNSUPPORTED'
    || input.sentence.sentenceId !== input.original.sentenceId
    || input.sentence.language !== input.original.language
    || input.sentence.sourceFactIds.length !== input.original.sourceFactIds.length
    || !input.sentence.sourceFactIds.every((id, index) => id === input.original.sourceFactIds[index])) {
    return { ok: false, issue: { code: 'INVALID_SENTENCE_KIND', sentenceId: input.sentence.sentenceId } };
  }
  const originalValidation = validateApplicationDocumentSentence({ ...input, sentence: input.original });
  if (!originalValidation.ok) return originalValidation;
  return validateApplicationDocumentSentence(input);
}
