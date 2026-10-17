import type { ApplicationDocumentLanguage, ApplicationDocumentSentence, ApplicationDocumentSentenceKind } from './application-documents-builder.js';

export type ApplicationDocumentRevisionClaim = ApplicationDocumentSentence & { language: ApplicationDocumentLanguage };
export type ApplicationDocumentFactSnapshot = { id: string; workspaceId: string; approval: string; text: string };
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
  const snapshot = [...input.snapshots].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt) || b.id.localeCompare(a.id))[0] ?? null;
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

/** Hashes only the exact claims, cited fact content/status, and stable offer fields defined by the design. */
export async function applicationDocumentHashes(input: HashInputs) {
  if (!input.offer.snapshot || input.offer.workspaceId !== input.workspaceId) return { ok: false as const, code: 'APPLICATION_HAS_NO_OFFER' as const };
  const citedIds = [...new Set(input.claims.flatMap((claim) => claim.sourceFactIds))].sort();
  const factsById = new Map(input.facts.filter((fact) => fact.workspaceId === input.workspaceId).map((fact) => [fact.id, fact]));
  const factsForHash = citedIds.map((id) => {
    const fact = factsById.get(id);
    return { factId: id, status: fact?.approval ?? 'MISSING', canonicalText: canonicalText(fact?.text ?? '') };
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
  | { ok: false; code: 'APPLICATION_HAS_NO_OFFER' | 'LANGUAGE_MISMATCH' | 'INVALID_PARENT_REVISION'; sentenceIds?: string[] };

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
      confirmedUnsupportedIds: input.claims.filter((claim) => claim.origin === 'USER_UNSUPPORTED').map((claim) => claim.sentenceId).sort(),
      approvedAt: null,
      approvedBy: null,
    },
  };
}

export type ApplicationDocumentApprovalResult =
  | { ok: true; revision: ApplicationDocumentRevision }
  | { ok: false; code: 'NOT_PENDING' | 'NOT_NEWEST' | 'APPROVAL_STALE' | 'UNSUPPORTED_NOT_CONFIRMED' | 'FACT_NOT_APPROVED' | 'LANGUAGE_MISMATCH' };

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
  if (mixedLanguageSentenceIds(revision.language, revision.claims).length) return { ok: false, code: 'LANGUAGE_MISMATCH' };
  const unsupportedIds = revision.claims.filter((claim) => claim.origin === 'USER_UNSUPPORTED').map((claim) => claim.sentenceId).sort();
  const confirmedIds = [...new Set(input.confirmedUnsupportedIds)].sort();
  if (confirmedIds.length !== input.confirmedUnsupportedIds.length || !sameIds(unsupportedIds, confirmedIds) || !sameIds(unsupportedIds, revision.confirmedUnsupportedIds)) {
    return { ok: false, code: 'UNSUPPORTED_NOT_CONFIRMED' };
  }
  const citedIds = [...new Set(revision.claims.flatMap((claim) => claim.sourceFactIds))];
  const currentFacts = new Map(input.facts.map((fact) => [fact.id, fact]));
  if (citedIds.some((id) => {
    const fact = currentFacts.get(id);
    return !fact || fact.workspaceId !== revision.workspaceId || fact.approval !== 'USER_APPROVED';
  })) return { ok: false, code: 'FACT_NOT_APPROVED' };
  const hashes = await applicationDocumentHashes({ workspaceId: revision.workspaceId, claims: revision.claims, facts: input.facts, offer: input.offer });
  if (!hashes.ok || hashes.contentHash !== revision.contentHash || hashes.factsHash !== revision.factsHash || hashes.offerHash !== revision.offerHash
    || hashes.contentHash !== input.expectedContentHash || hashes.factsHash !== input.expectedFactsHash || hashes.offerHash !== input.expectedOfferHash
    || revision.textSha256 !== input.expectedTextSha256 || revision.pdfSha256 !== input.expectedPdfSha256
    || revision.textSha256 !== input.storedTextSha256 || revision.pdfSha256 !== input.storedPdfSha256) {
    return { ok: false, code: 'APPROVAL_STALE' };
  }
  if (!input.approvedAt || !Number.isFinite(Date.parse(input.approvedAt)) || !input.approvedBy.trim()) return { ok: false, code: 'APPROVAL_STALE' };
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
