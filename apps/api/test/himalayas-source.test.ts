import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderReadError } from '../src/job-search-sources.js';
import { readHimalayasSearch } from '../src/himalayas-source.js';

const updatedAt = Date.parse('2026-10-03T12:00:00Z');
const job = (overrides: Record<string, unknown> = {}) => ({
  title: 'Senior Product Designer',
  companyName: 'Fictional Studio',
  guid: 'fictional-studio-senior-product-designer-1',
  applicationLink: 'https://himalayas.app/jobs/fictional-job?source=search',
  pubDate: Date.parse('2026-10-01T08:30:00Z'),
  description: '<p>Design useful tools &amp; experiences.</p><script>not-safe()</script>',
  locationRestrictions: [{ alpha2: 'ES', name: 'Spain', slug: 'spain' }, { alpha2: 'PT', name: 'Portugal', slug: 'portugal' }],
  ...overrides,
});
const page = (jobs = [job()], overrides: Record<string, unknown> = {}) => ({
  updatedAt,
  offset: 0,
  limit: 20,
  totalCount: 1,
  jobs,
  ...overrides,
});
const response = (payload: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(payload), {
  headers: { 'content-type': 'application/json' },
  ...init,
});
const withFinalUrl = (value: Response, url: string) => Object.defineProperty(value, 'url', { value: url }) as Response;

test('targets fixed Himalayas search endpoint, maps restrictions, and retains the provider application link', async () => {
  let requested: URL | undefined;
  let init: RequestInit | undefined;
  const result = await readHimalayasSearch({ role: ' Product Designer ', company: 'Fictional Studio', location: 'Spain' }, {
    fetch: async (input, requestInit) => {
      requested = new URL(String(input)); init = requestInit;
      return response(page());
    },
  });
  assert.equal(requested?.origin, 'https://himalayas.app');
  assert.equal(requested?.pathname, '/jobs/api/search');
  assert.equal(requested?.searchParams.get('q'), 'Product Designer Fictional Studio');
  assert.equal(requested?.searchParams.get('country'), 'ES');
  assert.equal(requested?.searchParams.get('page'), '1');
  assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
  assert.equal(result.coverage, 'COMPLETE'); assert.equal(result.requests, 1);
  assert.equal(result.sourceUpdatedAt, '2026-10-03T12:00:00.000Z');
  const found = result.jobs[0];
  assert.ok(found);
  assert.equal(found.externalId, 'fictional-studio-senior-product-designer-1');
  assert.equal(found.url, 'https://himalayas.app/jobs/fictional-job?source=search');
  assert.equal(found.workMode, 'remote');
  assert.equal(found.location, 'ES, PT');
  assert.deepEqual(found.raw.__careerStackCountries, ['ES', 'PT']);
  assert.equal(found.raw.__careerStackWorldwide, false);
  assert.equal(found.raw.__careerStackSource, 'himalayas');
  assert.equal(found.raw.__careerStackSourceUrl, 'https://himalayas.app');
  assert.equal(found.description, 'Design useful tools & experiences.');
  assert.equal(found.raw.description, found.description);
});

test('identifies unrestricted jobs as worldwide and preserves missing publication dates', async () => {
  const result = await readHimalayasSearch({ role: null, company: null, location: null }, {
    fetch: async () => response(page([job({ locationRestrictions: [], pubDate: 9e99 })])),
  });
  assert.equal(result.jobs[0]?.location, 'Worldwide');
  assert.deepEqual(result.jobs[0]?.raw.__careerStackCountries, []);
  assert.equal(result.jobs[0]?.raw.__careerStackWorldwide, true);
  assert.equal(result.jobs[0]?.postedAt, null);
  assert.equal(result.jobs[0]?.url, job().applicationLink);
});

test('normalizes supported countries and leaves cities and unsupported locations out of the country query', async () => {
  const requested: URL[] = [];
  for (const location of ['United States', 'España', 'London', 'Remote - Americas']) {
    await readHimalayasSearch({ role: null, company: null, location }, {
      fetch: async (input) => { requested.push(new URL(String(input))); return response(page([])); },
    });
  }
  assert.deepEqual(requested.map((value) => value.searchParams.get('country')), ['US', 'ES', null, null]);
});

test('keeps a safe public employer destination and rejects unsafe application hosts', async () => {
  const safe = await readHimalayasSearch({ role: null, company: null, location: null }, {
    fetch: async () => response(page([job({ applicationLink: 'https://careers.fictional-studio.com/apply?id=23' })])),
  });
  assert.equal(safe.jobs[0]?.url, 'https://careers.fictional-studio.com/apply?id=23');
  assert.equal(safe.jobs[0]?.raw.__careerStackSource, 'himalayas');
  for (const applicationLink of [
    'javascript:alert(1)', 'http://careers.fictional-studio.com/apply', 'https://user@careers.fictional-studio.com/apply',
    'https://127.0.0.1/apply', 'https://[::1]/apply', 'https://localhost/apply', 'https://private.local/apply',
    'https://metadata.internal/latest', 'https://not-public.example/apply',
  ]) {
    const result = await readHimalayasSearch({ role: null, company: null, location: null }, {
      fetch: async () => response(page([job({ applicationLink })])),
    });
    assert.equal(result.coverage, 'PARTIAL', applicationLink);
    assert.deepEqual(result.jobs, [], applicationLink);
  }
});

test('uses 1-based search pages and reports BOUNDED at the three-page ceiling', async () => {
  const requested: string[] = [];
  const result = await readHimalayasSearch({ role: 'design', company: null, location: null }, {
    maxPages: 99,
    fetch: async (input) => {
      requested.push(String(input));
      return response(page([job({ guid: `fictional-${requested.length}` })], { totalCount: 100, limit: 20 }));
    },
  });
  assert.equal(requested.length, 3); assert.equal(result.requests, 3);
  assert.deepEqual(requested.map((value) => new URL(value).searchParams.get('page')), ['1', '2', '3']);
  assert.equal(result.coverage, 'BOUNDED'); assert.equal(result.jobs.length, 3);
});

test('honors a lower configured page budget and handles an empty result as complete', async () => {
  const requested: string[] = [];
  const result = await readHimalayasSearch({ role: null, company: 'Studio', location: null }, {
    maxPages: 1,
    fetch: async (input) => {
      requested.push(String(input));
      return response(page([], { totalCount: 0 }));
    },
  });
  assert.equal(requested.length, 1); assert.equal(new URL(requested[0]!).searchParams.get('q'), 'Studio');
  assert.equal(result.coverage, 'COMPLETE'); assert.deepEqual(result.jobs, []);
});

test('rejects invalid response schema and marks invalid job schemas partial', async () => {
  const malformedRows = [page([job({ guid: '' })]), page([job({ locationRestrictions: 'ES' })]), page([job({ pubDate: '2026-10-01' })])];
  for (const payload of malformedRows) {
    const result = await readHimalayasSearch({ role: null, company: null, location: null }, { fetch: async () => response(payload) });
    assert.equal(result.coverage, 'PARTIAL'); assert.deepEqual(result.jobs, []);
  }
  await assert.rejects(readHimalayasSearch({ role: null, company: null, location: null }, { fetch: async () => response({ jobs: [] }) }),
    (error: unknown) => error instanceof ProviderReadError && error.code === 'SOURCE_INVALID_RESPONSE');
});

test('checks the final response URL and requires a JSON content type', async () => {
  await assert.rejects(readHimalayasSearch({ role: null, company: null, location: null }, {
    fetch: async () => withFinalUrl(response(page()), 'https://evil.invalid/jobs/api/search'),
  }), (error: unknown) => error instanceof ProviderReadError && error.code === 'SOURCE_UNSAFE_REDIRECT');
  await assert.rejects(readHimalayasSearch({ role: null, company: null, location: null }, {
    fetch: async () => new Response(JSON.stringify(page()), { headers: { 'content-type': 'text/html' } }),
  }), (error: unknown) => error instanceof ProviderReadError && error.code === 'SOURCE_INVALID_RESPONSE');
});

test('skips invalid rows while marking their page coverage PARTIAL', async () => {
  const result = await readHimalayasSearch({ role: null, company: null, location: null }, {
    fetch: async () => response(page([job({ applicationLink: 'https://localhost/private' }), job({ guid: 'valid-row' })])),
  });
  assert.equal(result.coverage, 'PARTIAL');
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0]?.externalId, 'valid-row');
});

test('retains earlier valid jobs and reports PARTIAL after a later page failure', async () => {
  let calls = 0;
  const result = await readHimalayasSearch({ role: 'designer', company: null, location: null }, {
    fetch: async () => {
      calls++;
      if (calls === 1) return response(page([job({ guid: 'first-page-job' })], { totalCount: 100 }));
      throw new Error('page two unavailable');
    },
  });
  assert.equal(result.requests, 2);
  assert.equal(result.coverage, 'PARTIAL');
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0]?.externalId, 'first-page-job');
});

test('bounds publication dates and rejects implausibly future source timestamps', async () => {
  const result = await readHimalayasSearch({ role: null, company: null, location: null }, {
    fetch: async () => response(page([job({ pubDate: Date.now() + 10 * 24 * 60 * 60 * 1000 })])),
  });
  assert.equal(result.jobs[0]?.postedAt, null);
  await assert.rejects(readHimalayasSearch({ role: null, company: null, location: null }, {
    fetch: async () => response(page([], { updatedAt: Date.now() + 48 * 60 * 60 * 1000 })),
  }), (error: unknown) => error instanceof ProviderReadError && error.code === 'SOURCE_INVALID_RESPONSE');
});

test('maps HTTP 429 Retry-After and rejects oversized response bodies', async () => {
  await assert.rejects(readHimalayasSearch({ role: null, company: null, location: null }, {
    fetch: async () => new Response('', { status: 429, headers: { 'retry-after': '60' } }),
  }), (error: unknown) => error instanceof ProviderReadError && error.code === 'SOURCE_HTTP_429' && error.retryAt > Date.now());
  await assert.rejects(readHimalayasSearch({ role: null, company: null, location: null }, {
    fetch: async () => new Response('x'.repeat(20), { headers: { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) } }),
  }), (error: unknown) => error instanceof ProviderReadError && error.code === 'SOURCE_RESPONSE_TOO_LARGE');
});

test('preserves a long Retry-After from a later page in partial coverage', async () => {
  let calls = 0;
  const result = await readHimalayasSearch({ role: null, company: null, location: null }, {
    fetch: async () => {
      calls++;
      if (calls === 1) return response(page([job({ guid: 'first-page' })], { totalCount: 100 }));
      return new Response('', { status: 429, headers: { 'retry-after': '172800' } });
    },
  });
  assert.equal(result.coverage, 'PARTIAL');
  assert.equal(result.requests, 2);
  assert.equal(result.jobs[0]?.externalId, 'first-page');
  assert.ok((result.retryAt ?? 0) > Date.now() + 47 * 60 * 60 * 1000);
});

test('maps invalid JSON, network errors, and request aborts to provider read errors', async () => {
  await assert.rejects(readHimalayasSearch({ role: null, company: null, location: null }, { fetch: async () => new Response('<html>oops</html>') }),
    (error: unknown) => error instanceof ProviderReadError && error.code === 'SOURCE_INVALID_RESPONSE');
  await assert.rejects(readHimalayasSearch({ role: null, company: null, location: null }, { fetch: async () => { throw new Error('offline'); } }),
    (error: unknown) => error instanceof ProviderReadError && error.code === 'SOURCE_UNAVAILABLE');
  await assert.rejects(readHimalayasSearch({ role: null, company: null, location: null }, {
    timeoutMs: 1,
    fetch: async (_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
  }), (error: unknown) => error instanceof ProviderReadError && error.code === 'SOURCE_TIMEOUT');
});
