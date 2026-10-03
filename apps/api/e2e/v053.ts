import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import type { Scenario } from './scenarios.js';
import { eventually, goTo, hasHorizontalOverflow, setLocale } from './ui.js';

type Profile = { revision: number; profile: Record<string, unknown>; facts: Array<{ id: string; approvalStatus: string }> };
type Resume = { id: string; name: string; sha256: string; approvalStatus: string; assistReady: boolean; reviewReady: boolean };
type Application = { id: string; documentId: string | null };
const lever = 'https://jobs.lever.co/fixture/33333333-3333-4333-8333-333333333333';
const t = (locale: 'es' | 'en', es: string, en: string) => locale === 'es' ? es : en;

/** Message and actions share one column: actions sit below the text, inside the viewport, after it in reading order. */
async function assertNoticeLayout(page: Page, notice: Locator, label: string) {
  const layout = await notice.evaluate((node) => {
    const message = node.querySelector('.notice-message')!.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    const actions = [...node.querySelectorAll('.notice-actions button, .notice-actions a')].map((element) => element.getBoundingClientRect());
    const order = node.querySelector('.notice-message')!.compareDocumentPosition(node.querySelector('.notice-actions')!);
    return { messageWidth: message.width, boxWidth: box.width, messageBottom: message.bottom, actions: actions.map((rect) => ({ top: rect.top, left: rect.left, right: rect.right })), viewport: document.documentElement.clientWidth, actionsFollow: Boolean(order & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  assert.ok(layout.actions.length > 0, `${label}: actions rendered`);
  assert.ok(layout.messageWidth >= layout.boxWidth * 0.7, `${label}: text keeps the notice width (${layout.messageWidth}/${layout.boxWidth})`);
  assert.ok(layout.actionsFollow, `${label}: actions follow the message in reading order`);
  for (const rect of layout.actions) {
    assert.ok(rect.top >= layout.messageBottom - 1, `${label}: actions sit below the text`);
    assert.ok(rect.left >= 0 && rect.right <= layout.viewport + 1, `${label}: action inside the viewport (${rect.right} > ${layout.viewport})`);
  }
  assert.equal(await hasHorizontalOverflow(page), false, `${label}: no horizontal overflow`);
}

export const v053Scenarios: Scenario[] = [
  {
    name: 'v053-notice-actions-wrap-on-mobile',
    async run({ page, marker, artifacts }) {
      await goTo(page, '/jobs'); await setLocale(page, 'es');
      await page.getByRole('button', { name: 'Añadir oferta', exact: true }).click();
      await page.getByLabel('Empresa', { exact: true }).fill(`Notice ${marker}`);
      await goTo(page, '/applications');
      await page.getByRole('button', { name: 'Añadir solicitud', exact: true }).click();
      await page.getByLabel('Empresa', { exact: true }).fill(`Notice ${marker}`);
      try {
        for (const locale of ['es', 'en'] as const) {
          await setLocale(page, locale);
          for (const width of [320, 390]) {
            await page.setViewportSize({ width, height: 844 });
            for (const [path, loading] of [['/jobs', t(locale, 'Cargando ofertas…', 'Loading jobs…')], ['/applications', t(locale, 'Cargando solicitudes…', 'Loading applications…')]] as const) {
              await page.goto(new URL(path, page.url()).toString());
              await page.getByText(loading, { exact: true }).waitFor({ state: 'hidden' });
              const resume = page.getByRole('button', { name: t(locale, 'Continuar borrador', 'Continue draft'), exact: true });
              const discard = page.getByRole('button', { name: t(locale, 'Descartar borrador', 'Discard draft'), exact: true });
              const notice = page.locator('.notice[role=status]').filter({ has: resume });
              await notice.waitFor();
              await page.waitForFunction(() => document.querySelector('#app-sidebar')?.hasAttribute('inert'));
              await assertNoticeLayout(page, notice, `${path} ${locale} ${width}px`);
              await resume.focus(); await page.keyboard.press('Tab');
              assert.equal(await discard.evaluate((node) => node === document.activeElement), true, 'Keyboard order: continue, then discard');
              if (width === 390 || width === 320) await page.screenshot({ animations: 'disabled', path: join(artifacts, `v053-draft${path.replace('/', '-')}-${locale}-${width}.png`) });
            }
          }
          // A confirmation with actions in another flow uses the same structure.
          await page.setViewportSize({ width: 320, height: 844 });
          await page.getByRole('button', { name: t(locale, 'Continuar borrador', 'Continue draft'), exact: true }).click();
          await page.getByRole('button', { name: t(locale, 'Guardar solicitud', 'Save application'), exact: true }).waitFor();
          await page.getByLabel(t(locale, 'Puesto', 'Role'), { exact: true }).fill(`Notice role ${marker}`);
          await page.getByRole('button', { name: t(locale, 'Guardar solicitud', 'Save application'), exact: true }).click();
          await page.getByLabel(t(locale, 'Estado de la solicitud', 'Application status'), { exact: true }).selectOption('CONFIRMED');
          const confirmation = page.locator('.notice[role=alert]').filter({ has: page.getByRole('button', { name: t(locale, 'Sí, la envié', 'Yes, I sent it'), exact: true }) });
          await confirmation.waitFor();
          await assertNoticeLayout(page, confirmation, `confirmation ${locale}`);
          await confirmation.scrollIntoViewIfNeeded();
          await page.screenshot({ animations: 'disabled', path: join(artifacts, `v053-confirmation-${locale}-320.png`) });
          await confirmation.getByRole('button', { name: t(locale, 'Cancelar', 'Cancel'), exact: true }).click();
          await confirmation.waitFor({ state: 'detached' });
          if (locale === 'es') {
            await page.getByRole('button', { name: 'Añadir solicitud', exact: true }).click();
            await page.getByLabel('Empresa', { exact: true }).fill(`Notice ${marker}`);
          }
        }
      } finally {
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
      // Discarding still asks first and clears the drafts.
      for (const path of ['/jobs', '/applications']) {
        await page.goto(new URL(path, page.url()).toString());
        const discard = page.getByRole('button', { name: 'Discard draft', exact: true });
        if (await discard.count()) { page.once('dialog', (dialog) => void dialog.accept()); await discard.click(); await discard.waitFor({ state: 'detached' }); }
      }
      await setLocale(page, 'es');
    },
  },
  {
    name: 'v053-linked-resume-review-and-change',
    async run({ page, api, marker, artifacts }) {
      const profile = await api.get<Profile>('/profile');
      await api.put('/profile', { expectedRevision: profile.revision, profile: { ...profile.profile, identity: { fullName: 'Linked Example', email: 'linked@example.com' } } });
      const facts = [];
      for (const label of ['A', 'B']) {
        const fact = await api.post<{ id: string }>('/profile/facts', { kind: 'achievement', statement: `Linked fact ${label} ${marker}` });
        await api.post(`/profile/facts/${fact.id}/approve`); facts.push(fact);
      }
      const job = await api.post<{ id: string }>('/jobs/import', { company: `Linked ${marker}`, title: 'Linked role', jobUrl: `https://example.com/${marker}/linked` });
      const application = await api.post<Application>('/applications', { company: `Linked ${marker}`, role: 'Linked role', jobId: job.id });
      const linked = await api.post<Resume>('/documents', { name: `Linked A ${marker}`, factIds: [facts[0]!.id], jobId: job.id, locale: 'es' });
      const other = await api.post<Resume>('/documents', { name: `Linked B ${marker}`, factIds: [facts[1]!.id], locale: 'en' });
      for (const doc of [linked, other]) await api.post(`/documents/${doc.id}/approve`, { confirmReviewed: true });
      await api.post('/applications/with-resume', { applicationId: application.id, documentId: linked.id });
      const card = (doc: Resume) => page.locator('.document-card').filter({ hasText: doc.name });
      for (const locale of ['es', 'en'] as const) {
        await page.goto(new URL(`/applications?id=${application.id}`, page.url()).toString()); await setLocale(page, locale);
        await page.getByRole('link', { name: t(locale, 'Revisar o cambiar CV', 'Review or change resume'), exact: true }).click();
        await page.waitForURL((url) => url.pathname === '/documents' && url.searchParams.get('view') === 'review' && url.searchParams.get('document') === linked.id && url.searchParams.get('applicationId') === application.id && url.searchParams.get('jobId') === job.id);
        const label = page.locator('.form-card .linked-resume-label');
        await page.locator('.pdf-preview canvas:visible').waitFor(); await label.waitFor();
        assert.equal((await label.innerText()).trim(), t(locale, 'CV vinculado a esta solicitud', 'Resume linked to this application'));
        assert.ok((await page.locator('.form-card .form-heading').innerText()).includes(linked.name), 'The linked document is the one under review');
        assert.equal(await page.getByRole('button', { name: t(locale, 'Usar en esta solicitud', 'Use for this application'), exact: true }).count(), 0, 'Already linked');
        assert.equal(await page.getByRole('button', { name: t(locale, 'Aprobar esta versión', 'Approve this version'), exact: true }).count(), 0);
        await page.reload(); await page.locator('.pdf-preview canvas:visible').waitFor(); await label.waitFor();
        await page.getByRole('button', { name: t(locale, 'Elegir otro CV', 'Choose another resume'), exact: true }).click();
        await page.waitForURL((url) => url.searchParams.get('view') === 'saved' && url.searchParams.get('applicationId') === application.id && !url.searchParams.has('document'));
        await card(linked).locator('.linked-resume-label').waitFor();
        assert.equal(await card(linked).getByRole('button', { name: t(locale, 'Usar en esta solicitud', 'Use for this application'), exact: true }).count(), 0);
        await card(other).getByRole('button', { name: t(locale, 'Usar en esta solicitud', 'Use for this application'), exact: true }).waitFor();
        await page.goBack(); await page.locator('.pdf-preview canvas:visible').waitFor(); await label.waitFor();
        await page.getByRole('button', { name: t(locale, 'Cerrar vista previa', 'Close preview'), exact: true }).click();
        await page.locator('#resume-history:visible').waitFor();
        await eventually(() => page.getByRole('heading', { name: t(locale, 'Tus documentos', 'Your documents'), exact: true }).evaluate((node) => node === document.activeElement), Boolean, 'Closing returns focus to the library');
        await page.goBack(); await page.goBack();
        await page.waitForURL((url) => url.pathname === '/applications' && url.searchParams.get('id') === application.id);
      }
      await setLocale(page, 'es');
      await page.setViewportSize({ width: 390, height: 844 });
      try {
        await page.getByRole('link', { name: 'Revisar o cambiar CV', exact: true }).click();
        await page.locator('.pdf-preview canvas:visible').waitFor();
        await page.waitForFunction(() => document.querySelector('#app-sidebar')?.hasAttribute('inert'));
        assert.equal(await hasHorizontalOverflow(page), false, 'Linked review fits the mobile viewport');
        await page.screenshot({ animations: 'disabled', path: join(artifacts, 'v053-linked-review-mobile.png'), fullPage: true });
      } finally { await page.setViewportSize({ width: 1440, height: 1000 }); }
      // Change: open another approved resume from the library and link it, keeping the application context.
      await page.getByRole('button', { name: 'Elegir otro CV', exact: true }).click();
      await card(other).getByRole('button', { name: 'Ver', exact: true }).click();
      await page.waitForURL((url) => url.searchParams.get('document') === other.id && url.searchParams.get('applicationId') === application.id);
      assert.equal(await page.locator('.form-card .linked-resume-label').count(), 0);
      await page.getByRole('button', { name: 'Usar en esta solicitud', exact: true }).click();
      await page.waitForURL((url) => url.pathname === '/applications' && url.searchParams.get('id') === application.id);
      assert.equal((await api.get<Application>(`/applications/${application.id}`)).documentId, other.id);
      await page.getByRole('link', { name: 'Revisar o cambiar CV', exact: true }).click();
      await page.waitForURL((url) => url.searchParams.get('document') === other.id);
      await page.locator('.form-card .linked-resume-label').waitFor();
      // Without a linked resume the action prepares or chooses one in the builder.
      const unlinked = await api.post<Application>('/applications', { company: `Unlinked ${marker}`, role: 'Unlinked role' });
      await page.goto(new URL(`/applications?id=${unlinked.id}`, page.url()).toString());
      const prepare = page.getByRole('link', { name: 'Preparar o elegir CV', exact: true });
      await prepare.waitFor();
      const href = new URL(await prepare.getAttribute('href') ?? '', page.url());
      assert.equal(href.searchParams.get('applicationId'), unlinked.id); assert.equal(href.searchParams.has('document'), false);
    },
  },
  {
    name: 'v053-home-pending-review-lands-on-saved-list',
    async run({ page, api, marker, artifacts }) {
      const profile = await api.get<Profile>('/profile');
      await api.put('/profile', { expectedRevision: profile.revision, profile: { ...profile.profile, identity: { fullName: 'Landing Example', email: 'landing@example.com' }, preferences: { targetTitles: ['QA'], workModes: ['remote'] } } });
      const confirmed = await api.post<{ id: string }>('/profile/facts', { kind: 'achievement', statement: `Confirmed landing ${marker}` });
      await api.post(`/profile/facts/${confirmed.id}/approve`);
      await api.post('/profile/facts', { kind: 'achievement', statement: `Pending landing ${marker}` });
      for (const [width, height] of [[390, 844], [1440, 1000]] as const) {
        await page.setViewportSize({ width, height });
        for (const locale of ['es', 'en'] as const) {
          await page.goto(new URL('/', page.url()).toString()); await setLocale(page, locale);
          const link = page.locator('a[href="/profile#saved-experience-heading"]:visible').first();
          await link.waitFor();
          assert.equal(await page.locator('a[href="/profile#experience"]:visible').count(), 0, 'Pending review is not sent to the add form');
          await link.click();
          await page.waitForURL((url) => url.pathname === '/profile' && url.hash === '#saved-experience-heading');
          await eventually(() => page.evaluate(() => document.activeElement?.id ?? ''), (id) => id === 'saved-experience-heading', 'Saved list heading receives focus after the profile loads');
          const place = await page.locator('#saved-experience-heading').evaluate((node) => ({ top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom, height: window.innerHeight, atEnd: Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 2 }));
          assert.ok(place.top >= 0 && place.bottom <= place.height && (place.top < 220 || place.atEnd), `Saved list is brought into view (${JSON.stringify(place)})`);
          if (width === 390) assert.ok(await page.evaluate(() => window.scrollY) > 0, 'Mobile page scrolled to the list');
          await page.screenshot({ animations: 'disabled', path: join(artifacts, `v053-home-pending-${locale}-${width}.png`) });
        }
      }
      await page.setViewportSize({ width: 1440, height: 1000 }); await setLocale(page, 'es');
      // A normal data reload after a save keeps the reader where they are.
      await page.getByRole('navigation', { name: 'Secciones de tu perfil' }).getByRole('link', { name: 'Mis datos', exact: true }).click();
      // The shortcut scrolls smoothly; measure once it has settled.
      let settled = -1;
      const before = await eventually(() => page.evaluate(() => new Promise<number>((done) => { const y = window.scrollY; setTimeout(() => done(window.scrollY === y ? y : -1), 300); })), (y) => { const ok = y >= 0 && y === settled; settled = y; return ok; }, 'Scroll settles after the section shortcut');
      const name = page.getByLabel('Nombre', { exact: true }); const original = await name.inputValue();
      await name.fill(`${original}x`); await name.fill(original);
      await page.getByRole('button', { name: 'Guardar mis datos', exact: true }).click();
      await page.getByText('Tus datos se han guardado.', { exact: true }).waitFor();
      assert.notEqual(await page.evaluate(() => document.activeElement?.id ?? ''), 'saved-experience-heading', 'Reloads never move focus back to the landing target');
      const after = await page.evaluate(() => ({ y: window.scrollY, active: document.activeElement?.tagName + '#' + (document.activeElement?.id ?? ''), name: document.getElementById('profile-details')?.getBoundingClientRect().top }));
      assert.ok(Math.abs(after.y - before) < 120, `Reloads keep the scroll position (${before} → ${JSON.stringify(after)})`);
      // The add anchor stays distinct and also lands after loading.
      await page.goto(new URL('/profile#experience', page.url()).toString());
      await eventually(() => page.evaluate(() => document.activeElement?.id ?? ''), (id) => id === 'experience', 'Add form receives focus after the profile loads');
    },
  },
  {
    name: 'v053-preferences-keep-approved-resume-ready',
    async run({ page, api, marker, allowConsole }) {
      allowConsole(/409|Conflict|Failed to load resource/i);
      let profile = await api.get<Profile>('/profile');
      await api.put('/profile', { expectedRevision: profile.revision, profile: { ...profile.profile, identity: { fullName: 'Prefs Example', email: 'prefs@example.com', country: 'ES' } } });
      const fact = await api.post<{ id: string }>('/profile/facts', { kind: 'achievement', statement: `Preferences fact ${marker}` });
      await api.post(`/profile/facts/${fact.id}/approve`);
      const approved = await api.post<Resume>('/documents', { name: `Prefs approved ${marker}`, factIds: [fact.id], locale: 'es' });
      await api.post(`/documents/${approved.id}/approve`, { confirmReviewed: true });
      const pending = await api.post<Resume>('/documents', { name: `Prefs pending ${marker}`, factIds: [fact.id], locale: 'en' });
      const second = await api.post<Resume>('/documents', { name: `Prefs second ${marker}`, factIds: [fact.id], locale: 'en' });
      const application = await api.post<Application>('/applications', { company: `Prefs ${marker}`, role: 'Prefs role', canonicalUrl: lever });
      const originalPdf = await api.bytes(`/api/v1/documents/${approved.id}/file`);
      const find = async (doc: Resume) => (await api.get<Resume[]>('/documents')).find((row) => row.id === doc.id)!;

      // Preferences changed through the real profile form only.
      await goTo(page, '/profile'); await setLocale(page, 'es');
      await page.getByText('Cargando tu perfil…', { exact: true }).waitFor({ state: 'hidden' });
      await page.locator('.profile-preferences > summary').click();
      await page.getByLabel('Puestos que buscas', { exact: true }).fill(`QA ${marker}, SDET`);
      await page.getByLabel('País de trabajo', { exact: true }).selectOption('MX');
      await page.getByRole('button', { name: 'Guardar mis datos', exact: true }).click();
      await page.getByText('Tus datos se han guardado.', { exact: true }).waitFor();
      profile = await api.get<Profile>('/profile');
      assert.deepEqual((profile.profile.preferences as { targetTitles: string[] }).targetTitles, [`QA ${marker}`, 'SDET']);
      assert.equal((await find(approved)).assistReady, true, 'Approved PDF stays usable');
      assert.equal((await find(pending)).reviewReady, true, 'Pending PDF stays approvable');
      await api.post(`/documents/${pending.id}/approve`, { confirmReviewed: true });
      assert.equal((await find(pending)).assistReady, true);
      assert.equal((await api.post<Application>('/applications/with-resume', { applicationId: application.id, documentId: approved.id })).documentId, approved.id);
      const assist = await api.get<{ documents: Array<{ id: string; assistReady: boolean }> }>(`/applications/${application.id}/assist`);
      assert.equal(assist.documents.find((row) => row.id === approved.id)?.assistReady, true);
      await page.goto(new URL(`/applications?id=${application.id}`, page.url()).toString());
      await page.locator('.assist-panel').getByRole('button', { name: 'Revisar datos y destino', exact: true }).waitFor();
      await goTo(page, '/documents'); await page.getByRole('button', { name: /^CV guardados/ }).click();
      const card = page.locator('.document-card').filter({ hasText: approved.name });
      await card.waitFor();
      assert.equal(await card.getByText(/Tu perfil cambió/).count(), 0, 'No regeneration prompt after preference-only changes');

      // A real change to the printed name blocks approval, linking and assisted use.
      await goTo(page, '/profile');
      await page.getByText('Cargando tu perfil…', { exact: true }).waitFor({ state: 'hidden' });
      await page.getByLabel('Nombre', { exact: true }).fill('Prefs Example Renamed');
      await page.getByRole('button', { name: 'Guardar mis datos', exact: true }).click();
      await page.getByText('Tus datos se han guardado.', { exact: true }).waitFor();
      assert.equal((await find(approved)).assistReady, false);
      assert.equal((await find(second)).reviewReady, false);
      await assert.rejects(() => api.post(`/documents/${second.id}/approve`, { confirmReviewed: true }), /409.*PROFILE_CHANGED_REGENERATE_DOCUMENT/);
      const another = await api.post<Application>('/applications', { company: `Prefs other ${marker}`, role: 'Prefs role' });
      await assert.rejects(() => api.post('/applications/with-resume', { applicationId: another.id, documentId: approved.id }), /409.*PROFILE_CHANGED_REGENERATE_DOCUMENT/);
      await assert.rejects(() => api.post(`/applications/${application.id}/assist/prepare`, { documentId: approved.id }), /409.*ASSIST_DOCUMENT_STALE/);
      await page.goto(new URL(`/documents?applicationId=${application.id}&view=review&document=${approved.id}&from=saved`, page.url()).toString());
      await page.getByText(/Tu perfil cambió desde que aprobaste este CV/).waitFor();
      await page.getByRole('button', { name: 'Preparar versión actualizada', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Usar en esta solicitud', exact: true }).count(), 0);

      // Printing the same identity again is equivalent; the stored PDF never changed.
      profile = await api.get<Profile>('/profile');
      await api.put('/profile', { expectedRevision: profile.revision, profile: { ...profile.profile, identity: { ...(profile.profile.identity as object), fullName: 'Prefs Example' } } });
      assert.equal((await find(approved)).assistReady, true);
      assert.equal((await find(approved)).sha256, approved.sha256);
      assert.deepEqual(await api.bytes(`/api/v1/documents/${approved.id}/file`), originalPdf, 'Existing PDFs are immutable');
    },
  },
];
