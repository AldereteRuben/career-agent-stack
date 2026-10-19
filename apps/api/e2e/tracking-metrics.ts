import assert from 'node:assert/strict';
import type { Scenario } from './scenarios.js';
import { hasHorizontalOverflow, setLocale } from './ui.js';

type Application = { id: string };
type Job = { id: string; workspaceId: string };
type Metrics = {
  period: string; confirmed: number; interviewed: number; interviewConversionPercent: number | null;
  noResponseYet: number; noResponseAfter14Days: number; noResponseThresholdDays: number;
  breakdowns: { source: Array<{ key: string; confirmed: number; interviewed: number; interviewConversionPercent: number | null; smallSample: boolean }>; role: Array<{ key: string; confirmed: number; interviewed: number; interviewConversionPercent: number | null; smallSample: boolean }>; country: Array<{ key: string; confirmed: number; interviewed: number; interviewConversionPercent: number | null; smallSample: boolean }> };
};

export const trackingMetricsScenario: Scenario = {
  name: 'tracking-metrics-confirmation-cohort-stage-corrections-and-no-response-age',
  async run({ api, db, marker, page, uiUrl }) {
    const before = await api.get<Metrics>('/tracking-metrics?period=30d');
    const createConfirmed = async (role: string) => {
      const application = await api.post<Application>('/applications', { company: `Metrics ${marker}`, role: `${role} ${marker}`, state: 'DRAFT', notes: '' });
      await api.patch(`/applications/${application.id}`, { state: 'CONFIRMED', confirmationEvidence: 'USER_ATTESTATION' });
      return application;
    };

    const interviewed = await createConfirmed('Interview');
    await api.patch(`/applications/${interviewed.id}`, { recruitmentStage: 'INTERVIEW' });
    await api.patch(`/applications/${interviewed.id}`, { recruitmentStage: 'REJECTED' });

    const corrected = await createConfirmed('Corrected');
    await api.patch(`/applications/${corrected.id}`, { recruitmentStage: 'INTERVIEW' });
    await api.patch(`/applications/${corrected.id}`, { recruitmentStage: 'ASSESSMENT', correction: true, reason: 'Fixture correction' });
    await api.patch(`/applications/${corrected.id}`, { recruitmentStage: 'REJECTED' });

    const laterCorrection = await createConfirmed('Later correction');
    await api.patch(`/applications/${laterCorrection.id}`, { recruitmentStage: 'INTERVIEW' });
    await api.patch(`/applications/${laterCorrection.id}`, { recruitmentStage: 'OFFER' });
    await api.patch(`/applications/${laterCorrection.id}`, { recruitmentStage: 'ASSESSMENT', correction: true, reason: 'Correct a later stage' });
    await api.patch(`/applications/${laterCorrection.id}`, { recruitmentStage: 'REJECTED' });

    await createConfirmed('Recent no response');
    const old = await createConfirmed('Old no response');
    await db.query("update application_events set created_at=now() - interval '15 days' where application_id=$1 and new_state='CONFIRMED'", [old.id]);

    const cancelled = await createConfirmed('Cancelled');
    await db.query("update applications set state='CANCELLED' where id=$1", [cancelled.id]);

    const metrics = await api.get<Metrics>('/tracking-metrics?period=30d');
    assert.equal(metrics.confirmed, before.confirmed + 5, 'only non-cancelled applications with confirmation evidence count');
    assert.equal(metrics.interviewed, before.interviewed + 2, 'a corrected-away interview is excluded but earlier interview evidence survives correcting a later stage');
    assert.equal(metrics.interviewConversionPercent, Math.round(((before.interviewed + 2) / (before.confirmed + 5)) * 100));
    assert.equal(metrics.noResponseYet, before.noResponseYet + 1, 'a recent confirmed application with no response is in the recent group');
    assert.equal(metrics.noResponseAfter14Days, before.noResponseAfter14Days + 1, 'an application with no response after 14 days is separated');
    assert.equal(metrics.noResponseThresholdDays, 14);
    assert.equal(metrics.period, '30d');

    const trackedJob = await api.post<Job>('/jobs/import', {
      company: `Tracked source ${marker}`, title: `Tracked role ${marker}`, jobUrl: `https://jobs.example.test/${marker}`, description: 'Synthetic tracked source.',
    });
    await db.query('insert into job_search_sources (workspace_id, job_id, provider, external_id, source_url) values ($1, $2, $3, $4, $5)', [
      trackedJob.workspaceId, trackedJob.id, 'e2e-test', marker, `https://jobs.example.test/${marker}`,
    ]);
    const attributed = await api.post<Application>('/applications', { jobId: trackedJob.id, company: `Tracked source ${marker}`, role: `Tracked role ${marker}`, state: 'DRAFT', notes: '' });
    await api.patch(`/applications/${attributed.id}`, { state: 'CONFIRMED', confirmationEvidence: 'USER_ATTESTATION' });
    await api.patch(`/applications/${attributed.id}`, { recruitmentStage: 'INTERVIEW' });
    const grouped = await api.get<Metrics>('/tracking-metrics?period=30d');
    assert.deepEqual(grouped.breakdowns.source.find((group) => group.key === 'e2e-test'), {
      key: 'e2e-test', label: 'e2e-test', confirmed: 1, interviewed: 1, interviewConversionPercent: null, smallSample: true,
    }, 'the API attributes only the explicitly linked provider and suppresses the one-application percentage');
    assert.equal(grouped.breakdowns.role.find((group) => group.key === `tracked role ${marker}`)?.confirmed, 1);
    assert.equal(grouped.breakdowns.country.find((group) => group.key === 'unidentified')?.confirmed, 1);

    for (const locale of ['es', 'en'] as const) {
      const c = (es: string, en: string) => locale === 'es' ? es : en;
      await page.setViewportSize({ width: 1280, height: 900 });
      await setLocale(page, locale);
      await page.goto(new URL('/overview', uiUrl).toString());
      const source = page.locator('section').filter({ has: page.getByRole('heading', { name: c('Por fuente', 'By source'), exact: true }) });
      const role = page.locator('section').filter({ has: page.getByRole('heading', { name: c('Por puesto', 'By role'), exact: true }) });
      const country = page.locator('section').filter({ has: page.getByRole('heading', { name: c('Por país', 'By country'), exact: true }) });
      await source.getByText(c('e2e-test', 'e2e-test'), { exact: true }).waitFor();
      await source.getByText(`1 ${c('solicitudes', 'applications')} · 1 ${c('entrevistas', 'interviews')}`, { exact: true }).waitFor();
      await role.getByText(`Tracked role ${marker}`, { exact: true }).waitFor();
      await country.getByText(c('País no identificado', 'Country not identified'), { exact: true }).waitFor();
      await country.getByText(c('La ubicación se guarda como texto libre; no inferimos el país.', 'Location is stored as free text, so we do not infer a country.'), { exact: true }).waitFor();
      await source.getByText(c('Muestra pequeña', 'Small sample'), { exact: true }).waitFor();

      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await hasHorizontalOverflow(page), false, `${locale}: overview breakdowns overflow at phone width`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  },
};
