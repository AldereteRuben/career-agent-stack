import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Scenario, ScenarioContext } from './scenarios.js';
import { eventually, goTo, hasHorizontalOverflow, setLocale } from './ui.js';

export const v060Scenario: Scenario = {
  name: 'v060-automatic-search-and-new-jobs',
  async run({ page, api, db, marker, artifacts, note }) {
    await checkCompanyEntry({ page, artifacts });
    // db is created by the isolation harness; production sources are never called by this scenario.
    const workspace = (await db.query<{ id: string }>('select id from workspaces limit 1')).rows[0]!.id;
    const board = randomUUID(); const other = randomUUID();
    await db.query("insert into boards(id,workspace_id,provider,tenant,region,company_name,company_domain,careers_url,enabled,association_status,permission_status,next_run_at,last_run_at,last_run_status,last_new_count) values($1,$2,'lever',$3,'global',$4,'example.test','https://example.test/careers',true,'VERIFIED','APPROVED_FOR_SCOPE',now() + interval '7 hours',now(),'COMPLETE',2)", [board, workspace, marker, `Discovery ${marker}`]);
    const job = await api.post<{ id: string }>('/jobs/import', { company: `Discovery ${marker}`, title: `Designer ${marker}`, location: 'Madrid', jobUrl: `https://example.test/${marker}/discovery`, description: 'Design experience' });
    await db.query('update jobs set discovered_at = now() where id = $1', [job.id]);
    // All existing fixture boards are kept out of the worker's due queue while testing opt-in.
    await db.query("update boards set next_run_at = now() + interval '7 hours'");
    await db.query('insert into workspaces(id) values($1)', [other]);
    await db.query("insert into jobs(workspace_id,company,title,discovered_at) values($1,'Other workspace','Private unrelated job',now())", [other]);
    try {
      for (const locale of ['es', 'en'] as const) {
        await setLocale(page, locale); await page.setViewportSize({ width: 390, height: 844 });
        await goTo(page, '/boards');
        const activate = page.getByRole('button', { name: locale === 'es' ? 'Activar búsqueda automática' : 'Turn on automatic search', exact: true });
        await activate.waitFor(); await activate.click();
        await eventually(async () => (await api.get<{ enabled: boolean }>('/discovery')).enabled, Boolean, 'Opt-in persisted');
        await page.reload();
        const pause = page.getByRole('button', { name: locale === 'es' ? 'Pausar búsqueda' : 'Pause search', exact: true }); await pause.waitFor();
        await page.screenshot({ path: join(artifacts, `v060-layout-${locale}.png`), fullPage: true });
        assert.equal(await hasHorizontalOverflow(page), false, JSON.stringify(await page.locator('main *').evaluateAll((nodes) => nodes.filter((node) => node.getBoundingClientRect().right > window.innerWidth + 1).map((node) => ({ tag: node.tagName, class: node.className, right: node.getBoundingClientRect().right })).slice(0, 15))));
        await page.locator('.discovery-details summary').click();
        await page.locator('.discovery-panel').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(artifacts, `v060-search-${locale}-390.png`), fullPage: true });
        await pause.click(); await activate.waitFor();
        assert.equal((await api.get<{ enabled: boolean }>('/discovery')).enabled, false);
        await goTo(page, '/jobs?scope=new');
        await page.getByRole('link', { name: jobTitle(marker), exact: true }).waitFor();
        assert.equal(await page.getByRole('link', { name: 'Private unrelated job', exact: true }).count(), 0);
        await page.getByRole('link', { name: jobTitle(marker), exact: true }).click();
        const reviewed = page.getByRole('button', { name: locale === 'es' ? 'Marcar como revisada' : 'Mark as reviewed', exact: true }); await reviewed.waitFor();
        await page.setViewportSize({ width: 320, height: 844 }); assert.equal(await hasHorizontalOverflow(page), false);
        await reviewed.click(); await reviewed.waitFor({ state: 'detached' });
        await goTo(page, '/jobs?scope=new');
        await eventually(async () => (await api.get<{ items: Array<{ id: string }> }>('/jobs?scope=new&paged=true')).items.every((item) => item.id !== job.id), Boolean, 'Reviewed job leaves the new inbox');
        await goTo(page, `/jobs/${job.id}`); await page.getByRole('heading', { name: jobTitle(marker), exact: true }).waitFor();
        await db.query('update jobs set seen_at = null where id = $1', [job.id]);
      }
      await page.setViewportSize({ width: 1280, height: 900 }); await goTo(page, '/');
      await page.locator('.discovery-panel').getByRole('heading').waitFor();
      assert.equal(await hasHorizontalOverflow(page), false);
      note('Real API, persisted opt-in/pause, new-job review, ES/EN, 320/390px. Fictional DB rows; source execution is verified separately with injected feeds.');
    } finally {
      await api.put('/discovery', { enabled: false });
      await db.query('delete from boards where id = $1', [board]);
      await db.query('delete from workspaces where id = $1', [other]);
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
  },
};
const jobTitle = (marker: string) => `Designer ${marker}`;

/** First-use UI, including the narrow desktop sidebar reported by the user. No employer requests. */
async function checkCompanyEntry({ page, artifacts }: Pick<ScenarioContext, 'page' | 'artifacts'>) {
  await page.route('**/api/v1/discovery', (route) => route.fulfill({ json: { enabled: false, unreadCount: 0, boards: [] } }));
  await page.route('**/api/v1/boards', (route) => route.fulfill({ json: [] }));
  try {
    for (const locale of ['es', 'en'] as const) {
      await setLocale(page, locale);
      for (const width of [1096, 320, 390]) {
        await page.setViewportSize({ width, height: width === 1096 ? 684 : 844 }); await goTo(page, '/boards');
        const add = page.getByRole('button', { name: locale === 'es' ? 'Añadir una empresa' : 'Add a company', exact: true });
        await add.click();
        const name = page.getByLabel(locale === 'es' ? 'Nombre de la empresa' : 'Company name', { exact: true });
        await eventually(() => name.evaluate((node) => node === document.activeElement), Boolean, 'Add company opens the form and focuses its first input');
        await page.locator('.source-help summary').click();
        assert.equal(await hasHorizontalOverflow(page), false, `Company form fits at ${width}px in ${locale}`);
        const dimensions = await page.locator('.add-board-aside .form-card').evaluate((card) => {
          const bounds = card.getBoundingClientRect();
          return [...card.querySelectorAll('input, .form-submit button')].map((control) => { const rect = control.getBoundingClientRect(); return { left: rect.left, right: rect.right, cardLeft: bounds.left, cardRight: bounds.right, scrollX: window.scrollX }; });
        });
        for (const rect of dimensions) { assert.ok(rect.left >= rect.cardLeft && rect.right <= rect.cardRight + 1, JSON.stringify(rect)); assert.equal(rect.scrollX, 0); }
        if (width === 1096) await page.screenshot({ path: join(artifacts, `v060-company-form-${locale}-1096.png`) });
        // Clicking the entry point again while already open must focus the field again.
        await add.click(); await eventually(() => name.evaluate((node) => node === document.activeElement), Boolean, 'Existing company form focuses its first input');
        await page.getByRole('button', { name: locale === 'es' ? 'Cerrar y continuar después' : 'Close and continue later', exact: true }).click();
        await eventually(() => add.evaluate((node) => node === document.activeElement), Boolean, 'Closing restores focus to the entry point');
      }
      await page.goto(new URL('/boards?add=1', page.url()).toString());
      await eventually(() => page.locator('#company-name').evaluate((node) => node === document.activeElement), Boolean, 'Home shortcut opens and focuses company form');
    }
  } finally { await page.unroute('**/api/v1/discovery'); await page.unroute('**/api/v1/boards'); }
}
