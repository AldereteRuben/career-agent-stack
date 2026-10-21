import assert from 'node:assert/strict';
import { AxeBuilder } from '@axe-core/playwright';
import type { Locator, Page } from 'playwright';
import type { Scenario } from './scenarios.js';
import { any, hasHorizontalOverflow, setLocale } from './ui.js';

async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 120; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Keyboard navigation could not reach the requested interview-preparation control');
}

async function activateWithKeyboard(page: Page, target: Locator) {
  await tabTo(page, target);
  await page.keyboard.press('Enter');
}

async function checkWithKeyboard(page: Page, target: Locator) {
  await tabTo(page, target);
  await page.keyboard.press('Space');
}

async function typeWithKeyboard(page: Page, target: Locator, value: string) {
  await tabTo(page, target);
  await page.keyboard.type(value);
}

export const interviewPreparationUiScenario: Scenario = {
  name: 'interview-preparation-ui-keyboard-locales-and-mobile',
  async run({ page, api, uiUrl, marker, allowConsole }) {
    // Fictional fixture: a QA role, one approved Playwright achievement, one user note and one mock answer.
    // The isolated E2E workspace must never be seeded from a real profile or resume.
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
    await activateWithKeyboard(page, panel.getByRole('button', { name: 'Crear plan' }));
    const planDisclosure = panel.locator('details').first();
    const planSummary = planDisclosure.locator(':scope > summary');
    await activateWithKeyboard(page, planSummary);
    assert.equal(await planDisclosure.evaluate((element) => (element as HTMLDetailsElement).open), true);
    await panel.getByText('Oferta guardada', { exact: false }).first().waitFor();
    await panel.getByText('Respaldado por experiencia aprobada', { exact: true }).first().waitFor();

    // The native disclosure remains keyboard operable and preserves focus on its summary.
    await page.keyboard.press('Enter');
    assert.equal(await planDisclosure.evaluate((element) => (element as HTMLDetailsElement).open), false);
    assert.equal(await planSummary.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press('Enter');
    await typeWithKeyboard(page, panel.getByLabel('Añadir nota o pregunta'), `Ask about onboarding ${marker}`);
    await activateWithKeyboard(page, panel.getByRole('button', { name: 'Añadir al plan' }));
    await panel.getByText(`Ask about onboarding ${marker}`).waitFor();

    const audit = async (flow: string) => {
      const result = await new AxeBuilder({ page }).include('[class*="application-interview-preparation_panel"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
      assert.deepEqual(result.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map((node) => node.target) })), [], `Interview preparation accessibility violations in ${flow}`);
    };
    await audit('Spanish desktop');

    // Keyboard-only opening of the practice panel; only fictitious E2E records are used.
    const practice = panel.locator('details').nth(2);
    const practiceSummary = practice.locator(':scope > summary');
    await activateWithKeyboard(page, practiceSummary);
    await activateWithKeyboard(page, panel.getByRole('button', { name: 'Practicar preguntas' }));
    await typeWithKeyboard(page, panel.getByLabel('Tu respuesta'), `En el proyecto ${marker}, cuando el equipo necesitaba pruebas, diseñé y construí una suite con Playwright. Como resultado reduje errores en cada entrega.`);
    await activateWithKeyboard(page, panel.getByRole('button', { name: 'Enviar respuesta' }));
    await panel.getByText(/Observaciones automáticas/).waitFor();
    await activateWithKeyboard(page, panel.getByRole('button', { name: 'Feedback opcional de Codex' }));
    await panel.getByText(/Solo comenta esta respuesta de práctica/).waitFor();
    const mockPanel = panel.locator('[class*="mockPanel"]');
    const selectedFact = mockPanel.getByRole('checkbox', { name: 'Built a Playwright suite at' });
    assert.equal(await selectedFact.isChecked(), false, 'approved facts are not selected by default for mock feedback');
    await activateWithKeyboard(page, panel.getByRole('button', { name: 'Revisar datos que se enviarán' }));
    await mockPanel.locator('dd').filter({ hasText: `En el proyecto ${marker}` }).waitFor();
    await mockPanel.getByText(/Codex no está disponible ahora/).waitFor();
    assert.equal(await mockPanel.getByRole('checkbox', { name: /Confirmo enviar esta respuesta/ }).count(), 0, 'unavailable Codex cannot receive this practice answer');
    await activateWithKeyboard(page, mockPanel.getByRole('button', { name: 'Cancelar' }));

    // Exercise the connected-provider UI without enabling Codex or sending fixture data anywhere.
    // The real isolated preview still builds the exact payload; Playwright only changes its availability
    // flag and supplies a fictional response for this browser flow.
    let previewPayload: { payloadSha256: string; available: boolean; sent: { question: string; answer: string; facts: Array<{ factId: string; text: string }> } } | undefined;
    let dispatchedBody: Record<string, unknown> | undefined;
    let discardRequested = false;
    let acceptRequested = false;
    await page.route('**/api/v1/interview-preparation/sessions/*/turns/*/assistant-feedback/preview', async (route) => {
      const response = await route.fetch();
      const body = await response.json() as typeof previewPayload;
      assert.ok(body, 'the isolated API returned the real feedback preview');
      previewPayload = { ...body, available: true };
      await route.fulfill({ response, body: JSON.stringify(previewPayload) });
    });
    await page.route('**/api/v1/interview-preparation/sessions/*/turns/*/assistant-feedback', async (route) => {
      const requestBody = route.request().postDataJSON() as Record<string, unknown>;
      dispatchedBody = requestBody;
      assert.deepEqual(requestBody.factIds, [fact.id], 'only the explicitly selected approved fact is included');
      assert.equal(requestBody.confirmed, true, 'the UI only dispatches after explicit consent');
      assert.equal(requestBody.origin, 'MANUAL', 'the practice feedback remains a user-triggered request');
      assert.equal(requestBody.payloadSha256, previewPayload?.payloadSha256, 'dispatch is bound to the reviewed preview');
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        runId: '00000000-0000-4000-8000-000000000001', payloadSha256: previewPayload?.payloadSha256,
        label: 'GENERATED_PRACTICE_FEEDBACK', feedback: {
          operation: 'INTERVIEW_MOCK_FEEDBACK', summary: 'La respuesta describe una acción concreta y cómo la aplicaste.',
          strengths: [{ answerQuote: 'diseñé y construí una suite con Playwright.', note: 'Incluye una acción específica.' }],
          improvements: ['Añade un resultado observable si lo recuerdas.'], claimsToVerify: [], evidenceFactIds: [fact.id], warnings: [],
        },
      }) });
    });
    await page.route('**/api/v1/interview-preparation/sessions/*/turns/*/assistant-feedback/discard', async (route) => {
      discardRequested = true;
      await route.fulfill({ status: 204, body: '' });
    });
    await page.route('**/api/v1/interview-preparation/sessions/*/turns/*/assistant-feedback/accept', async (route) => {
      acceptRequested = true;
      const requestBody = route.request().postDataJSON() as { feedback: Record<string, unknown> };
      const turnId = new URL(route.request().url()).pathname.split('/').at(-3);
      assert.ok(turnId, 'accept is attached to the reviewed practice turn');
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ turn: {
        id: turnId, position: 0, kind: 'QUESTION', question: previewPayload?.sent.question ?? '', answer: previewPayload?.sent.answer ?? '',
        feedback: { assessments: [], probe: null }, learningItems: [], verdict: null,
        assistantFeedback: { ...requestBody.feedback, generated: true, provider: 'codex', acceptedAt: new Date().toISOString() },
      } }) });
    });
    await activateWithKeyboard(page, panel.getByRole('button', { name: 'Feedback opcional de Codex' }));
    const connectedMockPanel = panel.locator('[class*="mockPanel"]');
    const selectedForFeedback = connectedMockPanel.getByRole('checkbox', { name: 'Built a Playwright suite at' });
    await checkWithKeyboard(page, selectedForFeedback);
    await activateWithKeyboard(page, connectedMockPanel.getByRole('button', { name: 'Revisar datos que se enviarán' }));
    await connectedMockPanel.locator('dd').filter({ hasText: `En el proyecto ${marker}` }).waitFor();
    assert.ok(previewPayload?.sent.answer.includes(`En el proyecto ${marker}`), 'the preview contains only the fictional practice answer');
    assert.deepEqual(previewPayload?.sent.facts.map((item) => item.factId), [fact.id], 'the real preview contains only the selected fact');
    const consent = connectedMockPanel.getByRole('checkbox', { name: /Confirmo enviar esta respuesta/ });
    const generateFeedback = connectedMockPanel.getByRole('button', { name: 'Generar feedback' });
    assert.equal(await generateFeedback.isDisabled(), true, 'feedback cannot be sent before consent');
    assert.equal(dispatchedBody, undefined, 'reviewing the payload does not dispatch it');
    await checkWithKeyboard(page, consent);
    await activateWithKeyboard(page, generateFeedback);
    await connectedMockPanel.getByText('La respuesta describe una acción concreta y cómo la aplicaste.').waitFor();
    assert.ok(dispatchedBody, 'the fake response is requested only after consent');
    await activateWithKeyboard(page, connectedMockPanel.getByRole('button', { name: 'Descartar resultado' }));
    assert.equal(discardRequested, true, 'discard sends the explicit discard action');
    await connectedMockPanel.getByText('La respuesta describe una acción concreta y cómo la aplicaste.').waitFor({ state: 'detached' });
    const afterDiscard = await api.get<{ plans: Array<{ sessions: Array<{ turns: Array<{ assistantFeedback?: unknown }> }> }> }>(`/applications/${application.id}/interview-preparation`);
    assert.equal(afterDiscard.plans[0]?.sessions[0]?.turns[0]?.assistantFeedback ?? null, null, 'discarded fictional feedback is absent from saved history');

    // A second fictional result can be accepted explicitly and displayed as practice history.
    await activateWithKeyboard(page, panel.getByRole('button', { name: 'Feedback opcional de Codex' }));
    const acceptedMockPanel = panel.locator('[class*="mockPanel"]');
    await checkWithKeyboard(page, acceptedMockPanel.getByRole('checkbox', { name: 'Built a Playwright suite at' }));
    await activateWithKeyboard(page, acceptedMockPanel.getByRole('button', { name: 'Revisar datos que se enviarán' }));
    await checkWithKeyboard(page, acceptedMockPanel.getByRole('checkbox', { name: /Confirmo enviar esta respuesta/ }));
    await activateWithKeyboard(page, acceptedMockPanel.getByRole('button', { name: 'Generar feedback' }));
    await acceptedMockPanel.getByText('La respuesta describe una acción concreta y cómo la aplicaste.').waitFor();
    await activateWithKeyboard(page, acceptedMockPanel.getByRole('button', { name: 'Guardar en el historial' }));
    await panel.locator('.notice-success .notice-message', { hasText: 'Feedback guardado en el historial de práctica.' }).waitFor();
    await panel.getByText('Generado por Codex · práctica').waitFor();
    assert.equal(acceptRequested, true, 'the result enters practice history only after an explicit save action');

    await activateWithKeyboard(page, panel.getByRole('button', { name: 'Terminar práctica' }));
    await activateWithKeyboard(page, panel.getByRole('button', { name: 'Volver al plan' }));
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

    const plans = await api.get<{ plans: Array<{ id: string }> }>(`/applications/${application.id}/interview-preparation`);
    const planId = plans.plans[0]?.id;
    assert.ok(planId, 'The fictional application retains its interview plan');
    const exported = await api.get<{ data: {
      interviewPreparationPlans: Array<{ id: string }>;
      interviewPreparationEvidence: Array<{ planId: string; sourceId: string }>;
      interviewPreparationItems: Array<{ planId: string; content: string }>;
      interviewPreparationSessions: Array<{ id: string; planId: string }>;
      interviewPreparationTurns: Array<{ sessionId: string; answer: string }>;
    } }>('/export');
    assert.ok(exported.data.interviewPreparationPlans.some((plan) => plan.id === planId), 'The JSON export keeps the interview plan');
    assert.ok(exported.data.interviewPreparationEvidence.some((evidence) => evidence.planId === planId && evidence.sourceId === fact.id), 'The export keeps approved-fact provenance');
    assert.ok(exported.data.interviewPreparationItems.some((item) => item.planId === planId && item.content === `Ask about onboarding ${marker}`), 'The export keeps the user-authored note');
    const session = exported.data.interviewPreparationSessions.find((item) => item.planId === planId);
    assert.ok(session, 'The export keeps the mock session');
    assert.ok(exported.data.interviewPreparationTurns.some((turn) => turn.sessionId === session.id && turn.answer.includes(`En el proyecto ${marker}`)), 'The export preserves the session-to-turn reference and answer');

    // Withdrawing the cited approved fact makes the plan evidence stale before the plan is deleted.
    await api.post(`/profile/facts/${fact.id}/reject`);
    await setLocale(page, 'es');
    await page.reload();
    await panel.getByText('Alguna evidencia cambió o ya no está disponible. Revisa el plan antes de confiar en él o enviarlo a Codex.').waitFor();

    // Deleting the plan removes its preparation history and makes it disappear from subsequent exports.
    page.once('dialog', (dialog) => dialog.accept());
    await activateWithKeyboard(page, panel.getByRole('button', { name: 'Eliminar plan' }));
    await panel.locator('.notice-success .notice-message', { hasText: 'Plan eliminado.' }).waitFor();
    const remaining = await api.get<{ plans: Array<{ id: string }> }>(`/applications/${application.id}/interview-preparation`);
    assert.equal(remaining.plans.some((plan) => plan.id === planId), false, 'Deleting a plan removes it from its application');
    const afterDelete = await api.get<{ data: { interviewPreparationPlans: Array<{ id: string }>; interviewPreparationSessions: Array<{ planId: string }> } }>('/export');
    assert.equal(afterDelete.data.interviewPreparationPlans.some((plan) => plan.id === planId), false, 'Deleted plans are absent from later exports');
    assert.equal(afterDelete.data.interviewPreparationSessions.some((item) => item.planId === planId), false, 'Deleting a plan also removes its practice history');
  },
};
