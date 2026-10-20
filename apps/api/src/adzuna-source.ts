import { createHash } from 'node:crypto';
import { plainDescription, type PublicJob, type SearchWorkMode } from './job-search-sources.js';
import { MAX_RESPONSE_BYTES, ProviderReadError, REQUEST_TIMEOUT_MS, parseRetryAfter } from './job-search-sources.js';

const API_ORIGIN = 'https://api.adzuna.com';
const ADZUNA_DOMAINS: Record<string, string> = {
  at: 'adzuna.at', au: 'adzuna.com.au', be: 'adzuna.be', br: 'adzuna.com.br', ca: 'adzuna.ca', ch: 'adzuna.ch',
  de: 'adzuna.de', es: 'adzuna.es', fr: 'adzuna.fr', gb: 'adzuna.co.uk', in: 'adzuna.in', it: 'adzuna.it',
  nl: 'adzuna.nl', nz: 'adzuna.co.nz', pl: 'adzuna.pl', sg: 'adzuna.sg', za: 'adzuna.co.za', us: 'adzuna.com',
};
export const ADZUNA_RESULTS_PER_PAGE = 20;
export const ADZUNA_MAX_PAGES = 3;
export const ADZUNA_MAX_REQUESTS_PER_DAY = 50;
export const ADZUNA_MAX_REQUESTS_PER_WEEK = 300;
export const ADZUNA_MAX_REQUESTS_PER_MONTH = 1200;
export const ADZUNA_CACHE_HOURS = 24;

export type AdzunaCriteria = { role: string | null; company: string | null; location: string | null; workMode: SearchWorkMode };
export type AdzunaCredentials = { appId: string; appKey: string; country: string };

export function readAdzunaCredentials(env: NodeJS.ProcessEnv = process.env): AdzunaCredentials | null {
  const appId = env.ADZUNA_APP_ID?.trim(); const appKey = env.ADZUNA_APP_KEY?.trim();
  if (!appId || !appKey) return null;
  const country = (env.ADZUNA_COUNTRY ?? 'es').trim().toLowerCase();
  if (!/^[a-z]{2}$/u.test(country) || !ADZUNA_DOMAINS[country]) return null;
  return { appId, appKey, country };
}

export function normalizeAdzunaJobs(payload: unknown, country: string): PublicJob[] {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  if (!Array.isArray(root.results)) throw new ProviderReadError('SOURCE_INVALID_RESPONSE');
  const domain = ADZUNA_DOMAINS[country];
  if (!domain) throw new ProviderReadError('SOURCE_INVALID_RESPONSE');
  const jobs: PublicJob[] = [];
  for (const entry of root.results.slice(0, ADZUNA_RESULTS_PER_PAGE)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const company = raw.company && typeof raw.company === 'object' && !Array.isArray(raw.company) ? raw.company as Record<string, unknown> : {};
    const location = raw.location && typeof raw.location === 'object' && !Array.isArray(raw.location) ? raw.location as Record<string, unknown> : {};
    const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 300) : '';
    const employer = typeof company.display_name === 'string' ? company.display_name.trim().slice(0, 200) : '';
    const id = typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id).slice(0, 300) : '';
    const sourceUrl = typeof raw.redirect_url === 'string' ? safeAdvertUrl(raw.redirect_url, domain) : null;
    if (!title || !employer || !id || !sourceUrl) continue;
    const locationName = typeof location.display_name === 'string' ? location.display_name.trim().slice(0, 300) : null;
    const description = plainDescription(raw.description);
    const published = typeof raw.created === 'string' && Number.isFinite(Date.parse(raw.created)) ? new Date(raw.created).toISOString() : null;
    const signals = `${title} ${locationName ?? ''}`.toLowerCase();
    const workMode: PublicJob['workMode'] = /\b(hybrid|partly remote|partially remote)\b/u.test(signals) ? 'hybrid'
      : /\b(remote|anywhere|work from home|telecommut)\b/u.test(signals) ? 'remote'
      : /\b(on[- ]?site|in[- ]office|office based)\b/u.test(signals) ? 'onsite' : 'unknown';
    jobs.push({
      externalId: id, title, company: employer, location: locationName, workMode, url: sourceUrl, attributionUrl: adzunaAttributionUrl(country), postedAt: published,
      description, raw: { id, title, company: { display_name: employer }, location: { display_name: locationName }, created: published, salary_min: finiteNumber(raw.salary_min), salary_max: finiteNumber(raw.salary_max), salary_is_predicted: raw.salary_is_predicted === 1 || raw.salary_is_predicted === true },
    });
  }
  return jobs;
}

function finiteNumber(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }

function safeAdvertUrl(value: string, expectedDomain: string): string | null {
  if (value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || ![expectedDomain, `www.${expectedDomain}`].includes(url.hostname.toLowerCase())) return null;
    // Adzuna's examples contain HTTP redirect URLs. Upgrade only its exact country domain.
    url.protocol = 'https:';
    return url.toString();
  } catch { return null; }
}

async function responseText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_RESPONSE_BYTES) throw new ProviderReadError('SOURCE_RESPONSE_TOO_LARGE');
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ProviderReadError('SOURCE_RESPONSE_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export async function readAdzunaSearch(criteria: AdzunaCriteria, options: { credentials?: AdzunaCredentials | null; fetcher?: typeof fetch; now?: number; wait?: (milliseconds: number) => Promise<unknown> } = {}): Promise<{ jobs: PublicJob[]; coverage: 'BOUNDED' }> {
  const credentials = options.credentials === undefined ? readAdzunaCredentials() : options.credentials;
  if (!credentials) throw new ProviderReadError('SOURCE_NOT_CONFIGURED');
  const query = [criteria.role, criteria.company].filter((value): value is string => Boolean(value?.trim())).join(' ').trim();
  if (!query) throw new ProviderReadError('SOURCE_INVALID_REQUEST');
  const found = new Map<string, PublicJob>(); let page = 1;
  for (; page <= ADZUNA_MAX_PAGES; page++) {
    if (page > 1) await (options.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))))(2_500);
    const endpoint = new URL(`/v1/api/jobs/${credentials.country}/search/${page}`, API_ORIGIN);
    endpoint.searchParams.set('app_id', credentials.appId);
    endpoint.searchParams.set('app_key', credentials.appKey);
    endpoint.searchParams.set('results_per_page', String(ADZUNA_RESULTS_PER_PAGE));
    endpoint.searchParams.set('what', query.slice(0, 200));
    if (criteria.location?.trim()) endpoint.searchParams.set('where', criteria.location.trim().slice(0, 200));
    endpoint.searchParams.set('content-type', 'application/json');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let payload: unknown;
    try {
      const response = await (options.fetcher ?? fetch)(endpoint.toString(), { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': 'CareerStack/0.9 Adzuna job search' }, redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new ProviderReadError(`SOURCE_HTTP_${response.status}`, parseRetryAfter(response.headers.get('retry-after'), options.now));
      try { payload = JSON.parse(await responseText(response)); }
      catch (error) { if (error instanceof ProviderReadError) throw error; throw new ProviderReadError('SOURCE_INVALID_RESPONSE'); }
    } catch (error) {
      if (error instanceof ProviderReadError) throw error;
      throw new ProviderReadError(error instanceof Error && error.name === 'AbortError' ? 'SOURCE_TIMEOUT' : 'SOURCE_UNAVAILABLE');
    } finally { clearTimeout(timeout); }
    const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    if (!Array.isArray(root.results)) throw new ProviderReadError('SOURCE_INVALID_RESPONSE');
    for (const job of normalizeAdzunaJobs(payload, credentials.country)) found.set(job.externalId, job);
    if (root.results.length < ADZUNA_RESULTS_PER_PAGE) break;
  }
  // The bounded page walk is never treated as a complete feed for closing absent listings.
  return { jobs: [...found.values()], coverage: 'BOUNDED' };
}

export function adzunaQueryHash(criteria: AdzunaCriteria, country: string): string {
  return createHash('sha256').update(JSON.stringify({ country, role: criteria.role?.trim() ?? null, company: criteria.company?.trim() ?? null, location: criteria.location?.trim() ?? null, workMode: criteria.workMode, maxPages: ADZUNA_MAX_PAGES, resultsPerPage: ADZUNA_RESULTS_PER_PAGE })).digest('hex');
}

export function adzunaAttributionUrl(country: string): string { return `https://www.${(ADZUNA_DOMAINS[country] ?? 'adzuna.es').replace(/^www\./u, '')}`; }
