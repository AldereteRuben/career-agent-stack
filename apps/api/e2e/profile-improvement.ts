import assert from 'node:assert/strict';
import type { Scenario } from './scenarios.js';
import { hasHorizontalOverflow, setLocale } from './ui.js';

type Fact = { id: string };

export const profileImprovementScenario: Scenario = {
  name: 'manual-profile-improvement-uses-approved-evidence-and-copies-with-citations',
  async run({ page, context, api, uiUrl, marker }) {
    const statement = `Automated payment regression tests ${marker}.`;
    const approved = await api.post<Fact>('/profile/facts', {
      kind: 'experience', statement, tags: ['Playwright'],
      employment: { role: `Quality Engineer ${marker}`, company: `Example Company ${marker}`, startMonth: '2020-01', endMonth: '2022-12', current: false, locale: 'en' },
    });
    await api.post(`/profile/facts/${approved.id}/approve`);
    await api.post('/profile/facts', { kind: 'experience', statement: `Pending director claim ${marker}`, tags: [], source: 'USER_ENTERED' });

    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: uiUrl });
    const outbound: string[] = [];
    const onRequest = (request: { url(): string }) => { const hostname = new URL(request.url()).hostname; if (hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com')) outbound.push(request.url()); };
    page.on('request', onRequest);
    try {
      for (const locale of ['es', 'en'] as const) {
        const c = (es: string, en: string) => locale === 'es' ? es : en;
        await page.setViewportSize({ width: 1280, height: 900 });
        await setLocale(page, locale);
        await page.goto(new URL('/profile', uiUrl).toString());
        const pack = page.getByTestId('profile-improvement-pack');
        await pack.getByRole('heading', { name: c('Mejora tu perfil profesional', 'Improve your professional profile'), exact: true }).waitFor();
        const headlines = pack.getByRole('heading', { name: c('Titulares basados en tu experiencia', 'Headlines grounded in your experience'), exact: true }).locator('..');
        await headlines.getByText(`Quality Engineer ${marker} · Playwright`, { exact: true }).waitFor();
        const about = pack.getByRole('heading', { name: c('Borrador de «Acerca de»', 'About draft'), exact: true }).locator('..');
        await about.getByText(locale === 'es' ? `Experiencia en Quality Engineer ${marker} en Example Company ${marker}.` : `Experience in Quality Engineer ${marker} at Example Company ${marker}.`, { exact: true }).waitFor();
        assert.equal(await pack.getByText(`Pending director claim ${marker}`, { exact: true }).count(), 0, 'pending claims are not used in the improvement pack');

        const copy = pack.getByRole('button', { name: c('Copiar con evidencia', 'Copy with evidence') }).first();
        await copy.focus(); await page.keyboard.press('Enter');
        await pack.getByRole('status').getByText(c('Texto y evidencia copiados.', 'Text and evidence copied.'), { exact: true }).waitFor();
        const clipboard = await page.evaluate(() => navigator.clipboard.readText());
        assert.match(clipboard, /Quality Engineer/);
        assert.ok(clipboard.includes(statement), 'clipboard includes the exact approved source evidence');

        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await hasHorizontalOverflow(page), false, `${locale}: profile improvement pack overflows at phone width`);
      }
      assert.deepEqual(outbound, [], 'the profile pack makes no LinkedIn requests');
    } finally {
      page.off('request', onRequest);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  },
};
