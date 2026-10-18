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

    // A successful explicit lookup carries its short-lived source handle only with the person's confirmed save.
    await setLocale(page, 'es');
    await page.goto(new URL('/jobs', uiUrl).toString());
    await page.getByRole('button', { name: 'Añadir oferta', exact: true }).first().click();
    const trackedUrl = `https://job-boards.greenhouse.io/fictional-${marker}/jobs/777`;
    const lookupToken = '00000000-0000-4000-8000-000000000161';
    await page.route('**/api/v1/jobs/lookup', (route) => route.fulfill({ json: { supported: true, provider: 'greenhouse', region: 'global', tenant: `fictional-${marker}`, externalId: '777', title: `Tracked role ${marker}`, company: 'Fictional Labs', companyConfirmed: true, location: 'Remote', description: 'Synthetic source description.', jobUrl: trackedUrl, applyUrl: trackedUrl, lookupToken } }));
    let savedBody: Record<string, unknown> | null = null;
    await page.route('**/api/v1/jobs/import', async (route) => {
      savedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 201, json: { id: '00000000-0000-4000-8000-000000000161', company: 'Fictional Labs', title: `Tracked role ${marker}`, canonicalUrl: trackedUrl, alreadySaved: false, sourceTracked: true } });
    });
    await page.getByLabel('URL oficial de la oferta').fill(trackedUrl);
    await page.getByRole('button', { name: 'Rellenar desde el enlace', exact: true }).click();
    await page.getByText('Datos rellenados desde la página pública').waitFor();
    await page.locator('.import-card').getByRole('button', { name: 'Guardar oferta', exact: true }).click();
    await page.getByText('Oferta añadida. Abre sus detalles para preparar tu solicitud.').waitFor();
    assert.equal(savedBody?.postingLookupToken, lookupToken, 'only the confirmed save sends the server-held source handle');
    assert.equal(savedBody?.jobUrl, trackedUrl);
    await page.unroute('**/api/v1/jobs/lookup');
    await page.unroute('**/api/v1/jobs/import');

    // The lookup never overwrites what the person already wrote, and an answer for an old link fills nothing.
    await setLocale(page, 'es');
    await page.goto(new URL('/jobs', uiUrl).toString());
    await page.getByRole('button', { name: 'Añadir oferta', exact: true }).first().click();
    const fill = page.getByRole('button', { name: 'Rellenar desde el enlace', exact: true });
    const field = (label: string) => page.getByLabel(label, { exact: true });
    const answer = (url: string) => ({ supported: true, provider: 'greenhouse', region: 'global', tenant: `fictional-${marker}`, externalId: '333', title: `Platform Engineer ${marker}`, company: 'Fictional Labs', companyConfirmed: true, location: 'Remote, Spain', description: 'Build the platform.', jobUrl: url, applyUrl: url });

    const kept = `https://job-boards.greenhouse.io/fictional-${marker}/jobs/333`;
    await page.route('**/api/v1/jobs/lookup', (route) => route.fulfill({ json: answer(kept) }));
    await field('Empresa').fill('Mi empresa'); await field('Descripción (opcional)').fill('Mi propia nota');
    await field('URL oficial de la oferta').fill(kept);
    await fill.click();
    await page.getByText('No cambiamos lo que ya habías escrito: Empresa, Descripción.').waitFor();
    assert.equal(await field('Empresa').inputValue(), 'Mi empresa', 'a company the person typed is kept');
    assert.equal(await field('Descripción (opcional)').inputValue(), 'Mi propia nota', 'a description the person pasted is kept');
    assert.equal(await field('Puesto').inputValue(), `Platform Engineer ${marker}`, 'empty fields are filled');
    assert.equal(await field('Ubicación').inputValue(), 'Remote, Spain');
    await page.unroute('**/api/v1/jobs/lookup');

    for (const name of ['Empresa', 'Puesto', 'Ubicación', 'Descripción (opcional)']) await field(name).fill('');
    const oldLink = `https://job-boards.greenhouse.io/fictional-${marker}/jobs/444`; const newLink = `https://jobs.lever.co/fictional-${marker}/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/api/v1/jobs/lookup', async (route) => { await gate; await route.fulfill({ json: answer(oldLink) }); });
    await field('URL oficial de la oferta').fill(oldLink);
    await fill.click();
    await field('URL oficial de la oferta').fill(newLink);
    release();
    await page.getByText('Cambiaste el enlace mientras consultábamos').waitFor();
    assert.equal(await field('URL oficial de la oferta').inputValue(), newLink, 'the link the person typed is not replaced by the old answer');
    assert.equal(await field('Puesto').inputValue(), '', 'the late answer fills nothing');
    assert.equal(await field('Empresa').inputValue(), '');
    await page.unroute('**/api/v1/jobs/lookup');
    for (const name of ['URL oficial de la oferta']) await field(name).fill('');
  },
};
