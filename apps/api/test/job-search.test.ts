import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesSearch } from '../src/job-search.js';
import { normalizePublicJobs, parseRetryAfter, readPublicFeed, readPublicJobs, ProviderReadError, type JobSearchProvider } from '../src/job-search-sources.js';

const remotiveFixture = { jobs: [{ id: 42, title: 'Senior Product Designer', company_name: 'Northwind Studio', candidate_required_location: 'Europe', publication_date: '2026-09-30', url: 'https://remotive.com/remote-jobs/design/senior-product-designer-42', remote: true, description: '<p>Design accessible products</p><script>secret()</script>' }] };
const arbeitnowFixture = { data: [{ slug: 'staff-engineer', title: 'Staff Engineer', company_name: 'Example GmbH', location: 'Berlin, Germany', created_at: '2026-10-01', url: 'https://www.arbeitnow.com/jobs/staff-engineer', remote: false, description: '<p>Platform work</p>' }] };

test('normalizes documented Remotive jobs and strips executable markup', () => {
  const [job] = normalizePublicJobs('remotive', remotiveFixture);
  const [revised] = normalizePublicJobs('remotive', { jobs: [{ ...remotiveFixture.jobs[0], url: 'https://remotive.com/remote-jobs/design/senior-product-designer-renamed' }] });
  assert.equal(job?.company, 'Northwind Studio'); assert.equal(job?.workMode, 'remote');
  assert.equal(job?.externalId, '42'); assert.equal(job?.description, 'Design accessible products'); assert.match(job?.url ?? '', /^https:/);
  assert.equal(revised?.externalId, job?.externalId);
});

test('normalizes Arbeitnow entries and keeps missing work-mode explicit', () => {
  const [job] = normalizePublicJobs('arbeitnow', arbeitnowFixture);
  assert.equal(job?.location, 'Berlin, Germany'); assert.equal(job?.workMode, 'unknown');
});

test('accepts official regional Arbeitnow listings and normalizes epoch timestamps', () => {
  const [job] = normalizePublicJobs('arbeitnow', { data: [{ slug: 'regional', title: 'Engineer', company_name: 'Example', location: 'Freiburg (Germany)', created_at: 1791049211, url: 'https://www.arbeitnow.fr/jobs/engineer', remote: false }] });
  assert.equal(job?.externalId, 'regional'); assert.equal(job?.postedAt, '2026-10-03T17:40:11.000Z');
});

test('hybrid signals take precedence over the provider remote boolean', () => {
  const [job] = normalizePublicJobs('arbeitnow', { data: [{ slug: 'hybrid', title: 'Hybrid Product Designer', company_name: 'Example', location: 'Berlin', created_at: 1791049211, url: 'https://www.arbeitnow.com/jobs/hybrid', remote: true }] });
  assert.equal(job?.workMode, 'hybrid');
});

test('rejects non-HTTPS, credentialed, redirected-host, and malformed source URLs', () => {
  for (const url of ['http://remotive.com/jobs/1', 'https://user@remotive.com/jobs/1', 'https://example.org/jobs/1', 'not a url']) {
    const result = normalizePublicJobs('remotive', { jobs: [{ ...remotiveFixture.jobs[0], url }] });
    assert.equal(result.length, 0, url);
  }
});

test('matches role and company together and marks unknown locations for review', () => {
  const job = { title: 'Senior Product Designer', company: 'Northwind Studio', location: null, workMode: 'remote' as const };
  assert.deepEqual(matchesSearch(job, { role: 'product designer', company: 'northwind', location: 'Spain', workMode: 'remote' }), { matched: true, unknownLocation: true });
  assert.equal(matchesSearch(job, { role: 'engineer', company: null, location: null, workMode: 'any' }).matched, false);
  assert.equal(matchesSearch(job, { role: null, company: 'Elsewhere', location: null, workMode: 'any' }).matched, false);
  assert.equal(matchesSearch({ ...job, location: 'Remote (US)' }, { role: null, company: null, location: 'Spain', workMode: 'remote' }).matched, false);
  assert.deepEqual(matchesSearch({ ...job, location: 'Worldwide' }, { role: null, company: null, location: 'Spain', workMode: 'remote' }), { matched: true, unknownLocation: true });
  assert.deepEqual(matchesSearch({ ...job, location: 'Europe' }, { role: null, company: null, location: 'Spain', workMode: 'remote' }), { matched: true, unknownLocation: true });
});

test('readPublicJobs uses the fixed HTTPS feed endpoint, bounded safe request options, and injected fixtures', async () => {
  for (const provider of ['remotive', 'arbeitnow'] as JobSearchProvider[]) {
    let requestInit: RequestInit | undefined;
    const fixture = provider === 'remotive' ? remotiveFixture : arbeitnowFixture;
    const jobs = await readPublicJobs(provider, async (_input, init) => { requestInit = init; return new Response(JSON.stringify(fixture), { headers: { 'content-type': 'application/json' } }); });
    assert.equal(jobs.length, 1); assert.equal(requestInit?.method, 'GET'); assert.equal(requestInit?.redirect, 'error'); assert.ok(requestInit?.signal);
  }
});

test('provider reads reject unsafe redirects and oversized response bodies', async () => {
  await assert.rejects(readPublicJobs('remotive', async (_input, init) => {
    assert.equal(init?.redirect, 'error'); throw new TypeError('redirect blocked');
  }), (error: unknown) => error instanceof ProviderReadError && error.code === 'SOURCE_UNAVAILABLE');
  await assert.rejects(readPublicJobs('arbeitnow', async () => new Response('x'.repeat(20), { headers: { 'content-length': String(5 * 1024 * 1024) } })),
    (error: unknown) => error instanceof ProviderReadError && error.code === 'SOURCE_RESPONSE_TOO_LARGE');
});

test('Arbeitnow pagination constructs fixed endpoint URLs and reports bounded coverage', async () => {
  const requested: string[] = [];
  const result = await readPublicFeed('arbeitnow', async (input) => {
    requested.push(String(input));
    const page = requested.length;
    return new Response(JSON.stringify({ data: [], links: { next: page < 4 ? 'https://evil.example/redirect' : null } }));
  });
  assert.equal(requested.length, 3); assert.deepEqual(requested.map((url) => new URL(url).searchParams.get('page')), [null, '2', '3']);
  assert.ok(requested.every((url) => new URL(url).origin === 'https://www.arbeitnow.com'));
  assert.equal(result.coverage, 'BOUNDED');
});

test('parses retry-after seconds and dates with a 48 hour cap', () => {
  const now = Date.parse('2026-10-03T00:00:00Z');
  assert.equal(parseRetryAfter('120', now), now + 120_000);
  assert.equal(parseRetryAfter('2026-10-03T02:00:00Z', now), now + 7_200_000);
  assert.equal(parseRetryAfter('999999', now), now + 48 * 60 * 60 * 1000);
});
