import assert from 'node:assert/strict';
import type { Scenario } from './scenarios.js';
import { eventually, setLocale } from './ui.js';

type Application = { id: string; state: string; nextStep: string | null; followUpDate: string | null; interviewAt: string | null; interviewTimezone: string | null };
type ApplicationEvent = { eventType: string; evidence: Record<string, unknown> | null };

export const phase1FollowUpScenario: Scenario = {
  name: 'phase1-application-follow-up-and-interview-time-zone',
  async run({ page, api, uiUrl, marker }) {
    const application = await api.post<Application>('/applications', { company: `Follow-up ${marker}`, role: `QA ${marker}`, state: 'DRAFT', notes: '' });
    const overdueDate = await page.evaluate(() => { const date = new Date(); date.setDate(date.getDate() - 30); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; });
    const interviewLocal = '2026-12-02T09:30';
    const updated = await api.patch<Application>(`/applications/${application.id}`, {
      nextStep: 'Send a short follow-up', followUpDate: overdueDate, interview: { localAt: interviewLocal, timeZone: 'Europe/Madrid' },
    });
    assert.equal(updated.nextStep, 'Send a short follow-up');
    assert.equal(updated.followUpDate, overdueDate);
    assert.equal(updated.interviewTimezone, 'Europe/Madrid');
    assert.equal(updated.interviewAt, '2026-12-02T08:30:00.000Z', 'winter wall time converts to UTC using the chosen zone');
    await api.patch(`/applications/${application.id}`, { state: 'CONFIRMED', confirmationEvidence: 'USER_ATTESTATION' });
    const closed = await api.post<Application>('/applications', { company: `Closed follow-up ${marker}`, role: `Closed QA ${marker}`, state: 'DRAFT', notes: '' });
    await api.patch(`/applications/${closed.id}`, { followUpDate: '2020-01-01', state: 'CANCELLED' });
    const events = await api.get<ApplicationEvent[]>(`/applications/${application.id}/events`);
    assert.ok(events.some((event) => event.eventType === 'FOLLOW_UP_UPDATED'));
    assert.ok(events.some((event) => event.eventType === 'INTERVIEW_UPDATED'));

    await setLocale(page, 'es');
    await page.goto(new URL(`/applications?id=${application.id}&sort=follow-up&q=${encodeURIComponent(marker)}`, uiUrl).toString());
    await eventually(() => page.getByLabel('Siguiente paso', { exact: true }).inputValue(), (value) => value === 'Send a short follow-up', 'saved next step appears in Spanish tracker');
    await page.getByLabel('Recordatorio para', { exact: true }).waitFor();
    await page.getByLabel('Fecha y hora de entrevista', { exact: true }).waitFor();
    await page.getByLabel('Zona horaria de la entrevista (IANA)', { exact: true }).waitFor();
    await eventually(() => page.locator('.tracker-row').filter({ hasText: `QA ${marker}` }).innerText(), (value) => /Vencida/.test(value), 'overdue follow-up appears in the list');
    const orderedRows = await page.locator('.tracker-row').allInnerTexts();
    assert.ok(orderedRows.findIndex((row) => row.includes(`QA ${marker}`)) < orderedRows.findIndex((row) => row.includes(`Closed QA ${marker}`)), 'active follow-ups appear before closed applications even when the closed date is earlier');
    await page.getByLabel('Siguiente paso', { exact: true }).fill('Contactar a la reclutadora');
    const saved = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/v1/applications/${application.id}`);
    await page.getByRole('button', { name: 'Guardar seguimiento', exact: true }).click();
    assert.equal((await saved).status(), 200);
    assert.equal((await api.get<Application>(`/applications/${application.id}`)).nextStep, 'Contactar a la reclutadora');

    await api.patch(`/applications/${application.id}`, { state: 'CANCELLED' });
    await page.reload();
    await eventually(() => page.locator('.tracker-row').filter({ hasText: `QA ${marker}` }).innerText(), (value) => !/Vencida|Vence hoy/.test(value), 'closed applications do not show an overdue follow-up');
  },
};
