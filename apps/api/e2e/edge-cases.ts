// Regressions from the 2026-10-04 audit. All writes use a disposable stack and fictional data.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createIsolatedStack, projectRoot } from './isolation.js';
import { signIn, setLocale, apiClient, hasHorizontalOverflow, revealField, eventually as waitFor } from './ui.js';

type Application = { id: string; version: number; recruitmentStage: string };
const stack = await createIsolatedStack();
const output = join(projectRoot, 'output/playwright', stack.runId, 'edge-cases');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results: Array<{ name: string; passed: boolean; error?: string }> = [];
try {
  await stack.db.query("INSERT INTO job_search_provider_cache(provider,payload,fetched_at,next_fetch_at) VALUES ('remotive','[]'::jsonb,now(),now()+interval '24 hours'),('arbeitnow','[]'::jsonb,now(),now()+interval '24 hours') ON CONFLICT(provider) DO UPDATE SET payload=excluded.payload,next_fetch_at=excluded.next_fetch_at");
  const context = await browser.newContext({ baseURL: stack.uiUrl, viewport: { width: 1096, height: 800 }, locale: 'es-ES' });
  let next = 0;
  const pace = async () => { const at = Math.max(Date.now(), next); next = at + 600; await delay(Math.max(0, at - Date.now())); };
  await context.route('**/api/v1/**', async (route) => { await pace(); await route.continue(); });
  const page = await context.newPage(); page.setDefaultTimeout(20000);
  // Match the full harness budget for routes compiled on demand by the disposable dev server.
  page.setDefaultNavigationTimeout(45000);
  const api = apiClient(context, stack.uiUrl, pace);
  const only = (process.env.EDGE_ONLY ?? '').split(',').filter(Boolean);
  const run = async (name: string, fn: () => Promise<void>) => {
    if (only.length && !only.includes(name)) return;
    try { await fn(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: String(error) }); }
    console.log(JSON.stringify(results.at(-1)));
    await page.screenshot({ path: join(output, `${name}.png`), fullPage: false }).catch(() => {});
    await page.unrouteAll({ behavior: 'wait' });
  };
  await signIn(page, stack.uiUrl, await stack.readToken()); await setLocale(page, 'es');
  const profile = await api.get<{ revision: number; profile: object }>('/profile');
  await api.put('/profile', { expectedRevision: profile.revision, profile: { ...profile.profile, identity: { fullName: `Alex ${stack.marker}`, email: 'alex@example.test' } } });
  const fact = await api.post<{ id: string }>('/profile/facts', { kind: 'achievement', statement: 'Designed accessible interfaces and automated testing.', tags: ['design', 'testing'] });
  await api.post(`/profile/facts/${fact.id}/approve`, {});
  const doc = await api.post<{ id: string }>('/documents', { name: 'Saved source resume', locale: 'es', factIds: [fact.id] });
  await api.post(`/documents/${doc.id}/approve`, { confirmReviewed: true });
  const job = await api.post<{ id: string; canonicalUrl: string }>('/jobs/import', { title: 'Audit designer', company: `Fictional ${stack.marker}`, jobUrl: 'https://jobs.lever.co/fictional-audit/33ef6bcd-2bb9-455f-9229-7b94d86be221', description: 'Design accessible interfaces and automated testing.' });
  const app = await api.post<Application>('/applications', { jobId: job.id, company: `Fictional ${stack.marker}`, role: 'Audit designer', canonicalUrl: job.canonicalUrl, state: 'DRAFT', notes: '' });

  await run('stale-application-keeps-newer-stage', async () => {
    await page.goto(`/applications?id=${app.id}`);
    const stage = page.getByLabel('Etapa del proceso', { exact: true }); await stage.waitFor();
    const before = await api.get<Application>(`/applications/${app.id}`);
    await api.patch(`/applications/${app.id}`, { recruitmentStage: 'REJECTED', expectedVersion: before.version });
    const pending = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().endsWith(`/applications/${app.id}`));
    await stage.selectOption('WITHDRAWN'); const response = await pending;
    assert.equal(response.request().postDataJSON().expectedVersion, before.version);
    assert.equal(response.status(), 409);
    assert.equal((await response.json()).error, 'STALE_APPLICATION_VERSION');
    await waitFor(() => stage.inputValue(), (value) => value === 'REJECTED', 'Conflict should reload the current stage');
    assert.equal((await api.get<Application>(`/applications/${app.id}`)).recruitmentStage, 'REJECTED');
  });

  await run('terminal-stages-have-no-preparation-actions', async () => {
    for (const stage of ['REJECTED', 'WITHDRAWN', 'HIRED']) {
      const current = await api.get<Application>(`/applications/${app.id}`);
      await api.patch(`/applications/${app.id}`, { recruitmentStage: stage, expectedVersion: current.version });
      await page.goto(`/applications?id=${app.id}`);
      await page.getByRole('heading', { name: 'Sigue la respuesta de la empresa', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Preparar mi solicitud', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Revisar datos y destino', exact: true }).count(), 0);
      assert.equal(await page.getByRole('link', { name: 'Preparar o elegir CV', exact: true }).count(), 0);
      assert.equal(await page.locator('.application-journey').count(), 0);
    }
  });

  await run('resume-reuse-cancel-and-confirm', async () => {
    await page.goto('/documents');
    const name = page.getByLabel('Nombre de la versión', { exact: true }); await name.waitFor();
    await name.fill('My unsaved custom resume');
    await page.getByLabel('Idioma del PDF', { exact: true }).selectOption('en');
    const before = await page.evaluate(() => sessionStorage.getItem('career:draft:v1:resume:base'));
    await page.getByRole('button', { name: /^CV guardados/ }).click();
    const cancelled = page.waitForEvent('dialog');
    const click = page.getByRole('button', { name: 'Usar como base', exact: true }).click();
    await (await cancelled).dismiss(); await click;
    assert.equal(await page.evaluate(() => sessionStorage.getItem('career:draft:v1:resume:base')), before);
    const accepted = page.waitForEvent('dialog');
    const retry = page.getByRole('button', { name: 'Usar como base', exact: true }).click();
    await (await accepted).accept(); await retry;
    await name.waitFor(); assert.equal(await name.inputValue(), 'Saved source resume');
    assert.equal(await page.getByLabel('Idioma del PDF', { exact: true }).inputValue(), 'es');
  });

  await run('generated-resume-edits-without-replacement', async () => {
    await page.goto('/documents');
    const name = page.getByLabel('Nombre de la versión', { exact: true }); await name.fill('Freshly generated resume');
    const pick = page.locator('.fact-pick input[type="checkbox"]').first(); await pick.check();
    // Leave the PDF language implicit, as for a new user's first resume.
    await page.evaluate(() => {
      const key = 'career:draft:v1:resume:base'; const draft = JSON.parse(sessionStorage.getItem(key)!);
      draft.language = ''; sessionStorage.setItem(key, JSON.stringify(draft));
    });
    await page.reload(); await name.waitFor();
    let confirmations = 0;
    const dismiss = async (dialog: import('playwright').Dialog) => { confirmations++; await dialog.dismiss(); };
    page.on('dialog', dismiss);
    try {
      for (const count of [1, 2]) {
        await page.getByRole('button', { name: 'Generar y revisar', exact: true }).click();
        await page.getByRole('button', { name: 'Cambiar contenido del CV', exact: true }).waitFor();
        const docs = await api.get<Array<{ name: string; id: string; storagePath: string }>>('/documents');
        const generated = docs.filter((item) => item.name === 'Freshly generated resume');
        assert.equal(generated.length, count);
        assert.equal(new Set(generated.map((item) => item.storagePath)).size, count);
        await page.getByRole('button', { name: 'Cambiar contenido del CV', exact: true }).click();
        await name.waitFor(); assert.equal(await name.inputValue(), 'Freshly generated resume');
      }
      assert.equal(confirmations, 0, 'Editing the version just saved should not ask to replace a different draft');
    } finally { page.off('dialog', dismiss); }
  });

  await run('resume-reuse-protects-another-destination', async () => {
    const target = await api.post<{ id: string }>('/documents', { name: 'Job source resume', jobId: job.id, locale: 'es', factIds: [fact.id] });
    const key = `career:draft:v1:resume:${job.id}`;
    const original = JSON.stringify({ name: 'Existing job draft', named: 'yes', language: 'en', facts: '[]' });
    await page.evaluate(({ key, original }) => sessionStorage.setItem(key, original), { key, original });
    await page.goto('/documents?view=saved');
    const reuse = page.locator('.document-card').filter({ has: page.locator(`[id="resume-title-${target.id}"]`) }).getByRole('button', { name: 'Usar como base', exact: true });
    await reuse.waitFor();
    const cancelled = page.waitForEvent('dialog'); const click = reuse.click(); await (await cancelled).dismiss(); await click;
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), key), original);
    assert.equal(new URL(page.url()).searchParams.has('jobId'), false);
  });

  await run('search-length-rejected-without-losing-input', async () => {
    await page.goto('/searches');
    const role = page.getByLabel('Puesto o palabras clave', { exact: true }); await role.fill('a'.repeat(201));
    await page.getByRole('button', { name: 'Buscar ofertas', exact: true }).click();
    await page.locator('#search-form-error').waitFor();
    assert.match(await page.locator('#search-form-error').innerText(), /200/);
    assert.equal(await role.inputValue(), 'a'.repeat(201)); assert.equal(await role.getAttribute('aria-invalid'), 'true');
    assert.equal(await role.evaluate((element) => element === document.activeElement), true);
    await role.fill('a'.repeat(200));
    const created = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/job-searches'));
    await page.getByRole('button', { name: 'Buscar ofertas', exact: true }).click();
    const response = await created; assert.equal(response.status(), 201); assert.equal((await response.json()).search.role.length, 200);
  });

  await run('old-application-and-pagination', async () => {
    await stack.db.query("INSERT INTO applications(workspace_id,company,role) SELECT workspace_id,'Bulk audit ' || n,'Test role' FROM applications CROSS JOIN generate_series(1,500) n WHERE id=$1", [app.id]);
    await page.goto(`/applications?id=${app.id}`);
    await page.getByLabel('Etapa del proceso', { exact: true }).waitFor();
    assert.equal(await page.locator('.tracker-row').count(), 25);
    const pageData = await api.get<{ total: number; items: Application[] }>('/applications?offset=0&limit=25');
    assert.equal(pageData.total, 501); assert.equal(pageData.items.some((item) => item.id === app.id), false);
    const nextPage = page.waitForResponse((r) => r.url().includes('/applications?') && new URL(r.url()).searchParams.get('offset') === '25');
    await page.getByRole('button', { name: 'Siguiente', exact: true }).click(); await nextPage;
    await waitFor(() => page.locator('.tracker-list-head').innerText(), (text) => text.includes('26–50'), 'Next page should load');
    await page.getByLabel('Buscar en mis solicitudes', { exact: true }).fill('Audit designer');
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    await waitFor(() => page.locator('.tracker-row').count(), (count) => count === 1, 'Old records should be searchable');
    assert.equal(await page.getByLabel('Etapa del proceso', { exact: true }).inputValue(), 'HIRED');
    const literal = await api.get<{ total: number }>('/applications?offset=0&limit=25&q=%25'); assert.equal(literal.total, 0);
    const last = await api.get<{ offset: number; items: Application[] }>('/applications?offset=9999&limit=25'); assert.equal(last.offset, 500); assert.equal(last.items.length, 1);
  });

  await run('detail-error-retry-and-missing-record', async () => {
    await page.route(`**/api/v1/applications/${app.id}`, (route) => route.fulfill({ status: 503, json: { error: 'SERVICE_UNAVAILABLE' } }));
    await page.goto(`/applications?id=${app.id}`);
    await page.getByRole('heading', { name: 'No pudimos cargar esta solicitud', exact: true }).waitFor();
    await page.unrouteAll({ behavior: 'wait' });
    await page.locator('.tracker-detail').getByRole('button', { name: 'Reintentar', exact: true }).click();
    await page.getByLabel('Etapa del proceso', { exact: true }).waitFor();
    await page.goto('/applications?id=00000000-0000-4000-8000-000000000001');
    await page.getByRole('heading', { name: 'No encontramos esa solicitud', exact: true }).waitFor();
  });

  await run('session-outage-keeps-route-and-retries', async () => {
    await page.route('**/api/v1/session', (route) => route.fulfill({ status: 503, json: { error: 'SERVICE_UNAVAILABLE' } }));
    await page.goto('/profile?jobId=' + job.id);
    await page.getByRole('button', { name: 'Reintentar conexión', exact: true }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/profile'); assert.equal(new URL(page.url()).searchParams.get('jobId'), job.id);
    await page.unrouteAll({ behavior: 'wait' });
    assert.equal((await api.get<{ authenticated: boolean }>('/session')).authenticated, true);
    await page.getByRole('button', { name: 'Reintentar conexión', exact: true }).click();
    await page.getByLabel('Nombre', { exact: true }).waitFor();
  });

  await run('job-availability-history-actions-desktop-and-mobile', async () => {
    const candidate = await api.post<{ id: string; canonicalUrl: string }>('/jobs/import', { title: 'Availability test designer', company: `Availability ${stack.marker}`, jobUrl: `https://jobs.lever.co/availability-${stack.marker}/33ef6bcd-2bb9-455f-9229-7b94d86be221`, description: 'Fictional job for availability controls.' });
    await page.setViewportSize({ width: 1096, height: 800 }); await setLocale(page, 'es');
    await page.goto(`/jobs/${candidate.id}`);
    await page.getByRole('heading', { name: 'Estado de la oferta', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Cerrar oferta', exact: true }).count(), 1);
    const close = page.getByRole('button', { name: 'Cerrar oferta', exact: true });
    await close.focus(); assert.equal(await close.evaluate((element) => element === document.activeElement), true, 'Close action is keyboard focusable');
    const closed = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith(`/api/v1/jobs/${candidate.id}/availability`));
    await page.keyboard.press('Enter'); assert.equal((await closed).status(), 200);
    await page.locator('[class*="availabilityLatest"]').filter({ hasText: 'La cerraste tú.' }).waitFor();
    await page.getByRole('button', { name: 'Reabrir oferta', exact: true }).waitFor();
    await stack.db.query(`insert into job_search_sources(workspace_id, job_id, provider, external_id, source_url, missed_complete_reads, last_seen_at) select workspace_id, id, 'remotive', $2, $3, 0, now() + interval '1 minute' from jobs where id = $1`, [candidate.id, `availability-${stack.marker}`, candidate.canonicalUrl]);
    await page.reload();
    await page.getByText('Una fuente todavía muestra esta oferta como publicada.', { exact: false }).waitFor();
    assert.equal(await hasHorizontalOverflow(page), false, 'Desktop layout has no horizontal overflow');

    await setLocale(page, 'en'); await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
    await page.getByRole('heading', { name: 'Job status', exact: true }).waitFor();
    await page.getByText('A source still lists this job as published.', { exact: false }).waitFor();
    await page.locator('[class*="availabilityLatest"]').filter({ hasText: 'You closed it.' }).waitFor();
    assert.equal(await hasHorizontalOverflow(page), false, 'Mobile layout has no horizontal overflow at 390 px');
    const reopen = page.getByRole('button', { name: 'Reopen job', exact: true });
    await reopen.focus(); assert.equal(await reopen.evaluate((element) => element === document.activeElement), true, 'Reopen action is keyboard focusable');
    await reopen.click();
    await page.locator('[class*="availabilityLatest"]').filter({ hasText: 'You reopened it.' }).waitFor();
    await page.locator('[class*="availabilityHistory"] summary').click();
    await page.locator('[class*="availabilityHistory"]').getByText('You closed it.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Reopen job', exact: true }).count(), 0);
    assert.equal(await hasHorizontalOverflow(page), false, 'Reopened mobile layout still has no horizontal overflow');
  });

  await run('job-availability-badges-filter-and-nonblocking-preparation-warning', async () => {
    const fixtures: Array<{ state: 'OPEN' | 'POSSIBLY_CLOSED' | 'CLOSED' | 'UNKNOWN'; title: string; id: string }> = [];
    for (const state of ['OPEN', 'POSSIBLY_CLOSED', 'CLOSED', 'UNKNOWN'] as const) {
      const title = `${state === 'POSSIBLY_CLOSED' ? 'Designer' : state} ${stack.marker.slice(-6)}`;
      const created = await api.post<{ id: string }>('/jobs/import', { title, company: `List ${state} ${stack.marker.slice(-6)}`, jobUrl: `https://jobs.lever.co/list-${state.toLowerCase()}-${stack.marker}/${state === 'OPEN' ? '66ef6bcd-2bb9-455f-9229-7b94d86be221' : `33ef6bcd-2bb9-455f-9229-7b94d86be22${['POSSIBLY_CLOSED', 'CLOSED', 'UNKNOWN'].indexOf(state)}`}`, description: 'Fictional availability list fixture.' });
      await stack.db.query('update jobs set availability = $2 where id = $1', [created.id, state]);
      fixtures.push({ state, title, id: created.id });
    }
    const possiblyClosed = fixtures.find((fixture) => fixture.state === 'POSSIBLY_CLOSED')!;
    const application = await api.post<Application>('/applications', { jobId: possiblyClosed.id, company: 'List POSSIBLY_CLOSED', role: possiblyClosed.title, canonicalUrl: 'https://jobs.lever.co/availability-test', state: 'DRAFT', notes: '' });
    const manuallyClosed = fixtures.find((fixture) => fixture.state === 'CLOSED')!;
    const closedApplication = await api.post<Application>('/applications', { jobId: manuallyClosed.id, company: 'List CLOSED', role: manuallyClosed.title, canonicalUrl: 'https://jobs.lever.co/availability-closed-test', state: 'DRAFT', notes: '' });
    await setLocale(page, 'es'); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/jobs');
    const closedCard = page.locator('.job-card').filter({ has: page.getByRole('link', { name: possiblyClosed.title, exact: true }) });
    await closedCard.getByText('Puede estar cerrada', { exact: true }).waitFor();
    const unknown = fixtures.find((fixture) => fixture.state === 'UNKNOWN')!;
    await page.locator('.job-card').filter({ has: page.getByRole('link', { name: manuallyClosed.title, exact: true }) }).getByText('Cerrada', { exact: true }).waitFor();
    await page.locator('.job-card').filter({ has: page.getByRole('link', { name: unknown.title, exact: true }) }).getByText('Sin comprobar', { exact: true }).waitFor();
    const open = fixtures.find((fixture) => fixture.state === 'OPEN')!;
    const openCard = page.locator('.job-card').filter({ has: page.getByRole('link', { name: open.title, exact: true }) });
    await openCard.waitFor(); assert.equal(await openCard.getByText('Abierta', { exact: true }).count(), 0, 'Open jobs do not get a non-open badge');
    assert.equal(await hasHorizontalOverflow(page), false, 'Availability badges fit the job list at 390 px');

    await page.getByLabel('Disponibilidad', { exact: true }).selectOption('POSSIBLY_CLOSED');
    await page.waitForURL(/availability=POSSIBLY_CLOSED/);
    // Wait for the filtered list itself: the unfiltered cards stay rendered until the new page of results arrives.
    await openCard.waitFor({ state: 'detached' });
    await closedCard.waitFor();
    const visibleTitles = await page.locator('.job-card h2 a').allTextContents();
    assert.deepEqual(visibleTitles, [possiblyClosed.title], 'Filtering returns exactly the possibly-closed job');
    const filtered = await api.get<{ items: Array<{ id: string; availability: string }>; total: number }>('/jobs?availability=POSSIBLY_CLOSED&paged=true');
    assert.deepEqual(filtered.items.map((item) => item.id), [possiblyClosed.id]);

    await page.goto(`/applications?id=${application.id}`);
    await page.locator('.preparation-action').getByRole('button', { name: 'Preparar mi solicitud', exact: true }).waitFor();
    assert.equal(await page.locator('.preparation-action').getByRole('button', { name: 'Preparar mi solicitud', exact: true }).isEnabled(), true, 'The warning does not block preparation');
    await page.locator('.preparation-action').getByText('La oferta figura como «Puede estar cerrada». Comprueba el anuncio original antes de continuar; preparar no envía nada.', { exact: true }).waitFor();
    assert.equal(await hasHorizontalOverflow(page), false, 'The application warning fits at 390 px');
    await setLocale(page, 'en');
    await page.locator('.preparation-action').getByRole('button', { name: 'Prepare my application', exact: true }).waitFor();
    assert.equal(await page.locator('.preparation-action').getByRole('button', { name: 'Prepare my application', exact: true }).isEnabled(), true, 'The English warning does not block preparation');
    await page.locator('.preparation-action').getByText('This job is marked “May be closed”. Check the original post before continuing; preparation does not submit anything.', { exact: true }).waitFor();
    assert.equal(await hasHorizontalOverflow(page), false, 'The English application warning fits at 390 px');

    await setLocale(page, 'es'); await page.goto(`/applications?id=${closedApplication.id}`);
    const closedRow = page.locator('.tracker-row').filter({ hasText: manuallyClosed.title });
    await closedRow.getByText('Cerrada', { exact: true }).waitFor();
    await page.locator('.preparation-action').getByText('La oferta figura como «Cerrada». Comprueba el anuncio original antes de continuar; preparar no envía nada.', { exact: true }).waitFor();
    const prepareClosed = page.locator('.preparation-action').getByRole('button', { name: 'Preparar mi solicitud', exact: true });
    assert.equal(await prepareClosed.isEnabled(), true, 'A closed job can still be prepared manually');
    const manualPreparation = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().endsWith('/api/v1/preparations'));
    await prepareClosed.click();
    const preparationResponse = await manualPreparation;
    assert.equal(preparationResponse.status(), 200, 'Manual preparation for a closed job is allowed');
    assert.notEqual((await preparationResponse.json()).status, 'BLOCKED');
    assert.equal(await hasHorizontalOverflow(page), false, 'The closed-job warning fits at 390 px');
  });

  await run('english-mobile-tracker-and-search-errors', async () => {
    await setLocale(page, 'en'); await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/applications?id=${app.id}`);
    await page.getByRole('heading', { name: 'Track the employer’s response', exact: true }).waitFor();
    assert.equal(await hasHorizontalOverflow(page), false);
    assert.equal(await page.locator('.tracker-row').count(), 25);
    await page.goto('/searches');
    const newSearch = page.getByRole('button', { name: 'New search', exact: true });
    await page.getByRole('heading', { level: 1 }).waitFor();
    await newSearch.waitFor(); await newSearch.click();
    const company = page.getByLabel('Company (optional)', { exact: true });
    await revealField(company); await company.fill('b'.repeat(201));
    await page.getByRole('button', { name: 'Find jobs', exact: true }).click();
    await page.locator('#search-form-error').waitFor(); assert.match(await page.locator('#search-form-error').innerText(), /200 characters/);
    assert.equal(await hasHorizontalOverflow(page), false);
  });
  // Last: it deletes everything in the isolated workspace (ADR 020).
  await run('delete-all-data-signs-out-and-empties', async () => {
    await setLocale(page, 'es'); await page.setViewportSize({ width: 1096, height: 800 });
    const oldCookie = (await context.cookies()).find((cookie) => cookie.name === 'career_session');
    assert.ok(oldCookie, 'Signed in before deleting');
    await page.goto('/settings');
    await page.getByText('Borrar todos mis datos', { exact: true }).first().click();
    const phrase = page.getByLabel(/Para confirmar, escribe BORRAR TODOS MIS DATOS/);
    const submit = page.getByRole('button', { name: 'Borrar todos mis datos', exact: true });
    await phrase.fill('borrar algo'); assert.equal(await submit.isDisabled(), true, 'A wrong phrase cannot delete');
    await phrase.fill('BORRAR TODOS MIS DATOS'); assert.equal(await submit.isDisabled(), false);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await hasHorizontalOverflow(page), false, 'The panel fits a phone screen');
    await submit.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, 'delete-all-panel-mobile.png'), fullPage: false });
    await page.setViewportSize({ width: 1096, height: 800 });
    const done = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/api/v1/workspace/delete-all'));
    await submit.click();
    assert.equal((await done).status(), 200);
    await page.getByText('Se borraron todos tus datos de esta instalación', { exact: false }).waitFor();
    await page.screenshot({ path: join(output, 'delete-all-done.png'), fullPage: false });
    // Every session stops working: this browser's cookie is cleared, and the old cookie is rejected anywhere.
    assert.equal((await api.get<{ authenticated: boolean }>('/session')).authenticated, false);
    const stale = await browser.newContext({ baseURL: stack.uiUrl });
    try {
      await stale.addCookies([oldCookie!]);
      const response = await stale.request.get(`${stack.uiUrl}/api/v1/applications`, { headers: { Origin: stack.uiUrl } });
      assert.equal(response.status(), 401, 'An old session cookie no longer works');
    } finally { await stale.close(); }
    // A new single-use code signs in to an empty workspace.
    await signIn(page, stack.uiUrl, await stack.readToken());
    const emptied = await api.get<{ revision: number; profile: { identity?: { fullName?: string } } }>('/profile');
    assert.equal(emptied.revision, 1); assert.equal(emptied.profile.identity?.fullName, undefined);
    const rows = await stack.db.query("select (select count(*) from jobs)::int as jobs, (select count(*) from applications)::int as applications, (select count(*) from document_versions)::int as documents, (select count(*) from profile_facts)::int as facts");
    assert.deepEqual(rows.rows[0], { jobs: 0, applications: 0, documents: 0, facts: 0 });
  });
  await context.close(); await stack.assertLiveUntouched();
} finally {
  await browser.close(); await stack.teardown();
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
}
assert.ok(results.length > 0, 'EDGE_ONLY did not select a known scenario');
assert.equal(results.filter((result) => !result.passed).length, 0, `Failed edge cases: ${results.filter((result) => !result.passed).map((result) => result.name).join(', ')}. Evidence: ${output}`);
console.log(`${results.length}/${results.length} edge cases passed. Evidence: ${output}`);
