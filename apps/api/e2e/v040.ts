import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { StructuredEntry } from '@career/domain';
import type { Scenario } from './scenarios.js';
import { eventually, hasHorizontalOverflow, setLocale } from './ui.js';

type Fact = { id: string; statement: string; approvalStatus: string; details: StructuredEntry | null };
type Profile = { revision: number; profile: Record<string, unknown>; facts: Fact[] };
type Resume = { id: string; name: string; claims: Array<{ text: string }>; approvalStatus: string };

export const v040Scenarios: Scenario[] = [
  {
    name: 'v040-structured-profile-to-linked-application',
    async run({ page, api, marker, artifacts }) {
      await page.goto(new URL('/profile', page.url()).toString()); await setLocale(page, 'es');
      const profile = await api.get<Profile>('/profile');
      await api.put('/profile', { expectedRevision: profile.revision, profile: { ...profile.profile, identity: { fullName: 'Alex Example', email: 'alex@example.com' } } });
      const job = await api.post<{ id: string }>('/jobs/import', { company: `Journey ${marker}`, title: 'Product designer', jobUrl: 'https://jobs.lever.co/fixture/44444444-4444-4444-8444-444444444444' });
      await page.goto(new URL(`/documents?jobId=${job.id}`, page.url()).toString());
      await page.getByRole('navigation', { name: 'Pasos para esta solicitud' }).getByRole('link', { name: 'Tu perfil', exact: true }).click();
      await page.waitForURL('**/profile?**');
      assert.equal(new URL(page.url()).searchParams.get('jobId'), job.id);
      await page.getByLabel('Puesto que ocupaste', { exact: true }).fill('Designer');
      await page.getByLabel('Empresa', { exact: true }).fill(`Studio ${marker}`);
      await page.getByLabel('Fecha de inicio', { exact: true }).fill('2020-01');
      await page.getByLabel('Fecha de fin', { exact: true }).fill('2019-12');
      assert.equal(await page.getByLabel('Fecha de fin', { exact: true }).evaluate((element: HTMLInputElement) => element.checkValidity()), false);
      await page.getByLabel('Actualmente trabajo aquí', { exact: true }).check();
      await page.getByLabel('Describe tu experiencia o logro', { exact: true }).fill(`Texto original ${marker}`);
      await page.getByRole('button', { name: 'Añadir para revisar', exact: true }).click();
      await page.getByRole('heading', { name: 'Revisa cómo aparecerá en tu CV', exact: true }).waitFor();
      assert.equal((await api.get<Profile>('/profile')).facts.find((fact) => fact.details?.organization === `Studio ${marker}`)?.approvalStatus, 'SUGGESTED', 'Saving experience does not confirm it automatically');
      await page.getByRole('button', { name: 'Confirmar experiencia', exact: true }).click();
      await eventually(() => api.get<Profile>('/profile'), (p) => p.facts.some((fact) => fact.details?.organization === `Studio ${marker}` && fact.approvalStatus === 'USER_APPROVED'), 'Immediate experience review confirms the saved entry');
      await page.locator('.fact-row').filter({ hasText: `Studio ${marker}` }).getByRole('button', { name: 'Editar', exact: true }).click();
      assert.equal(await page.getByLabel('Fecha de inicio', { exact: true }).inputValue(), '2020-01');
      assert.equal(await page.getByLabel('Empresa', { exact: true }).inputValue(), `Studio ${marker}`);
      await page.getByLabel('Puesto que ocupaste', { exact: true }).fill('Senior designer');
      await page.getByRole('button', { name: 'Guardar corrección para revisar', exact: true }).click();
      await page.locator('.fact-row').filter({ hasText: `Studio ${marker}` }).getByRole('button', { name: 'Confirmar', exact: true }).click();
      await page.getByLabel('Qué quieres añadir', { exact: true }).selectOption('education');
      await page.getByLabel('Titulación o curso', { exact: true }).fill('Design degree');
      await page.getByLabel('Centro o institución', { exact: true }).fill(`School ${marker}`);
      await page.getByLabel('Fecha de inicio', { exact: true }).fill('2024-09');
      await page.getByLabel('Actualmente estudio aquí', { exact: true }).check();
      await page.getByRole('button', { name: 'Añadir para revisar', exact: true }).click();
      await page.locator('.fact-row').filter({ hasText: `School ${marker}` }).getByRole('button', { name: 'Confirmar', exact: true }).click();
      const saved = await eventually(() => api.get<Profile>('/profile'), (p) => p.facts.some((fact) => fact.details?.organization === `School ${marker}` && fact.approvalStatus === 'USER_APPROVED'), 'Education confirmed');
      const entries = saved.facts.filter((fact) => fact.details?.organization.endsWith(marker));
      assert.equal(entries.length, 2); assert.equal(entries.find((fact) => fact.details?.type === 'employment')?.details?.title, 'Senior designer');
      await page.getByRole('button', { name: 'Añadir para revisar', exact: true }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('.sidebar').waitFor({ state: 'hidden' });
      assert.equal(await hasHorizontalOverflow(page), false);
      await page.screenshot({ path: join(artifacts, 'v040-profile-mobile.png'), fullPage: true, animations: 'disabled' });
      await page.getByRole('navigation', { name: 'Pasos para esta solicitud' }).getByRole('link', { name: 'Preparar CV', exact: true }).click();
      await page.waitForURL('**/documents?**');
      assert.equal(new URL(page.url()).searchParams.get('jobId'), job.id);
      await page.getByLabel('Idioma del PDF', { exact: true }).selectOption('en');
      const name = `Journey CV ${marker}`;
      await page.getByLabel('Nombre de la versión', { exact: true }).fill(name);
      for (const entry of entries) await page.locator('.fact-pick').filter({ hasText: entry.details!.organization }).locator('input').check();
      await page.getByRole('button', { name: 'Generar y revisar', exact: true }).click();
      await page.locator('.pdf-preview canvas').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Ampliar', exact: true }).click();
      await page.locator('.pdf-preview canvas').waitFor({ state: 'visible' });
      await eventually(() => page.locator('.pdf-viewport').evaluate((node) => node.scrollWidth > node.clientWidth), Boolean, 'Zoom provides an internally scrollable page');
      assert.equal(await hasHorizontalOverflow(page), false, 'Zoom must not overflow the page');
      await page.getByRole('button', { name: 'Ajustar al ancho', exact: true }).click();
      await page.locator('.pdf-preview canvas').waitFor({ state: 'visible' });
      const resume = (await api.get<Resume[]>('/documents')).find((doc) => doc.name === name)!;
      assert.ok(resume.claims.some((claim) => claim.text.includes('Present') && claim.text.includes(`Texto original ${marker}`)));
      assert.ok(resume.claims.some((claim) => claim.text.includes('In progress')));
      await page.getByRole('checkbox', { name: /He leído el documento completo/ }).check();
      await page.getByRole('button', { name: 'Aprobar esta versión', exact: true }).click();
      await page.getByRole('button', { name: 'Continuar con esta solicitud', exact: true }).click();
      await page.waitForURL((url) => url.pathname === '/applications' && Boolean(url.searchParams.get('id')));
      const applicationId = new URL(page.url()).searchParams.get('id')!;
      const application = await api.get<{ id: string; documentId: string; state: string }>(`/applications/${applicationId}`);
      assert.equal(application.documentId, resume.id); assert.equal(application.state, 'DRAFT');
      const differentJob = await api.post<{ id: string }>('/jobs/import', { company: `Other ${marker}`, title: 'Different role', jobUrl: `https://example.com/${marker}/other-journey` });
      await assert.rejects(() => api.post('/applications/with-resume', { documentId: resume.id, jobId: differentJob.id }), /DOCUMENT_JOB_MISMATCH/);
      const duplicate = await api.post<{ id: string }>('/applications/with-resume', { documentId: resume.id, jobId: job.id });
      assert.equal(duplicate.id, applicationId);
      assert.equal((await api.get<Array<{ jobId: string }>>('/applications')).filter((row) => row.jobId === job.id).length, 1);
      await page.getByRole('link', { name: 'Descargar CV elegido', exact: true }).waitFor();
      assert.equal(await page.getByRole('link', { name: 'Descargar CV elegido', exact: true }).getAttribute('href'), `/api/v1/documents/${resume.id}/file`);
      await eventually(() => page.getByLabel('CV aprobado para esta solicitud', { exact: true }).inputValue(), (value) => value === resume.id, 'Linked resume stays selected');
      await page.screenshot({ path: join(artifacts, 'v040-linked-application-mobile.png'), fullPage: true, animations: 'disabled' });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await setLocale(page, 'en');
      await page.getByRole('link', { name: 'Review or change resume', exact: true }).click();
      await page.waitForURL((url) => url.pathname === '/documents' && url.searchParams.get('applicationId') === applicationId);
      await page.getByRole('navigation', { name: 'Steps for this application' }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('applicationId'), applicationId);
      await setLocale(page, 'es');
    },
  },
  {
    name: 'v040-favorites-archive-filters-and-pagination',
    async run({ page, api, marker, artifacts }) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      const company = `Filter ${marker}`;
      const first = await api.post<{ id: string }>('/jobs/import', { company, title: 'Favorite designer', jobUrl: `https://example.com/${marker}/favorite` });
      await api.post('/jobs/import', { company, title: 'Other role', jobUrl: `https://example.com/${marker}/other` });
      await page.goto(new URL(`/jobs?q=${encodeURIComponent(company)}`, page.url()).toString()); await setLocale(page, 'es');
      await page.locator('.job-card').filter({ hasText: 'Favorite designer' }).getByRole('button', { name: 'Añadir a favoritas', exact: true }).click();
      await page.getByLabel('Mostrar ofertas', { exact: true }).selectOption('favorites');
      await eventually(() => page.locator('.job-card').count(), (count) => count === 1, 'Favorites filter');
      await page.reload(); await page.getByRole('link', { name: 'Favorite designer', exact: true }).waitFor();
      assert.equal(await page.getByLabel('Mostrar ofertas', { exact: true }).inputValue(), 'favorites');
      await page.getByRole('link', { name: 'Favorite designer', exact: true }).click();
      page.once('dialog', (dialog) => void dialog.accept());
      await page.getByRole('button', { name: 'Archivar oferta', exact: true }).click();
      await page.getByRole('button', { name: 'Restaurar oferta', exact: true }).waitFor();
      await page.goto(new URL(`/jobs?scope=archived&q=${encodeURIComponent(company)}`, page.url()).toString());
      await page.getByRole('link', { name: 'Favorite designer', exact: true }).waitFor();
      assert.equal(await page.locator('.job-card').count(), 1);
      await page.getByRole('link', { name: 'Favorite designer', exact: true }).click();
      await page.getByRole('button', { name: 'Restaurar oferta', exact: true }).click();
      await eventually(() => api.get<{ job: { shortlistDecision: string } }>(`/jobs/${first.id}`), (value) => value.job.shortlistDecision === 'UNREVIEWED', 'Restored to active jobs');
      for (let index = 0; index < 25; index++) await api.post('/jobs/import', { company: `Pages ${marker}`, title: `Role ${index}`, jobUrl: `https://example.com/${marker}/pages/${index}` });
      await page.goto(new URL(`/jobs?q=${encodeURIComponent(`Pages ${marker}`)}`, page.url()).toString());
      await eventually(() => page.locator('.job-card').count(), (count) => count === 24, 'First page bounded');
      await page.getByRole('button', { name: 'Página siguiente', exact: true }).click();
      await eventually(() => page.locator('.job-card').count(), (count) => count === 1, 'Second page');
      assert.equal(new URL(page.url()).searchParams.get('page'), '2');
      await page.reload();
      await eventually(() => page.locator('.job-card').count(), (count) => count === 1, 'Pagination survives reload');
      await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await hasHorizontalOverflow(page), false);
      await page.locator('.sidebar').waitFor({ state: 'hidden' });
      await page.screenshot({ path: join(artifacts, 'v040-jobs-mobile.png'), animations: 'disabled' });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: join(artifacts, 'v040-jobs-desktop.png'), animations: 'disabled' });
    },
  },
];
