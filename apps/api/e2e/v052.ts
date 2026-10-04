import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Scenario } from './scenarios.js';
import { clickWithResumeReplacement, eventually, hasHorizontalOverflow, setLocale } from './ui.js';

type Profile = { revision: number; profile: Record<string, unknown> };
type Resume = { id: string; name: string; reviewReady: boolean; jobId: string; reusableFactIds: string[]; sha256: string };
export const v052Scenario: Scenario = {
  name: 'v052-preview-lifetime-stale-review-and-reuse-context',
  async run({ page, api, marker, artifacts, allowConsole }) {
    const profile = await api.get<Profile>('/profile');
    await api.put('/profile', { expectedRevision: profile.revision, profile: { ...profile.profile, identity: { fullName: 'Preview Example', email: 'preview@example.com' } } });
    const fact = await api.post<{ id: string }>('/profile/facts', { kind: 'achievement', statement: `Preview stability ${marker}` });
    await api.post(`/profile/facts/${fact.id}/approve`);
    const job = await api.post<{ id: string }>('/jobs/import', { company: `Original ${marker}`, title: 'Original role', jobUrl: `https://example.com/${marker}/original` });
    const other = await api.post<{ id: string }>('/jobs/import', { company: `Current ${marker}`, title: 'Current role', jobUrl: `https://example.com/${marker}/current` });
    const application = await api.post<{ id: string }>('/applications', { company: `Current ${marker}`, role: 'Current role', jobId: other.id });
    const doc = await api.post<Resume>('/documents', { name: `Context ${marker}`, jobId: job.id, locale: 'en', factIds: [fact.id] });
    assert.equal(doc.jobId, job.id); assert.equal(doc.reviewReady, true); assert.deepEqual(doc.reusableFactIds, [fact.id]);
    const goto = async (path: string) => { await page.goto(new URL(path, page.url()).toString()); await page.getByRole('heading', { level: 1 }).waitFor(); };
    await goto('/documents?view=saved'); await setLocale(page, 'es');
    const card = () => page.locator('.document-card').filter({ hasText: doc.name });
    await clickWithResumeReplacement(page, card().getByRole('button', { name: 'Usar como base', exact: true }));
    await page.waitForURL((url) => url.searchParams.get('jobId') === job.id && url.searchParams.get('view') === 'prepare');
    await eventually(() => page.getByLabel('¿Para qué oferta?', { exact: true }).inputValue(), (value) => value === job.id, 'Original job restored');
    await eventually(() => page.locator('.fact-pick input:checked').count(), (value) => value === 1, 'Selection transferred to job draft');
    assert.equal(await page.getByLabel('Idioma del PDF', { exact: true }).inputValue(), 'en');
    await page.reload();
    await eventually(() => page.getByLabel('Nombre de la versión', { exact: true }).inputValue(), (value) => value === doc.name, 'Copied draft survives reload');
    await eventually(() => page.locator('.fact-pick input:checked').count(), (value) => value === 1, 'Recovered selection finishes loading');
    await goto(`/documents?view=saved&applicationId=${application.id}`);
    await clickWithResumeReplacement(page, card().getByRole('button', { name: 'Usar como base', exact: true }));
    await page.waitForURL((url) => url.searchParams.get('view') === 'prepare' && url.searchParams.get('jobId') === other.id);
    assert.equal(new URL(page.url()).searchParams.get('applicationId'), application.id);
    await eventually(() => page.getByLabel('¿Para qué oferta?', { exact: true }).inputValue(), (value) => value === other.id, 'Explicit application job retained');
    assert.equal(await page.getByLabel('¿Para qué oferta?', { exact: true }).isDisabled(), true);
    await eventually(() => page.locator('.fact-pick input:checked').count(), (value) => value === 1, 'Recovered selection finishes loading');

    const blobRequests: string[] = [];
    const observe = (request: import('playwright').Request) => { if (request.url().startsWith('blob:')) blobRequests.push(request.url()); };
    page.on('request', observe);
    try {
      for (const locale of ['es', 'en'] as const) {
        await setLocale(page, locale);
        await goto(`/documents?view=review&document=${doc.id}&from=saved`);
        await page.locator('.pdf-preview canvas:visible').waitFor();
        await page.getByRole('heading', { level: 1, name: locale === 'es' ? 'Revisa tu CV' : 'Review your resume', exact: true }).waitFor();
        for (let i = 0; i < 3; i++) {
          await page.getByRole('button', { name: locale === 'es' ? 'Cerrar vista previa' : 'Close preview', exact: true }).click();
          await page.locator('#resume-history:visible').waitFor();
          await card().getByRole('button', { name: locale === 'es' ? 'Revisar y aprobar' : 'Review and approve', exact: true }).click();
          await page.getByRole('heading', { name: locale === 'es' ? 'Revisa esta versión' : 'Review this version', exact: true }).waitFor();
        }
        await page.locator('.pdf-preview canvas:visible').waitFor();
        await page.reload(); await page.locator('.pdf-preview canvas:visible').waitFor();
        await page.getByRole('button', { name: locale === 'es' ? 'Preparar CV' : 'Prepare resume', exact: true }).click();
        await page.getByRole('heading', { name: locale === 'es' ? 'Preparar una versión' : 'Prepare a version', exact: true }).waitFor();
        await page.goBack(); await page.locator('.pdf-preview canvas:visible').waitFor();
      }
    } finally { page.off('request', observe); }
    assert.deepEqual(blobRequests, [], 'PDF rendering never fetches a revocable blob URL');

    const latest = await api.get<Profile>('/profile');
    // A printed name change (not a preference) is what makes this PDF stale.
    await api.put('/profile', { expectedRevision: latest.revision, profile: { ...latest.profile, identity: { fullName: 'Preview Example Renamed', email: 'preview@example.com' } } });
    for (const locale of ['es', 'en'] as const) {
      await setLocale(page, locale); await goto(`/documents?view=review&document=${doc.id}&from=saved`);
      const update = page.getByRole('button', { name: locale === 'es' ? 'Preparar versión actualizada' : 'Prepare updated version', exact: true });
      await update.waitFor();
      assert.equal(await page.getByRole('button', { name: locale === 'es' ? 'Aprobar esta versión' : 'Approve this version', exact: true }).count(), 0);
      await page.locator('.pdf-preview canvas:visible').waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await eventually(() => hasHorizontalOverflow(page), (value) => !value, 'Stale notice fits the mobile viewport');
      await update.scrollIntoViewIfNeeded();
      await page.screenshot({ animations: 'disabled', path: join(artifacts, `v052-stale-mobile-${locale}.png`) });
      await clickWithResumeReplacement(page, update);
      await page.getByRole('heading', { name: locale === 'es' ? 'Preparar una versión' : 'Prepare a version', exact: true }).waitFor();
      await eventually(() => page.locator('.fact-pick input:checked').count(), (value) => value === 1, 'Current copied facts are recovered');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await goto('/profile');
      await eventually(() => page.getByRole('link', { name: locale === 'es' ? 'Continuar con mi CV' : 'Continue to my resume', exact: true }).count(), (value) => value === 1, 'One profile continuation action');
      assert.equal(await page.locator('.profile-aside a.button').count(), 0);
    }
    assert.equal((await api.get<Resume[]>('/documents')).find((value) => value.id === doc.id)?.sha256, doc.sha256, 'Original PDF unchanged');

    await setLocale(page, 'es');
    // An unavailable original job must have an explanation rather than silently changing the target.
    allowConsole(/status of 404/);
    await page.route('**/api/v1/jobs', async (route) => {
      const response = await route.fetch(); const rows = await response.json() as { id: string }[];
      await route.fulfill({ response, json: rows.filter((row) => row.id !== job.id) });
    });
    await page.route(`**/api/v1/jobs/${job.id}`, (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"JOB_NOT_FOUND"}' }));
    try {
      await goto('/documents?view=saved');
      await clickWithResumeReplacement(page, card().getByRole('button', { name: 'Usar como base', exact: true }));
      await page.getByText('La oferta original ya no está disponible. Recuperamos el contenido; elige otra oferta o prepara un CV general.', { exact: true }).waitFor();
      await page.waitForURL((url) => url.searchParams.get('view') === 'prepare' && !url.searchParams.has('jobId'));
      assert.equal(await page.getByLabel('Idioma del PDF', { exact: true }).inputValue(), 'en');
    } finally { await page.unroute('**/api/v1/jobs'); await page.unroute(`**/api/v1/jobs/${job.id}`); }
  },
};
