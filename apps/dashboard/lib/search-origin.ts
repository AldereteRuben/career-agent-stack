/** Only internal listing routes are allowed as the return destination. */
export function searchOrigin(value: string | null | undefined): string {
  if (!value) return '';
  try {
    const url = new URL(value, 'http://career.local');
    if (url.origin !== 'http://career.local' || !value.startsWith('/') || !['/jobs', '/searches'].includes(url.pathname)) return '';
    return `${url.pathname}${url.search}`;
  } catch { return ''; }
}

export function withSearchOrigin(href: string, origin?: string | null): string {
  const safe = searchOrigin(origin);
  if (!safe) return href;
  const url = new URL(href, 'http://career.local');
  url.searchParams.set('returnTo', safe);
  return `${url.pathname}${url.search}${url.hash}`;
}
