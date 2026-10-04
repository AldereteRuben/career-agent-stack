import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Scenario } from './scenarios.js';
import { hasHorizontalOverflow, setLocale } from './ui.js';

export const v071Scenarios: Scenario[] = [
  {
    name: 'v071-search-background-arrivals-and-visible-errors',
    async run({ page, api, db, marker, allowConsole, note }) {
      allowConsole(/Failed to load resource|503|Service Unavailable/);
      const fixture = { externalId: `ux-${marker}`, title: `Usability designer ${marker}`, company: `UX ${marker}`, location: 'Spain', workMode: 'remote', url: `https://remotive.com/remote-jobs/design/ux-${marker}`, description: 'Design accessible forms and test automation.', postedAt: null, raw: {} };
      for (const provider of ['remotive', 'arbeitnow']) await db.query("insert into job_search_provider_cache(provider,payload,fetched_at,next_fetch_at) values($1,$2::jsonb,now(),now()+interval '24 hours') on conflict(provider) do update set payload=excluded.payload,fetched_at=excluded.fetched_at,next_fetch_at=excluded.next_fetch_at,last_error=null", [provider, JSON.stringify(provider === 'remotive' ? [fixture] : [])]);
      const { search } = await api.post<{ search: { id: string } }>('/job-searches', { role: 'Usability designer', company: fixture.company, location: null, enabled: true, frequencyHours: 24, autoPrepare: false, workMode: 'any', language: 'es' });
      const resultSnapshot = await api.get<{ items: Array<Record<string, unknown>>; total: number; resultVersion?: string }>(`/job-searches/${search.id}/results?offset=0`);
      const searchSnapshot = await api.get<{ searches: Array<{ id: string; lastRunStatus: string; lastRunAt: string | null }> }>('/job-searches');
      assert.ok(resultSnapshot.items.length, 'The fictional feed produces a real persisted result');
      const arrival = `New arrival ${marker}`;
      let addArrival = false; let failSave = false; let failSource = false; let resultRouteHits = 0;
      const resultsRoute = `**/api/v1/job-searches/${search.id}/results?*`;
      await page.route(resultsRoute, async (route) => {
        resultRouteHits += 1;
        const body = structuredClone(resultSnapshot);
        if (failSource) { body.items = []; body.total = 0; }
        else if (addArrival && body.items.length) {
          body.items.push({ ...body.items[0], id: `arrival-${marker}`, title: arrival }); body.total++;
          // A synthetic new row advances the result snapshot as a real persisted arrival does.
          body.resultVersion = `${body.resultVersion}:arrival`;
        }
        await route.fulfill({ json: body });
      });
      await page.route('**/api/v1/job-searches', async (route) => {
        if (route.request().method() !== 'GET') {
          if (failSave) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'SERVICE_UNAVAILABLE' }) });
          return route.fallback();
        }
        const body = structuredClone(searchSnapshot);
        if (failSource) for (const item of body.searches) if (item.id === search.id) { item.lastRunStatus = 'FAILED'; item.lastRunAt = new Date().toISOString(); }
        await route.fulfill({ json: body });
      });
      try {
        await setLocale(page, 'es');
        // This scenario validates the empty required-field flow; remove any draft intentionally persisted by
        // earlier scenarios so the form is blank and the creation action remains visible.
        await page.evaluate(() => sessionStorage.removeItem('career:draft:v1:saved-search-form'));
        await page.goto(new URL(`/searches?search=${search.id}`, page.url()).toString());
        await page.getByRole('link', { name: fixture.title, exact: true }).waitFor();
        await page.getByRole('button', { name: 'Nueva búsqueda', exact: true }).click();
        await page.getByRole('button', { name: 'Buscar ofertas', exact: true }).click();
        const role = page.getByLabel('Puesto o palabras clave', { exact: true });
        assert.equal(await role.evaluate((node) => node === document.activeElement), true);
        assert.equal(await role.getAttribute('aria-invalid'), 'true');
        await page.locator('form #search-form-error').waitFor();
        addArrival = true;
        // Exercise the real idle polling interval, without a click, navigation or visibility event.
        await page.getByRole('button', { name: 'Mostrar nuevas ofertas', exact: true }).waitFor({ timeout: 45000 });
        assert.equal(await page.getByRole('link', { name: arrival, exact: true }).count(), 0, 'New rows wait while the current page is being read');
        assert.equal(await role.evaluate((node) => node === document.activeElement), true, 'Background arrival preserves input focus');
        assert.equal(await page.locator('#search-form-error').isVisible(), true, 'Background success does not erase validation');
        await page.getByRole('button', { name: 'Mostrar nuevas ofertas', exact: true }).click();
        await page.getByRole('link', { name: arrival, exact: true }).waitFor();
        await role.fill('Draft kept after failure'); failSave = true;
        await page.getByRole('button', { name: 'Buscar ofertas', exact: true }).click();
        await page.waitForFunction(() => document.activeElement?.id === 'search-form-error');
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        assert.equal(await role.inputValue(), 'Draft kept after failure');
        assert.equal(await page.locator('#search-form-error').isVisible(), true);
        failSource = true;
        // A failed background check updates its status without removing offers the person is reading.
        // It is a local refresh, not a second portal check during the production cooldown.
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await page.getByText(/La última consulta no se pudo completar/).waitFor();
        await page.getByRole('link', { name: fixture.title, exact: true }).waitFor();
        await page.getByRole('button', { name: 'Reintentar ahora', exact: true }).click();
        await page.getByText(/Podrás volver a consultar .*Mientras tanto, puedes revisar las ofertas ya encontradas/).waitFor();
        assert.equal(await role.inputValue(), 'Draft kept after failure', 'A refresh cooldown preserves the separate search draft');
        await page.getByRole('button', { name: 'Mostrar nuevas ofertas', exact: true }).click();
        await page.getByRole('heading', { name: 'No pudimos completar la última consulta', exact: true }).waitFor();
        assert.equal(await page.getByText(/Todavía no encontramos ofertas con estos criterios|Para ver más, prueba a quitar la ubicación|Revisa la escritura del puesto/).count(), 0, 'Provider errors do not ask the user to rewrite valid filters');
        note('Fictional cached feed and intercepted local responses; idle polling, persistent validation, failed save and failed source recovery.');
      } finally {
        note(`Synthetic results endpoint was intercepted ${resultRouteHits} time(s); arrival injection ${addArrival ? 'was' : 'was not'} enabled.`);
        // Wait for any final poll response before leaving the scenario.
        await page.unrouteAll({ behavior: 'wait' });
        await api.patch(`/job-searches/${search.id}`, { enabled: false });
        await page.evaluate(() => sessionStorage.removeItem('career:draft:v1:saved-search-form'));
      }
    },
  },
  {
    name: 'v071-simple-application-continuation-es-en',
    async run({ page, api, marker, artifacts }) {
      const profile = await api.get<{ revision: number; profile: Record<string, unknown> }>('/profile');
      await api.put('/profile', { expectedRevision: profile.revision, profile: { ...profile.profile, identity: { fullName: 'Alex Fictional', email: 'alex@example.test' } } });
      const fact = await api.post<{ id: string }>('/profile/facts', { kind: 'achievement', statement: 'Designed accessible interfaces and automated Playwright tests.', tags: ['design', 'Playwright'] });
      await api.post(`/profile/facts/${fact.id}/approve`, {});
      const job = await api.post<{ id: string }>('/jobs/import', { title: `Interface designer ${marker}`, company: 'Fictional UX Studio', jobUrl: `https://example.test/jobs/${marker}`, description: 'Design accessible interfaces and automated Playwright tests.' });
      const application = await api.post<{ id: string }>('/applications', { jobId: job.id, company: 'Fictional UX Studio', role: `Interface designer ${marker}`, canonicalUrl: `https://example.test/jobs/${marker}`, state: 'DRAFT', notes: '' });
      const origin = '/searches?search=fictional&offset=20';
      const href = `/applications?id=${application.id}&returnTo=${encodeURIComponent(origin)}`;
      for (const locale of ['es', 'en'] as const) {
        const t = (es: string, en: string) => locale === 'es' ? es : en;
        await page.goto(new URL(href, page.url()).toString()); await setLocale(page, locale);
        await page.getByRole('button', { name: t('Preparar mi solicitud', 'Prepare my application'), exact: true }).waitFor();
        await page.getByRole('heading', { name: t('Continúa en la página de la empresa', 'Continue on the employer’s page'), exact: true }).waitFor();
        assert.equal(await page.locator('.assist-panel').getByText(/LEVER/).count(), 0);
        assert.equal(await page.getByRole('link', { name: t('Continuar en la oferta original', 'Continue on the original job page'), exact: true }).getAttribute('href'), `https://example.test/jobs/${marker}`);
        const stage = page.getByLabel(t('Etapa del proceso', 'Hiring stage'), { exact: true });
        assert.equal(await stage.locator('option:checked').innerText(), t('Aún sin contacto', 'No contact yet'));
        const state = page.getByLabel(t('Estado de la solicitud', 'Application status'), { exact: true });
        assert.equal(await state.isVisible(), false);
        await page.getByText(t('Corregir estado o cancelar', 'Correct status or cancel'), { exact: true }).press('Enter');
        await state.waitFor();
        for (const width of [1096, 390, 320]) {
          await page.setViewportSize({ width, height: 844 });
          if (width < 850) await page.locator('#app-sidebar').waitFor({ state: 'hidden' });
          assert.equal(await hasHorizontalOverflow(page), false, `Application layout fits ${locale}/${width}`);
        }
        await page.screenshot({ path: join(artifacts, `v071-application-${locale}.png`), fullPage: true });
      }
      await page.getByRole('button', { name: 'Prepare my application', exact: true }).click();
      await page.waitForURL('**/documents?**');
      assert.equal(new URL(page.url()).searchParams.get('applicationId'), application.id);
      assert.equal(new URL(page.url()).searchParams.get('returnTo'), origin);
      await page.locator('.pdf-preview canvas:not([hidden])').waitFor({ state: 'visible' });
      await page.goto(new URL(href, page.url()).toString()); await setLocale(page, 'es');
      await page.getByText('Preparación de la candidatura revisada', { exact: true }).waitFor();
      assert.equal(await page.getByText('Preparation Created', { exact: true }).count(), 0);
      await api.patch(`/applications/${application.id}`, { state: 'CANCELLED' });
      await page.reload();
      await page.getByRole('heading', { name: 'Sigue la respuesta de la empresa', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Preparar mi solicitud', exact: true }).count(), 0);
      await page.setViewportSize({ width: 1440, height: 1000 });
    },
  },
];
