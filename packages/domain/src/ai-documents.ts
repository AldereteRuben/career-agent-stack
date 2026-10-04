/**
 * Derived resume claims (claims contract v1): reviewed text with its own provenance. Documents without a contract version
 * stay on the legacy rules in documents.ts, which this module neither reads nor changes. Pure: hashes come from the caller.
 * Valid sources are required to approve a claim; they do not make the sentence true, so a person still reviews it.
 */
import { z } from 'zod';
import { aiHashSchema, aiIdSchema, aiLocaleSchema, type AiLocale, type AiSourceSnapshot, type ResumeDraftOutput } from './ai.js';

export const DERIVED_CLAIMS_CONTRACT_VERSION = 1 as const;
export const derivedClaimOrigins = ['MANUAL', 'AI', 'AI_EDITED'] as const;
export type DerivedClaimOrigin = (typeof derivedClaimOrigins)[number];

export const derivedClaimSchema = z.object({
  claimId: aiIdSchema,
  section: z.string().min(1).max(64),
  /** The exact approved text. Any later edit produces a new claim and a new approval. */
  text: z.string().trim().min(1).max(4000),
  textHash: aiHashSchema,
  sourceFactIds: z.array(aiIdSchema).min(1).max(20),
  /** Content hash of each source fact when the claim was approved. */
  sourceFingerprints: z.array(z.object({ factId: aiIdSchema, contentHash: aiHashSchema }).strict()).min(1).max(20),
  language: aiLocaleSchema,
  origin: z.enum(derivedClaimOrigins),
  /** Proposal the text came from; null for manual claims. */
  artifactId: aiIdSchema.nullable(),
  proposalKey: aiIdSchema.nullable(),
}).strict().superRefine((claim, ctx) => {
  const ids = [...new Set(claim.sourceFactIds)];
  if (ids.length !== claim.sourceFactIds.length) ctx.addIssue({ code: 'custom', path: ['sourceFactIds'], message: 'Duplicate source.' });
  const fingerprinted = claim.sourceFingerprints.map((source) => source.factId);
  if (fingerprinted.length !== ids.length || !ids.every((id) => fingerprinted.includes(id))) ctx.addIssue({ code: 'custom', path: ['sourceFingerprints'], message: 'Each source needs exactly one fingerprint.' });
  if ((claim.origin === 'MANUAL') !== (claim.artifactId === null)) ctx.addIssue({ code: 'custom', path: ['artifactId'], message: 'Only assisted claims reference a proposal.' });
  if ((claim.artifactId === null) !== (claim.proposalKey === null)) ctx.addIssue({ code: 'custom', path: ['proposalKey'], message: 'A proposal reference needs both artifact and key.' });
});
export type DerivedClaim = z.infer<typeof derivedClaimSchema>;

/** Basis of a derived-claims document: what was printed and what the person approved. */
export const derivedClaimsBasisSchema = z.object({
  claimsContractVersion: z.literal(DERIVED_CLAIMS_CONTRACT_VERSION),
  workspaceId: aiIdSchema,
  language: aiLocaleSchema,
  profileRevision: z.number().int().positive(),
  /** Fingerprint of the printed name/email; contact details are added locally and never sent to a provider. */
  identityFingerprint: aiHashSchema,
  /** Target posting the wording was adapted to, if any. */
  targetJob: z.object({ jobId: aiIdSchema, contentHash: aiHashSchema }).strict().nullable(),
  claims: z.array(derivedClaimSchema).min(1).max(120),
  /** Approval binds the exact claim texts and the PDF bytes shown to the person. */
  approval: z.object({ pdfHash: aiHashSchema, claimTextHashes: z.array(aiHashSchema).min(1).max(120), approvedAt: z.string().datetime({ offset: true }) }).strict().nullable(),
}).strict().superRefine((basis, ctx) => {
  if (new Set(basis.claims.map(claim => claim.claimId)).size !== basis.claims.length) {
    ctx.addIssue({ code: 'custom', path: ['claims'], message: 'Duplicate claim identifier.' });
  }
  basis.claims.forEach((claim, index) => {
    if (claim.language !== basis.language) ctx.addIssue({ code: 'custom', path: ['claims', index, 'language'], message: 'Claim language differs from the document.' });
  });
});
export type DerivedClaimsBasis = z.infer<typeof derivedClaimsBasisSchema>;

/** Stored documents without a claims contract version keep the legacy behaviour of printedContentCurrent. */
export function documentClaimsContract(document: { claimsContractVersion?: number | null }): 'legacy' | 'derived-v1' | 'unsupported' {
  if (document.claimsContractVersion === undefined || document.claimsContractVersion === null) return 'legacy';
  return document.claimsContractVersion === DERIVED_CLAIMS_CONTRACT_VERSION ? 'derived-v1' : 'unsupported';
}

/** A fact as it is now, looked up by the caller within the document's workspace. */
export type CurrentFactState = { factId: string; workspaceId: string; approvalStatus: string; contentHash: string };
export type DerivedClaimsState = {
  workspaceId: string;
  identityFingerprint: string | null;
  currentFact: (factId: string) => CurrentFactState | undefined;
  /** Current content hash of the target posting, null when it no longer exists. */
  targetJobHash?: string | null;
  /** Hashes of what is being approved or reused now. */
  pdfHash?: string | null;
};
export type DerivedClaimIssue =
  | { code: 'WORKSPACE_MISMATCH' }
  | { code: 'IDENTITY_CHANGED' }
  | { code: 'SOURCE_MISSING' | 'SOURCE_NOT_APPROVED' | 'SOURCE_CHANGED' | 'SOURCE_OTHER_WORKSPACE'; claimId: string; factId: string }
  | { code: 'TARGET_JOB_CHANGED' }
  | { code: 'APPROVAL_MISSING' | 'APPROVAL_TEXT_CHANGED' | 'APPROVAL_PDF_CHANGED' };
/**
 * CURRENT: faithful to the profile and still approved for the shown PDF. NEEDS_ADAPTATION_REVIEW: faithful to the
 * profile but the target posting changed. NEEDS_APPROVAL: faithful but not (or no longer) approved as shown.
 * STALE: identity or evidence changed, so it cannot be approved or reused.
 */
export type DerivedClaimsCurrentness = { status: 'CURRENT' | 'NEEDS_APPROVAL' | 'NEEDS_ADAPTATION_REVIEW' | 'STALE'; issues: DerivedClaimIssue[] };

/**
 * Currentness of a derived-claims document. Changes outside the printed identity and the cited facts (preferences,
 * country, locale, other facts) keep it current; a changed, rejected, missing or foreign source makes it stale.
 */
export function derivedClaimsCurrentness(basis: DerivedClaimsBasis, state: DerivedClaimsState): DerivedClaimsCurrentness {
  const issues: DerivedClaimIssue[] = [];
  let stale = false;
  if (basis.workspaceId !== state.workspaceId) { issues.push({ code: 'WORKSPACE_MISMATCH' }); stale = true; }
  if (state.identityFingerprint !== basis.identityFingerprint) { issues.push({ code: 'IDENTITY_CHANGED' }); stale = true; }
  for (const claim of basis.claims) {
    for (const source of claim.sourceFingerprints) {
      const fact = state.currentFact(source.factId);
      const issue = !fact ? 'SOURCE_MISSING' : fact.workspaceId !== basis.workspaceId ? 'SOURCE_OTHER_WORKSPACE'
        : fact.approvalStatus !== 'USER_APPROVED' ? 'SOURCE_NOT_APPROVED' : fact.contentHash !== source.contentHash ? 'SOURCE_CHANGED' : null;
      if (issue) { issues.push({ code: issue, claimId: claim.claimId, factId: source.factId }); stale = true; }
    }
  }
  if (stale) return { status: 'STALE', issues };

  let needsApproval = false;
  if (!basis.approval) { issues.push({ code: 'APPROVAL_MISSING' }); needsApproval = true; } else {
    const approved = basis.approval.claimTextHashes;
    if (approved.length !== basis.claims.length || basis.claims.some((claim, index) => claim.textHash !== approved[index])) { issues.push({ code: 'APPROVAL_TEXT_CHANGED' }); needsApproval = true; }
    if (state.pdfHash !== undefined && state.pdfHash !== basis.approval.pdfHash) { issues.push({ code: 'APPROVAL_PDF_CHANGED' }); needsApproval = true; }
  }
  if (needsApproval) return { status: 'NEEDS_APPROVAL', issues };
  if (basis.targetJob && state.targetJobHash !== undefined && state.targetJobHash !== basis.targetJob.contentHash) {
    issues.push({ code: 'TARGET_JOB_CHANGED' });
    return { status: 'NEEDS_ADAPTATION_REVIEW', issues };
  }
  return { status: 'CURRENT', issues };
}

/** One reviewed proposal: the person may keep or edit the proposed text. finalTextHash is the caller's hash of finalText. */
export type ProposalSelection = { proposalKey: string; claimId: string; finalText: string; finalTextHash: string; proposedTextHash: string };
export type ProposalClaimsResult =
  | { ok: true; claims: DerivedClaim[] }
  | { ok: false; issues: ({ code: 'UNKNOWN_PROPOSAL' | 'DUPLICATE_PROPOSAL' | 'EMPTY_TEXT' | 'INVALID_CLAIM'; proposalKey: string } | { code: 'SOURCE_NOT_IN_SNAPSHOT' | 'SOURCE_CHANGED'; proposalKey: string; factId: string } | { code: 'WORKSPACE_MISMATCH' | 'NOTHING_SELECTED' | 'LOCALE_MISMATCH' })[] };

/**
 * Turns the proposals a person selected into derived claims, keeping each proposal's sources and the fact fingerprints
 * from the snapshot the provider saw. Sources must still match the current facts; otherwise the proposal is reported
 * instead of being applied to newer profile data. This does not approve anything.
 */
export function claimsFromResumeProposals(input: {
  artifactId: string; workspaceId: string; language: AiLocale; output: ResumeDraftOutput; snapshot: AiSourceSnapshot;
  selections: ProposalSelection[]; currentFact: (factId: string) => CurrentFactState | undefined;
}): ProposalClaimsResult {
  type Issue = Extract<ProposalClaimsResult, { ok: false }>['issues'][number];
  const issues: Issue[] = [];
  if (input.snapshot.workspaceId !== input.workspaceId || input.snapshot.operation !== 'RESUME_DRAFT') issues.push({ code: 'WORKSPACE_MISMATCH' });
  if (input.snapshot.locale !== input.language || input.output.locale !== input.language) issues.push({ code: 'LOCALE_MISMATCH' });
  if (!input.selections.length) issues.push({ code: 'NOTHING_SELECTED' });
  const proposals = new Map(input.output.proposals.map((proposal) => [proposal.proposalKey, proposal]));
  const snapshotFacts = new Map(input.snapshot.facts.map((fact) => [fact.factId, fact]));
  const seen = new Set<string>();
  const claims: DerivedClaim[] = [];
  for (const selection of input.selections) {
    const proposal = proposals.get(selection.proposalKey);
    if (!proposal) { issues.push({ code: 'UNKNOWN_PROPOSAL', proposalKey: selection.proposalKey }); continue; }
    if (seen.has(selection.proposalKey)) { issues.push({ code: 'DUPLICATE_PROPOSAL', proposalKey: selection.proposalKey }); continue; }
    seen.add(selection.proposalKey);
    if (!selection.finalText.trim()) { issues.push({ code: 'EMPTY_TEXT', proposalKey: selection.proposalKey }); continue; }
    const sourceFingerprints: DerivedClaim['sourceFingerprints'] = [];
    const issuesBefore = issues.length;
    for (const factId of proposal.sourceFactIds) {
      const snapshotFact = snapshotFacts.get(factId);
      if (!snapshotFact) { issues.push({ code: 'SOURCE_NOT_IN_SNAPSHOT', proposalKey: proposal.proposalKey, factId }); continue; }
      const current = input.currentFact(factId);
      if (!current || current.workspaceId !== input.workspaceId || current.approvalStatus !== 'USER_APPROVED' || current.contentHash !== snapshotFact.contentHash) {
        issues.push({ code: 'SOURCE_CHANGED', proposalKey: proposal.proposalKey, factId }); continue;
      }
      sourceFingerprints.push({ factId, contentHash: snapshotFact.contentHash });
    }
    if (issues.length > issuesBefore) continue;
    claims.push({
      claimId: selection.claimId, section: proposal.section, text: selection.finalText.trim(), textHash: selection.finalTextHash,
      sourceFactIds: [...new Set(proposal.sourceFactIds)], sourceFingerprints, language: input.language,
      origin: selection.finalTextHash === selection.proposedTextHash ? 'AI' : 'AI_EDITED',
      artifactId: input.artifactId, proposalKey: proposal.proposalKey,
    });
  }
  for (const claim of claims) if (!derivedClaimSchema.safeParse(claim).success) issues.push({ code: 'INVALID_CLAIM', proposalKey: claim.proposalKey ?? '' });
  return issues.length ? { ok: false, issues } : { ok: true, claims };
}

/**
 * Approval of exactly what was shown: the ordered claim text hashes and the rendered PDF. Rejected when the person is
 * approving a different revision than the one on screen or when any evidence is no longer current.
 */
export function approveDerivedClaims(basis: DerivedClaimsBasis, input: {
  expectedClaimTextHashes: string[]; pdfHash: string; approvedAt: string; state: DerivedClaimsState;
}): { ok: true; basis: DerivedClaimsBasis } | { ok: false; reason: 'REVISION_CONFLICT' | 'STALE'; issues: DerivedClaimIssue[] } {
  const current = basis.claims.map((claim) => claim.textHash);
  if (!aiHashSchema.safeParse(input.pdfHash).success || !input.state.pdfHash || input.state.pdfHash !== input.pdfHash
      || current.length !== input.expectedClaimTextHashes.length || current.some((hash, index) => hash !== input.expectedClaimTextHashes[index])) {
    return { ok: false, reason: 'REVISION_CONFLICT', issues: [] };
  }
  const check = derivedClaimsCurrentness({ ...basis, approval: null }, { workspaceId: input.state.workspaceId, identityFingerprint: input.state.identityFingerprint, currentFact: input.state.currentFact });
  if (check.status === 'STALE') return { ok: false, reason: 'STALE', issues: check.issues };
  const approved = derivedClaimsBasisSchema.safeParse({ ...basis, approval: { pdfHash: input.pdfHash, claimTextHashes: current, approvedAt: input.approvedAt } });
  return approved.success ? { ok: true, basis: approved.data } : { ok: false, reason: 'REVISION_CONFLICT', issues: [] };
}
