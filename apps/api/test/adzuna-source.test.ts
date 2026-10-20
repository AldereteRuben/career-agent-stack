import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adzunaAttributionUrl, adzunaQueryHash, normalizeAdzunaJobs, readAdzunaCredentials, readAdzunaSearch } from '../src/adzuna-source.js';
import { ProviderReadError } from '../src/job-search-sources.js';

const credentials = { appId: 'synthetic-id', appKey: 'synthetic-secret', country: 'es' };
const criteria = { role: 'Product designer', company: null, location: 'Madrid', workMode: 'any' as const };
const payload = { results: [
  { id: '123', title: 'Product designer', company: { display_name: 'Example Co' }, location: { display_name: 'Madrid' }, redirect_url: 'http://adzuna.es/jobs/land/ad/123', created: '2026-10-01T12:00:00Z', description: '<b>Design systems</b>', salary_min: 50000 },
  { id: 'unsafe', title: 'Fake job', company: { display_name: 'Bad Co' }, location: { display_name: 'Madrid' }, redirect_url: 'https://example.com/steal' },
  { id: 'incomplete', title: 'No company', redirect_url: 'https://adzuna.es/jobs/land/ad/456' },
] };

test('credentials stay local and only supported country configuration enables Adzuna', () => {
  assert.deepEqual(readAdzunaCredentials({ ADZUNA_APP_ID: 'id', ADZUNA_APP_KEY: 'key', ADZUNA_COUNTRY: 'GB' }), { appId: 'id', appKey: 'key', country: 'gb' });
  assert.equal(readAdzunaCredentials({ ADZUNA_APP_ID: 'id' }), null);
  assert.equal(readAdzunaCredentials({ ADZUNA_APP_ID: 'id', ADZUNA_APP_KEY: 'key', ADZUNA_COUNTRY: 'zz' }), null);
  assert.deepEqual(readAdzunaCredentials({ ADZUNA_APP_ID: 'private-id', ADZUNA_APP_KEY: 'private-key' }), { appId: 'private-id', appKey: 'private-key', country: 'es' });
});

test('synthetic listings normalize bounded public fields and reject untrusted advert hosts', () => {
  const jobs = normalizeAdzunaJobs(payload, 'es');
  assert.equal(jobs.length, 1);
  assert.deepEqual({ id: jobs[0]?.externalId, url: jobs[0]?.url, company: jobs[0]?.company, location: jobs[0]?.location, date: jobs[0]?.postedAt }, {
    id: '123', url: 'https://adzuna.es/jobs/land/ad/123', company: 'Example Co', location: 'Madrid', date: '2026-10-01T12:00:00.000Z',
  });
  assert.equal(jobs[0]?.attributionUrl, 'https://www.adzuna.es');
  assert.equal(jobs[0]?.description, 'Design systems');
  assert.equal(adzunaAttributionUrl('es'), 'https://www.adzuna.es');
});

test('search uses the fixed HTTPS API host, bounded query, no redirects, and never follows advert URLs', async () => {
  let called = '';
  const result = await readAdzunaSearch(criteria, { credentials, fetcher: async (input, init) => {
    called = String(input);
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error');
    return Response.json(payload);
  } });
  const request = new URL(called);
  assert.equal(request.origin, 'https://api.adzuna.com');
  assert.equal(request.pathname, '/v1/api/jobs/es/search/1');
  assert.equal(request.searchParams.get('results_per_page'), '20');
  assert.equal(request.searchParams.get('what'), 'Product designer');
  assert.equal(request.searchParams.get('where'), 'Madrid');
  assert.equal(result.coverage, 'BOUNDED');
  assert.equal(result.jobs.length, 1);
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false, 'credentials never enter normalized results or errors');
  assert.equal(called.includes('synthetic-secret'), true, 'Adzuna requires keys in the HTTPS query; no result or error object exposes the URL');
});

test('search walks at most three pages, deduplicates moved listings and paces each request', async () => {
  const pages = [Array.from({ length: 20 }, (_, index) => ({ ...payload.results[0], id: `page-one-${index}` })), [{ ...payload.results[0], id: 'page-one-0', title: 'Updated title' }]];
  const paths: string[] = []; const waits: number[] = [];
  const result = await readAdzunaSearch(criteria, { credentials, wait: async (milliseconds) => { waits.push(milliseconds); }, fetcher: async (input) => {
    paths.push(new URL(String(input)).pathname);
    return Response.json({ results: pages[paths.length - 1] });
  } });
  assert.deepEqual(paths, ['/v1/api/jobs/es/search/1', '/v1/api/jobs/es/search/2']);
  assert.deepEqual(waits, [2_500]);
  assert.equal(result.jobs.length, 20);
  assert.equal(result.jobs.find((job) => job.externalId === 'page-one-0')?.title, 'Updated title');
  assert.equal(result.coverage, 'BOUNDED');

  const maxPagePaths: string[] = []; const maxPageWaits: number[] = [];
  const bounded = await readAdzunaSearch(criteria, { credentials, wait: async (milliseconds) => { maxPageWaits.push(milliseconds); }, fetcher: async (input) => {
    maxPagePaths.push(new URL(String(input)).pathname);
    return Response.json({ results: Array.from({ length: 20 }, (_, index) => ({ ...payload.results[0], id: `${maxPagePaths.length}-${index}` })) });
  } });
  assert.deepEqual(maxPagePaths, ['/v1/api/jobs/es/search/1', '/v1/api/jobs/es/search/2', '/v1/api/jobs/es/search/3']);
  assert.deepEqual(maxPageWaits, [2_500, 2_500]);
  assert.equal(bounded.jobs.length, 60);
});

test('missing credentials, malformed pages and HTTP errors fail with stable source codes', async () => {
  await assert.rejects(readAdzunaSearch(criteria, { credentials: null }), (error: unknown) => error instanceof ProviderReadError && error.code === 'SOURCE_NOT_CONFIGURED');
  await assert.rejects(readAdzunaSearch(criteria, { credentials, fetcher: async () => Response.json({ results: {} }) }), (error: unknown) => error instanceof ProviderReadError && error.code === 'SOURCE_INVALID_RESPONSE');
  await assert.rejects(readAdzunaSearch(criteria, { credentials, fetcher: async () => new Response('no', { status: 429 }) }), (error: unknown) => error instanceof ProviderReadError && error.code === 'SOURCE_HTTP_429');
});

test('Adzuna cache identity includes country, criteria and bounded page size', () => {
  assert.notEqual(adzunaQueryHash(criteria, 'es'), adzunaQueryHash(criteria, 'gb'));
  assert.notEqual(adzunaQueryHash(criteria, 'es'), adzunaQueryHash({ ...criteria, location: 'Barcelona' }, 'es'));
  assert.equal(adzunaQueryHash(criteria, 'es').length, 64);
});
