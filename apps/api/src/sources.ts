import { z } from 'zod';
import type { ProviderId } from './types.js';

export type ProviderJob = { externalId: string; title: string; location: string | null; description: string | null; jobUrl: string; applyUrl: string | null; postedAt: string | null; updatedAt: string | null; raw: Record<string, unknown> };
export type BoardForSource = { provider: ProviderId; tenant: string; region: string };
/** Test seam and limits; production callers pass nothing. */
export type SourceReadOptions = { fetch?: typeof fetch; timeoutMs?: number; maxBytes?: number };
/** What a read produced, including jobs dropped by per-job validation. Used by the validation CLI. */
export type BoardReadReport = { jobs: ProviderJob[]; host: string; url: string; bytes: number; received: number; unlisted: number; skipped: number; skipReasons: Record<string, number> };

const tenantPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
// Real public feeds with content=true reach several megabytes (e.g. 3.3 MB for a 210-job Greenhouse board), so the cap
// leaves headroom while still bounding memory. The body is read as a stream and abandoned once it passes the cap.
const defaultMaxBytes = 16 * 1024 * 1024;
const defaultTimeoutMs = 20_000;
const maxJobs = 10_000;
const userAgent = 'CareerAgentStack/0.2 (read-only discovery)';

/** Documented public read hosts per provider and region. Anything else is rejected before a request is made. */
const providerHosts: Record<ProviderId, Partial<Record<string, string>>> = {
  greenhouse: { global: 'boards-api.greenhouse.io' },
  lever: { global: 'api.lever.co', eu: 'api.eu.lever.co' },
  ashby: { global: 'api.ashbyhq.com' },
};

export function sourceHost(provider: string, region: string): string {
  const hosts = Object.hasOwn(providerHosts, provider) ? providerHosts[provider as ProviderId] : undefined;
  if (!hosts) throw new Error('SOURCE_PROVIDER_UNSUPPORTED');
  const key = region.trim().toLowerCase();
  const host = Object.hasOwn(hosts, key) ? hosts[key] : undefined;
  if (!host) throw new Error('BOARD_REGION_UNSUPPORTED');
  return host;
}

export function sourceUrl(board: BoardForSource): URL {
  if (!tenantPattern.test(board.tenant)) throw new Error('BOARD_TENANT_INVALID');
  const host = sourceHost(board.provider, board.region);
  const tenant = encodeURIComponent(board.tenant);
  if (board.provider === 'greenhouse') return new URL(`https://${host}/v1/boards/${tenant}/jobs?content=true`);
  if (board.provider === 'lever') return new URL(`https://${host}/v0/postings/${tenant}?mode=json`);
  return new URL(`https://${host}/posting-api/job-board/${tenant}?includeCompensation=true`);
}

async function readBounded(body: ReadableStream<Uint8Array> | null, maxBytes: number) {
  if (!body) return { text: '', bytes: 0 };
  const reader = body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel().catch(() => undefined); throw new Error('SOURCE_RESPONSE_TOO_LARGE'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return { text: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), bytes };
}

function networkError(error: unknown): Error {
  if (error instanceof Error && /^SOURCE_/.test(error.message)) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return new Error('SOURCE_TIMEOUT');
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  if (/redirect/i.test(cause) || (error instanceof Error && /redirect/i.test(error.message))) return new Error('SOURCE_REDIRECT_REJECTED');
  if (error instanceof TypeError && /decode|encoded data/i.test(error.message)) return new Error('SOURCE_ENCODING_INVALID');
  return new Error('SOURCE_NETWORK_ERROR');
}

/** Retry-After is preserved for the durable discovery schedule (seconds or HTTP date). */
export class SourceHttpError extends Error {
  readonly retryAfter: number;
  constructor(status: number, header: string | null, now = Date.now()) {
    super(`SOURCE_HTTP_${status}`);
    const value = header?.trim() ?? '';
    const timestamp = /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value);
    this.retryAfter = Number.isFinite(timestamp) && timestamp > now && timestamp < 8_640_000_000_000_000 ? timestamp : 0;
  }
}

async function readJson(url: URL, allowedHost: string, options: SourceReadOptions) {
  if (url.protocol !== 'https:' || url.hostname !== allowedHost || url.port || url.username || url.password) throw new Error('SOURCE_URL_REJECTED');
  const maxBytes = options.maxBytes ?? defaultMaxBytes;
  let text: string; let bytes: number;
  try {
    const response = await (options.fetch ?? fetch)(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? defaultTimeoutMs), headers: { Accept: 'application/json', 'User-Agent': userAgent } });
    if (response.status >= 300 && response.status < 400) throw new Error('SOURCE_REDIRECT_REJECTED');
    if (response.redirected || (response.url && new URL(response.url).hostname !== allowedHost)) throw new Error('SOURCE_REDIRECT_REJECTED');
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new SourceHttpError(response.status, response.headers.get('retry-after')); }
    const type = response.headers.get('content-type');
    if (type && !/\bjson\b/i.test(type)) { await response.body?.cancel().catch(() => undefined); throw new Error('SOURCE_CONTENT_TYPE_INVALID'); }
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel().catch(() => undefined); throw new Error('SOURCE_RESPONSE_TOO_LARGE'); }
    ({ text, bytes } = await readBounded(response.body, maxBytes));
  } catch (error) { throw networkError(error); }
  try { return { payload: JSON.parse(text) as unknown, bytes }; } catch { throw new Error('SOURCE_JSON_INVALID'); }
}

// ---- Plain-text conversion -------------------------------------------------------------------------------------------

const namedEntities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', shy: '' };
const codePoint = (value: number) => Number.isInteger(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '';
/** Decodes one level of HTML entities; unknown named entities are left as written. */
export function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});/gi, (match, entity: string) => {
    if (entity[0] === '#') return codePoint(entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10));
    return namedEntities[entity.toLowerCase()] ?? match;
  });
}

const blockTags = /<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|blockquote|pre|hr)\b[^>]*>/gi;
/** Converts an HTML fragment to readable plain text, keeping paragraph and list breaks. */
export function htmlToText(html: string) {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/li\s*>/gi, '')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(blockTags, '\n')
    .replace(/<[^>]*>/g, '');
  return plain(decodeEntities(text));
}
/** Normalises provider plain text: unifies newlines, collapses runs of spaces and blank lines. */
function plain(text: string) {
  return text.replace(/\r\n?/g, '\n').replace(/[\u00a0\t\f\v ]+/g, ' ').split('\n').map((line) => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
const nonEmpty = (value: string | null | undefined) => value && value.length ? value : null;
const joinSections = (...parts: Array<string | null>) => nonEmpty(parts.filter((part): part is string => !!part).join('\n\n'));
/** Truncates by code point so a cut never leaves a lone surrogate; Postgres varchar(n) also counts code points. */
const clip = (text: string, max: number) => text.length <= max ? text : Array.from(text).slice(0, max).join('');
const oneLine = (value: unknown, max: number) => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? clip(text, max) : null;
};

// ---- Field coercion -------------------------------------------------------------------------------------------------

const minTime = Date.UTC(1995, 0, 1);
const maxFutureMs = 366 * 86_400_000;
const isoLike = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;
/** Accepts ISO-8601 strings and epoch milliseconds inside a plausible window; anything else becomes null. */
export function sourceDate(value: unknown, now = Date.now()): string | null {
  let time: number;
  if (typeof value === 'number') time = value;
  else if (typeof value === 'string' && isoLike.test(value.trim())) time = Date.parse(value.trim());
  else return null;
  return Number.isFinite(time) && time >= minTime && time <= now + maxFutureMs ? new Date(time).toISOString() : null;
}

/** Absolute https URL without credentials or fragment, else null. */
export function sourceUrlField(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname.includes('.')) return null;
    parsed.hash = '';
    return parsed.toString();
  } catch { return null; }
}

// ASCII only and at most 300 characters, matching job_occurrences.external_job_id varchar(300).
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/;
function externalId(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return idPattern.test(id) ? id : null;
}
/** Last path segment of a hosted job URL, used when a provider omits the id field. */
function idFromUrl(jobUrl: string | null): string | null {
  if (!jobUrl) return null;
  const segment = new URL(jobUrl).pathname.split('/').filter(Boolean).at(-1);
  if (!segment) return null;
  try { return externalId(decodeURIComponent(segment)); } catch { return null; } // malformed %-escapes skip only this job
}

// ---- Provider schemas -----------------------------------------------------------------------------------------------

// Output caps follow packages/db/src/schema.ts: jobs.title / jobs.location varchar(300), external_job_id varchar(300).
const record = z.record(z.string(), z.unknown());
const greenhouseFeed = z.object({ jobs: z.array(record).max(maxJobs) }).passthrough();
const leverFeed = z.array(record).max(maxJobs);
const ashbyFeed = z.object({ jobs: z.array(record).max(maxJobs) }).passthrough();

const greenhouseJob = z.object({ id: z.union([z.number(), z.string()]), title: z.string(), absolute_url: z.string(), location: z.object({ name: z.string().nullish() }).passthrough().nullish(), content: z.string().nullish(), updated_at: z.unknown().optional(), first_published: z.unknown().optional() }).passthrough();
const leverList = z.object({ text: z.string().nullish(), content: z.string().nullish() }).passthrough();
const leverJob = z.object({ id: z.string(), text: z.string(), hostedUrl: z.string(), applyUrl: z.string().nullish(), categories: z.object({ location: z.string().nullish(), allLocations: z.array(z.string()).nullish() }).passthrough().nullish(), description: z.string().nullish(), descriptionPlain: z.string().nullish(), lists: z.array(leverList).nullish(), additional: z.string().nullish(), additionalPlain: z.string().nullish(), createdAt: z.unknown().optional(), updatedAt: z.unknown().optional() }).passthrough();
const ashbyJob = z.object({ id: z.string().nullish(), title: z.string(), jobUrl: z.string(), applyUrl: z.string().nullish(), location: z.string().nullish(), isListed: z.boolean().nullish(), descriptionHtml: z.string().nullish(), descriptionPlain: z.string().nullish(), publishedAt: z.unknown().optional(), updatedAt: z.unknown().optional() }).passthrough();

type Mapped = ProviderJob | { skip: string };

function finish(raw: Record<string, unknown>, fields: { id: string | null; title: unknown; location: string | null; description: string | null; jobUrl: string | null; applyUrl: string | null; postedAt: string | null; updatedAt: string | null }): Mapped {
  const title = oneLine(fields.title, 300);
  if (!title) return { skip: 'TITLE_MISSING' };
  if (!fields.jobUrl) return { skip: 'JOB_URL_INVALID' };
  if (!fields.id) return { skip: 'ID_INVALID' };
  return { externalId: fields.id, title, location: oneLine(fields.location, 300), description: fields.description ? clip(fields.description, 200_000) : null, jobUrl: fields.jobUrl, applyUrl: fields.applyUrl, postedAt: fields.postedAt, updatedAt: fields.updatedAt, raw };
}

function mapGreenhouse(raw: Record<string, unknown>): Mapped {
  const parsed = greenhouseJob.safeParse(raw); if (!parsed.success) return { skip: 'SCHEMA_INVALID' };
  const job = parsed.data; const jobUrl = sourceUrlField(job.absolute_url);
  // Greenhouse entity-encodes the HTML in `content` (&lt;p&gt;…), so decode once to HTML before converting to text.
  const description = job.content ? nonEmpty(htmlToText(decodeEntities(job.content))) : null;
  return finish(raw, { id: externalId(job.id), title: decodeEntities(job.title), location: job.location?.name ?? null, description, jobUrl, applyUrl: jobUrl, postedAt: sourceDate(job.first_published), updatedAt: sourceDate(job.updated_at) });
}

function mapLever(raw: Record<string, unknown>): Mapped {
  const parsed = leverJob.safeParse(raw); if (!parsed.success) return { skip: 'SCHEMA_INVALID' };
  const job = parsed.data;
  const intro = job.descriptionPlain != null ? nonEmpty(plain(job.descriptionPlain)) : job.description ? nonEmpty(htmlToText(job.description)) : null;
  // Lever keeps requirements and responsibilities in `lists`, whose `content` is an HTML list body without the <ul>.
  const lists = (job.lists ?? []).map((list) => joinSections(list.text ? nonEmpty(plain(list.text)) : null, list.content ? nonEmpty(htmlToText(list.content)) : null));
  const closing = job.additionalPlain != null ? nonEmpty(plain(job.additionalPlain)) : job.additional ? nonEmpty(htmlToText(job.additional)) : null;
  const locations = job.categories?.location ?? (job.categories?.allLocations?.length ? job.categories.allLocations.join(' / ') : null);
  const jobUrl = sourceUrlField(job.hostedUrl);
  return finish(raw, { id: externalId(job.id), title: job.text, location: locations, description: joinSections(intro, ...lists, closing), jobUrl, applyUrl: sourceUrlField(job.applyUrl), postedAt: sourceDate(job.createdAt), updatedAt: sourceDate(job.updatedAt) });
}

function mapAshby(raw: Record<string, unknown>): Mapped {
  const parsed = ashbyJob.safeParse(raw); if (!parsed.success) return { skip: 'SCHEMA_INVALID' };
  const job = parsed.data;
  // As in v0.1, only postings explicitly marked listed are surfaced.
  if (job.isListed !== true) return { skip: 'UNLISTED' };
  const jobUrl = sourceUrlField(job.jobUrl);
  const description = job.descriptionPlain != null ? nonEmpty(plain(job.descriptionPlain)) : job.descriptionHtml ? nonEmpty(htmlToText(job.descriptionHtml)) : null;
  return finish(raw, { id: externalId(job.id) ?? idFromUrl(jobUrl), title: job.title, location: job.location ?? null, description, jobUrl, applyUrl: sourceUrlField(job.applyUrl), postedAt: sourceDate(job.publishedAt), updatedAt: sourceDate(job.updatedAt) });
}

/** Reads a board and reports what was dropped. Throws SOURCE_* / BOARD_* error codes on whole-feed failures. */
export async function readBoardWithReport(board: BoardForSource, options: SourceReadOptions = {}): Promise<BoardReadReport> {
  const url = sourceUrl(board); const host = url.hostname;
  const { payload, bytes } = await readJson(url, host, options);
  let items: Record<string, unknown>[]; let mapper: (raw: Record<string, unknown>) => Mapped;
  if (board.provider === 'greenhouse') { const feed = greenhouseFeed.safeParse(payload); if (!feed.success) throw new Error('SOURCE_SCHEMA_INVALID'); items = feed.data.jobs; mapper = mapGreenhouse; }
  else if (board.provider === 'lever') { const feed = leverFeed.safeParse(payload); if (!feed.success) throw new Error('SOURCE_SCHEMA_INVALID'); items = feed.data; mapper = mapLever; }
  else { const feed = ashbyFeed.safeParse(payload); if (!feed.success) throw new Error('SOURCE_SCHEMA_INVALID'); items = feed.data.jobs; mapper = mapAshby; }

  const jobs: ProviderJob[] = []; const skipReasons: Record<string, number> = {}; const seen = new Set<string>(); let unlisted = 0;
  for (const item of items) {
    let mapped = mapper(item);
    if (!('skip' in mapped) && seen.has(mapped.externalId)) mapped = { skip: 'DUPLICATE_ID' };
    if ('skip' in mapped) { if (mapped.skip === 'UNLISTED') unlisted++; else skipReasons[mapped.skip] = (skipReasons[mapped.skip] ?? 0) + 1; continue; }
    seen.add(mapped.externalId); jobs.push(mapped);
  }
  const skipped = Object.values(skipReasons).reduce((sum, count) => sum + count, 0);
  // A feed whose every job is malformed is a contract change, not an empty board.
  if (skipped > 0 && jobs.length === 0) throw new Error('SOURCE_SCHEMA_INVALID');
  return { jobs, host, url: url.toString(), bytes, received: items.length, unlisted, skipped, skipReasons };
}

export async function readBoard(board: BoardForSource, options: SourceReadOptions = {}): Promise<ProviderJob[]> {
  return (await readBoardWithReport(board, options)).jobs;
}

export function normalizeJobUrl(input: string) {
  const parsed = new URL(input);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('JOB_URL_INVALID');
  parsed.hash = '';
  return parsed.toString();
}
