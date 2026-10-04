import { isApplicationClosedForPreparation } from '@career/domain';
import { createHash } from 'node:crypto';

type Fact = { id: string; kind: string; statement: string; tags: string[]; approvalStatus: string };
const stop = new Set('a an and are as at be by for from in into is it of on or our the to with you your de del el la las los un una y en para por con como que se es su'.split(' '));
const tokens = (value: string) => (value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().match(/[a-z0-9+#.]+/g) ?? []).filter((word) => word.length > 1 && !stop.has(word));

export type SelectedPreparationFact = { id: string; kind: string; statement: string; tags: string[]; score: number; reason: string };

/** Selects only current approved facts with a deterministic lexical overlap against the posting text. */
export function selectRelevantPreparationFacts(facts: Fact[], jobText: string, locale: 'es' | 'en' = 'en'): SelectedPreparationFact[] {
  const jobTokens = new Set(tokens(jobText));
  if (!jobTokens.size) return [];
  return facts.filter((fact) => fact.approvalStatus === 'USER_APPROVED').map((fact) => {
    const factTokens = [...new Set(tokens(`${fact.statement} ${fact.tags.join(' ')}`))];
    const matched = factTokens.filter((token) => jobTokens.has(token));
    return { ...fact, score: matched.length, reason: matched.length ? `${locale === 'es' ? 'Coincide con el anuncio' : 'Matches job wording'}: ${matched.slice(0, 5).join(', ')}` : '' };
  }).filter((fact) => fact.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 30);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function preparationKey(input: {
  profileRevisionId: string | null; snapshotId: string | null; locale: 'es' | 'en';
  identity: { fullName: string; email: string };
  facts: Array<{ id: string; kind: string; printedText: string; tags: string[] }>;
  answers: Array<{ id: string; semanticKey: string; jurisdiction: string; questionScope: string; revision: number; value: unknown }>;
}) {
  const fingerprint = {
    profileRevisionId: input.profileRevisionId, snapshotId: input.snapshotId, locale: input.locale,
    identity: { fullName: input.identity.fullName, email: input.identity.email },
    facts: [...input.facts].sort((a, b) => a.id.localeCompare(b.id)),
    answers: [...input.answers].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return createHash('sha256').update(stableJson(fingerprint)).digest('hex');
}

export function preparationGaps(input: { profileExists: boolean; fullName: string; email: string; factCount: number; jobTextAvailable: boolean }) {
  const gaps: string[] = [];
  if (!input.profileExists) gaps.push('PROFILE_REQUIRED');
  if (!input.fullName.trim()) gaps.push('FULL_NAME_REQUIRED');
  if (!input.email.trim()) gaps.push('EMAIL_REQUIRED');
  if (!input.jobTextAvailable) gaps.push('JOB_TEXT_UNAVAILABLE');
  if (!input.factCount) gaps.push('RELEVANT_APPROVED_EVIDENCE_REQUIRED');
  return gaps;
}

export function applicationPreparationBlockReason(application: { state: string; recruitmentStage: string; documentId: string | null } | null, generatedDocumentId?: string | null) {
  if (!application) return null;
  if (application.documentId && application.documentId !== generatedDocumentId) return 'USER_SELECTED_DOCUMENT_PRESERVED';
  if (isApplicationClosedForPreparation(application) || ['UNKNOWN', 'IN_PROGRESS'].includes(application.state)) return 'APPLICATION_CLOSED_OR_UNCERTAIN';
  return null;
}


export function findPriorPreparationResult<T>(events: Array<{ preparationKey?: unknown; result?: unknown }>, key: string): T | undefined {
  return events.find((event) => event.preparationKey === key)?.result as T | undefined;
}
