export type JobSearchProvider = 'remotive' | 'arbeitnow';
export type SearchWorkMode = 'any' | 'remote' | 'hybrid' | 'onsite';
export type PublicJob = {
  externalId: string;
  title: string;
  company: string;
  location: string | null;
  workMode: Exclude<SearchWorkMode, 'any'> | 'unknown';
  url: string;
  postedAt: string | null;
  description: string | null;
  raw: Record<string, unknown>;
};

export const PROVIDERS: Record<JobSearchProvider, { name: string; endpoint: string; hosts: string[]; attribution: string }> = {
  remotive: { name: 'Remotive', endpoint: 'https://remotive.com/api/remote-jobs', hosts: ['remotive.com', 'www.remotive.com'], attribution: 'https://github.com/remotive-com/remote-jobs-api' },
  arbeitnow: { name: 'Arbeitnow', endpoint: 'https://www.arbeitnow.com/api/job-board-api', hosts: ['arbeitnow.com', 'www.arbeitnow.com', 'arbeitnow.co.uk', 'www.arbeitnow.co.uk', 'arbeitnow.fr', 'www.arbeitnow.fr', 'arbeitnow.ch', 'www.arbeitnow.ch'], attribution: 'https://www.arbeitnow.com/blog/job-board-api' },
};

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_ARBEITNOW_PAGES = 3;
export const REQUEST_TIMEOUT_MS = 8_000;
const allowedHost = (provider: JobSearchProvider, value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !PROVIDERS[provider].hosts.includes(url.hostname.toLowerCase()) || url.port) return null;
    return url.toString();
  } catch { return null; }
};

const text = (value: unknown, limit = 2000): string | null => typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : null;
const identifier = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
const plainDescription = (value: unknown): string | null => {
  const valueText = text(value, 100_000);
  return valueText ? valueText.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim().slice(0, 20_000) : null;
};
const modeFrom = (remote: unknown, title: string, location: string | null, raw: Record<string, unknown>): PublicJob['workMode'] => {
  const signals = `${title} ${location ?? ''} ${JSON.stringify(raw.tags ?? '')} ${JSON.stringify(raw.job_type ?? raw.job_types ?? '')}`.toLowerCase();
  if (/\b(hybrid|partly remote|partially remote)\b/.test(signals)) return 'hybrid';
  if (remote === true || /\b(remote|anywhere|work from home|telecommut)\b/.test(signals)) return 'remote';
  if (/\b(on[- ]?site|in[- ]office|office based)\b/.test(signals)) return 'onsite';
  return 'unknown';
};

/** Normalizes either documented public feed without following job links or employer pages. */
export function normalizePublicJobs(provider: JobSearchProvider, payload: unknown): PublicJob[] {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const rows = provider === 'remotive' ? root.jobs : root.data;
  if (!Array.isArray(rows)) throw new Error('SOURCE_INVALID_RESPONSE');
  const result: PublicJob[] = [];
  for (const item of rows) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const title = text(raw.title, 300);
    const company = text(provider === 'remotive' ? raw.company_name : raw.company_name, 200);
    const sourceUrl = allowedHost(provider, raw.url);
    const externalId = identifier(raw.id ?? raw.slug) ?? sourceUrl;
    if (!title || !company || !sourceUrl || !externalId) continue;
    const location = text(provider === 'remotive' ? raw.candidate_required_location ?? raw.location : raw.location, 300);
    const posted = provider === 'remotive' ? raw.publication_date : raw.created_at;
    const postedAt = typeof posted === 'number' && Number.isFinite(posted) ? new Date(posted < 10_000_000_000 ? posted * 1000 : posted).toISOString() : text(posted, 80);
    result.push({ externalId, title, company, location, workMode: modeFrom(raw.remote, title, location, raw), url: sourceUrl, postedAt, description: plainDescription(raw.description), raw });
  }
  return result;
}

async function readBounded(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_RESPONSE_BYTES) throw new Error('SOURCE_RESPONSE_TOO_LARGE');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('SOURCE_RESPONSE_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export function parseRetryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return now + Math.min(seconds * 1000, 48 * 60 * 60 * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) && date > now ? Math.min(date, now + 48 * 60 * 60 * 1000) : 0;
}

export class ProviderReadError extends Error {
  constructor(readonly code: string, readonly retryAt = 0) { super(code); }
}

export type ProviderFeed = { jobs: PublicJob[]; coverage: 'COMPLETE' | 'BOUNDED' };

async function readPage(provider: JobSearchProvider, page: number, fetcher: typeof fetch, now: number): Promise<{ payload: unknown; next: boolean }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const endpoint = new URL(PROVIDERS[provider].endpoint);
    if (provider === 'arbeitnow' && page > 1) endpoint.searchParams.set('page', String(page));
    const response = await fetcher(endpoint.toString(), { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': 'CareerStack/0.7.0 public job search' }, redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new ProviderReadError(`SOURCE_HTTP_${response.status}`, parseRetryAfter(response.headers.get('retry-after'), now));
    let data: unknown;
    try { data = JSON.parse(await readBounded(response)); } catch (error) { if (error instanceof ProviderReadError) throw error; throw new ProviderReadError(error instanceof Error && error.message === 'SOURCE_RESPONSE_TOO_LARGE' ? error.message : 'SOURCE_INVALID_RESPONSE'); }
    const root = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const rows = provider === 'remotive' ? root.jobs : root.data;
    if (!Array.isArray(rows)) throw new ProviderReadError('SOURCE_INVALID_RESPONSE');
    const links = root.links && typeof root.links === 'object' ? root.links as Record<string, unknown> : {};
    return { payload: data, next: provider === 'arbeitnow' && typeof links.next === 'string' && Boolean(links.next) };
  } catch (error) {
    if (error instanceof ProviderReadError) throw error;
    throw new ProviderReadError(error instanceof Error && error.name === 'AbortError' ? 'SOURCE_TIMEOUT' : 'SOURCE_UNAVAILABLE');
  } finally { clearTimeout(timeout); }
}

/** Paginates only by constructing the fixed documented endpoint URL; never follows an API-provided link. */
export async function readPublicFeed(provider: JobSearchProvider, fetcher: typeof fetch = fetch, now = Date.now()): Promise<ProviderFeed> {
  const jobs: PublicJob[] = []; let page = 1; let hasNext: boolean;
  do {
    const result = await readPage(provider, page, fetcher, now);
    jobs.push(...normalizePublicJobs(provider, result.payload));
    hasNext = result.next;
    page++;
  } while (provider === 'arbeitnow' && hasNext && page <= MAX_ARBEITNOW_PAGES);
  return { jobs, coverage: hasNext ? 'BOUNDED' : 'COMPLETE' };
}

export async function readPublicJobs(provider: JobSearchProvider, fetcher: typeof fetch = fetch, now = Date.now()): Promise<PublicJob[]> {
  return (await readPublicFeed(provider, fetcher, now)).jobs;
}
