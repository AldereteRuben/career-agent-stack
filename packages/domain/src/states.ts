export const jobAvailability = ['OPEN', 'POSSIBLY_CLOSED', 'CLOSED', 'UNKNOWN'] as const;
export const shortlistDecision = ['UNREVIEWED', 'SHORTLISTED', 'SKIPPED', 'ARCHIVED'] as const;
export const applicationState = ['DRAFT', 'PREPARING', 'REVIEW_REQUIRED', 'READY', 'IN_PROGRESS', 'UNKNOWN', 'CONFIRMED', 'CANCELLED'] as const;
export const recruitmentStage = ['NO_RESPONSE', 'RECRUITER_CONTACT', 'ASSESSMENT', 'INTERVIEW', 'FINAL_INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN', 'HIRED'] as const;
export const eligibilityState = ['PASS', 'FAIL', 'NEEDS_REVIEW'] as const;
export const factApproval = ['SUGGESTED', 'USER_APPROVED', 'REJECTED'] as const;
export const boardPermission = ['APPROVED_FOR_SCOPE', 'UNKNOWN', 'BLOCKED'] as const;
export type ApplicationState = (typeof applicationState)[number];
export type RecruitmentStage = (typeof recruitmentStage)[number];

export const allowedApplicationTransitions: Record<ApplicationState, readonly ApplicationState[]> = {
  DRAFT: ['PREPARING', 'CANCELLED'],
  PREPARING: ['REVIEW_REQUIRED', 'CANCELLED'],
  REVIEW_REQUIRED: ['PREPARING', 'READY', 'CANCELLED'],
  READY: ['REVIEW_REQUIRED', 'IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['UNKNOWN', 'CONFIRMED', 'CANCELLED'],
  UNKNOWN: ['CONFIRMED', 'REVIEW_REQUIRED'],
  CONFIRMED: ['REVIEW_REQUIRED'],
  CANCELLED: [],
};

export function canTransitionApplication(from: ApplicationState, to: ApplicationState, evidence?: 'USER_ATTESTATION'): boolean {
  if (to === 'CONFIRMED' && evidence === 'USER_ATTESTATION' && from !== 'CANCELLED') return true;
  return allowedApplicationTransitions[from].includes(to);
}

export type RecruitmentStageChange = 'UNCHANGED' | 'ADVANCE' | 'CORRECTION' | 'REJECTED_REGRESSION';
/** Stages normally move forward; moving back is allowed only as an explicit correction, which callers must record in the event history. */
export function classifyRecruitmentStageChange(from: RecruitmentStage, to: RecruitmentStage, correction = false): RecruitmentStageChange {
  if (from === to) return 'UNCHANGED';
  if (recruitmentStage.indexOf(to) > recruitmentStage.indexOf(from)) return 'ADVANCE';
  return correction ? 'CORRECTION' : 'REJECTED_REGRESSION';
}

/** Recruitment outcomes that end the process even though the application itself was not cancelled. */
export const terminalRecruitmentStages = ['REJECTED', 'WITHDRAWN', 'HIRED'] as const satisfies readonly RecruitmentStage[];
/** Applications that still count as active in the tracker: not cancelled and not in a terminal recruitment stage. */
export const isActiveApplication = (application: { state: ApplicationState; recruitmentStage: RecruitmentStage }) =>
  application.state !== 'CANCELLED' && !(terminalRecruitmentStages as readonly RecruitmentStage[]).includes(application.recruitmentStage);

/** Submitted or terminal applications cannot start a new preparation or assisted form. */
export const isApplicationClosedForPreparation = (application: { state: string; recruitmentStage: string }) =>
  ['CONFIRMED', 'CANCELLED'].includes(application.state) || (terminalRecruitmentStages as readonly string[]).includes(application.recruitmentStage);
