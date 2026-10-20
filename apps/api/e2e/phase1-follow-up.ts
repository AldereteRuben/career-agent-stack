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
    const activeRow = page.locator('.tracker-row').filter({ has: page.getByText(`QA ${marker}`, { exact: true }) });
    const closedRow = page.locator('.tracker-row').filter({ has: page.getByText(`Closed QA ${marker}`, { exact: true }) });
    await eventually(() => activeRow.innerText(), (value) => /Vencida/.test(value), 'overdue follow-up appears in the list');
    const orderedTitles = await page.locator('.tracker-row .tracker-main > strong').allTextContents();
    const activeIndex = orderedTitles.indexOf(`QA ${marker}`);
    const closedIndex = orderedTitles.indexOf(`Closed QA ${marker}`);
    assert.ok(activeIndex >= 0 && closedIndex >= 0 && activeIndex < closedIndex, 'active follow-ups appear before closed applications even when the closed date is earlier');
    assert.doesNotMatch(await closedRow.innerText(), /Vencida|Vence hoy/, 'closed applications do not show due-state labels');
    await page.getByLabel('Siguiente paso', { exact: true }).fill('Contactar a la reclutadora');
    const saved = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/v1/applications/${application.id}`);
    await page.getByRole('button', { name: 'Guardar seguimiento', exact: true }).click();
    assert.equal((await saved).status(), 200);
    assert.equal((await api.get<Application>(`/applications/${application.id}`)).nextStep, 'Contactar a la reclutadora');

    const noInterview = await api.post<Application>('/applications', { company: `No interview ${marker}`, role: `No interview QA ${marker}`, state: 'DRAFT', notes: '' });
    await page.goto(new URL(`/applications?id=${noInterview.id}`, uiUrl).toString());
    await page.getByLabel('Siguiente paso', { exact: true }).waitFor();
    const interviewDisclosure = page.locator('.application-detail-interview');
    await interviewDisclosure.waitFor();
    assert.equal(await interviewDisclosure.getAttribute('open'), null, 'interview controls start collapsed when no interview is scheduled');
    await page.getByLabel('Fecha y hora de entrevista', { exact: true }).waitFor({ state: 'hidden' });
    await interviewDisclosure.locator('summary').click();
    const interviewTime = page.getByLabel('Fecha y hora de entrevista', { exact: true });
    const interviewZone = page.getByLabel('Zona horaria de la entrevista (IANA)', { exact: true });
    await interviewTime.waitFor();
    await interviewTime.fill('2026-12-03T10:00');
    await interviewZone.fill('Europe/Madrid');
    const savedInterview = page.waitForResponse((response) => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `/api/v1/applications/${noInterview.id}`);
    await page.getByRole('button', { name: 'Guardar seguimiento', exact: true }).click();
    assert.equal((await savedInterview).status(), 200);
    const scheduledInterview = await api.get<Application>(`/applications/${noInterview.id}`);
    assert.equal(scheduledInterview.interviewAt, '2026-12-03T09:00:00.000Z');
    assert.equal(scheduledInterview.interviewTimezone, 'Europe/Madrid');
    await eventually(() => interviewDisclosure.locator('summary').innerText(), (value) => /Entrevista programada/.test(value), 'scheduled interview is summarized in the collapsed control');

    assert.equal((await api.get<Application>(`/applications/${application.id}`)).state, 'CONFIRMED', 'a confirmed application remains active for follow-up purposes');
  },
};
