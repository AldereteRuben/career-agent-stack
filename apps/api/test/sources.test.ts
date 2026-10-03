import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeEntities, htmlToText, readBoard, readBoardWithReport, sourceDate, sourceHost, sourceUrlField, type BoardForSource, type SourceReadOptions } from '../src/sources.js';

type Call = { url: string; init: RequestInit | undefined };
/** Deterministic fetch double: records calls and answers with a canned Response (or throws). */
function mockFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => { const url = String(input instanceof Request ? input.url : input); calls.push({ url, init }); return respond(url); }) as typeof globalThis.fetch;
  return { calls, options: { fetch } satisfies SourceReadOptions };
}
const json = (body: unknown, init: ResponseInit = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, ...init });
const board = (provider: BoardForSource['provider'], region = 'global', tenant = 'acme'): BoardForSource => ({ provider, region, tenant });
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: Error) => { assert.equal(error.message, code); return true; });

const greenhouseFixture = {
  jobs: [
    { id: 8860302002, internal_job_id: 1, title: 'Backend Engineer &amp; SRE', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/8860302002#app', location: { name: 'Remote, Spain' }, updated_at: '2026-10-02T11:31:50-04:00', first_published: '2026-09-30T09:00:00-04:00', content: '&lt;div class=&quot;intro&quot;&gt;&lt;p&gt;We build &amp;amp; ship.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;li&gt;Postgres&lt;/li&gt;&lt;/ul&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;p&gt;Salary&amp;nbsp;&amp;euro;90k &amp;#8211; &amp;#x1F680;&lt;/p&gt;&lt;/div&gt;' },
    { id: 2, title: 'No URL', absolute_url: 'javascript:alert(1)', location: null, content: null, updated_at: 'yesterday', first_published: null },
  ],
  meta: { total: 2 },
};
const leverFixture = [
  { id: '681fbc53-1e34-4a46-8677-3a78118674eb', text: 'Product Engineer', hostedUrl: 'https://jobs.eu.lever.co/acme/681fbc53-1e34-4a46-8677-3a78118674eb', applyUrl: 'https://jobs.eu.lever.co/acme/681fbc53-1e34-4a46-8677-3a78118674eb/apply', categories: { location: 'Lisbon', team: 'Eng', allLocations: ['Lisbon', 'Madrid'] }, createdAt: 1_759_400_000_000, description: '<div>Intro <b>bold</b></div>', descriptionPlain: 'Intro bold\n', lists: [{ text: 'What you will do', content: '<li>Ship features</li><li>Review &amp; mentor</li>' }, { text: 'Requirements', content: '<li>TypeScript</li>' }], additional: '<div>Benefits</div>', additionalPlain: 'Benefits\n', workplaceType: 'hybrid' },
  { id: 'b2', text: 'All locations only', hostedUrl: 'https://jobs.eu.lever.co/acme/b2', categories: { allLocations: ['Berlin', 'Paris'] }, createdAt: 12, lists: [] },
];
const ashbyFixture = {
  apiVersion: '1',
  jobs: [
    { id: '7458d4e9-da2e-47bd-98cb-adfda43d42b2', title: 'Engineering Manager', location: 'Remote - EU', isListed: true, descriptionHtml: '<p>Hi</p>', descriptionPlain: 'Hi  there\r\n\r\n\r\nBye', publishedAt: '2024-03-04T14:29:08.532+00:00', jobUrl: 'https://jobs.ashbyhq.com/acme/7458d4e9-da2e-47bd-98cb-adfda43d42b2', applyUrl: 'https://jobs.ashbyhq.com/acme/7458d4e9-da2e-47bd-98cb-adfda43d42b2/application' },
    { title: 'No id field', location: 'NYC', isListed: true, descriptionHtml: '<p>Only <em>HTML</em></p>', publishedAt: '2025-01-01T00:00:00Z', jobUrl: 'https://jobs.ashbyhq.com/acme/0b6c3c2e-1111-4222-8333-944455556666' },
    { id: 'hidden', title: 'Unlisted', isListed: false, jobUrl: 'https://jobs.ashbyhq.com/acme/hidden' },
  ],
};

describe('provider requests', () => {
  it('requests only the documented public hosts with a non-following redirect policy', async () => {
    const cases: Array<[BoardForSource, string, unknown]> = [
      [board('greenhouse'), 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true', { jobs: [] }],
      [board('lever'), 'https://api.lever.co/v0/postings/acme?mode=json', []],
      [board('lever', ' EU '), 'https://api.eu.lever.co/v0/postings/acme?mode=json', []],
      [board('ashby', 'Global'), 'https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true', { apiVersion: '1', jobs: [] }],
    ];
    for (const [source, expected, body] of cases) {
      const { calls, options } = mockFetch(() => json(body));
      assert.deepEqual(await readBoard(source, options), []);
      assert.equal(calls.length, 1); assert.equal(calls[0]!.url, expected);
      assert.equal(calls[0]!.init?.method, 'GET'); assert.equal(calls[0]!.init?.redirect, 'error');
      assert.ok(calls[0]!.init?.signal, 'a timeout signal is always attached');
    }
  });

  it('rejects unsupported provider/region pairs and bad tenants before any request', async () => {
    const { calls, options } = mockFetch(() => json([]));
    await rejects(readBoard(board('greenhouse', 'eu'), options), 'BOARD_REGION_UNSUPPORTED');
    await rejects(readBoard(board('ashby', 'eu'), options), 'BOARD_REGION_UNSUPPORTED');
    await rejects(readBoard(board('lever', 'apac'), options), 'BOARD_REGION_UNSUPPORTED');
    await rejects(readBoard(board('lever', 'constructor'), options), 'BOARD_REGION_UNSUPPORTED');
    await rejects(readBoard({ provider: 'workday' as BoardForSource['provider'], region: 'global', tenant: 'acme' }, options), 'SOURCE_PROVIDER_UNSUPPORTED');
    await rejects(readBoard({ provider: 'toString' as BoardForSource['provider'], region: 'global', tenant: 'acme' }, options), 'SOURCE_PROVIDER_UNSUPPORTED');
    await rejects(readBoard(board('lever', 'global', '../admin'), options), 'BOARD_TENANT_INVALID');
    await rejects(readBoard(board('lever', 'global', 'acme?x=1'), options), 'BOARD_TENANT_INVALID');
    assert.equal(calls.length, 0);
    assert.throws(() => sourceHost('lever', 'hasOwnProperty'), /BOARD_REGION_UNSUPPORTED/);
  });
});

describe('transport failures', () => {
  it('maps HTTP errors to SOURCE_HTTP_<status>', async () => {
    for (const status of [404, 429, 500, 503]) {
      const { options } = mockFetch(() => json({ error: 'x' }, { status }));
      await rejects(readBoard(board('greenhouse'), options), `SOURCE_HTTP_${status}`);
    }
  });

  it('rejects redirects whether surfaced as a 3xx, a followed response, or a fetch redirect error', async () => {
    await rejects(readBoard(board('lever'), mockFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })).options), 'SOURCE_REDIRECT_REJECTED');
    const followed = json([]); Object.defineProperty(followed, 'redirected', { value: true });
    await rejects(readBoard(board('lever'), mockFetch(() => followed).options), 'SOURCE_REDIRECT_REJECTED');
    const elsewhere = json([]); Object.defineProperty(elsewhere, 'url', { value: 'https://evil.example/v0/postings/acme' });
    await rejects(readBoard(board('lever'), mockFetch(() => elsewhere).options), 'SOURCE_REDIRECT_REJECTED');
    await rejects(readBoard(board('lever'), mockFetch(() => { throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') }); }).options), 'SOURCE_REDIRECT_REJECTED');
  });

  it('maps timeouts and network failures to stable codes', async () => {
    await rejects(readBoard(board('ashby'), mockFetch(() => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }).options), 'SOURCE_TIMEOUT');
    await rejects(readBoard(board('ashby'), mockFetch(() => { throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND') }); }).options), 'SOURCE_NETWORK_ERROR');
  });

  it('rejects a declared oversize body without reading it', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(1024)); } });
    const { options } = mockFetch(() => new Response(body, { headers: { 'content-type': 'application/json', 'content-length': '5000' } }));
    await rejects(readBoard(board('lever'), { ...options, maxBytes: 4096 }), 'SOURCE_RESPONSE_TOO_LARGE');
    assert.ok(pulled <= 1, `body should not be consumed, pulled ${pulled} chunks`);
  });

  it('stops streaming an undeclared body as soon as it passes the cap', async () => {
    let pulled = 0; let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(new TextEncoder().encode(' '.repeat(1000))); }, cancel() { cancelled = true; } });
    const { options } = mockFetch(() => new Response(body, { headers: { 'content-type': 'application/json' } }));
    await rejects(readBoard(board('lever'), { ...options, maxBytes: 4500 }), 'SOURCE_RESPONSE_TOO_LARGE');
    assert.ok(pulled <= 7, `stream should stop near the cap, pulled ${pulled} chunks`);
    assert.equal(cancelled, true);
  });

  it('accepts a body exactly at the cap', async () => {
    const text = JSON.stringify([]).padEnd(64, ' ');
    const { options } = mockFetch(() => json(text));
    assert.deepEqual(await readBoard(board('lever'), { ...options, maxBytes: 64 }), []);
  });

  it('rejects non-JSON content types, malformed JSON, and invalid UTF-8', async () => {
    await rejects(readBoard(board('greenhouse'), mockFetch(() => new Response('<html>blocked</html>', { headers: { 'content-type': 'text/html' } })).options), 'SOURCE_CONTENT_TYPE_INVALID');
    await rejects(readBoard(board('greenhouse'), mockFetch(() => json('{"jobs": [')).options), 'SOURCE_JSON_INVALID');
    await rejects(readBoard(board('greenhouse'), mockFetch(() => new Response(new Uint8Array([0x7b, 0xff, 0x7d]), { headers: { 'content-type': 'application/json' } })).options), 'SOURCE_ENCODING_INVALID');
  });
});

describe('schema validation', () => {
  it('rejects feeds with the wrong top-level shape', async () => {
    await rejects(readBoard(board('greenhouse'), mockFetch(() => json([])).options), 'SOURCE_SCHEMA_INVALID');
    await rejects(readBoard(board('greenhouse'), mockFetch(() => json({ jobs: 'none' })).options), 'SOURCE_SCHEMA_INVALID');
    await rejects(readBoard(board('lever'), mockFetch(() => json({ jobs: [] })).options), 'SOURCE_SCHEMA_INVALID');
    await rejects(readBoard(board('ashby'), mockFetch(() => json({ jobs: [1, 2] })).options), 'SOURCE_SCHEMA_INVALID');
  });

  it('skips malformed jobs, reports why, and fails only when nothing valid remains', async () => {
    const report = await readBoardWithReport(board('lever'), mockFetch(() => json([...leverFixture, { id: 'x', text: 42, hostedUrl: 'https://jobs.lever.co/acme/x' }, { id: '', text: 'Blank id', hostedUrl: 'https://jobs.lever.co/acme/y' }, { ...leverFixture[1], text: 'Duplicate' }])).options);
    assert.equal(report.received, 5); assert.equal(report.jobs.length, 2); assert.equal(report.skipped, 3);
    assert.deepEqual(report.skipReasons, { SCHEMA_INVALID: 1, ID_INVALID: 1, DUPLICATE_ID: 1 });
    await rejects(readBoard(board('lever'), mockFetch(() => json([{ id: 1, text: 'numeric id' }])).options), 'SOURCE_SCHEMA_INVALID');
  });
});

describe('field mapping', () => {
  it('greenhouse: decodes entity-encoded HTML to plain text and keeps dates and ids exact', async () => {
    const report = await readBoardWithReport(board('greenhouse'), mockFetch(() => json(greenhouseFixture)).options);
    assert.equal(report.skipped, 1); assert.deepEqual(report.skipReasons, { JOB_URL_INVALID: 1 });
    const [job] = report.jobs;
    assert.equal(job!.externalId, '8860302002');
    assert.equal(job!.title, 'Backend Engineer & SRE');
    assert.equal(job!.location, 'Remote, Spain');
    assert.equal(job!.jobUrl, 'https://job-boards.greenhouse.io/acme/jobs/8860302002');
    assert.equal(job!.applyUrl, job!.jobUrl);
    assert.equal(job!.description, 'We build & ship.\n\n• Go\n• Postgres\n\nSalary €90k – 🚀');
    assert.doesNotMatch(job!.description!, /[<>]|&[a-z#0-9]+;|alert/);
    assert.equal(job!.postedAt, '2026-09-30T13:00:00.000Z');
    assert.equal(job!.updatedAt, '2026-10-02T15:31:50.000Z');
    assert.deepEqual(job!.raw, greenhouseFixture.jobs[0]);
  });

  it('lever: uses plain fields, includes every list section, and maps EU postings', async () => {
    const jobs = await readBoard(board('lever', 'eu'), mockFetch(() => json(leverFixture)).options);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0]!.description, 'Intro bold\n\nWhat you will do\n\n• Ship features\n• Review & mentor\n\nRequirements\n\n• TypeScript\n\nBenefits');
    assert.equal(jobs[0]!.location, 'Lisbon');
    assert.equal(jobs[0]!.postedAt, new Date(1_759_400_000_000).toISOString());
    assert.equal(jobs[0]!.applyUrl, 'https://jobs.eu.lever.co/acme/681fbc53-1e34-4a46-8677-3a78118674eb/apply');
    assert.equal(jobs[1]!.location, 'Berlin / Paris');
    assert.equal(jobs[1]!.postedAt, null, 'epoch 12ms is not a plausible posting date');
    assert.equal(jobs[1]!.description, null);
    assert.equal(jobs[1]!.applyUrl, null);
  });

  it('ashby: surfaces only listed jobs, prefers plain text, and recovers ids from the job URL', async () => {
    const report = await readBoardWithReport(board('ashby'), mockFetch(() => json(ashbyFixture)).options);
    assert.equal(report.unlisted, 1); assert.equal(report.skipped, 0);
    const [first, second] = report.jobs;
    assert.equal(first!.description, 'Hi there\n\nBye');
    assert.equal(first!.postedAt, '2024-03-04T14:29:08.532Z');
    assert.equal(second!.externalId, '0b6c3c2e-1111-4222-8333-944455556666');
    assert.equal(second!.description, 'Only HTML');
    assert.equal(second!.applyUrl, null);
  });
});

describe('database caps and hostile values', () => {
  it('skips an Ashby job whose URL has a malformed escape instead of failing the feed', async () => {
    const report = await readBoardWithReport(board('ashby'), mockFetch(() => json({ jobs: [ashbyFixture.jobs[0], { title: 'Bad escape', isListed: true, jobUrl: 'https://jobs.ashbyhq.com/acme/%E0%A4%A' }] })).options);
    assert.equal(report.jobs.length, 1); assert.deepEqual(report.skipReasons, { ID_INVALID: 1 });
  });

  it('keeps ids, titles and locations within the varchar(300) columns without splitting surrogate pairs', async () => {
    const long = '🚀'.repeat(400);
    const report = await readBoardWithReport(board('lever'), mockFetch(() => json([
      { id: 'a'.repeat(300), text: long, hostedUrl: 'https://jobs.lever.co/acme/a', categories: { location: `${'x'.repeat(299)}🚀🚀` } },
      { id: 'b'.repeat(301), text: 'Too long id', hostedUrl: 'https://jobs.lever.co/acme/b' },
      { id: 'ñ-id', text: 'Non-ASCII id', hostedUrl: 'https://jobs.lever.co/acme/c' },
    ])).options);
    assert.deepEqual(report.skipReasons, { ID_INVALID: 2 });
    const [job] = report.jobs;
    assert.equal(job!.externalId.length, 300);
    assert.equal(Array.from(job!.title).length, 300); assert.equal(job!.title, '🚀'.repeat(300));
    assert.equal(Array.from(job!.location!).length, 300); assert.ok(job!.location!.endsWith('x🚀'));
    assert.doesNotMatch(job!.title + job!.location, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('helpers', () => {
  it('parses only plausible ISO or epoch-millisecond dates', () => {
    const now = Date.UTC(2026, 9, 3);
    assert.equal(sourceDate('2026-10-02T11:31:50-04:00', now), '2026-10-02T15:31:50.000Z');
    assert.equal(sourceDate('2026-10-02', now), '2026-10-02T00:00:00.000Z');
    assert.equal(sourceDate(1_700_000_000_000, now), '2023-11-14T22:13:20.000Z');
    for (const bad of ['1', 'yesterday', 'Oct 2 2026', '2026-13-45', '', null, undefined, {}, 1_700_000_000, Number.NaN, Date.UTC(2030, 0, 1), '1990-01-01']) assert.equal(sourceDate(bad, now), null, String(bad));
  });

  it('accepts only https URLs without credentials and strips fragments', () => {
    assert.equal(sourceUrlField('https://jobs.lever.co/a/b#x'), 'https://jobs.lever.co/a/b');
    for (const bad of ['http://jobs.lever.co/a', 'javascript:alert(1)', 'https://user:pw@jobs.lever.co/a', '/relative', 'https://localhost/a', 42, null]) assert.equal(sourceUrlField(bad), null, String(bad));
  });

  it('decodes entities once and converts HTML without leaving markup', () => {
    assert.equal(decodeEntities('&amp;lt;b&amp;gt; &#39;x&#39; &unknown; &#0; &#xD800;'), "&lt;b&gt; 'x' &unknown;  ");
    assert.equal(htmlToText('<style>p{}</style><p>One<br>Two</p><!-- c --><h2>Three</h2>'), 'One\nTwo\n\nThree');
  });
});
