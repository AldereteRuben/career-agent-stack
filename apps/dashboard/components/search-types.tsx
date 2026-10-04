export type ProviderId = 'remotive' | 'arbeitnow' | 'himalayas' | 'boards';
export type Search = {
  id: string;
  role: string | null;
  company: string | null;
  location: string | null;
  workMode: 'any' | 'remote' | 'hybrid' | 'onsite';
  frequencyHours: 6 | 12 | 24;
  enabled: boolean;
  autoPrepare: boolean;
  language: 'en' | 'es';
  revision: number;
  matcherVersion: 1 | 2;
  providerIds: ProviderId[];
  includeRelated: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastRunStatus: string | null;
  lastResultCount: number;
  lastNewCount: number;
  lastError: string | null;
  latestRun?: {
    id: string;
    status: string;
    finishedAt: string | null;
    error: string | null;
    sources: Array<{ provider: ProviderId | string; status: string; coverage: string | null; fetchedAt: string | null; nextFetchAt?: string | null; error: string | null }>;
  } | null;
};

export type SearchJob = {
  id: string;
  company: string;
  title: string;
  location: string | null;
  canonicalUrl: string | null;
  seenAt: string | null;
  shortlistDecision: string;
  matchedAt: string;
  applicationId?: string | null;
  documentId?: string | null;
  applicationState?: string | null;
  documentApprovalStatus?: string | null;
  unknownLocation?: boolean;
  locationStatus?: string;
  searchScore?: number | null;
  searchReasons?: string[];
  groupId?: string | null;
  duplicateCount?: number;
  identityConflict?: boolean;
  searchIds?: string[];
  autoPreparedAt?: string | null;
  autoPrepareError?: string | null;
  sources: Array<{ provider: ProviderId | string; name?: string; url: string; postedAt: string | null; fetchedAt?: string | null }>;
};

export function searchInFlight(search?: Search | null): boolean {
  const status = search?.latestRun?.status ?? search?.lastRunStatus;
  return ['QUEUED', 'RUNNING'].includes(status ?? '') || Boolean(search?.latestRun && status === 'PARTIAL' && !search.latestRun.finishedAt);
}

export type SearchView = 'new' | 'all' | 'saved' | 'archived';
export type SearchSort = 'relevance' | 'recent';
export type SearchDraft = {
  role: string;
  company: string;
  location: string;
  workMode: Search['workMode'];
  frequencyHours: Search['frequencyHours'];
  enabled: boolean;
  autoPrepare: boolean;
  providerIds: ProviderId[];
  matcherVersion: 1 | 2;
  includeRelated: boolean;
  improveMatching: boolean;
};
