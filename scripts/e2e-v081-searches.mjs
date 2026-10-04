/* global document, sessionStorage */
import assert from 'node:assert/strict';
import { join } from 'node:path';

/** Deterministic UX regressions, authenticated only against the coordinator's disposable stack. */
export async function checkSearchUsability({ browser, uiUrl, cookies, artifacts }) {
  const url = new URL(uiUrl);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port && !['3000', '3001'].includes(url.port));
  const context = await browser.newContext({ viewport: { width: 1096, height: 684 } });
  await context.addCookies(cookies);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const now = new Date().toISOString(); const next = new Date(Date.now() + 3_600_000).toISOString();
  const base = { company: null, location: null, workMode: 'any', frequencyHours: 24, enabled: true, autoPrepare: false, language: 'es', revision: 1, matcherVersion: 2, providerIds: ['remotive'], includeRelated: false, lastRunAt: now, nextRunAt: next, lastRunStatus: 'SUCCEEDED', lastResultCount: 0, lastNewCount: 0, lastError: null, latestRun: { id: 'run', status: 'SUCCEEDED', finishedAt: now, error: null, sources: [{ provider: 'remotive', status: 'CACHED', coverage: 'COMPLETE', fetchedAt: now, error: null }] } };
  const first = { ...base, id: '11111111-1111-4111-8111-111111111111', role: 'QA Engineer' };
  const second = { ...base, id: '22222222-2222-4222-8222-222222222222', role: 'SDET' };
  let searches = []; let jobs = []; let reviews = 0; let creates = 0;
  const json = (route, body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/v1/job-searches**', async (route) => {
    const request = route.request(); const u = new URL(request.url());
    if (request.method() === 'GET' && u.pathname === '/api/v1/job-searches') return json(route, { searches: searches.map((s) => ({ ...s, lastNewCount: jobs.filter((j) => !j.seenAt && j.shortlistDecision === 'UNREVIEWED').length })), coverage: {} });
    if (request.method() === 'GET' && u.pathname.endsWith('/results')) {
      const view = u.searchParams.get('view');
      const items = jobs.filter((j) => view === 'new' ? !j.seenAt && j.shortlistDecision === 'UNREVIEWED' : view === 'saved' ? j.shortlistDecision === 'SHORTLISTED' : view === 'archived' ? j.shortlistDecision === 'ARCHIVED' : j.shortlistDecision !== 'ARCHIVED');
      return json(route, { items: items.slice(0, Number(u.searchParams.get('limit') ?? 20)), total: items.length, resultVersion: `${reviews}-${view}`, latestRun: null });
    }
    if (request.method() === 'POST' && u.pathname.endsWith('/review')) { reviews++; jobs = jobs.map((j) => ({ ...j, seenAt: now })); return json(route, { ok: true }); }
    if (request.method() === 'POST') creates++;
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'UNEXPECTED_FIXTURE_MUTATION' }) });
  });
  const go = async () => { await page.goto(`${uiUrl}/searches?search=all&view=new&sort=relevance&offset=0`); };
  const locale = async (value) => {
    if (await page.locator('html').getAttribute('lang') !== value) await page.getByRole('button', { name: value === 'es' ? 'Español' : 'English', exact: true }).click();
  };
  try {
    await go(); await locale('es');
    await page.getByRole('heading', { name: '¿Qué trabajo buscas?', exact: true }).waitFor();
    assert.equal(await page.locator('#search-result-list').count(), 0, 'First use has no empty results scaffolding');
    await page.getByLabel('Puesto o palabras clave', { exact: true }).fill('QA Engineer');
    await page.reload();
    assert.equal(await page.getByLabel('Puesto o palabras clave', { exact: true }).inputValue(), 'QA Engineer', 'Draft survives reload');
    await page.evaluate(() => sessionStorage.clear());

    searches = [{ ...first, lastRunStatus: 'FAILED', lastError: 'Fixture failure', latestRun: { ...base.latestRun, status: 'FAILED', error: 'Fixture failure', sources: [{ ...base.latestRun.sources[0], status: 'FAILED', error: 'Fixture failure' }] } }];
    await go();
    await page.getByRole('heading', { name: 'No pudimos completar la última consulta', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Estamos buscando ofertas', exact: true }).count(), 0, 'Finished failure is not presented as running');
    searches = [first]; await go();
    await page.getByRole('heading', { name: 'Todavía no hay coincidencias', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'No hay ofertas nuevas por revisar', exact: true }).count(), 0, 'Zero first matches does not claim prior review');
    await page.getByRole('button', { name: 'Editar búsqueda', exact: true }).click();
    assert.equal(await page.getByLabel('Puesto o palabras clave', { exact: true }).inputValue(), 'QA Engineer');
    await page.getByRole('button', { name: 'Guardar cambios', exact: true }).waitFor();
    assert.equal(creates, 0, 'Adjusting one search does not create another');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Cancelar edición', exact: true }).click();
    searches = [first, second]; await go();
    await page.getByRole('button', { name: 'Elegir búsqueda para ajustar', exact: true }).click();
    await page.locator('#manage-searches').waitFor();
    assert.equal(await page.locator('#search-form-title').count(), 0, 'Adjusting aggregate asks which search instead of opening create');
    await page.getByRole('button', { name: /Gestionar búsquedas/ }).click();

    searches = [{ ...first, lastRunStatus: 'PARTIAL', latestRun: { ...base.latestRun, status: 'PARTIAL', sources: [{ ...base.latestRun.sources[0], coverage: 'BOUNDED' }] } }];
    await go(); await page.getByRole('heading', { name: 'Todavía no hay coincidencias', exact: true }).waitFor();
    assert.equal(await page.getByText('La última consulta no se pudo completar.', { exact: true }).count(), 0, 'Bounded coverage is not a failed provider');

    searches = [first, second];
    jobs = [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'QA Engineer — fictional role', company: 'Example Studio', location: 'Remote', canonicalUrl: 'https://example.test/qa', seenAt: null, shortlistDecision: 'UNREVIEWED', matchedAt: now, searchScore: 90, searchReasons: ['ROLE_EXACT'], searchIds: [first.id, second.id], sources: [{ provider: 'remotive', url: 'https://example.test/qa', postedAt: now }] }];
    await go();
    await page.getByRole('link', { name: 'QA Engineer — fictional role', exact: true }).waitFor();
    const scopes = page.getByRole('group', { name: 'Tus búsquedas', exact: true });
    await scopes.getByRole('button', { name: 'Todas mis búsquedas (1)', exact: true }).waitFor();
    assert.equal(await page.getByRole('tablist').count(), 0);
    const filters = page.getByRole('group', { name: 'Mostrar ofertas', exact: true });
    await filters.getByRole('button', { name: 'Todas', exact: true }).focus(); await page.keyboard.press('Enter');
    assert.equal(await filters.getByRole('button', { name: 'Todas', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Guardadas');
    await filters.getByRole('button', { name: /^Nuevas/ }).click();
    for (const lang of ['es', 'en']) {
      await locale(lang);
      for (const width of [320, 390, 1096]) {
        await page.setViewportSize({ width, height: 844 });
        if (width < 900) await page.waitForFunction(() => document.querySelector('#app-sidebar').getBoundingClientRect().right <= 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1), false, `${lang} search overflow at ${width}`);
        if (width === 390) {
          const card = await page.getByRole('link', { name: 'QA Engineer — fictional role', exact: true }).boundingBox();
          assert.ok(card && card.y < 844, `First offer should appear on the first mobile screen: ${JSON.stringify(card)}`);
        }
        await page.screenshot({ path: join(artifacts, `v081-offers-${lang}-${width}.png`), fullPage: true });
      }
    }
    await locale('es');
    await page.locator('#search-result-list details summary').first().click();
    await page.getByRole('button', { name: 'Marcar como revisada', exact: true }).click();
    await page.getByRole('heading', { name: 'No hay ofertas nuevas por revisar', exact: true }).waitFor();
    await scopes.getByRole('button', { name: 'QA Engineer', exact: true }).waitFor();
    await scopes.getByRole('button', { name: 'SDET', exact: true }).waitFor();
    await scopes.getByRole('button', { name: 'Todas mis búsquedas', exact: true }).waitFor();
    assert.equal(reviews, 1, 'One review updates every visible counter without waiting for polling');
    assert.deepEqual(errors, []);
    console.log('✓ v0.8.1 first use, drafts, failed/limited/empty states, correct edit, deduplicated immediate counts, keyboard, ES/EN and mobile offers-first');
  } finally { await context.close(); }
}
