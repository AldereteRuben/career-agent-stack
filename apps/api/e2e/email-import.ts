import assert from 'node:assert/strict';
import type { Scenario } from './scenarios.js';
import { any, eventually } from './ui.js';

type Application = { id: string; recruitmentStage: string; version: number };
type ImportedEvent = { eventType: string; priorState: string; newState: string; evidence: Record<string, unknown> };

export const emailImportScenario: Scenario = {
  name: 'application-email-import-requires-stage-confirmation-and-protects-offer',
  async run({ page, api, uiUrl, marker, db }) {
    const application = await api.post<Application>('/applications', { company: `Fictional Email ${marker}`, role: `QA Candidate ${marker}`, state: 'DRAFT', notes: '' });
    await page.goto(`${uiUrl}/applications?id=${application.id}`);
    await page.getByRole('heading', { name: `QA Candidate ${marker}` }).first().waitFor();
    await page.getByText(any('Importar un email', 'Import an email')).click();
    const paste = page.getByLabel(any('Texto del mensaje', 'Message text'));
    await paste.fill(`Hello ${marker}. We would like to invite you to an interview next week.`);
    await page.getByRole('button', { name: any('Revisar mensaje', 'Review message') }).click();
    await page.getByText(any('Aplicar la etapa sugerida', 'Apply suggested stage')).waitFor();
    assert.equal((await api.get<Application[]>(`/applications?q=${encodeURIComponent(marker)}`)).find((row) => row.id === application.id)?.recruitmentStage, 'NO_RESPONSE', 'Preview must not change the stage');
    await page.getByRole('button', { name: any('Guardar sin cambiar etapa', 'Save without changing stage') }).click();
    await eventually(async () => (await api.get<Application[]>(`/applications?q=${encodeURIComponent(marker)}`)).find((row) => row.id === application.id)?.recruitmentStage, (stage) => stage === 'NO_RESPONSE', 'Saving without checking the stage option keeps the current stage');

    await paste.fill(`Another message ${marker}: We would like to invite you to an interview.`);
    await page.getByRole('button', { name: any('Revisar mensaje', 'Review message') }).click();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: any('Guardar y cambiar etapa', 'Save and change stage') }).click();
    await eventually(async () => (await api.get<Application[]>(`/applications?q=${encodeURIComponent(marker)}`)).find((row) => row.id === application.id)?.recruitmentStage, (stage) => stage === 'INTERVIEW', 'An explicitly checked stage proposal advances the application');

    await api.patch(`/applications/${application.id}`, { recruitmentStage: 'OFFER' });
    await page.reload();
    await page.getByText(any('Importar un email', 'Import an email')).click();
    await paste.fill(`We regret to inform you ${marker}; we decided not to proceed.`);
    await page.getByRole('button', { name: any('Revisar mensaje', 'Review message') }).click();
    await page.getByText(any('La etapa actual es Oferta', 'The current stage is Offer')).waitFor();
    assert.equal(await page.getByRole('checkbox').count(), 0, 'An offer-stage downgrade is not offered for confirmation');
    await page.getByRole('button', { name: any('Guardar sin cambiar etapa', 'Save without changing stage') }).click();
    await eventually(async () => (await api.get<Application[]>(`/applications?q=${encodeURIComponent(marker)}`)).find((row) => row.id === application.id)?.recruitmentStage, (stage) => stage === 'OFFER', 'A later email cannot downgrade an offer');

    const events = await api.get<ImportedEvent[]>(`/applications/${application.id}/events`);
    const imports = events.filter((event) => event.eventType === 'EMAIL_IMPORTED');
    assert.equal(imports.length, 3);
    assert.ok(imports.every((event) => typeof event.evidence.messageRef === 'string' && /^[a-f0-9]{64}$/.test(String(event.evidence.messageRef))));
    const stored = await db.query<{ evidence: Record<string, unknown> }>('select evidence from application_events where application_id=$1 and event_type=$2', [application.id, 'EMAIL_IMPORTED']);
    assert.ok(stored.rows.every((row) => !JSON.stringify(row.evidence).includes(marker) && !JSON.stringify(row.evidence).includes('invite you to an interview')));
  },
};
