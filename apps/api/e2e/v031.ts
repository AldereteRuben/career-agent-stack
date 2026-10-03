import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Scenario } from './scenarios.js';
import { eventually, goTo, setLocale } from './ui.js';

type Fact = { id: string; statement: string; approvalStatus: string };
type Profile = { revision: number; profile: Record<string, unknown>; facts: Fact[] };
type Document = { id: string; name: string; reusableFactIds: string[]; missingFactCount: number; assistReady: boolean; claims: Array<{ text: string }> };

export const patchScenarios: Scenario[] = [
  {
    name: 'v031-resume-reuse-edit-archive-and-assisted-readiness',
    async run({ page, api, marker, artifacts }) {
      await goTo(page, '/profile'); await setLocale(page, 'es');
      let profile = await api.get<Profile>('/profile');
      await api.put('/profile', { expectedRevision: profile.revision, profile: { ...profile.profile, identity: { fullName: 'Alex Fictional', email: 'alex@example.com' } } });
      const text = `Experiencia original ${marker}`;
      const fact = await api.post<Fact>('/profile/facts', { kind: 'achievement', statement: text, tags: ['SQL'] });
      await api.post(`/profile/facts/${fact.id}/approve`);
      const doc = await api.post<Document>('/documents', { name: `CV regresión ${marker}`, factIds: [fact.id], locale: 'es' });
      await api.post(`/documents/${doc.id}/approve`, { confirmReviewed: true });
      const originalPdf = await api.bytes(`/api/v1/documents/${doc.id}/file`);
      profile = await api.get<Profile>('/profile');
      await api.put('/profile', { expectedRevision: profile.revision, profile: { ...profile.profile, preferences: { targetTitles: ['QA'], workModes: ['remote'] } } });
      const after = (await api.get<Document[]>('/documents')).find((item) => item.id === doc.id)!;
      assert.equal(after.reusableFactIds.length, 1); assert.equal(after.missingFactCount, 0); assert.equal(after.assistReady, false);
      assert.notEqual(after.reusableFactIds[0], fact.id, 'Copied facts have fresh row ids');
      await goTo(page, '/documents');
      await page.getByRole('button', { name: /^CV guardados/ }).click();
      await page.locator('.document-card').filter({ hasText: doc.name }).getByRole('button', { name: 'Usar como base', exact: true }).click();
      assert.equal(await page.locator('.fact-pick input:checked').count(), 1);
      assert.equal(await page.locator('.notice[role=alert]').count(), 0);

      const application = await api.post<{ id: string }>('/applications', { company: 'Fictional company', role: `Readiness ${marker}`, canonicalUrl: 'https://jobs.lever.co/fixture/22222222-2222-4222-8222-222222222222' });
      const assist = await api.get<{ documents: Array<{ id: string; assistReady: boolean }> }>(`/applications/${application.id}/assist`);
      assert.equal(assist.documents.find((item) => item.id === doc.id)?.assistReady, false);
      await page.goto(new URL(`/applications?id=${application.id}`, page.url()).toString());
      await page.getByText('Tu perfil cambió. En Mis CV, usa una versión como base, genera y aprueba el CV actualizado para continuar.', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Revisar datos y destino', exact: true }).count(), 0);

      await goTo(page, '/profile');
      await page.locator('.fact-row').filter({ hasText: text }).getByRole('button', { name: 'Editar', exact: true }).click();
      const corrected = `Experiencia corregida ${marker}`;
      await page.getByLabel('Texto completo para el CV', { exact: true }).fill(corrected);
      await page.getByRole('button', { name: 'Guardar corrección para revisar', exact: true }).click();
      profile = await eventually(() => api.get<Profile>('/profile'), (p) => p.facts.some((f) => f.statement === corrected), 'Correction saved');
      const edited = profile.facts.find((item) => item.statement === corrected)!;
      assert.equal(edited.approvalStatus, 'SUGGESTED'); assert.ok(!profile.facts.some((item) => item.statement === text));
      await page.locator('.fact-row').filter({ hasText: corrected }).getByRole('button', { name: 'Confirmar', exact: true }).click();
      await eventually(() => api.get<Profile>('/profile'), (p) => p.facts.some((f) => f.id === edited.id && f.approvalStatus === 'USER_APPROVED'), 'Edited entry confirmed');
      const old = (await api.get<Document[]>('/documents')).find((item) => item.id === doc.id)!;
      assert.equal(old.missingFactCount, 1); assert.equal(old.reusableFactIds.length, 0); assert.equal(old.claims[0]?.text, text);
      assert.deepEqual(await api.bytes(`/api/v1/documents/${doc.id}/file`), originalPdf, 'Editing never rewrites an earlier PDF');
      const row = page.locator('.fact-row').filter({ hasText: corrected });
      await row.getByRole('button', { name: 'Archivar', exact: true }).click();
      await row.getByRole('button', { name: 'Confirmar archivo', exact: true }).click();
      await row.getByRole('button', { name: 'Restaurar y confirmar', exact: true }).click();
      await eventually(() => api.get<Profile>('/profile'), (p) => p.facts.some((f) => f.id === edited.id && f.approvalStatus === 'USER_APPROVED'), 'Archive can be undone');
      const fresh = await api.post<Document>('/documents', { name: `Actualizado ${marker}`, factIds: [edited.id], locale: 'en' });
      await api.post(`/documents/${fresh.id}/approve`, { confirmReviewed: true });
      const ready = await api.get<{ documents: Array<{ id: string; assistReady: boolean }> }>(`/applications/${application.id}/assist`);
      assert.equal(ready.documents.find((item) => item.id === fresh.id)?.assistReady, true);
      assert.equal(ready.documents.find((item) => item.id === doc.id)?.assistReady, false);
      await page.screenshot({ path: join(artifacts, 'v031-profile-edit.png'), fullPage: true });
    },
  },
  {
    name: 'v031-drafts-survive-navigation-reload-and-row-switch',
    async run({ page, api, marker, artifacts }) {
      await goTo(page, '/jobs'); await setLocale(page, 'es');
      await page.getByRole('button', { name: 'Añadir oferta', exact: true }).click();
      await page.getByLabel('Empresa', { exact: true }).fill(`Borrador ${marker}`);
      await goTo(page, '/'); await goTo(page, '/jobs');
      await page.getByRole('button', { name: 'Continuar borrador', exact: true }).click();
      assert.equal(await page.getByLabel('Empresa', { exact: true }).inputValue(), `Borrador ${marker}`);
      await page.reload();
      await page.getByRole('button', { name: 'Continuar borrador', exact: true }).click();
      assert.equal(await page.getByLabel('Empresa', { exact: true }).inputValue(), `Borrador ${marker}`);
      page.once('dialog', (dialog) => void dialog.accept());
      await page.getByRole('button', { name: 'Descartar borrador', exact: true }).click();
      assert.equal(await page.getByLabel('Empresa', { exact: true }).inputValue(), '');
      await api.post('/jobs/import', { company: `Fixture ${marker}`, title: 'Designer', jobUrl: `https://example.com/jobs/${marker}/draft-regression` });
      await page.getByRole('textbox', { name: 'Buscar ofertas', exact: true }).fill('zzzz-no-match');
      await page.getByRole('button', { name: 'Buscar', exact: true }).click();
      await page.getByRole('heading', { name: 'No hay ofertas que coincidan', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Añadir la primera', exact: true }).count(), 0);
      const one = await api.post<{ id: string }>('/applications', { company: `Draft One ${marker}`, role: 'Role One' });
      const two = await api.post<{ id: string }>('/applications', { company: `Draft Two ${marker}`, role: 'Role Two' });
      await page.goto(new URL(`/applications?id=${one.id}`, page.url()).toString());
      const note = page.getByLabel('Añadir nota al historial', { exact: true });
      await note.fill('Draft for first application');
      await page.locator('.tracker-row').filter({ hasText: `Draft Two ${marker}` }).click();
      await page.waitForURL((url) => url.searchParams.get('id') === two.id);
      assert.equal(await note.inputValue(), ''); await note.fill('Draft for second application');
      await page.locator('.tracker-row').filter({ hasText: `Draft One ${marker}` }).click();
      await page.waitForURL((url) => url.searchParams.get('id') === one.id);
      assert.equal(await note.inputValue(), 'Draft for first application');
      await page.reload(); await note.waitFor();
      assert.equal(await note.inputValue(), 'Draft for first application');
      await page.getByRole('button', { name: 'Añadir nota', exact: true }).click();
      await eventually(() => note.inputValue(), (value) => value === '', 'Saved note clears its own draft');
      await page.locator('.tracker-row').filter({ hasText: `Draft Two ${marker}` }).click();
      await page.waitForURL((url) => url.searchParams.get('id') === two.id);
      assert.equal(await note.inputValue(), 'Draft for second application');
      await page.screenshot({ path: join(artifacts, 'v031-note-drafts.png'), fullPage: true });
    },
  },
];
