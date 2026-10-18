import assert from 'node:assert/strict';
import type { Scenario } from './scenarios.js';

type Application = { id: string };
type Metrics = {
  period: string; confirmed: number; interviewed: number; interviewConversionPercent: number | null;
  noResponseYet: number; noResponseAfter14Days: number; noResponseThresholdDays: number;
};

export const trackingMetricsScenario: Scenario = {
  name: 'tracking-metrics-confirmation-cohort-stage-corrections-and-no-response-age',
  async run({ api, db, marker }) {
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
  },
};
