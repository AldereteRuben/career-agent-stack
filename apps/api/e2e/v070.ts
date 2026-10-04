import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Scenario } from './scenarios.js';
import { eventually, hasHorizontalOverflow, setLocale } from './ui.js';

/** All feed entries and profile details are fictional, confined to the harness database. */
export const v070Scenario: Scenario = {
  name: 'v070-saved-search-to-prepared-application',
  async run({ page, api, db, marker, artifacts, note }) {
    const workspace = (await db.query<{ id: string }>('select id from workspaces limit 1')).rows[0]!.id;
    const title = `Automation designer ${marker}`;
    const company = `Fictional Search ${marker}`;
    const fixture = { externalId: marker, title, company, location: 'Spain', workMode: 'remote', url: `https://remotive.com/remote-jobs/qa/${marker}`, postedAt: new Date().toISOString(), description: '<p>Automation designer builds Playwright tests and accessible design systems.</p><ul><li>Fictional requirement</li></ul>', raw: {} };
    // Pin both feeds in the disposable cache: no public API calls can be made by this scenario.
    for (const provider of ['remotive', 'arbeitnow']) await db.query("insert into job_search_provider_cache(provider,payload,fetched_at,next_fetch_at) values($1,$2::jsonb,now(),now()+interval '24 hours') on conflict(provider) do update set payload=excluded.payload,fetched_at=excluded.fetched_at,next_fetch_at=excluded.next_fetch_at,last_error=null", [provider, JSON.stringify(provider === 'remotive' ? [fixture] : [])]);
    try {
      const profile = await api.get<{ revision: number; profile: Record<string, unknown> }>('/profile');
      await api.put('/profile', { expectedRevision: profile.revision, locale: 'es', profile: { ...profile.profile, identity: { fullName: 'Alex Fictional', email: 'alex@example.test' } } });
      const fact = await api.post<{ id: string }>('/profile/facts', { kind: 'achievement', statement: 'Built Playwright automation tests and accessible design systems.', tags: ['Playwright', 'automation', 'design'] });
      await api.post(`/profile/facts/${fact.id}/approve`, {});
      await setLocale(page, 'es');
      await page.goto(new URL('/searches', page.url()).toString());
      await page.getByRole('heading', { name: 'Buscar empleo', exact: true }).waitFor();
      await page.getByLabel('Puesto o palabras clave', { exact: true }).fill('Automation designer');
      await page.getByLabel('Empresa (opcional)', { exact: true }).fill(company);
      await page.getByText('Fuentes y opciones', { exact: true }).click();
      await page.getByLabel('Modalidad', { exact: true }).selectOption('remote');
      await page.getByRole('checkbox', { name: 'Himalayas', exact: true }).uncheck(); // Only the two seeded fictional caches.
      await page.getByRole('checkbox', { name: /Preparar también un CV/ }).check();
      await page.getByRole('button', { name: /Buscar y guardar/ }).click();
      await page.getByRole('link', { name: title, exact: true }).waitFor({ timeout: 60000 });
      const search = (await db.query<{ id: string; enabled: boolean }>('select id, enabled from saved_job_searches where workspace_id=$1 and company=$2', [workspace, company])).rows[0]!;
      assert.equal(search.enabled, true);
      await page.goto(new URL('/', page.url()).toString());
      await page.goto(new URL('/searches', page.url()).toString());
      await page.getByRole('link', { name: title, exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('search'), search.id, 'Returning from navigation restores the selected search');
      const matching = await db.query<{ id: string }>('select id from jobs where workspace_id=$1 and title=$2', [workspace, title]);
      assert.equal(matching.rows.length, 1); const jobId = matching.rows[0]!.id;
      const prepared = await eventually(() => api.get<Array<{ jobId: string; status: string; documentId: string | null; applicationId: string | null }>>('/preparations'), (items) => items.some((item) => item.jobId === jobId && item.status === 'PREPARED'), 'The saved-search match prepares a reviewable candidature');
      const item = prepared.find((candidate) => candidate.jobId === jobId)!;
      assert.ok(item.documentId); assert.ok(item.applicationId);
      const firstDocument = item.documentId;
      const repeated = await api.post<{ documentId: string | null; applicationId: string | null }>('/preparations', { jobId, locale: 'es' });
      assert.equal(repeated.documentId, firstDocument); assert.equal(repeated.applicationId, item.applicationId);
      for (const locale of ['es', 'en'] as const) {
        await setLocale(page, locale);
        for (const width of [1096, 390, 320]) {
          await page.setViewportSize({ width, height: 844 });
          if (width < 850) await page.locator('#app-sidebar').waitFor({ state: 'hidden' });
          assert.equal(await hasHorizontalOverflow(page), false, `Searches fit ${locale}/${width}`);
        }
        await page.screenshot({ path: join(artifacts, `v070-search-${locale}.png`), fullPage: true });
      }
      const searchCard = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: `Automation designer · ${company}`, exact: true }) });
      await searchCard.getByRole('button', { name: 'Pause', exact: true }).click();
      await eventually(async () => (await db.query<{ enabled: boolean }>('select enabled from saved_job_searches where id=$1', [search.id])).rows[0]!.enabled, (enabled) => !enabled, 'Pause is persisted');
      await searchCard.getByRole('button', { name: 'Edit', exact: true }).click();
      await page.getByLabel('Refresh frequency', { exact: true }).selectOption('24');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await eventually(async () => (await db.query<{ frequency_hours: number }>('select frequency_hours from saved_job_searches where id=$1', [search.id])).rows[0]!.frequency_hours, (hours) => hours === 24, 'Edited frequency persists');
      await page.goto(new URL('/preparations', page.url()).toString());
      const candidate = page.locator('section.card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
      await candidate.waitFor();
      await candidate.getByRole('link', { name: /Review document|Review resume/, exact: true }).click();
      await page.locator('.pdf-preview canvas:not([hidden])').waitFor({ state: 'visible' });
      const docs = await api.get<Array<{ id: string; reviewReady: boolean; approvalStatus: string }>>('/documents');
      assert.equal(docs.find((doc) => doc.id === firstDocument)?.reviewReady, true);
      assert.equal(docs.find((doc) => doc.id === firstDocument)?.approvalStatus, 'PENDING_REVIEW', 'Preparation does not approve transmission');
      await page.goto(new URL(`/jobs/${jobId}`, page.url()).toString());
      await page.getByRole('link', { name: 'Remotive', exact: true }).waitFor();
      assert.equal(await page.locator('.detail-main > section').first().locator('#job-description').count(), 1, 'The job description precedes fit analysis');
      assert.equal(await page.locator('.fit-explanation').getAttribute('open'), null, 'Detailed scoring does not bury the job description');
      const description = await page.locator('.description-text').innerText();
      assert.doesNotMatch(description, /<\/?(?:p|li|ul)>/);
      assert.match(description, /• Fictional requirement/);
      await page.getByRole('heading', { name: 'Prepare your application', exact: true }).waitFor();
      assert.equal(await page.getByRole('link', { name: 'Choose resume content', exact: true }).isVisible(), false, 'Manual content selection is an optional path');
      await page.getByText('I prefer to choose my resume content', { exact: true }).click();
      await page.getByRole('link', { name: 'Choose resume content', exact: true }).waitFor();
      for (const width of [1096, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        if (width < 850) await page.locator('#app-sidebar').waitFor({ state: 'hidden' });
        assert.equal(await hasHorizontalOverflow(page), false, `Job detail fits at ${width}`);
      }
      assert.equal((await db.query('select id from jobs where workspace_id=$1 and title=$2', [workspace, title])).rows.length, 1);
      await page.screenshot({ path: join(artifacts, 'v070-prepared-job-en.png'), fullPage: true });
      await page.getByRole('button', { name: 'Prepare my application', exact: true }).click();
      await page.waitForURL('**/documents?**');
      const reviewParams = new URL(page.url()).searchParams;
      assert.equal(reviewParams.get('applicationId'), item.applicationId, 'Preparing from the job continues the same application');
      assert.ok(reviewParams.get('document'), 'Preparing from the job opens its PDF for review');
      await page.locator('.pdf-preview canvas:not([hidden])').waitFor({ state: 'visible' });
      note('Fictional cached feeds → saved query → automatic draft → PDF review; no external application submitted.');
    } finally {
      await db.query('update saved_job_searches set enabled=false,auto_prepare=false where workspace_id=$1', [workspace]);
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
  },
};
