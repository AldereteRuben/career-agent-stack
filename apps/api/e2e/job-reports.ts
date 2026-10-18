// Job evaluation report (#109) and evaluation of several saved jobs (#110), in the browser, in Spanish and English,
// with the keyboard and at phone width. Fictional profile details and jobs only; no assistant account is involved.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Page, Route } from 'playwright';
import type { Scenario } from './scenarios.js';
import { eventually, hasHorizontalOverflow, setLocale } from './ui.js';

type Profile = { revision: number; profile: Record<string, unknown> };
type Fact = { id: string };
type Batch = { id: string; status: string; counts: { done: number; failed: number; skipped: number; pending: number }; items: Array<{ jobId: string; status: string; verdict: string | null; errorCode: string | null }> };

const delayFirst = (page: Page, pattern: string, ms: number) => {
  let delayed = false;
  let resolveDelayed!: () => void;
  const delayedResponse = new Promise<void>((resolve) => { resolveDelayed = resolve; });
  const handler = async (route: Route) => {
    if (!delayed) { delayed = true; await new Promise((resolve) => setTimeout(resolve, ms)); }
    await route.fallback();
    if (delayed) resolveDelayed();
  };
  return { install: () => page.route(pattern, handler), remove: () => page.unroute(pattern, handler), delayedResponse };
};

export const jobReportsScenario: Scenario = {
  name: 'job-evaluation-report-and-batch',
  async run({ page, api, uiUrl, marker, allowConsole }) {
    // A fictional QA tester in Spain looking for remote QA roles, with two confirmed facts.
    for (const statement of [`Built a Playwright suite for Example Shop ${marker}`, `Wrote TypeScript helpers for Example Shop ${marker}`]) {
      const fact = await api.post<Fact>('/profile/facts', { kind: 'achievement', statement, tags: ['e2e'] });
      await api.post(`/profile/facts/${fact.id}/approve`);
    }
    const profile = await api.get<Profile>('/profile');
    const identity = (profile.profile.identity ?? {}) as Record<string, unknown>;
    const preferences = (profile.profile.preferences ?? {}) as { targetTitles?: string[] };
    await api.put('/profile', { expectedRevision: profile.revision, profile: { ...profile.profile, identity: { ...identity, country: 'ES' }, preferences: { ...preferences, targetTitles: [...(preferences.targetTitles ?? []), `QA ${marker}`], workModes: ['remote'] } } });
    const addJob = async (title: string, description: string) => {
      const job = await api.post<{ id: string }>('/jobs/import', { company: `Report Co ${marker}`, title, location: 'Remote - Spain', jobUrl: `https://example.com/${marker}/${randomUUID()}`, description });
      await api.post(`/jobs/${job.id}/shortlist`, { decision: 'SHORTLISTED' });
      return job.id;
    };
    const good = await addJob(`QA ${marker} Engineer`, 'Requirements: Playwright and TypeScript are required.\nSalary: 40.000 € gross per year.');
    const review = await addJob(`QA ${marker} Analyst`, 'Join a friendly team and help customers every day.');
    const notFit = await addJob(`Data Scientist ${marker}`, 'Python, SQL and AWS are required.');
    const archived = await addJob(`QA ${marker} Archived`, 'Playwright is required.');

    // 1. The report appears on the job page without any action, in words, with evidence and no score.
    await setLocale(page, 'es');
    await page.goto(new URL(`/jobs/${good}`, uiUrl).toString());
    const report = page.getByTestId('job-report');
    await report.getByRole('heading', { name: '¿Vale la pena presentar la solicitud?' }).waitFor();
    await eventually(() => report.innerText(), (text) => text.includes('Conclusión: Buena opción'), 'Spanish conclusion appears');
    const reportText = await report.innerText();
    for (const expected of ['1. Lo que pide la oferta y tu experiencia confirmada lo respalda', 'La oferta dice:', `Built a Playwright suite for Example Shop ${marker}`, '3. Revisa antes de presentar la solicitud', 'Salary: 40.000 € gross per year.', '4. Lo que no sabemos', 'No es la probabilidad de que te contraten']) {
      assert.ok(reportText.includes(expected), `The report shows “${expected}”`);
    }
    assert.doesNotMatch(reportText, /\/\s?100|%/, 'The report never shows a score or a percentage');
    // The availability card keeps its inner spacing (regression for a heading flush with the card border).
    const inset = await page.evaluate(() => {
      const card = document.getElementById('availability-heading')?.closest('section');
      const heading = document.getElementById('availability-heading');
      return card && heading ? heading.getBoundingClientRect().left - card.getBoundingClientRect().left : -1;
    });
    assert.ok(inset >= 16, `The availability heading sits inside the card padding (inset ${inset}px)`);
    await setLocale(page, 'en');
    await eventually(() => report.innerText(), (text) => text.includes('Is it worth applying?') && text.includes('Conclusion: Good option') && text.includes('It is not the probability of being hired'), 'English report');

    await page.goto(new URL(`/jobs/${review}`, uiUrl).toString());
    await eventually(() => page.getByTestId('job-report').innerText(), (text) => text.includes('Conclusion: Worth reviewing') && text.includes('We found no specific requirements in the description.'), 'A job without clear requirements says so');
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await page.getByTestId('job-report').waitFor();
      assert.equal(await hasHorizontalOverflow(page), false, 'The report fits a phone screen');
    } finally { await page.setViewportSize({ width: 1440, height: 1000 }); }

    // 2. Several saved jobs, chosen with the keyboard, evaluated after confirmation, paused and continued.
    await setLocale(page, 'es');
    await page.goto(new URL(`/jobs?scope=favorites&q=${encodeURIComponent(marker)}`, uiUrl).toString());
    const panel = page.getByTestId('job-report-batch');
    await panel.getByRole('heading', { name: 'Evaluar ofertas guardadas' }).waitFor();
    for (const title of [`QA ${marker} Engineer`, `QA ${marker} Analyst`, `Data Scientist ${marker}`, `QA ${marker} Archived`]) {
      const box = page.getByRole('checkbox', { name: `Evaluar: ${title}` });
      await box.focus(); await page.keyboard.press('Space');
      assert.equal(await box.isChecked(), true, `${title} selected with the keyboard`);
    }
    // Meanwhile the person archives one of them elsewhere, and the list they chose from contains a job that no longer exists.
    await api.post(`/jobs/${archived}/shortlist`, { decision: 'ARCHIVED' });
    const missing = randomUUID();
    const stale = async (route: Route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as { jobIds: string[] };
      await route.fallback({ postData: JSON.stringify({ ...body, jobIds: [...body.jobIds, missing] }) });
    };
    await page.route('**/api/v1/job-report-batches', stale);
    const slowPass = delayFirst(page, '**/api/v1/job-report-batches/*/advance', 2_500);
    await slowPass.install();
    try {
      await panel.getByRole('button', { name: 'Evaluar 4 ofertas seleccionadas' }).click();
      await panel.getByRole('heading', { name: 'Se evaluarán 4 ofertas. ¿Empezamos?' }).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'job-report-batch-confirm', 'Focus moves to the confirmation');
      await panel.getByRole('button', { name: 'Sí, evaluar' }).click();
      await panel.getByRole('button', { name: 'Pausar' }).click();
      await eventually(() => panel.innerText(), (text) => text.includes('En pausa') && text.includes('0 de 5 revisadas'), 'The batch pauses before its first pass');
    } finally { await page.unroute('**/api/v1/job-report-batches', stale); await slowPass.remove(); }
    const paused = await api.get<{ batch: Batch }>('/job-report-batches/current');
    assert.equal(paused.batch.status, 'PAUSED'); assert.equal(paused.batch.counts.pending, 5);
    await panel.getByRole('button', { name: 'Continuar' }).click();
    await eventually(() => panel.innerText(), (text) => text.includes('Terminada') && text.includes('Resultados, de más a menos favorable'), 'The batch finishes', 20_000);
    const rows = await panel.locator('[data-batch-item]').evaluateAll((items) => items.map((item) => item.getAttribute('data-batch-item')));
    assert.deepEqual(rows, [good, review, notFit, missing, archived], 'Most favourable first; failed and skipped jobs stay listed');
    const panelText = await panel.innerText();
    for (const expected of ['Buena opción', 'Conviene revisar', 'Probablemente no encaja', 'La oferta ya no existe en tu espacio de trabajo.', 'Omitida: la oferta está archivada.', '2 de 2 requisitos reconocidos respaldados']) assert.ok(panelText.includes(expected), `The results show “${expected}”`);
    const done = await api.get<{ batch: Batch }>('/job-report-batches/current');
    assert.deepEqual(done.batch.counts, { pending: 0, done: 3, failed: 1, skipped: 1 });

    await setLocale(page, 'en');
    await eventually(() => panel.innerText(), (text) => text.includes('Evaluate saved jobs') && text.includes('Results, most favourable first') && text.includes('Good option') && text.includes('Skipped: the job is archived.'), 'English batch results');

    // 3. Cancelling keeps what was evaluated and needs confirmation.
    for (const title of [`QA ${marker} Engineer`, `QA ${marker} Analyst`]) await page.getByRole('checkbox', { name: `Evaluate: ${title}` }).check();
    const slowCancel = delayFirst(page, '**/api/v1/job-report-batches/*/advance', 4_000);
    await slowCancel.install();
    try {
      await panel.getByRole('button', { name: 'Evaluate 2 selected jobs' }).click();
      await panel.getByRole('button', { name: 'Yes, evaluate' }).click();
      allowConsole(/dialog/i);
      page.once('dialog', (dialog) => void dialog.accept());
      await panel.getByRole('button', { name: 'Cancel evaluation' }).click();
      await eventually(() => panel.innerText(), (text) => text.includes('Cancelled') && text.includes('Not evaluated: you cancelled the evaluation.'), 'The batch is cancelled');
      const cancelled = await api.get<{ batch: Batch }>('/job-report-batches/current');
      for (const title of [`QA ${marker} Engineer`, `QA ${marker} Analyst`]) await page.getByRole('checkbox', { name: `Evaluate: ${title}` }).check();
      await panel.getByRole('button', { name: 'Evaluate 2 selected jobs' }).click();
      await panel.getByRole('button', { name: 'Yes, evaluate' }).click();
      await eventually(() => api.get<{ batch: Batch }>('/job-report-batches/current'), (result) => result.batch.id !== cancelled.batch.id && result.batch.status === 'COMPLETED', 'A replacement batch completes while the cancelled request is still in flight', 20_000);
      await slowCancel.delayedResponse;
      await eventually(() => panel.innerText(), (text) => text.includes('Finished 2 of 2 reviewed') && text.includes('Results, most favourable first') && !text.includes('Cancelled'), 'The late cancelled response does not replace the completed batch');
      const replacement = await api.get<{ batch: Batch }>('/job-report-batches/current');
      assert.notEqual(replacement.batch.id, cancelled.batch.id);
      assert.equal(replacement.batch.status, 'COMPLETED');
    } finally { await slowCancel.remove(); }

    await page.setViewportSize({ width: 390, height: 844 });
    try {
      await panel.waitFor();
      assert.equal(await hasHorizontalOverflow(page), false, 'Saved jobs with the evaluation panel fit a phone screen');
    } finally { await page.setViewportSize({ width: 1440, height: 1000 }); await setLocale(page, 'es'); }
  },
};
