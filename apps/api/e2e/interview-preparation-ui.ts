import assert from 'node:assert/strict';
import { AxeBuilder } from '@axe-core/playwright';
import type { Scenario } from './scenarios.js';
import { any, hasHorizontalOverflow, setLocale } from './ui.js';

export const interviewPreparationUiScenario: Scenario = {
  name: 'interview-preparation-ui-keyboard-locales-and-mobile',
  async run({ page, api, uiUrl, marker, allowConsole }) {
    // The application page probes for an optional existing resume and cover letter; for this fresh fixture both return 404.
    allowConsole(/Failed to load resource: the server responded with a status of 404 \(Not Found\)/);
    const company = `Interview UI ${marker}`;
    const role = `QA Interview ${marker}`;
    const job = await api.post<{ id: string }>('/jobs/import', { company, title: role, jobUrl: `https://example.com/${marker}/interview-ui`, description: 'Requirements: Playwright and TypeScript are required.' });
    const fact = await api.post<{ id: string }>('/profile/facts', { kind: 'achievement', statement: `Built a Playwright suite at Example ${marker}`, tags: ['interview'] });
    await api.post(`/profile/facts/${fact.id}/approve`);
    const application = await api.post<{ id: string }>('/applications', { jobId: job.id, company, role, state: 'DRAFT', notes: '' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await setLocale(page, 'es');
    await page.goto(new URL(`/applications?id=${application.id}`, uiUrl).toString());
    const panel = page.locator('[class*="application-interview-preparation_panel"]');
    await panel.getByRole('heading', { name: 'Preparar entrevista' }).waitFor();
    await panel.getByRole('button', { name: 'Crear plan' }).click();
    const planDisclosure = panel.locator('details').first();
    const planSummary = planDisclosure.locator(':scope > summary');
    await planSummary.focus(); await page.keyboard.press('Enter');
    assert.equal(await planDisclosure.evaluate((element) => (element as HTMLDetailsElement).open), true);
    await panel.getByText('Oferta guardada', { exact: false }).first().waitFor();
    await panel.getByText('Respaldado por experiencia aprobada', { exact: true }).first().waitFor();

    // The native disclosure remains keyboard operable and preserves focus on its summary.
    await page.keyboard.press('Enter');
    assert.equal(await planDisclosure.evaluate((element) => (element as HTMLDetailsElement).open), false);
    assert.equal(await planSummary.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('Enter');
    await panel.getByLabel('Añadir nota o pregunta').fill(`Ask about onboarding ${marker}`);
    await panel.getByRole('button', { name: 'Añadir al plan' }).click();
    await panel.getByText(`Ask about onboarding ${marker}`).waitFor();

    const audit = async (flow: string) => {
      const result = await new AxeBuilder({ page }).include('[class*="application-interview-preparation_panel"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
      assert.deepEqual(result.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map((node) => node.target) })), [], `Interview preparation accessibility violations in ${flow}`);
    };
    await audit('Spanish desktop');

    // Keyboard-only opening of the practice panel; only fictitious E2E records are used.
    const practice = panel.locator('details').nth(2);
    const practiceSummary = practice.locator(':scope > summary');
    await practiceSummary.focus(); await page.keyboard.press('Enter');
    await panel.getByRole('button', { name: 'Practicar preguntas' }).click();
    await panel.getByLabel('Tu respuesta').fill(`En el proyecto ${marker}, cuando el equipo necesitaba pruebas, diseñé y construí una suite con Playwright. Como resultado reduje errores en cada entrega.`);
    await panel.getByRole('button', { name: 'Enviar respuesta' }).click();
    await panel.getByText(/Observaciones automáticas/).waitFor();
    await panel.getByRole('button', { name: 'Terminar práctica' }).click();
    await panel.getByRole('button', { name: 'Volver al plan' }).click();
    await panel.getByText('Historial de prácticas', { exact: false }).waitFor();

    await setLocale(page, 'en');
    await panel.getByRole('heading', { name: 'Prepare for an interview' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await hasHorizontalOverflow(page), false, 'Interview preparation fits a 390 px mobile viewport');
    await audit('English mobile');
    await page.setViewportSize({ width: 1440, height: 1000 });

    // The Codex payload is not dispatched by preview. This test covers the consent boundary's review UI without needing a connected account.
    await practiceSummary.focus(); await page.keyboard.press('Enter');
    await panel.locator('details').nth(1).locator(':scope > summary').focus(); await page.keyboard.press('Enter');
    await panel.getByRole('button', { name: any('Review data before sending', 'Revisar datos antes de enviar') }).waitFor();
  },
};
