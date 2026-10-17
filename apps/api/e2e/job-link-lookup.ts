import assert from 'node:assert/strict';
import type { Scenario } from './scenarios.js';
import { eventually, setLocale } from './ui.js';

type Job = { id: string; company: string; title: string; canonicalUrl: string | null };

export const jobLinkLookupScenario: Scenario = {
  name: 'job-link-prefills-the-form-and-saves-only-on-confirmation',
  async run({ page, api, uiUrl, marker }) {
    for (const locale of ['es', 'en'] as const) {
      const t = (es: string, en: string) => (locale === 'es' ? es : en);
      await setLocale(page, locale);
      await page.goto(new URL('/jobs', uiUrl).toString());
      await page.getByRole('button', { name: t('Añadir oferta', 'Add a job'), exact: true }).first().click();
      const fill = page.getByRole('button', { name: t('Rellenar desde el enlace', 'Fill in from the link'), exact: true });
      const urlField = page.getByLabel(t('URL oficial de la oferta', 'Official job URL'));
      assert.equal(await fill.isDisabled(), true, 'the button needs a link first');

      // A link from another site is not recognised, and the real API answers without any request to it.
      await urlField.fill(`https://careers.example.test/jobs/${marker}-${locale}`);
      await fill.click();
      await page.getByText(t('Este enlace no es de Greenhouse, Lever ni Ashby', 'This link is not from Greenhouse, Lever or Ashby')).waitFor();
      assert.equal(await page.getByLabel(t('Puesto', 'Job title')).inputValue(), '', 'nothing is filled in for an unsupported link');

      // A recognised link pre-fills the form. The answer is mocked so the run needs no internet; the request is the real one.
      const posting = `https://job-boards.greenhouse.io/fictional-${marker}/jobs/${locale === 'es' ? '111' : '222'}`;
      let requested: unknown = null;
      await page.route('**/api/v1/jobs/lookup', async (route) => {
        requested = route.request().postDataJSON();
        await route.fulfill({ json: { supported: true, provider: 'greenhouse', region: 'global', tenant: `fictional-${marker}`, externalId: '111', title: `Platform Engineer ${marker} ${locale}`, company: 'Fictional Labs', companyConfirmed: true, location: 'Remote, Spain', description: 'Build the platform.', jobUrl: posting, applyUrl: posting } });
      });
      await urlField.fill(posting);
      await fill.click();
      await page.getByText(t('Datos rellenados desde la página pública', 'Details filled in from the public posting page')).waitFor();
      assert.deepEqual(requested, { url: posting });
      assert.equal(await page.getByLabel(t('Empresa', 'Company')).inputValue(), 'Fictional Labs');
      assert.equal(await page.getByLabel(t('Puesto', 'Job title')).inputValue(), `Platform Engineer ${marker} ${locale}`);
      assert.equal(await page.getByLabel(t('Ubicación', 'Location')).inputValue(), 'Remote, Spain');
      assert.equal((await api.get<Job[]>('/jobs')).some((job) => job.canonicalUrl === posting), false, 'nothing is saved until the person confirms');

      // Saving is the person's own action, and it saves the job once.
      await page.locator('.import-card').getByRole('button', { name: t('Guardar oferta', 'Save job'), exact: true }).click();
      await eventually(async () => (await api.get<Job[]>('/jobs')).filter((job) => job.canonicalUrl === posting).length, (count) => count === 1, 'the confirmed job is saved once');
      await page.unroute('**/api/v1/jobs/lookup');
    }
  },
};
