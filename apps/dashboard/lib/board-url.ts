export type JobBoardSource = {
  provider: 'greenhouse' | 'lever' | 'ashby';
  companyKey: string;
  region: 'global' | 'eu';
};

const keyPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;

export function parseJobBoardUrl(value: string): JobBoardSource | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  let companyKey: string;
  try { companyKey = decodeURIComponent(url.pathname.split('/').filter(Boolean)[0] ?? ''); } catch { return null; }
  if (!keyPattern.test(companyKey)) return null;
  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') return { provider: 'greenhouse', companyKey, region: 'global' };
  if (host === 'jobs.lever.co') return { provider: 'lever', companyKey, region: 'global' };
  if (host === 'jobs.eu.lever.co') return { provider: 'lever', companyKey, region: 'eu' };
  if (host === 'jobs.ashbyhq.com') return { provider: 'ashby', companyKey, region: 'global' };
  return null;
}

export function getOfficialDomain(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return null; }
}
