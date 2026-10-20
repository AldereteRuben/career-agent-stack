import assert from 'node:assert/strict';
import type { Request } from 'playwright';
import type { Scenario } from './scenarios.js';
import { eventually, hasHorizontalOverflow, setLocale } from './ui.js';

type Fact = { id: string; kind: string; statement: string; source: string; importId: string | null; approvalStatus: string; details: { organization?: string; startMonth?: string } | null };
type Profile = { revision: number; locale: string; profile: Record<string, unknown>; facts: Fact[] };
type Job = { job: { id: string; evidenceCoverage: number | null; fitScore: number | null; match: { matchedSkills: string[] } } };

/** A fictional resume: invented people, employers and contact details on the reserved .test domain. */
const resumeText = (marker: string) => `NORA PRUEBA
Valencia, España · nora.${marker}@example.test · +34 600 000 002

EXPERIENCIA LABORAL
Ingeniera de plataforma — Plataforma Ficticia ${marker}
Ene. 2022 – Actualidad
• Diseñé APIs con GraphQL y despliegues en Kubernetes.

Desarrolladora | Código Inventado ${marker} | 2018 - 2021
- Mantuve servicios internos.

HABILIDADES
Terraform, Ansible ${marker}

IDIOMAS
Español (nativo), Inglés (C1)

AFICIONES
Escalada privada ${marker}`;

/**
 * Resume import, ADR 018 tasks T5, T9 and T11: a PDF is read in the browser, only the chosen entries reach the API as
 * unconfirmed suggestions, nothing is used for matching until a batch is confirmed explicitly, and the import can be
 * corrected, discarded and undone. The PDF and its text never leave the page.
 */
export const resumeImportScenarios: Scenario[] = [{
  name: 'resume-import-pdf-review-to-matching',
  async run({ page, context, api, marker }) {
    const text = resumeText(marker);
    const pdfPage = await context.newPage();
    await pdfPage.setContent(`<!doctype html><meta charset="utf-8"><pre style="font:12px sans-serif">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`);
    const pdf = await pdfPage.pdf({ format: 'A4' });
    await pdfPage.close();

    // An approved entry that the resume repeats, and a job whose preferred skills the resume covers.
    const duplicate = `Terraform, Ansible ${marker}`;
    const manual = await api.post<Fact>('/profile/facts', { kind: 'skill_evidence', statement: duplicate });
    await api.post(`/profile/facts/${manual.id}/approve`);
    const job = await api.post<{ id: string }>('/jobs/import', { company: `Import Co ${marker}`, title: 'Platform engineer', description: 'You will build APIs with GraphQL and run services on Kubernetes.', jobUrl: `https://example.com/${marker}/resume-import` });
      const before = (await api.get<Job>(`/jobs/${job.id}`)).job;
      assert.ok(!before.match.matchedSkills.includes('graphql') && !before.match.matchedSkills.includes('kubernetes'), 'Unconfirmed imported experience is not used for matching');

    const sent: Array<{ url: string; body: string }> = [];
    const watch = (request: Request) => { if (request.url().includes('/api/v1/')) sent.push({ url: new URL(request.url()).pathname, body: `${request.headers()['content-type'] ?? ''}\n${request.postData() ?? ''}` }); };
    page.on('request', watch);
    try {
      await page.goto(new URL('/start', page.url()).toString()); await setLocale(page, 'es');
      await page.getByRole('link', { name: '¿Ya tienes un CV? Importa tus datos aquí.', exact: true }).waitFor();
      await setLocale(page, 'en');
      await page.getByRole('link', { name: 'Already have a resume? Import your details here.', exact: true }).click();
      await page.waitForURL('**/profile/import');

      await page.goto(new URL('/profile', page.url()).toString()); await setLocale(page, 'es');
      await page.getByRole('navigation', { name: 'Secciones de tu perfil' }).getByRole('link', { name: 'Importar desde un CV', exact: true }).click();
      await page.waitForURL('**/profile/import');
      await page.getByRole('heading', { name: 'Elige tu CV', exact: true }).waitFor();
      const resumeInput = page.getByLabel('CV en PDF', { exact: true });
      await eventually(() => resumeInput.isDisabled(), (disabled) => !disabled, 'profile loads before the import accepts a file');
      await resumeInput.setInputFiles({ name: 'cv-ficticio.pdf', mimeType: 'application/pdf', buffer: pdf });
      await page.getByRole('heading', { name: '¿Cómo quieres preparar las propuestas?', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Preparar con Codex', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Continuar sin IA', exact: true }).click();
      await page.getByRole('heading', { name: 'Elige qué guardar', exact: true }).waitFor();
      await page.getByText('No se importan estas secciones: AFICIONES').waitFor();

      const proposal = (name: string) => page.locator('li').filter({ has: page.locator('label').filter({ hasText: name }) }).first();
      assert.equal(await proposal(duplicate).getByRole('checkbox').isChecked(), false, 'A repeat of an existing entry starts unticked');
      await proposal(duplicate).getByText('Ya está en tu perfil', { exact: true }).waitFor();
      assert.equal(await proposal(`Código Inventado ${marker}`).getByRole('checkbox').isChecked(), true);
      await proposal(`Código Inventado ${marker}`).getByText('Fechas por completar', { exact: true }).waitFor();
      await proposal('Inglés (C1)').getByRole('checkbox').uncheck();
      assert.equal(await page.getByRole('checkbox', { name: /^Nombre:/ }).isChecked(), false, 'Identity proposals start unticked');
      await page.getByRole('button', { name: 'Guardar 3 para revisar', exact: true }).click();
      await page.waitForURL('**/profile/import?importId=*');
      const importId = new URL(page.url()).searchParams.get('importId')!;
      await page.getByRole('heading', { name: 'Revisa lo importado', exact: true }).waitFor();

      // Privacy: no request carried the PDF, the text outside the chosen entries, or contact details.
      for (const { body } of sent) {
        assert.doesNotMatch(body, /application\/pdf|multipart\/form-data/u, 'The PDF never leaves the browser');
        for (const secret of [`nora.${marker}@example.test`, '600 000 002', `Escalada privada ${marker}`, 'Inglés (C1)', duplicate]) {
          const match = sent.find((request) => request.body.includes(secret));
          assert.ok(!match, `Not sent: ${secret} (${match?.url ?? 'unknown request'})`);
        }
      }
      const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
      // The browser context is shared with earlier scenarios, which keep their own drafts tagged with the run marker.
      for (const secret of [`nora.${marker}@example.test`, '600 000 002', `Plataforma Ficticia ${marker}`, `Código Inventado ${marker}`, `Escalada privada ${marker}`, duplicate]) {
        assert.ok(!stored.includes(secret), `Nothing from the resume is kept in browser storage: ${secret}`);
      }

      let profile = await api.get<Profile>('/profile');
      const imported = profile.facts.filter((fact) => fact.importId === importId);
      assert.deepEqual(imported.map((fact) => [fact.kind, fact.source, fact.approvalStatus]).sort(), [['experience', 'IMPORTED_SUGGESTION', 'SUGGESTED'], ['experience', 'IMPORTED_SUGGESTION', 'SUGGESTED'], ['language', 'IMPORTED_SUGGESTION', 'SUGGESTED']]);
      assert.equal(imported.find((fact) => fact.details?.organization === `Plataforma Ficticia ${marker}`)?.details?.startMonth, '2022-01');
      assert.equal((await api.get<Job>(`/jobs/${job.id}`)).job.evidenceCoverage, before.evidenceCoverage, 'Suggestions do not change matching');

      // The job with years only is completed by the person before confirming.
      const row = (name: string) => page.locator('li').filter({ hasText: name }).first();
      await row(`Código Inventado ${marker}`).getByRole('button', { name: 'Completar', exact: true }).click();
      await page.getByRole('heading', { name: 'Corregir entrada', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Completar campos y fechas', exact: true }).click();
      await page.getByLabel('Puesto que ocupaste', { exact: true }).fill('Desarrolladora');
      await page.getByLabel('Empresa', { exact: true }).fill(`Código Inventado ${marker}`);
      await page.getByLabel('Fecha de inicio', { exact: true }).fill('2018-03');
      await page.getByLabel('Fecha de fin', { exact: true }).fill('2021-06');
      await page.getByLabel('Describe tu experiencia o logro', { exact: true }).fill('Mantuve servicios internos.');
      await page.getByRole('button', { name: 'Guardar corrección para revisar', exact: true }).click();
      profile = await eventually(() => api.get<Profile>('/profile'), (p) => p.facts.some((fact) => fact.importId === importId && fact.details?.startMonth === '2018-03'), 'The correction stays in the import as a suggestion');
      assert.equal(profile.facts.find((fact) => fact.details?.startMonth === '2018-03')?.approvalStatus, 'SUGGESTED');

      await row('Español (nativo)').getByRole('button', { name: 'Descartar', exact: true }).click();
      await eventually(() => api.get<Profile>('/profile'), (p) => p.facts.some((fact) => fact.importId === importId && fact.kind === 'language' && fact.approvalStatus === 'REJECTED'), 'One entry discarded');

      await page.getByRole('button', { name: 'Confirmar marcadas (2)', exact: true }).click();
      await page.getByRole('button', { name: 'Sí, confirmar 2', exact: true }).click();
      await page.getByText('2 entradas confirmadas. Ya se usan en tus CV y en la comparación con ofertas.').waitFor();
      const after = await eventually(() => api.get<Job>(`/jobs/${job.id}`), (result) => result.job.match.matchedSkills.includes('graphql') && result.job.match.matchedSkills.includes('kubernetes'), 'Confirmed experience is used for matching');
      assert.ok((after.job.fitScore ?? 0) >= (before.fitScore ?? 0));

      // Keyboard and phone width.
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await hasHorizontalOverflow(page), false, 'The review fits a phone screen');
      await setLocale(page, 'en');
      await page.getByRole('heading', { name: 'Review the import', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Undo the whole import', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.getByText('0 pending entries will be discarded and 2 confirmed entries archived', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'Undo import', exact: true }).click();
      await eventually(() => api.get<Profile>('/profile'), (p) => p.facts.filter((fact) => fact.importId === importId).every((fact) => fact.approvalStatus === 'REJECTED'), 'Undo archives the whole import');
      await eventually(() => api.get<Job>(`/jobs/${job.id}`), (result) => result.job.evidenceCoverage === before.evidenceCoverage, 'Undo rescoring removes the imported evidence');
    } finally {
      page.off('request', watch);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await setLocale(page, 'es');
      const current = await api.get<Profile>('/profile');
      for (const fact of current.facts.filter((item) => item.statement.includes(marker) && item.approvalStatus !== 'REJECTED')) await api.post(`/profile/facts/${fact.id}/reject`);
    }
  },
}];
