import { plainDescription, ProviderReadError, parseRetryAfter, MAX_RESPONSE_BYTES, type PublicJob } from './job-search-sources.js';

const ENDPOINT = 'https://himalayas.app/jobs/api/search';
const MAX_PAGES = 3;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 8_000;

export type HimalayasSearchCriteria = { role: string | null; company: string | null; location: string | null };
export type HimalayasSearchOptions = { fetch?: typeof fetch; maxPages?: number; timeoutMs?: number };
export type HimalayasSearchResult = { jobs: PublicJob[]; coverage: 'COMPLETE' | 'BOUNDED' | 'PARTIAL'; requests: number; sourceUpdatedAt?: string; retryAt?: number };

type HimalayasJob = Record<string, unknown>;
type HimalayasPage = { jobs: HimalayasJob[]; updatedAt: number; totalCount: number; limit: number };

const clean = (value: string | null): string | null => {
  const result = value?.trim();
  return result ? result.slice(0, 200) : null;
};

function validTimestamp(value: unknown, futureToleranceMs = 24 * 60 * 60 * 1000): string | null {
  const earliest = Date.UTC(2000, 0, 1);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < earliest || value > Date.now() + futureToleranceMs) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

const ISO_COUNTRY_CODES = new Set(`AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(/\s+/));
const COUNTRY_ALIASES: Record<string, string> = {
  'united states': 'US', 'united states of america': 'US', usa: 'US', 'u.s.': 'US', 'u.s.a.': 'US',
  'united kingdom': 'GB', uk: 'GB', britain: 'GB', 'great britain': 'GB',
  spain: 'ES', espana: 'ES', france: 'FR', germany: 'DE', deutschland: 'DE', italy: 'IT', italia: 'IT',
  portugal: 'PT', netherlands: 'NL', holland: 'NL', belgium: 'BE', switzerland: 'CH', austria: 'AT',
  ireland: 'IE', poland: 'PL', sweden: 'SE', norway: 'NO', denmark: 'DK', finland: 'FI', iceland: 'IS',
  greece: 'GR', cyprus: 'CY', romania: 'RO', bulgaria: 'BG', croatia: 'HR', slovenia: 'SI', slovakia: 'SK',
  hungary: 'HU', ukraine: 'UA', estonia: 'EE', latvia: 'LV', lithuania: 'LT', luxembourg: 'LU', malta: 'MT',
  canada: 'CA', mexico: 'MX', brazil: 'BR', argentina: 'AR', chile: 'CL', colombia: 'CO', peru: 'PE',
  australia: 'AU', 'new zealand': 'NZ', japan: 'JP', china: 'CN', india: 'IN', singapore: 'SG',
  'south korea': 'KR', korea: 'KR', israel: 'IL', 'south africa': 'ZA', nigeria: 'NG', kenya: 'KE',
  'united arab emirates': 'AE', uae: 'AE', turkey: 'TR', turkiye: 'TR', thailand: 'TH', indonesia: 'ID',
  philippines: 'PH', malaysia: 'MY', taiwan: 'TW', pakistan: 'PK', bangladesh: 'BD', egypt: 'EG', morocco: 'MA',
};

export function normalizeHimalayasCountry(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
  const alias = COUNTRY_ALIASES[normalized];
  if (alias) return alias;
  const code = normalized.toUpperCase();
  return /^[A-Z]{2}$/.test(code) && ISO_COUNTRY_CODES.has(code) ? code : null;
}

function requiredText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parsePage(payload: unknown): HimalayasPage {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ProviderReadError('SOURCE_INVALID_RESPONSE');
  const root = payload as Record<string, unknown>;
  if (!Array.isArray(root.jobs) || !Number.isSafeInteger(root.totalCount) || (root.totalCount as number) < 0 ||
      !Number.isSafeInteger(root.limit) || (root.limit as number) < 1 || (root.limit as number) > 100 ||
      typeof root.updatedAt !== 'number' || !Number.isSafeInteger(root.updatedAt) || !validTimestamp(root.updatedAt)) {
    throw new ProviderReadError('SOURCE_INVALID_RESPONSE');
  }
  return { jobs: root.jobs as HimalayasJob[], updatedAt: root.updatedAt, totalCount: root.totalCount as number, limit: root.limit as number };
}

function isPublicWebHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') ||
      host.endsWith('.test') || host.endsWith('.invalid') || host.endsWith('.example') || host.endsWith('.onion') ||
      !host.includes('.') || host.split('.').some((label) => !label || label.startsWith('-') || label.endsWith('-'))) return false;
  // Reject IP literals rather than risking loopback, private, link-local, or rebinding targets.
  if (/^[\d.]+$/.test(host) || host.startsWith('[') || host.includes(':')) return false;
  return true;
}

function safeApplicationUrl(value: unknown): string | null {
  if (!requiredText(value) || value.length > 2048) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !isPublicWebHost(parsed.hostname)) return null;
    // Keep the exact source URL (including its query string) for the user-facing destination.
    return value.trim();
  } catch { return null; }
}

function normalizeJob(job: HimalayasJob): PublicJob {
  const title = requiredText(job.title) ? job.title.trim().slice(0, 300) : null;
  const company = requiredText(job.companyName) ? job.companyName.trim().slice(0, 200) : null;
  const url = safeApplicationUrl(job.applicationLink);
  if (!title || !company || !url || !requiredText(job.guid) || job.guid.length > 300 || typeof job.pubDate !== 'number') {
    throw new ProviderReadError('SOURCE_INVALID_RESPONSE');
  }
  const restrictions = job.locationRestrictions;
  if (!Array.isArray(restrictions) || restrictions.some((country) => !country || typeof country !== 'object' || Array.isArray(country) ||
      !requiredText((country as Record<string, unknown>).alpha2))) throw new ProviderReadError('SOURCE_INVALID_RESPONSE');
  const countries = restrictions.map((country) => ((country as Record<string, unknown>).alpha2 as string).trim().toUpperCase());
  if (countries.some((country) => !/^[A-Z]{2}$/.test(country))) throw new ProviderReadError('SOURCE_INVALID_RESPONSE');
  const raw: Record<string, unknown> = { ...job };
  const description = plainDescription(job.description ?? job.excerpt);
  if (description) raw.description = description;
  raw.__careerStackCountries = countries;
  raw.__careerStackWorldwide = countries.length === 0;
  raw.__careerStackSource = 'himalayas';
  raw.__careerStackSourceUrl = 'https://himalayas.app';
  return {
    externalId: job.guid,
    title,
    company,
    location: countries.length ? countries.join(', ') : 'Worldwide',
    workMode: 'remote',
    url,
    postedAt: typeof job.pubDate === 'number' ? validTimestamp(job.pubDate) : null,
    description,
    raw,
  };
}

async function readResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (!contentType || !(contentType === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/.test(contentType))) {
    throw new ProviderReadError('SOURCE_INVALID_RESPONSE');
  }
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) throw new ProviderReadError('SOURCE_RESPONSE_TOO_LARGE');
  if (!response.body) throw new ProviderReadError('SOURCE_INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProviderReadError('SOURCE_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new ProviderReadError('SOURCE_INVALID_RESPONSE'); }
}

/** Read a targeted Himalayas search; only fixed-host, bounded page requests are made. */
export async function readHimalayasSearch(
  criteria: HimalayasSearchCriteria,
  options: HimalayasSearchOptions = {},
): Promise<HimalayasSearchResult> {
  const fetcher = options.fetch ?? fetch;
  const configuredPages = Number.isFinite(options.maxPages) ? Math.floor(options.maxPages as number) : MAX_PAGES;
  const maxPages = Math.min(MAX_PAGES, Math.max(1, configuredPages));
  const configuredTimeout = Number.isFinite(options.timeoutMs) ? Math.floor(options.timeoutMs as number) : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, configuredTimeout));
  const query = [clean(criteria.role), clean(criteria.company)].filter((part): part is string => Boolean(part)).join(' ');
  const country = normalizeHimalayasCountry(criteria.location);
  const jobs: PublicJob[] = [];
  let requests = 0;
  let sourceUpdatedAt: string | undefined;
  let totalPages = 1;
  let partial = false;
  let retryAt: number | undefined;

  for (let page = 1; page <= Math.min(maxPages, totalPages); page++) {
    const url = new URL(ENDPOINT);
    if (query) url.searchParams.set('q', query);
    if (country) url.searchParams.set('country', country);
    url.searchParams.set('page', String(page));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      requests++;
      const response = await fetcher(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.url) {
        const finalUrl = new URL(response.url);
        if (finalUrl.origin !== new URL(ENDPOINT).origin || finalUrl.pathname !== new URL(ENDPOINT).pathname || finalUrl.protocol !== 'https:') {
          throw new ProviderReadError('SOURCE_UNSAFE_REDIRECT');
        }
      }
      if (!response.ok) throw new ProviderReadError(`SOURCE_HTTP_${response.status}`, parseRetryAfter(response.headers.get('retry-after')));
      const result = parsePage(await readResponse(response));
      const updatedAt = validTimestamp(result.updatedAt);
      if (!updatedAt) throw new ProviderReadError('SOURCE_INVALID_RESPONSE');
      if (sourceUpdatedAt && sourceUpdatedAt !== updatedAt) throw new ProviderReadError('SOURCE_INVALID_RESPONSE');
      sourceUpdatedAt = updatedAt;
      totalPages = Math.ceil(result.totalCount / result.limit);
      for (const value of result.jobs) {
        try {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderReadError('SOURCE_INVALID_RESPONSE');
          jobs.push(normalizeJob(value as HimalayasJob));
        } catch (error) {
          if (!(error instanceof ProviderReadError)) throw error;
          partial = true;
        }
      }
    } catch (error) {
      const readError = error instanceof ProviderReadError ? error : new ProviderReadError(error instanceof Error && error.name === 'AbortError' ? 'SOURCE_TIMEOUT' : 'SOURCE_UNAVAILABLE');
      if (requests > 1) {
        partial = true;
        if (readError.code === 'SOURCE_HTTP_429' && readError.retryAt > 0) retryAt = readError.retryAt;
        break;
      }
      throw readError;
    } finally { clearTimeout(timeout); }
  }

  return {
    jobs,
    coverage: partial ? 'PARTIAL' : totalPages > requests ? 'BOUNDED' : 'COMPLETE',
    requests,
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    ...(retryAt ? { retryAt } : {}),
  };
}
