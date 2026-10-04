/* global document, window */
// Browser regression coverage for the guided application journey (usability findings U08 and U10).
//
// Import and call from a runner that already owns an isolated stack and a signed-in session:
//   import { checkApplicationUsability } from './e2e-v081-applications.mjs';
//   await checkApplicationUsability({ browser, uiUrl: stack.uiUrl, cookies: await realContext.cookies(stack.uiUrl), artifacts });
//
// The module opens and closes its own browser context with the supplied session cookies. Only the session check, pages and
// static assets reach the isolated dashboard; every domain API the journey uses is a deterministic Playwright route over
// fictional fixtures, and any other origin is aborted. It refuses shared-workspace ports 3000/3001 and non-loopback hosts,
// never starts a stack, never reads workspace files and blocks every mutation except the two fixture endpoints it models.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const SHARED_PORTS = new Set(['3000', '3001']);
const WIDTHS = [320, 390, 1096];
const RETURN_TO = '/searches?search=all&view=saved';
const ISO = '2026-09-28T09:30:00.000Z';

/** Accepts only an explicit http loopback URL with its own isolated port. */
export function isolatedUiUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('uiUrl must be an explicit http:// loopback URL for the isolated stack.'); }
  assert.equal(url.protocol, 'http:', 'uiUrl must use http on the local isolated stack');
  assert.ok(LOOPBACK_HOSTS.has(url.hostname), `uiUrl must use a loopback host, not ${url.hostname}`);
  assert.ok(url.port, 'uiUrl must include its isolated port');
  assert.ok(!SHARED_PORTS.has(url.port), `uiUrl may not use the shared-workspace port ${url.port}`);
  return url;
}

function checkedCookies(cookies) {
  assert.ok(Array.isArray(cookies) && cookies.length > 0, 'cookies must contain the isolated session cookies');
  for (const cookie of cookies) {
    const host = cookie.url ? new URL(cookie.url).hostname : String(cookie.domain ?? '').replace(/^\./, '');
    assert.ok(LOOPBACK_HOSTS.has(host) || host === '::1', `Session cookie ${cookie.name} belongs to ${host || 'an unknown host'}, not the loopback stack`);
  }
  return cookies;
}

// Fictional identifiers and copy only: no real people, employers or job posts.
const ids = {
  identityJob: 'e2e08100-0000-4000-8000-000000000001', identityApp: 'e2e08100-0000-4000-8000-0000000000a1', identityDoc: 'e2e08100-0000-4000-8000-0000000000d1',
  experienceJob: 'e2e08100-0000-4000-8000-000000000002', experienceApp: 'e2e08100-0000-4000-8000-0000000000a2',
  textJob: 'e2e08100-0000-4000-8000-000000000003', textApp: 'e2e08100-0000-4000-8000-0000000000a3',
  mixedJob: 'e2e08100-0000-4000-8000-000000000004', mixedApp: 'e2e08100-0000-4000-8000-0000000000a4',
  readyJob: 'e2e08100-0000-4000-8000-000000000005', readyApp: 'e2e08100-0000-4000-8000-0000000000a5', readyDoc: 'e2e08100-0000-4000-8000-0000000000d5',
  uncertainJob: 'e2e08100-0000-4000-8000-000000000006', uncertainApp: 'e2e08100-0000-4000-8000-0000000000a6', uncertainDoc: 'e2e08100-0000-4000-8000-0000000000d6',
  closedJob: 'e2e08100-0000-4000-8000-000000000007', closedApp: 'e2e08100-0000-4000-8000-0000000000a7',
  profileRevision: 'e2e08100-0000-4000-8000-0000000000f0', fact: 'e2e08100-0000-4000-8000-0000000000f1',
};
const LONG_TITLE = 'Responsable ficticia de investigación de servicios públicos digitales y accesibilidad para equipos multidisciplinares';
const jobs = {
  [ids.identityJob]: { title: 'Diseñadora de servicios (ficticia)', company: 'Estudio Ficticio Norte', description: 'Puesto ficticio: investigación con personas usuarias, prototipos y talleres.', applicationId: null },
  [ids.experienceJob]: { title: 'Analista de producto (ficticio)', company: 'Cooperativa Ejemplo Sur', description: 'Puesto ficticio: análisis de datos de producto y entrevistas.', applicationId: ids.experienceApp },
  [ids.textJob]: { title: 'Coordinación de proyectos (ficticia)', company: 'Taller Imaginario', description: null, applicationId: ids.textApp },
  [ids.mixedJob]: { title: 'Soporte técnico (ficticio)', company: 'Laboratorio Inventado', description: null, applicationId: ids.mixedApp },
  [ids.readyJob]: { title: LONG_TITLE, company: 'Agencia Ficticia de Servicios Digitales del Norte', description: 'Puesto ficticio.', applicationId: ids.readyApp },
  [ids.uncertainJob]: { title: 'Redacción técnica (ficticia)', company: 'Editorial Supuesta', description: 'Puesto ficticio.', applicationId: ids.uncertainApp },
  [ids.closedJob]: { title: 'Atención al cliente (ficticia)', company: 'Comercio Hipotético', description: 'Puesto ficticio.', applicationId: ids.closedApp },
};
const approvedFact = { id: ids.fact, kind: 'experience', statement: 'Coordiné doce entrevistas ficticias con personas usuarias para rediseñar un servicio.', tags: ['investigación', 'prototipos'], details: null, approvalStatus: 'USER_APPROVED' };
const selectedFact = { id: ids.fact, statement: approvedFact.statement, reason: 'Coincide con el anuncio: investigación' };

function jobDetail(jobId) {
  const job = jobs[jobId];
  if (!job) return null;
  return {
    job: { id: jobId, title: job.title, company: job.company, location: 'Remoto · España', canonicalUrl: `https://example.test/ofertas/${jobId}`, fitScore: null, evidenceCoverage: 40, eligibility: 'NEEDS_REVIEW', reasons: [], shortlistDecision: 'SHORTLISTED', availability: 'OPEN', createdAt: ISO, discoveredAt: null, seenAt: ISO, provisional: true, match: null },
    snapshots: job.description ? [{ id: `${jobId.slice(0, -2)}5e`, title: job.title, descriptionText: job.description, fetchedAt: ISO }] : [],
    sources: [], searchSources: [],
    applications: job.applicationId ? [{ id: job.applicationId, state: 'REVIEW_REQUIRED', recruitmentStage: 'NO_RESPONSE', updatedAt: ISO }] : [],
  };
}

const profileFixture = ({ identity, facts }) => ({ revision: 3, locale: 'es', profile: { identity, preferences: { targetTitles: ['Diseño de servicios'], workModes: ['remote'] } }, facts, answers: [] });
const identityReady = (profile) => Boolean(profile.profile.identity?.fullName?.trim() && profile.profile.identity?.email?.trim());
const filledIdentity = { fullName: 'Alex Ficticio', email: 'alex.ficticio@example.test' };

/** Mirrors the POST /api/v1/preparations contract in apps/api/src/application-preparation.ts. */
function preparationResult(state, jobId) {
  const job = jobs[jobId];
  const base = { status: 'NEEDS_REVIEW', jobId, company: job.company, title: job.title, applicationId: job.applicationId, documentId: null, profileRevisionId: ids.profileRevision, snapshotId: job.description ? `${jobId.slice(0, -2)}5e` : null, selectedFacts: [], answerSuggestions: [], gaps: [] };
  if (jobId === ids.identityJob) {
    if (!identityReady(state.profile)) return { ...base, applicationId: ids.identityApp, gaps: ['FULL_NAME_REQUIRED', 'EMAIL_REQUIRED'], selectedFacts: [selectedFact] };
    state.documents = [identityDocument()];
    state.identityPrepared = true;
    return { ...base, status: 'PREPARED', applicationId: ids.identityApp, documentId: ids.identityDoc, selectedFacts: [selectedFact] };
  }
  if (jobId === ids.experienceJob) return { ...base, gaps: ['RELEVANT_APPROVED_EVIDENCE_REQUIRED'] };
  if (jobId === ids.textJob) return { ...base, gaps: ['JOB_TEXT_UNAVAILABLE'] };
  // What the API derives for a job without saved text when no confirmed experience can be matched to it.
  if (jobId === ids.mixedJob) return { ...base, gaps: ['JOB_TEXT_UNAVAILABLE', 'RELEVANT_APPROVED_EVIDENCE_REQUIRED'] };
  return null;
}
function identityDocument() {
  return { id: ids.identityDoc, name: `Candidatura ${jobs[ids.identityJob].company} - ${jobs[ids.identityJob].title}`, revision: 1, sha256: '0'.repeat(64), mediaType: 'application/pdf', approvalStatus: 'PENDING_REVIEW', createdAt: ISO, language: 'es', jobId: ids.identityJob, jobSnapshotId: `${ids.identityJob.slice(0, -2)}5e`, reusableFactIds: [ids.fact], missingFactCount: 0, reviewReady: true, assistReady: false, claims: [{ text: approvedFact.statement, sourceFactIds: [ids.fact] }] };
}
function applicationFixture(state, applicationId) {
  const entry = Object.entries(jobs).find(([, job]) => job.applicationId === applicationId) ?? (applicationId === ids.identityApp ? [ids.identityJob, jobs[ids.identityJob]] : null);
  if (!entry) return null;
  const [jobId, job] = entry;
  return { id: applicationId, jobId, documentId: applicationId === ids.identityApp && state.identityPrepared ? ids.identityDoc : null, company: job.company, role: job.title, location: 'Remoto · España', canonicalUrl: `https://example.test/ofertas/${jobId}`, state: 'REVIEW_REQUIRED', recruitmentStage: 'NO_RESPONSE', shortlistDecision: 'SHORTLISTED', notes: '', updatedAt: ISO, version: 2 };
}

/** GET /api/v1/preparations rows as the API projects READY, UNCERTAIN (state UNKNOWN) and CLOSED (CANCELLED) applications. */
const queueRow = (jobId, overrides) => ({ jobId, company: jobs[jobId].company, title: jobs[jobId].title, applicationId: jobs[jobId].applicationId, documentId: null, profileRevisionId: ids.profileRevision, snapshotId: null, selectedFacts: [], answerSuggestions: [], gaps: [], reason: undefined, ...overrides });
const queueFixture = () => [
  queueRow(ids.readyJob, { status: 'PREPARED', documentId: ids.readyDoc, queueState: 'READY', needsAttention: true, canPrepare: false, applicationState: 'READY', selectedFacts: [selectedFact] }),
  queueRow(ids.uncertainJob, { status: 'BLOCKED', documentId: ids.uncertainDoc, queueState: 'UNCERTAIN', needsAttention: true, canPrepare: false, applicationState: 'UNKNOWN' }),
  queueRow(ids.closedJob, { status: 'BLOCKED', queueState: 'CLOSED', needsAttention: false, canPrepare: false, applicationState: 'CANCELLED' }),
];

function freshState(overrides = {}) {
  return { profile: profileFixture({ identity: filledIdentity, facts: [approvedFact] }), documents: [], queue: queueFixture(), identityPrepared: false, preparationPosts: [], profilePuts: [], ...overrides };
}

const json = (route, value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });

/** Deterministic domain API. Unknown reads answer 404 and are reported; unknown writes are refused and fail the run. */
async function domainApi(route, request, url, run) {
  const state = run.state; const method = request.method(); const path = url.pathname.slice('/api/v1'.length);
  let match;
  if (method === 'GET' && (match = path.match(/^\/jobs\/([^/]+)$/))) { const detail = jobDetail(match[1]); return detail ? json(route, detail) : json(route, { error: 'NOT_FOUND' }, 404); }
  if (method === 'GET' && path === '/jobs') return json(route, Object.keys(jobs).map((jobId) => jobDetail(jobId).job));
  if (method === 'GET' && path === '/profile') return json(route, state.profile);
  if (method === 'PUT' && path === '/profile') {
    const body = request.postDataJSON(); state.profilePuts.push(body);
    if (body.expectedRevision !== state.profile.revision) return json(route, { error: 'PROFILE_REVISION_CONFLICT' }, 409);
    state.profile = { ...state.profile, revision: state.profile.revision + 1, profile: body.profile };
    return json(route, { revision: state.profile.revision });
  }
  if (method === 'GET' && path === '/documents') return json(route, state.documents);
  if (method === 'GET' && /^\/documents\/[^/]+\/file$/.test(path)) return json(route, { error: 'NOT_FOUND' }, 404);
  if (method === 'GET' && path === '/preparations') return json(route, state.queue);
  if (method === 'POST' && path === '/preparations') {
    const body = request.postDataJSON(); state.preparationPosts.push(body);
    const result = preparationResult(state, body.jobId);
    return result ? json(route, result) : json(route, { status: 'BLOCKED', jobId: body.jobId, reason: 'JOB_NOT_FOUND', error: 'JOB_NOT_FOUND' }, 404);
  }
  if (method === 'GET' && /^\/applications\/[^/]+\/events$/.test(path)) return json(route, []);
  if (method === 'GET' && (match = path.match(/^\/applications\/([^/]+)$/))) { const application = applicationFixture(state, match[1]); return application ? json(route, application) : json(route, { error: 'NOT_FOUND' }, 404); }
  if (method === 'GET' && path === '/applications') return json(route, { items: [], total: 0, offset: 0, limit: 25 });
  if (method === 'GET') { run.unmockedReads.add(path); return json(route, { error: 'NOT_FOUND' }, 404); }
  run.blockedWrites.push(`${method} ${path}`);
  return json(route, { error: 'E2E_WRITE_BLOCKED' }, 409);
}

const normalized = (text) => text.replace(/\s+/g, ' ').trim();
const primaryNames = async (scope) => (await scope.locator('a.button-primary:visible, button.button-primary:visible').allInnerTexts()).map(normalized);
const focused = (page) => page.evaluate(() => {
  const element = document.activeElement;
  return { tag: element?.tagName ?? '', id: element?.id ?? '', type: element?.getAttribute('type') ?? '', className: typeof element?.className === 'string' ? element.className : '', text: (element?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) };
});

function assertHref(href, expected, label) {
  assert.ok(href, `${label}: link has no href`);
  const url = new URL(href, 'http://career.local');
  assert.equal(url.pathname, expected.path, `${label}: path`);
  for (const [key, value] of Object.entries(expected.params ?? {})) assert.equal(url.searchParams.get(key), value, `${label}: ${key} must be kept`);
  if (expected.hash !== undefined) assert.equal(url.hash, expected.hash, `${label}: section`);
}
const journey = (jobId, applicationId) => ({ jobId, applicationId, returnTo: RETURN_TO });

async function waitEnabled(locator, message) {
  await locator.waitFor();
  await locator.page().waitForFunction((element) => element && !element.disabled && !element.closest('fieldset:disabled'), await locator.elementHandle(), { timeout: 10_000 }).catch(() => undefined);
  assert.equal(await locator.isEnabled(), true, message);
}

/** Visible cards keep a 16px inner margin and no control or text touches the card edge; the page never scrolls sideways. */
async function layoutReport(page, cardSelector) {
  return page.evaluate((selector) => {
    const root = document.documentElement;
    const cards = [...document.querySelectorAll(selector)].filter((card) => card.getBoundingClientRect().width > 0);
    const problems = [];
    for (const card of cards) {
      const box = card.getBoundingClientRect(); const style = window.getComputedStyle(card);
      const pad = ['Top', 'Right', 'Bottom', 'Left'].map((side) => parseFloat(style[`padding${side}`]) || 0);
      const name = (card.querySelector('h2, h3')?.textContent ?? card.className).replace(/\s+/g, ' ').trim().slice(0, 50);
      if (Math.min(...pad) < 16) problems.push(`"${name}" padding ${pad.join('/')}px`);
      for (const child of card.querySelectorAll('a, button, summary, h2, h3, p, li, .tag')) {
        const rect = child.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        if (rect.left < box.left + 15 || rect.right > box.right - 15) problems.push(`"${name}": "${(child.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)}" is ${Math.round(rect.left - box.left)}px/${Math.round(box.right - rect.right)}px from the card edge`);
      }
    }
    return { cards: cards.length, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, problems: [...new Set(problems)].slice(0, 10) };
  }, cardSelector);
}

/**
 * Runs the U08/U10 application journey checks and throws on the first functional regression; layout findings for every
 * width and language are gathered and reported together. Returns the screenshots written and any unmocked reads.
 */
export async function checkApplicationUsability({ browser, uiUrl, cookies, artifacts }) {
  assert.ok(browser && typeof browser.newContext === 'function', 'browser must be a Playwright Browser');
  assert.ok(typeof artifacts === 'string' && artifacts, 'artifacts must be a directory path for screenshots');
  const ui = isolatedUiUrl(uiUrl);
  const sessionCookies = checkedCookies(cookies);
  await mkdir(artifacts, { recursive: true, mode: 0o700 });

  const run = { state: freshState(), unmockedReads: new Set(), blockedWrites: [], externalRequests: [], pageErrors: [], layoutProblems: [], screenshots: [], passed: [] };
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'es-ES', serviceWorkers: 'block' });
  try {
    await context.addCookies(sessionCookies);
    await context.route('**/*', async (route) => {
      const request = route.request(); let url;
      try { url = new URL(request.url()); } catch { return route.abort('blockedbyclient'); }
      if (url.origin !== ui.origin) { run.externalRequests.push(`${request.method()} ${url.origin}${url.pathname}`); return route.abort('blockedbyclient'); }
      if (!url.pathname.startsWith('/api/v1/')) return route.continue();
      // The real session cookie is verified by the isolated stack; everything else is a fixture.
      if (url.pathname === '/api/v1/session' && request.method() === 'GET') return route.continue();
      return domainApi(route, request, url, run);
    });

    const shot = async (page, name) => { const path = join(artifacts, `v081-${name}.png`); await page.screenshot({ path, fullPage: true }); run.screenshots.push(path); };
    const useLocale = (locale) => context.addCookies([{ name: 'locale', value: locale, url: ui.origin, sameSite: 'Lax' }]);
    const openPage = async (label) => {
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      page.on('pageerror', (error) => run.pageErrors.push(`${label}: ${error.message}`));
      return page;
    };
    const gotoApp = async (page, path, locale) => {
      await page.goto(new URL(path, ui).toString(), { waitUntil: 'domcontentloaded' });
      await page.locator('#main-content').waitFor({ timeout: 15_000 }).catch(() => undefined);
      assert.ok(!new URL(page.url()).pathname.startsWith('/login'), 'The supplied session cookies were not accepted by the isolated stack');
      await page.locator('#main-content').waitFor();
      if (locale) await page.waitForFunction((wanted) => document.documentElement.lang.startsWith(wanted), locale);
    };
    const jobPath = (jobId) => `/jobs/${jobId}?returnTo=${encodeURIComponent(RETURN_TO)}`;
    const prepareFromJob = async (page, jobId, locale) => {
      await gotoApp(page, jobPath(jobId), locale);
      const section = page.locator('section.preparation-action');
      const button = section.getByRole('button', { name: locale === 'es' ? 'Preparar mi solicitud' : 'Prepare my application', exact: true });
      await waitEnabled(button, 'Preparing is available from the job');
      assert.deepEqual(await primaryNames(section), [locale === 'es' ? 'Preparar mi solicitud' : 'Prepare my application'], 'Before preparing, preparing is the only primary action');
      const posts = run.state.preparationPosts.length;
      await button.click();
      await section.locator('.preparation-feedback .card').waitFor();
      assert.equal(run.state.preparationPosts.length, posts + 1, 'Preparing sends exactly one request');
      assert.equal(run.state.preparationPosts.at(-1).jobId, jobId);
      return section;
    };
    const noLinkBackToDescription = async (section, jobId, label) => {
      const hrefs = await section.locator('a[href]').evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
      assert.ok(!hrefs.some((href) => href.includes('#job-description') || new URL(href, 'http://career.local').pathname === `/jobs/${jobId}`), `${label}: the recovery must not send the person back to the empty description (${hrefs.join(', ')})`);
    };

    // 1. Missing identity: one primary continuation into the guide, which asks only for name and email, skips completed
    // steps and ends by preparing the same application without losing the job, application or originating listing.
    {
      run.state = freshState({ profile: profileFixture({ identity: {}, facts: [approvedFact] }) });
      await useLocale('es');
      const page = await openPage('identity-es');
      await gotoApp(page, jobPath(ids.identityJob), 'es');
      const section = page.locator('section.preparation-action');
      const prepare = section.getByRole('button', { name: 'Preparar mi solicitud', exact: true });
      await waitEnabled(prepare, 'Preparing is available from the job');
      assert.deepEqual(await primaryNames(section), ['Preparar mi solicitud']);
      await prepare.focus();
      await page.keyboard.press('Enter');
      await section.getByText('Falta tu nombre.', { exact: true }).waitFor();
      await section.getByText('Falta tu correo.', { exact: true }).waitFor();
      assert.deepEqual(run.state.preparationPosts.map((body) => body.jobId), [ids.identityJob]);
      await page.waitForFunction(() => document.activeElement?.classList.contains('preparation-feedback'));
      assert.deepEqual(await primaryNames(section), ['Completar lo que falta'], 'Missing identity offers a single primary continuation');
      assert.match(await section.getByRole('button', { name: 'Volver a comprobar', exact: true }).getAttribute('class'), /button-secondary/, 'Checking again stays secondary');
      assert.equal(await section.getByRole('link', { name: 'Añadir experiencia para esta oferta' }).count(), 0, 'Identity comes first; experience is not offered at the same time');
      assert.equal(await section.getByText('Prefiero elegir el contenido del CV', { exact: true }).filter({ visible: true }).count(), 0, 'No manual alternative competes with completing identity');
      const complete = section.getByRole('link', { name: 'Completar lo que falta', exact: true });
      assertHref(await complete.getAttribute('href'), { path: '/profile/setup', params: journey(ids.identityJob, ids.identityApp) }, 'Complete what is missing');
      assertHref(await section.getByRole('link', { name: 'Abrir solicitud', exact: true }).getAttribute('href'), { path: '/applications', params: { id: ids.identityApp, returnTo: RETURN_TO } }, 'Open application');
      await shot(page, 'identity-gap-es-1280');

      await page.keyboard.press('Tab');
      assert.equal((await focused(page)).text, 'Completar lo que falta', 'Tab from the preparation result reaches the continuation first');
      await page.keyboard.press('Enter');
      await page.waitForURL((url) => url.pathname === '/profile/setup');
      const setupUrl = new URL(page.url());
      for (const [key, value] of Object.entries(journey(ids.identityJob, ids.identityApp))) assert.equal(setupUrl.searchParams.get(key), value, `The guide keeps ${key}`);
      await page.getByRole('heading', { level: 1, name: 'Completa lo que falta' }).waitFor();
      const progress = page.getByRole('list', { name: 'Tu progreso' }).getByRole('listitem');
      await page.getByRole('heading', { name: '¿Cómo quieres aparecer en tu CV?' }).waitFor();
      assert.match(await progress.nth(0).getAttribute('aria-current') ?? '', /step/, 'The guide starts at the missing details');
      assertHref(await page.getByRole('navigation', { name: 'Pasos para esta solicitud' }).getByRole('link', { name: 'Ver oferta' }).getAttribute('href'), { path: `/jobs/${ids.identityJob}`, params: { returnTo: RETURN_TO } }, 'Journey back to the job');
      const name = page.getByLabel('Nombre', { exact: true }); const email = page.getByLabel('Correo', { exact: true });
      await waitEnabled(name, 'The name field is ready');
      assert.equal(await name.inputValue(), ''); assert.equal(await email.inputValue(), '');
      await name.focus();
      await page.keyboard.type('Alex Ficticio');
      await page.keyboard.press('Tab');
      assert.equal((await focused(page)).type, 'email', 'Tab moves from name to email');
      await page.keyboard.type('alex.ficticio@example.test');
      await shot(page, 'identity-guide-es-1280');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.activeElement?.id === 'prepare-application-heading');
      assert.equal(run.state.profilePuts.length, 1, 'Saving the guide writes the profile once');
      const put = run.state.profilePuts[0];
      assert.equal(put.expectedRevision, 3);
      assert.equal(put.profile.identity.fullName, 'Alex Ficticio'); assert.equal(put.profile.identity.email, 'alex.ficticio@example.test');
      assert.deepEqual(put.profile.preferences, { targetTitles: ['Diseño de servicios'], workModes: ['remote'] }, 'Other profile fields are preserved');
      for (const index of [0, 1]) assert.match(normalized(await progress.nth(index).innerText()), /✓.*Listo/, `Completed step ${index + 1} is marked done and skipped`);
      assert.equal(await progress.nth(2).getAttribute('aria-current'), 'step', 'The guide lands on preparing the application');
      assert.equal(await page.getByRole('heading', { name: 'Cuéntanos una experiencia' }).count(), 0, 'Confirmed experience is not asked for again');
      const guidePrepare = page.locator('section.preparation-action');
      assert.deepEqual(await primaryNames(guidePrepare), ['Preparar mi solicitud']);
      await page.keyboard.press('Tab');
      assert.equal((await focused(page)).text, 'Preparar mi solicitud', 'Tab from the step heading reaches the preparation action');
      await page.keyboard.press('Enter');
      await page.waitForURL((url) => url.pathname === '/documents');
      assert.deepEqual(run.state.preparationPosts.map((body) => body.jobId), [ids.identityJob, ids.identityJob]);
      const reviewUrl = new URL(page.url());
      for (const [key, value] of Object.entries({ applicationId: ids.identityApp, jobId: ids.identityJob, view: 'review', document: ids.identityDoc, returnTo: RETURN_TO })) assert.equal(reviewUrl.searchParams.get(key), value, `Resume review keeps ${key}`);
      await page.locator('#main-content').waitFor();
      await shot(page, 'identity-prepared-review-es');
      await page.close();

      // The same continuation in English, with its copy and context.
      run.state = freshState({ profile: profileFixture({ identity: {}, facts: [approvedFact] }) });
      await useLocale('en');
      const english = await openPage('identity-en');
      const enSection = await prepareFromJob(english, ids.identityJob, 'en');
      await enSection.getByText('Your name is missing.', { exact: true }).waitFor();
      assert.deepEqual(await primaryNames(enSection), ['Complete what is missing']);
      const enComplete = enSection.getByRole('link', { name: 'Complete what is missing', exact: true });
      assertHref(await enComplete.getAttribute('href'), { path: '/profile/setup', params: journey(ids.identityJob, ids.identityApp) }, 'English continuation');
      await enComplete.click();
      await english.getByRole('heading', { level: 1, name: 'Complete what is missing' }).waitFor();
      await english.getByLabel('Name', { exact: true }).waitFor();
      await english.getByLabel('Email', { exact: true }).waitFor();
      await english.close();
      run.passed.push('identity continuation and guide (ES keyboard, EN copy)');
    }

    // 2. Missing experience goes to the experience section of the profile with the journey context.
    {
      run.state = freshState({ profile: profileFixture({ identity: filledIdentity, facts: [] }) });
      await useLocale('es');
      const page = await openPage('experience-es');
      const section = await prepareFromJob(page, ids.experienceJob, 'es');
      await section.getByText('Añade y confirma experiencia relacionada con el puesto.', { exact: true }).waitFor();
      assert.deepEqual(await primaryNames(section), ['Añadir experiencia para esta oferta'], 'Missing experience offers a single primary continuation');
      const addExperience = section.getByRole('link', { name: 'Añadir experiencia para esta oferta', exact: true });
      assertHref(await addExperience.getAttribute('href'), { path: '/profile', params: journey(ids.experienceJob, ids.experienceApp), hash: '#experience' }, 'Add experience');
      const manual = section.locator('details').filter({ hasText: 'Prefiero elegir el contenido del CV' });
      await manual.locator('summary').focus();
      await page.keyboard.press('Enter');
      const choose = manual.getByRole('link', { name: 'Elegir contenido del CV', exact: true });
      await choose.waitFor();
      assert.match(await choose.getAttribute('class'), /button-secondary/, 'Choosing content by hand stays a secondary alternative');
      assertHref(await choose.getAttribute('href'), { path: '/documents', params: journey(ids.experienceJob, ids.experienceApp) }, 'Choose resume content');
      assert.deepEqual(await primaryNames(section), ['Añadir experiencia para esta oferta'], 'Opening the alternative does not add a second primary');
      await shot(page, 'experience-gap-es-1280');
      await addExperience.click();
      await page.waitForURL((url) => url.pathname === '/profile' && url.hash === '#experience');
      const profileUrl = new URL(page.url());
      for (const [key, value] of Object.entries(journey(ids.experienceJob, ids.experienceApp))) assert.equal(profileUrl.searchParams.get(key), value, `The profile keeps ${key}`);
      await page.waitForFunction(() => document.activeElement?.id === 'experience');
      assertHref(await page.getByRole('navigation', { name: 'Pasos para esta solicitud' }).getByRole('link', { name: 'Ver oferta' }).getAttribute('href'), { path: `/jobs/${ids.experienceJob}`, params: { returnTo: RETURN_TO } }, 'Journey back to the job');
      await shot(page, 'experience-profile-es-1280');
      await page.close();
      run.passed.push('experience continuation to /profile#experience');
    }

    // 3. Without saved job text the recovery is choosing resume content, never a link back to the empty description.
    {
      run.state = freshState();
      await useLocale('es');
      const page = await openPage('job-text-es');
      const section = await prepareFromJob(page, ids.textJob, 'es');
      await page.getByText('Esta fuente no incluyó descripción.', { exact: false }).waitFor();
      await section.getByText('No hay texto del anuncio guardado.', { exact: true }).waitFor();
      assert.deepEqual(await primaryNames(section), ['Elegir contenido del CV'], 'Missing job text leads to choosing resume content');
      assertHref(await section.getByRole('link', { name: 'Elegir contenido del CV', exact: true }).getAttribute('href'), { path: '/documents', params: journey(ids.textJob, ids.textApp) }, 'Choose resume content');
      assert.equal(await section.getByText('Prefiero elegir el contenido del CV', { exact: true }).count(), 0, 'The primary already is the manual choice; no duplicate disclosure');
      await noLinkBackToDescription(section, ids.textJob, 'Job text unavailable');
      await shot(page, 'job-text-gap-es-1280');

      const mixed = await prepareFromJob(page, ids.mixedJob, 'es');
      assert.deepEqual(await primaryNames(mixed), ['Añadir experiencia para esta oferta']);
      const alternative = mixed.locator('details').filter({ hasText: 'Prefiero elegir el contenido del CV' });
      await alternative.locator('summary').click();
      assertHref(await alternative.getByRole('link', { name: 'Elegir contenido del CV', exact: true }).getAttribute('href'), { path: '/documents', params: journey(ids.mixedJob, ids.mixedApp) }, 'Choose resume content without job text');
      await noLinkBackToDescription(mixed, ids.mixedJob, 'Job text and experience missing');
      await page.close();
      run.passed.push('job text unavailable offers resume content');
    }

    // 4. Review queue: READY continues to the application; the approved PDF is secondary; closed or uncertain
    // applications never invite another submission or preparation.
    const resend = /reenviar|volver a enviar|enviar de nuevo|volver a preparar|continuar con la solicitud|resend|send again|submit again|prepare again|continue application/i;
    const queueCard = (page, title) => page.locator('main section.card').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) });
    {
      run.state = freshState();
      await useLocale('es');
      const page = await openPage('queue-es');
      await gotoApp(page, '/applications?view=review', 'es');
      await page.getByRole('heading', { level: 1, name: 'Mis solicitudes' }).waitFor();
      const ready = queueCard(page, LONG_TITLE);
      await ready.waitFor();
      await ready.getByText('CV aprobado', { exact: true }).waitFor();
      assert.deepEqual(await primaryNames(ready), ['Continuar con la solicitud'], 'An approved resume continues to the application as the only primary');
      const proceed = ready.getByRole('link', { name: 'Continuar con la solicitud', exact: true });
      assertHref(await proceed.getAttribute('href'), { path: '/applications', params: { id: ids.readyApp } }, 'Continue application');
      const pdf = ready.getByRole('link', { name: 'Ver CV aprobado', exact: true });
      assert.match(await pdf.getAttribute('class'), /button-secondary/, 'The approved PDF is a secondary action');
      assertHref(await pdf.getAttribute('href'), { path: '/documents', params: { applicationId: ids.readyApp, jobId: ids.readyJob, view: 'review', document: ids.readyDoc } }, 'View approved resume');
      assert.equal(await ready.getByRole('button', { name: 'Volver a preparar' }).count(), 0);
      await proceed.focus();
      await page.keyboard.press('Tab');
      assert.equal((await focused(page)).text, 'Ver CV aprobado', 'Keyboard order is the continuation, then the PDF');

      const uncertain = queueCard(page, jobs[ids.uncertainJob].title);
      await uncertain.getByText('Abre la solicitud y comprueba el envío antes de intentar otra vez.', { exact: true }).waitFor();
      const uncertainControls = (await uncertain.locator('a.button:visible, button:visible').allInnerTexts()).map(normalized);
      assert.deepEqual(uncertainControls, ['Comprobar el envío'], 'An uncertain submission only offers checking it');
      assert.ok(!uncertainControls.some((text) => resend.test(text)));

      assert.equal(await queueCard(page, jobs[ids.closedJob].title).count(), 0, 'Closed applications are hidden from the pending view');
      const toggle = page.getByRole('button', { name: 'Ver también finalizadas', exact: true });
      await toggle.focus();
      await page.keyboard.press('Space');
      await page.getByRole('button', { name: 'Solo pendientes', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Solo pendientes', exact: true }).getAttribute('aria-pressed'), 'true');
      const closed = queueCard(page, jobs[ids.closedJob].title);
      await closed.getByText('Finalizada', { exact: true }).waitFor();
      const closedControls = (await closed.locator('a.button:visible, button:visible').allInnerTexts()).map(normalized);
      assert.deepEqual(closedControls, ['Abrir solicitud'], 'A closed application can only be opened');
      assert.ok(!closedControls.some((text) => resend.test(text)));
      assertHref(await closed.getByRole('link', { name: 'Abrir solicitud', exact: true }).getAttribute('href'), { path: '/applications', params: { id: ids.closedApp } }, 'Open closed application');
      await shot(page, 'queue-es-1280');
      await page.close();
      run.passed.push('queue READY/UNCERTAIN/CLOSED actions');
    }

    // 5. Card spacing and reflow at 320, 390 and 1096px in both languages, with the language switch used by keyboard.
    {
      run.state = freshState();
      await useLocale('es');
      const queue = await openPage('layout-queue');
      await gotoApp(queue, '/applications?view=review', 'es');
      await queueCard(queue, LONG_TITLE).waitFor();
      run.state.profile = profileFixture({ identity: {}, facts: [approvedFact] });
      const job = await openPage('layout-job');
      const section = await prepareFromJob(job, ids.identityJob, 'es');
      await section.getByRole('link', { name: 'Completar lo que falta', exact: true }).waitFor();
      const check = async (page, name, selector, locale) => {
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 900 });
          await page.waitForFunction((expected) => document.documentElement.clientWidth <= expected, width);
          if (width <= 850) await page.waitForFunction(() => document.querySelector('#app-sidebar').getBoundingClientRect().right <= 1);
          const report = await layoutReport(page, selector);
          if (!report.cards) run.layoutProblems.push(`${name} ${locale} ${width}px: no cards rendered for ${selector}`);
          if (report.scrollWidth > report.clientWidth + 1) run.layoutProblems.push(`${name} ${locale} ${width}px: horizontal overflow ${report.scrollWidth}>${report.clientWidth}`);
          for (const problem of report.problems) run.layoutProblems.push(`${name} ${locale} ${width}px: ${problem}`);
          await shot(page, `${name}-${locale}-${width}`);
        }
      };
      const queueCards = 'main section.card';
      const jobCards = 'main section.preparation-action, main .preparation-feedback > section.card';
      for (const locale of ['es', 'en']) {
        if (locale === 'en') {
          for (const page of [queue, job]) {
            await page.setViewportSize({ width: 1096, height: 900 });
            const switcher = page.getByRole('button', { name: 'English', exact: true }).first();
            await switcher.focus();
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.documentElement.lang.startsWith('en'));
          }
          await queue.getByRole('link', { name: 'Continue application', exact: true }).waitFor();
          await job.getByRole('link', { name: 'Complete what is missing', exact: true }).waitFor();
        }
        const toggle = queue.getByRole('button', { name: locale === 'es' ? 'Ver también finalizadas' : 'Include completed', exact: true });
        if (await toggle.count()) await toggle.click();
        await queueCard(queue, jobs[ids.closedJob].title).waitFor();
        await check(queue, 'queue', queueCards, locale);
        await check(job, 'job-preparation', jobCards, locale);
        await queue.setViewportSize({ width: 320, height: 900 });
        await queue.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
        const zoomed = await layoutReport(queue, queueCards);
        if (zoomed.scrollWidth > zoomed.clientWidth + 1) run.layoutProblems.push(`queue ${locale} 320px at 200% text: horizontal overflow ${zoomed.scrollWidth}>${zoomed.clientWidth}`);
        await shot(queue, `queue-${locale}-320-text200`);
        await queue.evaluate(() => { document.documentElement.style.fontSize = ''; });
      }
      await queue.close(); await job.close();
      assert.deepEqual(run.layoutProblems, [], `Card spacing or reflow regressions:\n${run.layoutProblems.join('\n')}`);
      run.passed.push(`card spacing and reflow at ${WIDTHS.join('/')}px, ES/EN, 200% text`);
    }

    assert.deepEqual(run.pageErrors, [], `Unexpected browser errors: ${run.pageErrors.join(' | ')}`);
    assert.deepEqual(run.blockedWrites, [], `Unexpected writes were blocked: ${run.blockedWrites.join(', ')}`);
    assert.deepEqual(run.externalRequests, [], `External requests were attempted and blocked: ${run.externalRequests.join(', ')}`);
    return { passed: run.passed, screenshots: run.screenshots, unmockedReads: [...run.unmockedReads] };
  } finally {
    await context.close().catch(() => undefined);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.error('Import checkApplicationUsability({ browser, uiUrl, cookies, artifacts }) from an isolated-stack runner such as scripts/e2e-v080.mjs; this module does not start a stack or sign in.');
  process.exitCode = 2;
}
