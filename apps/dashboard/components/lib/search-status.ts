import { searchInFlight, type Search } from '../search-types';

/**
 * One visible state per saved search. Only `queued` and `running` mean work is happening now;
 * a finished failure or limited coverage never reads as "still searching".
 */
export type SearchState = 'queued' | 'running' | 'paused' | 'failed' | 'limited' | 'pending' | 'ready';
export type SearchHealth = { state: SearchState; failedProviders: string[]; limitedProviders: string[]; finishedAt: string | null };
type Source = NonNullable<Search['latestRun']>['sources'][number];

const sourceFailed = (source: Source) => ['FAILED', 'ERROR'].includes(source.status.toUpperCase()) || Boolean(source.error);
const sourceLimited = (source: Source) => source.status.toUpperCase() === 'STALE' || ['BOUNDED', 'PARTIAL'].includes((source.coverage ?? '').toUpperCase());

export function searchHealth(search: Search): SearchHealth {
  const run = search.latestRun;
  const status = (run?.status ?? search.lastRunStatus ?? '').toUpperCase();
  const finishedAt = run ? run.finishedAt : search.lastRunAt;
  const sources = run?.sources ?? [];
  const failedProviders = run?.finishedAt ? sources.filter(sourceFailed).map((source) => source.provider) : [];
  const limitedProviders = run?.finishedAt ? sources.filter((source) => !sourceFailed(source) && sourceLimited(source)).map((source) => source.provider) : [];
  const base = { failedProviders, limitedProviders, finishedAt };
  if (searchInFlight(search)) return { ...base, state: status === 'QUEUED' ? 'queued' : 'running' };
  if (!search.enabled) return { ...base, state: 'paused' };
  if (status === 'FAILED' || (!run && Boolean(search.lastError)) || (sources.length > 0 && failedProviders.length === sources.length)) return { ...base, state: 'failed' };
  if (!finishedAt) return { ...base, state: 'pending' };
  if (status === 'PARTIAL' || failedProviders.length > 0 || limitedProviders.length > 0) return { ...base, state: 'limited' };
  return { ...base, state: 'ready' };
}

export const isActive = (state: SearchState) => state === 'queued' || state === 'running';

export type SearchSummary = {
  active: Search[]; failed: Search[]; limited: Search[]; paused: Search[]; pending: Search[];
  /** Earliest scheduled automatic check among enabled searches; null when everything is paused. */
  nextRunAt: string | null;
  allPaused: boolean;
};

export function summarize(searches: Search[]): SearchSummary {
  const by = (state: SearchState | SearchState[]) => searches.filter((search) => ([] as SearchState[]).concat(state).includes(searchHealth(search).state));
  const next = searches.filter((search) => search.enabled && search.nextRunAt && Number.isFinite(Date.parse(search.nextRunAt)))
    .map((search) => search.nextRunAt!).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
  return { active: by(['queued', 'running']), failed: by('failed'), limited: by('limited'), paused: by('paused'), pending: by('pending'), nextRunAt: next, allPaused: searches.length > 0 && searches.every((search) => !search.enabled) };
}

export type EmptyKind = 'loadError' | 'noSaved' | 'noArchived' | 'searching' | 'paused' | 'failed' | 'pending' | 'noMatches' | 'caughtUp' | 'unknown';

/**
 * Explains an empty result list truthfully. `matchesTotal` is the number of current matches in the
 * same scope before the New filter (null when unknown), so a first search with zero matches is never
 * described as "you reviewed everything".
 */
export function emptyKind({ view, error, scope, matchesTotal }: { view: 'new' | 'all' | 'saved' | 'archived'; error: boolean; scope: Search[]; matchesTotal: number | null }): EmptyKind {
  if (error) return 'loadError';
  if (view === 'saved') return 'noSaved';
  if (view === 'archived') return 'noArchived';
  const states = scope.map((search) => searchHealth(search).state);
  if (states.some(isActive)) return 'searching';
  if (states.length > 0 && states.every((state) => state === 'paused')) return 'paused';
  const running = states.filter((state) => state !== 'paused');
  if (running.length > 0 && running.every((state) => state === 'failed')) return 'failed';
  if (matchesTotal === null) return 'unknown';
  if (matchesTotal > 0) return view === 'new' ? 'caughtUp' : 'unknown';
  if (running.length > 0 && running.every((state) => state === 'pending')) return 'pending';
  return 'noMatches';
}

/** "today at 09:00" / "tomorrow at 09:00" / "Mon 12 Oct, 09:00"; a past time reads as "shortly". */
export function nextCheckLabel(value: string | null, locale: 'es' | 'en', now = new Date()): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  const es = locale === 'es';
  if (date.getTime() <= now.getTime()) return es ? 'en breve' : 'shortly';
  const time = new Intl.DateTimeFormat(es ? 'es-ES' : 'en-GB', { hour: '2-digit', minute: '2-digit' }).format(date);
  const day = (offset: number) => { const other = new Date(now); other.setDate(other.getDate() + offset); return other.toDateString() === date.toDateString(); };
  if (day(0)) return es ? `hoy a las ${time}` : `today at ${time}`;
  if (day(1)) return es ? `mañana a las ${time}` : `tomorrow at ${time}`;
  return new Intl.DateTimeFormat(es ? 'es-ES' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

export const searchName = (search: Pick<Search, 'role' | 'company'>, anyRole: string) => [search.role, search.company].filter(Boolean).join(' · ') || anyRole;
