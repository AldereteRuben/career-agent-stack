export type OverviewDetailsState = {
  totalJobs: number;
  totalApplications: number;
  /** Profile details waiting for the person to confirm. */
  pendingFacts: number;
  /** Questions without an approved answer. */
  unansweredItems: number;
  /** Applications that need the person's review. */
  needsReview: number;
  /** Prepared resumes waiting for review. */
  pendingResumes: number;
};

/** The "more figures and other tasks" block stays open when something awaits review, so it is not missed, and once the person has data to look at. */
export const overviewDetailsOpen = (state: OverviewDetailsState) =>
  state.pendingFacts > 0 || state.unansweredItems > 0 || state.needsReview > 0 || state.pendingResumes > 0 || state.totalJobs > 0 || state.totalApplications > 0;
