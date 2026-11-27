import assert from 'node:assert/strict';
import type { Scenario } from './scenarios.js';
import { eventually, setLocale } from './ui.js';

type Result = { id: string; title: string; shortlistDecision: string };

export const undoScenario: Scenario = {
  name: 'undo-archive-and-unsave-restore-the-previous-decision',
  async run({ page, api, db, marker, note }) {
    // A fictional cached feed gives the saved search one real, persisted result; no portal is contacted.
    const fixture = { externalId: `undo-${marker}`, title: `Undo designer ${marker}`, company: `Undo ${marker}`, location: 'Spain', workMode: 'remote', url: `https://remotive.com/remote-jobs/design/undo-${marker}`, description: 'Design accessible forms.', postedAt: null, raw: {} };
    for (const provider of ['remotive', 'arbeitnow']) await db.query("insert into job_search_provider_cache(provider,payload,fetched_at,next_fetch_at) values($1,$2::jsonb,now(),now()+interval '24 hours') on conflict(provider) do update set payload=excluded.payload,fetched_at=excluded.fetched_at,next_fetch_at=excluded.next_fetch_at,last_error=null", [provider, JSON.stringify(provider === 'remotive' ? [fixture] : [])]);
    const { search } = await api.post<{ search: { id: string } }>('/job-searches', { role: 'Undo designer', company: fixture.company, location: null, enabled: true, frequencyHours: 24, autoPrepare: false, workMode: 'any', language: 'es' });
    const results = await eventually(() => api.get<{ items: Result[] }>(`/job-searches/${search.id}/results?offset=0`), (body) => body.items.some((item) => item.title === fixture.title), 'The fictional feed produces a result');
    const jobId = results.items.find((item) => item.title === fixture.title)!.id;
    const decision = async () => (await api.get<{ job: { shortlistDecision: string } }>(`/jobs/${jobId}`)).job.shortlistDecision;
    const hasDecision = (expected: string, label: string) => eventually(decision, (value) => value === expected, label);

    await page.goto(new URL(`/searches?search=${search.id}&view=all`, page.url()).toString());
    await setLocale(page, 'es');
    const card = page.locator('section.card').filter({ has: page.getByRole('link', { name: fixture.title, exact: true }) });
    await card.getByRole('button', { name: 'Guardar oferta', exact: true }).click();
    await hasDecision('SHORTLISTED', 'The job is saved');
    const undo = page.getByRole('button', { name: /^Deshacer/u });
    assert.equal(await undo.count(), 0, 'Saving offers no undo; the button itself reverses it');

    // Unsave, then undo: the job is saved again.
    await card.getByRole('button', { name: 'Quitar de guardadas', exact: true }).click();
    await hasDecision('UNREVIEWED', 'The job is unsaved');
    await undo.click();
    await hasDecision('SHORTLISTED', 'Undo saves the job again');
    await page.getByText('Cambio deshecho.', { exact: false }).waitFor();
    assert.equal(await undo.count(), 0, 'Undo is offered once');

    // Archive a saved job, then undo: it comes back saved, not merely unarchived.
    await card.getByRole('button', { name: 'Archivar', exact: true }).click();
    await hasDecision('ARCHIVED', 'The job is archived');
    // The list reloads and moves focus to the job that took this one's place; Undo stays next to the result count.
    await undo.click();
    await hasDecision('SHORTLISTED', 'Undo returns the archived job to Saved');

    // Job detail: archiving asks nothing and offers Undo next to its message.
    await page.goto(new URL(`/jobs/${jobId}`, page.url()).toString());
    const archive = page.getByRole('button', { name: 'Archivar oferta', exact: true });
    await archive.click();
    await hasDecision('ARCHIVED', 'The job detail archives at once');
    assert.equal(await page.getByRole('dialog').count(), 0, 'Archiving a job asks for no confirmation');
    await page.getByText('Oferta archivada. Puedes encontrarla con el filtro Archivadas.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Deshacer', exact: true }).focus(); await page.keyboard.press('Enter');
    await hasDecision('SHORTLISTED', 'Undo on the job detail returns it to Saved, from the keyboard');
    await page.getByText('Archivado deshecho. La oferta vuelve a estar como antes.', { exact: true }).waitFor();
    assert.equal(await archive.evaluate((node) => node === document.activeElement), true, 'Focus returns to the archive button after undo');
    assert.equal(await page.getByRole('button', { name: 'Deshacer', exact: true }).count(), 0, 'Undo disappears once used');

    // A restore is not offered as undoable, and English uses its own label.
    await archive.click();
    await hasDecision('ARCHIVED', 'Archived again');
    await setLocale(page, 'en');
    await page.getByRole('button', { name: 'Restore job', exact: true }).click();
    await hasDecision('UNREVIEWED', 'Restore from the detail');
    assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).count(), 0, 'Restoring is not offered as undoable');
    note('Fictional cached feed; undo after unsave and archive on search results, and after archive on the job detail, the detail one from the keyboard.');
  },
};
