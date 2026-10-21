/**
 * Interview preparation (ADR 024). A plan never copies the profile or the resume: it stores a reference and a hash of
 * each piece of evidence it used, and compares them with the current records whenever the plan is opened.
 */
export const interviewEvidenceKinds = ['JOB_SNAPSHOT', 'RESUME_VERSION', 'APPROVED_FACT'] as const;
export type InterviewEvidenceKind = (typeof interviewEvidenceKinds)[number];

export const interviewItemKinds = ['REQUIREMENT', 'EXERCISE', 'STUDY', 'QUESTION', 'NOTE'] as const;
export type InterviewItemKind = (typeof interviewItemKinds)[number];

/** Where a plan item came from, so it can be audited and never passed off as a real employer question. */
export const interviewItemOrigins = ['JOB_SNAPSHOT', 'APPROVED_FACT', 'USER_NOTE', 'USER_RESEARCH', 'FIXED_TEMPLATE', 'ASSISTANT'] as const;
export type InterviewItemOrigin = (typeof interviewItemOrigins)[number];

export const interviewSessionStatuses = ['IN_PROGRESS', 'COMPLETED'] as const;
export type InterviewSessionStatus = (typeof interviewSessionStatuses)[number];

/** CURRENT: unchanged since the plan was made. STALE: changed or no longer approved. MISSING: the record is gone. */
export type InterviewEvidenceStatus = 'CURRENT' | 'STALE' | 'MISSING';

/** What the record looks like now. `withdrawn` is a fact the person no longer approves. */
export type InterviewEvidenceCurrent = { hash: string; withdrawn?: boolean };

/** A withdrawn fact is stale even when its text is unchanged: the person has stopped vouching for it. */
export function interviewEvidenceStatus(storedHash: string, current: InterviewEvidenceCurrent | null | undefined): InterviewEvidenceStatus {
  if (!current) return 'MISSING';
  if (current.withdrawn) return 'STALE';
  return current.hash === storedHash ? 'CURRENT' : 'STALE';
}

/** A plan needs review before reuse as soon as any piece of its evidence is not current. */
export function interviewPlanNeedsReview(statuses: readonly InterviewEvidenceStatus[]): boolean {
  return statuses.some((status) => status !== 'CURRENT');
}
