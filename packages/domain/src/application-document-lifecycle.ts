import {
  type ApplicationDocumentLanguage,
  type ApplicationDocumentOffer,
  type ApplicationDocumentSentence,
  type ApplicationDocumentSentenceKind,
} from './application-documents-builder.js';
import { validateApplicationDocumentSentence, type ApplicationDocumentValidationIssue } from './application-document-validation.js';

export type ApplicationDocumentRevisionClaim = ApplicationDocumentSentence & { language: ApplicationDocumentLanguage };
export type ApplicationDocumentFactSnapshot = { id: string; workspaceId: string; approval: 'USER_APPROVED' | 'SUGGESTED' | 'REJECTED'; text: string; tags?: string[] };
export type ApplicationDocumentOfferSnapshot = {
  workspaceId: string;
  company: string;
  role: string;
  location: string | null;
  snapshot: { id: string; title: string; descriptionText: string | null } | null;
};
export type ApplicationDocumentJobSnapshot = { id: string; title: string; descriptionText: string | null; fetchedAt: string };
export type ApplicationDocumentRevision = {
  id: string;
  workspaceId: string;
  documentId: string;
  revision: number;
  parentRevision: number | null;
  language: ApplicationDocumentLanguage;
  claims: ApplicationDocumentRevisionClaim[];
  contentHash: string;
  offerSnapshotId: string;
  offerHash: string;
  factsHash: string;
  paperSize: 'A4' | 'LETTER';
  textSha256: string;
  pdfSha256: string;
  confirmedUnsupportedIds: string[];
  approvedAt: string | null;
  approvedBy: string | null;
};

/** Selects the immutable application fields and the newest saved offer snapshot with a stable tie-break. */
export function latestApplicationDocumentOffer(input: {
  workspaceId: string;
  company: string;
  role: string;
  location: string | null;
  snapshots: ApplicationDocumentJobSnapshot[];
}): ApplicationDocumentOfferSnapshot {
  const compareDescending = (left: string, right: string) => {
    const leftTime = Date.parse(left);
    const rightTime = Date.parse(right);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime - leftTime;
    return left === right ? 0 : left > right ? -1 : 1;
  };
  const snapshot = [...input.snapshots].sort((a, b) => compareDescending(a.fetchedAt, b.fetchedAt) || compareDescending(a.id, b.id))[0] ?? null;
  return { workspaceId: input.workspaceId, company: input.company, role: input.role, location: input.location, snapshot };
}

type HashInputs = {
  workspaceId: string;
  claims: ApplicationDocumentRevisionClaim[];
  facts: ApplicationDocumentFactSnapshot[];
  offer: ApplicationDocumentOfferSnapshot;
};

function canonicalText(value: string | null) {
  return (value ?? '').replace(/\r\n?/gu, '\n').normalize('NFC').trim().replace(/\s+/gu, ' ');
}

function stableJson(value: unknown) {
  return JSON.stringify(value);
}

async function sha256(value: string) {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalClaims(claims: ApplicationDocumentRevisionClaim[]) {
  return claims.map((claim) => ({
    sentenceId: claim.sentenceId,
    text: claim.text,
    kind: claim.kind,
    origin: claim.origin,
    sourceFactIds: [...claim.sourceFactIds].sort(),
    language: claim.language,
  }));
}

export function mixedLanguageSentenceIds(language: ApplicationDocumentLanguage, claims: ApplicationDocumentRevisionClaim[]) {
  return claims.filter((claim) => claim.language !== language).map((claim) => claim.sentenceId);
}

function asBuilderOffer(offer: ApplicationDocumentOfferSnapshot): ApplicationDocumentOffer | null {
  return offer.snapshot ? { ...offer, snapshot: offer.snapshot } : null;
}

function revisionClaimIssue(input: {
  workspaceId: string;
  claims: ApplicationDocumentRevisionClaim[];
  facts: ApplicationDocumentFactSnapshot[];
  offer: ApplicationDocumentOfferSnapshot;
}): ApplicationDocumentValidationIssue | null {
  const sentenceIds = new Set<string>();
  for (const claim of input.claims) {
    if (sentenceIds.has(claim.sentenceId)) return { code: 'DUPLICATE_SENTENCE_ID', sentenceId: claim.sentenceId };
    sentenceIds.add(claim.sentenceId);
  }
  const offer = asBuilderOffer(input.offer);
  if (!offer) return null;
  for (const claim of input.claims) {
    if (claim.origin === 'USER_UNSUPPORTED') {
      if (claim.kind !== 'CANDIDATE_CLAIM') return { code: 'INVALID_SENTENCE_KIND', sentenceId: claim.sentenceId };
      if (new Set(claim.sourceFactIds).size !== claim.sourceFactIds.length) return { code: 'DUPLICATE_CITATION', sentenceId: claim.sentenceId };
      for (const factId of claim.sourceFactIds) {
        const fact = input.facts.find((candidate) => candidate.id === factId);
        if (!fact || fact.workspaceId !== input.workspaceId || fact.approval !== 'USER_APPROVED') {
          return { code: 'FACT_NOT_APPROVED', sentenceId: claim.sentenceId, factId };
        }
      }
      continue;
    }
    const validation = validateApplicationDocumentSentence({ sentence: claim, workspaceId: input.workspaceId, facts: input.facts.map((fact) => ({ ...fact, tags: fact.tags ?? [] })), offer });
    if (!validation.ok) return validation.issue;
  }
  return null;
}

function revisionFactIssue(workspaceId: string, claims: ApplicationDocumentRevisionClaim[], facts: ApplicationDocumentFactSnapshot[]) {
  for (const claim of claims) {
    for (const factId of claim.sourceFactIds) {
      const fact = facts.find((candidate) => candidate.id === factId);
      if (!fact || fact.workspaceId !== workspaceId || fact.approval !== 'USER_APPROVED') {
        return { code: 'FACT_NOT_APPROVED' as const, sentenceId: claim.sentenceId, factId };
      }
    }
  }
  return null;
}

/** Hashes only the exact claims, cited fact content/status, and stable offer fields defined by the design. */
export async function applicationDocumentHashes(input: HashInputs) {
  if (!input.offer.snapshot || input.offer.workspaceId !== input.workspaceId) return { ok: false as const, code: 'APPLICATION_HAS_NO_OFFER' as const };
  const citedIds = [...new Set(input.claims.flatMap((claim) => claim.sourceFactIds))].sort();
  const factsById = new Map(input.facts.filter((fact) => fact.workspaceId === input.workspaceId).map((fact) => [fact.id, fact]));
  const factsForHash = citedIds.map((id) => {
    const fact = factsById.get(id);
    const tags = (fact?.tags ?? []).map(canonicalText).sort((a, b) => a === b ? 0 : a < b ? -1 : 1);
    return { factId: id, status: fact?.approval ?? 'MISSING', canonicalText: canonicalText(fact?.text ?? ''), tags };
  });
  const description = canonicalText(input.offer.snapshot.descriptionText);
  const offer = {
    company: canonicalText(input.offer.company),
    role: canonicalText(input.offer.role),
    location: canonicalText(input.offer.location),
    title: canonicalText(input.offer.snapshot.title),
    description,
  };
  const [contentHash, factsHash, offerHash] = await Promise.all([
    sha256(stableJson(canonicalClaims(input.claims))),
    sha256(stableJson(factsForHash)),
    sha256(stableJson(offer)),
  ]);
  return { ok: true as const, offerSnapshotId: input.offer.snapshot.id, contentHash, factsHash, offerHash };
}

export type CreateApplicationDocumentRevisionResult =
  | { ok: true; revision: ApplicationDocumentRevision }
  | { ok: false; code: 'APPLICATION_HAS_NO_OFFER' | 'INVALID_PARENT_REVISION' }
  | { ok: false; code: 'LANGUAGE_MISMATCH'; sentenceIds: string[] }
  | { ok: false; code: 'INVALID_CLAIM'; issue: ApplicationDocumentValidationIssue };

/** Creates an immutable pending revision. Editing always creates a child; it never mutates the previous revision. */
export async function createApplicationDocumentRevision(input: {
  id: string;
  workspaceId: string;
  documentId: string;
  language: ApplicationDocumentLanguage;
  claims: ApplicationDocumentRevisionClaim[];
  facts: ApplicationDocumentFactSnapshot[];
  offer: ApplicationDocumentOfferSnapshot;
  paperSize: 'A4' | 'LETTER';
  textSha256: string;
  pdfSha256: string;
  previousRevision?: ApplicationDocumentRevision | null;
}): Promise<CreateApplicationDocumentRevisionResult> {
  const previous = input.previousRevision ?? null;
  if (previous && (previous.workspaceId !== input.workspaceId || previous.documentId !== input.documentId)) {
    return { ok: false, code: 'INVALID_PARENT_REVISION' };
  }
  const sentenceIds = mixedLanguageSentenceIds(input.language, input.claims);
  if (sentenceIds.length) return { ok: false, code: 'LANGUAGE_MISMATCH', sentenceIds };
  const hashes = await applicationDocumentHashes({ workspaceId: input.workspaceId, claims: input.claims, facts: input.facts, offer: input.offer });
  if (!hashes.ok) return hashes;
  const issue = revisionClaimIssue({ workspaceId: input.workspaceId, claims: input.claims, facts: input.facts, offer: input.offer });
  if (issue) return { ok: false, code: 'INVALID_CLAIM', issue };
  return {
    ok: true,
    revision: {
      id: input.id,
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      revision: (previous?.revision ?? 0) + 1,
      parentRevision: previous?.revision ?? null,
      language: input.language,
      claims: input.claims.map((claim) => ({ ...claim, sourceFactIds: [...claim.sourceFactIds] })),
      contentHash: hashes.contentHash,
      offerSnapshotId: hashes.offerSnapshotId,
      offerHash: hashes.offerHash,
      factsHash: hashes.factsHash,
      paperSize: input.paperSize,
      textSha256: input.textSha256,
      pdfSha256: input.pdfSha256,
      confirmedUnsupportedIds: [],
      approvedAt: null,
      approvedBy: null,
    },
  };
}

export type ApplicationDocumentApprovalResult =
  | { ok: true; revision: ApplicationDocumentRevision }
  | { ok: false; code: 'NOT_PENDING' | 'NOT_NEWEST' | 'UNSUPPORTED_NOT_CONFIRMED' }
  | { ok: false; code: 'APPROVAL_STALE'; reason: 'OFFER_MISSING' | 'CONTENT_HASH_CHANGED' | 'FACTS_CHANGED' | 'OFFER_CHANGED' | 'SUBMITTED_HASH_MISMATCH' | 'PREVIEW_DIGEST_MISMATCH' | 'APPROVAL_METADATA_INVALID' }
  | { ok: false; code: 'FACT_NOT_APPROVED'; sentenceId: string; factId: string }
  | { ok: false; code: 'LANGUAGE_MISMATCH'; sentenceIds: string[] }
  | { ok: false; code: 'INVALID_CLAIM'; issue: ApplicationDocumentValidationIssue };

/** Pure approval decision. The caller supplies digests of stored bytes; this function never invokes a renderer. */
export async function approveApplicationDocumentRevision(input: {
  revision: ApplicationDocumentRevision;
  newestRevisionId: string;
  facts: ApplicationDocumentFactSnapshot[];
  offer: ApplicationDocumentOfferSnapshot;
  expectedContentHash: string;
  expectedFactsHash: string;
  expectedOfferHash: string;
  expectedTextSha256: string;
  expectedPdfSha256: string;
  storedTextSha256: string;
  storedPdfSha256: string;
  confirmedUnsupportedIds: string[];
  approvedAt: string;
  approvedBy: string;
}): Promise<ApplicationDocumentApprovalResult> {
  const revision = input.revision;
  if (revision.approvedAt || revision.approvedBy) return { ok: false, code: 'NOT_PENDING' };
  if (input.newestRevisionId !== revision.id) return { ok: false, code: 'NOT_NEWEST' };
  const mixedLanguageIds = mixedLanguageSentenceIds(revision.language, revision.claims);
  if (mixedLanguageIds.length) return { ok: false, code: 'LANGUAGE_MISMATCH', sentenceIds: mixedLanguageIds };
  const unsupportedIds = revision.claims.filter((claim) => claim.origin === 'USER_UNSUPPORTED').map((claim) => claim.sentenceId).sort();
  const confirmedIds = [...new Set(input.confirmedUnsupportedIds)].sort();
  if (confirmedIds.length !== input.confirmedUnsupportedIds.length || !sameIds(unsupportedIds, confirmedIds)) {
    return { ok: false, code: 'UNSUPPORTED_NOT_CONFIRMED' };
  }
  const factIssue = revisionFactIssue(revision.workspaceId, revision.claims, input.facts);
  if (factIssue) return { ok: false, ...factIssue };
  const hashes = await applicationDocumentHashes({ workspaceId: revision.workspaceId, claims: revision.claims, facts: input.facts, offer: input.offer });
  if (!hashes.ok) return { ok: false, code: 'APPROVAL_STALE', reason: 'OFFER_MISSING' };
  if (hashes.contentHash !== revision.contentHash) return { ok: false, code: 'APPROVAL_STALE', reason: 'CONTENT_HASH_CHANGED' };
  if (hashes.factsHash !== revision.factsHash) return { ok: false, code: 'APPROVAL_STALE', reason: 'FACTS_CHANGED' };
  if (hashes.offerHash !== revision.offerHash) return { ok: false, code: 'APPROVAL_STALE', reason: 'OFFER_CHANGED' };
  const issue = revisionClaimIssue({ workspaceId: revision.workspaceId, claims: revision.claims, facts: input.facts, offer: input.offer });
  if (issue) return { ok: false, code: 'INVALID_CLAIM', issue };
  if (hashes.contentHash !== input.expectedContentHash || hashes.factsHash !== input.expectedFactsHash || hashes.offerHash !== input.expectedOfferHash
    || revision.textSha256 !== input.expectedTextSha256 || revision.pdfSha256 !== input.expectedPdfSha256) {
    return { ok: false, code: 'APPROVAL_STALE', reason: 'SUBMITTED_HASH_MISMATCH' };
  }
  if (revision.textSha256 !== input.storedTextSha256 || revision.pdfSha256 !== input.storedPdfSha256) {
    return { ok: false, code: 'APPROVAL_STALE', reason: 'PREVIEW_DIGEST_MISMATCH' };
  }
  if (!input.approvedAt || !Number.isFinite(Date.parse(input.approvedAt)) || !input.approvedBy.trim()) return { ok: false, code: 'APPROVAL_STALE', reason: 'APPROVAL_METADATA_INVALID' };
  return {
    ok: true,
    revision: { ...revision, approvedAt: input.approvedAt, approvedBy: input.approvedBy, confirmedUnsupportedIds: unsupportedIds },
  };
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export type ApplicationDocumentCurrentness = { status: 'CURRENT' | 'NEEDS_REVIEW'; reasons: ('FACTS_CHANGED' | 'OFFER_CHANGED' | 'FACT_NOT_APPROVED' | 'LANGUAGE_MISMATCH')[] };

/** Freshness is computed from current sources and is never stored back onto a revision. */
export async function applicationDocumentCurrentness(input: {
  revision: ApplicationDocumentRevision;
  facts: ApplicationDocumentFactSnapshot[];
  offer: ApplicationDocumentOfferSnapshot;
}): Promise<ApplicationDocumentCurrentness> {
  const reasons: ApplicationDocumentCurrentness['reasons'] = [];
  if (mixedLanguageSentenceIds(input.revision.language, input.revision.claims).length) reasons.push('LANGUAGE_MISMATCH');
  const citedIds = [...new Set(input.revision.claims.flatMap((claim) => claim.sourceFactIds))];
  const currentFacts = new Map(input.facts.map((fact) => [fact.id, fact]));
  if (citedIds.some((id) => {
    const fact = currentFacts.get(id);
    return !fact || fact.workspaceId !== input.revision.workspaceId || fact.approval !== 'USER_APPROVED';
  })) reasons.push('FACT_NOT_APPROVED');
  const hashes = await applicationDocumentHashes({ workspaceId: input.revision.workspaceId, claims: input.revision.claims, facts: input.facts, offer: input.offer });
  if (!hashes.ok || hashes.factsHash !== input.revision.factsHash) reasons.push('FACTS_CHANGED');
  if (!hashes.ok || hashes.offerHash !== input.revision.offerHash) reasons.push('OFFER_CHANGED');
  return { status: reasons.length ? 'NEEDS_REVIEW' : 'CURRENT', reasons: [...new Set(reasons)] };
}

export function isApplicationDocumentSentenceKind(value: string): value is ApplicationDocumentSentenceKind {
  return value === 'OFFER_REFERENCE' || value === 'BOILERPLATE' || value === 'CANDIDATE_CLAIM';
}

export function newestApprovedApplicationDocumentRevision(revisions: ApplicationDocumentRevision[]) {
  return revisions.filter((revision) => revision.approvedAt !== null).sort((a, b) => b.revision - a.revision)[0] ?? null;
}

export function isApplicationDocumentRevisionSuperseded(revision: ApplicationDocumentRevision, revisions: ApplicationDocumentRevision[]) {
  return revisions.some((candidate) => sameLogicalDocument(candidate, revision) && candidate.approvedAt !== null && candidate.revision > revision.revision);
}

function sameLogicalDocument(left: ApplicationDocumentRevision, right: ApplicationDocumentRevision) {
  return left.workspaceId === right.workspaceId && left.documentId === right.documentId;
}

export function applicationDocumentRevisionSelection(revision: ApplicationDocumentRevision, revisions: ApplicationDocumentRevision[], currentness: ApplicationDocumentCurrentness) {
  const newestApproved = newestApprovedApplicationDocumentRevision(revisions.filter((candidate) => sameLogicalDocument(candidate, revision)));
  const newerPendingRevision = revisions
    .filter((candidate) => sameLogicalDocument(candidate, revision) && !candidate.approvedAt && candidate.revision > revision.revision)
    .sort((a, b) => b.revision - a.revision)[0] ?? null;
  const selectable = revision.approvedAt !== null && newestApproved?.id === revision.id && currentness.status === 'CURRENT';
  return { selectable, superseded: isApplicationDocumentRevisionSuperseded(revision, revisions), newerPendingRevisionId: newerPendingRevision?.id ?? null };
}
