export type PreparationReviewItem = { documentId?: string | null; needsAttention: boolean };
export type ReviewableResume = { approvalStatus: string; id: string; reviewReady: boolean };

/** Counts preparation work plus ready-to-approve resumes that are not already in that queue. */
export function countReviewItems(preparations: readonly PreparationReviewItem[], documents: readonly ReviewableResume[]) {
  const pendingPreparations = preparations.filter((item) => item.needsAttention);
  const queuedDocumentIds = new Set(pendingPreparations.flatMap((item) => item.documentId ? [item.documentId] : []));
  const unqueuedResumes = documents.filter((document) => document.approvalStatus === 'PENDING_REVIEW' && document.reviewReady && !queuedDocumentIds.has(document.id));
  return pendingPreparations.length + unqueuedResumes.length;
}
