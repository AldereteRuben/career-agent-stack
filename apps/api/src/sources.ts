import { z } from 'zod';
import type { ProviderId } from './types.js';

export type ProviderJob = { externalId: string; title: string; location: string | null; description: string | null; jobUrl: string; applyUrl: string | null; postedAt: string | null; updatedAt: string | null; raw: Record<string, unknown> };
export type BoardForSource = { provider: ProviderId; tenant: string; region: string };
const tenantPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
const maxBytes = 2_000_000;

async function readJson(url: URL, allowedHost: string) {
  if (url.protocol !== 'https:' || url.hostname !== allowedHost || url.username || url.password) throw new Error('SOURCE_URL_REJECTED');
  const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json', 'User-Agent': 'CareerAgentStack/0.1 (read-only discovery)' } });
  if (!response.ok) throw new Error(`SOURCE_HTTP_${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new Error('SOURCE_RESPONSE_TOO_LARGE');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('SOURCE_RESPONSE_TOO_LARGE');
  return JSON.parse(text) as unknown;
}

const htmlText = (html: unknown) => typeof html === 'string' ? html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/\s+/g, ' ').trim() : null;
const url = (value: unknown) => typeof value === 'string' && /^https:\/\//i.test(value) ? value : null;
const date = (value: unknown) => { const d = typeof value === 'number' ? new Date(value) : typeof value === 'string' ? new Date(value) : null; return d && Number.isFinite(d.getTime()) ? d.toISOString() : null; };

export async function readBoard(board: BoardForSource): Promise<ProviderJob[]> {
  if (!tenantPattern.test(board.tenant)) throw new Error('BOARD_TENANT_INVALID');
  let payload: unknown;
  if (board.provider === 'greenhouse') {
    payload = await readJson(new URL(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.tenant)}/jobs?content=true`), 'boards-api.greenhouse.io');
    const parsed = z.object({ jobs: z.array(z.record(z.string(), z.unknown())) }).safeParse(payload);
    if (!parsed.success) throw new Error('SOURCE_SCHEMA_INVALID');
    return parsed.data.jobs.map((job) => ({ externalId: String(job.id), title: String(job.title ?? ''), location: typeof job.location === 'object' && job.location !== null && 'name' in job.location ? String((job.location as { name: unknown }).name) : null, description: htmlText(job.content), jobUrl: url(job.absolute_url) ?? '', applyUrl: url(job.absolute_url), postedAt: date(job.first_published), updatedAt: date(job.updated_at), raw: job }));
  }
  if (board.provider === 'lever') {
    const host = board.region.toLowerCase() === 'eu' ? 'api.eu.lever.co' : 'api.lever.co';
    payload = await readJson(new URL(`https://${host}/v0/postings/${encodeURIComponent(board.tenant)}?mode=json`), host);
    const parsed = z.array(z.record(z.string(), z.unknown())).safeParse(payload);
    if (!parsed.success) throw new Error('SOURCE_SCHEMA_INVALID');
    return parsed.data.map((job) => ({ externalId: String(job.id ?? ''), title: String(job.text ?? ''), location: typeof job.categories === 'object' && job.categories !== null && 'location' in job.categories ? String((job.categories as { location: unknown }).location ?? '') || null : null, description: htmlText(job.descriptionPlain ?? job.description), jobUrl: url(job.hostedUrl) ?? '', applyUrl: url(job.applyUrl), postedAt: date(job.createdAt), updatedAt: null, raw: job }));
  }
  if (board.region.toLowerCase() !== 'global') throw new Error('BOARD_REGION_UNSUPPORTED');
  payload = await readJson(new URL(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.tenant)}?includeCompensation=true`), 'api.ashbyhq.com');
  const parsed = z.object({ jobs: z.array(z.record(z.string(), z.unknown())) }).safeParse(payload);
  if (!parsed.success) throw new Error('SOURCE_SCHEMA_INVALID');
  return parsed.data.jobs.filter((job) => job.isListed === true).map((job) => ({ externalId: String(job.id ?? ''), title: String(job.title ?? ''), location: typeof job.location === 'string' ? job.location : null, description: htmlText(job.descriptionHtml ?? job.description), jobUrl: url(job.jobUrl) ?? '', applyUrl: url(job.applyUrl), postedAt: date(job.publishedAt), updatedAt: null, raw: job }));
}

export function normalizeJobUrl(input: string) {
  const parsed = new URL(input);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('JOB_URL_INVALID');
  parsed.hash = '';
  return parsed.toString();
}
