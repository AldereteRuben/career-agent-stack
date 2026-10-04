import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Scenario } from './scenarios.js';
import { clickWithResumeReplacement, eventually, goTo, hasHorizontalOverflow, setLocale } from './ui.js';

type Profile = { revision: number; profile: Record<string, unknown> };
type Resume = { id: string; language: string | null; sha256: string; reviewReady: boolean };
export const v051First: Scenario = {
  name: 'v051-honest-home-action-and-safe-signout',
  async run({ page, api, marker, allowConsole }) {
    await goTo(page, '/'); await setLocale(page, 'es');
    // The home inbox now uses a context aware primary action; keep checking its destination rather than obsolete copy.
    const action = page.locator('.getting-started').getByRole('link').first();
    assert.match(await action.getAttribute('href') ?? '', /^\/searches(?:\?|$)/); await action.click();
    await page.getByRole('heading', { name: 'Buscar empleo', exact: true }).waitFor();
    await goTo(page, '/profile/setup');
    const name = page.getByLabel('Nombre', { exact: true }); await name.fill(`Unsaved ${marker}`);
    assert.equal(await page.locator('button.profile-chip').count(), 0);
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('button', { name: 'Salir', exact: true }).click();
    assert.equal(await name.inputValue(), `Unsaved ${marker}`);
    allowConsole(/500|Failed to load resource|Internal Server Error/i);
    await page.route('**/api/v1/session', (route) => route.request().method() === 'DELETE' ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"INTERNAL_ERROR"}' }) : route.continue());
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Salir', exact: true }).click();
    await page.locator('.notice[role=alert]').first().waitFor();
    assert.equal((await api.get<{ authenticated: boolean }>('/session')).authenticated, true);
    await page.unroute('**/api/v1/session');
    await page.reload(); await name.waitFor(); assert.equal(await name.inputValue(), `Unsaved ${marker}`);
  },
};
export const v051Last: Scenario = {
  name: 'v051-resume-continuity-preferences-and-form-focus',
  async run({ page, api, marker, artifacts }) {
    const profile = await api.get<Profile>('/profile');
    // Make older approved PDFs stale explicitly; this scenario must not depend on prior scenarios changing identity.
    await api.put('/profile', { expectedRevision: profile.revision, profile: { ...profile.profile, identity: { fullName: `UX Review ${marker}`, email: 'ux-review@example.test' } } });
    const fact = await api.post<{ id: string }>('/profile/facts', { kind: 'achievement', statement: `Usability ${marker}`, tags: [] });
    await api.post(`/profile/facts/${fact.id}/approve`);
    const doc = await api.post<Resume>('/documents', { name: `UX resume ${marker}`, locale: 'es', factIds: [fact.id] });
    assert.equal(doc.language, 'es');
    assert.equal((await api.get<Resume[]>('/documents')).find((row) => row.id === doc.id)?.reviewReady, true);
    await goTo(page, '/profile/setup'); await setLocale(page, 'es');
    await page.getByRole('link', { name: 'Continuar revisando mi CV', exact: true }).click();
    await page.getByRole('heading', { name: 'Revisa esta versión', exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('document'), doc.id);
    await page.reload(); await page.getByRole('heading', { name: 'Revisa esta versión', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Cerrar vista previa', exact: true }).click();
    await page.locator('#resume-history:visible').waitFor();
    await eventually(() => page.getByRole('heading', { name: 'Tus documentos', exact: true }).evaluate((node) => node === document.activeElement), Boolean, 'Closing a reloaded preview focuses the library heading');
    await page.reload(); await page.locator('#resume-history:visible').waitFor();
    const card = page.locator('.document-card').filter({ hasText: `UX resume ${marker}` });
    assert.ok((await card.innerText()).includes('Español'));
    await card.getByRole('button', { name: 'Revisar y aprobar', exact: true }).click();
    await clickWithResumeReplacement(page, page.getByRole('button', { name: 'Cambiar contenido del CV', exact: true }));
    await page.getByRole('heading', { name: 'Preparar una versión', exact: true }).waitFor();
    assert.equal(await page.getByLabel('Nombre de la versión', { exact: true }).inputValue(), `UX resume ${marker}`);
    assert.equal(await page.getByLabel('Idioma del PDF', { exact: true }).inputValue(), 'es');
    assert.equal(await page.locator('.fact-pick input:checked').count(), 1);
    assert.equal((await api.get<Resume[]>('/documents')).find((row) => row.id === doc.id)?.sha256, doc.sha256);
    await page.goBack(); await page.getByRole('heading', { name: 'Revisa esta versión', exact: true }).waitFor();
    await page.goForward(); await page.getByRole('heading', { name: 'Preparar una versión', exact: true }).waitFor();
    for (const locale of ['es', 'en'] as const) {
      await setLocale(page, locale);
      await page.goto(new URL('/profile', page.url()).toString());
      await page.getByRole('heading', { level: 1 }).waitFor();
      await page.getByText(locale === 'es' ? 'Cargando tu perfil…' : 'Loading your profile…', { exact: true }).waitFor({ state: 'hidden' });
      const preferences = page.locator('.profile-preferences');
      assert.equal(await preferences.getAttribute('open'), null);
      await page.setViewportSize({ width: 1096, height: 684 });
      await page.screenshot({ animations: 'disabled', path: join(artifacts, `v051-profile-${locale}.png`) });
      for (const [path, button, heading] of [
        ['/jobs', locale === 'es' ? 'Añadir oferta' : 'Add a job', locale === 'es' ? 'Guardar oferta a mano' : 'Add a job manually'],
        ['/applications', locale === 'es' ? 'Añadir solicitud' : 'Add application', locale === 'es' ? 'Registrar una solicitud' : 'Add an application'],
        ['/boards', locale === 'es' ? 'Añadir empresa' : 'Add company', locale === 'es' ? 'Seguir una empresa' : 'Follow a company'],
      ]) {
        await goTo(page, path!); await page.getByRole('button', { name: button!, exact: true }).first().click();
        await eventually(() => page.getByRole('heading', { name: heading!, exact: true }).evaluate((node) => node === document.activeElement), Boolean, 'Opened form heading receives focus');
      }
      await goTo(page, '/settings');
      assert.equal(await page.getByRole('button', { name: locale === 'es' ? 'Descargar mis datos' : 'Download my data', exact: true }).isVisible(), false);
      await page.getByRole('button', { name: locale === 'es' ? 'Consultando copias…' : 'Checking backups…', exact: true }).waitFor({ state: 'hidden' });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => document.querySelector('#app-sidebar')?.hasAttribute('inert'));
      assert.equal(await hasHorizontalOverflow(page), false);
      await page.screenshot({ animations: 'disabled', path: join(artifacts, `v051-settings-mobile-${locale}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 }); await setLocale(page, 'es');
    let latest = await api.get<Profile>('/profile');
    await api.put('/profile', { expectedRevision: latest.revision, profile: latest.profile });
    assert.equal((await api.get<Resume[]>('/documents')).find((row) => row.id === doc.id)?.reviewReady, true, 'An identical profile save keeps the PDF approvable');
    latest = await api.get<Profile>('/profile');
    await api.put('/profile', { expectedRevision: latest.revision, profile: { ...latest.profile, identity: { ...(latest.profile.identity as object), email: `changed-${marker}@example.com` } } });
    assert.equal((await api.get<Resume[]>('/documents')).find((row) => row.id === doc.id)?.reviewReady, false, 'Stale PDF is not offered as ready to approve');
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Salir', exact: true }).click();
    await page.waitForURL('**/login');
    assert.equal(await page.evaluate(() => Object.keys(sessionStorage).some((key) => key.startsWith('career:draft:v1:'))), false);
  },
};
