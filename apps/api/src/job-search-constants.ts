/**
 * Minimum time between two reads of the same public feed, shared by every search and workspace. Remotive's API terms
 * allow at most four requests a day (https://github.com/remotive-com/remote-jobs-api), so this must stay at six hours
 * or more; failures only lengthen it (see backoff in job-search.ts). test/job-search.test.ts guards the minimum.
 */
export const JOB_SEARCH_PROVIDER_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const JOB_SEARCH_INTERVAL_MS = JOB_SEARCH_PROVIDER_COOLDOWN_MS;
export const JOB_SEARCH_FAILURE_MAX_MS = 48 * 60 * 60 * 1000;
