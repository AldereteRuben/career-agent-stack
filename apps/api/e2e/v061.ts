import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Scenario } from './scenarios.js';
import { eventually, hasHorizontalOverflow, setLocale } from './ui.js';

export const v061Scenario: Scenario = {
  name: 'v061-discovery-recovery-and-inbox-continuity',
  async run({ page, api, db, marker, artifacts, allowConsole, note }) {
    allowConsole(/Failed to load resource|500|Internal Server Error/i);
    const workspace = (await db.query<{ id: string }>('select id from workspaces limit 1')).rows[0]!.id;
    const createdBoards: string[] = [];
    await api.put('/discovery', { enabled: false });
    try {
      for (const locale of ['es', 'en'] as const) {
        await setLocale(page, locale); await page.setViewportSize({ width: 1096, height: 684 });
        const c = (es: string, en: string) => locale === 'es' ? es : en;
        const company = `Patch ${marker} ${locale}`;
        const board = await api.post<{ id: string }>('/boards', { provider: 'lever', tenant: `${marker}-${locale}`, region: 'global', companyName: company, companyDomain: 'example.test', careersUrl: 'https://example.test/careers', associationStatus: 'UNVERIFIED', permissionStatus: 'UNKNOWN', enabled: false });
        createdBoards.push(board.id);
        await page.goto(new URL('/boards', page.url()).toString());
        const card = page.locator('.board-card').filter({ hasText: company });
        await card.getByRole('checkbox').nth(0).check(); await card.getByRole('checkbox').nth(1).check();
        await card.getByRole('button', { name: c('Confirmar empresa', 'Confirm company'), exact: true }).click();
        await page.locator('.notice-success').filter({ hasText: c(`${company}: empresa confirmada y lista para consultar.`, `${company}: company confirmed and ready to check.`) }).waitFor();
        assert.equal((await api.get<{ enabled: boolean }>('/discovery')).enabled, false);
        await db.query("update boards set last_run_status='INTERRUPTED',last_run_at=now(),next_run_at=now()+interval '7 hours' where id=$1", [board.id]);
        await page.reload(); await page.locator('.discovery-details summary').click();
        const activity = page.locator('.discovery-details li').filter({ hasText: company });
        assert.match(await activity.innerText(), new RegExp(c('Programación pausada', 'Schedule paused')));
        assert.doesNotMatch(await activity.innerText(), /Reintentaremos en el próximo|retry at the next/i);

        let failGet = true; let failPut = false;
        await page.route('**/api/v1/discovery', async (route) => {
          if ((route.request().method() === 'GET' && failGet) || (route.request().method() === 'PUT' && failPut)) await route.fulfill({ status: 500, json: { error: 'INTERNAL_ERROR' } });
          else await route.continue();
        });
        try {
          await page.reload(); const panel = page.locator('.discovery-panel');
          await panel.getByRole('alert').waitFor();
          assert.equal(await panel.getByText(c('Cargando búsqueda…', 'Loading search…'), { exact: true }).count(), 0);
          failGet = false; await panel.getByRole('button', { name: c('Reintentar', 'Try again'), exact: true }).click();
          await panel.locator('.tag').filter({ hasText: c('PAUSADA', 'PAUSED') }).waitFor();
          failGet = true; await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
          await panel.locator('.tag').filter({ hasText: c('SIN ACTUALIZAR', 'OUT OF DATE') }).waitFor();
          const activate = panel.getByRole('button', { name: c('Activar consultas de empresas', 'Turn on company checks'), exact: true });
          assert.equal(await activate.isDisabled(), true);
          for (const width of [1096, 390, 320]) {
            await page.setViewportSize({ width, height: 844 });
            if (width < 850) await page.locator('#app-sidebar').waitFor({ state: 'hidden' });
            await card.waitFor(); assert.equal(await hasHorizontalOverflow(page), false);
          }
          await page.screenshot({ path: join(artifacts, `v061-stale-${locale}.png`), fullPage: true });
          failGet = false; await panel.getByRole('button', { name: c('Reintentar', 'Try again'), exact: true }).click();
          await eventually(() => activate.isEnabled(), Boolean, 'Fresh status restores action');
          failPut = true; await activate.click(); await panel.getByRole('alert').waitFor();
          await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
          await page.waitForTimeout(1200);
          assert.equal(await panel.getByRole('alert').count(), 1, 'A successful poll must not erase a failed action');
          assert.equal((await api.get<{ enabled: boolean }>('/discovery')).enabled, false);
        } finally { await page.unroute('**/api/v1/discovery'); }

        // Fictional inbox with 25 jobs: reviewing the only result on page 2 must return to page 1.
        const filter = `Inbox ${marker} ${locale}`;
        for (let i = 0; i < 25; i++) await db.query("insert into jobs(id,workspace_id,company,title,canonical_url,availability,discovered_at) values($1,$2,$3,$4,$5,'OPEN',now())", [randomUUID(), workspace, filter, `${filter} ${i}`, `https://example.test/${marker}/${locale}/${i}`]);
        await page.goto(new URL(`/jobs?scope=new&q=${encodeURIComponent(filter)}&availability=OPEN&page=2`, page.url()).toString());
        const jobLink = page.locator('.job-card h2 a').first();
        const detailId = new URL((await jobLink.getAttribute('href'))!, page.url()).pathname.split('/').pop()!;
        const detailPattern = `**/api/v1/jobs/${detailId}`;
        let detailReads = 0;
        const overlapsInitialReads = process.env.E2E_PRODUCTION !== '1';
        let releaseDelayedRead!: () => void;
        const releaseRead = new Promise<void>((resolve) => { releaseDelayedRead = resolve; });
        let snapshotCaptured = false;
        let finishDelayedRead!: () => void;
        const delayedRead = new Promise<void>((resolve) => { finishDelayedRead = resolve; });
        // React StrictMode duplicates this effect only in development. In that mode hold the first
        // snapshot until the mutation succeeds; production must not be expected to make duplicate reads.
        await page.route(detailPattern, async (route) => {
          detailReads += 1;
          if (!overlapsInitialReads || detailReads !== 1) return route.continue();
          try {
            const response = await route.fetch();
            snapshotCaptured = true;
            await releaseRead;
            await route.fulfill({ response });
          } finally { finishDelayedRead(); }
        });
        await jobLink.click();
        let failReview = true;
        await page.route('**/api/v1/jobs/*/seen', async (route) => failReview ? route.fulfill({ status: 500, json: { error: 'INTERNAL_ERROR' } }) : route.continue());
        try {
          const review = page.getByRole('button', { name: c('Marcar como revisada', 'Mark as reviewed'), exact: true });
          if (overlapsInitialReads) await eventually(async () => snapshotCaptured, Boolean, 'Initial snapshot captured before the review');
          await review.click(); await page.locator('main').getByRole('alert').waitFor();
          await eventually(() => review.isEnabled(), Boolean, 'Failed review can be retried');
          failReview = false;
          const retryResponse = page.waitForResponse((response) => response.url().endsWith('/seen') && response.request().method() === 'POST');
          await review.click();
          const response = await retryResponse;
          assert.equal(response.status(), 200, `Review retry returned ${response.status()}`);
          note(`${locale}: review retry reached API and returned 200`);
          if (overlapsInitialReads) {
            releaseDelayedRead(); await delayedRead;
            assert.ok(detailReads >= 2, 'The development fixture exercised overlapping initial reads');
            note(`${locale}: delayed development snapshot released only after the successful review`);
          } else {
            assert.ok(detailReads >= 1, 'Production loaded the job before reviewing it');
            note(`${locale}: production review/retry checked (${detailReads} initial read); StrictMode overlap is a development-only fixture`);
          }
          assert.ok((await db.query('select seen_at from jobs where id=$1', [detailId])).rows[0]?.seen_at, 'Successful review persisted');
          const continuation = page.getByRole('link', { name: c('Volver a la lista de ofertas', 'Back to the job list'), exact: true });
          await eventually(() => continuation.evaluate((node) => node === document.activeElement), Boolean, 'Review keeps a useful keyboard continuation');
          assert.equal(await page.locator('main').getByRole('alert').count(), 0, 'Successful retry clears the previous error');
          await continuation.click();
        } finally { releaseDelayedRead(); await page.unroute('**/api/v1/jobs/*/seen'); await page.unroute(detailPattern); }
        await page.waitForURL((url) => url.pathname === '/jobs' && !url.searchParams.has('page'));
        assert.equal(new URL(page.url()).searchParams.get('scope'), 'new'); assert.equal(new URL(page.url()).searchParams.get('q'), filter); assert.equal(new URL(page.url()).searchParams.get('availability'), 'OPEN');
        await eventually(() => page.locator('.job-card').count(), (count) => count === 24, 'All remaining jobs are accessible');
        const firstTitle = await page.locator('.job-card h2').first().innerText();
        const arrival = `${filter} arrived`;
        await db.query("insert into jobs(workspace_id,company,title,canonical_url,availability,discovered_at) values($1,$2,$3,$4,'OPEN',now())", [workspace, filter, arrival, `https://example.test/${marker}/${locale}/arrived`]);
        await page.getByRole('textbox', { name: c('Buscar ofertas', 'Search jobs'), exact: true }).focus();
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        const update = page.getByRole('button', { name: c('Actualizar resultados', 'Update results'), exact: true });
        await update.waitFor();
        assert.equal(await page.locator('.job-card h2').first().innerText(), firstTitle, 'Arrival does not reorder visible jobs');
        assert.equal(await page.getByRole('link', { name: arrival, exact: true }).count(), 0);
        assert.equal(await page.getByRole('textbox', { name: c('Buscar ofertas', 'Search jobs'), exact: true }).evaluate((node) => node === document.activeElement), true);
        await update.click(); await page.getByRole('link', { name: arrival, exact: true }).waitFor();
        assert.equal(new URL(page.url()).searchParams.get('q'), filter);
        await eventually(() => page.locator('h2.sr-only').evaluate((node) => node === document.activeElement), Boolean, 'Updating returns keyboard focus to results');
        const jobsPattern = /\/api\/v1\/jobs\?/;
        let failUpdates = true;
        await page.route(jobsPattern, (route) => failUpdates ? route.fulfill({ status: 500, json: { error: 'INTERNAL_ERROR' } }) : route.continue());
        try {
          await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
          const warning = page.locator('.notice-warning').filter({ hasText: c('No pudimos comprobar si hay novedades.', 'Could not check for updates.') });
          await warning.waitFor(); assert.equal(await page.locator('.job-card').count(), 24, 'Failed background check keeps visible results');
          failUpdates = false; await warning.getByRole('button', { name: c('Reintentar', 'Try again'), exact: true }).click();
          await warning.waitFor({ state: 'detached' });
        } finally { await page.unroute(jobsPattern); }
        await page.screenshot({ path: join(artifacts, `v061-inbox-${locale}.png`), fullPage: true });
        assert.equal(await hasHorizontalOverflow(page), false);
      }
      note('ES/EN: company confirmation vs paused automation, interrupted and stale state, initial failure/recovery, persistent action errors, failed/successful review and focus, 25→24 pagination, background arrivals and preserved filters. Isolated DB and fictional rows only.');
    } finally {
      await api.put('/discovery', { enabled: false });
      for (const id of createdBoards) await db.query('delete from boards where id=$1', [id]);
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
  },
};
