import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Scenario } from './scenarios.js';
import { eventually, hasHorizontalOverflow, setLocale } from './ui.js';

export const uxReviewScenarios: Scenario[] = [{
  name: 'ux-review-focus-resume-drafts-and-return-filters',
  async run({ page, api, marker, artifacts }) {
    const company = `UX ${marker}`;
    const job = await api.post<{ id: string }>('/jobs/import', { company, title: 'UX role one', jobUrl: `https://example.com/${marker}/ux-one` });
    const other = await api.post<{ id: string }>('/jobs/import', { company, title: 'UX role two', jobUrl: `https://example.com/${marker}/ux-two` });
    const profile = await api.get<{ revision: number; profile: Record<string, unknown> }>('/profile');
    await api.put('/profile', { expectedRevision: profile.revision, profile: { ...profile.profile, identity: { fullName: 'UX Example', email: 'ux@example.test' } } });
    const fact = await api.post<{ id: string }>('/profile/facts', { kind: 'achievement', statement: `UX example ${marker}` });
    await api.post(`/profile/facts/${fact.id}/approve`);
    await page.goto(new URL(`/profile?jobId=${job.id}`, page.url()).toString()); await setLocale(page, 'es');
    await page.getByRole('navigation', { name: 'Secciones de tu perfil' }).getByRole('link', { name: /Revisar lo guardado/ }).click();
    await page.locator('.fact-row').filter({ hasText: `UX example ${marker}` }).getByRole('button', { name: 'Editar', exact: true }).click();
    await eventually(() => page.evaluate(() => document.activeElement?.textContent), (text) => text === 'Editar dato del CV', 'Editing moves keyboard focus to its heading');
    await eventually(() => page.getByRole('heading', { name: 'Editar dato del CV' }).boundingBox(), (rect) => Boolean(rect && rect.y >= 0 && rect.y < 1000), 'Edit form is brought into view after scrolling');
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Cancelar edición', exact: true }).click();
    await page.getByRole('navigation', { name: 'Pasos para esta solicitud' }).getByRole('link', { name: 'Preparar CV', exact: true }).click();
    await page.waitForURL('**/documents?**');
    const choice = () => page.locator('.fact-pick').filter({ hasText: `UX example ${marker}` }).locator('input');
    await choice().check();
    await page.getByLabel('Nombre de la versión', { exact: true }).fill(`Draft UX ${marker}`);
    await page.getByLabel('Idioma del PDF', { exact: true }).selectOption('en');
    await page.getByRole('link', { name: 'Añadir o corregir datos del perfil', exact: true }).click();
    await page.waitForURL('**/profile?**');
    await page.getByRole('navigation', { name: 'Pasos para esta solicitud' }).getByRole('link', { name: 'Preparar CV', exact: true }).click();
    await page.waitForURL('**/documents?**');
    await eventually(() => page.getByLabel('Nombre de la versión', { exact: true }).inputValue(), (name) => name === `Draft UX ${marker}`, 'Resume name survives profile navigation');
    await page.reload();
    await choice().waitFor();
    assert.equal(await choice().isChecked(), true);
    assert.equal(await page.getByLabel('Idioma del PDF', { exact: true }).inputValue(), 'en');
    await page.getByLabel('¿Para qué oferta?', { exact: true }).selectOption(other.id);
    await page.waitForURL((url) => url.searchParams.get('jobId') === other.id);
    await eventually(() => page.getByLabel('Nombre de la versión', { exact: true }).inputValue(), (name) => name.includes('UX role two'), 'Another job starts with its own preparation');
    assert.equal(await choice().isChecked(), false);
    await page.getByLabel('¿Para qué oferta?', { exact: true }).selectOption(job.id);
    await page.waitForURL((url) => url.searchParams.get('jobId') === job.id);
    await eventually(() => page.getByLabel('Nombre de la versión', { exact: true }).inputValue(), (name) => name === `Draft UX ${marker}`, 'Switching back restores this job draft');
    assert.equal(await choice().isChecked(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('.sidebar').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    assert.equal(await hasHorizontalOverflow(page), false);
    await page.screenshot({ path: join(artifacts, 'ux-resume-mobile.png'), animations: 'disabled' });
    await api.post(`/profile/facts/${fact.id}/reject`);
    await page.reload();
    await page.getByText('Algunos datos de tu selección cambiaron o dejaron de estar confirmados.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Generar y revisar', exact: false }).isDisabled(), true);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await api.post(`/jobs/${job.id}/shortlist`, { decision: 'SHORTLISTED' });
    const query = new URLSearchParams({ q: company, scope: 'favorites', page: '1' });
    await page.goto(new URL(`/jobs?${query}`, page.url()).toString());
    await page.locator('.job-card').filter({ hasText: 'UX role one' }).getByRole('link', { name: 'Ver detalles', exact: true }).click();
    await page.getByRole('link', { name: 'Volver a ofertas', exact: false }).click();
    await page.waitForURL((url) => url.pathname === '/jobs' && url.searchParams.get('scope') === 'favorites');
    assert.equal(new URL(page.url()).searchParams.get('q'), company);
    await eventually(() => page.locator('.job-card').count(), (count) => count === 1, 'Return keeps search and favorite filter');
    await page.goto(new URL(`/profile?jobId=${job.id}`, page.url()).toString());
    await page.getByRole('navigation', { name: 'Secciones de tu perfil' }).waitFor();
    await page.screenshot({ path: join(artifacts, 'ux-profile-desktop.png'), animations: 'disabled' });
  },
}];

uxReviewScenarios.push({
  name: 'job-discovery-master-detail-responsive-and-locale',
  async run({ page, api, marker, artifacts }) {
    const company = `Design ${marker}`;
    const title = `Product Designer ${marker}`;
    await api.post<{ id: string }>('/jobs/import', { company, title, description: `Design accessible products and document research decisions for ${marker}.`, jobUrl: `https://example.com/${marker}/designer` });
    const secondTitle = `UX Designer ${marker}`;
    const second = await api.post<{ id: string }>('/jobs/import', { company, title: secondTitle, description: `Build clear workflows and test responsive interfaces for ${marker}.`, jobUrl: `https://example.com/${marker}/ux-designer` });
    const listUrl = `/jobs?q=${encodeURIComponent(company)}&scope=active`;
    for (const locale of ['es', 'en'] as const) {
      const labels = locale === 'es'
        ? { description: 'Descripción de la oferta', full: 'Ver detalles completos', back: 'Volver a las ofertas' }
        : { description: 'Job description', full: 'Open full details', back: 'Back to jobs' };
      for (const [viewport, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]] as const) {
        await setLocale(page, locale);
        await page.setViewportSize({ width, height });
        await page.goto(new URL(listUrl, page.url()).toString());
        const secondCard = page.locator('.job-card').filter({ hasText: secondTitle });
        const secondLink = secondCard.getByRole('link', { name: secondTitle, exact: true });
        await secondCard.waitFor(); await secondLink.waitFor();
        const panes = page.getByTestId('job-master-detail').locator(':scope > section');
        if (viewport === 'desktop') {
          await secondLink.focus(); await page.keyboard.press('Enter');
          await page.waitForURL((url) => url.searchParams.get('selected') === second.id);
          await panes.nth(1).waitFor({ state: 'visible' });
          await panes.nth(0).waitFor({ state: 'visible' });
          assert.equal(await secondLink.evaluate((node) => node === document.activeElement), true, `${locale} desktop selection keeps keyboard focus on the list so arrow-through review is not interrupted`);
        } else {
          assert.equal(await hasHorizontalOverflow(page), false, `${locale} job list overflows at mobile width`);
          await secondLink.focus(); await page.keyboard.press('Enter');
          await page.waitForURL((url) => url.searchParams.get('selected') === second.id);
          await panes.nth(0).waitFor({ state: 'hidden' });
          await page.getByRole('button', { name: labels.back, exact: true }).waitFor();
          assert.equal(await page.evaluate(() => document.activeElement?.tagName === 'H2' && Boolean(document.activeElement.closest('section'))), true, `${locale} mobile selection moves focus to the preview heading`);
          assert.equal(await page.evaluate(() => document.activeElement?.textContent ?? ''), secondTitle, `${locale} focus lands on the selected job's title`);
        }
        const previewPane = panes.nth(1);
        await previewPane.getByRole('heading', { name: secondTitle, exact: true }).waitFor();
        await previewPane.getByRole('heading', { name: labels.description, exact: true }).waitFor();
        await previewPane.getByRole('link', { name: labels.full, exact: true }).waitFor();
        const selectedUrl = new URL(page.url());
        assert.equal(selectedUrl.searchParams.get('q'), company, `${locale} ${viewport} selection must preserve search`);
        assert.equal(selectedUrl.searchParams.get('scope'), 'active', `${locale} ${viewport} selection must preserve scope`);
        assert.equal(await hasHorizontalOverflow(page), false, `${locale} job detail overflows at ${viewport} width`);
        if (locale === 'es' && viewport === 'desktop') {
          await page.screenshot({ path: join(artifacts, 'jobs-list-es.png'), animations: 'disabled' });
        }
        if (locale === 'es' && viewport === 'desktop') {
          await previewPane.getByRole('link', { name: labels.full, exact: true }).click();
          await page.waitForURL((url) => url.pathname === `/jobs/${second.id}`);
          await page.getByRole('heading', { name: 'Prepara tu solicitud', exact: true }).waitFor();
          await page.locator('.back-link').click();
          await page.waitForURL((url) => url.pathname === '/jobs' && url.searchParams.get('selected') === second.id && url.searchParams.get('q') === company);
          await page.screenshot({ path: join(artifacts, 'job-detail-overview-es.png'), animations: 'disabled' });
        }
        if (locale === 'en' && viewport === 'desktop') {
          await page.screenshot({ path: join(artifacts, 'job-detail-overview-en.png'), animations: 'disabled' });
        }
        if (viewport === 'mobile') {
          await page.getByRole('button', { name: labels.back, exact: true }).click();
          await page.waitForURL((url) => url.pathname === '/jobs' && !url.searchParams.has('selected'));
          await page.getByTestId('job-master-detail').locator(':scope > section').nth(0).waitFor({ state: 'visible' });
          assert.equal(await secondLink.evaluate((node) => node === document.activeElement), true, `${locale} going back returns focus to the job that was open`);
          const listUrlAfterBack = new URL(page.url());
          assert.equal(listUrlAfterBack.searchParams.get('q'), company);
          assert.equal(listUrlAfterBack.searchParams.get('scope'), 'active');
          assert.equal(await hasHorizontalOverflow(page), false, `${locale} job list overflows after back at mobile width`);
        }
      }
    }
  },
});

uxReviewScenarios.push({
  name: 'application-tracker-mobile-selection-and-locale',
  async run({ page, api, marker, artifacts }) {
    const company = `Tracker ${marker}`;
    const role = `UX Researcher ${marker}`;
    const application = await api.post<{ id: string }>('/applications', {
      company,
      role,
      canonicalUrl: `https://example.com/${marker}/application`,
      state: 'DRAFT',
    });

    for (const locale of ['es', 'en'] as const) {
      const trackingHeading = locale === 'es' ? 'Seguimiento' : 'Tracking';
      const activityHeading = locale === 'es' ? 'Actividad' : 'Activity';
      for (const [viewport, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]] as const) {
        await setLocale(page, locale);
        await page.setViewportSize({ width, height });
        await page.goto(new URL(`/applications?id=${application.id}`, page.url()).toString());
        await page.getByRole('heading', { name: role, exact: true }).waitFor();
        await page.locator('.tracker-row[aria-current="true"]').filter({ hasText: role }).waitFor({ state: 'attached' });
        await page.getByRole('heading', { name: trackingHeading, exact: true }).waitFor();
        const activityDisclosure = page.locator('.application-detail-activity');
        if (!(await activityDisclosure.evaluate((element) => (element as HTMLDetailsElement).open))) await activityDisclosure.locator('summary').click();
        await page.getByRole('heading', { name: activityHeading, exact: true }).waitFor();
        const list = page.locator('.tracker-list');
        await list.waitFor({ state: viewport === 'desktop' ? 'visible' : 'hidden' });
        assert.equal(await hasHorizontalOverflow(page), false, `${locale} application detail overflows at ${viewport} width`);
        if (locale === 'es' && viewport === 'desktop') {
          await page.screenshot({ path: join(artifacts, 'application-tracker-detail-es.png'), animations: 'disabled' });
        }
        if (locale === 'en' && viewport === 'mobile') {
          await page.screenshot({ path: join(artifacts, 'application-tracker-mobile-en.png'), fullPage: true, animations: 'disabled' });
        }
        if (viewport === 'mobile') {
          const backName = locale === 'es' ? 'Volver a la lista de solicitudes' : 'Back to application list';
          await page.getByRole('button', { name: backName, exact: true }).click();
          await page.waitForURL((url) => url.pathname === '/applications' && !url.searchParams.has('id'));
          await list.waitFor({ state: 'visible' });
          assert.equal(await hasHorizontalOverflow(page), false, `${locale} application list overflows at mobile width`);
        }
      }
    }
  },
});

uxReviewScenarios.push({
  name: 'activity-calendar-uses-the-viewers-calendar-days',
  async run({ page, api, marker }) {
    const company = `Activity ${marker}`;
    const job = await api.post<{ id: string }>('/jobs/import', { company, title: `Activity role ${marker}`, jobUrl: `https://example.com/${marker}/activity` });
    // The same instant falls on different calendar days in far-apart zones; each response must follow the zone asked for.
    const localDay = (timeZone: string, date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
    for (const timeZone of ['UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Europe/Madrid']) {
      const day = localDay(timeZone);
      const summary = await api.get<{ activityByDay: Array<{ day: string; jobs: number }> }>(`/summary?tz=${encodeURIComponent(timeZone)}`);
      assert.ok((summary.activityByDay.find((item) => item.day === day)?.jobs ?? 0) >= 1, `${timeZone}: the summary counts the new job on ${day}`);
      const detail = await api.get<{ day: string; jobsTotal: number; jobs: Array<{ id: string }> }>(`/activity?day=${day}&tz=${encodeURIComponent(timeZone)}`);
      assert.ok(detail.jobs.some((item) => item.id === job.id), `${timeZone}: the day detail lists the new job on ${day}`);
      assert.ok(detail.jobsTotal >= detail.jobs.length);
      const yesterday = localDay(timeZone, new Date(Date.now() - 86_400_000));
      const other = await api.get<{ jobs: Array<{ id: string }> }>(`/activity?day=${yesterday}&tz=${encodeURIComponent(timeZone)}`);
      assert.equal(other.jobs.some((item) => item.id === job.id), false, `${timeZone}: the job does not also appear on the previous day`);
    }
    for (const bad of ['/activity', '/activity?day=2026-02-30', '/activity?day=tomorrow', '/activity?day=2026-01-01&tz=Not/AZone', '/activity?day=2026-01-01&tz=%27%3B--', '/summary?tz=Not/AZone']) {
      await assert.rejects(() => api.get(bad), /INVALID_INPUT|400/, `${bad} is rejected`);
    }
    // A day without activity answers with empty lists and zero totals, not an error.
    const empty = await api.get<{ jobsTotal: number; applicationsTotal: number; jobs: unknown[]; applications: unknown[] }>('/activity?day=2001-01-01&tz=UTC');
    assert.deepEqual([empty.jobsTotal, empty.applicationsTotal, empty.jobs.length, empty.applications.length], [0, 0, 0, 0]);

    // The calendar shows the job on today's cell and opens it from the day detail.
    for (const locale of ['es', 'en'] as const) {
      await setLocale(page, locale);
      await page.goto(new URL('/overview', page.url()).toString());
      await page.getByRole('heading', { name: locale === 'es' ? 'Calendario de actividad' : 'Activity calendar', exact: true }).waitFor();
      const today = page.locator('button[aria-current="date"]');
      await today.waitFor();
      assert.match(await today.getAttribute('aria-label') ?? '', locale === 'es' ? /[1-9]\d* ofertas encontradas/ : /[1-9]\d* jobs found/);
      await today.click();
      await page.getByRole('link', { name: `Activity role ${marker}`, exact: true }).waitFor();
    }
    await setLocale(page, 'es');
  },
});
