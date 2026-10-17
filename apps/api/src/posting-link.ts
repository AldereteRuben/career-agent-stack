import type { ProviderId } from './types.js';

/** A job posting on one of the public boards the app can read, taken from a link a person pasted. */
export type PostingRef = { provider: ProviderId; region: string; tenant: string; id: string };

/**
 * Hosts of the public pages whose links are recognised, and the region each one belongs to. A link on any other host
 * is not recognised, so it never causes a request (issue #47). Greenhouse's EU boards are left out because its API
 * documents no EU read host (see `docs/operations/source-validation.md`).
 */
const pageHosts: Record<string, { provider: ProviderId; region: string }> = {
  'boards.greenhouse.io': { provider: 'greenhouse', region: 'global' },
  'job-boards.greenhouse.io': { provider: 'greenhouse', region: 'global' },
  'jobs.lever.co': { provider: 'lever', region: 'global' },
  'jobs.eu.lever.co': { provider: 'lever', region: 'eu' },
  'jobs.ashbyhq.com': { provider: 'ashby', region: 'global' },
};

const tenantPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
const idPatterns: Record<ProviderId, RegExp> = {
  greenhouse: /^[0-9]{1,18}$/,
  lever: /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/,
  ashby: /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/,
};
/** Trailing path words that still point at the same posting (the application form of the page). */
const trailingWords = new Set(['apply', 'application']);

/**
 * Recognises a posting link of Greenhouse, Lever (global and EU) or Ashby. Returns null for anything else, including
 * other protocols, ports, credentials, unknown hosts, board pages without a posting and malformed identifiers. It does
 * no network access.
 */
export function parsePostingUrl(input: string): PostingRef | null {
  if (typeof input !== 'string' || input.length > 2048) return null;
  let url: URL;
  try { url = new URL(input.trim()); } catch { return null; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  const host = Object.hasOwn(pageHosts, url.hostname.toLowerCase()) ? pageHosts[url.hostname.toLowerCase()] : undefined;
  if (!host) return null;
  let segments: string[];
  try { segments = url.pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment)); } catch { return null; }

  let tenant: string | undefined; let id: string | undefined;
  if (host.provider === 'greenhouse') {
    // /{board}/jobs/{id}
    if (segments.length !== 3 || segments[1] !== 'jobs') return null;
    [tenant, , id] = segments;
  } else {
    // /{site}/{id} with an optional /apply or /application
    if (segments.length === 3 && trailingWords.has(segments[2]!.toLowerCase())) segments = segments.slice(0, 2);
    if (segments.length !== 2) return null;
    [tenant, id] = segments;
  }
  if (!tenant || !id || !tenantPattern.test(tenant) || !idPatterns[host.provider].test(id)) return null;
  return { provider: host.provider, region: host.region, tenant, id };
}

/** What the job form is pre-filled with. Nothing is saved: the person reviews it and saves it themselves. */
export type PostingPrefill = {
  provider: ProviderId; region: string; tenant: string; externalId: string;
  title: string; company: string;
  /** False when the company is only the board's name in the URL, written as a name; the person should check it. */
  companyConfirmed: boolean;
  location: string | null; description: string | null; jobUrl: string; applyUrl: string | null;
};

const guessCompany = (tenant: string) => tenant.replace(/[._-]+/g, ' ').trim().split(/\s+/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ').slice(0, 200);

export function postingPrefill(ref: PostingRef, job: { externalId: string; title: string; location: string | null; description: string | null; jobUrl: string; applyUrl: string | null; raw: Record<string, unknown> }): PostingPrefill {
  // Greenhouse names the company in the posting; Lever and Ashby do not, so the board name in the URL stands in for it.
  const named = typeof job.raw.company_name === 'string' ? job.raw.company_name.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  return {
    provider: ref.provider, region: ref.region, tenant: ref.tenant, externalId: job.externalId, title: job.title,
    company: named || guessCompany(ref.tenant), companyConfirmed: Boolean(named),
    // The job form accepts at most 50,000 characters of description, so a longer one is cut here instead of failing on save.
    location: job.location, description: job.description ? Array.from(job.description).slice(0, 50_000).join('') : null, jobUrl: job.jobUrl, applyUrl: job.applyUrl,
  };
}
