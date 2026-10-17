import assert from 'node:assert/strict';
import type { Scenario } from './scenarios.js';
import { any, eventually, goTo, setLocale } from './ui.js';

// Browser-level accessibility checks for issues #64 and #65: decorative symbols must stay out of the
// accessibility tree and the saved-experience list must be exposed as a named region. The tree is
// inspected with Playwright aria snapshots (aria-hidden and display:none nodes are excluded), which
// approximates but does not replace a real screen reader.
export const a11yScenarios: Scenario[] = [{
  name: 'a11y-decorative-symbols-and-saved-region',
  async run({ page, context, api, marker, note }) {
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

    await page.goto(new URL(`/jobs?q=${encodeURIComponent(company)}&scope=active`, page.url()).toString());
    const card = page.locator('.job-card').filter({ hasText: title });
    await card.waitFor();
    const metrics = card.locator('.job-card-metrics');
    await metrics.waitFor({ state: 'attached' });
    assert.ok((await metrics.textContent())?.includes('Porción evaluable del encaje:'), 'The job card should explain what the percentage measures');
    const scoreLabel = job.fitScore === null || job.provisional ? 'Pendiente' : String(job.fitScore);
    assert.ok((await metrics.locator('strong').textContent())?.startsWith(scoreLabel), 'A provisional fit should be labelled pending instead of showing a bare dash');
    assert.equal(await metrics.evaluate((node) => getComputedStyle(node).borderTopWidth), '0px', 'The fit metric should not look like an empty progress bar');
    await card.getByRole('link', { name: title, exact: true }).click();
    const previewScore = page.locator('[class*="previewScore"]');
    await previewScore.waitFor();
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

    await goTo(page, '/applications');
    await page.getByRole('button', { name: any('Añadir solicitud', 'Add application', 'Registrar', 'Record') }).first().click();
    const applicationsFormSnapshot = await page.locator('.import-card').ariaSnapshot();
    assert.ok(!applicationsFormSnapshot.includes('＋'), 'The applications step badge is still exposed to assistive technology');

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
    note('Accessibility tree checked with Playwright aria snapshots; not verified with real screen readers.');
  },
}];
