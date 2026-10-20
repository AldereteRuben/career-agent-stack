export type OverviewDetailsState = {
  /** Profile details waiting for the person to confirm. */
  pendingFacts: number;
  /** Questions without an approved answer. */
  unansweredItems: number;
  /** Applications that need the person's review. */
  needsReview: number;
  /** Prepared resumes waiting for review. */
  pendingResumes: number;
};

/** The "more figures and other tasks" block stays closed unless something awaits the person's review, so it is not missed. */
export const overviewDetailsOpen = (state: OverviewDetailsState) =>
  state.pendingFacts > 0 || state.unansweredItems > 0 || state.needsReview > 0 || state.pendingResumes > 0;
