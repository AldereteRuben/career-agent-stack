import assert from 'node:assert/strict';
import { AxeBuilder } from '@axe-core/playwright';
import type { Scenario } from './scenarios.js';
import { join } from 'node:path';
import { any, eventually, goTo, setLocale } from './ui.js';

async function auditWithAxe(page: import('playwright').Page, flow: string) {
  // Colour transitions (buttons fade for 0.15 s) would let axe measure contrast between two states.
  // Looping animations such as spinners never finish, so only finite ones are awaited.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => Number.isFinite(Number(animation.effect?.getComputedTiming().endTime)))
    .map((animation) => animation.finished.catch(() => undefined))));
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  const violations = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    nodes: violation.nodes.map((node) => ({ target: node.target.join(' '), summary: node.failureSummary, html: node.html })).slice(0, 6),
  }));
  assert.deepEqual(violations, [], `axe accessibility violations in ${flow}: ${JSON.stringify(violations)}`);
}

// Browser-level accessibility checks for issues #64 and #65: decorative symbols must stay out of the
// accessibility tree and the saved-experience list must be exposed as a named region. The tree is
// inspected with Playwright aria snapshots (aria-hidden and display:none nodes are excluded), which
// approximates but does not replace a real screen reader.
export const a11yScenarios: Scenario[] = [{
  name: 'a11y-decorative-symbols-and-saved-region',
  async run({ page, context, api, marker, note, artifacts, allowConsole }) {
    // An application without a tailored resume or cover letter yet answers 404 for them; the panels show an empty state.
    allowConsole(/Failed to load resource: the server responded with a status of 404 \(Not Found\)/);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const company = `A11y ${marker}`;
    const title = `A11y role ${marker}`;
    const job = await api.post<{ id: string; fitScore: number | null; evidenceCoverage: number | null; provisional?: boolean }>('/jobs/import', { company, title, jobUrl: `https://example.com/${marker}/a11y` });
    const fact = await api.post<{ id: string }>('/profile/facts', { kind: 'achievement', statement: `A11y example ${marker}` });
    await api.post(`/profile/facts/${fact.id}/approve`);
    const profilePage = await context.newPage();
    await profilePage.setViewportSize({ width: 1440, height: 1000 });
    await profilePage.goto(new URL('/profile', page.url()).toString());
    await setLocale(profilePage, 'es');
    await profilePage.getByRole('complementary', { name: 'Menú principal', exact: true }).waitFor();
    await profilePage.getByRole('complementary', { name: 'Tu progreso', exact: true }).waitFor();
    await profilePage.locator('details.profile-preferences > summary').click();
    // Wait for the profile request to finish before exercising a controlled input. The field is
    // present in the initial render while the form is still locked, and the full suite can reach
    // this page while its separate tab is still loading.
    const region = profilePage.getByRole('region', { name: 'Lo que has guardado' });
    await region.getByText(`A11y example ${marker}`).waitFor();
    await auditWithAxe(profilePage, 'profile');
    const mode = profilePage.locator('.work-mode-field .tag-row button').first();
    await mode.waitFor();
    await eventually(() => mode.isEnabled(), (enabled) => enabled, 'The work-mode control should be ready after profile loading');
    const accessibleName = (snapshot: string) => snapshot.match(/button "([^"]+)"/)?.[1] ?? '';
    const modeBefore = await mode.ariaSnapshot();
    assert.ok(!modeBefore.includes('✓'), 'The selected work-mode checkmark is still exposed to assistive technology');
    const pressedBefore = await mode.getAttribute('aria-pressed');
    assert.ok(pressedBefore === 'true' || pressedBefore === 'false', 'The work-mode button should expose its pressed state');
    await mode.click();
    const modeAfter = await mode.ariaSnapshot();
    assert.equal(accessibleName(modeAfter), accessibleName(modeBefore), 'The work-mode accessible name should not change when toggled');
    await eventually(() => mode.getAttribute('aria-pressed'), (pressed) => pressed !== pressedBefore, 'The toggle state should still change');
    // #65: the list is a <section aria-labelledby>, so it is exposed as a named region.
    await region.waitFor();
    const regionSnapshot = await region.ariaSnapshot();
    assert.ok(regionSnapshot.includes(`A11y example ${marker}`), 'The saved region snapshot should contain the approved entry');
    // #64: the approved-entry marker (✓) is decorative; the state is already announced by the tag text.
    assert.ok(!regionSnapshot.includes('✓'), 'The fact approval marker is still exposed to assistive technology');
    // #64: the "Privado por defecto" card icon (⌑) is decorative.
    const asideSnapshot = await profilePage.locator('.aside-privacy').ariaSnapshot();
    assert.ok(!asideSnapshot.includes('⌑'), 'The privacy card icon is still exposed to assistive technology');
    await profilePage.close();

    await setLocale(page, 'es');
    await goTo(page, '/profile');

    await goTo(page, '/searches');
    await page.locator('main').waitFor();
    await auditWithAxe(page, 'search creation and saved searches');

    await page.goto(new URL(`/jobs?q=${encodeURIComponent(company)}&scope=active`, page.url()).toString());
    await page.locator('main').waitFor();
    const card = page.locator('.job-card').filter({ hasText: title });
    await card.waitFor();
    await auditWithAxe(page, 'job search results');
    const metrics = card.locator('.job-card-metrics');
    await metrics.waitFor({ state: 'attached' });
    assert.ok((await metrics.textContent())?.includes('Porción evaluable del encaje:'), 'The job card should explain what the percentage measures');
    const scoreLabel = job.fitScore === null || job.provisional ? 'Pendiente' : String(job.fitScore);
    assert.ok((await metrics.locator('strong').textContent())?.startsWith(scoreLabel), 'A provisional fit should be labelled pending instead of showing a bare dash');
    assert.equal(await metrics.evaluate((node) => getComputedStyle(node).borderTopWidth), '0px', 'The fit metric should not look like an empty progress bar');
    await card.getByRole('link', { name: title, exact: true }).click();
    const previewScore = page.locator('[class*="previewScore"]');
    await previewScore.waitFor();
    await auditWithAxe(page, 'job detail');
    await previewScore.getByText('Porción evaluable del encaje:', { exact: false }).waitFor();
    assert.ok((await previewScore.locator('strong').innerText()).startsWith(scoreLabel), 'The preview should label a provisional fit as pending');
    const cardSnapshot = await card.ariaSnapshot();
    // #64: the location pin (⌖) is decorative; the location text itself remains.
    assert.ok(!cardSnapshot.includes('⌖'), 'The job location pin is still exposed to assistive technology');
    // The bookmark button keeps its accessible name (⌑ inside a labelled button is not decorative text).
    assert.ok(cardSnapshot.includes('Guardar oferta'), 'The bookmark button should keep its accessible label');
    await setLocale(page, 'en');
    await previewScore.getByText('Assessable share of the fit:', { exact: false }).waitFor();
    await setLocale(page, 'es');

    // #64: the ＋ step badge on the manual job form is decorative.
    await page.getByRole('button', { name: any('Añadir oferta', 'Add job') }).first().click();
    const jobsFormSnapshot = await page.locator('.import-card').ariaSnapshot();
    assert.ok(!jobsFormSnapshot.includes('＋'), 'The jobs step badge is still exposed to assistive technology');

    const application = await api.post<{ id: string }>('/applications', { jobId: job.id, company, role: title, canonicalUrl: `https://example.com/${marker}/a11y`, state: 'DRAFT', notes: '' });
    await goTo(page, '/applications');
    await auditWithAxe(page, 'application tracker');
    await page.getByRole('button', { name: any('Añadir solicitud', 'Add application', 'Registrar', 'Record') }).first().click();
    await auditWithAxe(page, 'application form');
    const applicationsFormSnapshot = await page.locator('.import-card').ariaSnapshot();
    assert.ok(!applicationsFormSnapshot.includes('＋'), 'The applications step badge is still exposed to assistive technology');

    await page.goto(new URL(`/applications?id=${application.id}`, page.url()).toString());
    await page.locator('.tracker-detail').getByRole('heading', { name: title, exact: true }).waitFor();
    await page.locator('.assist-panel h3').waitFor();
    await auditWithAxe(page, 'application preparation detail');

    // #64: the boards ＋ badge is hidden by CSS in the aside layout; check the attribute directly.
    await goTo(page, '/boards');
    await page.getByRole('complementary', { name: 'Seguir una empresa', exact: true }).waitFor();
    const boardBadge = page.locator('.add-board-aside .step-badge').first();
    await boardBadge.waitFor({ state: 'attached' });
    assert.equal(await boardBadge.getAttribute('aria-hidden'), 'true', 'The boards step badge should be aria-hidden');
    await goTo(page, '/settings');
    await page.getByRole('complementary', { name: 'Solo en este equipo', exact: true }).waitFor();
    await goTo(page, `/jobs/${job.id}`);
    await page.getByRole('complementary', { name: 'Más acciones', exact: true }).waitFor();

    // Both themes: the main pages must pass axe (colour contrast included) in light and, when the system asks for
    // it, dark colours. Screenshots are kept with the run's artifacts for a visual check.
    const themedPages: Array<[string, string]> = [
      ['/overview', 'overview'], ['/profile', 'profile'], ['/searches', 'searches'], [`/jobs?q=${encodeURIComponent(company)}&scope=active`, 'jobs'],
      [`/jobs/${job.id}`, 'job-detail'], [`/applications?id=${application.id}`, 'application-detail'], ['/boards', 'boards'], ['/settings', 'settings'],
    ];
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      for (const [href, label] of themedPages) {
        await page.goto(new URL(href, page.url()).toString());
        await page.getByRole('heading', { level: 1 }).first().waitFor();
        // Audit the loaded page, not its loading notices.
        await page.waitForFunction(() => !/Cargando|Loading/u.test(document.querySelector('main')?.textContent ?? ''), undefined, { timeout: 20_000 });
        assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), colorScheme, `${label} uses the ${colorScheme} colour scheme`);
        await auditWithAxe(page, `${label} (${colorScheme} theme)`);
        await page.screenshot({ animations: 'disabled', path: join(artifacts, `${colorScheme}-${label}.png`), fullPage: true });
      }
    }
    // Settings → Appearance: a chosen theme wins over the system, survives a reload, and "Match the system" follows it again.
    const scheme = () => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
    const themeChoice = (es: string, en: string) => page.getByRole('radio', { name: any(es, en), exact: true });
    const reloadSettings = async () => { await page.reload(); await page.getByRole('heading', { name: any('Apariencia', 'Appearance'), exact: true }).waitFor(); };
    await page.emulateMedia({ colorScheme: 'light' });
    await goTo(page, '/settings');
    await page.getByRole('heading', { name: any('Apariencia', 'Appearance'), exact: true }).waitFor();
    assert.equal(await themeChoice('Según el sistema', 'Match the system').isChecked(), true, 'A new workspace follows the system theme');
    await themeChoice('Oscuro', 'Dark').check();
    assert.equal(await scheme(), 'dark', 'Choosing dark applies at once on a light system');
    await reloadSettings();
    assert.equal(await scheme(), 'dark', 'The dark choice is server-rendered after a reload');
    assert.equal(await themeChoice('Oscuro', 'Dark').isChecked(), true, 'The dark choice stays selected after a reload');
    await auditWithAxe(page, 'settings (dark theme chosen in Settings)');
    await page.emulateMedia({ colorScheme: 'dark' });
    await themeChoice('Claro', 'Light').check();
    assert.equal(await scheme(), 'light', 'Choosing light wins over a dark system');
    await reloadSettings();
    assert.equal(await scheme(), 'light', 'The light choice is server-rendered after a reload');
    await themeChoice('Según el sistema', 'Match the system').check();
    assert.equal(await scheme(), 'dark', 'Matching the system follows a dark system again');
    await reloadSettings();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme ?? null), null, 'Matching the system removes the stored choice');
    await page.emulateMedia({ colorScheme: 'light' });
    assert.equal(await scheme(), 'light', 'Matching the system follows the system when it changes');
    note('Accessibility tree checked with Playwright aria snapshots; not verified with real screen readers.');
  },
}];
