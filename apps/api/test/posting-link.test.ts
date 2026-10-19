import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clipUtf16, createPostingLookupHandleStore, parsePostingUrl, postingPrefill } from '../src/posting-link.js';
import { readPosting, type PostingFeedCache, type SourceReadOptions } from '../src/sources.js';

// All postings below are synthetic; none is a real company's data.
const leverId = '681fbc53-1e34-4a46-8677-3a78118674eb';
const ashbyId = '7458d4e9-da2e-47bd-98cb-adfda43d42b2';

type Call = { url: string; init: RequestInit | undefined };
function mockFetch(respond: (url: string) => Response) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => { const url = String(input instanceof Request ? input.url : input); calls.push({ url, init }); return respond(url); }) as typeof globalThis.fetch;
  return { calls, options: { fetch } satisfies SourceReadOptions };
}
const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: Error) => { assert.equal(error.message, code); return true; });

describe('parsePostingUrl', () => {
  it('recognises each provider, region and the application form of a posting', () => {
    assert.deepEqual(parsePostingUrl('https://boards.greenhouse.io/acme/jobs/8860302002'), { provider: 'greenhouse', region: 'global', tenant: 'acme', id: '8860302002' });
    assert.deepEqual(parsePostingUrl('https://job-boards.greenhouse.io/acme/jobs/8860302002?gh_src=x#app'), { provider: 'greenhouse', region: 'global', tenant: 'acme', id: '8860302002' });
    assert.deepEqual(parsePostingUrl(`https://jobs.lever.co/acme/${leverId}`), { provider: 'lever', region: 'global', tenant: 'acme', id: leverId });
    assert.deepEqual(parsePostingUrl(`https://jobs.eu.lever.co/acme/${leverId}/apply/`), { provider: 'lever', region: 'eu', tenant: 'acme', id: leverId });
    assert.deepEqual(parsePostingUrl(`  https://jobs.ashbyhq.com/acme/${ashbyId}/application `), { provider: 'ashby', region: 'global', tenant: 'acme', id: ashbyId });
  });

  it('does not recognise a link that could send the request somewhere else', () => {
    const rejected = [
      'http://boards.greenhouse.io/acme/jobs/1', 'https://boards.greenhouse.io:8443/acme/jobs/1', 'https://user:pass@boards.greenhouse.io/acme/jobs/1',
      'https://boards.greenhouse.io.evil.test/acme/jobs/1', 'https://evil.test/boards.greenhouse.io/acme/jobs/1', 'https://jobs.lever.co@evil.test/acme/' + leverId,
      'https://evilboards.greenhouse.io/acme/jobs/1', 'https://job-boards.eu.greenhouse.io/acme/jobs/1', 'https://api.lever.co/v0/postings/acme/' + leverId,
      'https://www.linkedin.com/jobs/view/123', 'ftp://jobs.lever.co/acme/' + leverId, 'javascript:alert(1)', 'not a url', '', 'https://169.254.169.254/latest/meta-data',
      'https://localhost/acme/jobs/1',
    ];
    for (const link of rejected) assert.equal(parsePostingUrl(link), null, link);
  });

  it('does not recognise board pages, missing or malformed identifiers and path tricks', () => {
    const rejected = [
      'https://boards.greenhouse.io/acme', 'https://boards.greenhouse.io/acme/jobs', 'https://boards.greenhouse.io/acme/jobs/abc', 'https://boards.greenhouse.io/acme/jobs/1/extra',
      'https://jobs.lever.co/acme', 'https://jobs.lever.co/acme/short', `https://jobs.lever.co/acme/${leverId}/other`, 'https://jobs.ashbyhq.com/acme', `https://jobs.ashbyhq.com/${ashbyId}`,
      `https://jobs.lever.co/ac%2Fme/${leverId}`, `https://jobs.lever.co/../${leverId}`, `https://jobs.lever.co/acme/${leverId}%2F..%2Fx`, `https://jobs.lever.co/%00/${leverId}`,
      `https://jobs.lever.co/acme/${'a'.repeat(100)}`, 'https://boards.greenhouse.io/acme/jobs/' + '1'.repeat(30), 'https://boards.greenhouse.io/acme/jobs/%E0%A4%A',
    ];
    for (const link of rejected) assert.equal(parsePostingUrl(link), null, link);
    assert.equal(parsePostingUrl(`https://jobs.lever.co/acme/${leverId}?${'x'.repeat(3000)}`), null, 'an overlong link');
  });
});

describe('posting lookup handles', () => {
  const ref = { provider: 'greenhouse' as const, region: 'global', tenant: 'fictional-board', id: '123456' };
  it('binds the source payload to one workspace, posting identity and canonical URL', () => {
    const store = createPostingLookupHandleStore<{ title: string }>();
    const token = store.issue('workspace-a', ref, 'https://job-boards.greenhouse.io/fictional-board/jobs/123456', { title: 'Synthetic role' });
    assert.match(token, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(store.get(token, 'workspace-a', ref, 'https://job-boards.greenhouse.io/fictional-board/jobs/123456'), { title: 'Synthetic role' });
    assert.equal(store.get(token, 'workspace-b', ref, 'https://job-boards.greenhouse.io/fictional-board/jobs/123456'), null);
    assert.equal(store.get(token, 'workspace-a', { ...ref, id: '654321' }, 'https://job-boards.greenhouse.io/fictional-board/jobs/123456'), null);
    assert.equal(store.get(token, 'workspace-a', ref, 'https://job-boards.greenhouse.io/fictional-board/jobs/654321'), null);
  });

  it('expires handles and bounds the number retained', () => {
    let now = 1000;
    const store = createPostingLookupHandleStore<string>({ ttlMs: 50, maxEntries: 1, now: () => now });
    const first = store.issue('workspace-a', ref, 'https://job-boards.greenhouse.io/fictional-board/jobs/123456', 'first');
    const second = store.issue('workspace-a', { ...ref, id: '123457' }, 'https://job-boards.greenhouse.io/fictional-board/jobs/123457', 'second');
    assert.equal(store.get(first, 'workspace-a', ref, 'https://job-boards.greenhouse.io/fictional-board/jobs/123456'), null, 'old entries are evicted at the cap');
    now += 50;
    assert.equal(store.get(second, 'workspace-a', { ...ref, id: '123457' }, 'https://job-boards.greenhouse.io/fictional-board/jobs/123457'), null, 'expired handles cannot be used');
  });

  it('rejects an oversized source payload instead of retaining it in memory', () => {
    const store = createPostingLookupHandleStore<string>({ maxEntryBytes: 3 });
    assert.equal(store.issue('workspace-a', ref, 'https://job-boards.greenhouse.io/fictional-board/jobs/123456', 'payload too large'), null);
  });
});

describe('readPosting', () => {
  const greenhouse = { id: 8860302002, title: 'Backend Engineer &amp; SRE', company_name: 'Acme Corp', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/8860302002', location: { name: 'Remote, Spain' }, content: '&lt;p&gt;Build things.&lt;/p&gt;', updated_at: '2026-10-01T10:00:00-04:00', first_published: '2026-09-01T10:00:00-04:00' };
  const lever = { id: leverId, text: 'Product Engineer', hostedUrl: `https://jobs.eu.lever.co/acme/${leverId}`, applyUrl: `https://jobs.eu.lever.co/acme/${leverId}/apply`, categories: { location: 'Berlin' }, descriptionPlain: 'Make products.', lists: [], createdAt: 1_760_000_000_000 };
  const ashbyFeed = { apiVersion: '1', jobs: [
    { id: 'aaaaaaaa-0000-0000-0000-000000000000', title: 'Other', jobUrl: 'https://jobs.ashbyhq.com/acme/aaaaaaaa-0000-0000-0000-000000000000', isListed: true, descriptionPlain: 'x' },
    { id: ashbyId, title: 'Engineering Manager', location: 'Remote - EU', jobUrl: `https://jobs.ashbyhq.com/acme/${ashbyId}`, applyUrl: `https://jobs.ashbyhq.com/acme/${ashbyId}/application`, isListed: true, descriptionPlain: 'Lead a team.' },
    { id: 'bbbbbbbb-0000-0000-0000-000000000000', title: 'Hidden', jobUrl: 'https://jobs.ashbyhq.com/acme/bbbbbbbb-0000-0000-0000-000000000000', isListed: false, descriptionPlain: 'y' },
  ] };

  it('reads one Greenhouse posting from its fixed API host and names the company', async () => {
    const { calls, options } = mockFetch(() => json(greenhouse));
    const ref = parsePostingUrl('https://boards.greenhouse.io/acme/jobs/8860302002')!;
    const job = await readPosting(ref, options);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/8860302002');
    assert.equal(calls[0]!.init?.redirect, 'error');
    assert.equal(job.title, 'Backend Engineer & SRE');
    const prefill = postingPrefill(ref, job);
    assert.deepEqual([prefill.company, prefill.companyConfirmed, prefill.location, prefill.description], ['Acme Corp', true, 'Remote, Spain', 'Build things.']);
    assert.equal(prefill.jobUrl, 'https://job-boards.greenhouse.io/acme/jobs/8860302002');
  });

  it('cuts a description longer than the job form accepts', async () => {
    const ref = parsePostingUrl('https://boards.greenhouse.io/acme/jobs/8860302002')!;
    const job = await readPosting(ref, mockFetch(() => json({ ...greenhouse, content: `&lt;p&gt;${'a'.repeat(60_000)}&lt;/p&gt;` })).options);
    assert.equal(postingPrefill(ref, job).description?.length, 50_000);
  });

  it('counts the limit in UTF-16 units like the form schema, so emoji never push a description over it', async () => {
    const ref = parsePostingUrl('https://boards.greenhouse.io/acme/jobs/8860302002')!;
    const job = await readPosting(ref, mockFetch(() => json({ ...greenhouse, content: `&lt;p&gt;${'😀'.repeat(60_000)}&lt;/p&gt;` })).options);
    const description = postingPrefill(ref, job).description!;
    assert.equal(description.length, 50_000, 'whole characters up to the limit, counted in UTF-16 units');
    assert.ok(description.isWellFormed(), 'no lone surrogate');
    assert.equal(clipUtf16('ab😀', 3), 'ab', 'a pair that would be cut in half is dropped');
    assert.equal(clipUtf16('ab😀', 4), 'ab😀');
    assert.equal(clipUtf16('short', 50_000), 'short');
  });

  it('reads one Lever posting, in the EU region too, and falls back to the board name for the company', async () => {
    const { calls, options } = mockFetch(() => json(lever));
    const ref = parsePostingUrl(`https://jobs.eu.lever.co/acme-labs/${leverId}`)!;
    const job = await readPosting(ref, options);
    assert.equal(calls[0]!.url, `https://api.eu.lever.co/v0/postings/acme-labs/${leverId}?mode=json`);
    const prefill = postingPrefill(ref, job);
    assert.deepEqual([prefill.company, prefill.companyConfirmed, prefill.title, prefill.location], ['Acme Labs', false, 'Product Engineer', 'Berlin']);
  });

  it('reads the Ashby board feed and keeps only the matching posting', async () => {
    const { calls, options } = mockFetch(() => json(ashbyFeed));
    const job = await readPosting(parsePostingUrl(`https://jobs.ashbyhq.com/acme/${ashbyId}`)!, options);
    assert.equal(calls.length, 1);
    assert.equal(new URL(calls[0]!.url).hostname, 'api.ashbyhq.com');
    assert.deepEqual([job.externalId, job.title, job.description], [ashbyId, 'Engineering Manager', 'Lead a team.']);
  });

  it('reports a missing posting: 404 from Greenhouse and Lever, absent from the Ashby feed', async () => {
    const missing = mockFetch(() => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }));
    await rejects(readPosting(parsePostingUrl('https://boards.greenhouse.io/acme/jobs/1')!, missing.options), 'POSTING_NOT_FOUND');
    await rejects(readPosting(parsePostingUrl(`https://jobs.lever.co/acme/${leverId}`)!, missing.options), 'POSTING_NOT_FOUND');
    const cache: PostingFeedCache = new Map();
    const ref = parsePostingUrl(`https://jobs.ashbyhq.com/acme/${ashbyId}`)!;
    const first = mockFetch(() => json(ashbyFeed));
    await readPosting(ref, { ...first.options, feedCache: cache }); await readPosting(ref, { ...first.options, feedCache: cache });
    assert.equal(first.calls.length, 1, 'the board feed is downloaded once and reused');
    const other = mockFetch(() => json(ashbyFeed));
    await readPosting(ref, other.options); await readPosting(ref, other.options);
    assert.equal(other.calls.length, 2, 'without a cache every lookup reads the feed');
    for (const tenant of ['b', 'c', 'd']) await readPosting(parsePostingUrl(`https://jobs.ashbyhq.com/${tenant}/${ashbyId}`)!, { ...mockFetch(() => json(ashbyFeed)).options, feedCache: cache }).catch(() => undefined);
    assert.ok(cache.size <= 3, 'only a few feeds are kept');
    await rejects(readPosting(parsePostingUrl(`https://jobs.ashbyhq.com/acme/cccccccc-0000-0000-0000-000000000000`)!, mockFetch(() => json(ashbyFeed)).options), 'POSTING_NOT_FOUND');
  });

  it('reports a posting Ashby does not list publicly as closed', async () => {
    await rejects(readPosting(parsePostingUrl('https://jobs.ashbyhq.com/acme/bbbbbbbb-0000-0000-0000-000000000000')!, mockFetch(() => json(ashbyFeed)).options), 'POSTING_UNLISTED');
  });

  it('rejects invalid responses, redirects and wrong content types', async () => {
    const ref = parsePostingUrl('https://boards.greenhouse.io/acme/jobs/1')!;
    await rejects(readPosting(ref, mockFetch(() => json([greenhouse])).options), 'SOURCE_SCHEMA_INVALID');
    await rejects(readPosting(ref, mockFetch(() => json({ id: 1 })).options), 'SOURCE_SCHEMA_INVALID');
    await rejects(readPosting(ref, mockFetch(() => new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } })).options), 'SOURCE_JSON_INVALID');
    await rejects(readPosting(ref, mockFetch(() => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })).options), 'SOURCE_CONTENT_TYPE_INVALID');
    await rejects(readPosting(ref, mockFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } })).options), 'SOURCE_REDIRECT_REJECTED');
    await rejects(readPosting(ref, { fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch }), 'SOURCE_NETWORK_ERROR');
  });

  it('refuses a reference that was not built by the parser before any request', async () => {
    const { calls, options } = mockFetch(() => json(greenhouse));
    await rejects(readPosting({ provider: 'greenhouse', region: 'global', tenant: 'a/../b', id: '1' }, options), 'POSTING_URL_INVALID');
    await rejects(readPosting({ provider: 'greenhouse', region: 'eu', tenant: 'acme', id: '1' }, options), 'BOARD_REGION_UNSUPPORTED');
    assert.equal(calls.length, 0);
  });
});
