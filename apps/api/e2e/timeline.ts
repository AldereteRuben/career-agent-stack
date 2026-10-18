import assert from 'node:assert/strict';
import type { Scenario } from './scenarios.js';
import { eventually, hasHorizontalOverflow, mainNavigation, setLocale } from './ui.js';

type Application = { id: string };

export const timelineScenario: Scenario = {
  name: 'activity-timeline-dated-records-filters-and-overdue',
  async run({ page, api, uiUrl, marker, db }) {
    const job = await api.post<{ id: string }>('/jobs/import', { company: `Timeline ${marker}`, title: `Saved tester ${marker}`, jobUrl: `https://example.com/${marker}/timeline` });
    await db.query('update jobs set discovered_at=created_at where id=$1', [job.id]);
    await api.post(`/jobs/${job.id}/shortlist`, { decision: 'SHORTLISTED' });
    const application = await api.post<Application>('/applications', { company: `Timeline ${marker}`, role: `Timeline QA ${marker}`, state: 'DRAFT', notes: '' });
    // Dates come from the browser so they match the calendar days the page shows.
    // No named helpers inside evaluate: the test transpiler would reference its own helper there.
    const [overdueDate, today, timeZone] = await page.evaluate(() => [-40, 0].map((offset) => new Date(Date.now() + offset * 86_400_000)).map((date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`).concat(Intl.DateTimeFormat().resolvedOptions().timeZone));
    const interviewLocal = `${today}T12:30`;
    await api.patch(`/applications/${application.id}`, { nextStep: `Call back ${marker}`, followUpDate: overdueDate, interview: { localAt: interviewLocal, timeZone } });
    await api.patch(`/applications/${application.id}`, { state: 'CONFIRMED', confirmationEvidence: 'USER_ATTESTATION' });
    await api.patch(`/applications/${application.id}`, { recruitmentStage: 'INTERVIEW' });

    for (const locale of ['es', 'en'] as const) {
      const c = (es: string, en: string) => locale === 'es' ? es : en;
      await setLocale(page, locale); await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(new URL('/applications', uiUrl).toString());
      await page.getByRole('link', { name: c('Cronología', 'Timeline'), exact: true }).click();
      await page.waitForURL((url) => url.pathname === '/timeline');
      await page.getByRole('heading', { level: 1, name: c('Cronología', 'Timeline') }).waitFor();
      assert.equal(await mainNavigation(page).getByRole('link').count(), 4, 'the timeline does not add a primary destination');
      assert.equal(await mainNavigation(page).locator('a[href="/applications"]').getAttribute('aria-current'), 'page', 'the timeline sits under Applications');

      const overdue = page.locator('section').filter({ has: page.getByRole('heading', { name: new RegExp(c('Recordatorios vencidos', 'Overdue follow-ups')) }) });
      await eventually(() => overdue.innerText(), (text) => text.includes(`Timeline QA ${marker}`) && text.includes(`Call back ${marker}`), 'the overdue follow-up is listed whatever month is shown');

      const entries = page.locator('ol li li').filter({ hasText: marker });
      const labels = async () => (await entries.allInnerTexts()).join('\n');
      for (const label of [c('Oferta encontrada', 'Job found'), c('Oferta guardada', 'Job saved'), c('Solicitud creada', 'Application created'), c('Estado', 'Status'), c('Etapa', 'Stage'), c('Entrevista', 'Interview')]) {
        await eventually(labels, (text) => text.includes(label), `${locale}: timeline shows "${label}"`);
      }
      assert.match(await labels(), /12:30/, 'the interview shows its local time');

      // Filters are real checkboxes, operable from the keyboard.
      const interviews = page.getByRole('checkbox', { name: c('Entrevistas', 'Interviews'), exact: true });
      const interviewEntries = entries.filter({ has: page.locator('.tag').getByText(c('Entrevista', 'Interview'), { exact: true }) });
      await interviews.focus(); await page.keyboard.press('Space');
      assert.equal(await interviews.isChecked(), false);
      await eventually(() => interviewEntries.count(), (count) => count === 0, `${locale}: interview filter hides interviews`);
      assert.match(await labels(), new RegExp(c('Oferta guardada', 'Job saved')), `${locale}: other types stay visible`);
      await page.keyboard.press('Space');
      await eventually(() => interviewEntries.count(), (count) => count === 1, `${locale}: interviews come back`);

      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await hasHorizontalOverflow(page), false, `${locale}: timeline overflows at phone width`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  },
};
