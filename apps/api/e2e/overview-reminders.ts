import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Scenario } from './scenarios.js';
import { eventually, hasHorizontalOverflow, setLocale } from './ui.js';

type Application = { id: string };

export const overviewRemindersScenario: Scenario = {
  name: 'overview-follow-up-reminders-card-desktop-and-mobile',
  async run({ page, api, uiUrl, marker, artifacts }) {
    const company = `Reminders ${marker}`;
    const overdue = await api.post<Application>('/applications', { company, role: `Overdue ${marker}`, state: 'DRAFT', notes: '' });
    const upcoming = await api.post<Application>('/applications', { company, role: `Upcoming ${marker}`, state: 'DRAFT', notes: '' });
    // Dates come from the browser so they match the calendar days the page shows. The overdue date is the oldest on purpose:
    // the card shows the three oldest overdue follow-ups, and other scenarios in the same run leave their own behind.
    const [today, soon, timeZone] = await page.evaluate(() => [0, 5].map((offset) => new Date(Date.now() + offset * 86_400_000)).map((date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`).concat(Intl.DateTimeFormat().resolvedOptions().timeZone));
    await api.patch(`/applications/${overdue.id}`, { nextStep: `Write back ${marker}`, followUpDate: '2001-01-02' });
    await api.patch(`/applications/${upcoming.id}`, { nextStep: `Check in ${marker}`, followUpDate: soon, interview: { localAt: `${today}T00:05`, timeZone } });
    await api.patch(`/applications/${upcoming.id}`, { state: 'CONFIRMED', confirmationEvidence: 'USER_ATTESTATION' });
    await api.patch(`/applications/${upcoming.id}`, { recruitmentStage: 'INTERVIEW' });

    for (const locale of ['es', 'en'] as const) {
      const c = (es: string, en: string) => locale === 'es' ? es : en;
      await setLocale(page, locale); await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(new URL('/overview', uiUrl).toString());
      const heading = page.getByRole('heading', { level: 2, name: c('Tu seguimiento', 'Your follow-up') });
      await heading.waitFor();
      const region = page.locator('[aria-labelledby="overview-reminders-heading"]');
      await eventually(() => region.innerText(), (text) => text.includes(`Overdue ${marker}`) || text.includes(`Write back ${marker}`), `${locale}: the overdue follow-up is listed`);
      await eventually(() => region.innerText(), (text) => text.includes(`Upcoming ${marker}`) || text.includes(`Check in ${marker}`), `${locale}: the upcoming interview and follow-up are listed`);
      assert.ok(await region.getByRole('heading', { level: 3, name: c('Seguimientos vencidos', 'Overdue follow-ups') }).isVisible(), `${locale}: overdue group heading`);
      assert.ok(await region.getByRole('heading', { level: 3, name: c('Próximos 30 días', 'Next 30 days') }).isVisible(), `${locale}: upcoming group heading`);
      assert.ok(await region.locator('time[datetime]').count() >= 2, `${locale}: every reminder carries a machine-readable date`);

      // The content does not touch the card edges.
      const insets = await region.evaluate((element) => {
        const frame = element.getBoundingClientRect();
        const inner = Array.from(element.querySelectorAll('h2, a.text-link')).map((child) => child.getBoundingClientRect());
        return { left: Math.min(...inner.map((rect) => rect.left)) - frame.left, right: frame.right - Math.max(...inner.map((rect) => rect.right)) };
      });
      assert.ok(insets.left >= 12 && insets.right >= 12, `${locale}: the card content keeps its padding (${JSON.stringify(insets)})`);

      // Every reminder and the timeline link are real links, reachable and operable from the keyboard.
      const links = region.getByRole('link');
      assert.ok(await links.count() >= 3, `${locale}: reminders link to their applications and to the timeline`);
      const mine = region.getByRole('link', { name: new RegExp(marker) }).first();
      await mine.focus();
      assert.equal(await mine.evaluate((element) => element === document.activeElement), true, `${locale}: a reminder takes keyboard focus`);
      const outline = await mine.evaluate((element) => getComputedStyle(element).outlineStyle);
      assert.notEqual(outline, 'none', `${locale}: the focused reminder shows a focus indicator`);

      await page.screenshot({ path: join(artifacts, `overview-reminders-desktop-${locale}.png`), animations: 'disabled' });
      await region.screenshot({ path: join(artifacts, `overview-reminders-card-desktop-${locale}.png`), animations: 'disabled' });

      await page.setViewportSize({ width: 390, height: 844 });
      await region.scrollIntoViewIfNeeded();
      assert.equal(await hasHorizontalOverflow(page), false, `${locale}: the overview overflows at phone width`);
      const box = await region.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `${locale}: the card fits inside the phone viewport`);
      await region.screenshot({ path: join(artifacts, `overview-reminders-card-mobile-${locale}.png`), animations: 'disabled' });

      await region.getByRole('link', { name: c('Ver calendario', 'Open timeline'), exact: true }).click();
      await page.waitForURL((url) => url.pathname === '/timeline');
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  },
};
