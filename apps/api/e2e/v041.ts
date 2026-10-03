import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Scenario } from './scenarios.js';
import { eventually, goTo, hasHorizontalOverflow, setLocale } from './ui.js';

export const v041Scenarios: Scenario[] = [{
  name: 'v041-layout-library-focus-and-neutral-copy',
  async run({ page, artifacts }) {
    for (const locale of ['es', 'en'] as const) {
      await setLocale(page, locale);
      await page.setViewportSize({ width: 1096, height: 684 });
      await goTo(page, '/profile');
      await page.getByText(locale === 'es' ? 'Preferencias de empleo · opcional' : 'Job preferences · optional', { exact: true }).click();
      const country = page.getByLabel(locale === 'es' ? 'País de trabajo' : 'Work country', { exact: true });
      const roles = page.getByLabel(locale === 'es' ? 'Puestos que buscas' : 'Roles you are looking for', { exact: true });
      await eventually(() => country.isEnabled(), Boolean, 'Profile is loaded');
      await country.scrollIntoViewIfNeeded();
      const a = await country.boundingBox(); const b = await roles.boundingBox();
      assert.ok(a && b && Math.abs(a.y - b.y) < 2, 'Country and job inputs share a baseline');
      const modes = await page.locator('.work-mode-field .tag-row button').all();
      const boxes = await Promise.all(modes.map((mode) => mode.boundingBox()));
      assert.ok(boxes.slice(0, 3).every((box) => box && Math.abs(box.y - boxes[0]!.y) < 2), 'Work arrangements share one row');
      assert.equal(await hasHorizontalOverflow(page), false);
      await page.screenshot({ animations: 'disabled', path: join(artifacts, `v041-profile-${locale}.png`) });
      await goTo(page, '/documents');
      assert.equal(await page.locator('#resume-history').isVisible(), false);
      await page.getByRole('button', { name: /^(CV guardados|Saved resumes)/ }).click();
      await page.locator('#resume-history:visible').waitFor();
      assert.equal(await page.locator('#resume-builder').isVisible(), false);
      const review = page.locator('.document-card').getByRole('button', { name: /^(Revisar y aprobar|Review and approve|Ver|View)$/ }).first();
      await review.click();
      await eventually(() => page.locator('.focus-heading:focus').count(), (n) => n === 1, 'PDF heading receives focus');
      await page.getByRole('button', { name: /^(Cerrar vista previa|Close preview)$/ }).click();
      await page.locator('#resume-history:visible').waitFor();
      await eventually(() => review.evaluate((button) => button === document.activeElement), Boolean, 'Closing preview restores focus');
      await page.screenshot({ animations: 'disabled', path: join(artifacts, `v041-library-${locale}.png`) });
      await goTo(page, '/boards');
      await page.screenshot({ animations: 'disabled', path: join(artifacts, `v041-companies-${locale}.png`) });
      for (const route of ['/profile', '/documents', '/boards', '/jobs', '/settings', '/login']) {
        await page.setViewportSize({ width: 390, height: 844 });
        await goTo(page, route);
        assert.equal(await hasHorizontalOverflow(page), false, `${route} overflows on mobile (${locale})`);
        assert.ok(!(await page.locator('body').innerText()).includes('Finder'), 'Instructions do not assume Finder');
        await page.screenshot({ animations: 'disabled', path: join(artifacts, `v041-${route.slice(1)}-mobile-${locale}.png`) });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await goTo(page, '/'); await setLocale(page, 'es');
  },
}];
