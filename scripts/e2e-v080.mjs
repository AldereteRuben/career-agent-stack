#!/usr/bin/env node
/* global document */
// Focused T08 browser coverage. Run only with an isolated dashboard/API pair:
// V080_ISOLATED=1 V080_UI_URL=http://127.0.0.1:<port> V080_API_URL=http://127.0.0.1:<port> V080_TOKEN=<isolated-token> node scripts/e2e-v080.mjs
// The dashboard APIs used by this flow are deterministic route fixtures; only sign-in and health
// checks reach the explicitly supplied isolated stack. The script never starts or touches 3000/3001.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(resolve(fileURLToPath(new URL('../apps/api/package.json', import.meta.url))));
const { chromium } = require('playwright');
const uiUrl = process.env.V080_UI_URL ?? '';
const apiUrl = process.env.V080_API_URL ?? '';
const token = process.env.V080_TOKEN ?? '';
const isolated = process.env.V080_ISOLATED === '1';
const artifacts = process.env.V080_ARTIFACTS ?? resolve('output/playwright/e2e-v080-manual');

function checkedLoopbackUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an explicit http:// loopback URL supplied for the isolated stack.`); }
  assert.equal(url.protocol, 'http:', `${name} must use http on the local isolated stack`);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), `${name} must use a loopback host`);
  assert.ok(url.port, `${name} must include its isolated port`);
  assert.ok(!['3000', '3001'].includes(url.port), `${name} may not use a shared-workspace port`);
  return url;
}

async function signIn(page, token) {
  await page.goto(new URL('/login', ui).toString(), { waitUntil: 'domcontentloaded' });
  const tokenInput = page.getByLabel(/^(Código de acceso|Sign-in code)$/i).first();
  await tokenInput.fill(token);
  const submit = page.getByRole('button', { name: /^(Entrar|Sign in|Iniciar sesión|Continue|Continuar|Open my workspace)$/i }).first();
  if (await submit.isVisible().catch(() => false)) await submit.click(); else await tokenInput.press('Enter');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
}
async function setLocale(page, locale) {
  const button = locale === 'es' ? /^Español$/ : /^English$/;
  if (!(await page.locator('html').getAttribute('lang') ?? '').startsWith(locale)) await page.getByRole('button', { name: button }).first().click();
  await page.waitForFunction((wanted) => document.documentElement.lang.startsWith(wanted), locale);
}
async function waitEnabled(locator, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !(await locator.isEnabled().catch(() => false))) await delay(100);
  assert.equal(await locator.isEnabled(), true, message);
}

if (!isolated || !token || !uiUrl || !apiUrl) {
  console.error('Refusing to run without V080_ISOLATED=1, V080_TOKEN, V080_UI_URL and V080_API_URL for a coordinator-provided isolated stack.');
  process.exit(2);
}
const ui = checkedLoopbackUrl(uiUrl, 'V080_UI_URL');
const api = checkedLoopbackUrl(apiUrl, 'V080_API_URL');
assert.notEqual(ui.port, api.port, 'Dashboard and API must use separate isolated ports');

const responseJson = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
const ids = { legacy: '11111111-1111-4111-8111-111111111111', paused: '22222222-2222-4222-8222-222222222222', failed: '33333333-3333-4333-8333-333333333333', partial: '55555555-5555-4555-8555-555555555555', created: '44444444-4444-4444-8444-444444444444', job: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const iso = new Date(Date.now() - 3_600_000).toISOString();
const future = new Date(Date.now() + 3_600_000).toISOString();
const searches = [
  { id: ids.legacy, role: 'Legacy QA', company: null, location: null, workMode: 'any', frequencyHours: 24, enabled: true, autoPrepare: false, language: 'en', revision: 1, matcherVersion: 1, providerIds: ['remotive', 'arbeitnow'], includeRelated: false, lastRunAt: iso, nextRunAt: null, lastRunStatus: 'PARTIAL', lastResultCount: 1, lastNewCount: 1, lastError: null, latestRun: null },
  { id: ids.paused, role: 'Paused Designer', company: null, location: 'Spain', workMode: 'remote', frequencyHours: 24, enabled: false, autoPrepare: false, language: 'en', revision: 1, matcherVersion: 2, providerIds: ['remotive'], includeRelated: false, lastRunAt: iso, nextRunAt: null, lastRunStatus: 'SUCCEEDED', lastResultCount: 0, lastNewCount: 0, lastError: null, latestRun: { id: 'run-paused', status: 'SUCCEEDED', finishedAt: iso, error: null, sources: [{ provider: 'remotive', status: 'SUCCEEDED', coverage: 'COMPLETE', fetchedAt: iso, error: null }] } },
  { id: ids.failed, role: 'Failed Analyst', company: null, location: null, workMode: 'any', frequencyHours: 24, enabled: true, autoPrepare: true, language: 'en', revision: 1, matcherVersion: 2, providerIds: ['arbeitnow'], includeRelated: false, lastRunAt: iso, nextRunAt: future, lastRunStatus: 'FAILED', lastResultCount: 2, lastNewCount: 0, lastError: 'Source timeout', latestRun: { id: 'run-failed', status: 'FAILED', finishedAt: iso, error: 'Source timeout', sources: [{ provider: 'arbeitnow', status: 'FAILED', coverage: 'BOUNDED', fetchedAt: iso, error: 'Source timeout' }] } },
  { id: ids.partial, role: 'Service Designer', company: null, location: null, workMode: 'any', frequencyHours: 24, enabled: true, autoPrepare: false, language: 'en', revision: 1, matcherVersion: 2, providerIds: ['remotive', 'himalayas'], includeRelated: false, lastRunAt: iso, nextRunAt: iso, lastRunStatus: 'PARTIAL', lastResultCount: 21, lastNewCount: 21, lastError: null, latestRun: { id: 'run-partial', status: 'PARTIAL', finishedAt: null, error: null, sources: [{ provider: 'remotive', status: 'CACHED', coverage: 'COMPLETE', fetchedAt: iso, nextFetchAt: future, error: null }, { provider: 'himalayas', status: 'RUNNING', coverage: 'UNKNOWN', fetchedAt: null, error: null }] } },
];
let saveBody;
const saveBodies = [];
let patchBodies = [];
let createdSearch;
let createRequests = 0;
let refreshRequests = 0;
let selectedJobDecision = 'UNREVIEWED';
let jobSeenAt = null;
let arrivalPublished = false;
const job = (index = 0) => ({ id: index === 0 ? ids.job : `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, title: index === 0 ? 'Product Designer' : `Design role ${index}`, company: 'Example Studio', location: 'Remote · Spain', canonicalUrl: `https://example.test/jobs/design-${index}`, seenAt: index === 0 ? jobSeenAt : null, shortlistDecision: index === 0 ? selectedJobDecision : 'UNREVIEWED', matchedAt: iso, searchScore: 92, searchReasons: ['ROLE_EXACT', 'LOCATION_COMPATIBLE', 'WORK_MODE_MATCH'], locationStatus: 'compatible', groupId: null, duplicateCount: 1, searchIds: [ids.legacy], ...(index === 0 ? { applicationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', documentId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', applicationState: 'IN_PROGRESS', documentApprovalStatus: 'PENDING_REVIEW', identityConflict: true } : {}), sources: [{ provider: 'remotive', name: 'Remotive', url: `https://example.test/jobs/design-${index}`, postedAt: iso, fetchedAt: iso }] });
const pagedResults = (offset, view) => {
  const all = Array.from({ length: arrivalPublished ? 22 : 21 }, (_, index) => job(index));
  const filtered = view === 'new' ? all.filter((item) => !item.seenAt && item.shortlistDecision === 'UNREVIEWED') : view === 'saved' ? all.filter((item) => item.shortlistDecision === 'SHORTLISTED') : view === 'archived' ? all.filter((item) => item.shortlistDecision === 'ARCHIVED') : all;
  return { items: filtered.slice(offset, offset + 20), total: filtered.length, resultVersion: `fixture-${arrivalPublished ? 'partial-2' : 'partial-1'}-${view}`, latestRun: null };
};
const summary = { boards: [], recentJobs: [], recentApplications: [], pendingFacts: 0, unansweredItems: 0, applicationCounts: {}, approvedSourceCount: 0, boardCount: 0, savedSearchCount: 4, activeSearchCount: 3, totalJobs: 0, activeApplications: 0, profileCompletion: { percent: 0, completed: 0, total: 6, missing: ['fullName', 'email', 'country', 'targetTitles', 'workModes', 'approvedFact'], approvedFactCount: 0, pendingFactCount: 0 } };

const browser = await chromium.launch({ headless: process.env.V080_HEADED !== '1' });
let context;
try {
  await mkdir(artifacts, { recursive: true, mode: 0o700 });
  const healthResponse = await browser.newPage().then(async (page) => {
    const response = await page.request.get(new URL('/healthz', api).toString(), { timeout: 5000 });
    const body = await response.json().catch(() => ({}));
    assert.ok(response.ok() && body.status === 'ok', `Isolated API health check failed (${response.status()})`);
    await page.close();
    return body;
  });
  console.log(`T08 isolated stack confirmed · API ${healthResponse.version ?? 'ready'} · ports ${ui.port}/${api.port}`);

  // A real v2 search uses a seeded, disposable Remotive cache entry. This exercises asynchronous
  // create → source progress → result persistence without making any provider network request.
  const realContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-GB' });
  const realPage = await realContext.newPage(); realPage.setDefaultTimeout(15_000);
  await signIn(realPage, token);
  const realRequest = realContext.request;
  const marker = process.env.V080_REAL_MARKER ?? `v080-${Date.now()}`;
  const createdResponse = await realRequest.post(new URL('/api/v1/job-searches', ui).toString(), {
    headers: { Origin: ui.origin },
    data: { role: 'T08 Cached Product Designer', company: marker, location: null, workMode: 'any', frequencyHours: 24, enabled: true, autoPrepare: false, language: 'en', matcherVersion: 2, providerIds: ['remotive'], includeRelated: false, idempotencyKey: randomUUID() },
  });
  assert.equal(createdResponse.status(), 201, `Cached flow create returned ${createdResponse.status()}: ${await createdResponse.text()}`);
  const createdPayload = await createdResponse.json();
  assert.ok(createdPayload.runId, 'v2 create should enqueue a background run and return promptly');
  const observedStatuses = new Set();
  let finishedSearch;
  const searchEndpoint = new URL('/api/v1/job-searches', ui).toString();
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const listResponse = await realRequest.get(searchEndpoint);
    assert.ok(listResponse.ok(), `Could not read search progress (${listResponse.status()})`);
    const list = await listResponse.json();
    finishedSearch = list.searches.find((item) => item.id === createdPayload.search.id);
    const status = finishedSearch?.latestRun?.status;
    if (status) observedStatuses.add(status);
    if (finishedSearch?.latestRun?.finishedAt) break;
    await delay(500);
  }
  assert.ok(finishedSearch?.latestRun?.finishedAt, `Cached search did not finish; observed ${[...observedStatuses].join(', ')}`);
  const cacheSource = finishedSearch.latestRun.sources.find((source) => source.provider === 'remotive');
  assert.equal(cacheSource?.status, 'CACHED', 'The disposable provider cache must be used by the background worker');
  const realResultsResponse = await realRequest.get(new URL(`/api/v1/job-searches/${createdPayload.search.id}/results?view=all&sort=relevance&offset=0&limit=20`, ui).toString());
  assert.ok(realResultsResponse.ok(), `Cached search result request failed (${realResultsResponse.status()})`);
  const realResults = await realResultsResponse.json();
  assert.ok(realResults.total >= 1 && realResults.items.some((item) => item.title === 'T08 Cached Product Designer'), 'Cached provider results should persist and be returned by the result endpoint');
  await realPage.goto(new URL(`/searches?search=${createdPayload.search.id}&view=all`, ui).toString());
  await realPage.getByRole('link', { name: 'T08 Cached Product Designer' }).waitFor();
  await realPage.screenshot({ path: join(artifacts, 'cached-provider-result.png'), fullPage: true });
  console.log(`✓ Real cached-provider create/progress/results · ${[...observedStatuses].join(' → ')} · screenshot ${join(artifacts, 'cached-provider-result.png')}`);
  const sessionCookies = await realContext.cookies(ui.toString());
  await realContext.close();

  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'es-ES' });
  await context.addCookies(sessionCookies);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));

  await page.route('**/api/v1/summary', (route) => responseJson(route, summary));
  await page.route('**/api/v1/documents', (route) => responseJson(route, [{ id: 'doc-pending', name: 'Resume to review', revision: 1, approvalStatus: 'PENDING_REVIEW', reviewRequired: true }]));
  await page.route('**/api/v1/job-searches**', async (route) => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (request.method() === 'GET' && path === '/api/v1/job-searches') return responseJson(route, { searches, coverage: {} });
    if (request.method() === 'GET' && (path === '/api/v1/job-searches/results' || /\/api\/v1\/job-searches\/[^/]+\/results$/.test(path))) {
      const view = url.searchParams.get('view') ?? 'all';
      const singleSearch = searches.find((search) => path.includes(search.id));
      if (singleSearch && [ids.paused, ids.failed].includes(singleSearch.id)) return responseJson(route, { items: [], total: 0, resultVersion: `fixture-${path}-${view}`, latestRun: singleSearch.latestRun ?? null });
      if (singleSearch && singleSearch.id === ids.legacy) return responseJson(route, { items: view === 'new' && jobSeenAt ? [] : [job()], total: view === 'new' && jobSeenAt ? 0 : 1, resultVersion: `fixture-legacy-${view}-${jobSeenAt ? 'reviewed' : 'new'}`, latestRun: null });
      const offset = Number(url.searchParams.get('offset') ?? '0');
      return responseJson(route, pagedResults(offset, view));
    }
    const searchMatch = path.match(/\/api\/v1\/job-searches\/([^/]+)$/);
    if (request.method() === 'POST' && path === '/api/v1/job-searches') {
      saveBody = request.postDataJSON(); saveBodies.push(saveBody); createRequests++;
      if (!createdSearch) {
        createdSearch = { id: ids.created, role: saveBody.role, company: saveBody.company, location: saveBody.location, workMode: saveBody.workMode, frequencyHours: saveBody.frequencyHours, enabled: saveBody.enabled, autoPrepare: saveBody.autoPrepare, language: saveBody.language, revision: 1, matcherVersion: saveBody.matcherVersion, providerIds: saveBody.providerIds, includeRelated: saveBody.includeRelated, lastRunAt: null, nextRunAt: saveBody.enabled ? iso : null, lastRunStatus: saveBody.enabled ? 'QUEUED' : null, lastResultCount: 0, lastNewCount: 0, lastError: null, latestRun: saveBody.enabled ? { id: 'run-created', status: 'QUEUED', finishedAt: null, error: null, sources: [] } : null };
        searches.push(createdSearch);
        return route.abort('connectionreset'); // The mock persisted the request, but the first response is lost.
      }
      assert.equal(saveBody.idempotencyKey, saveBodies[0].idempotencyKey, 'The retried POST must reuse the draft idempotency key');
      return responseJson(route, { search: createdSearch, runId: 'run-created', refresh: null }, 201);
    }
    if (request.method() === 'PATCH' && searchMatch) {
      const body = request.postDataJSON(); patchBodies.push(body);
      const existing = searches.find((search) => search.id === searchMatch[1]);
      if (existing) Object.assign(existing, body, { revision: existing.revision + 1, matcherVersion: body.matcherVersion ?? existing.matcherVersion, providerIds: body.providerIds ?? existing.providerIds });
      return responseJson(route, { search: existing, runId: null, refresh: null });
    }
    if (request.method() === 'POST' && path.endsWith('/refresh')) { refreshRequests++; return responseJson(route, { runId: 'run-refresh' }, 202); }
    if (request.method() === 'POST' && path.endsWith('/review')) { jobSeenAt = new Date().toISOString(); return responseJson(route, { ok: true }); }
    return route.continue();
  });
  await page.route('**/api/v1/jobs/*/shortlist', async (route) => {
    selectedJobDecision = route.request().postDataJSON().decision;
    return responseJson(route, { id: ids.job, shortlistDecision: selectedJobDecision });
  });

  await page.goto(new URL('/', ui).toString());
  await setLocale(page, 'es');
  await page.getByText(/TU BANDEJA DE HOY|TODAY’S JOB INBOX/i).waitFor();
  await page.getByText('1 CV pendientes de revisión', { exact: true }).waitFor();
  await page.getByRole('link', { name: /Review resumes|Revisar CV/i }).waitFor();
  await page.screenshot({ path: join(artifacts, 'home-inbox-es.png'), fullPage: true });
  await page.goto(new URL('/searches?search=all&view=new', ui).toString());
  await page.locator('#saved-searches-title').waitFor();
  await page.getByText(/4 (búsquedas guardadas|saved searches)/i).first().waitFor();
  await page.getByRole('link', { name: /Product Designer/ }).waitFor();
  await page.getByText(/Checking your sources|Buscando en tus fuentes/).waitFor();
  await page.getByText(/Source response complete|Respuesta de la fuente completa/).waitFor();
  await page.getByText(/Can be checked again|Puede volver a consultarse/).waitFor();
  const appLink = page.locator('a[href^="/applications?id="]').first();
  await appLink.waitFor();
  assert.match(await appLink.getAttribute('href'), /returnTo=.*search%3Dall/);
  await page.getByText(/Submission in progress|Envío en curso/).waitFor();
  await page.getByText(/Waiting for review|Pendiente de revisión/).waitFor();
  await page.getByText(/This job has records with different decisions or applications|Esta oferta tiene registros con decisiones o candidaturas diferentes/).waitFor();
  await page.getByText(/Checked|Comprobada/).first().waitFor();
  const legacyRefresh = page.getByRole('listitem').filter({ hasText: 'Legacy QA' }).getByRole('button', { name: /Refresh results|Actualizar resultados/ });
  assert.equal(await legacyRefresh.isEnabled(), true, 'Legacy PARTIAL without a finished run is not indefinitely in flight');
  const partialRefresh = page.getByRole('listitem').filter({ hasText: 'Service Designer' }).getByRole('button', { name: /Refresh results|Actualizar resultados/ });
  assert.equal(await partialRefresh.isEnabled(), false, 'An unfinished PARTIAL run stays in flight until it has finished');
  const pausedRefresh = page.getByRole('listitem').filter({ hasText: 'Paused Designer' }).getByRole('button', { name: /Refresh results|Actualizar resultados/ });
  assert.equal(await pausedRefresh.isEnabled(), true, 'Paused searches can refresh results');
  await pausedRefresh.click();
  const scheduledRefresh = page.getByRole('listitem').filter({ hasText: 'Failed Analyst' }).getByRole('button', { name: /Refresh results|Actualizar resultados/ });
  await waitEnabled(scheduledRefresh, 'A future schedule is not a provider cooldown');
  await scheduledRefresh.click();
  assert.equal(refreshRequests, 2);
  const pages = page.getByRole('navigation', { name: /Result pages|Páginas de resultados/ });
  await pages.getByRole('button', { name: /Next|Siguiente/ }).click();
  await page.getByRole('link', { name: 'Design role 20', exact: true }).waitFor();
  const focusBeforeArrival = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
  arrivalPublished = true;
  await page.getByRole('button', { name: /Show new jobs|Mostrar nuevas ofertas/ }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Design role 20', exact: true }).count(), 1, 'Background arrivals must leave the second-page rows in place until requested');
  assert.equal(await page.getByRole('link', { name: 'Design role 21', exact: true }).count(), 0, 'New arrivals stay staged until the user selects the banner');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ''), focusBeforeArrival, 'Background arrivals must not move keyboard focus');
  await page.getByRole('button', { name: /Show new jobs|Mostrar nuevas ofertas/ }).click();
  await page.getByRole('link', { name: 'Design role 21', exact: true }).waitFor();

  await page.getByRole('button', { name: 'Legacy QA', exact: true }).click();
  await page.getByRole('button', { name: /Mark reviewed|Marcar revisada/, exact: true }).click();
  await page.getByRole('heading', { name: /You are up to date|Estás al día/ }).waitFor();
  assert.ok(jobSeenAt, 'Per-search review should be sent only after the person marks the result reviewed');

  await page.getByRole('button', { name: /Paused Designer/ }).click();
  await page.getByRole('heading', { name: 'This search is paused' }).waitFor().catch(async () => page.getByRole('heading', { name: 'Esta búsqueda está en pausa' }).waitFor());
  await page.getByRole('button', { name: /Resume search|Reanudar búsqueda/ }).waitFor();
  await page.getByRole('button', { name: /Failed Analyst/ }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: /Matching jobs.*Failed Analyst|Ofertas encontradas.*Failed Analyst/ }).waitFor();
  await page.getByRole('heading', { name: /A source did not respond|Una fuente no respondió/ }).waitFor();
  await page.getByRole('button', { name: /^(Edit search|Editar búsqueda)$/ }).click();
  const prepConsent = page.getByRole('checkbox', { name: /Also prepare a resume|Preparar también un CV/ });
  assert.equal(await prepConsent.isChecked(), true);
  await page.getByLabel(/Role or keywords|Puesto o palabras clave/).fill('Changed Analyst');
  assert.equal(await prepConsent.isChecked(), false, 'Changed criteria must clear prior preparation consent');
  await prepConsent.check();
  await page.getByRole('button', { name: /Save changes|Guardar cambios/, exact: true }).click();
  assert.equal(patchBodies.at(-1).autoPrepare, true, 'Preparation can continue only after the person opts in again');

  const legacyCard = page.getByRole('listitem').filter({ hasText: 'Legacy QA' });
  await legacyCard.getByRole('button', { name: 'Legacy QA', exact: true }).click();
  await legacyCard.getByRole('button', { name: /^(Edit|Editar)$/ }).click();
  const consent = page.getByRole('checkbox', { name: /Use improved matching and newer sources|Probar coincidencias mejoradas y fuentes nuevas/ });
  assert.equal(await consent.isChecked(), false, 'Legacy search upgrade must require an explicit opt-in');
  await page.getByRole('button', { name: /Save changes|Guardar cambios/, exact: true }).click();
  assert.equal(patchBodies.at(-1).matcherVersion, undefined, 'Editing a legacy search without consent must preserve its matcher version');
  assert.equal(searches.find((search) => search.id === ids.legacy).matcherVersion, 1);

  await legacyCard.getByRole('button', { name: 'Legacy QA', exact: true }).click();
  await legacyCard.getByRole('button', { name: /^(Edit|Editar)$/ }).click();
  await page.getByRole('checkbox', { name: /Use improved matching and newer sources|Probar coincidencias mejoradas y fuentes nuevas/ }).check();
  const himalayas = page.getByRole('checkbox', { name: 'Himalayas', exact: true });
  await himalayas.check();
  await page.getByRole('button', { name: /Save changes|Guardar cambios/, exact: true }).click();
  const upgrade = patchBodies.at(-1);
  assert.equal(upgrade.matcherVersion, 2);
  assert.ok(upgrade.providerIds.includes('himalayas'));
  assert.equal(searches.find((search) => search.id === ids.legacy).matcherVersion, 2);

  await page.getByRole('button', { name: /New search|Nueva búsqueda/, exact: true }).click();
  await page.getByLabel(/Role or keywords|Puesto o palabras clave/).fill('Service Designer');
  assert.equal(await page.getByLabel(/Work mode|Modalidad/).inputValue(), 'any', 'Modality is available in the first-use form');
  await page.getByText(/When saved, Himalayas receives only your role|Al guardar, Himalayas recibe solo/).waitFor();
  await page.getByText(/Sources and options|Fuentes y opciones/).click();
  assert.equal(await page.getByLabel(/Refresh frequency|Frecuencia de actualización/).inputValue(), '24');
  assert.equal(await page.getByRole('checkbox', { name: /Also prepare a resume|Preparar también un CV/ }).isChecked(), false);
  await page.getByRole('button', { name: /Search and save|Buscar y guardar/, exact: true }).click();
  const roleAfterLostReply = await page.getByLabel(/Role or keywords|Puesto o palabras clave/).inputValue();
  assert.equal(roleAfterLostReply, 'Service Designer', 'A lost create response must preserve the draft for retry');
  assert.equal(createRequests, 1);
  await page.getByRole('button', { name: /Search and save|Buscar y guardar/, exact: true }).click();
  assert.equal(createRequests, 2);
  assert.equal(saveBodies[1].idempotencyKey, saveBodies[0].idempotencyKey, 'Create retry reuses the same idempotency key');
  assert.equal(saveBody.matcherVersion, 2);
  assert.ok(saveBody.providerIds.includes('himalayas'));
  assert.equal(saveBody.includeRelated, false);
  assert.equal(saveBody.frequencyHours, 24);
  assert.equal(saveBody.autoPrepare, false);
  assert.match(saveBody.idempotencyKey, /^[a-f0-9-]{36}$/i);

  const viewportWidths = [320, 390, 768, 1096, 1440];
  for (const width of viewportWidths) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false, `Spanish search page must not overflow horizontally at ${width}px`);
    if (width === 320) await page.screenshot({ path: join(artifacts, 'searches-mobile-es.png'), fullPage: true });
    if (width === 320 || width === 1440) await page.screenshot({ path: join(artifacts, `searches-${width}-es.png`) });
  }
  await page.setViewportSize({ width: 320, height: 900 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  const textZoom = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, overflow: [...document.querySelectorAll('body *')].map((element) => ({ tag: element.tagName, className: typeof element.className === 'string' ? element.className : '', text: element.textContent?.trim().slice(0, 70), right: Math.round(element.getBoundingClientRect().right), width: Math.round(element.getBoundingClientRect().width) })).filter((element) => element.width > 0 && element.right > document.documentElement.clientWidth + 1).slice(0, 8) }));
  assert.ok(textZoom.scrollWidth <= textZoom.clientWidth + 1, `Search page must reflow without horizontal overflow at 200% text size: ${JSON.stringify(textZoom)}`);
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await setLocale(page, 'en');
  await page.locator('#saved-searches-title').waitFor();
  await page.getByText('Search saved. You can review jobs while the search continues.', { exact: true }).waitFor();
  assert.equal(await page.getByText('Búsqueda guardada. Puedes revisar las ofertas mientras continúa la consulta.', { exact: true }).count(), 0);
  for (const width of viewportWidths) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false, `English search page must not overflow horizontally at ${width}px`);
    if (width === 320) await page.screenshot({ path: join(artifacts, 'searches-mobile-en.png'), fullPage: true });
    if (width === 320 || width === 1440) await page.screenshot({ path: join(artifacts, `searches-${width}-en.png`) });
  }
  assert.deepEqual(browserErrors, [], `Unexpected browser errors: ${browserErrors.join(' | ')}`);
  console.log(`✓ Home inbox, search states, review, v1 consent, v2 defaults, consent retry, keyboard, ES/EN, widths ${viewportWidths.join('/')}px and 200% text size · screenshots ${artifacts}`);
} finally {
  await context?.close().catch(() => undefined);
  await browser.close();
}
