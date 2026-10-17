export type PreparationReviewItem = { documentId?: string | null; needsAttention?: boolean };
export type ReviewableResume = { approvalStatus: string; id: string; name: string; reviewReady: boolean };

/** Returns ready-to-approve resumes that do not already have a visible preparation row. */
export function unqueuedReviewableResumes(preparations: readonly PreparationReviewItem[], documents: readonly ReviewableResume[]) {
  const pendingPreparations = preparations.filter((item) => item.needsAttention);
  const queuedDocumentIds = new Set(pendingPreparations.flatMap((item) => item.documentId ? [item.documentId] : []));
  return documents.filter((document) => document.approvalStatus === 'PENDING_REVIEW' && document.reviewReady && !queuedDocumentIds.has(document.id));
}

/** Counts exactly the rows shown in the pending review queue. */
export function countReviewItems(preparations: readonly PreparationReviewItem[], documents: readonly ReviewableResume[]) {
  return preparations.filter((item) => item.needsAttention).length + unqueuedReviewableResumes(preparations, documents).length;
}
