import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AI_SCHEMA_VERSION, aiIdSchema, aiSourceSnapshotSchema, educationSchema, employmentSchema,
  printedResumeIdentity, printedStatement, type AiLocale, type AiSourceSnapshot, type StructuredEntry,
} from '@career/domain';
import { decodeEntities, htmlToText } from '../sources.js';
import { hashAiInputContent } from './prompts.js';

const id = z.string().uuid();
const selectedFacts = z.array(id).max(500).refine((ids) => new Set(ids).size === ids.length);
const locale = z.enum(['es', 'en']);
/** Browser requests name sources; source content, policy, approval and hashes are always loaded by the server. */
export const aiSourceRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('SEARCH_DRAFT'), locale, searchRequest: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ operation: z.literal('JOB_ANALYSIS'), locale, jobId: id, selectedFactIds: selectedFacts.default([]) }).strict(),
  z.object({ operation: z.literal('RESUME_DRAFT'), locale, jobId: id, selectedFactIds: selectedFacts.refine((ids) => ids.length > 0) }).strict(),
  z.object({ operation: z.literal('ANSWER_DRAFT'), locale, questionId: id, jobId: id.optional(), selectedFactIds: selectedFacts.default([]) }).strict(),
]);
export type AiSourceRequest = z.infer<typeof aiSourceRequestSchema>;

export type AiSourceErrorCode = 'AI_INVALID_REQUEST' | 'AI_SOURCE_MISSING' | 'AI_SOURCE_INVALID' | 'AI_SOURCE_CHANGED' | 'AI_SOURCE_TOO_LARGE';
export class AiSourceError extends Error {
  constructor(readonly code: AiSourceErrorCode) { super(code); this.name = 'AiSourceError'; }
}

/** These are trusted database projections, never objects deserialized from an HTTP request. */
export type AiProfileSource = { id: string; workspaceId: string; revision: number; profile: Record<string, unknown> };
export type AiFactSource = {
  id: string; workspaceId: string; profileVersionId: string; kind: string; statement: string; details: StructuredEntry | null;
  tags: string[]; source: string; approvalStatus: string; createdAt: Date;
};
export type AiJobSource = { id: string; workspaceId: string; title: string; company: string; location: string | null };
export type AiJobSnapshotSource = { id: string; workspaceId: string; jobId: string; title: string; descriptionText: string | null };
/** A current saved question. Mutable semanticKey/strategy/value are deliberately not inputs to classification. */
export type AiQuestionSource = { id: string; workspaceId: string; questionText: string | null; jurisdiction: string; questionScope: string };
export type AiSourceRecords = {
  /** latestProfile(workspace), and latestFacts(workspace, profile.id), read consistently by the caller. */
  profile?: AiProfileSource | null;
  facts?: readonly AiFactSource[];
  job?: AiJobSource | null;
  /** Latest saved posting for the requested job, selected by fetchedAt and id. */
  jobSnapshot?: AiJobSnapshotSource | null;
  /** Latest answer version for this exact question scope; never an older row selected only by its ID. */
  question?: AiQuestionSource | null;
  /** Only needed to resolve exact copies of referenced facts after a profile revision, scoped to the workspace. */
  historicalFacts?: readonly AiFactSource[];
};

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const placeholderHash = '0'.repeat(64);

const experienceQuestions = new Set([
  'describe your relevant work experience.', 'describe your relevant work experience',
  'describe your customer service experience.', 'describe your customer service experience',
  'describe a project you worked on.', 'describe a project you worked on',
  'describe tu experiencia laboral relevante.', 'describe tu experiencia laboral relevante',
  'describe tu experiencia en atención al cliente.', 'describe tu experiencia en atención al cliente',
  'describe un proyecto en el que hayas trabajado.', 'describe un proyecto en el que hayas trabajado',
]);
/** Intentionally conservative. A known prefix followed by a personal question is not a known template. */
export function classifyAiQuestion(text: string): 'EXPERIENCE_DRAFT' | 'USER_ONLY' {
  return experienceQuestions.has(text.normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('und')) ? 'EXPERIENCE_DRAFT' : 'USER_ONLY';
}

export function parseAiSourceRequest(input: unknown): AiSourceRequest {
  const parsed = aiSourceRequestSchema.safeParse(input);
  if (!parsed.success) throw new AiSourceError('AI_INVALID_REQUEST');
  return parsed.data;
}

function requireProfile(workspaceId: string, records: AiSourceRecords): AiProfileSource {
  const profile = records.profile;
  if (!profile || profile.workspaceId !== workspaceId) throw new AiSourceError('AI_SOURCE_MISSING');
  if (!aiIdSchema.safeParse(profile.id).success || !Number.isSafeInteger(profile.revision) || profile.revision < 1) throw new AiSourceError('AI_SOURCE_INVALID');
  return profile;
}

function identityHash(profile: AiProfileSource): string {
  return hash(printedResumeIdentity(profile.profile));
}

/** Validate persisted structured entries before using the existing PDF formatter; never infer or fill dates. */
function factText(fact: AiFactSource, language: AiLocale): string {
  const entry = fact.details;
  if (entry) {
    if (typeof entry.description !== 'string' || entry.description.length > 4000) throw new AiSourceError('AI_SOURCE_INVALID');
    const dates = { startMonth: entry.startMonth, ...(entry.endMonth !== undefined ? { endMonth: entry.endMonth } : {}), current: entry.current, locale: entry.locale };
    const valid = entry.type === 'employment' && fact.kind === 'experience'
      ? employmentSchema.safeParse({ ...dates, role: entry.title, company: entry.organization }).success
      : entry.type === 'education' && fact.kind === 'education'
        ? educationSchema.safeParse({ ...dates, qualification: entry.title, institution: entry.organization }).success : false;
    if (!valid) throw new AiSourceError('AI_SOURCE_INVALID');
  }
  if (typeof fact.statement !== 'string') throw new AiSourceError('AI_SOURCE_INVALID');
  return printedStatement(fact, language).trim();
}

function factEvidence(fact: AiFactSource, language: AiLocale): AiSourceSnapshot['facts'][number] {
  const text = factText(fact, language);
  return { factId: fact.id, approvalStatus: 'USER_APPROVED', kind: fact.kind, text, contentHash: hash([fact.kind, text]) };
}

/** Exact copy identity mirrors document-reuse. Creation time prevents a new, unrelated identical fact being substituted. */
function copyHash(fact: AiFactSource): string {
  if (!(fact.createdAt instanceof Date) || !Number.isFinite(fact.createdAt.getTime())) throw new AiSourceError('AI_SOURCE_INVALID');
  const entry = fact.details;
  // Fixed-order fields avoid depending on PostgreSQL JSONB object-key order.
  const details = entry ? [entry.type, entry.title, entry.organization, entry.startMonth, entry.endMonth ?? null, entry.current, entry.description, entry.locale] : null;
  return hash([fact.createdAt.toISOString(), fact.kind, fact.statement, fact.tags, fact.source, details]);
}

/** Unlike feed normalization this never truncates. Oversized sources fail before a model can see an incomplete clause. */
function normalizedDescription(value: string | null): string {
  if (value === null) return '';
  if (typeof value !== 'string') throw new AiSourceError('AI_SOURCE_INVALID');
  if (value.length > 200_000) throw new AiSourceError('AI_SOURCE_TOO_LARGE');
  let text = value;
  for (let level = 0; level < 2; level++) { const decoded = decodeEntities(text); if (decoded === text) break; text = decoded; }
  if (/<\/?(?:p|div|br|li|ul|ol|h[1-6]|table|tr|td|section|article|strong|em|b|i|span|a|script|style|noscript|template)\b[^>]*>/iu.test(text)) return htmlToText(text);
  return text.replace(/\r\n?/gu, '\n').replace(/[\u00a0\t\f\v ]+/gu, ' ').split('\n').map((line) => line.trim()).join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function jobEvidence(workspaceId: string, jobId: string, records: AiSourceRecords): NonNullable<AiSourceSnapshot['job']> {
  const job = records.job; const posting = records.jobSnapshot;
  if (!job || job.id !== jobId || job.workspaceId !== workspaceId || !posting || posting.workspaceId !== workspaceId || posting.jobId !== jobId) throw new AiSourceError('AI_SOURCE_MISSING');
  if (typeof posting.title !== 'string' || !posting.title.trim() || typeof job.company !== 'string' || !job.company.trim()
    || (job.location !== null && typeof job.location !== 'string')) throw new AiSourceError('AI_SOURCE_INVALID');
  const normalizedText = [`Title: ${posting.title.trim()}`, `Company: ${job.company.trim()}`, ...(job.location?.trim() ? [`Location: ${job.location.trim()}`] : []), normalizedDescription(posting.descriptionText)].filter(Boolean).join('\n\n');
  if (normalizedText.length > 50_000) throw new AiSourceError('AI_SOURCE_TOO_LARGE');
  return { jobId: job.id, canonicalIdentity: `job:${job.id}`, normalizedText, contentHash: hash(normalizedText) };
}

function questionEvidence(workspaceId: string, questionId: string, records: AiSourceRecords): NonNullable<AiSourceSnapshot['question']> {
  const question = records.question;
  if (!question || question.workspaceId !== workspaceId || question.id !== questionId) throw new AiSourceError('AI_SOURCE_MISSING');
  if (typeof question.questionText !== 'string' || !question.questionText.trim() || typeof question.questionScope !== 'string' || typeof question.jurisdiction !== 'string') throw new AiSourceError('AI_SOURCE_INVALID');
  const text = question.questionText.trim(); const answerPolicy = classifyAiQuestion(text);
  return { questionId, text, answerPolicy, contentHash: hash([text, answerPolicy, question.jurisdiction, question.questionScope]) };
}

/**
 * Construct from current server-selected rows only. Call within a consistent read/short transaction, then release it
 * before invoking an assistant. No DB, model, file or logging side effects. Unselected records never enter the snapshot.
 */
function constructSnapshot(workspaceId: string, requestInput: unknown, records: AiSourceRecords): AiSourceSnapshot {
  if (!aiIdSchema.safeParse(workspaceId).success) throw new AiSourceError('AI_INVALID_REQUEST');
  const request = parseAiSourceRequest(requestInput);
  const ids = 'selectedFactIds' in request ? request.selectedFactIds : [];
  const profile = ids.length || request.operation === 'RESUME_DRAFT' ? requireProfile(workspaceId, records) : null;
  const facts = ids.map((factId) => {
    const candidates = (records.facts ?? []).filter((fact) => fact.id === factId && fact.workspaceId === workspaceId && fact.profileVersionId === profile!.id);
    if (candidates.length !== 1 || candidates[0]!.approvalStatus !== 'USER_APPROVED') throw new AiSourceError('AI_SOURCE_MISSING');
    return factEvidence(candidates[0]!, request.locale);
  });
  const searchRequest = request.operation === 'SEARCH_DRAFT' ? { text: request.searchRequest, contentHash: hash(request.searchRequest) } : null;
  const job = 'jobId' in request && request.jobId ? jobEvidence(workspaceId, request.jobId, records) : null;
  const question = request.operation === 'ANSWER_DRAFT' ? questionEvidence(workspaceId, request.questionId, records) : null;
  const parsed = aiSourceSnapshotSchema.safeParse({
    schemaVersion: AI_SCHEMA_VERSION, snapshotId: randomUUID(), workspaceId, operation: request.operation, locale: request.locale,
    snapshotHash: placeholderHash, searchRequest, job, question, facts, profileRevision: profile?.revision ?? null,
    identityFingerprint: request.operation === 'RESUME_DRAFT' ? identityHash(profile!) : null,
  });
  if (!parsed.success) {
    const tooLarge = parsed.error.issues.some((issue) => issue.code === 'too_big' || (issue.code === 'custom' && issue.path.length === 0));
    throw new AiSourceError(tooLarge ? 'AI_SOURCE_TOO_LARGE' : 'AI_SOURCE_INVALID');
  }
  const snapshot = parsed.data;
  snapshot.snapshotHash = hashAiInputContent(snapshot);
  return snapshot;
}

/** Build a detached immutable input copy from selected rows; only stable, content-free error codes escape. */
export function buildAiSourceSnapshot(workspaceId: string, requestInput: unknown, records: AiSourceRecords): AiSourceSnapshot {
  try { return constructSnapshot(workspaceId, requestInput, records); }
  catch (error) { throw error instanceof AiSourceError ? error : new AiSourceError('AI_SOURCE_INVALID'); }
}

export type AiCurrentSources = { ok: true; resolvedFacts: Array<{ sourceFactId: string; currentFactId: string }> } | { ok: false; code: AiSourceErrorCode };

/**
 * Check before dispatch, adopting a result, and approving an artifact. Caller loads latest rows and, after a profile
 * revision, the original referenced facts. Preference-only revisions remain current when exact approved copies exist.
 * This is source currentness, not consent, output truth or PDF approval. Source IDs in existing outputs remain unchanged.
 */
export function checkAiSourceCurrent(snapshotInput: unknown, workspaceId: string, records: AiSourceRecords): AiCurrentSources {
  try {
    const parsed = aiSourceSnapshotSchema.safeParse(snapshotInput);
    if (!parsed.success) return { ok: false, code: 'AI_SOURCE_INVALID' };
    const snapshot = parsed.data;
    if (snapshot.workspaceId !== workspaceId || snapshot.snapshotHash !== hashAiInputContent(snapshot)) return { ok: false, code: 'AI_SOURCE_CHANGED' };
    if (snapshot.searchRequest && snapshot.searchRequest.contentHash !== hash(snapshot.searchRequest.text)) return { ok: false, code: 'AI_SOURCE_CHANGED' };
    if (snapshot.job) {
      const current = jobEvidence(workspaceId, snapshot.job.jobId, records);
      if (current.contentHash !== snapshot.job.contentHash || current.canonicalIdentity !== snapshot.job.canonicalIdentity || current.normalizedText !== snapshot.job.normalizedText) return { ok: false, code: 'AI_SOURCE_CHANGED' };
    }
    if (snapshot.question) {
      const current = questionEvidence(workspaceId, snapshot.question.questionId, records);
      if (current.contentHash !== snapshot.question.contentHash || current.text !== snapshot.question.text || current.answerPolicy !== snapshot.question.answerPolicy) return { ok: false, code: 'AI_SOURCE_CHANGED' };
    }
    const profile = snapshot.facts.length || snapshot.identityFingerprint ? requireProfile(workspaceId, records) : null;
    if (snapshot.identityFingerprint && identityHash(profile!) !== snapshot.identityFingerprint) return { ok: false, code: 'AI_SOURCE_CHANGED' };
    const currentFacts = (records.facts ?? []).filter((fact) => fact.workspaceId === workspaceId && fact.profileVersionId === profile?.id && fact.approvalStatus === 'USER_APPROVED');
    const resolvedFacts: Array<{ sourceFactId: string; currentFactId: string }> = [];
    for (const evidence of snapshot.facts) {
      if (evidence.contentHash !== hash([evidence.kind, evidence.text])) return { ok: false, code: 'AI_SOURCE_CHANGED' };
      const direct = currentFacts.filter((fact) => fact.id === evidence.factId);
      let candidate = direct.length === 1 ? direct[0] : undefined;
      if (!candidate) {
        const originals = (records.historicalFacts ?? []).filter((fact) => fact.id === evidence.factId && fact.workspaceId === workspaceId);
        const original = originals.length === 1 ? originals[0] : undefined;
        if (!original || factEvidence(original, snapshot.locale).contentHash !== evidence.contentHash) return { ok: false, code: 'AI_SOURCE_CHANGED' };
        const copies = currentFacts.filter((fact) => copyHash(fact) === copyHash(original));
        // Ambiguous copies fail closed rather than choosing an arbitrary provenance chain.
        if (copies.length === 1) candidate = copies[0];
      }
      if (!candidate || factEvidence(candidate, snapshot.locale).contentHash !== evidence.contentHash) return { ok: false, code: 'AI_SOURCE_CHANGED' };
      resolvedFacts.push({ sourceFactId: evidence.factId, currentFactId: candidate.id });
    }
    return { ok: true, resolvedFacts };
  } catch (error) {
    return { ok: false, code: error instanceof AiSourceError ? error.code : 'AI_SOURCE_INVALID' };
  }
}
