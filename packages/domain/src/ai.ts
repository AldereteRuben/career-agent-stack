/**
 * Provider-independent contracts for assisted work (v0.9.0, T01). Pure: no processes, network, clock or hashing.
 * Callers supply hashes, timestamps and lookups. Valid JSON is not proof of truth: these checks reject references that
 * cannot be traced to the supplied input, they do not show that a sentence is accurate. Human review stays mandatory.
 */
import { z } from 'zod';
import { AI_LIMITS } from './ai-budget.js';

export const AI_SCHEMA_VERSION = 1 as const;

export const aiProviders = ['codex', 'claude-code'] as const;
export const aiOperations = ['SEARCH_DRAFT', 'JOB_ANALYSIS', 'RESUME_DRAFT', 'ANSWER_DRAFT'] as const;
/** Same lowercase tags as DocumentLanguage. */
export const aiLocales = ['es', 'en'] as const;
export const aiConnectionStates = ['NOT_INSTALLED', 'LOGIN_REQUIRED', 'CONNECTING', 'CONNECTED', 'UNSUPPORTED_VERSION', 'UNAVAILABLE'] as const;
export const aiRunStates = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED', 'INTERRUPTED'] as const;
export const aiArtifactStates = ['PENDING_REVIEW', 'ACCEPTED', 'DISMISSED', 'STALE'] as const;
export const aiUsageAvailability = ['KNOWN', 'STALE', 'UNAVAILABLE'] as const;
export const aiRunOrigins = ['MANUAL', 'AUTOMATIC'] as const;
/** What the provider may receive. Contact details are never a category: they are added locally. */
export const aiDataCategories = ['SEARCH_REQUEST', 'JOB_POSTING', 'APPROVED_FACTS', 'APPLICATION_QUESTION'] as const;
export const aiErrorCodes = [
  'NOT_CONNECTED', 'CONSENT_MISSING', 'CONSENT_REVOKED', 'ACCOUNT_CHANGED', 'BUDGET_EXHAUSTED', 'PROVIDER_LIMIT_REACHED',
  'INPUT_TOO_LARGE', 'SOURCE_CHANGED', 'TIMEOUT', 'CANCELLED', 'PROVIDER_ERROR', 'INVALID_OUTPUT', 'UNSUPPORTED_VERSION', 'INTERNAL',
] as const;

export type AiProvider = (typeof aiProviders)[number];
export type AiOperation = (typeof aiOperations)[number];
export type AiLocale = (typeof aiLocales)[number];
export type AiConnectionState = (typeof aiConnectionStates)[number];
export type AiRunState = (typeof aiRunStates)[number];
export type AiArtifactState = (typeof aiArtifactStates)[number];
export type AiUsageAvailability = (typeof aiUsageAvailability)[number];
export type AiRunOrigin = (typeof aiRunOrigins)[number];
export type AiDataCategory = (typeof aiDataCategories)[number];
export type AiErrorCode = (typeof aiErrorCodes)[number];

/** Data each operation needs; consent must cover all of them. */
export const aiOperationDataCategories: Record<AiOperation, readonly AiDataCategory[]> = {
  SEARCH_DRAFT: ['SEARCH_REQUEST'],
  JOB_ANALYSIS: ['JOB_POSTING'],
  RESUME_DRAFT: ['JOB_POSTING', 'APPROVED_FACTS'],
  ANSWER_DRAFT: ['APPLICATION_QUESTION', 'APPROVED_FACTS'],
};

// ---------------------------------------------------------------------------------------------------------------------
// Shared primitives

/** Stable reference (UUID or other opaque key). No whitespace, slashes or shell metacharacters. */
export const aiIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
/** Lowercase hex SHA-256 computed by the caller. */
export const aiHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const aiLocaleSchema = z.enum(aiLocales);
export const aiOperationSchema = z.enum(aiOperations);
export const aiProviderSchema = z.enum(aiProviders);
const isoDateTime = z.string().datetime({ offset: true });
const versionTag = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const text = (max: number) => z.string().trim().min(1).max(max);

export const aiCapabilitiesSchema = z.object({
  login: z.boolean(), structuredOutput: z.boolean(), usageWindows: z.boolean(), cancellation: z.boolean(), isolatedExecution: z.boolean(),
}).strict();
export type AiCapabilities = z.infer<typeof aiCapabilitiesSchema>;

export const aiErrorSchema = z.object({
  code: z.enum(aiErrorCodes),
  /** Whether the provider may have received the request. UNKNOWN counts as possibly consumed. */
  dispatched: z.enum(['NO', 'YES', 'UNKNOWN']),
}).strict();
export type AiError = z.infer<typeof aiErrorSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Consent

export const aiConsentSchema = z.object({
  consentId: aiIdSchema, workspaceId: aiIdSchema, connectionId: aiIdSchema, provider: aiProviderSchema,
  /** Non-secret account fingerprint observed when the person authorized the connection. */
  accountFingerprint: aiHashSchema,
  connectionRevision: z.number().int().positive(),
  revision: z.number().int().positive(),
  operation: aiOperationSchema,
  dataCategories: z.array(z.enum(aiDataCategories)).min(1).max(aiDataCategories.length),
  /** Saved searches automatic analysis may cover; null for operations started by the person. */
  searchIds: z.array(aiIdSchema).max(200).nullable(),
  noticeVersion: versionTag,
  grantedAt: isoDateTime,
  revokedAt: isoDateTime.nullable(),
}).strict().refine((consent) => new Set(consent.dataCategories).size === consent.dataCategories.length, { path: ['dataCategories'], message: 'Duplicate data category.' });
export type AiConsent = z.infer<typeof aiConsentSchema>;

export type AiConsentRequest = {
  workspaceId: string; connectionId: string; provider: AiProvider; accountFingerprint: string; connectionRevision: number;
  operation: AiOperation; origin: AiRunOrigin; searchId?: string | null;
  /** Derived by the server from the actual input snapshot, never from a checkbox sent by the client. */
  dataCategories: readonly AiDataCategory[];
  /** The consent revision the run was created with; a different revision means the scope changed since. */
  expectedConsentRevision?: number;
};
export type AiConsentIssue = 'WORKSPACE_MISMATCH' | 'CONNECTION_MISMATCH' | 'PROVIDER_CHANGED' | 'ACCOUNT_CHANGED' | 'CONNECTION_REVISION_CHANGED'
  | 'CONSENT_REVISION_CHANGED' | 'REVOKED' | 'OPERATION_NOT_COVERED' | 'DATA_CATEGORY_NOT_COVERED' | 'SEARCH_NOT_COVERED' | 'AUTOMATION_NOT_SUPPORTED';

/**
 * Whether a consent still authorizes a request. Run it before dispatch and again before storing a usable result: a
 * revoked or changed authorization must not produce an active proposal from a late event.
 */
export function checkAiConsent(consent: AiConsent | null | undefined, request: AiConsentRequest): { ok: true } | { ok: false; issues: AiConsentIssue[] } {
  if (!consent) return { ok: false, issues: ['OPERATION_NOT_COVERED'] };
  const issues: AiConsentIssue[] = [];
  if (consent.workspaceId !== request.workspaceId) issues.push('WORKSPACE_MISMATCH');
  if (consent.connectionId !== request.connectionId) issues.push('CONNECTION_MISMATCH');
  if (consent.provider !== request.provider) issues.push('PROVIDER_CHANGED');
  if (consent.accountFingerprint !== request.accountFingerprint) issues.push('ACCOUNT_CHANGED');
  if (consent.connectionRevision !== request.connectionRevision) issues.push('CONNECTION_REVISION_CHANGED');
  if (request.expectedConsentRevision !== undefined && consent.revision !== request.expectedConsentRevision) issues.push('CONSENT_REVISION_CHANGED');
  if (consent.revokedAt) issues.push('REVOKED');
  if (consent.operation !== request.operation) issues.push('OPERATION_NOT_COVERED');
  const sharedCategories = new Set([...aiOperationDataCategories[request.operation], ...request.dataCategories]);
  if (![...sharedCategories].every((category) => consent.dataCategories.includes(category))) issues.push('DATA_CATEGORY_NOT_COVERED');
  if (request.origin === 'AUTOMATIC' && (!request.searchId || !consent.searchIds?.includes(request.searchId))) issues.push('SEARCH_NOT_COVERED');
  if (request.origin === 'AUTOMATIC' && request.operation !== 'JOB_ANALYSIS') issues.push('AUTOMATION_NOT_SUPPORTED');
  return issues.length ? { ok: false, issues } : { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// Source evidence snapshot: the minimal immutable copy of what the provider received.

export const aiSnapshotFactSchema = z.object({
  factId: aiIdSchema,
  /** Only approved facts may be shared or cited; pending, rejected or archived entries never enter a snapshot. */
  approvalStatus: z.literal('USER_APPROVED'),
  kind: z.string().min(1).max(64),
  text: text(8000),
  contentHash: aiHashSchema,
}).strict();
export type AiSnapshotFact = z.infer<typeof aiSnapshotFactSchema>;

export const aiSourceSnapshotSchema = z.object({
  schemaVersion: z.literal(AI_SCHEMA_VERSION),
  snapshotId: aiIdSchema, workspaceId: aiIdSchema, operation: aiOperationSchema, locale: aiLocaleSchema,
  /** Hash of the canonical snapshot content, computed by the caller. */
  snapshotHash: aiHashSchema,
  searchRequest: z.object({ text: text(2000), contentHash: aiHashSchema }).strict().nullable(),
  job: z.object({
    jobId: aiIdSchema, canonicalIdentity: z.string().min(1).max(500),
    /** Normalized posting text sent to the provider; citations must quote it. */
    normalizedText: text(50_000), contentHash: aiHashSchema,
  }).strict().nullable(),
  question: z.object({
    questionId: aiIdSchema, text: text(2000), contentHash: aiHashSchema,
    /** Classified by application rules. Unknown or personal questions use USER_ONLY, never model classification. */
    answerPolicy: z.enum(['EXPERIENCE_DRAFT', 'USER_ONLY']),
  }).strict().nullable(),
  facts: z.array(aiSnapshotFactSchema).max(500),
  profileRevision: z.number().int().positive().nullable(),
  /** Fingerprint of the printed identity (name/email) the profile had; never the identity itself. */
  identityFingerprint: aiHashSchema.nullable(),
}).strict().superRefine((snapshot, ctx) => {
  if (JSON.stringify(snapshot).length > AI_LIMITS.inputCharacters) {
    ctx.addIssue({ code: 'custom', path: [], message: 'Input exceeds the composed data budget; select less content rather than truncating it.' });
  }
  const ids = new Set<string>();
  snapshot.facts.forEach((fact, index) => {
    if (ids.has(fact.factId)) ctx.addIssue({ code: 'custom', path: ['facts', index, 'factId'], message: 'Duplicate fact.' });
    ids.add(fact.factId);
  });
  const need = (key: 'searchRequest' | 'job' | 'question', operations: AiOperation[]) => {
    if (operations.includes(snapshot.operation) && !snapshot[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${snapshot.operation} requires ${key}.` });
  };
  need('searchRequest', ['SEARCH_DRAFT']);
  need('job', ['JOB_ANALYSIS', 'RESUME_DRAFT']);
  need('question', ['ANSWER_DRAFT']);
  if (snapshot.operation === 'SEARCH_DRAFT' && (snapshot.facts.length || snapshot.job || snapshot.question)) {
    ctx.addIssue({ code: 'custom', path: ['operation'], message: 'A search draft receives only the written request.' });
  }
  if (snapshot.facts.length && snapshot.profileRevision === null) ctx.addIssue({ code: 'custom', path: ['profileRevision'], message: 'Facts require the profile revision they came from.' });
});
export type AiSourceSnapshot = z.infer<typeof aiSourceSnapshotSchema>;

export function aiSnapshotDataCategories(snapshot: AiSourceSnapshot): AiDataCategory[] {
  const categories: AiDataCategory[] = [];
  if (snapshot.searchRequest) categories.push('SEARCH_REQUEST');
  if (snapshot.job) categories.push('JOB_POSTING');
  if (snapshot.facts.length) categories.push('APPROVED_FACTS');
  if (snapshot.question) categories.push('APPLICATION_QUESTION');
  return categories;
}

// ---------------------------------------------------------------------------------------------------------------------
// Structured outputs. Every object is strict: commands, tool calls, URLs to open or approval fields are rejected.

const header = <T extends AiOperation>(operation: T) => ({
  schemaVersion: z.literal(AI_SCHEMA_VERSION), operation: z.literal(operation), locale: aiLocaleSchema,
});
/** A verbatim fragment of the supplied source text. */
export const aiQuoteSchema = z.object({ quote: z.string().trim().min(4).max(600) }).strict();
const citations = z.array(aiQuoteSchema).min(1).max(10);
const factIds = z.array(aiIdSchema).min(1).max(20);

export const aiSearchWorkModes = ['any', 'remote', 'hybrid', 'onsite'] as const;
export const aiUnsupportedConstraintKinds = ['SALARY', 'CONTRACT_TYPE', 'SENIORITY', 'SCHEDULE', 'LANGUAGE', 'VISA_OR_RELOCATION', 'BENEFITS', 'COMPANY_SIZE', 'INDUSTRY', 'OTHER'] as const;
export const searchDraftOutputSchema = z.object({
  ...header('SEARCH_DRAFT'),
  /** Only filters the search engine supports. Nothing here is executed until the person saves it. */
  criteria: z.object({
    role: text(200).nullable(), company: text(200).nullable(), location: text(200).nullable(), workMode: z.enum(aiSearchWorkModes),
  }).strict(),
  /** Parts of the request the filters cannot represent; listed instead of silently dropped. */
  unsupportedConstraints: z.array(z.object({ kind: z.enum(aiUnsupportedConstraintKinds), requestQuote: aiQuoteSchema.shape.quote, explanation: text(500) }).strict()).max(20),
  clarifications: z.array(z.object({ question: text(300) }).strict()).max(5),
}).strict();
export type SearchDraftOutput = z.infer<typeof searchDraftOutputSchema>;

export const jobAnalysisOutputSchema = z.object({
  ...header('JOB_ANALYSIS'),
  summary: z.array(z.object({ text: text(600), citations }).strict()).min(1).max(12),
  requirements: z.array(z.object({ text: text(400), level: z.enum(['REQUIRED', 'PREFERRED', 'UNSPECIFIED']), citations }).strict()).max(40),
  /** Personal claims: always tied to the posting and to approved facts. Empty when no profile was shared. */
  personalMatches: z.array(z.object({ text: text(600), strength: z.enum(['STRONG', 'PARTIAL']), jobCitations: citations, factIds }).strict()).max(30),
  gaps: z.array(z.object({ text: text(400), jobCitations: citations }).strict()).max(30),
  warnings: z.array(text(400)).max(10),
}).strict();
export type JobAnalysisOutput = z.infer<typeof jobAnalysisOutputSchema>;

export const resumeDraftOutputSchema = z.object({
  ...header('RESUME_DRAFT'),
  proposals: z.array(z.object({
    proposalKey: aiIdSchema, section: z.string().min(1).max(64), text: text(4000),
    sourceFactIds: factIds, changeExplanation: text(600), warnings: z.array(text(300)).max(5),
  }).strict()).min(1).max(60),
  warnings: z.array(text(400)).max(10),
}).strict().superRefine((output, ctx) => {
  const keys = new Set<string>();
  output.proposals.forEach((proposal, index) => {
    if (keys.has(proposal.proposalKey)) ctx.addIssue({ code: 'custom', path: ['proposals', index, 'proposalKey'], message: 'Duplicate proposal.' });
    keys.add(proposal.proposalKey);
  });
});
export type ResumeDraftOutput = z.infer<typeof resumeDraftOutputSchema>;

export const aiNeedsInputReasons = ['MISSING_FACT', 'PERSONAL_DECISION', 'LEGAL_OR_SENSITIVE', 'AMBIGUOUS_QUESTION'] as const;
export const answerDraftOutputSchema = z.object({
  ...header('ANSWER_DRAFT'),
  questionId: aiIdSchema,
  result: z.discriminatedUnion('status', [
    z.object({ status: z.literal('NEEDS_USER_INPUT'), reason: z.enum(aiNeedsInputReasons), explanation: text(500) }).strict(),
    z.object({
      status: z.literal('DRAFT'), text: text(4000),
      evidence: z.array(z.object({ factId: aiIdSchema, quote: aiQuoteSchema.shape.quote.optional() }).strict()).min(1).max(20),
    }).strict(),
  ]),
}).strict();
export type AnswerDraftOutput = z.infer<typeof answerDraftOutputSchema>;

export const aiOutputSchema = z.discriminatedUnion('operation', [searchDraftOutputSchema, jobAnalysisOutputSchema, resumeDraftOutputSchema, answerDraftOutputSchema]);
export type AiOutput = z.infer<typeof aiOutputSchema>;
export const aiOutputSchemas = { SEARCH_DRAFT: searchDraftOutputSchema, JOB_ANALYSIS: jobAnalysisOutputSchema, RESUME_DRAFT: resumeDraftOutputSchema, ANSWER_DRAFT: answerDraftOutputSchema } as const;

// ---------------------------------------------------------------------------------------------------------------------
// Evidence validation

/** Whitespace, width and case insensitive comparison form for quotes. Accents and punctuation are kept. */
export function normalizeEvidenceText(value: string): string {
  return value.normalize('NFKC').replace(/[‘’]/gu, "'").replace(/[“”]/gu, '"').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('und');
}
const MIN_QUOTE = 4;

export type AiEvidenceIssueCode = 'INVALID_SNAPSHOT' | 'INVALID_OUTPUT' | 'WORKSPACE_MISMATCH' | 'OPERATION_MISMATCH' | 'LOCALE_MISMATCH' | 'UNKNOWN_FACT_ID'
  | 'QUOTE_NOT_IN_SOURCE' | 'MISSING_SOURCE' | 'QUESTION_MISMATCH' | 'PERSONAL_CLAIM_WITHOUT_PROFILE' | 'UNSUPPORTED_CONSTRAINT_DROPPED' | 'PERSONAL_ANSWER_REQUIRED';
export type AiEvidenceIssue = { code: AiEvidenceIssueCode; path: (string | number)[] };
export type AiValidatedOutput = { ok: true; output: AiOutput; snapshot: AiSourceSnapshot } | { ok: false; issues: AiEvidenceIssue[] };

/** Salary or pay mentions; a request containing one must report it as unsupported rather than drop it. Heuristic, ES/EN only. */
const salaryPattern = /(salar|sueldo|\bpa(?:y|ys|ying|id)\b|compensat|retribu|remunera|\bbruto|\bgross\b|[€$£]\s?\d|\d\s?(?:k|mil)?\s?(?:[€$£]|(?:eur|euros?|usd|gbp)\b))/iu;

/**
 * Parses one final provider output and checks it against the snapshot it was produced from. Only fact IDs in that
 * snapshot are accepted (a valid ID from another workspace or revision is unknown here), and every quote must occur in
 * the normalized source text. Any issue rejects the whole output; partial adoption is the caller's explicit choice.
 */
export function validateAiOutput(raw: unknown, snapshotInput: unknown, expected: { workspaceId: string; operation: AiOperation; locale: AiLocale }): AiValidatedOutput {
  const snapshotParse = aiSourceSnapshotSchema.safeParse(snapshotInput);
  if (!snapshotParse.success) return { ok: false, issues: [{ code: 'INVALID_SNAPSHOT', path: [] }] };
  const outputParse = aiOutputSchemas[expected.operation].safeParse(raw);
  if (!outputParse.success) {
    return { ok: false, issues: outputParse.error.issues.map((issue) => ({ code: 'INVALID_OUTPUT' as const, path: issue.path.filter((part): part is string | number => typeof part !== 'symbol') })) };
  }
  const snapshot = snapshotParse.data; const output = outputParse.data as AiOutput;
  const issues: AiEvidenceIssue[] = [];
  if (snapshot.workspaceId !== expected.workspaceId) issues.push({ code: 'WORKSPACE_MISMATCH', path: ['workspaceId'] });
  if (snapshot.operation !== expected.operation) issues.push({ code: 'OPERATION_MISMATCH', path: ['operation'] });
  if (output.locale !== expected.locale || snapshot.locale !== expected.locale) issues.push({ code: 'LOCALE_MISMATCH', path: ['locale'] });

  const facts = new Map(snapshot.facts.map((fact) => [fact.factId, fact]));
  const checkFacts = (ids: string[], path: (string | number)[]) => ids.forEach((id, index) => { if (!facts.has(id)) issues.push({ code: 'UNKNOWN_FACT_ID', path: [...path, index] }); });
  const checkQuote = (quote: string, source: string | null | undefined, path: (string | number)[]) => {
    if (source === null || source === undefined) { issues.push({ code: 'MISSING_SOURCE', path }); return; }
    const needle = normalizeEvidenceText(quote);
    if (needle.length < MIN_QUOTE || !normalizeEvidenceText(source).includes(needle)) issues.push({ code: 'QUOTE_NOT_IN_SOURCE', path });
  };
  const jobText = snapshot.job?.normalizedText;
  const checkCitations = (list: { quote: string }[], path: (string | number)[]) => list.forEach((citation, index) => checkQuote(citation.quote, jobText, [...path, index, 'quote']));

  switch (output.operation) {
    case 'SEARCH_DRAFT': {
      const request = snapshot.searchRequest?.text;
      output.unsupportedConstraints.forEach((constraint, index) => checkQuote(constraint.requestQuote, request, ['unsupportedConstraints', index, 'requestQuote']));
      if (request && salaryPattern.test(request) && !output.unsupportedConstraints.some((constraint) => constraint.kind === 'SALARY')) {
        issues.push({ code: 'UNSUPPORTED_CONSTRAINT_DROPPED', path: ['unsupportedConstraints'] });
      }
      break;
    }
    case 'JOB_ANALYSIS':
      output.summary.forEach((item, index) => checkCitations(item.citations, ['summary', index, 'citations']));
      output.requirements.forEach((item, index) => checkCitations(item.citations, ['requirements', index, 'citations']));
      output.gaps.forEach((item, index) => checkCitations(item.jobCitations, ['gaps', index, 'jobCitations']));
      output.personalMatches.forEach((item, index) => {
        if (!snapshot.facts.length) issues.push({ code: 'PERSONAL_CLAIM_WITHOUT_PROFILE', path: ['personalMatches', index] });
        checkCitations(item.jobCitations, ['personalMatches', index, 'jobCitations']);
        checkFacts(item.factIds, ['personalMatches', index, 'factIds']);
      });
      break;
    case 'RESUME_DRAFT':
      output.proposals.forEach((proposal, index) => checkFacts(proposal.sourceFactIds, ['proposals', index, 'sourceFactIds']));
      break;
    case 'ANSWER_DRAFT':
      if (!snapshot.question || output.questionId !== snapshot.question.questionId) issues.push({ code: 'QUESTION_MISMATCH', path: ['questionId'] });
      if (output.result.status === 'DRAFT') {
        if (snapshot.question?.answerPolicy !== 'EXPERIENCE_DRAFT') issues.push({ code: 'PERSONAL_ANSWER_REQUIRED', path: ['result'] });
        output.result.evidence.forEach((item, index) => {
          const fact = facts.get(item.factId);
          if (!fact) issues.push({ code: 'UNKNOWN_FACT_ID', path: ['result', 'evidence', index, 'factId'] });
          else if (item.quote !== undefined) checkQuote(item.quote, fact.text, ['result', 'evidence', index, 'quote']);
        });
      }
      break;
  }
  return issues.length ? { ok: false, issues } : { ok: true, output, snapshot };
}

// ---------------------------------------------------------------------------------------------------------------------
// Runs

export const aiRunTransitions: Record<AiRunState, readonly AiRunState[]> = {
  QUEUED: ['RUNNING', 'CANCELLED', 'FAILED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'CANCEL_REQUESTED', 'INTERRUPTED'],
  // A result arriving after a cancel request is never adopted.
  CANCEL_REQUESTED: ['CANCELLED', 'FAILED', 'INTERRUPTED'],
  SUCCEEDED: [], FAILED: [], CANCELLED: [], INTERRUPTED: [],
};
export const terminalAiRunStates = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'] as const satisfies readonly AiRunState[];
export const canTransitionAiRun = (from: AiRunState, to: AiRunState) => aiRunTransitions[from].includes(to);

export type AiRunRecord = { state: AiRunState; leaseToken: string | null; error: AiError | null };
export type AiRunEvent =
  | { type: 'CLAIM'; leaseToken: string }
  | { type: 'SUCCEED'; leaseToken: string }
  | { type: 'FAIL'; leaseToken: string | null; error: AiError }
  | { type: 'REQUEST_CANCEL' }
  | { type: 'CONFIRM_CANCELLED'; leaseToken: string | null }
  /** Restart recovery: a run that was executing has an uncertain outcome. */
  | { type: 'INTERRUPT' };
export type AiRunTransitionResult = { ok: true; run: AiRunRecord; changed: boolean } | { ok: false; reason: 'INVALID_TRANSITION' | 'STALE_LEASE' };

/**
 * Pure run reducer. Events from a worker carry its lease token; a token that is no longer current (expired lease,
 * reclaimed run) is rejected so a late worker cannot store a result. Repeating a cancel request is idempotent.
 */
export function applyAiRunEvent(run: AiRunRecord, event: AiRunEvent): AiRunTransitionResult {
  const move = (to: AiRunState, patch: Partial<AiRunRecord> = {}): AiRunTransitionResult =>
    canTransitionAiRun(run.state, to) ? { ok: true, changed: true, run: { ...run, ...patch, state: to } } : { ok: false, reason: 'INVALID_TRANSITION' };
  const leased = (token: string | null) => run.leaseToken !== null && token === run.leaseToken;
  switch (event.type) {
    case 'CLAIM':
      return run.state === 'QUEUED' ? move('RUNNING', { leaseToken: event.leaseToken }) : { ok: false, reason: 'INVALID_TRANSITION' };
    case 'SUCCEED':
      if (!leased(event.leaseToken)) return { ok: false, reason: 'STALE_LEASE' };
      return move('SUCCEEDED');
    case 'FAIL':
      if (run.state !== 'QUEUED' && !leased(event.leaseToken)) return { ok: false, reason: 'STALE_LEASE' };
      return move('FAILED', { error: event.error });
    case 'REQUEST_CANCEL':
      if (run.state === 'CANCEL_REQUESTED' || run.state === 'CANCELLED') return { ok: true, changed: false, run };
      return run.state === 'QUEUED' ? move('CANCELLED', { error: { code: 'CANCELLED', dispatched: 'NO' } }) : move('CANCEL_REQUESTED');
    case 'CONFIRM_CANCELLED':
      if (!leased(event.leaseToken)) return { ok: false, reason: 'STALE_LEASE' };
      return move('CANCELLED', { error: { code: 'CANCELLED', dispatched: 'UNKNOWN' } });
    case 'INTERRUPT':
      return move('INTERRUPTED', { error: { code: 'INTERNAL', dispatched: 'UNKNOWN' } });
  }
}

/** Only transient failures before dispatch may retry; changed permission, account, source or quota requires a new decision. */
export function canAutoRetryAiRun(run: AiRunRecord, attempt: number, maxAttempts = 2): boolean {
  return Number.isSafeInteger(attempt) && attempt >= 0 && Number.isSafeInteger(maxAttempts) && maxAttempts > 0 && maxAttempts <= 2
    && run.state === 'FAILED' && run.error?.dispatched === 'NO'
    && (run.error.code === 'PROVIDER_ERROR' || run.error.code === 'TIMEOUT') && attempt < maxAttempts;
}

/**
 * Canonical content identity for reusing a result (hash it on the caller side). Distinct from the HTTP idempotency key,
 * which only protects the same click.
 */
export type AiReuseIdentity = {
  workspaceId: string; operation: AiOperation; connectionId: string; accountFingerprint: string; locale: AiLocale;
  /** Hash of every input field, including search request and source IDs. Excludes generated run/snapshot IDs. */
  inputContentHash: string;
  jobIdentity: string | null; jobContentHash: string | null; evidenceHashes: readonly string[]; questionHash: string | null;
  promptVersion: string; schemaVersion: number; configVersion: string;
};
export function canonicalAiReuseKey(identity: AiReuseIdentity): string {
  return JSON.stringify([
    identity.workspaceId, identity.operation, identity.connectionId, identity.accountFingerprint, identity.locale, identity.inputContentHash,
    identity.jobIdentity, identity.jobContentHash, [...new Set(identity.evidenceHashes)].sort(), identity.questionHash,
    identity.promptVersion, identity.schemaVersion, identity.configVersion,
  ]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Artifacts

export const aiArtifactTransitions: Record<AiArtifactState, readonly AiArtifactState[]> = {
  PENDING_REVIEW: ['ACCEPTED', 'DISMISSED', 'STALE'],
  // An accepted result can become outdated when its sources change; it is never re-approved in place.
  ACCEPTED: ['STALE'],
  STALE: ['DISMISSED'],
  DISMISSED: [],
};
export const canTransitionAiArtifact = (from: AiArtifactState, to: AiArtifactState) => aiArtifactTransitions[from].includes(to);

export type AiArtifactRecord = { workspaceId: string; state: AiArtifactState; revision: number; snapshotHash: string };
export type AiArtifactDecision =
  /** Only a person accepts. expectedRevision guards against concurrent edits; the snapshot hash must still match the current sources. */
  | { type: 'ACCEPT'; actor: 'USER'; workspaceId: string; expectedRevision: number; currentSnapshotHash: string }
  | { type: 'DISMISS'; actor: 'USER'; workspaceId: string; expectedRevision: number }
  | { type: 'MARK_STALE' };
export type AiArtifactDecisionResult = { ok: true; artifact: AiArtifactRecord } | { ok: false; reason: 'WORKSPACE_MISMATCH' | 'REVISION_CONFLICT' | 'SOURCE_CHANGED' | 'INVALID_TRANSITION' };

export function decideAiArtifact(artifact: AiArtifactRecord, decision: AiArtifactDecision): AiArtifactDecisionResult {
  const to: AiArtifactState = decision.type === 'ACCEPT' ? 'ACCEPTED' : decision.type === 'DISMISS' ? 'DISMISSED' : 'STALE';
  if (decision.type !== 'MARK_STALE') {
    if (decision.workspaceId !== artifact.workspaceId) return { ok: false, reason: 'WORKSPACE_MISMATCH' };
    if (decision.expectedRevision !== artifact.revision) return { ok: false, reason: 'REVISION_CONFLICT' };
  }
  if (!canTransitionAiArtifact(artifact.state, to)) return { ok: false, reason: 'INVALID_TRANSITION' };
  if (decision.type === 'ACCEPT' && decision.currentSnapshotHash !== artifact.snapshotHash) return { ok: false, reason: 'SOURCE_CHANGED' };
  return { ok: true, artifact: { ...artifact, state: to, revision: artifact.revision + 1 } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Usage

export const AI_USAGE_STALE_AFTER_MS = 5 * 60_000;
const nullableNumber = z.number().finite().nullable().optional();
/** What an adapter observed. Absent values stay absent: they are "not available", never zero. */
export const aiUsageObservationSchema = z.object({
  provider: aiProviderSchema,
  observedAt: isoDateTime.nullable(),
  source: z.enum(['PROVIDER_REPORTED', 'RUN_EVENT', 'NONE']),
  windows: z.array(z.object({
    windowId: z.string().regex(/^[a-z0-9_-]{1,40}$/), label: z.string().max(80).optional(),
    usedPercent: nullableNumber, resetsAt: isoDateTime.nullable().optional(), limitReached: z.boolean().nullable().optional(),
  }).strict()).max(10),
  tokens: z.object({ input: nullableNumber, output: nullableNumber }).strict().nullable().optional(),
  costUsd: nullableNumber,
}).strict();
export type AiUsageObservation = z.input<typeof aiUsageObservationSchema>;

export type AiUsageWindow = { windowId: string; label: string | null; usedPercent: number | null; remainingPercent: number | null; resetsAt: string | null; limitReached: boolean | null };
export type AiUsageSnapshot = {
  provider: AiProvider; availability: AiUsageAvailability; observedAt: string | null; ageMs: number | null;
  windows: AiUsageWindow[]; anyLimitReached: boolean | null;
  tokens: { input: number | null; output: number | null }; costUsd: number | null;
};

const percent = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null);
const count = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null);

/**
 * Normalizes an observation for display. Percentages are consumed share of their own window, clamped to 0–100;
 * tokens, runs and subscription percentages are never converted into each other. A snapshot never promises quota.
 */
export function normalizeAiUsage(raw: AiUsageObservation, nowMs: number): AiUsageSnapshot {
  const observation = aiUsageObservationSchema.parse(raw);
  const observedMs = observation.observedAt ? Date.parse(observation.observedAt) : NaN;
  const ageMs = Number.isFinite(observedMs) ? Math.max(0, nowMs - observedMs) : null;
  const windows = observation.windows.map((window): AiUsageWindow => {
    const used = percent(window.usedPercent);
    return {
      windowId: window.windowId, label: window.label ?? null, usedPercent: used, remainingPercent: used === null ? null : 100 - used,
      resetsAt: window.resetsAt ?? null, limitReached: window.limitReached ?? null,
    };
  });
  const hasData = windows.some((window) => window.usedPercent !== null || window.limitReached !== null);
  const availability: AiUsageAvailability = observation.source === 'NONE' || ageMs === null || !hasData ? 'UNAVAILABLE' : ageMs > AI_USAGE_STALE_AFTER_MS ? 'STALE' : 'KNOWN';
  const flags = windows.map((window) => window.limitReached);
  return {
    provider: observation.provider, availability, observedAt: observation.observedAt, ageMs, windows,
    anyLimitReached: flags.includes(true) ? true : flags.length && flags.every((flag) => flag === false) ? false : null,
    tokens: { input: count(observation.tokens?.input), output: count(observation.tokens?.output) },
    costUsd: typeof observation.costUsd === 'number' && Number.isFinite(observation.costUsd) && observation.costUsd >= 0 ? observation.costUsd : null,
  };
}
