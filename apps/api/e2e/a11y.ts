import assert from 'node:assert/strict';
import type { Scenario } from './scenarios.js';
import { any, goTo, setLocale } from './ui.js';

// Browser-level accessibility checks for issues #64 and #65: decorative symbols must stay out of the
// accessibility tree and the saved-experience list must be exposed as a named region. The tree is
// inspected with Playwright aria snapshots (aria-hidden and display:none nodes are excluded), which
// approximates but does not replace a real screen reader.
export const a11yScenarios: Scenario[] = [{
  name: 'a11y-decorative-symbols-and-saved-region',
  async run({ page, api, marker, note }) {
    const company = `A11y ${marker}`;
    const title = `A11y role ${marker}`;
    await api.post<{ id: string }>('/jobs/import', { company, title, jobUrl: `https://example.com/${marker}/a11y` });
    const fact = await api.post<{ id: string }>('/profile/facts', { kind: 'achievement', statement: `A11y example ${marker}` });
    await api.post(`/profile/facts/${fact.id}/approve`);
    await setLocale(page, 'es');

    await goTo(page, '/profile');
    // #65: the list is a <section aria-labelledby>, so it is exposed as a named region.
    const region = page.getByRole('region', { name: 'Lo que has guardado' });
    await region.waitFor();
    // The region renders before the profile data loads, so wait for the entry to appear first.
    await region.getByText(`A11y example ${marker}`).waitFor();
    const regionSnapshot = await region.ariaSnapshot();
    assert.ok(regionSnapshot.includes(`A11y example ${marker}`), 'The saved region snapshot should contain the approved entry');
    // #64: the approved-entry marker (✓) is decorative; the state is already announced by the tag text.
    assert.ok(!regionSnapshot.includes('✓'), 'The fact approval marker is still exposed to assistive technology');
    // #64: the "Privado por defecto" card icon (⌑) is decorative.
    const asideSnapshot = await page.locator('.aside-privacy').ariaSnapshot();
    assert.ok(!asideSnapshot.includes('⌑'), 'The privacy card icon is still exposed to assistive technology');

    await page.goto(new URL(`/jobs?q=${encodeURIComponent(company)}&scope=active`, page.url()).toString());
    const card = page.locator('.job-card').filter({ hasText: title });
    await card.waitFor();
    const cardSnapshot = await card.ariaSnapshot();
    // #64: the location pin (⌖) is decorative; the location text itself remains.
    assert.ok(!cardSnapshot.includes('⌖'), 'The job location pin is still exposed to assistive technology');
    // The bookmark button keeps its accessible name (⌑ inside a labelled button is not decorative text).
    assert.ok(cardSnapshot.includes('Guardar oferta'), 'The bookmark button should keep its accessible label');

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
    const boardBadge = page.locator('.add-board-aside .step-badge').first();
    await boardBadge.waitFor({ state: 'attached' });
    assert.equal(await boardBadge.getAttribute('aria-hidden'), 'true', 'The boards step badge should be aria-hidden');
    note('Accessibility tree checked with Playwright aria snapshots; not verified with real screen readers.');
  },
}];
