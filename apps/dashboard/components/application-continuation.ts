/** Pure decisions for what moves an application forward; kept free of React so they can be tested directly. */

const identityGaps = ['PROFILE_REQUIRED', 'FULL_NAME_REQUIRED', 'EMAIL_REQUIRED'];

/** The one step that unblocks preparation; identity comes first because every resume needs it. */
export const gapContinuation = (gaps: readonly string[]): 'identity' | 'experience' | 'job-text' | null =>
  gaps.some((gap) => identityGaps.includes(gap)) ? 'identity' : gaps.includes('RELEVANT_APPROVED_EVIDENCE_REQUIRED') ? 'experience' : gaps.includes('JOB_TEXT_UNAVAILABLE') ? 'job-text' : null;

export type QueueItem = { queueState?: string; needsAttention?: boolean; applicationId: string | null; documentId: string | null; gaps: readonly string[] };
export type QueueAction = { kind: 'continue' | 'review' | 'update' | 'check' | 'open' | 'approved'; primary: boolean };

/**
 * Actions for one review-queue card in display order, with at most one primary: missing details lead when present, then a
 * pending resume review, then continuing to the form or employer page once the resume is approved.
 */
export function queueActions(item: QueueItem): QueueAction[] {
  const gapLeads = gapContinuation(item.gaps) !== null;
  const checking = ['UNCERTAIN', 'IN_PROGRESS'].includes(item.queueState ?? '');
  const hasDocument = Boolean(item.documentId && item.applicationId);
  if (item.queueState === 'READY' && item.applicationId) return [{ kind: 'continue', primary: !gapLeads }, ...(hasDocument ? [{ kind: 'approved' as const, primary: false }] : [])];
  const actions: QueueAction[] = [];
  const review = hasDocument && item.needsAttention && !checking;
  if (review) actions.push({ kind: item.queueState === 'STALE_DOCUMENT' ? 'update' : 'review', primary: !gapLeads });
  if (item.applicationId) actions.push({ kind: checking ? 'check' : 'open', primary: !gapLeads && !review });
  return actions;
}
