import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Scenario } from './scenarios.js';
import { hasHorizontalOverflow, mainNavigation, revealField, setLocale } from './ui.js';

/** Measure the first-use interaction budget with fictional local responses, never live portals. */
export const v082Scenario: Scenario = {
  name: 'v082-search-first-simple-navigation-and-progressive-options',
  async run({ page, marker, artifacts, note }) {
    const searchId = '82828282-8282-4282-8282-828282828282';
    const jobId = '82828282-0000-4000-8000-828282828282';
    let submitted: Record<string, unknown> | undefined;
    const now = new Date().toISOString();
    const next = new Date(Date.now() + 86_400_000).toISOString();
    const result = { id: jobId, title: `QA Engineer ${marker}`, company: 'Fictional First Company', location: 'Remote', canonicalUrl: 'https://example.test/first-job', seenAt: null, shortlistDecision: 'UNREVIEWED', matchedAt: now, searchScore: 90, searchReasons: ['ROLE_EXACT'], searchIds: [searchId], sources: [{ provider: 'remotive', url: 'https://example.test/first-job', postedAt: now }] };
    const search = () => ({ ...submitted, id: searchId, revision: 1, lastRunStatus: 'SUCCEEDED', lastRunAt: now, nextRunAt: next, lastResultCount: 1, lastNewCount: 1, lastError: null, latestRun: { id: 'first-run', status: 'SUCCEEDED', finishedAt: now, error: null, sources: [] } });
    await page.route('**/api/v1/job-searches**', async (route) => {
      const request = route.request(); const url = new URL(request.url());
      if (request.method() === 'POST' && url.pathname === '/api/v1/job-searches') {
        submitted = request.postDataJSON();
        return route.fulfill({ status: 201, json: { search: search(), runId: 'first-run', refresh: null } });
      }
      if (request.method() === 'GET' && url.pathname === '/api/v1/job-searches') return route.fulfill({ json: { searches: submitted ? [search()] : [], coverage: {} } });
      if (request.method() === 'GET' && url.pathname.endsWith('/results')) return route.fulfill({ json: { items: submitted ? [result] : [], total: submitted ? 1 : 0, resultVersion: submitted ? 'first' : 'empty' } });
      return route.fulfill({ status: 400, json: { error: 'UNEXPECTED_FIXTURE_ACTION' } });
    });
    try {
      for (const locale of ['es', 'en'] as const) {
        const t = (es: string, en: string) => locale === 'es' ? es : en;
        await page.setViewportSize({ width: 1096, height: 844 });
        await page.goto(new URL('/', page.url()).toString());
        await page.waitForURL((url) => url.pathname === '/searches');
        await setLocale(page, locale);
        await page.getByRole('heading', { name: t('¿Qué trabajo buscas?', 'What job are you looking for?'), exact: true }).waitFor();
        const form = page.locator('form').filter({ has: page.locator('#search-role') });
        assert.equal(await form.locator('input:visible').count(), 2, 'A first search exposes only role and optional location');
        assert.equal(await form.getByRole('combobox').count(), 0, 'No configuration dropdown is required before the first search');
        assert.equal(await form.getByRole('checkbox').count(), 0, 'Automatic setup does not require technical choices');
        const nav = mainNavigation(page);
        assert.deepEqual(await nav.getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href'))), ['/searches', '/jobs?scope=favorites', '/applications']);
        assert.equal(await page.locator('#app-sidebar a[href="/profile"]').isVisible(), false, 'Profile is available on demand instead of blocking discovery');
        const tools = page.getByText(t('Perfil y herramientas', 'Profile and tools'), { exact: true });
        await tools.click();
        for (const href of ['/profile', '/documents', '/boards', '/settings', '/overview']) await page.locator(`#app-sidebar a[href="${href}"]`).waitFor({ state: 'visible' });
        assert.equal(await nav.getByRole('link').count(), 3, 'Secondary tools do not become additional primary destinations');
        await tools.click();
        for (const width of [390, 320]) {
          await page.setViewportSize({ width, height: 844 });
          await page.waitForFunction(() => document.querySelector('#app-sidebar')!.getBoundingClientRect().right <= 1);
          assert.equal(await hasHorizontalOverflow(page), false, `First search fits ${locale}/${width}`);
          const button = page.getByRole('button', { name: t('Buscar ofertas', 'Find jobs'), exact: true });
          if (width === 390) {
            const box = await button.boundingBox();
            assert.ok(box && box.y >= 0 && box.y + box.height <= 844, `First search action is visible without scrolling (${locale}): ${JSON.stringify(box)}`);
          }
          await page.screenshot({ path: join(artifacts, `v082-first-search-${locale}-${width}.png`), fullPage: true });
          await page.getByRole('button', { name: t('Abrir menú', 'Open menu'), exact: true }).click();
          for (let i = 0; i < 14; i++) {
            await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(() => {
              const active = document.activeElement as HTMLElement | null;
              return Boolean(active && document.querySelector('#app-sidebar')?.contains(active) && active.getClientRects().length && !active.closest('[inert]'));
            }), true, 'Collapsed secondary tools cannot trap keyboard focus off screen');
          }
          await page.keyboard.press('Escape');
          assert.equal(await page.getByRole('button', { name: t('Abrir menú', 'Open menu'), exact: true }).evaluate((node) => node === document.activeElement), true);
        }
        await page.setViewportSize({ width: 1096, height: 844 });
        const company = page.locator('#search-company');
        await revealField(company); await company.fill('Fictional company');
        await page.reload(); await company.waitFor();
        assert.equal(await company.inputValue(), 'Fictional company', 'Restored optional criteria are visible, not silently applied');
        await page.evaluate(() => sessionStorage.clear());
      }
      await page.goto(new URL('/', page.url()).toString());
      await setLocale(page, 'es');
      await page.locator('#search-role').fill('QA Engineer');
      await page.getByRole('button', { name: 'Buscar ofertas', exact: true }).click();
      await page.getByRole('link', { name: result.title, exact: true }).waitFor();
      assert.equal(submitted?.enabled, true, 'The first search repeats automatically');
      assert.equal(submitted?.frequencyHours, 24);
      assert.equal(submitted?.autoPrepare, false, 'Simplification does not silently opt into application preparation');
      assert.equal(submitted?.matcherVersion, 2);
      assert.deepEqual(submitted?.providerIds, ['remotive', 'arbeitnow', 'himalayas'], 'Simplification preserves the source defaults');
      assert.equal(submitted?.company, null);
      assert.match(String(submitted?.idempotencyKey), /^[a-f0-9-]{36}$/i);
      assert.equal(await page.locator('#search-form-title').count(), 0, 'One submit leads directly to results');
      assert.equal(await page.getByRole('group', { name: 'Tus búsquedas', exact: true }).count(), 0, 'A single search does not need an All versus current selector');
      await page.screenshot({ path: join(artifacts, 'v082-first-results.png'), fullPage: true });
      for (const locale of ['es', 'en'] as const) {
        await setLocale(page, locale);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(new URL('/jobs', page.url()).toString());
        await page.getByRole('heading', { name: locale === 'es' ? 'Ofertas encontradas' : 'Found jobs', exact: true }).waitFor();
        await page.getByRole('button', { name: locale === 'es' ? 'Abrir menú' : 'Open menu', exact: true }).click();
        assert.equal(await page.locator('#app-sidebar a[href="/jobs"]').getAttribute('aria-current'), 'page');
        await mainNavigation(page).getByRole('link', { name: locale === 'es' ? /^Guardadas/ : /^Saved jobs/ }).click();
        await page.waitForURL((url) => url.pathname === '/jobs' && url.searchParams.get('scope') === 'favorites');
        await page.getByRole('heading', { name: locale === 'es' ? 'Guardadas' : 'Saved jobs', exact: true }).waitFor();
        await page.waitForFunction(() => document.querySelector('#app-sidebar')!.getBoundingClientRect().right <= 1);
        assert.equal(await page.locator('#app-sidebar a[href="/jobs?scope=favorites"]').getAttribute('aria-current'), 'page', 'Query-only navigation highlights Saved jobs and closes the mobile menu');
        assert.equal(await page.locator('#app-sidebar a[href="/jobs"]').getAttribute('aria-current'), null);
        assert.equal(await hasHorizontalOverflow(page), false);
        await page.screenshot({ path: join(artifacts, `v082-saved-jobs-${locale}-390.png`), fullPage: true });
      }
      note('ES/EN: three primary links, two initial fields, no forced profile, automatic defaults, native disclosures, restored optional criteria and mobile keyboard trap. Job replies are fictional; production API matching is tested separately.');
    } finally {
      await page.unrouteAll({ behavior: 'wait' });
      await page.evaluate(() => sessionStorage.clear());
      await page.setViewportSize({ width: 1440, height: 1000 });
      await setLocale(page, 'es');
    }
  },
};
